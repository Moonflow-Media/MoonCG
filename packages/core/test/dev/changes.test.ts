import { describe, expect, it } from 'vitest';
import {
  changeArea,
  isIdlePlan,
  isIgnoredPath,
  planForAreas,
  planReload,
} from '../../src/dev/changes.js';

describe('isIgnoredPath', () => {
  it.each([
    'node_modules/vue/index.js',
    'dashboard/node_modules/x.js',
    '.git/HEAD',
    '.vscode/settings.json',
    'dashboard/.cache/a.html',
    '.env',
    'graphics/.DS_Store',
    '',
  ])('ignores %s', (path) => {
    expect(isIgnoredPath(path)).toBe(true);
  });

  it.each(['mooncg.json', 'dashboard/control.html', 'extension/index.js', 'graphics/a.b/c.css'])(
    'takes %s',
    (path) => {
      expect(isIgnoredPath(path)).toBe(false);
    },
  );
});

describe('changeArea', () => {
  it.each([
    ['mooncg.json', 'manifest'],
    ['extension/index.js', 'extension'],
    ['extension/lib/deep/util.js', 'extension'],
    ['shared/types.js', 'extension'],
    ['dashboard/control.html', 'dashboard'],
    ['graphics/overlay.html', 'graphics'],
    ['schemas/score.json', 'schemas'],
    ['README.md', 'other'],
    ['package.json', 'other'],
    ['dashboard', 'other'],
    ['docs/mooncg.json', 'other'],
  ] as const)('puts %s under %s', (path, area) => {
    expect(changeArea(path)).toBe(area);
  });

  it('counts a schema file the manifest names as a schema, wherever it lies', () => {
    expect(changeArea('config.schema.json', ['config.schema.json'])).toBe('schemas');
    expect(changeArea('config.schema.json')).toBe('other');
  });

  it('reads backslashes as the separators Windows reports', () => {
    expect(changeArea('dashboard\\control.html')).toBe('dashboard');
  });

  it('puts an ignored path under nothing', () => {
    expect(changeArea('extension/node_modules/x/index.js')).toBe('other');
    expect(changeArea('dashboard/.tmp/control.html')).toBe('other');
  });
});

describe('planReload', () => {
  const dev = { dev: true };
  const production = { dev: false };

  it('does nothing for changes that concern nothing', () => {
    const plan = planReload(['README.md', 'node_modules/a/b.js', '.git/index'], dev);
    expect(plan).toEqual({ bundle: 'none', panels: false, graphics: 'none' });
    expect(isIdlePlan(plan)).toBe(true);
  });

  it('reloads the bundle when its manifest changed', () => {
    expect(planReload(['mooncg.json'], dev)).toEqual({
      bundle: 'reload',
      panels: false,
      graphics: 'none',
    });
  });

  it('reloads the bundle when a schema changed', () => {
    expect(planReload(['schemas/score.json'], production).bundle).toBe('reload');
    expect(
      planReload(['config.schema.json'], { dev: false, schemaFiles: ['config.schema.json'] })
        .bundle,
    ).toBe('reload');
  });

  it('restarts the extension for extension and shared code', () => {
    expect(planReload(['extension/index.js'], dev).bundle).toBe('restart-extension');
    expect(planReload(['shared/util.js'], production).bundle).toBe('restart-extension');
  });

  it('lets a reload of the bundle stand for a restart of its extension', () => {
    expect(planReload(['extension/index.js', 'mooncg.json'], dev).bundle).toBe('reload');
  });

  it('reloads the panels for dashboard files, in and out of dev mode', () => {
    expect(planReload(['dashboard/control.html'], dev)).toEqual({
      bundle: 'none',
      panels: true,
      graphics: 'none',
    });
    expect(planReload(['dashboard/control.css'], production).panels).toBe(true);
  });

  it('reloads graphics in dev mode', () => {
    expect(planReload(['graphics/overlay.html'], dev)).toEqual({
      bundle: 'none',
      panels: false,
      graphics: 'reload',
    });
  });

  it('never reloads a graphic outside dev mode: it is marked out of date', () => {
    expect(planReload(['graphics/overlay.html'], production)).toEqual({
      bundle: 'none',
      panels: false,
      graphics: 'mark-out-of-date',
    });
  });

  it('leaves pages to the development server of a bundle that names one, in dev mode', () => {
    const paths = ['dashboard/control.html', 'graphics/overlay.html', 'extension/index.js'];
    expect(planReload(paths, { dev: true, devUrl: true })).toEqual({
      bundle: 'restart-extension',
      panels: false,
      graphics: 'none',
    });
  });

  it('does not honour a development server outside dev mode', () => {
    const paths = ['dashboard/control.html', 'graphics/overlay.html'];
    expect(planReload(paths, { dev: false, devUrl: true })).toEqual({
      bundle: 'none',
      panels: true,
      graphics: 'mark-out-of-date',
    });
  });

  it('combines everything a batch of changes touched', () => {
    const paths = ['schemas/a.json', 'dashboard/a.html', 'graphics/a.html', 'extension/a.js'];
    expect(planReload(paths, dev)).toEqual({
      bundle: 'reload',
      panels: true,
      graphics: 'reload',
    });
  });

  it('plans the same from the areas alone', () => {
    expect(planForAreas(['dashboard', 'extension'], dev)).toEqual(
      planReload(['dashboard/a.html', 'extension/a.js'], dev),
    );
    expect(isIdlePlan(planForAreas(['other'], dev))).toBe(true);
    expect(isIdlePlan(planForAreas(['graphics'], production))).toBe(false);
  });
});
