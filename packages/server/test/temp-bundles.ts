import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** Creates temporary bundle folders for one test file and removes them again. */
export function temporaryBundles() {
  const created: string[] = [];
  return {
    /** Writes `files` (path relative to the new bundles directory, to content) and returns it. */
    async create(files: Readonly<Record<string, string | object>>): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), 'mooncg-test-'));
      created.push(dir);
      await this.add(dir, files);
      return dir;
    },
    /** Writes more files into a directory `create` made. */
    async add(dir: string, files: Readonly<Record<string, string | object>>): Promise<void> {
      for (const [path, content] of Object.entries(files)) {
        const target = join(dir, path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, typeof content === 'string' ? content : JSON.stringify(content));
      }
    },
    async cleanup(): Promise<void> {
      for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true });
    },
  };
}

/** A minimal valid manifest for a bundle called `name`. */
export function manifest(name: string, extra: object = {}): object {
  return { manifest: 1, kind: 'bundle', name, version: '1.0.0', ...extra };
}
