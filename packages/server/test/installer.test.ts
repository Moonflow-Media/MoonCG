import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { MessageBus, ReplicantRegistry } from '@mooncg/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BundleManager } from '../src/bundles/manager.js';
import type { ExtensionHost } from '../src/extension-host/extension-host.js';
import { DEFAULT_INSTALL_LIMITS } from '../src/install/files.js';
import {
  BundleInstaller,
  INSTALLS_REPLICANT,
  type InstallerOptions,
  type InstallJob,
  JOBS_KEPT,
  STAGING_TTL_MS,
  type StagedBundle,
} from '../src/install/installer.js';
import type { NpmRequest } from '../src/install/npm.js';
import { memoryStorage } from '../src/storage/replicant-store.js';
import { memoryLogger } from './helpers.js';
import { manifest } from './temp-bundles.js';
import { makeZip, zipOf } from './zip-writer.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

const hasGit = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
const withExtension = (name: string, version: string, extra: object = {}) =>
  manifest(name, { version, extension: 'extension/index.js', ...extra });
type Files = Readonly<Record<string, string | object>>;
const text = (content: string | object) =>
  typeof content === 'string' ? content : JSON.stringify(content);

/** The files of a version of the bundle `board`. */
const board = (version: string, extra: object = {}): Files => ({
  'mooncg.json': withExtension('board', version, {
    title: 'Board',
    permissions: { view: 'See the board', operate: 'Change the score' },
    capabilities: ['http.routes'],
    panels: [{ id: 'score', title: 'Score', file: 'dashboard/score.html', requires: 'operate' }],
    graphics: [{ id: 'overlay', file: 'graphics/overlay.html', width: 1920, height: 1080 }],
    ...extra,
  }),
  'extension/index.js': 'export default () => {}',
  'dashboard/score.html': `<p>score ${version}</p>`,
  'graphics/overlay.html': '<p>overlay</p>',
});

async function setup(
  options: Partial<InstallerOptions> = {},
  installed: Record<string, Files> = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'mooncg-installer-'));
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const bundlesDir = join(root, 'bundles');
  const dataDir = join(root, 'data');
  const write = async (base: string, files: Files) => {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(base, path)), { recursive: true });
      await writeFile(join(base, path), text(content));
    }
    return base;
  };
  await mkdir(bundlesDir);
  await mkdir(dataDir);
  for (const [name, files] of Object.entries(installed)) await write(join(bundlesDir, name), files);

  const calls: string[] = [];
  const failing = new Set<string>();
  const host: ExtensionHost = {
    async start(spec) {
      calls.push(`start ${spec.bundle}@${spec.version}`);
      if (failing.has(`${spec.bundle}@${spec.version}`)) throw new Error('boom');
    },
    async stop(bundle) {
      calls.push(`stop ${bundle}`);
    },
    onCrash() {},
    stats: () => ({ running: 0, ledger: {}, threads: { started: 0, exited: 0, live: 0 } }),
    close: async () => {},
  };
  const registry = new ReplicantRegistry();
  const { logger, lines } = memoryLogger();
  const storage = memoryStorage();
  const manager = new BundleManager({
    bundlesDir,
    registry,
    bus: new MessageBus({ timers: { setTimeout, clearTimeout } }),
    host,
    logger,
    settings: storage.bundles,
  });
  await manager.start();
  calls.length = 0;

  const npm: (NpmRequest & { readonly inBundles: boolean })[] = [];
  const purged: string[] = [];
  let changes = 0;
  const installer = new BundleInstaller({
    dataDir,
    bundlesDir,
    manager,
    registry,
    logger,
    mooncgVersion: '0.6.0',
    npmInstall: async (request) => {
      npm.push({ ...request, inBundles: request.dir.startsWith(bundlesDir) });
      request.log('added 1 package');
      await mkdir(join(request.dir, 'node_modules', 'left-pad'), { recursive: true });
    },
    purge: async (bundle) => void purged.push(bundle),
    afterChange: () => void changes++,
    ...options,
  });
  cleanup.push(() => installer.close());
  await installer.start();

  /** A folder outside the server's own, with the files of a bundle. */
  const folder = (files: Files, name = `source-${Math.random().toString(36).slice(2)}`) =>
    write(join(root, 'sources', name), files);
  const archive = async (
    content: Buffer,
    name = `a-${Math.random().toString(36).slice(2)}.zip`,
  ) => {
    await mkdir(join(root, 'sources'), { recursive: true });
    await writeFile(join(root, 'sources', name), content);
    return join(root, 'sources', name);
  };
  /** Stages a folder with `files` and waits for the job to end. */
  const stage = async (files: Files, target?: string, scripts?: boolean) => {
    const job = await installer.stage({
      source: { type: 'path', path: await folder(files) },
      target,
      scripts,
      by: 'ada',
    });
    return installer.settled(job.id);
  };
  /** Stages and commits `files`, and waits for the end of it. */
  const install = async (files: Files, target?: string, scripts?: boolean) => {
    const staged = await stage(files, target);
    if (staged.staged === undefined) throw new Error(`Not staged: ${staged.error}`);
    return installer.settled(installer.commit(staged.staged.id, { by: 'ada', scripts }).id);
  };
  const states = () => Object.fromEntries(manager.list().map(({ name, state }) => [name, state]));
  const published = () =>
    registry.get(`system:${INSTALLS_REPLICANT}`)?.replicant.value as
      | { jobs: InstallJob[]; staged: StagedBundle[] }
      | undefined;
  const stagingDirs = () => readdir(join(dataDir, 'staging')).catch(() => [] as string[]);
  const read = (path: string) => readFile(join(root, path), 'utf8');
  return {
    root,
    bundlesDir,
    dataDir,
    installer,
    manager,
    registry,
    lines,
    calls,
    failing,
    npm,
    purged,
    changes: () => changes,
    write,
    folder,
    archive,
    stage,
    install,
    states,
    published,
    stagingDirs,
    read,
  };
}

describe('defaults', () => {
  it('keeps a staged bundle for half an hour and the last twenty jobs', () => {
    expect(STAGING_TTL_MS).toBe(30 * 60_000);
    expect(JOBS_KEPT).toBe(20);
  });
});

