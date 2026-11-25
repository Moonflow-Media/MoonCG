import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchSource, sourceProblem } from '../src/install/fetch.js';
import { DEFAULT_INSTALL_LIMITS } from '../src/install/files.js';
import { parseCatalogOrigin } from '../src/install/installer.js';
import { publicSource, refetchable } from '../src/install/sources.js';
import { privateNetworks } from '../src/registry/network.js';
import { bytes, type HttpFixture, startHttpFixture } from './http-fixture.js';
import { zipOf } from './zip-writer.js';

const made: string[] = [];
const fixtures: HttpFixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
  for (const dir of made.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mooncg-url-'));
  made.push(dir);
  return dir;
}
const hasGit = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;

const MANIFEST = { manifest: 1, kind: 'bundle', name: 'board', version: '1.0.0' };
const archive = zipOf({ 'mooncg.json': MANIFEST, 'graphics/a.html': '<p>a</p>' });
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

const context = (limits = DEFAULT_INSTALL_LIMITS) => ({
  limits,
  timeoutMs: 5000,
  signal: new AbortController().signal,
  forbidden: [],
  noun: 'bundle',
  git: { allowFileUrls: true },
});

/** An archive listed in an index on this machine, which alone may point to this machine. */
async function serveArchive(body = archive) {
  const fixture = await startHttpFixture({ '/board.zip': bytes(body) });
  fixtures.push(fixture);
  return { url: `${fixture.url}/board.zip`, index: `${fixture.url}/index.json` };
}

describe('a ZIP archive from an address', () => {
  it('is downloaded, checked against its checksum and unpacked', async () => {
    const { url, index } = await serveArchive();
    const dir = await temp();
    const content = join(dir, 'bundle');
    const source = await fetchSource(
      { type: 'url', url, sha256: sha256(archive), index },
      dir,
      content,
      context(),
    );
    // The index it was listed in is not kept with the source: it may hold credentials.
    expect(source).toEqual({ type: 'url', url, sha256: sha256(archive) });
    expect(JSON.parse(await readFile(join(content, 'mooncg.json'), 'utf8'))).toEqual(MANIFEST);
    // Nothing of the download is left beside the bundle.
    expect((await readdir(dir)).sort()).toEqual(['bundle']);
  });

  it('is refused before anything is unpacked when the checksum does not match', async () => {
    const { url, index } = await serveArchive();
    const dir = await temp();
    const content = join(dir, 'bundle');
    await expect(
      fetchSource({ type: 'url', url, sha256: 'f'.repeat(64), index }, dir, content, context()),
    ).rejects.toThrow(/checksum/i);
    expect(existsSync(content)).toBe(false);
    expect(existsSync(join(dir, 'unpacked'))).toBe(false);
  });

  it('is refused when it is larger than an archive may be', async () => {
    const { url, index } = await serveArchive();
    const dir = await temp();
    await expect(
      fetchSource(
        { type: 'url', url, sha256: sha256(archive), index },
        dir,
        join(dir, 'bundle'),
        context({ ...DEFAULT_INSTALL_LIMITS, maxArchiveBytes: 10 }),
      ),
    ).rejects.toThrow(/larger than 10/);
  });

  it('needs an https address and a SHA-256', () => {
    const problem = (source: unknown) => sourceProblem(source as never, 'bundle');
    expect(problem({ type: 'url', url: 'https://example.org/a.zip', sha256: 'a'.repeat(64) })).toBe(
      undefined,
    );
    expect(
      problem({ type: 'url', url: 'http://example.org/a.zip', sha256: 'a'.repeat(64) }),
    ).toMatch(/https/);
    // An address of its own never asks this machine; an index on this machine may.
    const sha = 'a'.repeat(64);
    expect(problem({ type: 'url', url: 'http://127.0.0.1:9/a.zip', sha256: sha })).toMatch(
      /https|machine/,
    );
    expect(problem({ type: 'url', url: 'https://localhost/a.zip', sha256: sha })).toMatch(
      /machine/,
    );
    expect(
      problem({ type: 'url', url: 'http://169.254.169.254\\@127.0.0.1/', sha256: sha }),
    ).toBeDefined();
    expect(problem({ type: 'url', url: 'https://10.0.0.8/a.zip', sha256: sha })).toMatch(
      /internal/,
    );
    expect(
      problem({
        type: 'url',
        url: 'http://127.0.0.1:9/a.zip',
        sha256: sha,
        index: 'http://127.0.0.1:9/index.json',
      }),
    ).toBeUndefined();
    expect(problem({ type: 'url', url: 'https://example.org/a.zip' })).toMatch(/SHA-256/);
    expect(problem({ type: 'url', url: 'https://example.org/a.zip', sha256: 'ABC' })).toMatch(
      /SHA-256/,
    );
  });

  it('is told without credentials and can be fetched again', () => {
    const source = {
      type: 'url',
      url: 'https://reader:secret@example.org/a.zip?token=x',
      sha256: 'a'.repeat(64),
    } as const;
    expect(publicSource(source)).toEqual({
      type: 'url',
      location: 'https://***@example.org/a.zip',
      sha256: 'a'.repeat(64),
    });
    expect(refetchable(source)).toEqual({ type: 'url', url: source.url, sha256: source.sha256 });
  });

  it('keeps where an index listed it, for people and for updates', () => {
    const catalog = {
      index: 'abc123',
      indexUrl: 'https://example.org/index.json',
      kind: 'bundle',
      name: 'board',
      version: '1.0.0',
    } as const;
    expect(
      publicSource({ type: 'url', url: 'https://x.org/a.zip', sha256: 'a'.repeat(64), catalog }),
    ).toMatchObject({ catalog });
  });
});

