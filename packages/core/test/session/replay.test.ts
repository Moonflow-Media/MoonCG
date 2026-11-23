import { describe, expect, it } from 'vitest';
import { ALLOW_ALL_POLICY, ALLOW_ALL_PRINCIPAL } from '../../src/permissions/authorize.js';
import {
  type ClientMessage,
  decodeClientMessage,
  decodeServerMessage,
  encodeMessage,
  PROTOCOL_VERSION,
  type ServerMessage,
} from '../../src/protocol/protocol.js';
import { ReplicantRegistry } from '../../src/replicant/registry.js';
import { createSession } from '../../src/session/session.js';

const EPOCH = 'boot-1';
/** Large enough that replaying a few small patches is cheaper than a snapshot. */
const PAD = 'x'.repeat(20_000);

function setup() {
  let declared = 0;
  const registry = new ReplicantRegistry({
    createEpoch: () => (declared++ === 0 ? EPOCH : `redeclared-${declared}`),
  });
  const declare = () =>
    registry.declare('scoreboard', 'score', { initial: { n: 0, pad: PAD } }).replicant;
  let replicant = declare();
  const bump = (n: number) =>
    replicant.applyOp({ patches: [{ op: 'replace', path: '/n', value: n }] });
  const redeclare = () => {
    registry.undeclare('scoreboard');
    replicant = declare();
  };
  const connect = (bundle: string | null = 'scoreboard') => {
    const sent: ServerMessage[] = [];
    const session = createSession({
      principal: ALLOW_ALL_PRINCIPAL,
      policy: ALLOW_ALL_POLICY,
      registry,
      bundleExists: (name) => name === 'scoreboard',
      send: (msg) => sent.push(msg),
    });
    const receive = (msg: ClientMessage) => session.receive(encodeMessage(msg));
    if (bundle !== null) {
      receive({ t: 'hello', v: PROTOCOL_VERSION, bundle });
      sent.length = 0;
    }
    return { sent, receive };
  };
  return { registry, bump, redeclare, connect };
}

const snapshot = (id: number, rev: number, n: number, epoch = EPOCH) => ({
  t: 'rep.snap',
  id,
  name: 'scoreboard:score',
  rev,
  value: { n, pad: PAD },
  epoch,
});

describe('subscription state on the wire', () => {
  it('round-trips a subscription that names the last known state', () => {
    const msg: ClientMessage = {
      t: 'rep.sub',
      id: 1,
      name: 'score',
      since: { epoch: EPOCH, rev: 3 },
    };
    expect(decodeClientMessage(encodeMessage(msg))).toEqual({ ok: true, msg });
  });

  it.each([
    ['a non-object', '{"t":"rep.sub","id":1,"name":"s","since":3}'],
    ['a missing epoch', '{"t":"rep.sub","id":1,"name":"s","since":{"rev":3}}'],
    ['a negative rev', '{"t":"rep.sub","id":1,"name":"s","since":{"epoch":"e","rev":-1}}'],
  ])('rejects "since" with %s', (_label, text) => {
    expect(decodeClientMessage(text)).toMatchObject({ ok: false, error: { id: 1 } });
  });

  it('requires an epoch on snapshots and round-trips rep.gone', () => {
    const gone: ServerMessage = { t: 'rep.gone', name: 'a:b', message: 'removed' };
    expect(decodeServerMessage(encodeMessage(gone))).toEqual({ ok: true, msg: gone });
    expect(
      decodeServerMessage('{"t":"rep.snap","id":1,"name":"a:b","rev":0,"value":1}'),
    ).toMatchObject({ ok: false });
  });
});

describe('hello', () => {
  it('refuses an unknown bundle with not_found', () => {
    const { sent, receive } = setup().connect(null);
    receive({ t: 'hello', v: PROTOCOL_VERSION, bundle: 'nope' });
    receive({ t: 'rep.sub', id: 1, name: 'scoreboard:score' });
    expect(sent).toMatchObject([
      { t: 'err', code: 'not_found' },
      { t: 'err', id: 1, code: 'bad_request' },
    ]);
    expect(sent[0]).not.toHaveProperty('id');
  });
});

describe('rep.sub with a last known state', () => {
  it('puts the epoch on a snapshot', () => {
    const { connect } = setup();
    const { sent, receive } = connect();
    receive({ t: 'rep.sub', id: 1, name: 'score' });
    expect(sent).toEqual([snapshot(1, 0, 0)]);
  });

  it('replays the missed patches and then acks the subscription', () => {
    const { bump, connect } = setup();
    for (let n = 1; n <= 3; n++) bump(n);
    const { sent, receive } = connect();

    receive({ t: 'rep.sub', id: 7, name: 'score', since: { epoch: EPOCH, rev: 1 } });

    expect(sent).toEqual([
      {
        t: 'rep.patch',
        name: 'scoreboard:score',
        rev: 2,
        patches: [{ op: 'replace', path: '/n', value: 2 }],
      },
      {
        t: 'rep.patch',
        name: 'scoreboard:score',
        rev: 3,
        patches: [{ op: 'replace', path: '/n', value: 3 }],
      },
      { t: 'ack', id: 7, rev: 3 },
    ]);
  });

  it('only acks when the client is current, and keeps it subscribed', () => {
    const { bump, connect } = setup();
    bump(1);
    const { sent, receive } = connect();

    receive({ t: 'rep.sub', id: 7, name: 'score', since: { epoch: EPOCH, rev: 1 } });
    bump(2);

    expect(sent.map((msg) => msg.t)).toEqual(['ack', 'rep.patch']);
    expect(sent[0]).toEqual({ t: 'ack', id: 7, rev: 1 });
  });

  it.each([
    ['another epoch', { epoch: 'boot-0', rev: 1 }],
    ['a revision ahead of the server', { epoch: EPOCH, rev: 9 }],
  ])('sends a snapshot for %s', (_label, since) => {
    const { bump, connect } = setup();
    bump(1);
    const { sent, receive } = connect();

    receive({ t: 'rep.sub', id: 7, name: 'score', since });

    expect(sent).toEqual([snapshot(7, 1, 1)]);
  });

  it('sends a snapshot when the gap is larger than the replay buffer', () => {
    const { bump, connect } = setup();
    for (let n = 1; n <= 150; n++) bump(n);
    const { sent, receive } = connect();

    receive({ t: 'rep.sub', id: 7, name: 'score', since: { epoch: EPOCH, rev: 10 } });

    expect(sent).toMatchObject([{ t: 'rep.snap', id: 7, rev: 150 }]);
  });

  it('sends a snapshot to a client of the replicant that was declared before', () => {
    const { bump, redeclare, connect } = setup();
    bump(1);
    redeclare();
    bump(5);
    const { sent, receive } = connect();

    // Same name, same revision number, but the value behind it is a different one.
    receive({ t: 'rep.sub', id: 7, name: 'score', since: { epoch: EPOCH, rev: 1 } });

    expect(sent).toMatchObject([{ t: 'rep.snap', id: 7, rev: 1, value: { n: 5 } }]);
    expect((sent[0] as { epoch: string }).epoch).not.toBe(EPOCH);
  });
});

describe('a removed replicant', () => {
  it('is announced to subscribers with rep.gone', () => {
    const { registry, connect } = setup();
    const { sent, receive } = connect();
    receive({ t: 'rep.sub', id: 1, name: 'score' });
    sent.length = 0;

    registry.undeclare('scoreboard');

    expect(sent).toEqual([
      { t: 'rep.gone', name: 'scoreboard:score', message: expect.stringContaining('removed') },
    ]);
  });
});
