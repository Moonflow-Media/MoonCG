import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BundleSources,
  publicSource,
  refetchable,
  type SourceRecord,
} from '../src/install/sources.js';

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function dataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mooncg-sources-'));
  made.push(dir);
  return dir;
}

const record = (source: SourceRecord['source'], version = '1.0.0'): SourceRecord => ({
  source,
  version,
  installedAt: '2026-11-24T10:00:00.000Z',
  by: 'ada',
});
const git = {
  type: 'git',
  url: 'https://example.org/o/r.git',
  ref: 'main',
  commit: 'abc',
} as const;

describe('BundleSources', () => {
  it('remembers where each bundle came from, across restarts', async () => {
    const dir = await dataDir();
    const sources = new BundleSources({ dataDir: dir });
    expect(await sources.get('board')).toBeUndefined();

    await sources.set('board', record(git));
    await sources.set('ticker', record({ type: 'upload', filename: 'ticker.zip' }, '0.2.0'));

    const again = new BundleSources({ dataDir: dir });
    expect(await again.get('board')).toEqual(record(git));
    expect(Object.keys(await again.all()).sort()).toEqual(['board', 'ticker']);
    expect(await readdir(dir)).toEqual(['bundle-sources.json']);
  });

  it('replaces and forgets', async () => {
    const sources = new BundleSources({ dataDir: await dataDir() });
    await sources.set('board', record(git));
    await sources.set('board', record({ type: 'path', path: '/srv/board' }, '2.0.0'));
    expect((await sources.get('board'))?.version).toBe('2.0.0');
    await sources.delete('board');
    await sources.delete('never-there');
    expect(await sources.get('board')).toBeUndefined();
    expect(await sources.all()).toEqual({});
  });

  it('keeps every change when several are made at once', async () => {
    const dir = await dataDir();
    const sources = new BundleSources({ dataDir: dir });
    await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((name) => sources.set(name, record(git, `1.0.${name.length}`))),
    );
    expect(
      Object.keys(JSON.parse(await readFile(join(dir, 'bundle-sources.json'), 'utf8'))),
    ).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('starts empty over a file that cannot be read, and says so', async () => {
    const dir = await dataDir();
    await writeFile(join(dir, 'bundle-sources.json'), '{ broken');
    const warnings: string[] = [];
    const sources = new BundleSources({ dataDir: dir, warn: (message) => warnings.push(message) });
    expect(await sources.all()).toEqual({});
    expect(warnings).toHaveLength(1);
    await sources.set('board', record(git));
    expect(await new BundleSources({ dataDir: dir }).get('board')).toEqual(record(git));
  });

  // Windows knows no such modes: there the access list of the data folder protects the file.
  it.skipIf(process.platform === 'win32')(
    'writes the file only its owner can read, as a Git address in it may hold credentials',
    async () => {
      const dir = await dataDir();
      // A file beside it that a crash left behind, readable by everyone.
      await writeFile(join(dir, 'module-sources.json.tmp'), '{}', { mode: 0o644 });
      for (const file of ['bundle-sources.json', 'module-sources.json']) {
        const sources = new BundleSources({ dataDir: dir, file });
        await sources.set('board', record(git));
        expect((await stat(join(dir, file))).mode & 0o777).toBe(0o600);
      }
    },
  );

  it('is not fooled by a name that every object has', async () => {
    const sources = new BundleSources({ dataDir: await dataDir() });
    expect(await sources.get('constructor')).toBeUndefined();
    expect(await sources.get('__proto__')).toBeUndefined();
  });
});

describe('publicSource', () => {
  it('shows a Git address without the credentials in it', () => {
    expect(
      publicSource({
        type: 'git',
        url: 'https://bob:hunter2@example.org/o/r.git',
        ref: 'v1',
        commit: 'abc',
      }),
    ).toEqual({
      type: 'git',
      location: 'https://***@example.org/o/r.git',
      ref: 'v1',
      commit: 'abc',
    });
  });

  it('shows the path of a folder or an archive, and the name of an upload', () => {
    expect(publicSource({ type: 'path', path: '/srv/board' })).toEqual({
      type: 'path',
      location: '/srv/board',
    });
    expect(publicSource({ type: 'zip', path: '/srv/board.zip' }).location).toBe('/srv/board.zip');
    expect(publicSource({ type: 'upload', filename: 'board.zip' }).location).toBe('board.zip');
    expect(publicSource({ type: 'upload' }).location).toBe('uploaded archive');
  });
});

describe('refetchable', () => {
  it('is what can be fetched again, with the ref but not the commit', () => {
    expect(refetchable(git)).toEqual({ type: 'git', url: git.url, ref: 'main' });
    expect(refetchable({ type: 'git', url: git.url, commit: 'abc' })).toEqual({
      type: 'git',
      url: git.url,
    });
    expect(refetchable({ type: 'path', path: '/srv/board' })).toEqual({
      type: 'path',
      path: '/srv/board',
    });
    expect(refetchable({ type: 'zip', path: '/srv/board.zip' })).toEqual({
      type: 'zip',
      path: '/srv/board.zip',
    });
  });

  it('is nothing for an upload or for a bundle of unknown origin', () => {
    expect(refetchable({ type: 'upload', filename: 'board.zip' })).toBeUndefined();
    expect(refetchable(undefined)).toBeUndefined();
  });
});
