import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_INSTALL_LIMITS, type InstallLimits } from '../src/install/files.js';
import { bundleRoot, extractZip } from '../src/install/zip.js';
import { makeZip, type ZipItem, zipOf } from './zip-writer.js';

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

/**
 * Writes the archive into a folder of its own and extracts it into `dest` beside a file that
 * must stay as it is. What is left in the folder afterwards is all the extraction wrote.
 */
async function extract(archive: Buffer, limits: Partial<InstallLimits> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mooncg-zip-'));
  made.push(root);
  const file = join(root, 'archive.zip');
  const dest = join(root, 'work', 'dest');
  await mkdir(dest, { recursive: true });
  await writeFile(file, archive);
  await writeFile(join(root, 'canary.txt'), 'untouched');
  const result = extractZip(file, dest, { ...DEFAULT_INSTALL_LIMITS, ...limits });
  /** Everything below the temporary folder, as forward-slash paths. */
  const tree = async () => {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) =>
        join(entry.parentPath, entry.name)
          .slice(root.length + 1)
          .replaceAll('\\', '/'),
      )
      .sort();
  };
  return { root, dest, result, tree };
}

/** The archive is refused for `reason`, and nothing but the archive itself is on disk. */
async function refused(items: readonly ZipItem[], reason: RegExp, limits?: Partial<InstallLimits>) {
  const { result, tree, root } = await extract(makeZip(items), limits);
  await expect(result).rejects.toThrow(reason);
  await expect(result).rejects.toMatchObject({ code: 'invalid' });
  expect(await tree()).toEqual(['archive.zip', 'canary.txt']);
  expect(await readFile(join(root, 'canary.txt'), 'utf8')).toBe('untouched');
  // Nothing appeared beside the temporary folder either.
  expect(existsSync(join(dirname(root), 'evil.txt'))).toBe(false);
}

const good: ZipItem = { name: 'mooncg.json', data: '{}' };