describe('stage', () => {
  it('fetches a folder into staging and says what the bundle declares, installing nothing', async () => {
    const { installer, folder, bundlesDir, dataDir, states, stagingDirs, calls } = await setup();
    const path = await folder({
      ...board('1.2.0', { dependencies: {}, engine: { mooncg: '>=0.6.0' } }),
      'package.json': { dependencies: { 'left-pad': '^1.3.0' } },
      'package-lock.json': {},
    });

    const started = await installer.stage({ source: { type: 'path', path }, by: 'ada' });
    expect(started).toMatchObject({ operation: 'stage', by: 'ada' });
    const job = await installer.settled(started.id);

    expect(job).toMatchObject({ state: 'succeeded', bundle: 'board' });
    expect(job.error).toBeUndefined();
    const staged = job.staged as StagedBundle;
    expect(staged).toMatchObject({
      name: 'board',
      version: '1.2.0',
      title: 'Board',
      source: { type: 'path', location: path },
      engine: '>=0.6.0',
      permissions: [
        { name: 'view', description: 'See the board' },
        { name: 'operate', description: 'Change the score' },
      ],
      capabilities: ['http.routes'],
      dependencies: {},
      extension: true,
      panels: 1,
      dialogs: 0,
      graphics: 1,
      assets: 0,
      config: false,
      npm: { needed: true, lockfile: true, dependencies: ['left-pad'], installed: false },
      files: 6,
      by: 'ada',
    });
    expect(staged.target).toBeUndefined();
    expect(staged.id).toMatch(/^[0-9a-f]{24}$/);
    expect(staged.bytes).toBeGreaterThan(100);
    expect(Date.parse(staged.expiresAt) - Date.parse(staged.stagedAt)).toBe(STAGING_TTL_MS);
    expect(installer.staged()).toEqual([staged]);
    // Nothing is installed, nothing was started: the bundle sits in staging.
    expect(await readdir(bundlesDir)).toEqual([]);
    expect(states()).toEqual({});
    expect(calls).toEqual([]);
    expect(await stagingDirs()).toEqual([staged.id]);
    expect(existsSync(join(dataDir, 'staging', staged.id, 'bundle', 'mooncg.json'))).toBe(true);
  });

  it('unpacks an archive from a path, also one with everything in one folder', async () => {
    const { installer, archive } = await setup();
    const files = Object.fromEntries(
      Object.entries(board('2.0.0')).map(([path, content]) => [`board-2.0.0/${path}`, content]),
    );
    const path = await archive(zipOf(files));
    const job = await installer.settled(
      (await installer.stage({ source: { type: 'zip', path }, by: 'ada' })).id,
    );
    expect(job).toMatchObject({ state: 'succeeded' });
    expect(job.staged).toMatchObject({
      name: 'board',
      version: '2.0.0',
      files: 4,
      source: { type: 'zip', location: path },
    });
  });

  it('refuses a file given as a folder, and says how to give an archive', async () => {
    const { installer, archive, stagingDirs } = await setup();
    const path = await archive(zipOf(board('2.0.0')));
    const job = await installer.settled(
      (await installer.stage({ source: { type: 'path', path }, by: 'ada' })).id,
    );
    expect(job.state).toBe('failed');
    expect(job.error).toMatch(/is a file.*"type": "zip"/);
    expect(await stagingDirs()).toEqual([]);
  });

  it('takes an uploaded archive', async () => {
    const { installer } = await setup();
    const zip = zipOf(board('3.1.0'));
    const started = await installer.stage({
      source: { type: 'upload', body: Readable.from([zip]), length: zip.length, filename: 'b.zip' },
      by: 'ada',
    });
    const job = await installer.settled(started.id);
    expect(job.staged).toMatchObject({
      version: '3.1.0',
      source: { type: 'upload', location: 'b.zip' },
    });
  });

  it('refuses an upload that is larger than allowed, by what it says and by what arrives', async () => {
    const { installer, stagingDirs } = await setup({
      limits: { ...DEFAULT_INSTALL_LIMITS, maxArchiveBytes: 1000 },
    });
    const big = Buffer.alloc(5000, 1);
    const declared = installer.stage({
      source: { type: 'upload', body: Readable.from([big]), length: big.length },
      by: 'ada',
    });
    await expect(declared).rejects.toMatchObject({ code: 'invalid' });
    await expect(declared).rejects.toThrow(/larger than 1000 bytes/);
    // A body that says nothing, or lies, is counted as it comes.
    const undeclared = installer.stage({
      source: { type: 'upload', body: Readable.from([big.subarray(0, 2500), big.subarray(2500)]) },
      by: 'ada',
    });
    await expect(undeclared).rejects.toThrow(/larger than 1000 bytes/);
    const lying = installer.stage({
      source: { type: 'upload', body: Readable.from([big]), length: 10 },
      by: 'ada',
    });
    await expect(lying).rejects.toThrow(/larger than 1000 bytes/);
    expect(await stagingDirs()).toEqual([]);
    expect(installer.jobs()).toEqual([]);
  });

  it('refuses a request that names no usable source, before anything is fetched', async () => {
    const { installer, stagingDirs } = await setup();
    const sources = [
      { type: 'git', url: '--upload-pack=touch pwned' },
      { type: 'git', url: 'file:///srv/repo.git' },
      { type: 'git', url: 'https://example.org/r.git', ref: '--x' },
      { type: 'path', path: 'relative/path' },
      { type: 'path' },
      { type: 'zip', path: 'relative.zip' },
      { type: 'ftp', url: 'ftp://example.org' },
      {},
    ];
    for (const source of sources) {
      const staged = installer.stage({ source: source as never, by: 'ada' });
      await expect(staged).rejects.toMatchObject({ code: 'invalid' });
    }
    expect(installer.jobs()).toEqual([]);
    expect(await stagingDirs()).toEqual([]);
  });

  it.each([
    ['no manifest', { 'readme.txt': 'hello' }, /mooncg.json not found/],
    ['a manifest that is no JSON', { 'mooncg.json': '{ nope' }, /not valid JSON/],
    ['a name no bundle can have', { 'mooncg.json': manifest('Bad Name!') }, /name: /],
    ['the name of the server', { 'mooncg.json': manifest('system') }, /reserved/],
    ['a module', { 'mooncg.json': { ...manifest('mod'), kind: 'module' } }, /Expected a bundle/],
    [
      'an extension outside the bundle',
      { 'mooncg.json': manifest('x', { extension: '../../evil.js' }) },
      /extension: /,
    ],
    [
      'a newer MoonCG than this',
      { 'mooncg.json': manifest('x', { engine: { mooncg: '>=9.0.0' } }) },
      /engine.mooncg: needs MoonCG >=9.0.0, but this is 0.6.0/,
    ],
    [
      'a bundle that is not installed',
      { 'mooncg.json': manifest('x', { dependencies: { 'team-data': '^2.0.0' } }) },
      /dependencies.team-data: bundle "team-data" is not installed/,
    ],
    ['a package.json that is none', { ...board('1.0.0'), 'package.json': '[1]' }, /package.json/],
  ])('fails for a bundle with %s, and keeps nothing of it', async (_what, files, reason) => {
    const { stage, stagingDirs, installer, bundlesDir } = await setup();
    const job = await stage(files);
    expect(job.state).toBe('failed');
    expect(job.error).toMatch(reason);
    expect(job.staged).toBeUndefined();
    expect(installer.staged()).toEqual([]);
    expect(await stagingDirs()).toEqual([]);
    expect(await readdir(bundlesDir)).toEqual([]);
  });

  it('fails for an archive that tries to write outside its folder, and writes nothing', async () => {
    const { installer, archive, root, stagingDirs } = await setup();
    const path = await archive(
      makeZip([
        { name: 'mooncg.json', data: text(manifest('evil')) },
        { name: '../../../evil.txt', data: 'evil' },
      ]),
    );
    const job = await installer.settled(
      (await installer.stage({ source: { type: 'zip', path }, by: 'ada' })).id,
    );
    expect(job.state).toBe('failed');
    expect(job.error).toMatch(/Entry "\.\.\/\.\.\/\.\.\/evil\.txt"/);
    expect(await stagingDirs()).toEqual([]);
    for (const dir of [root, dirname(root), join(root, 'data'), join(root, 'data', 'staging')]) {
      expect(existsSync(join(dir, 'evil.txt'))).toBe(false);
    }
  });

  it('fails for a folder of the server itself', async () => {
    const { installer, bundlesDir } = await setup({}, { board: board('1.0.0') });
    const job = await installer.settled(
      (
        await installer.stage({
          source: { type: 'path', path: join(bundlesDir, 'board') },
          by: 'ada',
        })
      ).id,
    );
    expect(job).toMatchObject({ state: 'failed' });
    expect(job.error).toMatch(/inside the bundles folder or the data folder/);
  });

  it('refuses to stage a bundle that is installed, unless it is meant as its update', async () => {
    const { stage } = await setup({}, { board: board('1.0.0') });
    const plain = await stage(board('1.1.0'));
    expect(plain.state).toBe('failed');
    expect(plain.error).toBe(
      'Bundle "board" is already installed (version 1.0.0); update it instead',
    );

    const update = await stage(board('1.1.0'), 'board');
    expect(update.state).toBe('succeeded');
    expect(update.staged).toMatchObject({ target: 'board', replaces: '1.0.0', version: '1.1.0' });
  });

  it('refuses an update with a bundle of another name, or of a bundle that is not there', async () => {
    const { stage, installer, folder } = await setup({}, { board: board('1.0.0') });
    const other = await stage({ 'mooncg.json': manifest('ticker') }, 'board');
    expect(other.state).toBe('failed');
    expect(other.error).toBe('name: this is bundle "ticker", not "board"');

    const missing = installer.stage({
      source: { type: 'path', path: await folder(board('1.0.0')) },
      target: 'nope',
      by: 'ada',
    });
    await expect(missing).rejects.toMatchObject({ code: 'not_found' });
    for (const target of ['../board', 'Board', '']) {
      const bad = installer.stage({ source: { type: 'path', path: '/x' }, target, by: 'ada' });
      await expect(bad).rejects.toMatchObject({ code: 'not_found' });
    }
  });

  it('publishes jobs and staged bundles to those who manage bundles', async () => {
    const { stage, registry, published } = await setup();
    const entry = registry.get(`system:${INSTALLS_REPLICANT}`);
    expect(entry?.replicant.value).toEqual({ jobs: [], staged: [] });
    expect(entry?.readPermission).toBe('system:bundles.manage');

    const done = await stage(board('1.0.0'));
    const failed = await stage({ 'readme.txt': 'x' });

    expect(published()?.jobs.map(({ id, state }) => [id, state])).toEqual([
      [failed.id, 'failed'],
      [done.id, 'succeeded'],
    ]);
    expect(published()?.staged).toEqual([done.staged]);
  });

  it('keeps the latest jobs only', async () => {
    const { stage, installer } = await setup();
    const ids: string[] = [];
    for (let index = 0; index < JOBS_KEPT + 3; index++) ids.push((await stage({ a: 'b' })).id);
    expect(installer.jobs()).toHaveLength(JOBS_KEPT);
    expect(installer.jobs()[0]?.id).toBe(ids.at(-1));
    expect(installer.job(ids[0] as string)).toBeUndefined();
  });

  it('takes no paths of the server into what it publishes about a failure', async () => {
    const { installer, root, published } = await setup();
    const job = await installer.settled(
      (
        await installer.stage({
          source: { type: 'zip', path: join(root, 'missing.zip') },
          by: 'ada',
        })
      ).id,
    );
    expect(job.state).toBe('failed');
    expect(JSON.stringify(published())).not.toContain(root.replaceAll('\\', '\\\\'));
    expect(JSON.stringify(published())).not.toContain(dirname(root).replaceAll('\\', '\\\\'));
  });
});

