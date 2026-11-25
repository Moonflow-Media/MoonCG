import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReplicantRegistry } from '@mooncg/core';
import { afterEach, describe, expect, it } from 'vitest';
import { AssetStore } from '../src/assets/store.js';
import { BundleConfigs } from '../src/config/bundle-config.js';
import {
  MemoryReplicantStore,
  openSqliteStore,
  type ReplicantStore,
} from '../src/storage/replicant-store.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
async function dataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mooncg-purge-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

const stores: [string, () => Promise<ReplicantStore>][] = [
  ['memory', async () => new MemoryReplicantStore()],
  [
    'SQLite',
    async () => {
      const store = await openSqliteStore(await dataDir());
      cleanup.push(() => store.close());
      return store;
    },
  ],
];

describe.each(stores)('removeBundle of the %s store', (_name, open) => {
  it('deletes every record of the bundle and none of another', async () => {
    const store = await open();
    await store.save([
      { bundle: 'board', name: 'score', rev: 3, value: { home: 1 } },
      { bundle: 'board', name: 'clock', rev: 1, value: 90 },
      { bundle: 'board-two', name: 'score', rev: 2, value: 'kept' },
      { bundle: 'boar', name: 'score', rev: 2, value: 'kept too' },
    ]);

    await store.removeBundle('board');

    expect(await store.load('board', 'score')).toBeUndefined();
    expect(await store.load('board', 'clock')).toBeUndefined();
    expect(await store.load('board-two', 'score')).toMatchObject({ value: 'kept' });
    expect(await store.load('boar', 'score')).toMatchObject({ value: 'kept too' });
    // Nothing to delete is fine.
    await store.removeBundle('never-there');
  });
});

describe('BundleConfigs.remove', () => {
  it('deletes the stored configuration of the bundle only', async () => {
    const dir = await dataDir();
    await mkdir(join(dir, 'config'));
    await writeFile(join(dir, 'config', 'board.json'), '{"league":"First"}');
    await writeFile(join(dir, 'config', 'other.json'), '{"kept":true}');
    const configs = new BundleConfigs({ dataDir: dir });

    await configs.remove('board');
    await configs.remove('never-there');

    expect(existsSync(join(dir, 'config', 'board.json'))).toBe(false);
    expect(await readFile(join(dir, 'config', 'other.json'), 'utf8')).toBe('{"kept":true}');
  });
});

describe('AssetStore.purge', () => {
  async function setup() {
    const dir = await dataDir();
    for (const folder of ['board/logos', 'board/sounds', 'other/logos']) {
      await mkdir(join(dir, 'assets', folder), { recursive: true });
      await writeFile(join(dir, 'assets', folder, 'file.bin'), 'x');
    }
    await writeFile(join(dir, 'mooncg.db'), 'not an asset');
    const assets = new AssetStore({
      dataDir: dir,
      registry: new ReplicantRegistry(),
      maxFileBytes: 1000,
      quotaBytes: 10_000,
    });
    return { dir, assets };
  }

  it('deletes every uploaded file of the bundle and none of another', async () => {
    const { dir, assets } = await setup();
    await assets.purge('board');
    await assets.purge('never-there');
    expect(existsSync(join(dir, 'assets', 'board'))).toBe(false);
    expect(existsSync(join(dir, 'assets', 'other', 'logos', 'file.bin'))).toBe(true);
  });

  it.each(['..', '../..', '.', '', 'other/logos', '.incoming', 'Board'])(
    'deletes nothing for "%s", which is no bundle name',
    async (name) => {
      const { dir, assets } = await setup();
      await assets.purge(name);
      expect(existsSync(join(dir, 'mooncg.db'))).toBe(true);
      expect(existsSync(join(dir, 'assets', 'board', 'logos', 'file.bin'))).toBe(true);
      expect(existsSync(join(dir, 'assets', 'other', 'logos', 'file.bin'))).toBe(true);
    },
  );
});
