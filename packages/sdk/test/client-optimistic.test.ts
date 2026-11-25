import {
  ALLOW_ALL_POLICY,
  ALLOW_ALL_PRINCIPAL,
  createSession,
  type Json,
  MAX_PENDING_WRITES,
  MoonCGError,
  ReplicantRegistry,
  type Session,
} from '@mooncg/core';
import { describe, expect, it } from 'vitest';
import { effectScope } from 'vue';
import { createClient, type SocketLike } from '../src/client/index.js';
import { useReplicant } from '../src/vue/index.js';
import { NAME, type Score, tick, withScore } from './fake-socket.js';

type Listener = (event: { data?: unknown }) => void;

/**
 * A socket wired to a real session. What the client sends is handled at once (unless the
 * socket drops it); what the server answers waits in `inbox` until `flush()`, so that a test
 * sees the client between a write and its confirmation.
 */
class BridgeSocket implements SocketLike {
  readonly inbox: string[] = [];
  readonly session: Session;
  /** While set, frames from the client are lost on the way, as on a dying connection. */
  dropping = false;
  closed = false;
  readonly #listeners = new Map<string, Listener[]>();

  constructor(registry: ReplicantRegistry) {
    this.session = createSession({
      principal: ALLOW_ALL_PRINCIPAL,
      policy: ALLOW_ALL_POLICY,
      registry,
      bundleExists: () => true,
      send: (msg) => this.inbox.push(JSON.stringify(msg)),
    });
    queueMicrotask(() => this.#emit('open', {}));
  }

  addEventListener(type: string, listener: Listener): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }

