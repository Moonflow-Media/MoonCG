import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import {
  type InstallLimits,
  isInside,
  isNetworkPath,
  realNearest,
  refuse,
  removeDir,
  type TreeSize,
  treeCounter,
} from './files.js';

export interface CopyOptions {
  /** Folders the source may neither be in nor contain: the bundles and the data folder. */
  readonly forbidden: readonly string[];
  readonly limits: Pick<InstallLimits, 'maxFiles' | 'maxUnpackedBytes'>;
}

/** The history of a repository is no part of a bundle. */
const SKIPPED_AT_TOP = new Set(['.git']);

/**
 * Copies a folder of this machine into `dest`, which must not exist yet. The folder may not
 * be one of the server's own, nor contain one: installing from the bundles folder into the
 * bundles folder helps nobody. A link is followed only while it stays inside the folder;
 * one that leads out of it is refused, so that naming a folder never copies what lies
 * elsewhere. Whatever is refused leaves no `dest` behind.
 */
export async function copyLocalPath(
  source: string,
  dest: string,
  options: CopyOptions,
): Promise<TreeSize> {
  if (isNetworkPath(source)) {
    throw refuse(
      'A network path is not accepted as the source of a bundle; copy it to a local disk',
    );
  }
  if (!isAbsolute(source)) throw refuse('The path of the bundle must be an absolute path');
  const isFolder = await stat(source).then(
    (stats) => stats.isDirectory(),
    () => false,
  );
  if (!isFolder) throw refuse('There is no folder at the path of the bundle');
  const root = await realpath(source);
  for (const folder of await Promise.all(options.forbidden.map(realNearest))) {
    if (isInside(folder, root)) {
      throw refuse('The path is inside the bundles folder or the data folder of the server');
    }
    if (isInside(root, folder)) {
      throw refuse('The path contains the bundles folder or the data folder of the server');
    }
  }

  const counter = treeCounter(options.limits);
  /** Copies the content of `from`, whose real location is `realFrom`, into `to`. */
  const copy = async (from: string, realFrom: string, to: string): Promise<void> => {
    await mkdir(to, { recursive: true });
    for (const name of await readdir(from)) {
      if (from === root && SKIPPED_AT_TOP.has(name)) continue;
      const path = join(from, name);
      const shown = relative(root, path).split(sep).join('/');
      let stats = await lstat(path);
      let target = join(realFrom, name);
      if (stats.isSymbolicLink()) {
        target = await realpath(path).catch(() => '');
        if (target === '' || !isInside(root, target)) {
          throw refuse(`"${shown}" links to a place outside the folder; it is not copied`);
        }
        if (isInside(target, realFrom)) {
          throw refuse(`"${shown}" links to a folder it is in`);
        }
        stats = await stat(target);
      }
      if (stats.isDirectory()) {
        counter.entry(false);
        await copy(target, target, join(to, name));
      } else if (stats.isFile()) {
        counter.entry(true);
        counter.add(stats.size);
        await copyFile(target, join(to, name), constants.COPYFILE_EXCL);
      } else {
        throw refuse(`"${shown}" is neither a file nor a folder`);
      }
    }
  };
  try {
    await copy(root, root, dest);
  } catch (error) {
    await removeDir(dest);
    throw error;
  }
  return counter.size();
}
