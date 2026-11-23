import { describe, expect, it } from 'vitest';
import {
  ALLOW_ALL_POLICY,
  ALLOW_ALL_PRINCIPAL,
  type Policy,
  type Principal,
} from '../../src/permissions/authorize.js';
import {
  type ClientMessage,
  encodeMessage,
  PROTOCOL_VERSION,
  type ServerMessage,
} from '../../src/protocol/protocol.js';
import { ReplicantRegistry } from '../../src/replicant/registry.js';
import { createSession } from '../../src/session/session.js';

function setup() {
  const registry = new ReplicantRegistry();
  registry.declare('scoreboard', 'score', {
    initial: { home: 0, away: 0 },
    read: 'view',
    write: 'operate',
  });
  registry.declare('team-data', 'teams', { initial: ['red', 'blue'] });

  /** A session on a fake transport: `sent` collects what would go down the socket. */
  const connect = (
    options: { principal?: Principal; policy?: Policy; bundle?: string | null } = {},
  ) => {
    const sent: ServerMessage[] = [];
    const session = createSession({
      principal: options.principal ?? ALLOW_ALL_PRINCIPAL,
      policy: options.policy ?? ALLOW_ALL_POLICY,
      registry,
      bundleExists: () => true,
      send: (msg) => sent.push(msg),
    });
    const receive = (msg: ClientMessage) => session.receive(encodeMessage(msg));
    if (options.bundle !== null) {
      receive({ t: 'hello', v: PROTOCOL_VERSION, bundle: options.bundle ?? 'scoreboard' });
      sent.length = 0;
    }
    return { session, sent, receive };
  };
  return { registry, connect };
}

const viewerPolicy: Policy = { roles: { viewer: ['bundle:scoreboard:view'] } };
const viewer: Principal = { id: 'v', roles: ['viewer'] };

describe('session handshake', () => {
  it('answers hello with welcome', () => {
    const { sent, receive } = setup().connect({ bundle: null });
    receive({ t: 'hello', v: PROTOCOL_VERSION, bundle: 'scoreboard' });
    expect(sent).toEqual([{ t: 'welcome', v: PROTOCOL_VERSION }]);
  });

  it('rejects an unsupported protocol version', () => {
    const { sent, receive } = setup().connect({ bundle: null });
    receive({ t: 'hello', v: PROTOCOL_VERSION + 1, bundle: 'scoreboard' });
    expect(sent).toMatchObject([{ t: 'err', code: 'bad_request' }]);
  });

  it('rejects requests before hello', () => {
    const { sent, receive } = setup().connect({ bundle: null });
    receive({ t: 'rep.sub', id: 1, name: 'score' });
    expect(sent).toMatchObject([{ t: 'err', id: 1, code: 'bad_request' }]);
  });

  it('rejects a second hello', () => {
    const { sent, receive } = setup().connect();
    receive({ t: 'hello', v: PROTOCOL_VERSION, bundle: 'team-data' });
    expect(sent).toMatchObject([{ t: 'err', code: 'bad_request' }]);
  });

  it('answers malformed input with a bad_request error', () => {
    const { session, sent } = setup().connect();
    session.receive('{not json');
    expect(sent).toMatchObject([{ t: 'err', code: 'bad_request' }]);
  });
});

describe('rep.sub', () => {
  it('sends a snapshot under the qualified name', () => {
    const { sent, receive } = setup().connect();
    receive({ t: 'rep.sub', id: 1, name: 'score' });
    expect(sent).toEqual([
      {
        t: 'rep.snap',
        id: 1,
        name: 'scoreboard:score',
        rev: 0,
        value: { home: 0, away: 0 },
        epoch: '1',
      },
    ]);
  });

  it('resolves cross-bundle names', () => {
    const { sent, receive } = setup().connect();
    receive({ t: 'rep.sub', id: 1, name: 'team-data:teams' });
    expect(sent).toMatchObject([
      { t: 'rep.snap', name: 'team-data:teams', value: ['red', 'blue'] },
    ]);
  });

  it('returns not_found for an undeclared replicant and never declares it', () => {
    const { registry, connect } = setup();
    const { sent, receive } = connect();
    receive({ t: 'rep.sub', id: 1, name: 'made-up' });
    expect(sent).toMatchObject([{ t: 'err', id: 1, code: 'not_found' }]);
    expect(registry.get('scoreboard:made-up')).toBeUndefined();
  });

  it('returns forbidden without the read permission', () => {
    const { sent, receive } = setup().connect({ principal: viewer, policy: { roles: {} } });
    receive({ t: 'rep.sub', id: 1, name: 'score' });
    expect(sent).toMatchObject([{ t: 'err', id: 1, code: 'forbidden' }]);
  });

  it('does not deliver patches twice after subscribing twice', () => {
    const { connect } = setup();
    const a = connect();
    a.receive({ t: 'rep.sub', id: 1, name: 'score' });
    a.receive({ t: 'rep.sub', id: 2, name: 'score' });
    a.sent.length = 0;

    connect().receive({
      t: 'rep.op',
      id: 1,
      name: 'score',
      patches: [{ op: 'replace', path: '/home', value: 1 }],
    });

    expect(a.sent.filter((msg) => msg.t === 'rep.patch')).toHaveLength(1);
  });
});

