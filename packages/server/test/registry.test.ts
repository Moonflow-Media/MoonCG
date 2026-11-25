import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Json } from '@mooncg/core';
import { afterEach, describe, expect, it } from 'vitest';
import { privateNetworks } from '../src/registry/network.js';
import { indexId, MAX_INDEXES, Registry } from '../src/registry/registry.js';
import { memoryLogger } from './helpers.js';
import { type HttpFixture, json, startHttpFixture } from './http-fixture.js';

const SHA = 'a'.repeat(64);
const made: string[] = [];
const fixtures: HttpFixture[] = [];
const registries: Registry[] = [];
afterEach(async () => {
  for (const registry of registries.splice(0)) await registry.close();
  for (const fixture of fixtures.splice(0)) await fixture.close();
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function dataDir() {
  const dir = await mkdtemp(join(tmpdir(), 'mooncg-registry-'));
  made.push(dir);
  return dir;
}
async function serve(routes: Parameters<typeof startHttpFixture>[0] = {}) {
  const fixture = await startHttpFixture(routes);
  fixtures.push(fixture);
  return fixture;
}

const index = (version = '1.0.0') => ({
  index: 1,
  title: 'Test index',
  entries: [
    {
      name: 'board',
      kind: 'bundle',
      versions: [{ version, source: { type: 'zip', url: `board-${version}.zip`, sha256: SHA } }],
    },
  ],
});

function memoryStore() {
  const values = new Map<string, Json>();
  return {
    values,
    get: async (key: string) => values.get(key),
    set: async (key: string, value: Json) => {
      values.set(key, value);
    },
  };
}

async function registry(options: {
  configured?: string[];
  dir?: string;
  store?: ReturnType<typeof memoryStore>;
  refreshMs?: number;
  logger?: ReturnType<typeof memoryLogger>['logger'];
}) {
  const created = new Registry({
    dataDir: options.dir ?? (await dataDir()),
    store: options.store ?? memoryStore(),
    configured: options.configured ?? [],
    refreshMs: options.refreshMs ?? 60_000,
    timeoutMs: 2000,
    logger: options.logger ?? memoryLogger().logger,
  });
  registries.push(created);
  return created;
}

describe('Registry', () => {
  it('fetches the configured indexes at start and lists their entries', async () => {
    const server = await serve({ '/index.json': json(index()) });
    const url = `${server.url}/index.json`;
    const reg = await registry({ configured: [url] });
    await reg.start();
    await reg.refreshed();
    expect(reg.indexes()).toEqual([
      expect.objectContaining({
        id: indexId(url),
        url,
        origin: 'config',
        status: 'ok',
        title: 'Test index',
        entries: 1,
      }),
    ]);
    const [listed] = reg.entries();
    expect(listed?.entry.name).toBe('board');
    // A path next to the index is resolved against the index's address.
    expect(listed?.entry.versions[0]?.source.url).toBe(`${server.url}/board-1.0.0.zip`);
  });

  it('says what is wrong with an index and keeps using the last good copy', async () => {
    const server = await serve({ '/index.json': json(index()) });
    const url = `${server.url}/index.json`;
    const dir = await dataDir();
    const { lines, logger } = memoryLogger();
    const reg = await registry({ configured: [url], dir, logger });
    await reg.start();
    await reg.refreshed();

    server.routes.set('/index.json', json({ index: 1, entries: [{ name: 'Bad Name' }] }));
    await reg.refresh();
    const [state] = reg.indexes();
    expect(state?.status).toBe('stale');
    expect(state?.error).toMatch(/entries\.0/);
    expect(reg.entries()).toHaveLength(1);
    expect(lines.join('\n')).toMatch(/could not be used/);

    // Across a restart, with the index unreachable, the cached copy is what there is.
    await server.close();
    const again = await registry({ configured: [url], dir });
    await again.start();
    await again.refreshed();
    expect(again.indexes()[0]?.status).toBe('stale');
    expect(again.entries().map(({ entry }) => entry.name)).toEqual(['board']);
  });

  it('is an error without any copy, and the cached copy of another index is never mixed in', async () => {
    const server = await serve({ '/index.json': json({ nope: true }) });
    const reg = await registry({ configured: [`${server.url}/index.json`] });
    await reg.start();
    await reg.refreshed();
    expect(reg.indexes()[0]).toMatchObject({ status: 'error', entries: 0 });
    expect(reg.entries()).toEqual([]);
  });

  it('asks conditionally and keeps the copy when nothing changed', async () => {
    const server = await serve({ '/index.json': json(index(), { etag: '"one"' }) });
    const reg = await registry({ configured: [`${server.url}/index.json`] });
    await reg.start();
    await reg.refreshed();
    server.routes.set('/index.json', (request, response) => {
      if (request.headers['if-none-match'] === '"one"') response.writeHead(304).end();
      else response.writeHead(500).end();
    });
    await reg.refresh();
    expect(reg.indexes()[0]?.status).toBe('ok');
    expect(reg.entries()).toHaveLength(1);
  });

  it('checks again on its own, every so often', async () => {
    const server = await serve({ '/index.json': json(index()) });
    const reg = await registry({ configured: [`${server.url}/index.json`], refreshMs: 40 });
    await reg.start();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(server.requests.length).toBeGreaterThanOrEqual(3);
  });

  it('adds and removes indexes, remembers them, and leaves the configured ones alone', async () => {
    const server = await serve({ '/a.json': json(index()), '/b.json': json(index('2.0.0')) });
    const store = memoryStore();
    const configured = `${server.url}/a.json`;
    const reg = await registry({ configured: [configured], store });
    await reg.start();
    const added = await reg.add(`${server.url}/b.json`, 'ada');
    expect(added).toMatchObject({ origin: 'added', status: 'ok', entries: 1 });
    expect(store.values.get('registryIndexes')).toEqual([`${server.url}/b.json`]);

    await expect(reg.add(`${server.url}/b.json`, 'ada')).rejects.toThrow(/already/);
    await expect(reg.add('http://example.org/index.json', 'ada')).rejects.toThrow(/https/);
    await expect(reg.remove(indexId(configured), 'ada')).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(reg.remove('0123456789abcdef', 'ada')).rejects.toMatchObject({
      code: 'not_found',
    });

    const again = await registry({ store });
    await again.start();
    expect(again.indexes().map((state) => state.url)).toEqual([`${server.url}/b.json`]);
    await again.remove(added.id, 'ada');
    expect(again.indexes()).toEqual([]);
    expect(store.values.get('registryIndexes')).toEqual([]);
  });

  it('takes no more than a few indexes', async () => {
    const reg = await registry({});
    await reg.start();
    for (let i = 0; i < MAX_INDEXES; i++) {
      await reg.add(`https://127.0.0.1:1/index-${i}.json`, 'ada');
    }
    await expect(reg.add('https://127.0.0.1:1/one-more.json', 'ada')).rejects.toThrow(/at most/);
  });

  it('never tells or logs the credentials of an index address', async () => {
    const server = await serve({
      '/private.json': (request, response) => {
        if (request.headers.authorization === undefined) response.writeHead(401).end();
        else json(index())(request, response);
      },
      '/denied.json': (_request, response) => response.writeHead(403).end(),
    });
    const host = server.url.replace('http://', '');
    const { lines, logger } = memoryLogger();
    const reg = await registry({
      configured: [
        `http://reader:s3cret@${host}/private.json`,
        `http://reader:s3cret@${host}/denied.json`,
      ],
      logger,
    });
    await reg.start();
    await reg.refreshed();
    const [good, bad] = reg.indexes();
    expect(good?.status).toBe('ok');
    expect(bad?.status).toBe('error');
    const told = JSON.stringify([reg.indexes(), lines]);
    expect(told).not.toMatch(/s3cret/);
    expect(told).toMatch(/\*\*\*@/);
    // A path next to the index is resolved without them: the download asks the index for
    // them when it runs, so they are never kept with what was installed.
    expect(reg.entries()[0]?.entry.versions[0]?.source.url).toBe(`${server.url}/board-1.0.0.zip`);
    expect(reg.address(indexId(`http://reader:s3cret@${host}/private.json`))).toMatch(/s3cret/);
  });

  it('lets an index elsewhere list nothing on this machine, and one on this machine do so', async () => {
    const local = {
      ...index(),
      entries: [
        {
          name: 'board',
          kind: 'bundle',
          versions: [
            {
              version: '1.0.0',
              source: { type: 'zip', url: 'http://127.0.0.1:1/board.zip', sha256: SHA },
            },
          ],
        },
      ],
    };
    const server = await serve({ '/index.json': json(local) });
    const reg = await registry({ configured: [`${server.url}/index.json`] });
    await reg.start();
    await reg.refreshed();
    expect(reg.indexes()[0]?.status).toBe('ok');
    // The same file, cached, is read again by the same rule.
    const fake = new Registry({
      dataDir: await dataDir(),
      store: memoryStore(),
      configured: ['https://example.org/index.json'],
      logger: memoryLogger().logger,
      sources: [
        {
          schemes: ['https:'],
          load: async () => ({ status: 'ok', value: local }),
        },
      ],
    });
    registries.push(fake);
    await fake.start();
    await fake.refreshed();
    expect(fake.indexes()[0]).toMatchObject({ status: 'error' });
    expect(fake.indexes()[0]?.error).toMatch(/this machine/);
  });

  it('tells what is wrong with an index without its control or format characters, and briefly', async () => {
    const { lines, logger } = memoryLogger();
    const reg = new Registry({
      dataDir: await dataDir(),
      store: memoryStore(),
      configured: ['https://example.org/index.json'],
      logger,
      sources: [
        {
          schemes: ['https:'],
          load: async () => {
            throw new Error(`bad\u001b[2J\u202ename\u2028${'x'.repeat(2000)}`);
          },
        },
      ],
    });
    registries.push(reg);
    await reg.start();
    await reg.refreshed();
    const error = reg.indexes()[0]?.error ?? '';
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the point
    expect(error).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]/u);
    expect(error.length).toBeLessThanOrEqual(500);
    expect(error).toMatch(/^bad/);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the point
    expect(lines.join('\n')).not.toMatch(/[\u001b\u202e\u2028]/);
  });

  it('counts only the entries of the kinds asked for', async () => {
    const both = {
      index: 1,
      entries: [
        ...index().entries,
        {
          name: 'helper',
          kind: 'module',
          versions: [{ version: '1.0.0', source: { type: 'zip', url: 'h.zip', sha256: SHA } }],
        },
      ],
    };
    const server = await serve({ '/index.json': json(both) });
    const reg = await registry({ configured: [`${server.url}/index.json`] });
    await reg.start();
    await reg.refreshed();
    expect(reg.indexes()[0]?.entries).toBe(2);
    expect(reg.indexes(['bundle'])[0]?.entries).toBe(1);
    expect(reg.indexes(['module'])[0]?.entries).toBe(1);
    expect(reg.indexes([])[0]?.entries).toBe(0);
  });

  it('keeps no copy of an index that was removed while it was being fetched', async () => {
    let answer: (() => void) | undefined;
    const server = await serve({
      '/slow.json': (request, response) => {
        answer = () => json(index())(request, response);
      },
    });
    const dir = await dataDir();
    const reg = await registry({ dir });
    await reg.start();
    const adding = reg.add(`${server.url}/slow.json`, 'ada');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const id = indexId(`${server.url}/slow.json`);
    await reg.remove(id, 'ada');
    answer?.();
    await adding;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const left = await readdir(join(dir, 'registry')).catch(() => []);
    expect(left).toEqual([]);
  });

  it('writes nothing once it is closed, and waits for what runs', async () => {
    let answer: (() => void) | undefined;
    const server = await serve({
      '/slow.json': (request, response) => {
        answer = () => json(index())(request, response);
      },
    });
    const dir = await dataDir();
    const reg = await registry({ configured: [`${server.url}/slow.json`], dir });
    await reg.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const closing = reg.close();
    answer?.();
    await closing;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await readdir(join(dir, 'registry')).catch(() => [])).toEqual([]);
  });

  it('keeps nothing in the data folder but its own copies', async () => {
    const server = await serve({ '/index.json': json(index()) });
    const dir = await dataDir();
    const reg = await registry({ configured: [`${server.url}/index.json`], dir });
    await reg.start();
    await reg.refreshed();
    expect(await readdir(join(dir, 'registry'))).toEqual([
      `${indexId(`${server.url}/index.json`)}.json`,
    ]);
  });
});

