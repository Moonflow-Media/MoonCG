import { Agent, request as httpRequest, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { MessageBus, ReplicantRegistry, RouteTable } from '@mooncg/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BundleManager } from '../src/bundles/manager.js';
import { InlineHost } from '../src/extension-host/inline-host.js';
import { WorkerHost } from '../src/extension-host/worker-host.js';
import { createApp, resolveLocalAdmin } from '../src/http/app.js';
import { memoryLogger } from './helpers.js';
import { manifest, temporaryBundles } from './temp-bundles.js';

const MIB = 1024 * 1024;
const WAIT = { timeout: 10_000, interval: 20 };
const temporary = temporaryBundles();
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  await temporary.cleanup();
  delete (globalThis as { streamProbe?: unknown }).streamProbe;
});

/** What the inline extension reports to the test; it runs in this process. */
interface Probe {
  chunks: number;
  largest: number;
  produced: number;
  stopped: boolean;
  failed: string | undefined;
  release: (() => void) | undefined;
}

const probe = (): Probe => {
  const state = (globalThis as { streamProbe?: Probe }).streamProbe;
  if (!state) throw new Error('The extension has not started');
  return state;
};

const extension = `export default async function start(ctx) {
  const probe = (globalThis.streamProbe = {
    chunks: 0, largest: 0, produced: 0, stopped: false, failed: undefined, release: undefined,
  });
  const count = async (stream) => {
    let bytes = 0;
    try {
      for await (const chunk of stream) {
        probe.chunks++;
        probe.largest = Math.max(probe.largest, chunk.length);
        bytes += chunk.length;
      }
    } catch (error) {
      probe.failed = error.message;
      throw error;
    }
    return bytes;
  };
  await ctx.http.post('/upload', async (request) => ({ body: { bytes: await count(request.stream) } }), {
    stream: true,
    maxBodyBytes: 256 * 1024 * 1024,
  });
  await ctx.http.post('/slow', async (request) => {
    const reader = request.stream.getReader();
    let bytes = (await reader.read()).value.length;
    await new Promise((resolve) => { probe.release = resolve; });
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
    }
    return { body: { bytes } };
  }, { stream: true, maxBodyBytes: null });
  await ctx.http.post('/limited', async (request) => ({ body: { bytes: await count(request.stream) } }), {
    stream: true,
  });
  await ctx.http.get('/download/:mib', (request) => {
    const total = Number(request.params.mib) * 1024 * 1024;
    return {
      headers: { 'x-total': String(total) },
      body: (async function* () {
        try {
          for (let sent = 0; sent < total; sent += 65536) {
            probe.produced++;
            yield new Uint8Array(Math.min(65536, total - sent)).fill(7);
          }
        } finally {
          probe.stopped = true;
        }
      })(),
    };
  });
  await ctx.http.post('/buffered', (request) => ({ body: { bytes: request.body?.length ?? 0 } }));
  await ctx.http.post('/refuse', async (request) => {
    const reader = request.stream.getReader();
    await reader.read();
    throw new Error('refused after one piece');
  }, { stream: true, maxBodyBytes: null });
  await ctx.http.post('/unlimited', async (request) => ({ body: { bytes: await count(request.stream) } }), {
    stream: true,
    maxBodyBytes: null,
  });
  await ctx.http.get('/no-content', () => ({
    status: 204,
    body: (async function* () {
      try {
        yield new Uint8Array(10);
      } finally {
        probe.stopped = true;
      }
    })(),
  }));
}`;

