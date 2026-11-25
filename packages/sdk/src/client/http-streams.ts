import {
  base64ToBytes,
  bytesToBase64,
  type ClientMessage,
  MAX_STREAM_CHUNK_BYTES,
  MoonCGError,
  STREAM_WINDOW,
} from '@mooncg/core';

interface Incoming {
  readonly pieces: Uint8Array[];
  ended: boolean;
  error: MoonCGError | undefined;
  wake: (() => void) | undefined;
}

/**
 * The streamed request bodies an extension receives, by call. The server sends at most
 * `STREAM_WINDOW` pieces ahead; every piece the handler reads asks it for the next one.
 */
export class IncomingBodies {
  readonly #send: (msg: ClientMessage) => void;
  readonly #bodies = new Map<number, Incoming>();

  constructor(send: (msg: ClientMessage) => void) {
    this.#send = send;
  }

  /** The body of a call as a stream, which is also an async iterable in Node. */
  open(call: number): ReadableStream<Uint8Array> {
    const body: Incoming = { pieces: [], ended: false, error: undefined, wake: undefined };
    this.#bodies.set(call, body);
    return new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          for (;;) {
            const piece = body.pieces.shift();
            if (piece) {
              controller.enqueue(piece);
              if (!body.ended) this.#send({ t: 'http.pull', call });
              return;
            }
            if (body.error) {
              this.#forget(call, body);
              controller.error(body.error);
              return;
            }
            if (body.ended) {
              this.#forget(call, body);
              controller.close();
              return;
            }
            await new Promise<void>((resolve) => {
              body.wake = resolve;
            });
          }
        },
        cancel: () => {
          if (this.#bodies.get(call) === body) this.drop(call);
        },
      },
      { highWaterMark: 0 },
    );
  }

  data(call: number, data: string): void {
    const body = this.#bodies.get(call);
    if (!body || body.ended) return;
    body.pieces.push(base64ToBytes(data));
    this.#wake(body);
  }

  end(call: number): void {
    const body = this.#bodies.get(call);
    if (!body) return;
    body.ended = true;
    this.#wake(body);
  }

  abort(call: number, message: string): void {
    const body = this.#bodies.get(call);
    if (!body) return;
    body.error = new MoonCGError('unavailable', message);
    this.#wake(body);
  }

  /** The handler is done with the body. What it did not read is not wanted. */
  drop(call: number): void {
    const body = this.#bodies.get(call);
    if (!body) return;
    this.#bodies.delete(call);
    if (!body.ended && !body.error) this.#send({ t: 'http.cancel', call });
  }

  /**
   * The connection is gone: every body still being read fails, and is forgotten, because the
   * next connection numbers its calls anew.
   */
  closeAll(error: MoonCGError): void {
    for (const body of this.#bodies.values()) {
      body.error ??= error;
      this.#wake(body);
    }
    this.#bodies.clear();
  }

  /** Forgets a body, unless a call of a later connection has its number by now. */
  #forget(call: number, body: Incoming): void {
    if (this.#bodies.get(call) === body) this.#bodies.delete(call);
  }

  #wake(body: Incoming): void {
    body.wake?.();
    body.wake = undefined;
  }
}

interface Outgoing {
  credit: number;
  cancelled: boolean;
  wake: (() => void) | undefined;
}

/**
 * The streamed answers an extension sends, by call. At most `STREAM_WINDOW` pieces are sent
 * ahead of what the server has read; the source is not read further until it asks.
 */
export class OutgoingBodies {
  readonly #send: (msg: ClientMessage) => void;
  readonly #bodies = new Map<number, Outgoing>();

  constructor(send: (msg: ClientMessage) => void) {
    this.#send = send;
  }

  /** Sends the source in pieces. Resolves when it is sent, cancelled or failed. */
  async start(
    call: number,
    source: AsyncIterable<Uint8Array>,
    onError: (error: unknown) => void,
  ): Promise<void> {
    const body: Outgoing = { credit: STREAM_WINDOW, cancelled: false, wake: undefined };
    this.#bodies.set(call, body);
    const iterator = source[Symbol.asyncIterator]();
    let finished = false;
    try {
      for (;;) {
        if (body.cancelled) return;
        const next = await iterator.next();
        if (next.done) {
          finished = true;
          break;
        }
        const piece = next.value;
        if (!(piece instanceof Uint8Array)) {
          throw new Error('A streamed body must yield Uint8Array pieces');
        }
        for (let offset = 0; offset < piece.length; offset += MAX_STREAM_CHUNK_BYTES) {
          while (body.credit === 0 && !body.cancelled) {
            await new Promise<void>((resolve) => {
              body.wake = resolve;
            });
          }
          if (body.cancelled) return;
          body.credit--;
          const data = bytesToBase64(piece.subarray(offset, offset + MAX_STREAM_CHUNK_BYTES));
          this.#send({ t: 'http.data', call, data });
        }
      }
      if (!body.cancelled) this.#send({ t: 'http.end', call });
    } catch (error) {
      finished = true;
      if (!body.cancelled) {
        onError(error);
        this.#send({ t: 'http.abort', call, message: 'The body of the answer broke off' });
      }
    } finally {
      // A call of a later connection may have the same number by now.
      if (this.#bodies.get(call) === body) this.#bodies.delete(call);
      if (!finished) {
        try {
          await iterator.return?.();
        } catch {
          // A source that fails while it is stopped has nothing left to say.
        }
      }
    }
  }

  pulled(call: number): void {
    const body = this.#bodies.get(call);
    if (!body) return;
    body.credit = Math.min(body.credit + 1, STREAM_WINDOW);
    this.#wake(body);
  }

  cancelled(call: number): void {
    const body = this.#bodies.get(call);
    if (!body) return;
    body.cancelled = true;
    this.#wake(body);
  }

  /** The connection is gone: every answer still being sent stops and is forgotten. */
  closeAll(): void {
    for (const call of [...this.#bodies.keys()]) this.cancelled(call);
    this.#bodies.clear();
  }

  #wake(body: Outgoing): void {
    body.wake?.();
    body.wake = undefined;
  }
}