describe.skipIf(!hasGit)('a Git source pinned to a commit', () => {
  async function repository() {
    const repo = await temp();
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim();
    git('init', '--quiet', '--initial-branch=main');
    git('config', 'user.email', 'test@example.org');
    git('config', 'user.name', 'Test');
    await mkdir(join(repo, 'graphics'));
    await writeFile(join(repo, 'mooncg.json'), JSON.stringify(MANIFEST));
    git('add', '.');
    git('commit', '--quiet', '-m', 'first');
    git('tag', 'v1.0.0');
    return { url: pathToFileURL(repo).href, commit: git('rev-parse', 'HEAD') };
  }

  it('is taken when the commit is the one the index names', async () => {
    const { url, commit } = await repository();
    const dir = await temp();
    const source = await fetchSource(
      { type: 'git', url, ref: 'v1.0.0', commit },
      dir,
      join(dir, 'bundle'),
      context(),
    );
    expect(source.commit).toBe(commit);
  });

  it('is refused, and nothing is kept, when the ref points elsewhere now', async () => {
    const { url } = await repository();
    const dir = await temp();
    const content = join(dir, 'bundle');
    await expect(
      fetchSource(
        { type: 'git', url, ref: 'v1.0.0', commit: 'c'.repeat(40) },
        dir,
        content,
        context(),
      ),
    ).rejects.toThrow(/commit/);
    expect(existsSync(content)).toBe(false);
  });
});

describe('parseCatalogOrigin', () => {
  it('takes up the index entry a staged note names, and nothing else', () => {
    const origin = {
      index: 'abc123',
      indexUrl: 'https://example.org/index.json',
      kind: 'bundle',
      name: 'board',
      version: '1.0.0',
    };
    expect(parseCatalogOrigin({ ...origin, extra: 'dropped' })).toEqual(origin);
    expect(parseCatalogOrigin({ ...origin, kind: 'theme' })).toBeUndefined();
    expect(parseCatalogOrigin({ ...origin, name: 'x'.repeat(300) })).toBeUndefined();
    expect(parseCatalogOrigin('board')).toBeUndefined();
  });
});

describe('where a source may lead, with the configuration of private networks', () => {
  const sha = 'a'.repeat(64);
  const access = privateNetworks(['10.20.0.0/16', 'git.corp.example'], false);
  const withHttp = privateNetworks(['10.20.0.0/16'], true);

  it('refuses an internal address written in a Git address before anything is started', () => {
    expect(sourceProblem({ type: 'git', url: 'https://10.20.0.5/o/r.git' }, 'bundle')).toMatch(
      /internal/,
    );
    expect(sourceProblem({ type: 'git', url: 'git@[fd00::1]:o/r.git' }, 'bundle')).toBeDefined();
    expect(sourceProblem({ type: 'git', url: 'ssh://git@127.0.0.1/o/r.git' }, 'bundle')).toMatch(
      /this machine/,
    );
    expect(
      sourceProblem({ type: 'git', url: 'https://10.20.0.5/o/r.git' }, 'bundle', false, access),
    ).toBeUndefined();
  });

  it('takes an archive on an allowed private network, over http only where that is allowed', () => {
    const at = (url: string, allowed = access) =>
      sourceProblem({ type: 'url', url, sha256: sha }, 'bundle', false, allowed);
    expect(at('https://10.20.0.5/a.zip')).toBeUndefined();
    expect(at('https://10.21.0.5/a.zip')).toMatch(/internal/);
    expect(at('http://10.20.0.5/a.zip')).toMatch(/https/);
    expect(at('http://10.20.0.5/a.zip', withHttp)).toBeUndefined();
    expect(at('https://127.0.0.1/a.zip', withHttp)).toMatch(/machine/);
  });

  it('lets Git ask this machine only for what an index on this machine lists', async () => {
    const dir = await temp();
    const script = join(dir, 'fake-git.mjs');
    await writeFile(
      script,
      `import { mkdirSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) console.log('git version 2.52.0');
if (args.includes('--get-url')) console.log(args.at(-1));
if (args.includes('--get-urlmatch')) process.exit(1);
if (args.includes('init')) mkdirSync(args.at(-1) + '/.git', { recursive: true });
if (args.includes('rev-parse')) console.log('${'b'.repeat(40)}');
`,
    );
    const git = {
      command: [process.execPath, script],
      resolve: async () => [{ address: '127.0.0.1', family: 4 }],
    };
    const url = 'https://localhost:3000/o/r.git';
    const fetch = (index?: string) =>
      fetchSource(
        { type: 'git', url, ...(index === undefined ? {} : { index }) },
        dir,
        join(dir, `bundle-${index === undefined ? 'direct' : 'listed'}`),
        { ...context(), git },
      );
    await expect(fetch()).rejects.toThrow(/this machine/);
    await expect(fetch('http://127.0.0.1:9/index.json')).resolves.toMatchObject({
      type: 'git',
      commit: 'b'.repeat(40),
    });
  });

  it('fetches a Git source from an index again with that index, for its rules', () => {
    const catalog = {
      index: 'abc123',
      indexUrl: 'http://127.0.0.1:9/index.json',
      kind: 'bundle',
      name: 'board',
      version: '1.0.0',
    } as const;
    const source = {
      type: 'git',
      url: 'https://localhost/o/r.git',
      commit: 'c'.repeat(40),
      catalog,
    } as const;
    expect(refetchable(source, () => 'http://127.0.0.1:9/index.json')).toEqual({
      type: 'git',
      url: source.url,
      commit: source.commit,
      index: 'http://127.0.0.1:9/index.json',
    });
  });
});
