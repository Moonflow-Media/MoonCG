import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_INSTALL_LIMITS } from '../src/install/files.js';
import { copyLocalPath } from '../src/install/local.js';

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A source bundle, a bundles folder and a data folder, each beside the others. */
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'mooncg-local-'));
  made.push(root);
  const source = join(root, 'source');
  const bundlesDir = join(root, 'bundles');
  const dataDir = join(root, 'data');
  for (const dir of [join(source, 'dashboard'), bundlesDir, dataDir]) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(join(source, 'mooncg.json'), '{}');
  await writeFile(join(source, 'dashboard', 'panel.html'), 'panel');
  await writeFile(join(root, 'secret.txt'), 'secret');
  const dest = join(dataDir, 'staging', 'abc', 'bundle');
  const copy = (from = source, limits = DEFAULT_INSTALL_LIMITS) =>
    copyLocalPath(from, dest, { forbidden: [bundlesDir, dataDir], limits });
  return { root, source, bundlesDir, dataDir, dest, copy };
}

/** Links `path` to `target`, or says that this machine does not allow making links. */
async function link(target: string, path: string, type: 'file' | 'junction'): Promise<boolean> {
  return symlink(target, path, type).then(
    () => true,
    () => false,
  );
}

describe('copyLocalPath', () => {
  it('copies the folder with everything in it', async () => {
    const { copy, dest } = await setup();
    expect(await copy()).toEqual({ files: 2, bytes: 7 });
    expect(await readFile(join(dest, 'dashboard', 'panel.html'), 'utf8')).toBe('panel');
    expect((await readdir(dest)).sort()).toEqual(['dashboard', 'mooncg.json']);
  });

  it('leaves the history of a repository behind', async () => {
    const { copy, dest, source } = await setup();
    await mkdir(join(source, '.git', 'objects'), { recursive: true });
    await writeFile(join(source, '.git', 'HEAD'), 'ref: refs/heads/main');
    await copy();
    expect((await readdir(dest)).sort()).toEqual(['dashboard', 'mooncg.json']);
  });

  it('refuses a path that is not absolute, not there, or no folder', async () => {
    const { copy, source, dest } = await setup();
    await expect(copy('relative/bundle')).rejects.toThrow(/absolute path/);
    await expect(copy(join(source, 'nope'))).rejects.toThrow(/no folder/);
    await expect(copy(join(source, 'mooncg.json'))).rejects.toThrow(/no folder/);
    await expect(copy('relative/bundle')).rejects.toMatchObject({ code: 'invalid' });
    expect(existsSync(dest)).toBe(false);
  });

  it('refuses a folder inside the bundles folder or the data folder', async () => {
    const { copy, bundlesDir, dataDir, dest } = await setup();
    await mkdir(join(bundlesDir, 'installed'));
    await mkdir(join(dataDir, 'backups', 'x'), { recursive: true });
    for (const inside of [
      bundlesDir,
      join(bundlesDir, 'installed'),
      dataDir,
      join(dataDir, 'backups', 'x'),
    ]) {
      await expect(copy(inside)).rejects.toThrow(/inside the bundles folder or the data folder/);
    }
    expect(existsSync(dest)).toBe(false);
  });

  it('refuses a folder that contains the bundles folder or the data folder', async () => {
    const { copy, root, dest } = await setup();
    await expect(copy(root)).rejects.toThrow(/contains the bundles folder or the data folder/);
    expect(existsSync(dest)).toBe(false);
  });

  it('refuses a link that stands for a folder of the server', async (context) => {
    const { copy, root, bundlesDir } = await setup();
    await mkdir(join(bundlesDir, 'installed'));
    if (!(await link(join(bundlesDir, 'installed'), join(root, 'alias'), 'junction'))) {
      return context.skip();
    }
    await expect(copy(join(root, 'alias'))).rejects.toThrow(/inside the bundles folder/);
  });

  it('refuses a link that leads out of the source, and copies nothing', async (context) => {
    const { copy, root, source, dest } = await setup();
    await mkdir(join(root, 'outside'));
    await writeFile(join(root, 'outside', 'private.txt'), 'private');
    if (!(await link(join(root, 'outside'), join(source, 'dashboard', 'out'), 'junction'))) {
      return context.skip();
    }
    await expect(copy()).rejects.toThrow(/"dashboard\/out" links to a place outside/);
    expect(existsSync(dest)).toBe(false);
  });

  it('refuses a file link that leads out of the source', async (context) => {
    const { copy, root, source, dest } = await setup();
    if (!(await link(join(root, 'secret.txt'), join(source, 'leak.txt'), 'file'))) {
      return context.skip();
    }
    await expect(copy()).rejects.toThrow(/"leak.txt" links to a place outside/);
    expect(existsSync(dest)).toBe(false);
  });

  it('copies what a link inside the source points to', async (context) => {
    const { copy, source, dest } = await setup();
    await mkdir(join(source, 'shared'));
    await writeFile(join(source, 'shared', 'util.js'), 'util');
    if (!(await link(join(source, 'shared'), join(source, 'dashboard', 'shared'), 'junction'))) {
      return context.skip();
    }
    await copy();
    expect(await readFile(join(dest, 'dashboard', 'shared', 'util.js'), 'utf8')).toBe('util');
  });

  it('refuses a link to a folder it is in', async (context) => {
    const { copy, source, dest } = await setup();
    if (!(await link(source, join(source, 'dashboard', 'loop'), 'junction'))) {
      return context.skip();
    }
    await expect(copy()).rejects.toThrow(/"dashboard\/loop" links to a folder it is in/);
    expect(existsSync(dest)).toBe(false);
  });

  it('keeps to the limits and leaves nothing of a folder that is too large', async () => {
    const { copy, source, dest } = await setup();
    await writeFile(join(source, 'big.bin'), Buffer.alloc(5000));
    await expect(
      copy(source, { ...DEFAULT_INSTALL_LIMITS, maxUnpackedBytes: 1000 }),
    ).rejects.toThrow(/larger than 1000 bytes/);
    expect(existsSync(dest)).toBe(false);
    await expect(copy(source, { ...DEFAULT_INSTALL_LIMITS, maxFiles: 2 })).rejects.toThrow(
      /more than 2 files/,
    );
    expect(existsSync(dest)).toBe(false);
  });
});