describe('extractZip', () => {
  it('extracts files and folders, compressed or stored', async () => {
    const { dest, result } = await extract(
      makeZip([
        { name: 'mooncg.json', data: '{"manifest":1}' },
        { name: 'dashboard/' },
        { name: 'dashboard/panel.html', data: '<p>panel</p>'.repeat(50) },
        { name: 'graphics/deep/er/logo.bin', data: Buffer.from([0, 1, 2, 255]), store: true },
        { name: 'empty.txt' },
      ]),
    );
    expect(await result).toEqual({ files: 4, bytes: 14 + 600 + 4 });
    expect(await readFile(join(dest, 'mooncg.json'), 'utf8')).toBe('{"manifest":1}');
    expect(await readFile(join(dest, 'dashboard/panel.html'), 'utf8')).toHaveLength(600);
    expect([...(await readFile(join(dest, 'graphics/deep/er/logo.bin')))]).toEqual([0, 1, 2, 255]);
    expect(await readFile(join(dest, 'empty.txt'), 'utf8')).toBe('');
  });

  it('refuses a file that is no archive', async () => {
    const { result } = await extract(Buffer.from('this is not a zip file at all'));
    await expect(result).rejects.toThrow(/not a usable ZIP archive/);
    await expect(result).rejects.toMatchObject({ code: 'invalid' });
  });

  it('refuses an empty archive', async () => {
    await refused([], /empty/);
  });

  // --- Zip slip: no entry may land outside the folder it is extracted into.
  it.each([
    ['a parent folder', '../evil.txt'],
    ['a parent folder further in', 'a/b/../../../evil.txt'],
    ['many parent folders', '../../../../../../../../evil.txt'],
    ['an absolute path', '/evil.txt'],
    ['an absolute path under temp', `${tmpdir().replaceAll('\\', '/')}/evil.txt`],
    ['a drive letter', 'C:/evil.txt'],
    ['a drive-relative path', 'C:evil.txt'],
    ['a UNC path', '//server/share/evil.txt'],
    ['backslashes', '..\\evil.txt'],
    ['backslashes further in', 'a\\..\\..\\evil.txt'],
    ['an alternate data stream', 'mooncg.json:evil'],
  ])('refuses an entry with %s', async (_what, name) => {
    await refused([good, { name, data: 'evil' }], /Entry ".*": /);
  });

  it.each(['CON', 'nul.txt', 'dashboard/COM1', 'x/lpt3.html', 'AUX.js'])(
    'refuses the reserved Windows name "%s"',
    async (name) => {
      await refused([good, { name, data: 'x' }], /reserved/);
    },
  );

  it('refuses names that Windows would store under another name', async () => {
    await refused([good, { name: 'trailing-dot./file', data: 'x' }], /ends with/);
    await refused([good, { name: 'trailing-space /file', data: 'x' }], /ends with/);
  });

  it('refuses a symbolic link entry', async () => {
    await refused(
      [good, { name: 'link', data: '../../canary.txt', mode: 0o120777 }],
      /Entry "link": symbolic links are not extracted/,
    );
  });

  it('refuses device files and other special entries', async () => {
    await refused([good, { name: 'dev', mode: 0o020644 }], /Entry "dev": .*special/);
    await refused([good, { name: 'fifo', mode: 0o010644 }], /Entry "fifo": .*special/);
  });

  it('takes regular files and folders that say so in their mode', async () => {
    const { result } = await extract(
      makeZip([
        { name: 'bin/', mode: 0o040755 },
        { name: 'bin/run.js', data: 'run', mode: 0o100755 },
      ]),
    );
    expect(await result).toEqual({ files: 1, bytes: 3 });
  });

  it('refuses an encrypted entry', async () => {
    await refused([good, { name: 'secret.bin', data: 'x', encrypted: true }], /encrypted/);
  });

  it('refuses two entries for the same file, also when only the case differs', async () => {
    await refused([good, { name: 'a.txt', data: '1' }, { name: 'a.txt', data: '2' }], /twice/);
    await refused([good, { name: 'Dashboard/a.txt' }, { name: 'dashboard/A.TXT' }], /twice/);
  });

  it('refuses a file where another entry needs a folder', async () => {
    await refused(
      [
        { name: 'a', data: 'file' },
        { name: 'a/b.txt', data: 'x' },
      ],
      /both a file/,
    );
    await refused(
      [
        { name: 'a/b.txt', data: 'x' },
        { name: 'a', data: 'file' },
      ],
      /both a file/,
    );
  });

  // --- Limits.
  it('refuses more entries than allowed', async () => {
    const items = Array.from({ length: 6 }, (_, index) => ({ name: `f${index}.txt`, data: 'x' }));
    await refused(items, /more than 5 entries/, { maxFiles: 5 });
  });

  it('refuses more uncompressed bytes than allowed, by what the archive says', async () => {
    await refused(
      [
        { name: 'a.bin', data: Buffer.alloc(600, 1), store: true },
        { name: 'b.bin', data: Buffer.alloc(600, 2), store: true },
      ],
      /unpacks to more than 1000 bytes/,
      { maxUnpackedBytes: 1000 },
    );
  });

  it('refuses a zip bomb by its compression ratio', async () => {
    // Two megabytes of zeros in about two kilobytes.
    const { result, tree } = await extract(
      makeZip([good, { name: 'bomb.bin', data: Buffer.alloc(2 * 1024 * 1024) }]),
    );
    await expect(result).rejects.toThrow(/compressed more than 100 times/);
    expect(await tree()).toEqual(['archive.zip', 'canary.txt']);
  });

  it('takes small files however well they compress', async () => {
    const { result } = await extract(makeZip([{ name: 'zeros.txt', data: Buffer.alloc(50_000) }]));
    expect(await result).toEqual({ files: 1, bytes: 50_000 });
  });

  it('stops an entry that unpacks to more than its header says, and keeps nothing', async () => {
    // The header claims ten bytes; the data inflates to two megabytes.
    const { result, tree } = await extract(
      makeZip([
        good,
        { name: 'liar.bin', data: Buffer.alloc(2 * 1024 * 1024, 7), claimedSize: 10 },
      ]),
      { maxCompressionRatio: 1_000_000 },
    );
    await expect(result).rejects.toThrow(/not a usable ZIP archive|larger than it says/);
    expect(await tree()).toEqual(['archive.zip', 'canary.txt']);
  });

  it('counts what is really written against the limit, whatever the headers say', async () => {
    const { result, tree } = await extract(
      makeZip([{ name: 'liar.bin', data: Buffer.alloc(5000, 7), claimedSize: 10, store: true }]),
      { maxUnpackedBytes: 1000 },
    );
    await expect(result).rejects.toThrow();
    expect(await tree()).toEqual(['archive.zip', 'canary.txt']);
  });
});

describe('bundleRoot', () => {
  async function folder(files: Readonly<Record<string, string>>) {
    const { dest, result } = await extract(zipOf(files));
    await result;
    return dest;
  }

  it('is the folder itself when the manifest is at the top', async () => {
    const dest = await folder({ 'mooncg.json': '{}', 'dashboard/a.html': 'a' });
    expect(await bundleRoot(dest)).toBe(dest);
  });

  it('is the one top-level folder when everything is inside it', async () => {
    const dest = await folder({
      'my-bundle-1.2.0/mooncg.json': '{}',
      'my-bundle-1.2.0/dashboard/a.html': 'a',
    });
    expect(await bundleRoot(dest)).toBe(join(dest, 'my-bundle-1.2.0'));
  });

  it('unwraps one level only, and only a lone folder', async () => {
    const two = await folder({ 'a/mooncg.json': '{}', 'b/mooncg.json': '{}' });
    expect(await bundleRoot(two)).toBe(two);
    const beside = await folder({ 'a/mooncg.json': '{}', 'README.md': 'read me' });
    expect(await bundleRoot(beside)).toBe(beside);
    const deep = await folder({ 'a/b/mooncg.json': '{}' });
    expect(await bundleRoot(deep)).toBe(join(deep, 'a'));
  });
});