async function serve(appOptions: Partial<Parameters<typeof createApp>[0]> = {}) {
  const dir = await temporary.create({
    'demo/mooncg.json': manifest('demo', {
      extension: 'extension/index.js',
      capabilities: ['http.routes'],
    }),
    'demo/extension/index.js': extension,
  });
  const registry = new ReplicantRegistry();
  const bus = new MessageBus({ timers: { setTimeout, clearTimeout } });
  const routes = new RouteTable();
  const { logger } = memoryLogger();
  const host = new InlineHost({ registry, bus, routes, logger, httpTimeoutMs: 5_000 });
  const manager = new BundleManager({ bundlesDir: dir, registry, bus, host, logger });
  await manager.start();
  cleanup.push(() => manager.close());
  const app = await createApp({
    resolvePrincipal: resolveLocalAdmin,
    bundles: () => manager.list(),
    routes,
    lifecycle: manager,
    sdkFile: undefined,
    maxBodyBytes: 64 * 1024,
    ...appOptions,
  });
  cleanup.push(() => app.close());
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  return { port, host };
}

/** A body of `total` bytes, produced only as fast as it is sent; `produced` counts it. */
function source(total: number) {
  const state = { produced: 0 };
  const stream = new Readable({
    highWaterMark: 64 * 1024,
    read() {
      const size = Math.min(64 * 1024, total - state.produced);
      if (size <= 0) this.push(null);
      else {
        state.produced += size;
        this.push(Buffer.alloc(size, 1));
      }
    },
  });
  return { stream, state };
}

function post(port: number, path: string, body: Readable, length?: number) {
  const headers: Record<string, string> = {
    'x-mooncg-csrf': '1',
    'content-type': 'application/octet-stream',
  };
  if (length !== undefined) headers['content-length'] = String(length);
  const sent = httpRequest({ host: '127.0.0.1', port, path, method: 'POST', headers });
  const answer = new Promise<{ status: number; text: string }>((resolve, reject) => {
    sent.on('response', (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (piece) => {
        text += piece;
      });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, text }));
    });
    sent.on('error', reject);
  });
  body.pipe(sent);
  return { request: sent, answer };
}

