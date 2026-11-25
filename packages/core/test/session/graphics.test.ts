import { describe, expect, it } from 'vitest';
import type { Policy, Principal } from '../../src/permissions/authorize.js';
import {
  type ClientMessage,
  decodeClientMessage,
  decodeServerMessage,
  encodeMessage,
  PROTOCOL_VERSION,
  type ServerMessage,
} from '../../src/protocol/protocol.js';
import { ReplicantRegistry } from '../../src/replicant/registry.js';
import { createSession, type GraphicPages } from '../../src/session/session.js';

const policy: Policy = {
  roles: { viewer: ['bundle:scoreboard:view'], stats: ['bundle:scoreboard:stats'] },
};
const viewer: Principal = { id: 'user:v', roles: ['viewer'] };
const FILE = 'graphics/overlay.html';

/** Graphic pages as the server keeps them: one graphic, which takes a single instance. */
function pages() {
  const open: {
    principal: Principal;
    reload(): void;
    end(reason: 'replaced' | 'disconnected'): void;
  }[] = [];
  const graphics: GraphicPages = {
    find: (bundle, file) =>
      bundle === 'scoreboard' && file === FILE
        ? { permission: 'bundle:scoreboard:view' }
        : undefined,
    enter(_bundle, _file, instance) {
      if (open.length > 0) return undefined;
      open.push(instance);
      return () => {
        open.splice(open.indexOf(instance), 1);
      };
    },
  };
  return { open, graphics };
}

function connect(graphics: GraphicPages, principal: Principal = viewer) {
  const sent: ServerMessage[] = [];
  const session = createSession({
    principal,
    policy,
    registry: new ReplicantRegistry(),
    bundleExists: () => true,
    send: (msg) => sent.push(msg),
    graphics,
  });
  const receive = (msg: ClientMessage) => session.receive(encodeMessage(msg));
  return { session, sent, receive };
}

const hello = (graphic?: string): ClientMessage =>
  graphic === undefined
    ? { t: 'hello', v: PROTOCOL_VERSION, bundle: 'scoreboard' }
    : { t: 'hello', v: PROTOCOL_VERSION, bundle: 'scoreboard', graphic };

describe('the protocol version', () => {
  it('is version 7', () => {
    expect(PROTOCOL_VERSION).toBe(7);
  });

  it('carries the graphic a page is in hello', () => {
    const msg = hello(FILE);
    expect(decodeClientMessage(encodeMessage(msg))).toEqual({ ok: true, msg });
  });

  it.each(['', '../x.html', 'graphics\\x.html', 'a'.repeat(600), 7])(
    'refuses a hello whose graphic is %j',
    (graphic) => {
      const raw = { t: 'hello', v: PROTOCOL_VERSION, bundle: 'scoreboard', graphic };
      expect(decodeClientMessage(JSON.stringify(raw)).ok).toBe(false);
    },
  );

  it('decodes the request to reload', () => {
    expect(decodeServerMessage(JSON.stringify({ t: 'reload', extra: 1 }))).toEqual({
      ok: true,
      msg: { t: 'reload' },
    });
  });
});

describe('a session of a graphic page', () => {
  it('registers the instance and lets go of it when the connection closes', () => {
    const { open, graphics } = pages();
    const { session, sent, receive } = connect(graphics);
    receive(hello(FILE));
    expect(sent).toEqual([{ t: 'welcome', v: PROTOCOL_VERSION }]);
    expect(open.map((instance) => instance.principal.id)).toEqual(['user:v']);
    session.close();
    expect(open).toEqual([]);
  });

  it('tells a second instance of a single-instance graphic that it is a duplicate', () => {
    const { open, graphics } = pages();
    connect(graphics).receive(hello(FILE));
    const second = connect(graphics);
    second.receive(hello(FILE));
    expect(second.sent).toEqual([
      { t: 'err', code: 'conflict', message: expect.stringContaining('already open') },
    ]);
    expect(open).toHaveLength(1);
    // The refused connection has not said hello: it gets nothing.
    second.receive({ t: 'rep.sub', id: 1, name: 'score' });
    expect(second.sent.at(-1)).toMatchObject({ t: 'err', id: 1, code: 'bad_request' });
  });

  it('takes the place once the first instance is gone', () => {
    const { graphics } = pages();
    const first = connect(graphics);
    first.receive(hello(FILE));
    first.session.close();
    const second = connect(graphics);
    second.receive(hello(FILE));
    expect(second.sent).toEqual([{ t: 'welcome', v: PROTOCOL_VERSION }]);
  });

  it('refuses whoever may not open the graphic, and registers nothing', () => {
    const { open, graphics } = pages();
    const { sent, receive } = connect(graphics, { id: 'user:s', roles: ['stats'] });
    receive(hello(FILE));
    expect(sent).toEqual([
      { t: 'err', code: 'forbidden', message: 'Missing permission "bundle:scoreboard:view"' },
    ]);
    expect(open).toEqual([]);
  });

  it('treats a file that is no graphic as any other page', () => {
    const { open, graphics } = pages();
    const { sent, receive } = connect(graphics);
    receive(hello('graphics/helper.html'));
    expect(sent).toEqual([{ t: 'welcome', v: PROTOCOL_VERSION }]);
    expect(open).toEqual([]);
  });

  it('sends the instance the request to reload', () => {
    const { open, graphics } = pages();
    const { sent, receive } = connect(graphics);
    receive(hello(FILE));
    open[0]?.reload();
    expect(sent.at(-1)).toEqual({ t: 'reload' });
  });

  it('tells the page that it is no longer the instance, and why', () => {
    const { open, graphics } = pages();
    const { sent, receive } = connect(graphics);
    receive(hello(FILE));
    open[0]?.end('replaced');
    expect(sent.at(-1)).toEqual({ t: 'graphic.end', reason: 'replaced' });
    expect(
      decodeServerMessage(encodeMessage({ t: 'graphic.end', reason: 'disconnected' })),
    ).toEqual({
      ok: true,
      msg: { t: 'graphic.end', reason: 'disconnected' },
    });
    expect(decodeServerMessage('{"t":"graphic.end","reason":"bored"}').ok).toBe(false);
  });

  it('registers nothing for a page that names no graphic', () => {
    const { open, graphics } = pages();
    connect(graphics).receive(hello());
    expect(open).toEqual([]);
  });
});