describe('Registry, with private networks allowed by the configuration', () => {
  const create = async (
    allowed?: ReturnType<typeof privateNetworks>,
    configured: string[] = [],
  ) => {
    const asked: string[] = [];
    const reg = new Registry({
      dataDir: await dataDir(),
      store: memoryStore(),
      configured,
      logger: memoryLogger().logger,
      privateNetworks: allowed,
      sources: [
        {
          schemes: ['https:', 'http:'],
          load: async (url) => {
            asked.push(url);
            return { status: 'ok', value: index() };
          },
        },
      ],
    });
    registries.push(reg);
    await reg.start();
    await reg.refreshed();
    return { reg, asked };
  };
  const url = 'http://index.intranet/index.json';

  it('takes a plain http index on an allowed host only with the setting for http', async () => {
    const closed = (await create()).reg;
    await expect(closed.add(url, 'ada')).rejects.toMatchObject({ code: 'invalid' });
    const httpsOnly = (await create(privateNetworks(['index.intranet'], false))).reg;
    await expect(httpsOnly.add(url, 'ada')).rejects.toMatchObject({ code: 'invalid' });
    const { reg, asked } = await create(privateNetworks(['index.intranet'], true));
    expect(await reg.add(url, 'ada')).toMatchObject({ status: 'ok', entries: 1 });
    expect(asked).toEqual([url]);
  });

  it('takes a configured plain http index on an allowed host', async () => {
    const { reg } = await create(privateNetworks(['index.intranet'], true), [url]);
    expect(reg.indexes()).toEqual([expect.objectContaining({ url, status: 'ok' })]);
    const { reg: closed } = await create(undefined, [url]);
    expect(closed.indexes()).toEqual([]);
  });
});