function get(port: number, path: string) {
  return new Promise<IncomingMessage>((resolve, reject) => {
    const sent = httpRequest({ host: '127.0.0.1', port, path }, resolve);
    sent.on('error', reject);
    sent.end();
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('streamed bodies of extension routes', () => {
  it('takes a large upload piece by piece', async () => {
    const { port } = await serve();
    const { stream } = source(24 * MIB);

    const { answer } = post(port, '/b/demo/api/upload', stream);

    const { status, text } = await answer;
    expect(status).toBe(200);
    expect(JSON.parse(text)).toEqual({ bytes: 24 * MIB });
    expect(probe().largest).toBeLessThanOrEqual(64 * 1024);
    expect(probe().chunks).toBeGreaterThanOrEqual(384);
  }, 30_000);

  it('reads an upload only as fast as the extension does', async () => {
    const { port } = await serve();
    const { stream, state } = source(32 * MIB);

    const { answer } = post(port, '/b/demo/api/slow', stream);
    await vi.waitFor(() => expect(probe().release).toBeDefined(), WAIT);
    await sleep(300);
    // The handler took one piece and waits: only what the buffers on the way hold was read.
    expect(state.produced).toBeLessThan(8 * MIB);

    probe().release?.();
    const { status, text } = await answer;
    expect(status).toBe(200);
    expect(JSON.parse(text)).toEqual({ bytes: 32 * MIB });
  }, 30_000);

  it('keeps the server limit for a streamed route without one, also without a length', async () => {
    const { port } = await serve();
    const declared = post(port, '/b/demo/api/limited', source(128 * 1024).stream, 128 * 1024);
    expect((await declared.answer).status).toBe(413);

    const chunked = post(port, '/b/demo/api/limited', source(256 * 1024).stream);
    const { status, text } = await chunked.answer.catch(() => ({ status: 413, text: '' }));
    expect(status).toBe(413);
    if (text) expect(JSON.parse(text)).toMatchObject({ error: { code: 'bad_request' } });
  });

  it('still buffers routes that do not stream, with the server limit', async () => {
    const { port } = await serve();
    const small = post(port, '/b/demo/api/buffered', source(1000).stream, 1000);
    expect(JSON.parse((await small.answer).text)).toEqual({ bytes: 1000 });
    const large = post(port, '/b/demo/api/buffered', source(128 * 1024).stream, 128 * 1024);
    expect((await large.answer).status).toBe(413);
  });

  it('sends a large download as the client reads it', async () => {
    const { port } = await serve();
    const response = await get(port, '/b/demo/api/download/32');
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/octet-stream');

    response.pause();
    await sleep(300);
    // Nothing was read: the extension made only what the buffers on the way hold.
    expect(probe().produced).toBeLessThan(128);

    let bytes = 0;
    response.on('data', (piece: Buffer) => {
      bytes += piece.length;
    });
    response.resume();
    await new Promise((resolve) => response.on('end', resolve));
    expect(bytes).toBe(32 * MIB);
    expect(probe().produced).toBe(512);
  }, 30_000);

  it('stops the download in the extension when the client goes away', async () => {
    const { port } = await serve();
    const response = await get(port, '/b/demo/api/download/64');
    await new Promise((resolve) => response.once('data', resolve));
    response.destroy();
    await vi.waitFor(() => expect(probe().stopped).toBe(true), WAIT);
    expect(probe().produced).toBeLessThan(1024);
  });

  it('fails the upload in the extension when the client goes away', async () => {
    const { port } = await serve();
    const { stream } = source(64 * MIB);
    const { request, answer } = post(port, '/b/demo/api/upload', stream);
    answer.catch(() => {});
    await vi.waitFor(() => expect(probe().chunks).toBeGreaterThan(2), WAIT);
    request.destroy();
    await vi.waitFor(() => expect(probe().failed).toBeDefined(), WAIT);
  });
});

/** A request on a connection of its own that is kept alive; resolves with the answer. */
function keepAlive(port: number, path: string, headers: Record<string, string>, body?: Buffer) {
  return new Promise<{
    status: number;
    headers: IncomingMessage['headers'];
    closed: Promise<void>;
  }>((resolve, reject) => {
    const sent = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      method: 'POST',
      agent: new Agent({ keepAlive: true }),
      headers: { 'x-mooncg-csrf': '1', ...headers },
    });
    sent.on('error', () => {});
    sent.on('response', (response) => {
      const socket = sent.socket;
      const closed = new Promise<void>((done) => {
        if (!socket || socket.destroyed) done();
        else socket.once('close', () => done());
      });
      response.resume();
      resolve({ status: response.statusCode ?? 0, headers: response.headers, closed });
    });
    sent.on('error', reject);
    if (body) sent.write(body);
    // The rest of the body never comes.
  });
}

describe('limits of streamed bodies', () => {
  it('answers 408 to a client that stops sending its upload', async () => {
    const { port } = await serve({ uploadPace: { windowMs: 200, minBytes: 1024 } });
    const answer = await keepAlive(
      port,
      '/b/demo/api/upload',
      { 'content-length': String(1024 * 1024), 'content-type': 'application/octet-stream' },
      Buffer.alloc(100),
    );
    expect(answer.status).toBe(408);
    expect(answer.headers.connection).toBe('close');
    await answer.closed;
    await vi.waitFor(() => expect(probe().failed).toBeDefined(), WAIT);
  });

  it('closes the connection when it answers an error before the upload is over', async () => {
    const { port } = await serve();
    const answer = await keepAlive(
      port,
      '/b/demo/api/refuse',
      { 'content-length': String(8 * MIB), 'content-type': 'application/octet-stream' },
      Buffer.alloc(128 * 1024),
    );
    expect(answer.status).toBe(500);
    expect(answer.headers.connection).toBe('close');
    await answer.closed;
  });

  it.each([
    ['/b/demo/api/nothing-here', 404],
    ['/b/nobody/api/upload', 404],
  ])('closes the connection when %s is refused before its body is read', async (path, status) => {
    const { port } = await serve();
    const answer = await keepAlive(port, path, { 'content-length': '1000' }, Buffer.alloc(10));
    expect(answer.status).toBe(status);
    expect(answer.headers.connection).toBe('close');
    await answer.closed;
  });

  it('caps every streamed route with maxStreamBodyBytes, also one without a limit', async () => {
    const { port } = await serve({ maxStreamBodyBytes: 256 * 1024 });
    const declared = post(port, '/b/demo/api/unlimited', source(512 * 1024).stream, 512 * 1024);
    // The answer comes before the body is read; the client may see the connection reset.
    expect((await declared.answer.catch(() => ({ status: 413 }))).status).toBe(413);
    const chunked = post(port, '/b/demo/api/upload', source(512 * 1024).stream);
    const { status } = await chunked.answer.catch(() => ({ status: 413 }));
    expect(status).toBe(413);
    const fits = post(port, '/b/demo/api/unlimited', source(200 * 1024).stream);
    expect(JSON.parse((await fits.answer).text)).toEqual({ bytes: 200 * 1024 });
  });

  it('ends a download whose client stops reading, and stops it in the extension', async () => {
    const { port, host } = await serve({ streamDrainTimeoutMs: 300 });
    const response = await get(port, '/b/demo/api/download/1024');
    response.pause();
    await vi.waitFor(() => expect(probe().stopped).toBe(true), WAIT);
    expect(probe().produced).toBeLessThan(16384);
    await vi.waitFor(() => expect(host.stats().ledger.demo?.streams ?? 0).toBe(0), WAIT);
  }, 30_000);

  it('stops a streamed answer that cannot have a body', async () => {
    const { port, host } = await serve();
    const response = await get(port, '/b/demo/api/no-content');
    expect(response.statusCode).toBe(204);
    await vi.waitFor(() => expect(probe().stopped).toBe(true), WAIT);
    await vi.waitFor(() => expect(host.stats().ledger.demo?.streams ?? 0).toBe(0), WAIT);
  });
});

describe('streamed bodies and a crashing worker', () => {
  const WORKER_BOOTSTRAP = new URL('./worker-bootstrap.mjs', import.meta.url);

  it('ends a download that is under way when the worker dies', async () => {
    const dir = await temporary.create({
      'demo/mooncg.json': manifest('demo', {
        extension: 'extension/index.js',
        capabilities: ['http.routes'],
      }),
      'demo/extension/index.js': `export default async function start(ctx) {
        await ctx.http.get('/endless', () => ({
          body: (async function* () {
            for (let n = 0; ; n++) {
              if (n === 20) setTimeout(() => { throw new Error('crash mid-stream'); }, 0);
              yield new Uint8Array(65536);
            }
          })(),
        }));
      }`,
    });
    const registry = new ReplicantRegistry();
    const bus = new MessageBus({ timers: { setTimeout, clearTimeout } });
    const routes = new RouteTable();
    const { logger } = memoryLogger();
    const host = new WorkerHost({ registry, bus, routes, logger, bootstrap: WORKER_BOOTSTRAP });
    const manager = new BundleManager({ bundlesDir: dir, registry, bus, host, logger });
    cleanup.push(() => manager.close());
    await manager.start();
    const app = await createApp({
      resolvePrincipal: resolveLocalAdmin,
      bundles: () => manager.list(),
      routes,
      lifecycle: manager,
      sdkFile: undefined,
    });
    cleanup.push(() => app.close());
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    await vi.waitFor(() => expect(routes.count('demo')).toBe(1), WAIT);

    const response = await get(port, '/b/demo/api/endless');
    expect(response.statusCode).toBe(200);
    const ended = await new Promise<string>((resolve) => {
      response.on('data', () => {});
      response.on('end', () => resolve('end'));
      response.on('aborted', () => resolve('aborted'));
      response.on('error', () => resolve('error'));
      response.on('close', () => resolve(response.complete ? 'complete' : 'cut off'));
    });
    // The client sees the body cut off, never a complete answer.
    expect(['aborted', 'error', 'cut off']).toContain(ended);
    expect(response.complete).toBe(false);
    expect(host.stats().ledger.demo?.streams ?? 0).toBe(0);
  }, 30_000);
});
