import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Manifest } from '@mooncg/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BundleConfigs,
  mergeSecrets,
  redactConfig,
  secretPaths,
  setSecrets,
} from '../src/config/bundle-config.js';
import { temporaryBundles } from './temp-bundles.js';

const temporary = temporaryBundles();
afterEach(() => temporary.cleanup());

const SCHEMA = {
  type: 'object',
  properties: {
    league: { type: 'string', default: 'First' },
    periods: { type: 'integer', minimum: 1 },
    apiKey: { type: 'string', minLength: 4, 'x-secret': true },
    mail: {
      type: 'object',
      properties: { host: { type: 'string' }, password: { type: 'string', 'x-secret': true } },
    },
  },
  additionalProperties: false,
};

describe('secretPaths', () => {
  it('finds the properties marked as secret, also in nested objects', () => {
    expect(secretPaths(SCHEMA)).toEqual([['apiKey'], ['mail', 'password']]);
  });

  it('takes a property for secret as a whole when a secret hides where no name leads', () => {
    const schema = {
      type: 'object',
      properties: {
        keys: { type: 'array', items: { type: 'string', 'x-secret': true } },
        login: { anyOf: [{ type: 'string', 'x-secret': true }, { type: 'null' }] },
        plain: { type: 'array', items: { type: 'string' } },
      },
    };
    expect(secretPaths(schema)).toEqual([['keys'], ['login']]);
  });

  it('follows a reference to a definition inside the schema', () => {
    const schema = {
      $defs: { key: { type: 'string', 'x-secret': true } },
      type: 'object',
      properties: { apiKey: { $ref: '#/$defs/key' }, self: { $ref: '#' } },
    };
    // `self` repeats the whole configuration, secrets and all, to any depth.
    expect(secretPaths(schema)).toEqual([['apiKey'], ['self']]);
  });

  const KEY = { $defs: { key: { type: 'string', 'x-secret': true } } };

  it.each([
    ['the items of a list', { type: 'array', items: { $ref: '#/$defs/key' } }],
    ['one of several alternatives', { anyOf: [{ $ref: '#/$defs/key' }, { type: 'null' }] }],
    ['a oneOf', { oneOf: [{ type: 'integer' }, { $ref: '#/$defs/key' }] }],
    ['an allOf', { allOf: [{ $ref: '#/$defs/key' }] }],
    [
      'a list of alternatives of lists',
      { type: 'array', items: { anyOf: [{ type: 'array', items: { $ref: '#/$defs/key' } }] } },
    ],
    ['a reference to a reference', { $ref: '#/$defs/alias' }],
  ])('finds a secret behind a reference in %s', (_where, property) => {
    const schema = {
      $defs: { ...KEY.$defs, alias: { type: 'array', items: { $ref: '#/$defs/key' } } },
      type: 'object',
      properties: { plain: { type: 'string' }, hidden: property },
    };
    expect(secretPaths(schema)).toEqual([['hidden']]);
  });

  it('follows references that go in a circle without going round for ever', () => {
    const schema = {
      $defs: {
        node: {
          type: 'object',
          properties: {
            token: { type: 'string', 'x-secret': true },
            next: { $ref: '#/$defs/node' },
          },
        },
        loop: { anyOf: [{ $ref: '#/$defs/loop' }, { type: 'string' }] },
      },
      type: 'object',
      properties: {
        chain: { $ref: '#/$defs/node' },
        harmless: { $ref: '#/$defs/loop' },
        list: { type: 'array', items: { $ref: '#/$defs/node' } },
      },
    };
    // Where the circle closes, everything below is secret: the token can be at any depth.
    expect(secretPaths(schema)).toEqual([['chain', 'token'], ['chain', 'next'], ['list']]);
  });

  it.each([
    ['a name instead of a path', { $ref: '#key' }],
    ['another document', { $ref: 'https://example.com/schema.json#/key' }],
    ['a file', { $ref: 'other.json' }],
    ['a path that leads nowhere', { $ref: '#/$defs/missing' }],
    ['a dynamic reference', { $dynamicRef: '#key' }],
    ['a recursive reference', { $recursiveRef: '#' }],
    ['a reference deep inside', { type: 'array', items: { anyOf: [{ $ref: 'other.json' }] } }],
  ])('refuses a schema with %s, because a secret could hide behind it', (_what, property) => {
    const schema = { ...KEY, type: 'object', properties: { hidden: property } };
    expect(() => secretPaths(schema)).toThrow(/cannot be followed/);
  });

  it('refuses a schema whose secret no property name leads to', () => {
    expect(() =>
      secretPaths({ type: 'object', additionalProperties: { 'x-secret': true } }),
    ).toThrow(/x-secret/);
  });
});

