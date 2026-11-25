import { type ChangeArea, type Manifest, MoonCGError, parseManifest } from '@mooncg/core';
import { describe, expect, it } from 'vitest';
import type { BundleRecord } from '../src/bundles/bundles.js';
import { BundleWatchers, type CreateFileWatcher, WATCH_DEBOUNCE_MS } from '../src/dev/watcher.js';
import { memoryLogger } from './helpers.js';
import { manifest } from './temp-bundles.js';

const parsed = (input: object): Manifest => {
  const result = parseManifest(input);
  if (!result.ok) throw new Error(`The test manifest is invalid: ${JSON.stringify(result.errors)}`);
  return result.manifest;
};

function fakeTimers() {
  let now = 0;
  let tasks: { at: number; run: () => void }[] = [];
  return {
    timers: {
      setTimeout(run: () => void, ms: number) {
        const task = { at: now + ms, run };
        tasks.push(task);
        return task;
      },
      clearTimeout(handle: unknown) {
        tasks = tasks.filter((task) => task !== handle);
      },
    },
    advance(ms: number) {
      now += ms;
      const due = tasks.filter((task) => task.at <= now);
      tasks = tasks.filter((task) => task.at > now);
      for (const task of due) task.run();
    },
    pending: () => tasks.length,
  };
}

interface SetupOptions {
  dev?: boolean;
  manifests?: Record<string, object>;
  states?: Record<string, BundleRecord['state']>;
}

function setup(options: SetupOptions = {}) {
  const clock = fakeTimers();
  const { logger, lines } = memoryLogger();
  const calls: string[] = [];
  const watched = new Map<
    string,
    { change(path: string): void; fail(error: unknown): void; closed: boolean }
  >();
  const createWatcher: CreateFileWatcher = (dir, onChange, onError) => {
    const handle = { change: onChange, fail: onError, closed: false };
    watched.set(dir, handle);
    return {
      close: async () => {
        handle.closed = true;
        calls.push(`close-watcher ${dir}`);
      },
    };
  };
  const manifests: Record<string, object> = {
    board: manifest('board', {
      extension: 'extension/index.js',
      replicants: { score: { schema: 'schemas/score.json', default: {} } },
      config: { schema: 'config.schema.json' },
    }),
    vite: manifest('vite', { dev: { url: 'http://localhost:5173' } }),
    ...options.manifests,
  };
  const states: Record<string, BundleRecord['state']> = { ...options.states };
  const pending = new Map<string, readonly ChangeArea[]>();
  let onAir = false;
  let failWith: Error | undefined;
  const step = async (label: string) => {
    calls.push(label);
    await Promise.resolve();
    if (failWith) throw failWith;
    calls.push(`${label} done`);
  };
  const record = (name: string): BundleRecord | undefined =>
    manifests[name] === undefined
      ? undefined
      : {
          name,
          dir: `/bundles/${name}`,
          manifest: parsed(manifests[name]),
          errors: [],
          state: states[name] ?? 'running',
        };
  const watchers = new BundleWatchers({
    manager: {
      get: record,
      reloadIfValid: async (name) => {
        await step(`reload ${name}`);
        return record(name) as BundleRecord;
      },
      restartExtension: async (name) => {
        await step(`restart ${name}`);
        return record(name) as BundleRecord;
      },
      enable: async (name) => {
        await step(`enable ${name}`);
        return record(name) as BundleRecord;
      },
      notePending: (name, areas) => {
        if (areas.length === 0) pending.delete(name);
        else pending.set(name, areas);
      },
    },
    pages: {
      reload: (bundle, kind) => {
        calls.push(`pages ${kind} ${bundle}`);
        return 1;
      },
      restyle: (bundle, kind, styles) => {
        const files = styles.map(({ file, permission }) =>
          permission === `bundle:${bundle}:?` ? file : `${file}(${permission})`,
        );
        calls.push(`styles ${kind} ${bundle} ${files.join(' ')}`);
        return 1;
      },
    },
    instances: {
      markOutOfDate: (bundle) => {
        calls.push(`out-of-date ${bundle}`);
        return 2;
      },
    },
    logger,
    dev: options.dev ?? true,
    isOnAir: () => onAir,
    createWatcher,
    timers: clock.timers,
  });
  for (const name of Object.keys(manifests)) watchers.open(name, `/bundles/${name}`);
  const change = (bundle: string, ...paths: string[]) => {
    for (const path of paths) watched.get(`/bundles/${bundle}`)?.change(path);
  };
  /** Lets the debounce pass and waits for what it started. */
  const settle = async () => {
    clock.advance(WATCH_DEBOUNCE_MS);
    await watchers.idle();
  };
  return {
    watchers,
    watched,
    calls,
    lines,
    clock,
    change,
    settle,
    pending,
    setOnAir: (value: boolean) => {
      onAir = value;
    },
    failNext: (error: Error | undefined) => {
      failWith = error;
    },
  };
}

