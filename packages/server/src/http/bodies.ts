import type { IncomingMessage } from 'node:http';
import { MoonCGError } from '@mooncg/core';

/**
 * How fast a client must send a request body: at least `minBytes` in every `windowMs` the
 * server spends waiting for it. Time the server spends not reading, because whoever takes the
 * body is busy, does not count. A client that sends nothing at all fails after one window,
 * one that trickles in after the first window it sent too little in.
 */
export interface UploadPace {
  readonly windowMs: number;
  readonly minBytes: number;
}

/**
 * 16 KiB in every 10 seconds of waiting, about 1.6 KiB/s: far below any real connection, so
 * only a client that stalls or crawls on purpose fails, and it holds a place for at most
 * twice the window without sending.
 */
export const DEFAULT_UPLOAD_PACE: UploadPace = { windowMs: 10_000, minBytes: 16 * 1024 };

/** The body of a request to a bundle route, read as it arrives and counted against a limit. */
export interface RequestBody {
  /** The body piece by piece. Throws when it breaks the limit or the client goes away. */
  readonly pieces: AsyncIterable<Uint8Array>;
  /** Whether the body was larger than the limit. */
  readonly overLimit: boolean;
  /** Whether the client sent the body too slowly. See `UploadPace`. */
  readonly tooSlow: boolean;
  /** Whether all of the body was read. */
  readonly complete: boolean;
}

const WINDOW_OVER = Symbol('window over');

/**
 * Reads a request body without holding on to it. `limit` is in bytes, `null` for none.
 * Stopping early does not destroy the request: the answer can still be sent on its socket.
 */
export function requestBody(
  raw: IncomingMessage,
  limit: number | null,
  pace: UploadPace = DEFAULT_UPLOAD_PACE,
): RequestBody {
  let overLimit = false;
  let tooSlow = false;
  let complete = false;
  async function* read(): AsyncGenerator<Uint8Array> {
    const chunks = raw.iterator({ destroyOnReturn: false });
    let received = 0;
    /** Time spent waiting for the client in the current window, and what it sent in it. */
    let waited = 0;
    let sent = 0;
    const ask = () => {
      const next = chunks.next();
      // Left behind when the client is too slow; its failure then says nothing new.
      next.catch(() => {});
      return next;
    };
    let pending = ask();
    try {
      for (;;) {
        const started = performance.now();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const outcome = await Promise.race([
          pending,
          new Promise<typeof WINDOW_OVER>((resolve) => {
            timer = setTimeout(() => resolve(WINDOW_OVER), Math.max(0, pace.windowMs - waited));
          }),
        ]);
        clearTimeout(timer);
        waited += performance.now() - started;
        if (outcome !== WINDOW_OVER && outcome.done) {
          complete = true;
          return;
        }
        if (outcome !== WINDOW_OVER) sent += (outcome.value as Buffer).length;
        if (waited >= pace.windowMs) {
          if (sent < pace.minBytes) {
            tooSlow = true;
            throw new MoonCGError('timeout', 'The request body arrived too slowly');
          }
          waited = 0;
          sent = 0;
        }
        if (outcome === WINDOW_OVER) continue;
        const piece = outcome.value as Buffer;
        received += piece.length;
        if (limit !== null && received > limit) {
          overLimit = true;
          throw new MoonCGError('bad_request', 'The request body is too large');
        }
        yield piece;
        pending = ask();
      }
    } finally {
      // Not awaited: with a piece still asked for, it would wait for the client.
      if (!complete) chunks.return?.().catch(() => {});
    }
  }
  const pieces = read();
  return {
    pieces,
    get overLimit() {
      return overLimit;
    },
    get tooSlow() {
      return tooSlow;
    },
    get complete() {
      return complete;
    },
  };
}

/** All of a body, or `null` when it is empty. */
export async function readWhole(pieces: AsyncIterable<Uint8Array>): Promise<Buffer | null> {
  const parts: Uint8Array[] = [];
  for await (const piece of pieces) parts.push(piece);
  return parts.length === 0 ? null : Buffer.concat(parts);
}
