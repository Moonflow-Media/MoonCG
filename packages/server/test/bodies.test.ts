import type { IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { readWhole, requestBody } from '../src/http/bodies.js';

const pace = { windowMs: 100, minBytes: 1024 };
const raw = (stream: PassThrough) => stream as unknown as IncomingMessage;

describe('requestBody', () => {
  it('reads a body that arrives in time', async () => {
    const stream = new PassThrough();
    const body = requestBody(raw(stream), null, pace);
    stream.end(Buffer.alloc(4096, 1));
    expect((await readWhole(body.pieces))?.length).toBe(4096);
    expect(body).toMatchObject({ complete: true, tooSlow: false, overLimit: false });
  });

  it('fails a body from a client that sends nothing more', async () => {
    const stream = new PassThrough();
    const body = requestBody(raw(stream), null, pace);
    stream.write(Buffer.alloc(10));
    await expect(readWhole(body.pieces)).rejects.toMatchObject({ code: 'timeout' });
    expect(body).toMatchObject({ complete: false, tooSlow: true });
  });

  it('fails a body that trickles in slower than the least it must deliver', async () => {
    const stream = new PassThrough();
    const body = requestBody(raw(stream), null, pace);
    const trickle = setInterval(() => stream.write(Buffer.alloc(1)), 20);
    try {
      await expect(readWhole(body.pieces)).rejects.toMatchObject({ code: 'timeout' });
    } finally {
      clearInterval(trickle);
    }
    expect(body.tooSlow).toBe(true);
  });

  it('does not count the time the reader takes', async () => {
    const stream = new PassThrough();
    const body = requestBody(raw(stream), null, pace);
    stream.end(Buffer.alloc(2048, 1));
    const iterator = body.pieces[Symbol.asyncIterator]();
    expect((await iterator.next()).done).toBe(false);
    // The reader waits longer than a window; the client is not to blame for that.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await iterator.next()).done).toBe(true);
    expect(body.tooSlow).toBe(false);
  });

  it('keeps the limit', async () => {
    const stream = new PassThrough();
    const body = requestBody(raw(stream), 100, pace);
    stream.end(Buffer.alloc(200));
    await expect(readWhole(body.pieces)).rejects.toMatchObject({ code: 'bad_request' });
    expect(body.overLimit).toBe(true);
  });
});
