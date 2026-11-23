import { describe, expect, it, vi } from 'vitest';
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
import { nestedText } from '../nest.js';

function setup(registry = new ReplicantRegistry()) {
  registry.declare('scoreboard', 'score', { initial: { home: 0 } });
  const connect = () => {
    const sent: ServerMessage[] = [];
    const onError = vi.fn();
    const session = createSession({
      principal: ALLOW_ALL_PRINCIPAL,
      policy: ALLOW_ALL_POLICY,
      registry,
      bundleExists: () => true,
      send: (msg) => sent.push(msg),
      onError,
    });
    const receive = (msg: ClientMessage) => session.receive(encodeMessage(msg));
    receive({ t: 'hello', v: PROTOCOL_VERSION, bundle: 'scoreboard' });
    sent.length = 0;
    return { session, sent, receive, onError };
  };
  return { registry, connect };
}

/** A `rep.op` frame whose value is 100,000 nested arrays, about 200 KB of text. */
const deepOp = `{"t":"rep.op","id":9,"name":"score","patches":[{"op":"replace","path":"","value":${nestedText(100_000)}}]}`;

describe('protocol depth limit', () => {
  it('rejects a deeply nested patch value at decode, keeping the request id', () => {
    expect(decodeClientMessage(deepOp)).toMatchObject({
      ok: false,
      error: { t: 'err', id: 9, code: 'bad_request' },
    });
  });

  it('rejects a deeply nested snapshot from the server', () => {
    const text = `{"t":"rep.snap","id":1,"name":"a:b","rev":0,"value":${nestedText(100_000)}}`;
    expect(decodeServerMessage(text)).toMatchObject({ ok: false });
  });

  it('accepts values nested up to the limit', () => {
    const text = `{"t":"rep.op","id":1,"name":"s","patches":[{"op":"replace","path":"","value":${nestedText(64)}}]}`;
    expect(decodeClientMessage(text)).toMatchObject({ ok: true });
  });
});

describe('session resilience', () => {
  it('answers a 100,000-level deep op with bad_request and changes nothing', () => {
    const { registry, connect } = setup();
    const { session, sent } = connect();

    expect(() => session.receive(deepOp)).not.toThrow();

    expect(sent).toMatchObject([{ t: 'err', id: 9, code: 'bad_request' }]);
    expect(registry.get('scoreboard:score')?.replicant.rev).toBe(0);
  });

  it('turns an unexpected failure while handling a message into a typed error', () => {
    const registry = new ReplicantRegistry();
    const failure = new Error('registry exploded');
    const { connect } = setup(registry);
    const { sent, receive, onError } = connect();
    vi.spyOn(registry, 'get').mockImplementation(() => {
      throw failure;
    });

    expect(() => receive({ t: 'rep.sub', id: 4, name: 'score' })).not.toThrow();

    expect(sent).toMatchObject([{ t: 'err', id: 4, code: 'bad_request' }]);
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
  });

  it('acks an op without patches with the current rev and broadcasts nothing', () => {
    const { connect } = setup();
    const watcher = connect();
    const writer = connect();
    watcher.receive({ t: 'rep.sub', id: 1, name: 'score' });
    watcher.sent.length = 0;

    writer.receive({ t: 'rep.op', id: 2, name: 'score', patches: [] });

    expect(writer.sent).toEqual([{ t: 'ack', id: 2, rev: 0 }]);
    expect(watcher.sent).toEqual([]);
  });

  it('tells subscribers when a replicant is removed and stops serving it', () => {
    const { registry, connect } = setup();
    const { sent, receive } = connect();
    receive({ t: 'rep.sub', id: 1, name: 'score' });
    sent.length = 0;

    registry.undeclare('scoreboard');
    receive({ t: 'rep.op', id: 2, name: 'score', patches: [] });

    expect(sent).toMatchObject([
      { t: 'rep.gone', name: 'scoreboard:score' },
      { t: 'err', id: 2, code: 'not_found' },
    ]);
  });

  it('removes its close listeners when the session ends', () => {
    const { registry, connect } = setup();
    const { session, sent, receive } = connect();
    receive({ t: 'rep.sub', id: 1, name: 'score' });
    sent.length = 0;

    session.close();
    registry.undeclare('scoreboard');

    expect(sent).toEqual([]);
  });
});