describe('rep.op', () => {
  const patches = [{ op: 'replace', path: '/home', value: 1 }] as const;

  it('commits, broadcasts the patch to subscribers and acks the sender', () => {
    const { registry, connect } = setup();
    const watcher = connect();
    const writer = connect();
    watcher.receive({ t: 'rep.sub', id: 1, name: 'score' });
    watcher.sent.length = 0;

    writer.receive({ t: 'rep.op', id: 5, name: 'score', baseRev: 0, patches: [...patches] });

    expect(writer.sent).toEqual([{ t: 'ack', id: 5, rev: 1 }]);
    expect(watcher.sent).toEqual([{ t: 'rep.patch', name: 'scoreboard:score', rev: 1, patches }]);
    expect(registry.get('scoreboard:score')?.replicant.value).toEqual({ home: 1, away: 0 });
  });

  it('delivers the patch to a subscribed sender before its ack', () => {
    const { sent, receive } = setup().connect();
    receive({ t: 'rep.sub', id: 1, name: 'score' });
    sent.length = 0;

    receive({ t: 'rep.op', id: 2, name: 'score', baseRev: 0, patches: [...patches] });

    expect(sent.map((msg) => msg.t)).toEqual(['rep.patch', 'ack']);
  });

  it('rejects a stale baseRev with conflict and broadcasts nothing', () => {
    const { connect } = setup();
    const watcher = connect();
    const writer = connect();
    watcher.receive({ t: 'rep.sub', id: 1, name: 'score' });
    writer.receive({ t: 'rep.op', id: 1, name: 'score', baseRev: 0, patches: [...patches] });
    watcher.sent.length = 0;
    writer.sent.length = 0;

    writer.receive({ t: 'rep.op', id: 2, name: 'score', baseRev: 0, patches: [...patches] });

    expect(writer.sent).toMatchObject([{ t: 'err', id: 2, code: 'conflict' }]);
    expect(watcher.sent).toEqual([]);
  });

  it('returns not_found for an undeclared replicant', () => {
    const { sent, receive } = setup().connect();
    receive({ t: 'rep.op', id: 1, name: 'made-up', patches: [] });
    expect(sent).toMatchObject([{ t: 'err', id: 1, code: 'not_found' }]);
  });

  it('returns forbidden without the write permission and changes nothing', () => {
    const { registry, connect } = setup();
    const { sent, receive } = connect({ principal: viewer, policy: viewerPolicy });

    receive({ t: 'rep.sub', id: 1, name: 'score' });
    receive({ t: 'rep.op', id: 2, name: 'score', patches: [...patches] });

    expect(sent).toMatchObject([{ t: 'rep.snap' }, { t: 'err', id: 2, code: 'forbidden' }]);
    expect(registry.get('scoreboard:score')?.replicant.rev).toBe(0);
  });

  it('passes engine rejections through with their code', () => {
    const { sent, receive } = setup().connect();
    receive({ t: 'rep.op', id: 1, name: 'score', patches: [{ op: 'remove', path: '/nope' }] });
    expect(sent).toMatchObject([{ t: 'err', id: 1, code: 'bad_request' }]);
  });
});

describe('session close', () => {
  it('stops delivering patches', () => {
    const { connect } = setup();
    const gone = connect();
    gone.receive({ t: 'rep.sub', id: 1, name: 'score' });
    gone.sent.length = 0;
    gone.session.close();

    connect().receive({
      t: 'rep.op',
      id: 1,
      name: 'score',
      patches: [{ op: 'replace', path: '/home', value: 1 }],
    });

    expect(gone.sent).toEqual([]);
  });
});
