import { describe, expect, it } from 'vitest';
import { parseManifest } from '../../src/index.js';

const module = (extra: object = {}) => ({
  manifest: 1,
  kind: 'module',
  name: 'auth-oidc',
  version: '1.0.0',
  ...extra,
});
const errorsOf = (input: unknown) => {
  const result = parseManifest(input);
  return result.ok ? [] : result.errors.map(({ path, message }) => `${path}: ${message}`);
};

describe('the manifest of a module', () => {
  it('takes a main file and a config schema', () => {
    const result = parseManifest(
      module({ title: 'OpenID Connect', main: 'dist/index.js', config: { schema: 'config.json' } }),
    );
    expect(result.ok && result.manifest.main).toBe('dist/index.js');
  });

  it('refuses a main file outside the module', () => {
    expect(errorsOf(module({ main: '../evil.js' }))).toHaveLength(1);
    expect(errorsOf(module({ main: 'C:/evil.js' }))).toHaveLength(1);
  });

  it('refuses what only a bundle has', () => {
    const errors = errorsOf(
      module({
        extension: 'extension/index.js',
        permissions: { view: 'See' },
        panels: [{ id: 'p', title: 'P', file: 'dashboard/p.html' }],
        capabilities: ['http.routes'],
      }),
    );
    expect(errors).toEqual([
      'extension: Only a bundle has this; a module has "main"',
      'permissions: Only a bundle has this; a module defines permissions in its setup',
      'panels: Only a bundle has this',
      'capabilities: Only a bundle has this',
    ]);
  });

  it('refuses a main file in a bundle', () => {
    expect(errorsOf({ ...module({ main: 'index.js' }), kind: 'bundle' })).toEqual([
      'main: Only a module has a main file; a bundle has "extension"',
    ]);
  });
});