describe('staging folder', () => {
  it('is swept when the server starts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mooncg-installer-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const dataDir = join(root, 'data');
    await mkdir(join(dataDir, 'staging', 'stale', 'bundle'), { recursive: true });
    await writeFile(join(dataDir, 'staging', 'stale', 'bundle', 'mooncg.json'), '{}');
    // A backup that is whole, and a folder an interrupted update left: a note, no bundle.
    const whole = join(dataDir, 'backups', 'board', '1.0.0-20260101T000000000Z');
    const broken = join(dataDir, 'backups', 'board', '0.9.0-20300101T000000000Z');
    await mkdir(join(whole, 'bundle'), { recursive: true });
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, 'backup.json'), '{}');
    const registry = new ReplicantRegistry();
    const { logger } = memoryLogger();
    const host = { onCrash() {}, close: async () => {} } as unknown as ExtensionHost;
    const manager = new BundleManager({
      bundlesDir: join(root, 'bundles'),
      registry,
      host,
      logger,
    });
    const installer = new BundleInstaller({
      dataDir,
      bundlesDir: join(root, 'bundles'),
      manager,
      registry,
      logger,
      mooncgVersion: '0.6.0',
    });
    cleanup.push(() => installer.close());

    await installer.start();

    expect(await readdir(join(dataDir, 'staging')).catch(() => [])).toEqual([]);
    // Backups are not staging; what is no backup goes.
    expect(await readdir(join(dataDir, 'backups', 'board'))).toEqual(['1.0.0-20260101T000000000Z']);
  });

  it('drops a staged bundle nobody decided about in time', async () => {
    const { stage, installer, stagingDirs, lines } = await setup({ stagingTtlMs: 150 });
    const job = await stage(board('1.0.0'));
    expect(installer.staged()).toHaveLength(1);
    await vi.waitFor(async () => expect(await stagingDirs()).toEqual([]), { timeout: 5000 });
    expect(installer.staged()).toEqual([]);
    expect(() => installer.commit(job.staged?.id ?? '', { by: 'ada' })).toThrow(/no staged bundle/);
    expect(lines.join('\n')).toMatch(/expired/);
  });
});

describe('a restart', () => {
  /** The installer of the next start, on the same folders, at the time `now` says. */
  async function restart(
    context: Awaited<ReturnType<typeof setup>>,
    now = Date.now,
    options: Partial<InstallerOptions> = {},
  ) {
    await context.installer.close();
    const { logger, lines } = memoryLogger();
    const next = new BundleInstaller({
      dataDir: context.dataDir,
      bundlesDir: context.bundlesDir,
      manager: context.manager,
      registry: new ReplicantRegistry(),
      logger,
      mooncgVersion: '0.6.0',
      npmInstall: async () => {},
      now,
      ...options,
    });
    cleanup.push(() => next.close());
    await next.start();
    return { next, lines };
  }

  it('keeps a staged bundle that is still within its lifetime, and it can be installed', async () => {
    const context = await setup();
    const job = await context.stage(board('1.0.0'));
    const before = job.staged as StagedBundle;

    const { next, lines } = await restart(context);

    expect(next.staged()).toEqual([before]);
    expect(lines.join('\n')).toMatch(/kept across the restart/);
    const done = await next.settled(next.commit(before.id, { by: 'ada' }).id);
    expect(done.state).toBe('succeeded');
    expect(context.states()).toMatchObject({ board: 'running' });
  });

  it('believes nothing stored about the files: they are read and checked again', async () => {
    const context = await setup();
    const job = await context.stage(board('1.0.0'));
    const id = job.staged?.id as string;
    const files = join(context.dataDir, 'staging', id, 'bundle');
    // Changed on disk while the server was down: what is shown is what is there now.
    await writeFile(
      join(files, 'mooncg.json'),
      JSON.stringify(manifest('board', { version: '6.6.6', capabilities: ['bus.any'] })),
    );

    const { next } = await restart(context);

    expect(next.staged()).toMatchObject([{ id, version: '6.6.6', extension: false }]);
    expect(next.staged()[0]?.capabilities).toEqual(['bus.any']);
  });

  it('drops one whose files no longer pass, with the trust it was fetched with', async () => {
    const context = await setup();
    const job = await context.stage(board('1.0.0'));
    const id = job.staged?.id as string;
    const files = join(context.dataDir, 'staging', id, 'bundle');
    // It was fetched untrusted; now it would make npm fetch from elsewhere.
    await writeFile(join(files, '.npmrc'), 'registry=https://evil.example/\n');
    await writeFile(
      join(files, 'package.json'),
      JSON.stringify({ name: 'board', dependencies: { left: '1.0.0' } }),
    );

    const { next, lines } = await restart(context);

    expect(next.staged()).toEqual([]);
    expect(await context.stagingDirs()).toEqual([]);
    expect(lines.join('\n')).toMatch(/is not kept: Installing this bundle would make npm/);
  });

  it('drops one whose lifetime ran out, one without its note, and one whose note was tampered with', async () => {
    const context = await setup();
    const old = (await context.stage(board('1.0.0'))).staged as StagedBundle;
    const bare = (await context.stage(board('1.1.0', { name: 'other' }))).staged as StagedBundle;
    const forged = (await context.stage(board('1.2.0', { name: 'third' }))).staged as StagedBundle;
    await rm(join(context.dataDir, 'staging', bare.id, 'staged.json'));
    const noteOf = join(context.dataDir, 'staging', forged.id, 'staged.json');
    const note = JSON.parse(await readFile(noteOf, 'utf8'));
    await writeFile(noteOf, JSON.stringify({ ...note, id: '0123456789abcdef01234567' }));

    const later = Date.parse(old.expiresAt) + 1;
    const { next, lines } = await restart(context, () => later);

    expect(next.staged()).toEqual([]);
    expect(await context.stagingDirs()).toEqual([]);
    // One line each, with the reason.
    const log = lines.join('\n');
    expect(log).toMatch(new RegExp(`${bare.id} is not kept: it has no note`));
    expect(log).toMatch(new RegExp(`${forged.id} is not kept: its note is not valid`));
    expect(log).toMatch(new RegExp(`${old.id} is not kept: its time is up`));
  });

  it('drops one whose note says it was staged later than now, and says so', async () => {
    const context = await setup();
    const job = (await context.stage(board('1.0.0'))).staged as StagedBundle;

    const earlier = Date.now() - 60 * 60 * 1000;
    const { next, lines } = await restart(context, () => earlier);

    expect(next.staged()).toEqual([]);
    expect(lines.join('\n')).toMatch(new RegExp(`${job.id} is not kept: .*in the future`));
  });

  it('keeps one no longer than its lifetime from when it was staged, whatever its note says', async () => {
    const context = await setup();
    const job = (await context.stage(board('1.0.0'))).staged as StagedBundle;
    const noteOf = join(context.dataDir, 'staging', job.id, 'staged.json');
    const note = JSON.parse(await readFile(noteOf, 'utf8'));
    const stagedAt = Date.parse(note.stagedAt);
    await writeFile(
      noteOf,
      JSON.stringify({ ...note, expiresAt: new Date(stagedAt + 365 * 86_400_000).toISOString() }),
    );

    const { next } = await restart(context);

    expect(next.staged()[0]?.expiresAt).toBe(new Date(stagedAt + 30 * 60 * 1000).toISOString());
  });

  it('takes only the known fields of the source from the note, and refuses overlong ones', async () => {
    const context = await setup();
    const kept = (await context.stage(board('1.0.0'))).staged as StagedBundle;
    const long = (await context.stage(board('1.0.0', { name: 'other' }))).staged as StagedBundle;
    const rewrite = async (id: string, change: (source: object) => object) => {
      const noteOf = join(context.dataDir, 'staging', id, 'staged.json');
      const note = JSON.parse(await readFile(noteOf, 'utf8'));
      await writeFile(noteOf, JSON.stringify({ ...note, source: change(note.source) }));
    };
    await rewrite(kept.id, (source) => ({ ...source, injected: { deep: 'x'.repeat(1000) } }));
    await rewrite(long.id, (source) => ({ ...source, path: 'x'.repeat(100_000) }));

    const { next, lines } = await restart(context);

    expect(next.staged().map((staged) => staged.id)).toEqual([kept.id]);
    expect(lines.join('\n')).toMatch(new RegExp(`${long.id} is not kept: its note is not valid`));
    await next.settled(next.commit(kept.id, { by: 'ada' }).id);
    const sources = await readFile(join(context.dataDir, 'bundle-sources.json'), 'utf8');
    expect(sources).not.toContain('injected');
  });

  it('keeps no more staged bundles than may wait, and says which it drops', async () => {
    const context = await setup();
    for (const name of ['one', 'two', 'three']) {
      await context.stage(board('1.0.0', { name }));
    }

    const { next, lines } = await restart(context, Date.now, { maxStaged: 2 });

    expect(next.staged()).toHaveLength(2);
    expect(await context.stagingDirs()).toHaveLength(2);
    expect(lines.join('\n')).toMatch(/is not kept: as many staged bundles as may wait are kept/);
  });

  it('drops the update of a bundle that is gone', async () => {
    const context = await setup({}, { board: board('1.0.0') });
    await context.manager.start();
    const job = await context.stage(board('1.1.0'), 'board');
    expect(job.staged?.target).toBe('board');
    await context.manager.remove('board', { force: true }, async () => {
      await rm(join(context.bundlesDir, 'board'), { recursive: true });
    });

    const { next, lines } = await restart(context);

    expect(next.staged()).toEqual([]);
    expect(lines.join('\n')).toMatch(/is not kept: the bundle "board" it was to update is gone/);
  });
});

