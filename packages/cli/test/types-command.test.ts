import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { writeTypes } from '../src/types-command.js';

const typedFixture = fileURLToPath(new URL('./fixtures/typed', import.meta.url));

const temporary: string[] = [];
afterEach(async () => {
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function bundleDir(files: Record<string, string | object>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mooncg-cli-'));
  temporary.push(dir);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(
      join(dir, path),
      typeof content === 'string' ? content : JSON.stringify(content),
    );
  }
  return dir;
}

const manifest = (replicants: object) => ({
  manifest: 1,
  kind: 'bundle',
  name: 'demo',
  version: '1.0.0',
  replicants,
});

function io(cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { cwd, log: (line: string) => out.push(line), error: (line: string) => err.push(line) },
  };
}

describe('writeTypes', () => {
  it('writes mooncg-env.d.ts next to the manifest from schemas and defaults', async () => {
    const dir = await bundleDir({
      'mooncg.json': manifest({ score: { schema: 'schemas/score.json' }, count: { default: 0 } }),
      'schemas/score.json': { type: 'object', properties: { home: { type: 'integer' } } },
    });

    const file = await writeTypes({ bundleDir: dir });

    expect(file).toBe(join(dir, 'mooncg-env.d.ts'));
    const text = await readFile(file, 'utf8');
    expect(text).toContain('home?: number;');
    expect(text).toContain('count: number;');
    expect(text).toContain("'demo:score': ReplicantMap['score'];");
  });

  it('writes to another file when asked', async () => {
    const dir = await bundleDir({ 'mooncg.json': manifest({}) });
    const out = join(dir, 'types', 'env.d.ts');
    expect(await writeTypes({ bundleDir: dir, out })).toBe(out);
    expect(await readFile(out, 'utf8')).toContain('interface ReplicantMap {}');
  });

  it('keeps the checked-in fixture declaration up to date', async () => {
    const out = join(await bundleDir({}), 'generated.d.ts');
    await writeTypes({ bundleDir: typedFixture, out });
    expect(await readFile(out, 'utf8')).toBe(
      (await readFile(join(typedFixture, 'mooncg-env.d.ts'), 'utf8')).replaceAll('\r\n', '\n'),
    );
  });

  it.each([
    ['there is no manifest', {}, /mooncg\.json/],
    ['the manifest is invalid', { 'mooncg.json': { manifest: 1, kind: 'bundle' } }, /name: /],
    [
      'a schema file is missing',
      { 'mooncg.json': manifest({ score: { schema: 'schemas/score.json' } }) },
      /schemas\/score\.json/,
    ],
    [
      'a schema file is not JSON',
      { 'mooncg.json': manifest({ score: { schema: 's.json' } }), 's.json': '{' },
      /s\.json/,
    ],
  ])('fails with a readable error when %s', async (_label, files, message) => {
    const dir = await bundleDir(files);
    await expect(writeTypes({ bundleDir: dir })).rejects.toThrow(message);
  });
});

describe('mooncg command line', () => {
  it('runs "types" for the working directory by default', async () => {
    const dir = await bundleDir({ 'mooncg.json': manifest({ count: { default: 0 } }) });
    const { io: streams, out } = io(dir);

    expect(await run(['types'], streams)).toBe(0);

    expect(out).toEqual([`Wrote ${join(dir, 'mooncg-env.d.ts')}`]);
    expect(await readFile(join(dir, 'mooncg-env.d.ts'), 'utf8')).toContain('count: number;');
  });

  it('takes a bundle directory and --out, both relative to the working directory', async () => {
    const dir = await bundleDir({
      'bundles/demo/mooncg.json': manifest({ count: { default: 0 } }),
    });
    const { io: streams } = io(dir);

    expect(await run(['types', 'bundles/demo', '--out', 'env.d.ts'], streams)).toBe(0);

    expect(await readFile(join(dir, 'env.d.ts'), 'utf8')).toContain('count: number;');
  });

  it('reports a failure and exits with 1', async () => {
    const dir = await bundleDir({});
    const { io: streams, err } = io(dir);

    expect(await run(['types'], streams)).toBe(1);

    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/mooncg\.json/);
  });

  it.each([[[]], [['frobnicate']], [['types', '--nope']]])('prints usage for %j', async (argv) => {
    const { io: streams, err } = io(process.cwd());
    expect(await run(argv, streams)).toBe(1);
    expect(err.join('\n')).toMatch(/Usage: mooncg types \[bundleDir\] \[--out <file>\]/);
  });
});
