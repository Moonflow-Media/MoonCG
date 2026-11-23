import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseManifest } from '@mooncg/core';
import { generateTypes, type ReplicantTypeSource } from './generate-types.js';

export const TYPES_FILE = 'mooncg-env.d.ts';

export interface WriteTypesOptions {
  /** The folder that holds the bundle's `mooncg.json`. */
  readonly bundleDir: string;
  /** Where to write. Defaults to `mooncg-env.d.ts` in the bundle folder. */
  readonly out?: string | undefined;
}

/** Generates the replicant types of a bundle and writes them. Returns the file written. */
export async function writeTypes({ bundleDir, out }: WriteTypesOptions): Promise<string> {
  const result = parseManifest(await readJson(join(bundleDir, 'mooncg.json')));
  if (!result.ok) {
    const errors = result.errors.map(({ path, message }) => `  ${path || '(root)'}: ${message}`);
    throw new Error(`mooncg.json is not a valid manifest:\n${errors.join('\n')}`);
  }
  const { name, replicants } = result.manifest;
  const sources: Record<string, ReplicantTypeSource> = {};
  for (const [replicant, declaration] of Object.entries(replicants)) {
    sources[replicant] =
      declaration.schema === undefined
        ? { default: declaration.default }
        : { schema: await readJson(join(bundleDir, declaration.schema), declaration.schema) };
  }

  const file = out ?? join(bundleDir, TYPES_FILE);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, generateTypes(name, sources));
  return file;
}

async function readJson(file: string, label = file): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    throw new Error(`Could not read ${label}: ${(error as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${(error as Error).message}`);
  }
}
