import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_INSTALL_LIMITS,
  entryNameProblem,
  isInside,
  MOVE_RETRY_MS,
  measureTree,
  moveDir,
  removeDir,
} from '../src/install/files.js';

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mooncg-files-'));
  made.push(dir);
  return dir;
}
const errno = (code: string) => Object.assign(new Error(code), { code });

describe('limits', () => {
  it('has defaults that fit a bundle and stop an archive that is none', () => {
    expect(DEFAULT_INSTALL_LIMITS).toEqual({
      maxArchiveBytes: 100 * 1024 * 1024,
      maxUnpackedBytes: 500 * 1024 * 1024,
      maxFiles: 50_000,
      maxCompressionRatio: 100,
    });
  });
});

describe('isInside', () => {
  const root = join(tmpdir(), 'root');

  it('is true for the folder itself and everything below it', () => {
    expect(isInside(root, root)).toBe(true);
    expect(isInside(root, join(root, 'a', 'b'))).toBe(true);
    expect(isInside(root, `${root}${sep}`)).toBe(true);
  });

  it('is false for a sibling whose name starts the same, a parent and a way out', () => {
    expect(isInside(root, `${root}-other`)).toBe(false);
    expect(isInside(root, tmpdir())).toBe(false);
    expect(isInside(root, join(root, '..', 'elsewhere'))).toBe(false);
  });

  it.runIf(process.platform === 'win32')('ignores case and takes another drive as outside', () => {
    expect(isInside('C:\\Data\\MoonCG', 'c:\\data\\mooncg\\staging')).toBe(true);
    expect(isInside('C:\\Data', 'D:\\Data\\x')).toBe(false);
  });
});

describe('entryNameProblem', () => {
  it.each([
    'mooncg.json',
    'dashboard/panel.html',
    'graphics/img/logo.final.png',
    'node_modules/@scope/pkg/index.js',
    'extension/index.js',
    'a b/c (1).txt',
    'docs/ünïcode.md',
    'folder/',
    'console.log.txt',
    'aux-files/com10.txt',
  ])('accepts "%s"', (name) => {
    expect(entryNameProblem(name)).toBeUndefined();
  });

  it.each([
    ['', 'empty'],
    ['/etc/passwd', 'absolute'],
    ['../outside.txt', '".."'],
    ['a/../../outside.txt', '".."'],
    ['a/./b', '"."'],
    ['a//b', 'empty'],
    ['a\\b.txt', 'backslash'],
    ['..\\..\\evil.txt', 'backslash'],
    ['C:/Windows/evil.dll', 'drive'],
    ['C:evil.txt', 'drive'],
    ['a/b:stream', ':'],
    ['a/CON', 'reserved'],
    ['nul.txt', 'reserved'],
    ['x/COM1.log', 'reserved'],
    ['LPT9', 'reserved'],
    ['aux.tar.gz', 'reserved'],
    ['a/trailing./b', 'ends with'],
    ['a/trailing /b', 'ends with'],
    ['a/b\u0000c', 'control'],
    ['a/b\nc', 'control'],
    ['a/what?.txt', 'character'],
    ['a/star*.txt', 'character'],
    ['a/<b>.txt', 'character'],
    ['a/pipe|.txt', 'character'],
    ['a/"q".txt', 'character'],
    [`${'d/'.repeat(60)}f`, 'deep'],
    [`a/${'x'.repeat(256)}`, 'long'],
    ['x'.repeat(1100), 'long'],
  ])('refuses "%s" (%s)', (name, reason) => {
    expect(entryNameProblem(name)).toContain(reason);
  });
});

