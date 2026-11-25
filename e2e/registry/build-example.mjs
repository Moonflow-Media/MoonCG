// Builds the example registry index next to this file from examples/scoreboard: an archive of
// the bundle and an index that lists it with its checksum. Run it with `node` after the
// example changed; a test checks that the index, the archive and the bundle agree.
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
// The built core, so run `pnpm build` first: it writes the JSON Schema of an index too.
import { registryIndexJsonSchema } from '../../packages/core/dist/index.js';
import { makeZip } from '../../packages/server/test/zip-writer.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const bundle = fileURLToPath(new URL('../../examples/scoreboard/', import.meta.url));

async function files(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await files(path)));
    else found.push(path);
  }
  return found.sort();
}

const manifest = JSON.parse(await readFile(join(bundle, 'mooncg.json'), 'utf8'));
const items = [];
for (const file of await files(bundle)) {
  items.push({
    name: relative(bundle, file).split('\\').join('/'),
    data: await readFile(file),
    // Stored, not compressed: the same files give the same archive on every machine.
    store: true,
  });
}
const archive = makeZip(items);
const zipName = `scoreboard-${manifest.version}.zip`;
await writeFile(join(here, zipName), archive);
const index = {
  $schema: '../../docs/registry-index.schema.json',
  index: 1,
  title: 'MoonCG example index',
  entries: [
    {
      name: manifest.name,
      kind: 'bundle',
      title: manifest.title,
      description: 'The example bundle of MoonCG: a score with a panel and a graphic.',
      author: 'MoonCG',
      license: 'MIT',
      tags: ['example', 'sports'],
      versions: [
        {
          version: manifest.version,
          engine: { mooncg: '>=0.10.0' },
          source: {
            type: 'zip',
            url: zipName,
            sha256: createHash('sha256').update(archive).digest('hex'),
          },
        },
      ],
    },
  ],
};
await writeFile(join(here, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
const schema = fileURLToPath(new URL('../../docs/registry-index.schema.json', import.meta.url));
await writeFile(schema, `${JSON.stringify(registryIndexJsonSchema(), null, 2)}\n`);
console.log(`Wrote ${zipName}, index.json and docs/registry-index.schema.json`);
