import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRegistryIndex, registryIndexJsonSchema } from '@mooncg/core';
import { describe, expect, it } from 'vitest';
import { DEFAULT_INSTALL_LIMITS } from '../src/install/files.js';
import { extractZip } from '../src/install/zip.js';

const repo = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));
const AGAIN = 'Run "pnpm build && node e2e/registry/build-example.mjs" to build it again.';

describe('the example registry index', () => {
  it('is a valid index whose archive has the checksum it names and holds the bundle it lists', async () => {
    const parsed = parseRegistryIndex(
      JSON.parse(await readFile(repo('e2e/registry/index.json'), 'utf8')),
    );
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    if (!parsed.ok) return;
    const [entry] = parsed.index.entries;
    expect(entry?.name).toBe('scoreboard');
    const version = entry?.versions[0];
    if (version?.source.type !== 'zip') throw new Error('The example lists a ZIP archive');
    const archive = await readFile(repo(`e2e/registry/${version.source.url}`));
    expect(createHash('sha256').update(archive).digest('hex'), AGAIN).toBe(version.source.sha256);

    const dir = await mkdtemp(join(tmpdir(), 'mooncg-example-index-'));
    try {
      const file = join(dir, 'a.zip');
      await writeFile(file, archive);
      await extractZip(file, join(dir, 'out'), DEFAULT_INSTALL_LIMITS);
      const manifest = JSON.parse(await readFile(join(dir, 'out', 'mooncg.json'), 'utf8'));
      expect([manifest.name, manifest.version]).toEqual([entry?.name, version.version]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('has the JSON Schema of an index published beside the documentation', async () => {
    const published = JSON.parse(await readFile(repo('docs/registry-index.schema.json'), 'utf8'));
    expect(published, AGAIN).toEqual(registryIndexJsonSchema());
  });
});
