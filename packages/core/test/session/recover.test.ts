import { describe, expect, it } from 'vitest';
import { MessageBus } from '../../src/messages/bus.js';
import {
  ALLOW_ALL_POLICY,
  ALLOW_ALL_PRINCIPAL,
  extensionPrincipal,
  type Policy,
  type Principal,
  TRUSTED_EXTENSION_POLICY,
} from '../../src/permissions/authorize.js';
import {
  type ClientMessage,
  decodeServerMessage,
  encodeMessage,
  PROTOCOL_VERSION,
  type ServerMessage,
} from '../../src/protocol/protocol.js';
import { ReplicantRegistry } from '../../src/replicant/registry.js';
import {
  type ConnectedPage,
  createSession,
  MAX_AWAITED_NAMES,
  type SessionOptions,
} from '../../src/session/session.js';

const timers = { setTimeout: () => 0, clearTimeout: () => {} };

function setup() {
  const registry = new ReplicantRegistry();
  const bus = new MessageBus({ timers });
  const declare = () => {
    registry.declare('scoreboard', 'score', { initial: { home: 0 }, read: 'view' });
    bus.declare('scoreboard', 'tick', { listen: 'view' });
  };
  const undeclare = () => {
    registry.undeclare('scoreboard');
    bus.undeclare('scoreboard');
  };
  declare();
  const connect = (
    options: Partial<SessionOptions> & { principal?: Principal; policy?: Policy } = {},
    hello: Partial<Extract<ClientMessage, { t: 'hello' }>> = {},
  ) => {
    const sent: ServerMessage[] = [];
    const session = createSession({
      principal: ALLOW_ALL_PRINCIPAL,
      policy: ALLOW_ALL_POLICY,
      registry,
      bus,
      timers,
      bundleExists: () => true,
      send: (msg) => sent.push(msg),
      ...options,
    });
    const receive = (msg: ClientMessage) => session.receive(encodeMessage(msg));
    receive({ t: 'hello', v: PROTOCOL_VERSION, bundle: 'scoreboard', ...hello });
    sent.length = 0;
    return { session, sent, receive };
  };
  return { registry, bus, declare, undeclare, connect };
}

describe('protocol version 6', () => {
  it('is what hello and welcome carry', () => {
    expect(PROTOCOL_VERSION).toBe(6);
  });

  it('round-trips rep.back and msg.back', () => {
    for (const t of ['rep.back', 'msg.back'] as const) {
      const msg: ServerMessage = { t, name: 'scoreboard:score' };
      expect(decodeServerMessage(encodeMessage(msg))).toEqual({ ok: true, msg });
    }
    expect(decodeServerMessage('{"t":"rep.back"}')).toMatchObject({ ok: false });
    expect(decodeServerMessage('{"t":"msg.back","name":""}')).toMatchObject({ ok: false });
  });
});

describe('a replicant that comes back', () => {
  it('is announced to a session that was subscribed when it went', () => {
    const { connect, declare, undeclare } = setup();
    const { sent, receive } = connect();
    receive({ t: 'rep.sub', id: 1, name: 'score' });
    undeclare();
    sent.length = 0;

    declare();

    expect(sent).toEqual([{ t: 'rep.back', name: 'scoreboard:score' }]);
  });

  it('is served again when the client subscribes after the announcement', () => {
    const { connect, declare, undeclare, registry } = setup();
    const { sent, receive } = connect();
    receive({ t: 'rep.sub', id: 1, name: 'score' });
    undeclare();
    declare();
    sent.length = 0;

    receive({ t: 'rep.sub', id: 2, name: 'score' });
    registry.get('scoreboard:score')?.replicant.applyOp({
      patches: [{ op: 'replace', path: '/home', value: 3 }],
    });

    expect(sent).toMatchObject([
      { t: 'rep.snap', id: 2, name: 'scoreboard:score', value: { home: 0 } },
      { t: 'rep.patch', name: 'scoreboard:score', rev: 1 },
    ]);
  });

  it('is announced once, not at every later declaration', () => {
    const { connect, declare, undeclare } = setup();
    const { sent, receive } = connect();
    receive({ t: 'rep.sub', id: 1, name: 'score' });
    undeclare();
    declare();
    // Never asked for again: a second round of the bundle is none of this client's business.
    sent.length = 0;
    undeclare();
    declare();

    expect(sent).toEqual([]);
  });

  it('is announced to a session that asked for it while it was not declared', () => {
    const { connect, declare, undeclare } = setup();
    undeclare();
    const { sent, receive } = connect();
    receive({ t: 'rep.sub', id: 1, name: 'score' });
    expect(sent).toMatchObject([{ t: 'err', id: 1, code: 'not_found' }]);
    sent.length = 0;

    declare();

    expect(sent).toEqual([{ t: 'rep.back', name: 'scoreboard:score' }]);
  });

  it('is not announced to a session that holds nothing of the bundle', () => {
    const { connect, declare, undeclare } = setup();
    undeclare();
    const { sent, receive } = connect(
      { principal: { id: 'v', roles: ['viewer'] }, policy: { roles: { viewer: [] } } },
      { bundle: 'system' },
    );
    receive({ t: 'rep.sub', id: 1, name: 'scoreboard:score' });
    sent.length = 0;

    declare();

    expect(sent).toEqual([]);
  });

  it('is not announced after the session closed, and nothing stays registered', () => {
    const { connect, declare, undeclare, registry } = setup();
    const { sent, receive, session } = connect();
    receive({ t: 'rep.sub', id: 1, name: 'score' });
    undeclare();
    session.close();
    sent.length = 0;

    declare();

    expect(sent).toEqual([]);
    expect(registry.stats().listeners).toBe(0);
    expect(registry.declareListenerCount).toBe(0);
  });

  it('remembers a bounded number of names only', () => {
    const { connect, registry, undeclare } = setup();
    undeclare();
    const { sent, receive } = connect();
    for (let index = 0; index <= MAX_AWAITED_NAMES; index++) {
      receive({ t: 'rep.sub', id: index + 1, name: `r${index}` });
    }
    sent.length = 0;

    registry.declare('scoreboard', `r${MAX_AWAITED_NAMES}`, { initial: 1 });
    registry.declare('scoreboard', 'r0', { initial: 1 });

    expect(sent).toEqual([{ t: 'rep.back', name: 'scoreboard:r0' }]);
  });
});

