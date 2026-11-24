import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeMessage, PROTOCOL_VERSION, type ServerMessage } from '@mooncg/core';
import { createClient } from '@mooncg/sdk/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { InlineHost } from '../src/extension-host/inline-host.js';
import { resolveLocalAdmin } from '../src/http/identity.js';
import { type RunningServer, startServer } from '../src/server.js';
import { fixture, memoryLogger, testConfig } from './helpers.js';
import { manifest, temporaryBundles } from './temp-bundles.js';

const temporary = temporaryBundles();
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  await temporary.cleanup();
});

const scoreSchema = {
  type: 'object',
  properties: { home: { type: 'integer', minimum: 0 } },
  required: ['home'],
  additionalProperties: false,
};

async function gameBundles(): Promise<string> {
  return temporary.create({
    'game/mooncg.json': manifest('game', {
      replicants: {
        score: { schema: 'schemas/score.json', default: { home: 0 }, persistent: true },
        volatile: { default: { home: 0 } },
        big: { default: { home: 0, pad: 'x'.repeat(20_000) } },
      },
    }),
    'game/schemas/score.json': scoreSchema,
  });
}

/** Starts a server that stores its data in a real SQLite file under `dataDir`. */
async function start(bundlesDir: string, dataDir: string) {
  const { logger, lines } = memoryLogger();
  const server = await startServer(testConfig({ bundlesDir, dataDir }), {
    logger,
    sdkFile: undefined,
    resolvePrincipal: resolveLocalAdmin,
    createHost: (services) => new InlineHost(services),
  });
  let closed = false;
  const close = async () => {
    if (!closed) await server.close();
    closed = true;
  };
  cleanup.push(close);
  await server.started;
  return { server, lines, close };
}

async function dataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mooncg-data-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function connect(server: RunningServer, bundle = 'game') {
  const client = createClient({ bundle, url: `ws://127.0.0.1:${server.port}/ws` });
  cleanup.push(() => client.close());
  return client;
}

async function rawSocket(server: RunningServer) {
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  cleanup.push(() => socket.terminate());
  const received: ServerMessage[] = [];
  socket.on('message', (data) => received.push(JSON.parse(data.toString())));
  await new Promise((resolve, reject) => socket.once('open', resolve).once('error', reject));
  socket.send(encodeMessage({ t: 'hello', v: PROTOCOL_VERSION, bundle: 'game' }));
  await vi.waitFor(() => expect(received).toHaveLength(1));
  received.length = 0;
  return { socket, received };
}

interface Score {
  home: number;
}

describe('persistence across restarts', () => {
  it('brings a persistent replicant back, and resets the others', async () => {
    const bundles = await gameBundles();
    const data = await dataDir();
    const first = await start(bundles, data);
    const client = connect(first.server);
    await client.replicant<Score>('score').set({ home: 4 });
    await client.replicant<Score>('score').update((draft) => {
      draft.home++;
    });
    await client.replicant<Score>('volatile').set({ home: 9 });
    client.close();
    await first.close();

    const second = await start(bundles, data);
    const score = connect(second.server).replicant<Score>('score');
    const volatile = connect(second.server).replicant<Score>('volatile');
    await Promise.all([score.ready, volatile.ready]);

    expect(score.value).toEqual({ home: 5 });
    expect(volatile.value).toEqual({ home: 0 });
    expect(second.lines.filter((line) => line.startsWith('WARN'))).toEqual([]);
  });

  it('gives a client that reconnects after a restart a snapshot, even at the same revision', async () => {
    const bundles = await gameBundles();
    const first = await start(bundles, await dataDir());
    const before = await rawSocket(first.server);
    before.socket.send(encodeMessage({ t: 'rep.sub', id: 1, name: 'volatile' }));
    await vi.waitFor(() => expect(before.received).toHaveLength(1));
    const snapshot = before.received[0] as Extract<ServerMessage, { t: 'rep.snap' }>;
    await first.close();

    const second = await start(bundles, await dataDir());
    const after = await rawSocket(second.server);
    after.socket.send(
      encodeMessage({
        t: 'rep.sub',
        id: 2,
        name: 'volatile',
        since: { epoch: snapshot.epoch, rev: snapshot.rev },
      }),
    );
    await vi.waitFor(() => expect(after.received).toHaveLength(1));

    expect(after.received[0]).toMatchObject({ t: 'rep.snap', id: 2, rev: 0 });
    expect((after.received[0] as typeof snapshot).epoch).not.toBe(snapshot.epoch);
  });
});

describe('schema validation over the wire', () => {
  it('rejects a write that violates the schema with invalid and changes nothing', async () => {
    const { server } = await start(await gameBundles(), await dataDir());
    const score = connect(server).replicant<Score>('score');
    const watcher = connect(server).replicant<Score>('score');
    await Promise.all([score.ready, watcher.ready]);

    const write = score.set({ home: -3 });

    await expect(write).rejects.toMatchObject({ code: 'invalid', message: '/home: must be >= 0' });
    await expect(
      score.update((draft) => {
        (draft as { extra?: number }).extra = 1;
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(watcher.value).toEqual({ home: 0 });
  });
});

describe('replay over the wire', () => {
  it('sends the missed patches for a small gap and a snapshot for a large one', async () => {
    const { server } = await start(await gameBundles(), await dataDir());
    const writer = connect(server).replicant<Score>('big');
    await writer.ready;
    const { socket, received } = await rawSocket(server);
    socket.send(encodeMessage({ t: 'rep.sub', id: 1, name: 'big' }));
    await vi.waitFor(() => expect(received).toHaveLength(1));
    const { epoch } = received[0] as Extract<ServerMessage, { t: 'rep.snap' }>;
    for (let home = 1; home <= 3; home++)
      await writer.update((draft) => {
        draft.home = home;
      });
    await vi.waitFor(() => expect(received).toHaveLength(4));
    received.length = 0;

    socket.send(encodeMessage({ t: 'rep.sub', id: 2, name: 'big', since: { epoch, rev: 1 } }));
    await vi.waitFor(() => expect(received).toHaveLength(3));
    expect(received).toMatchObject([
      { t: 'rep.patch', rev: 2 },
      { t: 'rep.patch', rev: 3 },
      { t: 'ack', id: 2, rev: 3 },
    ]);

    for (let home = 4; home <= 110; home++)
      await writer.update((draft) => {
        draft.home = home;
      });
    await vi.waitFor(() => expect(received).toHaveLength(3 + 107));
    received.length = 0;
    socket.send(encodeMessage({ t: 'rep.sub', id: 3, name: 'big', since: { epoch, rev: 3 } }));
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toMatchObject({ t: 'rep.snap', id: 3, rev: 110 });
  });
});

describe('hello for a bundle that is not running', () => {
  it.each([['nope'], ['crashy'], ['broken']])('refuses "%s" with not_found', async (bundle) => {
    const { server } = await start(fixture('bundles'), await dataDir());
    const client = connect(server, bundle);
    await expect(client.ready).rejects.toMatchObject({ code: 'not_found' });
  });
});