describe('shutting down', () => {
  it('ends a fetch that is under way instead of waiting for it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mooncg-fake-git-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const script = join(dir, 'slow-git.mjs');
    await writeFile(script, 'await new Promise((done) => setTimeout(done, 90_000));');
    const { installer, stagingDirs } = await setup({
      timeoutMs: 60_000,
      // A public address for every name: nothing is asked of real DNS.
      git: {
        command: [process.execPath, script],
        resolve: async () => [{ address: '93.184.215.14', family: 4 }],
      },
    });
    const job = await installer.stage({
      source: { type: 'git', url: 'https://example.org/o/r.git' },
      by: 'ada',
    });
    const started = Date.now();

    await installer.close();

    expect(Date.now() - started).toBeLessThan(10_000);
    expect(installer.job(job.id)).toMatchObject({ state: 'failed' });
    expect(await stagingDirs()).toEqual([]);
  }, 15_000);
});

describe('an upload that stalls', () => {
  it('is given up, and nothing of it is kept', async () => {
    const { installer, stagingDirs } = await setup({ uploadIdleMs: 150 });
    const body = new Readable({ read() {} });
    body.push(Buffer.from('PK'));
    const staged = installer.stage({ source: { type: 'upload', body }, by: 'ada' });
    await expect(staged).rejects.toThrow(/stalled/);
    await expect(staged).rejects.toMatchObject({ code: 'invalid' });
    expect(await stagingDirs()).toEqual([]);
    expect(installer.jobs()).toEqual([]);
  }, 15_000);
});

describe('discard', () => {
  it('deletes the staged bundle', async () => {
    const { stage, installer, stagingDirs, published } = await setup();
    const { staged } = await stage(board('1.0.0'));
    expect(await installer.discard(staged?.id ?? '', 'ada')).toBe(true);
    expect(await stagingDirs()).toEqual([]);
    expect(installer.staged()).toEqual([]);
    expect(published()?.staged).toEqual([]);
    expect(await installer.discard(staged?.id ?? '', 'ada')).toBe(false);
    expect(await installer.discard('../../etc', 'ada')).toBe(false);
  });
});

describe('commit of a new bundle', () => {
  it('moves it into the bundles folder and starts it', async () => {
    const { stage, installer, read, states, stagingDirs, calls, changes } = await setup();
    const { staged } = await stage(board('1.2.0'));

    const started = installer.commit(staged?.id ?? '', { by: 'ada' });
    expect(started).toMatchObject({ operation: 'install', bundle: 'board', by: 'ada' });
    const job = await installer.settled(started.id);

    expect(job).toMatchObject({ state: 'succeeded', bundle: 'board' });
    expect(job.error).toBeUndefined();
    expect(JSON.parse(await read('bundles/board/mooncg.json'))).toMatchObject({ version: '1.2.0' });
    expect(await read('bundles/board/dashboard/score.html')).toBe('<p>score 1.2.0</p>');
    expect(states()).toEqual({ board: 'running' });
    expect(calls).toEqual(['start board@1.2.0']);
    expect(await stagingDirs()).toEqual([]);
    expect(installer.staged()).toEqual([]);
    // Roles get what the new bundle grants them by default.
    expect(changes()).toBe(1);
    expect(await installer.sources()).toEqual({
      board: { type: 'path', location: expect.stringContaining('source-') },
    });
  });

  it('refuses an id that names nothing staged, and a second commit of the same', async () => {
    const { stage, installer } = await setup();
    for (const id of ['nope', '../x', '']) {
      expect(() => installer.commit(id, { by: 'ada' })).toThrow(/no staged bundle/);
    }
    const { staged } = await stage(board('1.0.0'));
    const first = installer.commit(staged?.id ?? '', { by: 'ada' });
    expect(() => installer.commit(staged?.id ?? '', { by: 'ada' })).toThrow(/being installed/);
    expect(await installer.settled(first.id)).toMatchObject({ state: 'succeeded' });
    expect(() => installer.commit(staged?.id ?? '', { by: 'ada' })).toThrow(/no staged bundle/);
  });

  it('installs npm dependencies in staging first, without scripts', async () => {
    const { install, npm, read, lines } = await setup();
    const job = await install({
      ...board('1.0.0'),
      'package.json': { dependencies: { 'left-pad': '^1.3.0' } },
      'package-lock.json': {},
    });
    expect(job.state).toBe('succeeded');
    expect(npm).toHaveLength(1);
    expect(npm[0]).toMatchObject({ lockfile: true, scripts: false, inBundles: false });
    expect(npm[0]?.dir).toContain('staging');
    expect(npm[0]?.timeoutMs).toBeGreaterThan(0);
    // What was installed in staging moved in with the bundle.
    expect(await read('bundles/board/package.json')).toContain('left-pad');
    expect(lines.join('\n')).toContain('added 1 package');
  });

  it('lets install scripts run only when that was asked for, and logs who asked', async () => {
    const { install, npm, lines } = await setup();
    const files = { ...board('1.0.0'), 'package.json': { dependencies: { sharp: '*' } } };
    await install(files, undefined, true);
    expect(npm[0]).toMatchObject({ lockfile: false, scripts: true });
    expect(lines.join('\n')).toMatch(/WARN .*ada.*install scripts/);
  });

  it('does not run npm for a bundle that needs none or brought its node_modules', async () => {
    const { install, npm } = await setup();
    await install(board('1.0.0'));
    await install({
      'mooncg.json': manifest('ticker'),
      'package.json': { dependencies: { zod: '^4' } },
      'node_modules/zod/index.js': '',
    });
    expect(npm).toEqual([]);
  });

  it('installs nothing when npm fails, and keeps the staged bundle for another try', async () => {
    const { stage, installer, bundlesDir, states } = await setup({
      npmInstall: async () => {
        throw new Error('npm exited with code 1: 404 Not Found');
      },
    });
    const { staged } = await stage({
      ...board('1.0.0'),
      'package.json': { dependencies: { nope: '1' } },
    });
    const job = await installer.settled(installer.commit(staged?.id ?? '', { by: 'ada' }).id);
    expect(job).toMatchObject({ state: 'failed', step: 'dependencies' });
    expect(job.error).toContain('404 Not Found');
    expect(await readdir(bundlesDir)).toEqual([]);
    expect(states()).toEqual({});
    expect(installer.staged().map(({ id }) => id)).toEqual([staged?.id]);
  });

  it('keeps a bundle that does not start, as failed, and says so', async () => {
    const { install, failing, states, manager, bundlesDir } = await setup();
    failing.add('board@1.0.0');
    const job = await install(board('1.0.0'));
    expect(job).toMatchObject({ state: 'failed', step: 'enable' });
    expect(job.error).toBe(
      'Bundle "board" was installed but does not start: Extension failed to start: boom',
    );
    expect(states()).toEqual({ board: 'failed' });
    expect(manager.get('board')?.errors).toEqual(['Extension failed to start: boom']);
    expect(await readdir(bundlesDir)).toEqual(['board']);
  });

  it('fails when something of that name appeared meanwhile', async () => {
    const { stage, installer, write, bundlesDir, manager } = await setup();
    const { staged } = await stage(board('1.0.0'));
    await write(join(bundlesDir, 'board'), board('0.9.0'));
    await manager.enable('board');
    const job = await installer.settled(installer.commit(staged?.id ?? '', { by: 'ada' }).id);
    expect(job.state).toBe('failed');
    expect(job.error).toMatch(/already installed/);
    expect(manager.get('board')?.manifest?.version).toBe('0.9.0');
  });
});