describe('secrets in values', () => {
  const paths = secretPaths(SCHEMA);
  const stored = { league: 'A', apiKey: 'hunter2-key', mail: { host: 'h', password: 'pw-123' } };

  it('takes every secret out of what is shown and says which are set', () => {
    expect(redactConfig(stored, paths)).toEqual({ league: 'A', mail: { host: 'h' } });
    expect(setSecrets(stored, paths)).toEqual(['/apiKey', '/mail/password']);
    expect(setSecrets({ league: 'A' }, paths)).toEqual([]);
  });

  it('keeps a stored secret that a write leaves out', () => {
    expect(mergeSecrets({ league: 'B', mail: { host: 'x' } }, stored, paths)).toEqual({
      league: 'B',
      apiKey: 'hunter2-key',
      mail: { host: 'x', password: 'pw-123' },
    });
    // Also when the object around it is left out.
    expect(mergeSecrets({ league: 'B' }, stored, paths)).toEqual({
      league: 'B',
      apiKey: 'hunter2-key',
      mail: { password: 'pw-123' },
    });
  });

  it('replaces a secret that is given and removes one that is given as null', () => {
    expect(mergeSecrets({ apiKey: 'new-key', mail: { password: null } }, stored, paths)).toEqual({
      apiKey: 'new-key',
      mail: {},
    });
  });
});

async function setup(schema: unknown = SCHEMA, stored?: string) {
  const dir = await temporary.create({ 'board/config.schema.json': JSON.stringify(schema) });
  const dataDir = join(dir, 'data');
  if (stored !== undefined) {
    await mkdir(join(dataDir, 'config'), { recursive: true });
    await writeFile(join(dataDir, 'config', 'board.json'), stored);
  }
  const bundle = {
    name: 'board',
    dir: join(dir, 'board'),
    manifest: { config: { schema: 'config.schema.json' } } as Manifest,
  };
  return {
    configs: new BundleConfigs({ dataDir }),
    bundle,
    file: join(dataDir, 'config', 'board.json'),
  };
}