describe('BundleWatchers', () => {
  it('debounces for 150 ms', () => {
    expect(WATCH_DEBOUNCE_MS).toBe(150);
  });

  it('watches each bundle folder once', () => {
    const { watchers, watched } = setup();
    const first = watched.get('/bundles/board');
    watchers.open('board', '/bundles/board');
    expect(watched.get('/bundles/board')).toBe(first);
    expect([...watched.keys()]).toEqual(['/bundles/board', '/bundles/vite']);
  });

  it('acts once, after the changes have been quiet for the debounce time', async () => {
    const { change, clock, calls, watchers } = setup();
    change('board', 'dashboard/a.html');
    clock.advance(100);
    change('board', 'dashboard/b.html');
    clock.advance(100);
    await watchers.idle();
    expect(calls).toEqual([]);

    clock.advance(50);
    await watchers.idle();

    expect(calls).toEqual(['pages panels board']);
  });

  it('reloads the panels of the bundle for a dashboard file', async () => {
    const { change, settle, calls, lines } = setup();
    change('board', 'dashboard/control.html');
    await settle();
    expect(calls).toEqual(['pages panels board']);
    expect(lines.join('\n')).toContain('dashboard/control.html');
  });

  it('reloads the graphics of the bundle in dev mode', async () => {
    const { change, settle, calls } = setup({ dev: true });
    change('board', 'graphics/overlay.html');
    await settle();
    expect(calls).toEqual(['pages graphics board']);
  });

  it('swaps the stylesheets of panels when only CSS changed', async () => {
    const { change, settle, calls, lines } = setup({ dev: false });
    change('board', 'dashboard/control.css', 'dashboard\\theme.css');
    await settle();
    expect(calls).toEqual(['styles panels board dashboard/control.css dashboard/theme.css']);
    expect(lines.join('\n')).toContain('stylesheets');
  });

  it('names the permission a stylesheet that is a page entry of the manifest takes', async () => {
    const { change, settle, calls } = setup({
      dev: false,
      manifests: {
        styled: manifest('styled', {
          panels: [{ id: 'raw', title: 'Raw', file: 'dashboard/raw.css', requires: 'admin' }],
          permissions: { admin: 'Admin' },
        }),
      },
    });
    change('styled', 'dashboard/raw.css', 'dashboard/theme.css');
    await settle();
    expect(calls).toEqual([
      'styles panels styled dashboard/raw.css(bundle:styled:admin) dashboard/theme.css',
    ]);
  });

  it('swaps the stylesheets of graphics when only CSS changed, in dev mode', async () => {
    const { change, settle, calls } = setup({ dev: true });
    change('board', 'graphics/overlay.css');
    await settle();
    expect(calls).toEqual(['styles graphics board graphics/overlay.css']);
  });

  it('marks graphics out of date for CSS outside dev mode', async () => {
    const { change, settle, calls } = setup({ dev: false });
    change('board', 'graphics/overlay.css');
    await settle();
    expect(calls).toEqual(['out-of-date board']);
  });

  it('only marks graphics as out of date outside dev mode', async () => {
    const { change, settle, calls } = setup({ dev: false });
    change('board', 'graphics/overlay.html');
    await settle();
    expect(calls).toEqual(['out-of-date board']);
  });

  it('restarts the extension for extension and shared code', async () => {
    const { change, settle, calls } = setup();
    change('board', 'extension/index.js', 'shared/util.js');
    await settle();
    expect(calls).toEqual(['restart board', 'restart board done']);
  });

  it('gives a failed bundle another try when its extension changes', async () => {
    const { change, settle, calls } = setup({ states: { board: 'failed' } });
    change('board', 'extension/index.js');
    await settle();
    expect(calls).toEqual(['enable board', 'enable board done']);
  });

  it('reloads the bundle for its manifest, and the pages only once that is done', async () => {
    const { change, settle, calls } = setup();
    change('board', 'mooncg.json', 'dashboard/control.html', 'extension/index.js');
    await settle();
    expect(calls).toEqual(['reload board', 'reload board done', 'pages panels board']);
  });

  it('reloads the bundle for a schema, also one the manifest names outside schemas/', async () => {
    const { change, settle, calls } = setup();
    change('board', 'schemas/score.json');
    await settle();
    change('board', 'config.schema.json');
    await settle();
    expect(calls.filter((call) => call === 'reload board')).toHaveLength(2);
  });

  it('does nothing for files that concern nothing', async () => {
    const { change, settle, calls, clock } = setup();
    change('board', 'README.md', 'node_modules/x/index.js', '.git/HEAD', 'dashboard/.tmp/a');
    expect(clock.pending()).toBe(0);
    await settle();
    expect(calls).toEqual([]);
  });

  it('reads the separators Windows reports', async () => {
    const { change, settle, calls } = setup();
    change('board', 'dashboard\\control.html');
    await settle();
    expect(calls).toEqual(['pages panels board']);
  });

  it('leaves the pages of a bundle with a development server alone, in dev mode', async () => {
    const { change, settle, calls } = setup({ dev: true });
    change('vite', 'dashboard/a.html', 'graphics/b.html');
    await settle();
    expect(calls).toEqual([]);
  });

  it('does not honour a development server outside dev mode', async () => {
    const { change, settle, calls } = setup({ dev: false });
    change('vite', 'dashboard/a.html', 'graphics/b.html');
    await settle();
    expect(calls).toEqual(['pages panels vite', 'out-of-date vite']);
  });

  it('keeps the bundles apart', async () => {
    const { change, settle, calls } = setup({ manifests: { other: manifest('other') } });
    change('board', 'dashboard/a.html');
    change('other', 'graphics/a.html');
    await settle();
    expect(calls.sort()).toEqual(['pages graphics other', 'pages panels board']);
  });

  it('logs a failed reload and stays in service', async () => {
    const { change, settle, calls, lines, failNext } = setup();
    failNext(new MoonCGError('conflict', 'Bundle "board" is updating'));
    change('board', 'extension/index.js');
    await settle();
    expect(lines.join('\n')).toContain('Bundle "board" is updating');

    failNext(undefined);
    calls.length = 0;
    change('board', 'extension/index.js');
    await settle();
    expect(calls).toEqual(['restart board', 'restart board done']);
  });

  it('logs an error of the watcher itself', () => {
    const { watched, lines } = setup();
    watched.get('/bundles/board')?.fail(new Error('EPERM'));
    expect(lines.join('\n')).toContain('EPERM');
  });

  describe('on air', () => {
    it('records the changes as pending and does nothing', async () => {
      const { change, settle, calls, pending, setOnAir, lines } = setup();
      setOnAir(true);
      change('board', 'extension/index.js', 'dashboard/a.html');
      await settle();
      change('board', 'graphics/a.html', 'README.md');
      await settle();

      expect(calls).toEqual([]);
      expect([...(pending.get('board') ?? [])].sort()).toEqual([
        'dashboard',
        'extension',
        'graphics',
      ]);
      expect(lines.join('\n')).toContain('on air');
    });

    it('carries the pending changes out once the lock is released', async () => {
      const { change, settle, calls, pending, setOnAir, watchers } = setup();
      setOnAir(true);
      change('board', 'extension/index.js', 'dashboard/a.html');
      await settle();
      setOnAir(false);

      await watchers.flushPending();

      expect(calls).toEqual(['restart board', 'restart board done', 'pages panels board']);
      expect(pending.has('board')).toBe(false);
      calls.length = 0;
      await watchers.flushPending();
      expect(calls).toEqual([]);
    });

    it('records a change as pending when the lock closed while it was on its way', async () => {
      const { change, settle, calls, pending, setOnAir, failNext } = setup();
      change('board', 'extension/index.js');
      failNext(new MoonCGError('conflict', 'MoonCG is on air'));
      setOnAir(false);
      const settled = settle();
      setOnAir(true);
      await settled;

      expect(calls).toEqual(['restart board']);
      expect(pending.get('board')).toEqual(['extension']);
    });
  });

  describe('letting go of a folder', () => {
    it('closes the watcher and forgets what was buffered', async () => {
      const { change, settle, calls, watchers, watched } = setup();
      change('board', 'dashboard/a.html');

      await watchers.close('board');
      await settle();

      expect(watched.get('/bundles/board')?.closed).toBe(true);
      expect(calls).toEqual(['close-watcher /bundles/board']);
    });

    it('is fine with a bundle that is not watched', async () => {
      const { watchers } = setup();
      await expect(watchers.close('nope')).resolves.toBeUndefined();
    });

    it('watches the folder again when it is opened again', async () => {
      const { change, settle, calls, watchers } = setup();
      await watchers.close('board');
      calls.length = 0;
      watchers.open('board', '/bundles/board');
      change('board', 'dashboard/a.html');
      await settle();
      expect(calls).toEqual(['pages panels board']);
    });

    it('forgets the changes that waited for the lock', async () => {
      const { change, settle, calls, watchers, setOnAir } = setup();
      setOnAir(true);
      change('board', 'extension/index.js');
      await settle();
      await watchers.close('board');
      watchers.open('board', '/bundles/board');
      setOnAir(false);
      calls.length = 0;

      await watchers.flushPending();

      expect(calls).toEqual([]);
    });
  });

  describe('disposal', () => {
    it('closes every watcher, drops the timers and opens nothing afterwards', async () => {
      const { change, watchers, watched, clock, calls } = setup();
      change('board', 'dashboard/a.html');

      await watchers.dispose();
      watchers.open('late', '/bundles/late');
      clock.advance(WATCH_DEBOUNCE_MS);
      await watchers.idle();

      expect([...watched.values()].every((handle) => handle.closed)).toBe(true);
      expect(watched.has('/bundles/late')).toBe(false);
      expect(clock.pending()).toBe(0);
      expect(calls.filter((call) => !call.startsWith('close-watcher'))).toEqual([]);
      expect(watchers.watching()).toEqual([]);
    });
  });
});