describe('commit of an update', () => {
  const installedBoard = { board: board('1.0.0') };

  it('moves the old version to the backups, puts the new one in place and starts it', async () => {
    const { install, installer, read, states, calls, dataDir, stagingDirs } = await setup(
      {},
      installedBoard,
    );
    const job = await install(board('1.1.0'), 'board');

    expect(job).toMatchObject({ state: 'succeeded', operation: 'update', bundle: 'board' });
    expect(states()).toEqual({ board: 'running' });
    expect(calls).toEqual(['stop board', 'start board@1.1.0']);
    expect(await read('bundles/board/dashboard/score.html')).toBe('<p>score 1.1.0</p>');
    const backups = await installer.backups('board');
    expect(backups).toMatchObject([{ version: '1.0.0', reason: 'update' }]);
    expect(backups[0]?.id).toMatch(/^1\.0\.0-\d{8}T\d{9}Z$/);
    const kept = join(dataDir, 'backups', 'board', backups[0]?.id ?? '', 'bundle');
    expect(await readFile(join(kept, 'dashboard', 'score.html'), 'utf8')).toBe(
      '<p>score 1.0.0</p>',
    );
    expect(await stagingDirs()).toEqual([]);
  });

  it('rolls back to the old version when the new one does not start', async () => {
    const { install, installer, failing, read, states, calls, stagingDirs, bundlesDir } =
      await setup({}, installedBoard);
    failing.add('board@2.0.0');

    const job = await install(board('2.0.0'), 'board');

    expect(job).toMatchObject({ state: 'rolled-back', operation: 'update', bundle: 'board' });
    expect(job.error).toBe('Extension failed to start: boom');
    expect(job.rollbackError).toBeUndefined();
    expect(states()).toEqual({ board: 'running' });
    expect(calls).toEqual(['stop board', 'start board@2.0.0', 'start board@1.0.0']);
    expect(await read('bundles/board/dashboard/score.html')).toBe('<p>score 1.0.0</p>');
    expect(JSON.parse(await read('bundles/board/mooncg.json')).version).toBe('1.0.0');
    // The version that failed is gone, and the backup went back to where it came from.
    expect(await installer.backups('board')).toEqual([]);
    expect(await stagingDirs()).toEqual([]);
    expect(await readdir(bundlesDir)).toEqual(['board']);
  });

  it('reports both errors when the old version does not start either', async () => {
    const { install, failing, states } = await setup({}, installedBoard);
    failing.add('board@2.0.0');
    failing.add('board@1.0.0');
    const job = await install(board('2.0.0'), 'board');
    expect(job).toMatchObject({ state: 'failed', operation: 'update' });
    expect(job.error).toBe('Extension failed to start: boom');
    expect(job.rollbackError).toBe('Extension failed to start: boom');
    expect(states()).toEqual({ board: 'failed' });
  });

  it('leaves configuration, assets and everything else in the data folder alone', async () => {
    const { install, write, dataDir, read, purged } = await setup({}, installedBoard);
    await write(dataDir, {
      'config/board.json': '{"league":"First"}',
      'assets/board/logos/logo.png': 'png',
    });
    await install(board('1.1.0'), 'board');
    expect(await read('data/config/board.json')).toBe('{"league":"First"}');
    expect(await read('data/assets/board/logos/logo.png')).toBe('png');
    expect(purged).toEqual([]);
  });

  it('keeps the newest backups only', async () => {
    let now = Date.UTC(2026, 0, 1);
    const { install, installer } = await setup(
      { backupsKept: 2, now: () => (now += 60_000) },
      installedBoard,
    );
    for (const version of ['1.1.0', '1.2.0', '1.3.0', '1.4.0']) {
      expect((await install(board(version), 'board')).state).toBe('succeeded');
    }
    expect((await installer.backups('board')).map(({ version }) => version)).toEqual([
      '1.3.0',
      '1.2.0',
    ]);
  });

  it('runs npm for the new version before the old one is touched', async () => {
    const { stage, installer, states, calls, read } = await setup(
      {
        npmInstall: async () => {
          throw new Error('registry unreachable');
        },
      },
      installedBoard,
    );
    const { staged } = await stage(
      { ...board('1.1.0'), 'package.json': { dependencies: { a: '1' } } },
      'board',
    );
    const job = await installer.settled(installer.commit(staged?.id ?? '', { by: 'ada' }).id);
    expect(job).toMatchObject({ state: 'failed', step: 'dependencies' });
    expect(calls).toEqual([]);
    expect(states()).toEqual({ board: 'running' });
    expect(await read('bundles/board/dashboard/score.html')).toBe('<p>score 1.0.0</p>');
    expect(await installer.backups('board')).toEqual([]);
  });
});

