import { MoonCGError } from '../errors.js';
import { base64ToBytes, bytesToBase64 } from '../http/base64.js';
import { MAX_STREAM_CHUNK_BYTES, STREAM_WINDOW, type StreamMessage } from '../protocol/protocol.js';

/**
 * The streamed bodies of one HTTP call between the server and an extension: the request body
 * the server sends, and the response body the extension sends. Each side may have at most
 * `STREAM_WINDOW` pieces on their way that the other has not taken; the receiver asks for the
 * next with `http.pull`. So neither side ever holds more than a few pieces of a body.
 */
export class HttpExchange {
  readonly call: number;
  /**
   * Whether a body of the call streams, the request's or the answer's. Such a call holds one
   * of the few places a connection has for streamed bodies until both bodies are over.
   */
  streamed = false;
  readonly #send: (msg: StreamMessage) => void;
  readonly #onDone: () => void;
  /** Pieces of the request body the extension may still be sent before it asks for more. */
  #credit = STREAM_WINDOW;
  #wakeSender: (() => void) | undefined;
  /** The request body is being sent and the extension still wants it. */
  #requestOpen = false;
  /** The call has been answered or has failed. */
  #settled = false;
  /** The extension streams its answer and it is not over yet. */
  #responding = false;
  readonly #pieces: Uint8Array[] = [];
  #ended = false;
  #error: MoonCGError | undefined;
  #wakeReader: (() => void) | undefined;
  #done = false;

  constructor(call: number, send: (msg: StreamMessage) => void, onDone: () => void) {
    this.call = call;
    this.#send = send;
    this.#onDone = onDone;
  }

  /**
   * Sends the request body in pieces, as fast as the extension takes them. Rejects with the
   * body's own error when it breaks off, after telling the extension so. `onActivity` is
   * called for every piece sent, each one after the extension took one: it keeps a waiting
   * call from timing out while the extension reads.
   */
  async sendBody(body: AsyncIterable<Uint8Array>, onActivity: () => void): Promise<void> {
    if (this.#done) return;
    this.#requestOpen = true;
    const iterator = body[Symbol.asyncIterator]();
    let finished = false;
    try {
      for (;;) {
        if (!this.#requestOpen) return;
        const next = await iterator.next();
        if (next.done) {
          finished = true;
          break;
        }
        const piece = next.value;
        for (let offset = 0; offset < piece.length; offset += MAX_STREAM_CHUNK_BYTES) {
          while (this.#credit === 0 && this.#requestOpen) {
            await new Promise<void>((resolve) => {
              this.#wakeSender = resolve;
            });
          }
          if (!this.#requestOpen) return;
          this.#credit--;
          const data = bytesToBase64(piece.subarray(offset, offset + MAX_STREAM_CHUNK_BYTES));
          this.#send({ t: 'http.data', call: this.call, data });
          onActivity();
        }
      }
      if (this.#requestOpen) this.#send({ t: 'http.end', call: this.call });
    } catch (error) {
      finished = true;
      if (this.#requestOpen) {
        this.#send({ t: 'http.abort', call: this.call, message: 'The request body broke off' });
      }
      throw error;
    } finally {
      this.#requestOpen = false;
      // Whatever is left of the body is not wanted; its owner decides what that means.
      if (!finished) await iterator.return?.();
      this.#check();
    }
  }

  /** The extension took a piece of the request body. */
  pulled(): void {
    this.#credit = Math.min(this.#credit + 1, STREAM_WINDOW);
    this.#wakeSender?.();
    this.#wakeSender = undefined;
  }

  /** The extension wants no more of the request body. */
  cancelled(): void {
    this.#requestOpen = false;
    this.#wakeSender?.();
    this.#wakeSender = undefined;
  }

  /** The call has been answered, with `stream` when the body of the answer follows. */
  settled(stream: boolean): void {
    this.#settled = true;
    this.#responding = stream && !this.#done;
    this.#check();
  }

  /** A piece of the answer. More than the window allows ends the exchange. */
  data(text: string): void {
    if (!this.#responding || this.#ended || this.#error) {
      this.#send({ t: 'http.cancel', call: this.call });
      return;
    }
    if (this.#pieces.length >= STREAM_WINDOW) {
      this.close(new MoonCGError('internal', 'The extension sent more than it was asked for'));
      return;
    }
    this.#pieces.push(base64ToBytes(text));
    this.#wake();
  }

  /** The answer is complete. */
  end(): void {
    if (!this.#responding) return;
    this.#ended = true;
    this.#wake();
  }

  /** The extension could not complete the answer. */
  aborted(message: string): void {
    if (!this.#responding || this.#ended) return;
    this.#error = new MoonCGError('unavailable', message);
    this.#wake();
  }

  /** The answer's body, piece by piece. Each piece read asks the extension for the next. */
  response(): AsyncIterable<Uint8Array> {
    const next = async (): Promise<IteratorResult<Uint8Array>> => {
      for (;;) {
        const piece = this.#pieces.shift();
        if (piece) {
          if (!this.#ended && !this.#error) this.#send({ t: 'http.pull', call: this.call });
          return { done: false, value: piece };
        }
        if (this.#error) {
          this.#finishResponse();
          throw this.#error;
        }
        if (this.#ended || !this.#responding) {
          this.#finishResponse();
          return { done: true, value: undefined };
        }
        await new Promise<void>((resolve) => {
          this.#wakeReader = resolve;
        });
      }
    };
    const stop = async (): Promise<IteratorResult<Uint8Array>> => {
      if (this.#responding && !this.#ended && !this.#error) {
        this.#send({ t: 'http.cancel', call: this.call });
      }
      this.#finishResponse();
      return { done: true, value: undefined };
    };
    return { [Symbol.asyncIterator]: () => ({ next, return: stop }) };
  }

  /**
   * Ends the exchange: a request body still being sent stops, an answer still being read
   * fails with `error`. With `tell`, the extension learns that both are over.
   */
  close(error: MoonCGError, tell = true): void {
    if (this.#done) return;
    if (tell && this.#requestOpen) {
      this.#send({ t: 'http.abort', call: this.call, message: error.message });
    }
    if (tell && this.#responding && !this.#ended) {
      this.#send({ t: 'http.cancel', call: this.call });
    }
    this.#requestOpen = false;
    this.#wakeSender?.();
    this.#wakeSender = undefined;
    if (this.#responding && !this.#ended) this.#error ??= error;
    this.#wake();
    this.#finish();
  }

  #wake(): void {
    this.#wakeReader?.();
    this.#wakeReader = undefined;
  }

  #finishResponse(): void {
    this.#responding = false;
    this.#pieces.length = 0;
    this.#check();
  }

  #check(): void {
    if (this.#settled && !this.#requestOpen && !this.#responding) this.#finish();
  }

  #finish(): void {
    if (this.#done) return;
    this.#done = true;
    this.#onDone();
  }
}
