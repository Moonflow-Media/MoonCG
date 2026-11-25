import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUNDLE_NAME_PATTERN, isReservedDeviceName, SYSTEM_BUNDLE } from '@mooncg/core';

/** The bundle templates the command line ships, by the name of their folder in `templates/`. */
export const TEMPLATES = ['html', 'vue'] as const;
export type Template = (typeof TEMPLATES)[number];

/** The name of the configuration file. The same as the server's `CONFIG_FILE`. */
const CONFIG_FILE = 'mooncg.config.json';

const templatesDir = fileURLToPath(new URL('../templates/', import.meta.url));

/** Where `@mooncg/sdk` is: the entry of its client, `<sdk>/dist/client/index.js`. */
const resolveSdkClient = () => createRequire(import.meta.url).resolve('@mooncg/sdk/client');

/**
 * `@mooncg/sdk` as a bundle with a build step names it: the folder of the copy this command
 * line uses, since the SDK is not published on npm.
 */
function sdkDependency(resolveSdk: () => string): string {
  let entry: string;
  try {
    entry = resolveSdk();
  } catch (error) {
    throw new Error(
      `@mooncg/sdk could not be found beside this command line (${(error as Error).message}). ` +
        'A bundle with a build step names it by its folder, as it is not on npm. Build the ' +
        'MoonCG this command line belongs to ("pnpm build"), or use --template html. ' +
        'Nothing was written.',
    );
  }
  return `file:${dirname(dirname(dirname(entry))).replaceAll('\\', '/')}`;
}

/** Files a template holds under another name, because npm would leave them out. */
const RENAMED: Readonly<Record<string, string>> = { gitignore: '.gitignore' };

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** `lower-third` becomes `Lower Third`. */
export function titleOf(name: string): string {
  return name
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** Every file below a folder, relative to it, with forward slashes. */
async function filesIn(dir: string, below = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(dir, below), { withFileTypes: true })) {
    const path = below === '' ? entry.name : `${below}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await filesIn(dir, path)));
    else files.push(path);
  }
  return files.sort();
}

export interface CreateBundleOptions {
  /** The name of the bundle, which is also the name of its folder. */
  readonly name: string;
  /** The folder that holds one folder per bundle. */
  readonly bundlesDir: string;
  readonly template?: string | undefined;
  /** Writes one new file. For tests: stands in for the file system, to make it fail. */
  readonly write?: ((path: string, text: string) => Promise<void>) | undefined;
  /** Finds the entry of `@mooncg/sdk/client`. For tests: stands in for module resolution. */
  readonly resolveSdk?: (() => string) | undefined;
}

/**
 * Creates a bundle from a template: a folder of the bundle's name in the bundles folder.
 * Nothing that exists is written to. If a file cannot be written, the folder is taken away
 * again, so that nothing half-written is left and the command can be run once more. Returns
 * the folder and the files created in it.
 */
export async function createBundle(
  options: CreateBundleOptions,
): Promise<{ readonly dir: string; readonly files: readonly string[] }> {
  const { name, bundlesDir } = options;
  const template = TEMPLATES.find((known) => known === (options.template ?? 'html'));
  if (template === undefined) {
    throw new Error(
      `There is no template "${options.template}". The templates are: ${TEMPLATES.join(', ')}`,
    );
  }
  if (!BUNDLE_NAME_PATTERN.test(name) || name.length > 100) {
    throw new Error(
      `"${name}" cannot be the name of a bundle: use lowercase letters, digits and single dashes, such as "lower-third"`,
    );
  }
  if (name === SYSTEM_BUNDLE || isReservedDeviceName(name)) {
    throw new Error(`"${name}" is a reserved name and cannot be the name of a bundle`);
  }
  const dir = join(bundlesDir, name);
  if (await exists(dir)) {
    throw new Error(`${dir} exists already. Nothing was written.`);
  }
  const source = join(templatesDir, template);
  const files = await filesIn(source);
  const title = titleOf(name);
  // Before anything is created. It goes into a string of package.json: JSON-escaped, so no
  // quote or backslash of the path can end the string.
  const sdk = files.some((file) => file === 'package.json')
    ? JSON.stringify(sdkDependency(options.resolveSdk ?? resolveSdkClient)).slice(1, -1)
    : '';
  // `wx`: never over a file that appeared meanwhile.
  const write = options.write ?? ((path, text) => writeFile(path, text, { flag: 'wx' }));
  await mkdir(bundlesDir, { recursive: true });
  // Created here and by nobody else, or not at all: only then is it this command's to
  // remove again.
  await mkdir(dir).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new Error(`${dir} exists already. Nothing was written.`);
  });
  try {
    for (const file of files) {
      const text = await readFile(join(source, file), 'utf8');
      const target = join(dir, RENAMED[file] ?? file);
      await mkdir(join(target, '..'), { recursive: true });
      // Replacer functions: a `$` in a value is not a replacement pattern.
      await write(
        target,
        text
          .replaceAll('{{name}}', () => name)
          .replaceAll('{{title}}', () => title)
          .replaceAll('{{sdk}}', () => sdk),
      );
    }
  } catch (error) {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
    throw new Error(
      `The bundle "${name}" could not be created, and ${dir} was removed again: ${(error as Error).message}`,
    );
  }
  return { dir, files: files.map((file) => RENAMED[file] ?? file) };
}

/**
 * Creates an installation folder: `bundles/`, `modules/`, `data/`, a configuration file that names them,
 * and a `.gitignore` that keeps the data, with its password hashes, out of a repository.
 * Refuses a folder that has a configuration file; folders and a `.gitignore` that are there
 * are left as they are. Returns what was created, relative to the folder.
 */
export async function initInstallation(dir: string): Promise<string[]> {
  const config = join(dir, CONFIG_FILE);
  if (await exists(config)) {
    throw new Error(`${config} exists already. Nothing was changed.`);
  }
  const created: string[] = [];
  for (const folder of ['bundles', 'modules', 'data']) {
    if (await exists(join(dir, folder))) continue;
    await mkdir(join(dir, folder), { recursive: true });
    created.push(`${folder}/`);
  }
  const settings = {
    port: 9090,
    host: '127.0.0.1',
    bundlesDir: 'bundles',
    modulesDir: 'modules',
    dataDir: 'data',
    allowedOrigins: [],
  };
  await writeFile(config, `${JSON.stringify(settings, null, 2)}\n`, { flag: 'wx' });
  created.push(CONFIG_FILE);
  const ignore = join(dir, '.gitignore');
  if (!(await exists(ignore))) {
    await writeFile(ignore, '# Accounts, sessions and everything else the server stores.\ndata/\n');
    created.push('.gitignore');
  }
  return created;
}

/** A path as it is shown: relative to the working directory when it is inside it. */
export function shownPath(cwd: string, path: string): string {
  const inside = relative(cwd, path);
  return inside === '' ? '.' : inside.startsWith('..') ? resolve(path) : inside;
}
