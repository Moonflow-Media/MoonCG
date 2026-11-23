import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { type BundleState, type Manifest, parseManifest, SYSTEM_BUNDLE } from '@mooncg/core';
import { errorMessage } from '../kernel/logger.js';
import { BundleManager, type BundleManagerOptions } from './manager.js';

const MANIFEST_FILE = 'mooncg.json';

/** A bundle folder and what its manifest said. `manifest` is missing when it is unusable. */
export interface DiscoveredBundle {
  /** The folder name. For a valid bundle this equals `manifest.name`. */
  readonly name: string;
  readonly dir: string;
  readonly manifest: Manifest | undefined;
  readonly errors: readonly string[];
}

/** A bundle as the server knows it at this moment. */
export interface BundleRecord extends DiscoveredBundle {
  readonly state: BundleState;
  /** Why the bundle last failed, kept until it runs again. */
  readonly lastError?: string | undefined;
}

/** Reads the manifest of every folder in `bundlesDir`. A bad bundle never throws. */
export async function discoverBundles(bundlesDir: string): Promise<DiscoveredBundle[]> {
  const entries = await readdir(bundlesDir, { withFileTypes: true }).catch(() => []);
  const names = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
  return Promise.all(
    names.map(async (name) => {
      const dir = join(bundlesDir, name);
      return { name, dir, ...(await readManifest(dir, name)) };
    }),
  );
}

/** Reads one bundle folder again. `undefined` if there is no such folder. */
export async function readBundle(
  bundlesDir: string,
  name: string,
): Promise<DiscoveredBundle | undefined> {
  const dir = join(bundlesDir, name);
  const isDirectory = await stat(dir).then(
    (stats) => stats.isDirectory(),
    () => false,
  );
  return isDirectory ? { name, dir, ...(await readManifest(dir, name)) } : undefined;
}

/** Reads and checks the manifest in a bundle folder. */
export async function readManifest(
  dir: string,
  folder: string,
): Promise<Pick<DiscoveredBundle, 'manifest' | 'errors'>> {
  const failed = (...errors: string[]) => ({ manifest: undefined, errors });
  let text: string;
  try {
    text = await readFile(join(dir, MANIFEST_FILE), 'utf8');
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    return failed(
      missing
        ? `${MANIFEST_FILE} not found`
        : `${MANIFEST_FILE} could not be read: ${errorMessage(error)}`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return failed(`${MANIFEST_FILE} is not valid JSON: ${errorMessage(error)}`);
  }
  const result = parseManifest(json);
  if (!result.ok) {
    return failed(
      ...result.errors.map(({ path, message }) => (path ? `${path}: ${message}` : message)),
    );
  }
  const { manifest } = result;
  if (manifest.kind !== 'bundle') {
    return failed(`kind: Expected a bundle, found a ${manifest.kind}`);
  }
  if (manifest.name !== folder) {
    return failed(`name: Bundle "${manifest.name}" must live in a folder of the same name`);
  }
  if (manifest.name === SYSTEM_BUNDLE) {
    return failed(`name: "${SYSTEM_BUNDLE}" is reserved for the server itself`);
  }
  return { manifest, errors: [] };
}

/**
 * Discovers the bundles and starts them all, once. A convenience over `BundleManager` for
 * callers that only want the outcome.
 */
export async function loadBundles(options: BundleManagerOptions): Promise<BundleRecord[]> {
  const manager = new BundleManager(options);
  await manager.start();
  return [...manager.list()];
}
