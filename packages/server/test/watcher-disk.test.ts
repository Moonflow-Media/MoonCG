import { mkdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { chokidarWatcher } from '../src/dev/chokidar-watcher.js';
import type { FileWatcher } from '../src/dev/watcher.js';
import { manifest, temporaryBundles } from './temp-bundles.js';

const temporary = temporaryBundles();
const open: FileWatcher[] = [];
afterEach(async () => {
  for (const watcher of open.splice(0)) await watcher.close();
  await temporary.cleanup();
});

const WAIT_MS = 8000;

/** Waits until `check` holds, asking every few milliseconds. */
async function until(check: () => boolean, what: string): Promise<void> {
  const end = Date.now() + WAIT_MS;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function watching() {
  const root = await temporary.create({
    'demo/mooncg.json': manifest('demo'),
    'demo/dashboard/control.html': 'one',
    'demo/extension/index.js': 'export default async () => {}',
    'demo/node_modules/dep/index.js': 'dep',
    'demo/.git/HEAD': 'ref',
    'demo/.cache/note.txt': 'x',
  });
  const dir = join(root, 'demo');
  const seen: string[] = [];
  const errors: unknown[] = [];
  const watcher = chokidarWatcher(
    dir,
    (path) => seen.push(path),
    (error) => errors.push(error),
  );
  open.push(watcher);
  await watcher.ready;
  return { root, dir, seen, errors, watcher };
}

describe('watching a real folder with chokidar', () => {
  it('says nothing about the files that are there when it starts', async () => {
    const { seen } = await watching();
    await pause(300);
    expect(seen).toEqual([]);
  });

  it('reports a changed, an added and a deleted file, relative with forward slashes', async () => {
    const { dir, seen, errors } = await watching();

    await writeFile(join(dir, 'dashboard', 'control.html'), 'two');
    await until(() => seen.includes('dashboard/control.html'), 'the change');

    await mkdir(join(dir, 'graphics', 'deep'), { recursive: true });
    await writeFile(join(dir, 'graphics', 'deep', 'overlay.html'), 'new');
    await until(() => seen.includes('graphics/deep/overlay.html'), 'the added file');

    seen.length = 0;
    await unlink(join(dir, 'extension', 'index.js'));
    await until(() => seen.includes('extension/index.js'), 'the deleted file');
    expect(errors).toEqual([]);
  });

  it('does not report what happens in node_modules, .git and dot folders', async () => {
    const { dir, seen } = await watching();

    await writeFile(join(dir, 'node_modules', 'dep', 'index.js'), 'changed');
    await writeFile(join(dir, '.git', 'HEAD'), 'changed');
    await writeFile(join(dir, '.cache', 'note.txt'), 'changed');
    await writeFile(join(dir, '.env'), 'SECRET=1');
    // Something that is reported, so that the test knows the watcher had its chance.
    await writeFile(join(dir, 'mooncg.json'), JSON.stringify(manifest('demo', { title: 'D' })));
    await until(() => seen.includes('mooncg.json'), 'the manifest change');
    await pause(200);

    expect(seen.filter((path) => path !== 'mooncg.json')).toEqual([]);
  });

  it('lets go of the folder when closed: it can be renamed and deleted, and nothing is reported', async () => {
    const { root, dir, seen, watcher } = await watching();

    await watcher.close();
    await rename(dir, join(root, 'moved'));
    await writeFile(join(root, 'moved', 'dashboard', 'control.html'), 'three');
    await rm(join(root, 'moved'), { recursive: true });
    await pause(200);

    expect(seen).toEqual([]);
  });

  it('can be closed twice', async () => {
    const { watcher } = await watching();
    await watcher.close();
    await expect(watcher.close()).resolves.toBeUndefined();
  });
});