describe('BundleConfigs', () => {
  it('gives a bundle without a config schema an empty configuration', async () => {
    const { configs, bundle } = await setup();
    expect(await configs.load({ ...bundle, manifest: {} as Manifest })).toEqual({
      ok: true,
      values: {},
    });
  });

  it('loads what is stored, with the defaults of the schema filled in', async () => {
    const { configs, bundle } = await setup(SCHEMA, JSON.stringify({ apiKey: 'hunter2-key' }));
    expect(await configs.load(bundle)).toEqual({
      ok: true,
      values: { league: 'First', apiKey: 'hunter2-key' },
    });
  });

  it('starts from the defaults when nothing is stored', async () => {
    const { configs, bundle } = await setup();
    expect(await configs.load(bundle)).toEqual({ ok: true, values: { league: 'First' } });
  });

  it('says what is wrong with a stored configuration, without a secret in it', async () => {
    const { configs, bundle } = await setup(SCHEMA, JSON.stringify({ apiKey: 'abc', periods: 0 }));
    const loaded = await configs.load(bundle);
    expect(loaded).toEqual({
      ok: false,
      errors: [
        'config: /periods: must be >= 1',
        'config: /apiKey: must NOT have fewer than 4 characters',
      ],
    });
  });

  it('never repeats stored text in the error for a file that is not JSON', async () => {
    const { configs, bundle } = await setup(SCHEMA, '{"apiKey": "hunter2-key"');
    const loaded = await configs.load(bundle);
    expect(loaded.ok).toBe(false);
    expect(JSON.stringify(loaded)).not.toContain('hunter2');
    expect(JSON.stringify(loaded)).toContain('not valid JSON');
  });

  it('refuses a configuration that is no object, and a schema it cannot use', async () => {
    const list = await setup({}, '[1]');
    expect(await list.configs.load(list.bundle)).toEqual({
      ok: false,
      errors: ['config: must be a JSON object'],
    });
    const broken = await setup({ type: 'nonsense' });
    const loaded = await broken.configs.load(broken.bundle);
    expect(loaded.ok).toBe(false);
    expect(loaded.ok ? [] : loaded.errors).toEqual([
      expect.stringContaining('config.schema: "config.schema.json" is not a usable schema'),
    ]);
  });

  it('describes the configuration without its secrets', async () => {
    const { configs, bundle } = await setup(
      SCHEMA,
      JSON.stringify({ league: 'A', apiKey: 'hunter2-key', mail: { password: 'pw-123' } }),
    );
    const described = await configs.describe(bundle);
    expect(described).toEqual({
      schema: SCHEMA,
      values: { league: 'A', mail: {} },
      secretFields: ['/apiKey', '/mail/password'],
      secrets: ['/apiKey', '/mail/password'],
      problems: [],
    });
  });

  it('writes a valid configuration and keeps the secrets a write leaves out', async () => {
    const { configs, bundle, file } = await setup(
      SCHEMA,
      JSON.stringify({ league: 'A', apiKey: 'hunter2-key' }),
    );
    const described = await configs.write(bundle, { league: 'B', periods: 3 });
    expect(described.values).toEqual({ league: 'B', periods: 3 });
    expect(described.secrets).toEqual(['/apiKey']);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      league: 'B',
      periods: 3,
      apiKey: 'hunter2-key',
    });
    // Written through a temporary file that is gone afterwards.
    expect(await readdir(join(file, '..'))).toEqual(['board.json']);
  });

  it('refuses an invalid write, leaves the file alone and names no secret', async () => {
    const before = JSON.stringify({ league: 'A', apiKey: 'hunter2-key' });
    const { configs, bundle, file } = await setup(SCHEMA, before);
    const failure = await configs
      .write(bundle, { periods: 'many', apiKey: 'xy', surprise: 'xy-and-more' })
      .catch((error) => error);
    expect(failure).toMatchObject({ code: 'invalid' });
    expect(failure.message).toContain('/periods: must be integer');
    expect(failure.message).toContain('/apiKey: must NOT have fewer than 4 characters');
    expect(failure.message).not.toContain('xy');
    expect(await readFile(file, 'utf8')).toBe(before);
    await expect(configs.write(bundle, ['no', 'object'])).rejects.toMatchObject({
      code: 'invalid',
    });
  });

  it('keeps a secret behind a reference out of what it describes and out of texts', async () => {
    const schema = {
      $defs: { key: { type: 'string', 'x-secret': true } },
      type: 'object',
      properties: { keys: { type: 'array', items: { $ref: '#/$defs/key' } } },
    };
    const { configs, bundle } = await setup(schema, JSON.stringify({ keys: ['first-secret-key'] }));
    const described = await configs.describe(bundle);
    expect(described.values).toEqual({});
    expect(described.secretFields).toEqual(['/keys']);
    expect(configs.scrub('got first-secret-key')).toBe('got ***');
  });

  it('refuses to load a configuration whose schema has a reference it cannot follow', async () => {
    const { configs, bundle } = await setup(
      { type: 'object', properties: { key: { $ref: 'secrets.json' } } },
      JSON.stringify({ key: 'whatever-it-is' }),
    );
    const loaded = await configs.load(bundle);
    expect(loaded.ok ? [] : loaded.errors).toEqual([
      expect.stringMatching(/config\.schema: .*"secrets\.json" cannot be followed/),
    ]);
  });

  it('leaves a secret too short to tell from ordinary text alone, and says so once', async () => {
    const warnings: string[] = [];
    const { bundle, file } = await setup(SCHEMA, JSON.stringify({ apiKey: 'abcd' }));
    const configs = new BundleConfigs({
      dataDir: join(file, '..', '..'),
      warn: (message) => warnings.push(message),
    });
    await configs.load(bundle);
    await configs.load(bundle);
    expect(configs.scrub('abcd is in abcdefgh')).toBe('abcd is in abcdefgh');
    expect(warnings).toEqual([
      'The secret /apiKey of bundle "board" has fewer than 8 characters and cannot be kept out of logs and errors',
    ]);
    expect(warnings.join()).not.toContain('abcd');
  });

  it('forgets secrets that are no longer stored', async () => {
    const { configs, bundle } = await setup(SCHEMA, JSON.stringify({ apiKey: 'first-key-1' }));
    await configs.load(bundle);
    await configs.write(bundle, { apiKey: 'second-key-2' });
    // The one before is still known: the extension that runs was started with it.
    expect(configs.scrub('first-key-1 second-key-2')).toBe('*** ***');
    await configs.write(bundle, { apiKey: 'third-key-3' });
    expect(configs.scrub('first-key-1 second-key-2 third-key-3')).toBe('first-key-1 *** ***');
    // A bundle that starts holds what is stored, and nothing else.
    await configs.load(bundle);
    expect(configs.scrub('second-key-2 third-key-3')).toBe('second-key-2 ***');
  });

  it('takes every secret it has seen out of a text', async () => {
    const { configs, bundle } = await setup(
      SCHEMA,
      JSON.stringify({ apiKey: 'hunter2-key', mail: { password: 'pw-123456' } }),
    );
    await configs.load(bundle);
    expect(configs.scrub('failed with hunter2-key and pw-123456, twice: pw-123456')).toBe(
      'failed with *** and ***, twice: ***',
    );
    await configs.write(bundle, { apiKey: 'fresh-key' });
    expect(configs.scrub('fresh-key')).toBe('***');
  });
});