  send(data: string): void {
    if (!this.dropping && !this.closed) this.session.receive(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.session.close();
    this.#emit('close', {});
  }

  /** Delivers what the server sent so far, in order. */
  flush(): void {
    while (this.inbox.length > 0 && !this.closed) {
      this.#emit('message', { data: this.inbox.shift() });
    }
  }

  #emit(type: string, event: { data?: unknown }): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

/** A server with a `score` replicant whose schema allows at most 5 points per team. */
function server() {
  const registry = new ReplicantRegistry();
  const entry = registry.declare('scoreboard', 'score', {
    initial: { home: 0, away: 0 },
    validate: (value) => {
      const score = value as unknown as Score;
      return score.home > 5 || score.away > 5 ? ['/home must be <= 5'] : null;
    },
  });
  const sockets: BridgeSocket[] = [];
  const client = createClient({
    bundle: 'scoreboard',
    url: 'ws://test/ws',
    reconnectDelayMs: 0,
    createSocket: () => {
      const socket = new BridgeSocket(registry);
      sockets.push(socket);
      return socket;
    },
  });
  const socket = () => sockets.at(-1) as BridgeSocket;
  /** Lets the client connect and subscribe, answering everything on the way. */
  const settle = async () => {
    for (let round = 0; round < 5; round++) {
      await tick();
      socket().flush();
    }
  };
  /** Writes as somebody else, straight to the replicant on the server. */
  const writeElsewhere = (value: Score) =>
    entry.replicant.applyOp({
      patches: [{ op: 'replace', path: '', value: value as unknown as Json }],
    });
  return { client, entry, socket, sockets, settle, writeElsewhere, registry };
}

async function connected() {
  const context = server();
  const score = context.client.replicant<Score>('score', { optimistic: true });
  await context.settle();
  await score.ready;
  const seen: Score[] = [];
  score.subscribe((value) => seen.push(value));
  seen.length = 0;
  return { ...context, score, seen };
}

/** The answers to ops the server has sent and the client has not read yet. */
const opsSent = (socket: BridgeSocket) => socket.inbox.filter((m) => m.includes('"t":"ack"'));

describe('optimistic replicants', () => {
  it('shows a set at once and keeps it when the server confirms', async () => {
    const { score, socket, seen, entry } = await connected();

    const write = score.set({ home: 3, away: 1 });
    await tick();

    expect(score.value).toEqual({ home: 3, away: 1 });
    expect(seen).toEqual([{ home: 3, away: 1 }]);
    expect(entry.replicant.value).toEqual({ home: 3, away: 1 });
    const shown = score.value;

    socket().flush();
    await expect(write).resolves.toBeUndefined();
    expect(score.value).toBe(shown);
    expect(seen).toHaveLength(1);
  });

  it('keeps pending writes in order and sends one at a time', async () => {
    const { score, socket, seen, entry } = await connected();

    const writes = [
      score.update((draft) => {
        draft.home += 1;
      }),
      score.set({ home: 4, away: 0 }),
      score.update((draft) => {
        draft.away += 2;
      }),
    ];
    await tick();

    expect(score.value).toEqual({ home: 4, away: 2 });
    expect(seen).toEqual([
      { home: 1, away: 0 },
      { home: 4, away: 0 },
      { home: 4, away: 2 },
    ]);
    // Only the first write has reached the server; the others wait for its answer.
    expect(entry.replicant.rev).toBe(1);
    expect(opsSent(socket())).toHaveLength(1);

    for (let round = 0; round < 4; round++) {
      socket().flush();
      await tick();
    }

    await expect(Promise.all(writes)).resolves.toBeDefined();
    expect(entry.replicant.value).toEqual({ home: 4, away: 2 });
    expect(entry.replicant.rev).toBe(3);
    expect(score.value).toEqual({ home: 4, away: 2 });
    // Confirmations of what is already shown notify nobody.
    expect(seen).toHaveLength(3);
  });

  it('re-runs a recipe on conflict and shows the rebased value, never one applied twice', async () => {
    const { score, seen, entry, writeElsewhere, settle } = await connected();
    // Somebody else changes the value; the client has not heard of it yet.
    writeElsewhere({ home: 2, away: 2 });

    const write = score.update((draft) => {
      draft.home += 1;
    });
    await tick();
    expect(score.value).toEqual({ home: 1, away: 0 });

    await settle();
    await expect(write).resolves.toBeUndefined();

    expect(entry.replicant.value).toEqual({ home: 3, away: 2 });
    expect(score.value).toEqual({ home: 3, away: 2 });
    expect(seen).toEqual([
      { home: 1, away: 0 },
      { home: 3, away: 2 },
    ]);
  });

  it('rolls back a write the schema refuses and rebases the writes after it', async () => {
    const { score, seen, entry, settle } = await connected();

    // Caught at once: it is refused while the test is still busy answering.
    const refused = score.set({ home: 9, away: 0 }).catch((error: unknown) => error);
    const later = score.update((draft) => {
      draft.away += 1;
    });
    await tick();
    expect(score.value).toEqual({ home: 9, away: 1 });

    await settle();

    await expect(refused).resolves.toMatchObject({ code: 'invalid' });
    await expect(later).resolves.toBeUndefined();
    expect(entry.replicant.value).toEqual({ home: 0, away: 1 });
    expect(score.value).toEqual({ home: 0, away: 1 });
    // The rolled-back value without the later write is never shown on its own.
    expect(seen).toEqual([
      { home: 9, away: 0 },
      { home: 9, away: 1 },
      { home: 0, away: 1 },
    ]);
  });

  it('shows changes of others that arrive while nothing is pending at once', async () => {
    const { score, socket, seen, writeElsewhere } = await connected();
    writeElsewhere({ home: 5, away: 5 });
    socket().flush();
    expect(score.value).toEqual({ home: 5, away: 5 });
    expect(seen).toEqual([{ home: 5, away: 5 }]);
  });

  it('rejects the write in flight when the connection drops after the server applied it', async () => {
    const { score, socket, entry, settle, seen } = await connected();
    const inFlight = score.set({ home: 1, away: 0 });
    const queued = score.update((draft) => {
      draft.away += 1;
    });
    await tick();
    // The server applied the first write, but its answer is lost with the connection.
    expect(entry.replicant.value).toEqual({ home: 1, away: 0 });
    socket().inbox.length = 0;
    socket().close();

    await expect(inFlight).rejects.toMatchObject({ code: 'disconnected' });
    // Still shown: whether it took effect is only known once the client is back.
    expect(score.value).toEqual({ home: 1, away: 1 });

    await settle();

    await expect(queued).resolves.toBeUndefined();
    expect(entry.replicant.value).toEqual({ home: 1, away: 1 });
    expect(score.value).toEqual({ home: 1, away: 1 });
    expect(seen).toEqual([
      { home: 1, away: 0 },
      { home: 1, away: 1 },
    ]);
  });

  it('drops the write in flight when the server never got it, and sends the rest after a reconnect', async () => {
    const { score, socket, entry, settle, seen } = await connected();
    socket().dropping = true;
    const lost = score.set({ home: 4, away: 0 });
    const queued = score.update((draft) => {
      draft.away += 1;
    });
    await tick();
    expect(score.value).toEqual({ home: 4, away: 1 });
    socket().close();
    await expect(lost).rejects.toMatchObject({ code: 'disconnected' });

    await settle();

    await expect(queued).resolves.toBeUndefined();
    expect(entry.replicant.value).toEqual({ home: 0, away: 1 });
    expect(score.value).toEqual({ home: 0, away: 1 });
    expect(seen).toEqual([
      { home: 4, away: 0 },
      { home: 4, away: 1 },
      { home: 0, away: 1 },
    ]);
  });

  it('keeps writes made while reconnecting and sends them once the client is back', async () => {
    const { score, socket, entry, settle } = await connected();
    socket().close();
    const write = score.update((draft) => {
      draft.home += 2;
    });
    await tick();
    expect(score.value).toEqual({ home: 2, away: 0 });

    await settle();

    await expect(write).resolves.toBeUndefined();
    expect(entry.replicant.value).toEqual({ home: 2, away: 0 });
  });

  it('rejects every pending write when the client is closed', async () => {
    const { client, score, socket } = await connected();
    socket().dropping = true;
    const first = score.set({ home: 1, away: 0 });
    const second = score.set({ home: 2, away: 0 });
    await tick();
    client.close();
    await expect(first).rejects.toBeInstanceOf(MoonCGError);
    await expect(second).rejects.toMatchObject({ code: 'disconnected' });
  });

  it('rejects a set of something that is not JSON without showing it', async () => {
    const { score, seen } = await connected();
    await expect(score.set({ home: 1, away: new Date() } as never)).rejects.toMatchObject({
      code: 'bad_request',
    });
    expect(seen).toEqual([]);
  });

  it('stays optimistic once asked, for every handle of the name in this client', async () => {
    const { client, score, entry } = await connected();
    const plain = client.replicant<Score>('score');
    expect(plain).toBe(score);
    void plain.set({ home: 2, away: 2 });
    await tick();
    expect(plain.value).toEqual({ home: 2, away: 2 });
    expect(entry.replicant.value).toEqual({ home: 2, away: 2 });
  });

  it('feeds the Vue hook the optimistic value', async () => {
    const { score } = await connected();
    const scope = effectScope();
    const used = scope.run(() => useReplicant(score)) as ReturnType<typeof useReplicant<Score>>;
    void used.set({ home: 5, away: 0 });
    await tick();
    expect(used.data.value).toEqual({ home: 5, away: 0 });
    scope.stop();
  });
});

describe('optimistic replicants under load', () => {
  it('holds a snapshot that comes while a write is out until the write is answered', async () => {
    const { score, socket, seen, entry } = await connected();
    const write = score.update((draft) => {
      draft.home++;
    });
    await tick();
    expect(score.value).toEqual({ home: 1, away: 0 });
    // The server applied the write. Its patch is lost, its answer comes late.
    const inbox = socket().inbox.splice(0);
    const ack = inbox.find((frame) => frame.includes('"t":"ack"')) as string;
    entry.replicant.applyOp({ patches: [{ op: 'replace', path: '/away', value: 5 }] });
    // The gap in revisions makes the client ask for a snapshot, which has the write in it.
    socket().flush();
    await tick();
    socket().flush();
    expect(score.value).toEqual({ home: 1, away: 0 });

    socket().inbox.push(ack);
    socket().flush();
    await expect(write).resolves.toBeUndefined();
    expect(score.value).toEqual({ home: 1, away: 5 });
    expect(seen.every((value) => value.home <= 1)).toBe(true);
  });

  it('sends only the last of the sets that wait, and settles them together', async () => {
    const { score, socket, entry, settle } = await connected();
    socket().dropping = true;
    const first = score.set({ home: 1, away: 0 });
    await tick();
    socket().dropping = false;
    const waiting = [2, 3, 4].map((home) => score.set({ home, away: 0 }));
    await tick();
    expect(score.value).toEqual({ home: 4, away: 0 });
    socket().close();
    await expect(first).rejects.toMatchObject({ code: 'disconnected' });

    const ops: string[] = [];
    const send = BridgeSocket.prototype.send;
    BridgeSocket.prototype.send = function (this: BridgeSocket, data: string) {
      if (data.includes('"t":"rep.op"')) ops.push(data);
      send.call(this, data);
    };
    try {
      await settle();
    } finally {
      BridgeSocket.prototype.send = send;
    }
    await expect(Promise.all(waiting)).resolves.toBeDefined();
    expect(ops).toHaveLength(1);
    expect(entry.replicant.value).toEqual({ home: 4, away: 0 });
  });

  it('refuses writes beyond the limit of those that wait', async () => {
    const { score, socket } = await connected();
    socket().dropping = true;
    const writes = Array.from({ length: MAX_PENDING_WRITES }, () =>
      score.update((draft) => {
        draft.away++;
      }),
    );
    for (const write of writes) write.catch(() => {});
    await tick();
    await expect(
      score.update((draft) => {
        draft.away++;
      }),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(score.value?.away).toBe(MAX_PENDING_WRITES);
  });

  it('leaves no unhandled rejection behind when a refused write is caught', async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', listener);
    try {
      const { score, settle } = await connected();
      // As without the option, a caller that ignores the promise of a refused write gets an
      // unhandled rejection; nothing inside the client adds one of its own.
      const refused = score.set({ home: 9, away: 0 }).catch((error: unknown) => error);
      const coalesced = score.set({ home: 8, away: 0 }).catch((error: unknown) => error);
      await settle();
      await expect(refused).resolves.toMatchObject({ code: 'invalid' });
      await expect(coalesced).resolves.toMatchObject({ code: 'invalid' });
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off('unhandledRejection', listener);
    }
    expect(unhandled).toEqual([]);
  });
});

describe('replicants without the option', () => {
  it('still wait for the server before the value changes', async () => {
    const { socket, score } = await withScore();
    const write = score.set({ home: 1, away: 1 });
    await tick();
    expect(score.value).toEqual({ home: 0, away: 0 });
    const op = socket().last('rep.op');
    socket().receive({
      t: 'rep.patch',
      name: NAME,
      rev: 1,
      patches: [{ op: 'replace', path: '', value: { home: 1, away: 1 } }],
    });
    socket().receive({ t: 'ack', id: op.id, rev: 1 });
    await expect(write).resolves.toBeUndefined();
    expect(score.value).toEqual({ home: 1, away: 1 });
  });
});
