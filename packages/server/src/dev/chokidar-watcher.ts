import { relative, sep } from 'node:path';
import { isIgnoredPath } from '@mooncg/core';
import { watch as chokidarWatch } from 'chokidar';
import type { CreateFileWatcher } from './watcher.js';

// A module of its own, loaded only when watching is turned on: a server that runs a show
// with the watcher off never loads chokidar at all.

/** Watches with chokidar. `node_modules`, `.git` and dot folders are not even looked into. */
export const chokidarWatcher: CreateFileWatcher = (dir, onChange, onError) => {
  const watcher = chokidarWatch(dir, {
    cwd: dir,
    // What is there when the watch starts is no change.
    ignoreInitial: true,
    // A link that points out of the bundle is not followed out of it.
    followSymlinks: false,
    ignored: (path) => {
      const inside = relative(dir, path);
      // The folder itself, and whatever chokidar asks about above it, is never ignored.
      return inside !== '' && !inside.startsWith('..') && isIgnoredPath(inside);
    },
  });
  watcher.on('all', (event, path) => {
    if (event === 'add' || event === 'change' || event === 'unlink') {
      onChange(path.split(sep).join('/'));
    }
  });
  watcher.on('error', onError);
  const ready = new Promise<void>((resolve) => watcher.once('ready', () => resolve()));
  return { ready, close: () => watcher.close() };
};