describe('update', () => {
  it('fetches from where the bundle came from when no source is given', async () => {
    const { installer, folder, write, read } = await setup();
    const path = await folder(board('1.0.0'), 'board-checkout');
    const first = await installer.settled(
      (await installer.stage({ source: { type: 'path', path }, by: 'ada' })).id,
    );
    await installer.settled(installer.commit(first.staged?.id ?? '', { by: 'ada' }).id);
    // The folder moves on to the next version.
    await write(path, board('1.5.0'));

    const job = await installer.settled((await installer.update('board', { by: 'olga' })).id);

    expect(job).toMatchObject({ operation: 'stage', state: 'succeeded' });
    expect(job.staged).toMatchObject({ target: 'board', replaces: '1.0.0', version: '1.5.0' });
    const done = await installer.settled(installer.commit(job.staged?.id ?? '', { by: 'olga' }).id);
    expect(done.state).toBe('succeeded');
    expect(await read('bundles/board/dashboard/score.html')).toBe('<p>score 1.5.0</p>');
  });

  it('takes another source when one is given, and remembers that one', async () => {
    const { installer, folder } = await setup({}, { board: board('1.0.0') });
    const path = await folder(board('3.0.0'), 'elsewhere');
    const job = await installer.settled(
      (await installer.update('board', { source: { type: 'path', path }, by: 'ada' })).id,
    );
    await installer.settled(installer.commit(job.staged?.id ?? '', { by: 'ada' }).id);
    expect(await installer.sources()).toEqual({ board: { type: 'path', location: path } });
  });

  it('says what to do when it does not know where the bundle came from', async () => {
    const { installer } = await setup({}, { board: board('1.0.0') });
    await expect(installer.update('board', { by: 'ada' })).rejects.toThrow(
      /not known where bundle "board" came from/,
    );
    await expect(installer.update('board', { by: 'ada' })).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(installer.update('nope', { by: 'ada' })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('cannot fetch an uploaded archive again', async () => {
    const { installer } = await setup();
    const zip = zipOf(board('1.0.0'));
    const staged = await installer.settled(
      (
        await installer.stage({
          source: { type: 'upload', body: Readable.from([zip]), filename: 'board.zip' },
          by: 'ada',
        })
      ).id,
    );
    await installer.settled(installer.commit(staged.staged?.id ?? '', { by: 'ada' }).id);
    await expect(installer.update('board', { by: 'ada' })).rejects.toThrow(/uploaded archive/);
  });
});

describe('remove', () => {
  const two = {
    data: { 'mooncg.json': manifest('data', { version: '2.0.0' }) },
    board: board('1.0.0', { dependencies: { data: '^2.0.0' } }),
  };

  it('stops the bundle and moves it to the backups; what it stored stays', async () => {
    const { installer, write, dataDir, read, states, bundlesDir, purged, changes } = await setup(
      {},
      two,
    );
    await write(dataDir, { 'config/board.json': '{"a":1}', 'assets/board/logos/l.png': 'png' });

    const started = installer.remove('board', { by: 'ada' });
    expect(started).toMatchObject({ operation: 'remove', bundle: 'board', by: 'ada' });
    const job = await installer.settled(started.id);

    expect(job).toMatchObject({ state: 'succeeded' });
    expect(states()).toEqual({ data: 'running' });
    expect(await readdir(bundlesDir)).toEqual(['data']);
    expect(await installer.backups('board')).toMatchObject([
      { version: '1.0.0', reason: 'remove' },
    ]);
    expect(await read('data/config/board.json')).toBe('{"a":1}');
    expect(await read('data/assets/board/logos/l.png')).toBe('png');
    expect(purged).toEqual([]);
    expect(changes()).toBe(1);
  });

  it('deletes the files instead when told to', async () => {
    const { installer, bundlesDir, dataDir, stagingDirs } = await setup({}, two);
    const job = await installer.settled(
      installer.remove('board', { deleteFiles: true, by: 'ada' }).id,
    );
    expect(job.state).toBe('succeeded');
    expect(await readdir(bundlesDir)).toEqual(['data']);
    expect(await installer.backups('board')).toEqual([]);
    expect(existsSync(join(dataDir, 'backups', 'board'))).toBe(false);
    expect(await stagingDirs()).toEqual([]);
  });

  it('purges what the bundle stored only when told to', async () => {
    const { installer, purged } = await setup({}, two);
    await installer.settled(installer.remove('board', { purgeData: true, by: 'ada' }).id);
    expect(purged).toEqual(['board']);
  });

  it('forgets where the bundle came from', async () => {
    const { install, installer } = await setup();
    await install(board('1.0.0'));
    expect(Object.keys(await installer.sources())).toEqual(['board']);
    await installer.settled(installer.remove('board', { by: 'ada' }).id);
    expect(await installer.sources()).toEqual({});
  });

  it('refuses at once while an enabled bundle depends on it, unless forced', async () => {
    const { installer, states, manager } = await setup({}, two);
    expect(() => installer.remove('data', { by: 'ada' })).toThrow(/needed by board/);
    expect(() => installer.remove('nope', { by: 'ada' })).toThrow(/no bundle "nope"/);
    expect(() => installer.remove('../data', { by: 'ada' })).toThrow(/no bundle/);
    expect(installer.jobs()).toEqual([]);
    expect(states()).toEqual({ board: 'running', data: 'running' });

    const job = await installer.settled(installer.remove('data', { force: true, by: 'ada' }).id);
    expect(job.state).toBe('succeeded');
    expect(manager.get('board')).toMatchObject({
      state: 'failed',
      errors: ['Stopped because bundle "data" was removed'],
    });
  });
});

describe('restore', () => {
  it('puts a backup back in place of the installed version, which becomes a backup', async () => {
    const { install, installer, read, states } = await setup({}, { board: board('1.0.0') });
    await install(board('2.0.0'), 'board');
    const [backup] = await installer.backups('board');

    const job = await installer.settled(
      (await installer.restore('board', backup?.id ?? '', 'ada')).id,
    );

    expect(job).toMatchObject({ state: 'succeeded', operation: 'restore', bundle: 'board' });
    expect(states()).toEqual({ board: 'running' });
    expect(await read('bundles/board/dashboard/score.html')).toBe('<p>score 1.0.0</p>');
    expect(await installer.backups('board')).toMatchObject([
      { version: '2.0.0', reason: 'restore' },
    ]);
  });

  it('keeps the installed version when the backup does not start', async () => {
    const { install, installer, read, failing, states } = await setup(
      {},
      { board: board('1.0.0') },
    );
    await install(board('2.0.0'), 'board');
    const [backup] = await installer.backups('board');
    failing.add('board@1.0.0');

    const job = await installer.settled(
      (await installer.restore('board', backup?.id ?? '', 'ada')).id,
    );

    expect(job).toMatchObject({ state: 'rolled-back', error: 'Extension failed to start: boom' });
    expect(states()).toEqual({ board: 'running' });
    expect(await read('bundles/board/dashboard/score.html')).toBe('<p>score 2.0.0</p>');
    // The backup is still there, as it was.
    expect(await installer.backups('board')).toMatchObject([{ id: backup?.id, version: '1.0.0' }]);
  });

  it('installs the backup of a bundle that was removed', async () => {
    const { installer, read, states } = await setup({}, { board: board('1.0.0') });
    await installer.settled(installer.remove('board', { by: 'ada' }).id);
    const [backup] = await installer.backups('board');

    const job = await installer.settled(
      (await installer.restore('board', backup?.id ?? '', 'ada')).id,
    );

    expect(job).toMatchObject({ state: 'succeeded', operation: 'restore' });
    expect(states()).toEqual({ board: 'running' });
    expect(await read('bundles/board/dashboard/score.html')).toBe('<p>score 1.0.0</p>');
    expect(await installer.backups('board')).toEqual([]);
  });

  it('refuses a backup that is not there, whatever it is called', async () => {
    const { installer, install } = await setup({}, { board: board('1.0.0') });
    await install(board('2.0.0'), 'board');
    for (const id of ['1.0.0-20200101T000000000Z', '..', '../../bundles/board', 'bundle', '']) {
      await expect(installer.restore('board', id, 'ada')).rejects.toMatchObject({
        code: 'not_found',
      });
    }
    await expect(installer.restore('../board', 'x', 'ada')).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(await installer.backups('../board')).toEqual([]);
  });
});

describe('the log', () => {
  it('says who did what', async () => {
    const { install, installer, lines } = await setup({}, { board: board('1.0.0') });
    await install(board('1.1.0'), 'board');
    await installer.settled(installer.remove('board', { purgeData: true, by: 'olga' }).id);
    const log = lines.join('\n');
    expect(log).toMatch(/\[bundles\] ada staged board 1\.1\.0 from folder /);
    expect(log).toMatch(/\[bundles\] ada updated board from 1\.0\.0 to 1\.1\.0/);
    expect(log).toMatch(/\[bundles\] olga removed board 1\.1\.0 .*data purged/);
  });
});

describe.skipIf(!hasGit)('a Git repository', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.org', ...args], {
      cwd,
      windowsHide: true,
      encoding: 'utf8',
    }).trim();

  async function repository(folder: (files: Files, name?: string) => Promise<string>) {
    const dir = await folder(board('1.0.0'), 'repo');
    git(dir, 'init', '--quiet', '--initial-branch=main');
    git(dir, 'add', '.');
    git(dir, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'one');
    return { dir, url: pathToFileURL(dir).href, commit: git(dir, 'rev-parse', 'HEAD') };
  }

  it('is fetched, and the commit is remembered', async () => {
    const { installer, folder, bundlesDir } = await setup({ git: { allowFileUrls: true } });
    const { url, commit } = await repository(folder);

    const job = await installer.settled(
      (await installer.stage({ source: { type: 'git', url, ref: 'main' }, by: 'ada' })).id,
    );

    expect(job.error).toBeUndefined();
    expect(job.staged).toMatchObject({
      name: 'board',
      files: 4,
      source: { type: 'git', location: url, ref: 'main', commit },
    });
    await installer.settled(installer.commit(job.staged?.id ?? '', { by: 'ada' }).id);
    expect(await installer.sources()).toEqual({
      board: { type: 'git', location: url, ref: 'main', commit },
    });
    expect(await readdir(join(bundlesDir, 'board'))).not.toContain('.git');
  });

  it('is refused through a file URL where no test allowed that', async () => {
    const { installer, folder } = await setup();
    const { url } = await repository(folder);
    await expect(
      installer.stage({ source: { type: 'git', url }, by: 'ada' }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });
});

// ---------------------------------------------------------------------------------------
// What a review of the installation found.

const withPackages = (
  extra: Files = {},
  dependencies: object = { 'left-pad': '^1.3.0' },
): Files => ({
  ...board('1.0.0'),
  'package.json': { dependencies },
  ...extra,
});

describe('a bundle that would steer npm', () => {
  it.each([
    ['an .npmrc', withPackages({ '.npmrc': 'git=./tools/g.exe' }), /\.npmrc/],
    ['a .yarnrc.yml', withPackages({ '.yarnrc.yml': 'x: y' }), /\.yarnrc\.yml/],
    [
      'a dependency fetched with Git',
      withPackages({}, { repo: 'git+ssh://git@example.org/o/r.git' }),
      /dependencies\.repo: git\+ssh:\/\/\*\*\*@example\.org/,
    ],
    [
      'a dependency from a URL',
      withPackages({}, { x: 'https://example.org/x.tgz' }),
      /dependencies\.x/,
    ],
    [
      'a dependency from a folder',
      withPackages({}, { x: 'file:../../elsewhere' }),
      /dependencies\.x/,
    ],
    ['a GitHub shorthand', withPackages({}, { x: 'owner/repo' }), /dependencies\.x/],
    [
      'a lockfile that fetches from elsewhere',
      withPackages({
        'package-lock.json': {
          lockfileVersion: 3,
          packages: { 'node_modules/left-pad': { resolved: 'https://evil.example.org/l.tgz' } },
        },
      }),
      /package-lock\.json: node_modules\/left-pad comes from https:\/\/evil\.example\.org/,
    ],
  ])(
    'is refused when it brings %s, unless it is trusted to run code',
    async (_what, files, reason) => {
      const { stage, installer, stagingDirs, npm } = await setup();
      const job = await stage(files);
      expect(job.state).toBe('failed');
      expect(job.error).toMatch(reason);
      expect(job.error).toMatch(/install scripts/);
      expect(installer.staged()).toEqual([]);
      expect(await stagingDirs()).toEqual([]);
      expect(npm).toEqual([]);
    },
  );

  it('is staged when that was allowed, says so, and is then installed with scripts', async () => {
    const { stage, installer, npm, lines } = await setup();
    const files = withPackages(
      { '.npmrc': 'registry=https://npm.example.org/' },
      {
        'left-pad': '^1.3.0',
        repo: 'git+https://example.org/o/r.git',
      },
    );

    const job = await stage(files, undefined, true);

    expect(job.error).toBeUndefined();
    expect(job.staged).toMatchObject({
      installCode: 'allowed',
      npm: {
        needed: true,
        config: ['.npmrc'],
        unusual: ['dependencies.repo: git+https://example.org/o/r.git'],
      },
    });
    // Whoever commits it need not say it again: it was said when the bundle was fetched.
    const done = await installer.settled(installer.commit(job.staged?.id ?? '', { by: 'olga' }).id);
    expect(done.state).toBe('succeeded');
    expect(npm[0]).toMatchObject({ scripts: true });
    expect(lines.join('\n')).toMatch(/WARN .*ada allowed .* to run code while it is installed/);
  });

  it('says for every bundle whether installing it can run code', async () => {
    const { stage } = await setup();
    expect((await stage(board('1.0.0'))).staged).toMatchObject({ installCode: 'none' });
    const plain = await stage({ ...withPackages(), 'mooncg.json': manifest('plain') });
    expect(plain.staged).toMatchObject({
      installCode: 'on-request',
      npm: { config: [], unusual: [] },
    });
    // npm is not run for a bundle that brought its packages, so its .npmrc steers nothing.
    const brought = await stage({
      ...withPackages({ '.npmrc': 'git=./g.exe', 'node_modules/left-pad/index.js': '' }),
      'mooncg.json': manifest('brought'),
    });
    expect(brought.staged).toMatchObject({ installCode: 'none', npm: { needed: false } });
  });
});

describe('after npm ran', () => {
  it('refuses a bundle whose manifest is no longer the one that was shown', async () => {
    const { stage, installer, bundlesDir, states, stagingDirs } = await setup({
      npmInstall: async ({ dir }) => {
        const changed = withExtension('board', '1.0.0', { capabilities: ['bundle:*:write'] });
        await writeFile(join(dir, 'mooncg.json'), JSON.stringify(changed));
      },
    });
    const { staged } = await stage(withPackages());
    const job = await installer.settled(installer.commit(staged?.id ?? '', { by: 'ada' }).id);
    expect(job.state).toBe('failed');
    expect(job.error).toMatch(/manifest is not the one that was shown/);
    expect(await readdir(bundlesDir)).toEqual([]);
    expect(states()).toEqual({});
    // What npm left is not kept for another try.
    expect(installer.staged()).toEqual([]);
    expect(await stagingDirs()).toEqual([]);
  });

  it('measures the bundle again and refuses one that grew beyond the limit', async () => {
    const { stage, installer, bundlesDir } = await setup({
      limits: { ...DEFAULT_INSTALL_LIMITS, maxUnpackedBytes: 20_000 },
      npmInstall: async ({ dir }) => {
        await mkdir(join(dir, 'node_modules', 'fat'), { recursive: true });
        await writeFile(join(dir, 'node_modules', 'fat', 'index.js'), Buffer.alloc(50_000));
      },
    });
    const { staged } = await stage(withPackages());
    const job = await installer.settled(installer.commit(staged?.id ?? '', { by: 'ada' }).id);
    expect(job.state).toBe('failed');
    expect(job.error).toMatch(/larger than 20000 bytes/);
    expect(await readdir(bundlesDir)).toEqual([]);
  });

  it('takes credentials out of what npm said, in the log and in the job', async () => {
    const { stage, installer, lines, published } = await setup({
      npmInstall: async ({ log }) => {
        log(
          'npm http fetch GET https://bob:hunter2@npm.example.org/left-pad?authToken=s3cr3t-value',
        );
        throw new Error('npm exited with code 1: 401 https://bob:hunter2@npm.example.org/left-pad');
      },
    });
    const { staged } = await stage(withPackages());
    const job = await installer.settled(installer.commit(staged?.id ?? '', { by: 'ada' }).id);
    expect(job.error).toContain('npm.example.org/left-pad');
    const told = `${lines.join('\n')}\n${JSON.stringify(published())}`;
    expect(told).toContain('npm.example.org/left-pad');
    expect(told).not.toMatch(/hunter2|s3cr3t-value/);
  });
});

describe('restore, checked like an update', () => {
  it('refuses a backup that a bundle depending on it cannot use, and stops nothing', async () => {
    const lib = (version: string) => ({ 'mooncg.json': withExtension('lib', version) });
    const { install, installer, states, calls, read } = await setup({}, { lib: lib('1.0.0') });
    await install(lib('2.0.0'), 'lib');
    await install({
      'mooncg.json': withExtension('app', '1.0.0', { dependencies: { lib: '^2.0.0' } }),
    });
    const [backup] = await installer.backups('lib');
    calls.length = 0;

    const job = await installer.settled(
      (await installer.restore('lib', backup?.id ?? '', 'ada')).id,
    );

    expect(job.state).toBe('failed');
    expect(job.error).toBe('Bundle "app" needs lib ^2.0.0, but this is version 1.0.0');
    expect(calls).toEqual([]);
    expect(states()).toEqual({ app: 'running', lib: 'running' });
    expect(JSON.parse(await read('bundles/lib/mooncg.json')).version).toBe('2.0.0');
    expect(await installer.backups('lib')).toMatchObject([{ version: '1.0.0' }]);
  });

  it('refuses a backup that asks for another MoonCG', async () => {
    const { install, installer, dataDir, states } = await setup({}, { board: board('1.0.0') });
    await install(board('2.0.0'), 'board');
    const [backup] = await installer.backups('board');
    const kept = join(dataDir, 'backups', 'board', backup?.id ?? '', 'bundle', 'mooncg.json');
    await writeFile(
      kept,
      JSON.stringify(withExtension('board', '1.0.0', { engine: { mooncg: '>=9' } })),
    );
    const job = await installer.settled(
      (await installer.restore('board', backup?.id ?? '', 'ada')).id,
    );
    expect(job.state).toBe('failed');
    expect(job.error).toMatch(/engine\.mooncg: needs MoonCG >=9/);
    expect(states()).toEqual({ board: 'running' });
  });
});

describe('how much may go on at once', () => {
  async function slowGit() {
    const dir = await mkdtemp(join(tmpdir(), 'mooncg-fake-git-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const script = join(dir, 'slow-git.mjs');
    await writeFile(script, 'await new Promise((done) => setTimeout(done, 90_000));');
    return {
      command: [process.execPath, script],
      resolve: async () => [{ address: '93.184.215.14', family: 4 }],
    };
  }
  const git = { type: 'git', url: 'https://example.org/o/r.git' } as const;

  it('fetches two bundles at a time and refuses a third', async () => {
    const { installer } = await setup({ git: await slowGit() });
    await installer.stage({ source: git, by: 'ada' });
    await installer.stage({ source: git, by: 'ada' });
    const third = installer.stage({ source: git, by: 'ada' });
    await expect(third).rejects.toMatchObject({ code: 'conflict' });
    await expect(third).rejects.toThrow(/2 bundles are being fetched/);
    expect(installer.jobs()).toHaveLength(2);
    await installer.close();
  }, 20_000);

  it('holds a few fetched bundles and refuses more until one is decided about', async () => {
    const { installer, stage, stagingDirs } = await setup({ maxStaged: 2 });
    const one = await stage(board('1.0.0'));
    await stage({ 'mooncg.json': manifest('two') });
    const third = installer.stage({ source: { type: 'path', path: '/srv/x' }, by: 'ada' });
    await expect(third).rejects.toMatchObject({ code: 'conflict' });
    await expect(third).rejects.toThrow(/2 fetched bundles wait for a decision/);
    expect(await stagingDirs()).toHaveLength(2);
    await installer.discard(one.staged?.id ?? '', 'ada');
    expect((await stage({ 'mooncg.json': manifest('three') })).state).toBe('succeeded');
  });

  it('has defaults of two and five', async () => {
    const { installer } = await setup();
    expect(installer.limits).toMatchObject({ maxStageJobs: 2, maxStaged: 5 });
  });

  it('keeps a job that still runs, however many came after it', async () => {
    const { installer, stage } = await setup({ git: await slowGit() });
    const running = await installer.stage({ source: git, by: 'ada' });
    for (let index = 0; index < JOBS_KEPT + 5; index++) await stage({ a: 'b' });
    expect(installer.job(running.id)).toMatchObject({ state: 'running' });
    expect(installer.jobs().length).toBeLessThanOrEqual(JOBS_KEPT + 1);
    await installer.close();
  }, 30_000);
});

describe('removing, when something goes wrong or nothing is kept', () => {
  it('finishes the removal when the data cannot be purged, and says so', async () => {
    const { installer, install, states, changes, bundlesDir } = await setup({
      purge: async () => {
        throw new Error('the database is locked');
      },
    });
    await install(board('1.0.0'));
    const before = changes();

    const job = await installer.settled(
      installer.remove('board', { purgeData: true, by: 'ada' }).id,
    );

    expect(job.state).toBe('failed');
    expect(job.error).toBe(
      'Bundle "board" was removed, but what it stored could not be deleted: the database is locked',
    );
    expect(states()).toEqual({});
    expect(await readdir(bundlesDir)).toEqual([]);
    expect(await installer.sources()).toEqual({});
    expect(changes()).toBe(before + 1);
  });

  it('keeps no backup at all when told to keep none', async () => {
    const { installer, install, dataDir, lines, failing, states, read } = await setup(
      { backupsKept: 0 },
      { board: board('1.0.0') },
    );
    expect(installer.limits.backupsKept).toBe(0);
    // An update still has something to go back to while it runs...
    failing.add('board@2.0.0');
    expect((await install(board('2.0.0'), 'board')).state).toBe('rolled-back');
    expect(states()).toEqual({ board: 'running' });
    expect(await read('bundles/board/dashboard/score.html')).toBe('<p>score 1.0.0</p>');
    // ...and nothing is left of it afterwards.
    expect((await install(board('1.1.0'), 'board')).state).toBe('succeeded');
    expect(await installer.backups('board')).toEqual([]);

    const job = await installer.settled(installer.remove('board', { by: 'ada' }).id);
    expect(job.state).toBe('succeeded');
    expect(await readdir(join(dataDir, 'backups', 'board')).catch(() => [])).toEqual([]);
    expect(lines.join('\n')).toMatch(/ada removed board 1\.1\.0 \(files deleted, data kept\)/);
  });
});

describe('backups that are not whole', () => {
  it('do not count against the number that is kept, and are swept', async () => {
    let now = Date.UTC(2026, 5, 1);
    const { installer, install, dataDir, write } = await setup(
      { backupsKept: 2, now: () => (now += 60_000) },
      { board: board('1.0.0') },
    );
    // Folders an interrupted update left: the note is there, the bundle is not.
    const broken = ['9.9.9-20300101T000000000Z', '9.9.8-20300102T000000000Z'];
    for (const id of broken)
      await write(join(dataDir, 'backups', 'board', id), { 'backup.json': '{}' });

    for (const version of ['1.1.0', '1.2.0']) await install(board(version), 'board');

    expect((await installer.backups('board')).map(({ version }) => version)).toEqual([
      '1.1.0',
      '1.0.0',
    ]);
    expect((await readdir(join(dataDir, 'backups', 'board'))).sort()).toEqual(
      (await installer.backups('board')).map(({ id }) => id).sort(),
    );
  });
});

describe('a move that fails', () => {
  it('leaves nothing of a new bundle in the bundles folder', async () => {
    const { stage, installer, bundlesDir, states } = await setup({
      move: async (_from, to) => {
        await mkdir(join(to, 'dashboard'), { recursive: true });
        await writeFile(join(to, 'mooncg.json'), '{ half');
        throw new Error('the disk went away');
      },
    });
    const { staged } = await stage(board('1.0.0'));
    const job = await installer.settled(installer.commit(staged?.id ?? '', { by: 'ada' }).id);
    expect(job.state).toBe('failed');
    expect(job.error).toBe('the disk went away');
    expect(await readdir(bundlesDir)).toEqual([]);
    expect(states()).toEqual({});
    // Nothing was used up: the fetched bundle is still there to try again.
    expect(installer.staged().map(({ id }) => id)).toEqual([staged?.id]);
  });

  it('keeps the fetched bundle when an update could not move it in', async () => {
    const { moveDir } = await import('../src/install/files.js');
    let moves = 0;
    const { stage, installer, states, read } = await setup(
      {
        move: async (from, to) => {
          // The installed version moves out; the new one does not get in.
          if (++moves === 2) throw new Error('EBUSY: the folder is locked');
          await moveDir(from, to);
        },
      },
      { board: board('1.0.0') },
    );
    const { staged } = await stage(board('2.0.0'), 'board');
    const job = await installer.settled(installer.commit(staged?.id ?? '', { by: 'ada' }).id);
    expect(job).toMatchObject({ state: 'rolled-back', error: 'EBUSY: the folder is locked' });
    expect(states()).toEqual({ board: 'running' });
    expect(await read('bundles/board/dashboard/score.html')).toBe('<p>score 1.0.0</p>');
    expect(installer.staged().map(({ id }) => id)).toEqual([staged?.id]);
    expect(await installer.backups('board')).toEqual([]);
  });
});

describe('two fetched bundles of the same name', () => {
  it('are not both installed when both are committed at once', async () => {
    const { stage, installer, states, calls, read } = await setup();
    const first = await stage(board('1.0.0'));
    const second = await stage(board('2.0.0'));

    const jobs = await Promise.all(
      [first, second].map(({ staged }) =>
        installer.settled(installer.commit(staged?.id ?? '', { by: 'ada' }).id),
      ),
    );

    expect(jobs.map(({ state }) => state).sort()).toEqual(['failed', 'succeeded']);
    expect(jobs.find(({ state }) => state === 'failed')?.error).toMatch(/already installed/);
    expect(states()).toEqual({ board: 'running' });
    expect(calls.filter((call) => call.startsWith('start'))).toHaveLength(1);
    const winner = jobs[0]?.state === 'succeeded' ? '1.0.0' : '2.0.0';
    expect(JSON.parse(await read('bundles/board/mooncg.json')).version).toBe(winner);
    // The one that lost is still there, to be discarded.
    expect(installer.staged()).toHaveLength(1);
  });
});

describe('what a refusal says', () => {
  it('reports a full disk as a problem of the server, without a path', async () => {
    const { installer, stagingDirs } = await setup();
    const body = new Readable({
      read() {
        this.destroy(
          Object.assign(
            new Error("ENOSPC: no space left on device, write 'C:\\srv\\secret\\upload.zip'"),
            {
              code: 'ENOSPC',
            },
          ),
        );
      },
    });
    const staged = installer.stage({ source: { type: 'upload', body }, by: 'ada' });
    await expect(staged).rejects.toMatchObject({ code: 'internal' });
    await expect(staged).rejects.toThrow(/could not store the bundle: the disk is full/);
    await expect(staged).rejects.not.toThrow(/secret|srv/);
    expect(await stagingDirs()).toEqual([]);
  });

  it('names no folder of the server when an upload breaks off', async () => {
    const { installer, dataDir } = await setup();
    const body = new Readable({
      read() {
        this.destroy(
          new Error(`aborted while writing ${join(dataDir, 'staging', 'x', 'upload.zip')}`),
        );
      },
    });
    const staged = installer.stage({ source: { type: 'upload', body }, by: 'ada' });
    await expect(staged).rejects.toThrow(/did not arrive whole/);
    await expect(staged).rejects.not.toThrow(new RegExp(dataDir.replaceAll('\\', '\\\\'), 'i'));
  });

  it.each([
    { type: 'path', path: '\\\\server\\share\\bundle' },
    { type: 'path', path: '//server/share/bundle' },
    { type: 'zip', path: '\\\\server\\share\\bundle.zip' },
  ] as const)('refuses the network path $path before it looks at it', async (source) => {
    const { installer } = await setup();
    const staged = installer.stage({ source, by: 'ada' });
    await expect(staged).rejects.toMatchObject({ code: 'invalid' });
    await expect(staged).rejects.toThrow(/network path/);
    expect(installer.jobs()).toEqual([]);
  });
});

describe('the roles a bundle proposes', () => {
  it('are part of what is shown, with whether they will be granted', async () => {
    const asked: string[] = [];
    const { stage } = await setup({
      roles: {
        proposed: (name, defaultRoles) => {
          asked.push(name);
          return {
            grants: { operator: [...(defaultRoles.operator ?? [])] },
            applies: name !== 'seen',
          };
        },
      },
    });
    const files = (name: string) => ({
      'mooncg.json': manifest(name, {
        permissions: { view: 'See', operate: 'Do' },
        defaultRoles: { operator: ['view', 'operate'], nobody: ['view'] },
      }),
    });
    expect((await stage(files('fresh'))).staged?.roles).toEqual({
      grants: { operator: ['view', 'operate'] },
      applies: true,
    });
    expect((await stage(files('seen'))).staged?.roles).toMatchObject({ applies: false });
    expect(asked).toEqual(['fresh', 'seen']);
  });

  it('are shown as proposed and not granted where nothing can tell', async () => {
    const { stage } = await setup();
    const job = await stage({
      'mooncg.json': manifest('x', {
        permissions: { view: 'See' },
        defaultRoles: { viewer: ['view'] },
      }),
    });
    expect(job.staged?.roles).toEqual({ grants: { viewer: ['view'] }, applies: false });
  });
});