describe('moveDir', () => {
  it('moves a folder with what is in it', async () => {
    const root = await temp();
    await mkdir(join(root, 'from', 'sub'), { recursive: true });
    await writeFile(join(root, 'from', 'sub', 'file.txt'), 'content');

    await moveDir(join(root, 'from'), join(root, 'to'));

    expect(await readFile(join(root, 'to', 'sub', 'file.txt'), 'utf8')).toBe('content');
    expect(await readdir(root)).toEqual(['to']);
  });

  it('refuses to move over something that is there', async () => {
    const root = await temp();
    await mkdir(join(root, 'from'));
    await mkdir(join(root, 'to'));
    await writeFile(join(root, 'to', 'kept.txt'), 'kept');

    await expect(moveDir(join(root, 'from'), join(root, 'to'))).rejects.toThrow(/already exists/);
    expect(await readFile(join(root, 'to', 'kept.txt'), 'utf8')).toBe('kept');
  });

  it.each(['EPERM', 'EBUSY', 'EACCES'])(
    'tries again, waiting longer each time, while Windows says %s',
    async (code) => {
      const waits: number[] = [];
      let calls = 0;
      await moveDir('from', join(await temp(), 'to'), {
        rename: async () => {
          if (++calls <= 3) throw errno(code);
        },
        wait: async (ms) => void waits.push(ms),
      });
      expect(calls).toBe(4);
      expect(waits).toEqual(MOVE_RETRY_MS.slice(0, 3));
      expect(MOVE_RETRY_MS.length).toBeGreaterThanOrEqual(5);
      expect([...MOVE_RETRY_MS]).toEqual([...MOVE_RETRY_MS].sort((a, b) => a - b));
    },
  );

  it('gives up when the folder stays locked, and says why', async () => {
    let calls = 0;
    const moved = moveDir('from', join(await temp(), 'to'), {
      rename: async () => {
        calls++;
        throw errno('EBUSY');
      },
      wait: async () => {},
    });
    await expect(moved).rejects.toThrow(/in use/);
    expect(calls).toBe(MOVE_RETRY_MS.length + 1);
  });

  it('does not retry an error that waiting will not cure', async () => {
    let calls = 0;
    const moved = moveDir('from', join(await temp(), 'to'), {
      rename: async () => {
        calls++;
        throw errno('ENOENT');
      },
      wait: async () => {},
    });
    await expect(moved).rejects.toThrow('ENOENT');
    expect(calls).toBe(1);
  });

  it('copies and deletes when the folders are on different volumes', async () => {
    const root = await temp();
    await mkdir(join(root, 'from', 'sub'), { recursive: true });
    await writeFile(join(root, 'from', 'sub', 'file.txt'), 'content');

    await moveDir(join(root, 'from'), join(root, 'to'), {
      // Only the way to the other volume is closed; beside itself a folder can be renamed.
      rename: async (from, to) => {
        if (to === join(root, 'to')) throw errno('EXDEV');
        await rename(from, to);
      },
    });

    expect(await readFile(join(root, 'to', 'sub', 'file.txt'), 'utf8')).toBe('content');
    expect(await readdir(root)).toEqual(['to']);
  });

  it('leaves no half copy behind when copying across volumes fails', async () => {
    const root = await temp();
    await mkdir(join(root, 'to-parent'));
    const moved = moveDir(join(root, 'missing'), join(root, 'to-parent', 'to'), {
      rename: async () => {
        throw errno('EXDEV');
      },
    });
    await expect(moved).rejects.toThrow();
    expect(await readdir(join(root, 'to-parent'))).toEqual([]);
  });
});

describe('removeDir', () => {
  it('removes a folder with everything in it, and is fine with one that is gone', async () => {
    const root = await temp();
    await mkdir(join(root, 'a', 'b'), { recursive: true });
    await writeFile(join(root, 'a', 'b', 'c.txt'), 'c');
    await removeDir(join(root, 'a'));
    await removeDir(join(root, 'a'));
    expect(await readdir(root)).toEqual([]);
  });
});

describe('measureTree', () => {
  it('counts the files and their bytes', async () => {
    const root = await temp();
    await mkdir(join(root, 'sub', 'deeper'), { recursive: true });
    await writeFile(join(root, 'a.txt'), '12345');
    await writeFile(join(root, 'sub', 'deeper', 'b.txt'), '123');
    expect(await measureTree(root, DEFAULT_INSTALL_LIMITS)).toEqual({ files: 2, bytes: 8 });
  });

  it('refuses more files or bytes than allowed', async () => {
    const root = await temp();
    for (const name of ['a', 'b', 'c']) await writeFile(join(root, name), '1234');
    await expect(measureTree(root, { ...DEFAULT_INSTALL_LIMITS, maxFiles: 2 })).rejects.toThrow(
      /more than 2 files/,
    );
    await expect(
      measureTree(root, { ...DEFAULT_INSTALL_LIMITS, maxUnpackedBytes: 10 }),
    ).rejects.toThrow(/larger than 10 bytes/);
  });

  it('refuses a symbolic link', async (context) => {
    const root = await temp();
    await mkdir(join(root, 'sub'));
    try {
      await symlink(tmpdir(), join(root, 'sub', 'link'), 'junction');
    } catch {
      return context.skip();
    }
    await expect(measureTree(root, DEFAULT_INSTALL_LIMITS)).rejects.toThrow(
      /"sub\/link" is a symbolic link/,
    );
  });
});
