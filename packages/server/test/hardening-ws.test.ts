import { connect as connectTcp } from 'node:net';
import { encodeMessage, PROTOCOL_VERSION, type ServerMessage } from '@mooncg/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { InlineHost } from '../src/extension-host/inline-host.js';
import { MAX_FRAME_BYTES, upgradeRefusal } from '../src/http/ws.js';
import { type RunningServer, type ServerOptions, startServer } from '../src/server.js';
import { memoryStorage } from '../src/storage/replicant-store.js';
import { fixture, memoryLogger } from './helpers.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function start(
  options: Partial<ServerOptions> = {},
  allowedOrigins: string[] = [],
): Promise<RunningServer & { lines: string[] }> {
  const { logger, lines } = memoryLogger();
  const server = await startServer(
    {
      port: 0,
      host: '127.0.0.1',
      bundlesDir: fixture('bundles'),
      allowedOrigins,
      dataDir: fixture('unused-data'),
      extensionMemoryMb: 128,
      extensionStartTimeoutMs: 10_000,
      extensionHeartbeatTimeoutMs: 10_000,
      maxBodyBytes: 1024 * 1024,
    },
    {
      logger,
      sdkFile: undefined,
      storage: memoryStorage(),
      createHost: (services) => new InlineHost(services),
      ...options,
    },
  );
  cleanup.push(() => server.close());
  await server.started;
  return Object.assign(server, { lines });
}

/** Opens a socket and reports how the upgrade went: `open`, or the refusal's status code. */
function upgrade(server: RunningServer, origin?: string): Promise<'open' | number> {
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, origin ? { origin } : {});
  cleanup.push(() => socket.terminate());
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve('open'));
    socket.once('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0));
    socket.once('error', reject);
  });
}

async function handshake(server: RunningServer) {
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  cleanup.push(() => socket.terminate());
  const received: ServerMessage[] = [];
  socket.on('message', (data) => received.push(JSON.parse(data.toString())));
  await new Promise((resolve, reject) => socket.once('open', resolve).once('error', reject));
  socket.send(encodeMessage({ t: 'hello', v: PROTOCOL_VERSION, bundle: 'good' }));
  await vi.waitFor(() => expect(received).toHaveLength(1));
  received.length = 0;
  return { socket, received };
}

/** Sends a raw HTTP upgrade request with the given request target and returns the response. */
function rawUpgrade(server: RunningServer, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connectTcp(server.port, '127.0.0.1');
    let response = '';
    socket.setTimeout(3000, () => {
      socket.destroy();
      reject(new Error(`No answer to the upgrade request, got: ${JSON.stringify(response)}`));
    });
    socket.on('data', (chunk) => {
      response += chunk.toString();
    });
    socket.on('end', () => resolve(response));
    socket.on('error', reject);
    socket.write(
      `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nConnection: Upgrade\r\n` +
        'Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
    );
  });
}

describe('upgradeRefusal', () => {
  const host = '127.0.0.1:9090';
  const request = (url: string | undefined, origin?: string) => ({
    url,
    headers: origin === undefined ? { host } : { host, origin },
  });

  it.each([
    ['the socket path', '/ws', undefined],
    ['the socket path with a query', '/ws?token=x', undefined],
    ['a page of this server', '/ws', 'http://127.0.0.1:9090'],
    ['a host header in another case', '/ws', 'http://127.0.0.1:9090'.toUpperCase()],
    ['an allowed extra origin', '/ws', 'http://localhost:5173'],
  ])('accepts %s', (_label, url, origin) => {
    expect(upgradeRefusal(request(url, origin), ['http://localhost:5173'])).toBeUndefined();
  });

  it.each([
    ['an unparsable request target', '//', undefined, '400 Bad Request'],
    ['a missing request target', undefined, undefined, '400 Bad Request'],
    ['another path', '/other', undefined, '404 Not Found'],
    ['a foreign origin', '/ws', 'http://evil.example', '403 Forbidden'],
    ['this host on another port', '/ws', 'http://127.0.0.1:5173', '403 Forbidden'],
    ['the opaque origin', '/ws', 'null', '403 Forbidden'],
  ])('refuses %s', (_label, url, origin, status) => {
    expect(upgradeRefusal(request(url, origin), [])).toBe(status);
  });
});

describe('WebSocket hardening', () => {
  it('answers a request target of "//" with 400 and keeps serving', async () => {
    const server = await start();

    const response = await rawUpgrade(server, '//');

    expect(response).toMatch(/^HTTP\/1\.1 400 /);
    expect(await upgrade(server)).toBe('open');
  });

  it('refuses a foreign Origin and accepts same-origin, absent and allowed ones', async () => {
    const server = await start({}, ['http://localhost:5173']);

    expect(await upgrade(server, 'http://evil.example')).toBe(403);
    expect(await upgrade(server, `http://127.0.0.1:${server.port}`)).toBe('open');
    expect(await upgrade(server, 'http://localhost:5173')).toBe('open');
    expect(await upgrade(server)).toBe('open');
  });

  it('answers a 100,000-level deep value with bad_request and stays up', async () => {
    const server = await start();
    const { socket, received } = await handshake(server);
    const deep = `${'['.repeat(100_000)}0${']'.repeat(100_000)}`;

    socket.send(
      `{"t":"rep.op","id":1,"name":"score","patches":[{"op":"replace","path":"","value":${deep}}]}`,
    );
    socket.send(encodeMessage({ t: 'rep.sub', id: 2, name: 'score' }));

    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(received).toMatchObject([
      { t: 'err', id: 1, code: 'bad_request' },
      { t: 'rep.snap', id: 2, rev: 0, value: { home: 0, away: 0 } },
    ]);
  });

  it('closes a socket that sends a frame over the size limit, and stays up', async () => {
    const server = await start();
    const { socket } = await handshake(server);
    const closed = new Promise<number>((resolve) => socket.once('close', resolve));
    socket.on('error', () => {});

    socket.send(JSON.stringify({ t: 'rep.sub', id: 1, name: 'x'.repeat(MAX_FRAME_BYTES) }));

    expect(MAX_FRAME_BYTES).toBe(1024 * 1024);
    expect(await closed).toBe(1009);
    expect((await fetch(`${server.url}/api/v1/bundles`)).status).toBe(200);
  });

  it('refuses subscriptions to the replicants of a failed bundle', async () => {
    const server = await start();
    const { socket, received } = await handshake(server);

    socket.send(encodeMessage({ t: 'rep.sub', id: 1, name: 'crashy:state' }));

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received).toMatchObject([{ t: 'err', id: 1, code: 'not_found' }]);
  });
});
