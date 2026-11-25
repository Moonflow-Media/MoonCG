import { describe, expect, it } from 'vitest';
import * as core from '../src/index.js';
import { parseManifest } from '../src/manifest/manifest.js';
import { isReservedDeviceName } from '../src/names.js';

const base = (extra: object = {}) => ({
  manifest: 1,
  kind: 'bundle',
  name: 'board',
  version: '1.0.0',
  ...extra,
});
const errors = (extra: object) => {
  const result = parseManifest(base(extra));
  return result.ok ? [] : result.errors.map(({ path, message }) => `${path}: ${message}`);
};
const many = (count: number, make: (index: number) => [string, unknown]) =>
  Object.fromEntries(Array.from({ length: count }, (_, index) => make(index)));

describe('names Windows reserves for devices', () => {
  const reserved = ['con', 'prn', 'aux', 'nul', 'com0', 'com1', 'com9', 'lpt0', 'lpt1', 'lpt9'];

  it.each(reserved)('refuses "%s" as the name of a bundle, on every system', (name) => {
    expect(isReservedDeviceName(name)).toBe(true);
    expect(isReservedDeviceName(name.toUpperCase())).toBe(true);
    expect(errors({ name })).toEqual([
      'name: Must not be a name that Windows reserves for a device',
    ]);
  });

  it.each(['console', 'null', 'com10', 'com', 'lpt', 'nul-device', 'aux2', 'printer'])(
    'takes "%s", which only looks alike',
    (name) => {
      expect(isReservedDeviceName(name)).toBe(false);
      expect(errors({ name })).toEqual([]);
    },
  );
});

describe('texts of a manifest that are shown to people', () => {
  const texts: [what: string, make: (text: string) => object, path: string][] = [
    ['the title', (text) => ({ title: text }), 'title'],
    [
      'a description of a permission',
      (text) => ({ permissions: { view: text } }),
      'permissions.view',
    ],
    ['a capability', (text) => ({ capabilities: [text] }), 'capabilities.0'],
    [
      'the title of a panel',
      (text) => ({ panels: [{ id: 'a', title: text, file: 'dashboard/a.html' }] }),
      'panels.0.title',
    ],
    [
      'the workspace of a panel',
      (text) => ({ panels: [{ id: 'a', title: 'A', file: 'dashboard/a.html', workspace: text }] }),
      'panels.0.workspace',
    ],
    [
      'the title of a graphic',
      (text) => ({
        graphics: [{ id: 'a', title: text, file: 'graphics/a.html', width: 1, height: 1 }],
      }),
      'graphics.0.title',
    ],
    [
      'the title of an asset category',
      (text) => ({ assets: [{ id: 'a', title: text }] }),
      'assets.0.title',
    ],
    ['the range of MoonCG', (text) => ({ engine: { mooncg: text } }), 'engine.mooncg'],
    [
      'the range of a dependency',
      (text) => ({ dependencies: { other: text } }),
      'dependencies.other',
    ],
  ];

  it.each(texts)('refuses control characters in %s', (_what, make, path) => {
    for (const bad of [
      'a\u001b[2Jb',
      'a\nb',
      'a\u0000b',
      'a\u007fb',
      'a\u009bb',
      'a\u0085b',
      '\tx',
    ]) {
      const found = errors(make(bad));
      expect(found.some((error) => error.startsWith(`${path}: `) && /control/.test(error))).toBe(
        true,
      );
    }
  });

  it.each(texts)('refuses %s when it goes on and on', (_what, make, path) => {
    const found = errors(make('x'.repeat(5000)));
    expect(found.some((error) => error.startsWith(`${path}: `))).toBe(true);
  });

  it('takes ordinary texts, in any language', () => {
    expect(
      errors({
        title: 'Spielstand – Übersicht (日本語) 🎬',
        permissions: { view: 'Sehen, was auf dem Spielfeld passiert. Mehr nicht.', plain: '' },
        capabilities: ['http.routes', 'bundle:team-data:read'],
        engine: { mooncg: '>=0.6.0 <2' },
      }),
    ).toEqual([]);
  });
});

describe('how much a manifest may declare', () => {
  const panel = (index: number) => ({
    id: `p${index}`,
    title: 'P',
    file: `dashboard/p${index}.html`,
  });
  const cases: [what: string, extra: object, path: string][] = [
    ['permissions', { permissions: many(501, (i) => [`p${i}`, '']) }, 'permissions'],
    ['panels', { panels: Array.from({ length: 501 }, (_, i) => panel(i)) }, 'panels'],
    [
      'dialogs',
      {
        dialogs: Array.from({ length: 501 }, (_, i) => ({ id: `d${i}`, file: 'dashboard/d.html' })),
      },
      'dialogs',
    ],
    [
      'graphics',
      {
        graphics: Array.from({ length: 501 }, (_, i) => ({
          id: `g${i}`,
          file: 'graphics/g.html',
          width: 1,
          height: 1,
        })),
      },
      'graphics',
    ],
    ['replicants', { replicants: many(2001, (i) => [`r${i}`, {}]) }, 'replicants'],
    ['messages', { messages: many(2001, (i) => [`m${i}`, {}]) }, 'messages'],
    [
      'asset categories',
      { assets: Array.from({ length: 201 }, (_, i) => ({ id: `a${i}` })) },
      'assets',
    ],
    [
      'capabilities',
      { capabilities: Array.from({ length: 201 }, (_, i) => `c${i}`) },
      'capabilities',
    ],
    ['dependencies', { dependencies: many(201, (i) => [`d${i}`, '*']) }, 'dependencies'],
    ['roles', { defaultRoles: many(101, (i) => [`role${i}`, []]) }, 'defaultRoles'],
  ];

  it.each(cases)('refuses more %s than any bundle has', (_what, extra, path) => {
    const found = errors(extra);
    expect(found.some((error) => error.startsWith(`${path}: `) && /at most/.test(error))).toBe(
      true,
    );
  });

  it('takes a bundle with a hundred panels and permissions', () => {
    expect(
      errors({
        permissions: many(100, (i) => [`p${i}`, 'A permission']),
        panels: Array.from({ length: 100 }, (_, i) => panel(i)),
      }),
    ).toEqual([]);
  });
});

describe('what core offers about operations', () => {
  it('has no table that nothing but its own tests reads', () => {
    expect(Object.keys(core)).not.toContain('compensation');
    expect(Object.keys(core)).toContain('OPERATION_STEPS');
  });
});
