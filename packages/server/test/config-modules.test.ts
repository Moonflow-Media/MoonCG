import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type ConfigFile, loadConfig } from '../src/kernel/config.js';

const cwd = resolve('/srv/show');
const load = (argv: string[] = [], env: Record<string, string> = {}, file?: ConfigFile) =>
  loadConfig({ argv, env, cwd, file });
const file = (values: unknown): ConfigFile => ({
  values,
  dir: resolve('/etc/mooncg'),
  path: resolve('/etc/mooncg/mooncg.config.json'),
});

describe('the modules folder', () => {
  it('is "modules" in the working directory unless said otherwise', () => {
    expect(load().modulesDir).toBe(resolve(cwd, 'modules'));
  });

  it('is taken from the flag, then the environment, then the file', () => {
    const fromFile = file({ modulesDir: 'mods' });
    expect(load([], {}, fromFile).modulesDir).toBe(resolve('/etc/mooncg/mods'));
    expect(load([], { MOONCG_MODULES_DIR: 'env' }, fromFile).modulesDir).toBe(resolve(cwd, 'env'));
    expect(load(['--modules-dir', 'flag'], { MOONCG_MODULES_DIR: 'env' }).modulesDir).toBe(
      resolve(cwd, 'flag'),
    );
  });
});

describe('the public address', () => {
  it('is not set unless said', () => {
    expect(load().publicUrl).toBeUndefined();
  });

  it('is an origin, from the flag, the environment or the file', () => {
    expect(load(['--public-url', 'https://show.example/']).publicUrl).toBe('https://show.example');
    expect(load([], { MOONCG_PUBLIC_URL: 'http://localhost:9090' }).publicUrl).toBe(
      'http://localhost:9090',
    );
    expect(load([], {}, file({ publicUrl: 'https://show.example:8443' })).publicUrl).toBe(
      'https://show.example:8443',
    );
  });

  it('refuses what is no origin: a path, a query, credentials, another scheme', () => {
    for (const url of [
      'show.example',
      'https://show.example/mooncg',
      'https://show.example/?a=1',
      'https://user:secret@show.example',
      'ftp://show.example',
      'https://show.example/#x',
    ]) {
      expect(() => load(['--public-url', url]), url).toThrow(/public address/);
    }
    expect(() => load([], {}, file({ publicUrl: 5 }))).toThrow(/publicUrl/);
  });

  it('does not show credentials in the complaint about them', () => {
    expect(() => load(['--public-url', 'https://user:hunter2@show.example'])).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('hunter2') }),
    );
  });
});