describe('a message topic that comes back', () => {
  it('is announced to a session that listened when it went', () => {
    const { connect, declare, undeclare } = setup();
    const { sent, receive } = connect();
    receive({ t: 'msg.sub', id: 1, name: 'tick' });
    undeclare();
    expect(sent).toMatchObject([
      { t: 'ok', id: 1 },
      { t: 'msg.gone', name: 'scoreboard:tick' },
    ]);
    sent.length = 0;

    declare();

    expect(sent).toEqual([{ t: 'msg.back', name: 'scoreboard:tick' }]);
  });

  it('is announced to a session that asked to listen while it was not declared', () => {
    const { connect, declare, undeclare } = setup();
    undeclare();
    const { sent, receive } = connect();
    receive({ t: 'msg.sub', id: 1, name: 'tick' });
    sent.length = 0;

    declare();

    expect(sent).toEqual([{ t: 'msg.back', name: 'scoreboard:tick' }]);
  });

  it('is not awaited once the client stopped listening', () => {
    const { connect, declare, undeclare } = setup();
    const { sent, receive } = connect();
    receive({ t: 'msg.sub', id: 1, name: 'tick' });
    undeclare();
    receive({ t: 'msg.unsub', id: 2, name: 'tick' });
    sent.length = 0;

    declare();

    expect(sent).toEqual([]);
  });

  it('is not awaited by a failed send: only listening is', () => {
    const { connect, declare, undeclare } = setup();
    undeclare();
    const { sent, receive } = connect();
    receive({ t: 'msg.send', id: 1, name: 'tick', data: null });
    sent.length = 0;

    declare();

    expect(sent).toEqual([]);
  });

  it('releases its listener on the bus when the session closes', () => {
    const { connect, undeclare, bus } = setup();
    const { receive, session } = connect();
    receive({ t: 'msg.sub', id: 1, name: 'tick' });
    undeclare();
    session.close();

    expect(bus.declareListenerCount).toBe(0);
  });
});

describe('the pages of a bundle', () => {
  function pages() {
    const joined: { bundle: string; page: ConnectedPage }[] = [];
    let left = 0;
    return {
      joined,
      get left() {
        return left;
      },
      join(bundle: string, page: ConnectedPage) {
        joined.push({ bundle, page });
        return () => {
          left++;
        };
      },
    };
  }

  it('lists a page under its bundle once it is welcome', () => {
    const registry = pages();
    setup().connect({ pages: registry });
    expect(registry.joined).toMatchObject([{ bundle: 'scoreboard', page: { graphic: false } }]);
  });

  it('knows a page that said which graphic it is as a graphic', () => {
    const registry = pages();
    setup().connect({ pages: registry }, { graphic: 'graphics/overlay.html' });
    expect(registry.joined[0]?.page.graphic).toBe(true);
  });

  it('tells the page to load itself again', () => {
    const registry = pages();
    const { sent } = setup().connect({ pages: registry });
    registry.joined[0]?.page.reload();
    expect(sent).toEqual([{ t: 'reload' }]);
  });

  it('takes the page off the list when the session closes, and tells it nothing after', () => {
    const registry = pages();
    const { session, sent } = setup().connect({ pages: registry });
    session.close();
    registry.joined[0]?.page.reload();
    expect(registry.left).toBe(1);
    expect(sent).toEqual([]);
  });

  it('does not list a page whose hello was refused', () => {
    const registry = pages();
    setup().connect({ pages: registry, bundleExists: () => false });
    expect(registry.joined).toEqual([]);
  });

  it("does not list a bundle's extension: it is no page", () => {
    const registry = pages();
    setup().connect({
      pages: registry,
      principal: extensionPrincipal('scoreboard'),
      policy: TRUSTED_EXTENSION_POLICY,
      extension: { capabilities: [], permissions: [] },
    });
    expect(registry.joined).toEqual([]);
  });
});
