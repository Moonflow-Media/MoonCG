import {
  type ClientMessage,
  decodeClientMessage,
  encodeMessage,
  PROTOCOL_VERSION,
  type ServerMessage,
} from '@mooncg/core';
import { createClient, type SocketLike } from '../src/client/index.js';

type Listener = (event: { data?: unknown }) => void;

/** The client message of a type, also where several types share one shape. */
type MessageOf<T extends ClientMessage['t']> = ClientMessage extends infer M
  ? M extends { t: infer Types }
    ? T extends Types
      ? M
      : never
    : never
  : never;

/** Stands in for a WebSocket: records what the client sends and lets the test play server. */
export class FakeSocket implements SocketLike {
  readonly sent: ClientMessage[] = [];
  closed = false;
  readonly #listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: Listener): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }

  send(data: string): void {
    const decoded = decodeClientMessage(data);
    if (!decoded.ok) throw new Error(`Client sent a malformed message: ${data}`);
    this.sent.push(decoded.msg);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.#emit('close', {});
  }

  open(): void {
    this.#emit('open', {});
  }

  receive(msg: ServerMessage): void {
    this.#emit('message', { data: encodeMessage(msg) });
  }

  /** Opens the socket and completes the handshake. */
  welcome(): void {
    this.open();
    this.receive({ t: 'welcome', v: PROTOCOL_VERSION });
  }

  /** The last request of the given type the client sent. */
  last<T extends ClientMessage['t']>(type: T): MessageOf<T> {
    const msg = this.sent.findLast((candidate) => candidate.t === type);
    if (!msg) throw new Error(`Client never sent ${type}`);
    return msg as MessageOf<T>;
  }

  #emit(type: string, event: { data?: unknown }): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

export const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
export const NAME = 'scoreboard:score';

export function setup() {
  const sockets: FakeSocket[] = [];
  const client = createClient({
    bundle: 'scoreboard',
    url: 'ws://test/ws',
    reconnectDelayMs: 0,
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
  });
  const socket = () => sockets.at(-1) as FakeSocket;
  return { client, sockets, socket };
}

export interface Score {
  home: number;
  away: number;
}

/** A connected client with a `score` replicant that has received its first snapshot. */
export async function withScore() {
  const context = setup();
  context.socket().welcome();
  const score = context.client.replicant<Score>('score');
  const sub = context.socket().last('rep.sub');
  context.socket().receive({
    t: 'rep.snap',
    epoch: 'e1',
    id: sub.id,
    name: NAME,
    rev: 0,
    value: { home: 0, away: 0 },
  });
  await score.ready;
  return { ...context, score };
}
