import { createServer } from 'node:net';
import {
  ANONYMOUS_PRINCIPAL,
  encodeMessage,
  PROTOCOL_VERSION,
  type ServerMessage,
} from '@mooncg/core';
import { createClient } from '@mooncg/sdk/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { InlineHost } from '../src/extension-host/inline-host.js';
import { resolveLocalAdmin } from '../src/http/identity.js';
import { type RunningServer, type ServerOptions, startServer } from '../src/server.js';
import { memoryStorage } from '../src/storage/replicant-store.js';
import { fixture, memoryLogger, testConfig } from './helpers.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function start(options: Partial<ServerOptions> = {}): Promise<RunningServer> {
  const server = await startServer(testConfig({ bundlesDir: fixture('bundles') }), {
    logger: memoryLogger().logger,
    sdkFile: fixture('sdk/mooncg.js'),
    resolvePrincipal: resolveLocalAdmin,
    storage: memoryStorage(),
    createHost: (services) => new InlineHost(services),
    ...options,
  });
  cleanup.push(() => server.close());
  await server.started;
  return server;
}

function connect(server: RunningServer, bundle = 'good') {
  const client = createClient({ bundle, url: `ws://127.0.0.1:${server.port}/ws` });
  cleanup.push(() => client.close());
  return client;
}

/** A bare socket that has completed the handshake, for sending hand-made protocol messages. */
async function rawSocket(server: RunningServer) {
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  cleanup.push(() => socket.terminate());
  const received: ServerMessage[] = [];
  socket.on('message', (data) => received.push(JSON.parse(data.toString())));
  await new Promise((resolve, reject) => socket.once('open', resolve).once('error', reject));
  socket.send(encodeMessage({ t: 'hello', v: PROTOCOL_VERSION, bundle: 'good' }));
  await vi.waitFor(() => expect(received).toEqual([{ t: 'welcome', v: PROTOCOL_VERSION }]));
  return { socket, received };
}

interface Score {
  home: number;
  away: number;
}

describe('startServer', () => {
  it('serves HTTP on an ephemeral port and survives failed bundles', async () => {
    const server = await start();

    const response = await fetch(`${server.url}/api/v1/bundles`);
    const { bundles } = (await response.json()) as { bundles: { name: string; state: string }[] };

    expect(server.port).toBeGreaterThan(0);
    expect(bundles.map((bundle) => [bundle.name, bundle.state])).toEqual([
      ['broken', 'failed'],
      ['crashy', 'failed'],
      ['good', 'running'],
      ['no-manifest', 'failed'],
      ['wrong-name', 'failed'],
    ]);
  });

  it('syncs a replicant between two SDK clients over real sockets', async () => {
    const server = await start();
    const watcher = connect(server).replicant<Score>('score');
    const writer = connect(server).replicant<Score>('score');
    const seen: Score[] = [];
    watcher.subscribe((value) => seen.push(value));
    await Promise.all([watcher.ready, writer.ready]);

    await writer.update((draft) => {
      draft.home++;
    });
    await writer.set({ home: 7, away: 3 });

    await vi.waitFor(() =>
      expect(seen).toEqual([
        { home: 0, away: 0 },
        { home: 1, away: 0 },
        { home: 7, away: 3 },
      ]),
    );
    expect(writer.value).toEqual({ home: 7, away: 3 });
  });

  it('lets clients see what an extension wrote through the same replicant API', async () => {
    const server = await start();
    const greeting = connect(server).replicant<string>('greeting');
    await greeting.ready;
    expect(greeting.value).toBe('hello from the extension');
  });

  it('rejects an op based on a stale revision with conflict', async () => {
    const server = await start();
    const { socket, received } = await rawSocket(server);
    const patches = [{ op: 'replace', path: '/home', value: 1 }] as const;
    received.length = 0;

    socket.send(encodeMessage({ t: 'rep.op', id: 1, name: 'score', baseRev: 0, patches }));
    socket.send(encodeMessage({ t: 'rep.op', id: 2, name: 'score', baseRev: 0, patches }));

    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(received).toMatchObject([
      { t: 'ack', id: 1, rev: 1 },
      { t: 'err', id: 2, code: 'conflict' },
    ]);
  });

  it('answers garbage on the socket with bad_request and keeps the connection', async () => {
    const server = await start();
    const { socket, received } = await rawSocket(server);
    received.length = 0;

    socket.send('{nonsense');
    socket.send(encodeMessage({ t: 'rep.sub', id: 1, name: 'made-up' }));

    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(received).toMatchObject([
      { t: 'err', code: 'bad_request' },
      { t: 'err', id: 1, code: 'not_found' },
    ]);
  });

  it('refuses the socket upgrade of someone who is not signed in', async () => {
    const server = await start({ resolvePrincipal: () => ANONYMOUS_PRINCIPAL });
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    cleanup.push(() => socket.terminate());

    const status = await new Promise((resolve, reject) => {
      socket.once('unexpected-response', (_request, response) => resolve(response.statusCode));
      socket.once('open', () => reject(new Error('The upgrade should have been refused')));
      socket.once('error', reject);
    });

    expect(status).toBe(401);
  });

  it('shuts down although a client has not read the file it asked for', async () => {
    const server = await start();
    const unread = await fetch(`${server.url}/b/good/dashboard/control.html`);
    expect(unread.status).toBe(200);

    const closed = await Promise.race([
      server.close().then(() => 'closed'),
      new Promise((resolve) => setTimeout(() => resolve('still open'), 3000)),
    ]);

    expect(closed).toBe('closed');
    await unread.body?.cancel().catch(() => {});
  }, 10_000);

  it('stops listening and drops open sockets on close', async () => {
    const server = await start();
    const { socket } = await rawSocket(server);
    const closed = new Promise((resolve) => socket.once('close', resolve));

    await server.close();
    await closed;

    await expect(fetch(`${server.url}/api/v1/bundles`)).rejects.toThrow();
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject).listen(server.port, '127.0.0.1', resolve);
    });
    await new Promise((resolve) => probe.close(resolve));
  });
});
