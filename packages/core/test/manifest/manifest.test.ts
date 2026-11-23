import { describe, expect, it } from 'vitest';
import { manifestJsonSchema, parseManifest } from '../../src/manifest/manifest.js';

/** The example manifest from the architecture plan. */
const full = () => ({
  $schema: 'https://example.invalid/mooncg.schema.json',
  manifest: 1,
  kind: 'bundle',
  name: 'scoreboard',
  version: '1.2.0',
  title: 'Scoreboard',
  engine: { mooncg: '^1.0.0' },
  dependencies: { 'team-data': '^2.0.0' },
  extension: 'extension/index.js',
  permissions: { view: 'See scoreboard', operate: 'Change scores' },
  defaultRoles: { operator: ['view', 'operate'], viewer: ['view'] },
  panels: [
    {
      id: 'control',
      title: 'Score',
      file: 'dashboard/control.html',
      width: 3,
      workspace: 'Show',
      requires: 'operate',
    },
  ],
  dialogs: [{ id: 'confirm-reset', file: 'dashboard/reset.html', width: 4 }],
  graphics: [
    {
      id: 'overlay',
      file: 'graphics/overlay.html',
      width: 1920,
      height: 1080,
      singleInstance: true,
      requires: 'view',
    },
  ],
  replicants: {
    score: { schema: 'schemas/score.json', persistent: true, read: 'view', write: 'operate' },
  },
  messages: { reset: { send: 'operate' } },
  assets: [{ id: 'logos', title: 'Logos', accept: ['image/*'] }],
  config: { schema: 'config.schema.json' },
  capabilities: ['http.routes', 'net.outbound', 'bundle:team-data:read'],
  dev: { url: 'http://localhost:5173' },
});

const minimal = () => ({ manifest: 1, kind: 'bundle', name: 'tiny', version: '0.1.0' });

function errorsOf(input: unknown) {
  const result = parseManifest(input);
  if (result.ok) throw new Error('Expected the manifest to be rejected');
  return result.errors;
}

function pathsOf(input: unknown) {
  return errorsOf(input).map((error) => error.path);
}

