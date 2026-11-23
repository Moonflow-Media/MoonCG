import { describe, expect, it } from 'vitest';
import { parseManifest } from '../../src/manifest/manifest.js';
import {
  ALLOW_ALL_POLICY,
  authorize,
  extensionPrincipal,
  TRUSTED_EXTENSION_POLICY,
} from '../../src/permissions/authorize.js';

const minimal = () => ({ manifest: 1, kind: 'bundle', name: 'tiny', version: '0.1.0' });

function pathsOf(input: unknown) {
  const result = parseManifest(input);
  if (result.ok) throw new Error('Expected the manifest to be rejected');
  return result.errors.map((error) => error.path);
}

describe('manifest permission references', () => {
  it('does not mistake inherited object members for declared permissions', () => {
    const paths = pathsOf({
      ...minimal(),
      replicants: { score: { read: 'constructor' } },
      panels: [{ id: 'a', title: 'A', file: 'dashboard/a.html', requires: 'constructor' }],
    });
    expect(paths).toEqual(['panels.0.requires', 'replicants.score.read']);
  });

  it('accepts a declared permission that shares its name with an object member', () => {
    const result = parseManifest({
      ...minimal(),
      permissions: { constructor: 'Build things' },
      replicants: { score: { read: 'constructor' } },
    });
    expect(result.ok).toBe(true);
  });
});

describe('manifest with an extremely nested value', () => {
  it('is rejected with an error instead of overflowing the stack', () => {
    let deep: unknown = 0;
    for (let level = 0; level < 100_000; level++) deep = [deep];

    const result = parseManifest({ ...minimal(), replicants: { score: { default: deep } } });

    expect(result.ok).toBe(false);
  });
});

describe('manifest extension path', () => {
  it.each([['dashboard/extension.js'], ['graphics/server/index.js']])(
    'rejects %s because that folder is served to browsers',
    (extension) => {
      expect(pathsOf({ ...minimal(), extension })).toEqual(['extension']);
    },
  );

  it.each([['extension/index.js'], ['index.js'], ['dashboards/index.js']])(
    'accepts %s',
    (extension) => {
      expect(parseManifest({ ...minimal(), extension }).ok).toBe(true);
    },
  );
});

describe('extensionPrincipal', () => {
  it('names the bundle and is allowed everything by the trusted extension policy', () => {
    const principal = extensionPrincipal('scoreboard');
    expect(principal.id).toBe('extension:scoreboard');
    expect(authorize(principal, 'bundle:other:operate', TRUSTED_EXTENSION_POLICY)).toBe(true);
  });

  it('holds no grant under an ordinary policy', () => {
    expect(authorize(extensionPrincipal('scoreboard'), 'bundle:x:y', ALLOW_ALL_POLICY)).toBe(false);
  });
});