describe('parseManifest', () => {
  it('accepts the full example from the plan', () => {
    const result = parseManifest(full());
    expect(result).toMatchObject({ ok: true, manifest: { name: 'scoreboard', version: '1.2.0' } });
  });

  it('normalizes a minimal manifest with empty collections', () => {
    const result = parseManifest(minimal());
    expect(result).toEqual({
      ok: true,
      manifest: {
        manifest: 1,
        kind: 'bundle',
        name: 'tiny',
        version: '0.1.0',
        dependencies: {},
        permissions: {},
        defaultRoles: {},
        panels: [],
        dialogs: [],
        graphics: [],
        replicants: {},
        messages: {},
        assets: [],
        capabilities: [],
      },
    });
  });

  it('keeps a replicant default value', () => {
    const result = parseManifest({
      ...minimal(),
      replicants: { score: { default: { home: 0, away: 0 } } },
    });
    expect(result).toMatchObject({
      ok: true,
      manifest: { replicants: { score: { default: { home: 0, away: 0 } } } },
    });
  });

  it.each([
    ['null', null],
    ['a string', 'nope'],
    ['an array', []],
    ['undefined', undefined],
  ])('never throws and reports an error for %s', (_label, input) => {
    expect(errorsOf(input).length).toBeGreaterThan(0);
  });

  it('reports every problem with its path', () => {
    const paths = pathsOf({ manifest: 2, kind: 'plugin', name: 'Bad Name', version: '1.0' });
    expect(paths).toEqual(expect.arrayContaining(['manifest', 'kind', 'name', 'version']));
  });

  it.each([['Scoreboard'], ['score_board'], ['-score'], ['score-'], ['score board'], ['']])(
    'rejects the name %j',
    (name) => {
      expect(pathsOf({ ...minimal(), name })).toEqual(['name']);
    },
  );

  it.each([['1.2.0'], ['0.0.1-beta.1'], ['1.0.0+build.5']])('accepts version %s', (version) => {
    expect(parseManifest({ ...minimal(), version }).ok).toBe(true);
  });

  it.each([['1.2'], ['v1.2.0'], ['1.2.0.0'], ['latest']])('rejects version %s', (version) => {
    expect(pathsOf({ ...minimal(), version })).toEqual(['version']);
  });

  it('rejects unknown keys so typos surface', () => {
    const errors = errorsOf({ ...minimal(), panells: [] });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('panells');
  });

  it('rejects duplicate panel, graphic and dialog ids', () => {
    const paths = pathsOf({
      ...minimal(),
      panels: [
        { id: 'a', title: 'A', file: 'dashboard/a.html' },
        { id: 'a', title: 'B', file: 'dashboard/b.html' },
      ],
      graphics: [
        { id: 'g', file: 'graphics/a.html', width: 1920, height: 1080 },
        { id: 'g', file: 'graphics/b.html', width: 1920, height: 1080 },
      ],
      dialogs: [
        { id: 'd', file: 'dashboard/d.html' },
        { id: 'd', file: 'dashboard/e.html' },
      ],
    });
    expect(paths).toEqual(['panels.1.id', 'dialogs.1.id', 'graphics.1.id']);
  });

  it.each([
    ['../outside.html'],
    ['dashboard/../../outside.html'],
    ['/etc/passwd'],
    ['C:/windows/win.ini'],
    ['dashboard\\control.html'],
    ['dashboard//control.html'],
    [''],
  ])('rejects the unsafe file path %j', (file) => {
    expect(pathsOf({ ...minimal(), extension: file })).toEqual(['extension']);
  });

  it('requires panel and dialog files under dashboard/ and graphic files under graphics/', () => {
    const paths = pathsOf({
      ...minimal(),
      panels: [{ id: 'a', title: 'A', file: 'graphics/a.html' }],
      dialogs: [{ id: 'd', file: 'd.html' }],
      graphics: [{ id: 'g', file: 'dashboard/g.html', width: 1920, height: 1080 }],
    });
    expect(paths).toEqual(['panels.0.file', 'dialogs.0.file', 'graphics.0.file']);
  });

  it.each([[0], [-1], [1.5], ['1920']])('rejects graphic width/height %j', (size) => {
    const paths = pathsOf({
      ...minimal(),
      graphics: [{ id: 'g', file: 'graphics/g.html', width: size, height: size }],
    });
    expect(paths).toEqual(['graphics.0.width', 'graphics.0.height']);
  });

  it('rejects references to undeclared permissions', () => {
    const paths = pathsOf({
      ...minimal(),
      permissions: { view: 'See it' },
      defaultRoles: { operator: ['view', 'operate'] },
      panels: [{ id: 'a', title: 'A', file: 'dashboard/a.html', requires: 'operate' }],
      dialogs: [{ id: 'd', file: 'dashboard/d.html', requires: 'operate' }],
      graphics: [
        { id: 'g', file: 'graphics/g.html', width: 1920, height: 1080, requires: 'operate' },
      ],
      replicants: { score: { read: 'view', write: 'operate' }, other: { read: 'nope' } },
      messages: { reset: { send: 'operate', listen: 'view' } },
    });
    expect(paths).toEqual([
      'panels.0.requires',
      'dialogs.0.requires',
      'graphics.0.requires',
      'replicants.score.write',
      'replicants.other.read',
      'messages.reset.send',
      'defaultRoles.operator.1',
    ]);
  });

  it('rejects replicant names containing the namespace separator', () => {
    expect(pathsOf({ ...minimal(), replicants: { 'a:b': {} } })).toEqual(['replicants.a:b']);
  });
});

describe('manifestJsonSchema', () => {
  it('describes the manifest for editor completion', () => {
    const schema = manifestJsonSchema() as {
      type: string;
      required: string[];
      properties: Record<string, { pattern?: string }>;
    };
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(
      expect.arrayContaining(['manifest', 'kind', 'name', 'version']),
    );
    expect(schema.properties.name?.pattern).toBeTypeOf('string');
    expect(schema.properties).toHaveProperty('$schema');
  });
});
