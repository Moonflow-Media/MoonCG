import { describe, expect, it } from 'vitest';
import {
  gitRefProblem,
  isLoopbackRegistryUrl,
  MAX_INDEX_ENTRIES,
  parseRegistryIndex,
  registryIndexJsonSchema,
  registryUrlProblem,
} from '../../src/registry/index-format.js';

const SHA = 'a'.repeat(64);
const COMMIT = 'b'.repeat(40);

const valid = () => ({
  $schema: 'https://example.invalid/mooncg-index.schema.json',
  index: 1,
  title: 'Example index',
  entries: [
    {
      name: 'scoreboard',
      kind: 'bundle',
      title: 'Scoreboard',
      description: 'A score with a panel and a graphic.',
      author: 'MoonCG',
      homepage: 'https://example.org/scoreboard',
      license: 'MIT',
      tags: ['sports', 'score'],
      versions: [
        {
          version: '1.0.0',
          engine: { mooncg: '>=0.10.0' },
          source: { type: 'zip', url: 'scoreboard-1.0.0.zip', sha256: SHA },
        },
        {
          version: '1.1.0',
          engine: { mooncg: '>=0.10.0' },
          dependencies: { 'team-data': '^1.0.0' },
          source: {
            type: 'git',
            url: 'https://example.org/scoreboard.git',
            ref: 'v1.1.0',
            commit: COMMIT,
          },
        },
      ],
    },
    {
      name: 'auth-extra',
      kind: 'module',
      versions: [
        {
          version: '0.1.0',
          source: { type: 'zip', url: 'https://cdn.example.org/auth-extra.zip', sha256: SHA },
        },
      ],
    },
  ],
});

const errorsOf = (input: unknown) => {
  const result = parseRegistryIndex(input);
  return result.ok ? [] : result.errors.map((error) => `${error.path}: ${error.message}`);
};

describe('parseRegistryIndex', () => {
  it('accepts an index of bundles and modules and drops $schema', () => {
    const result = parseRegistryIndex(valid());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.index).not.toHaveProperty('$schema');
    expect(result.index.entries.map((entry) => entry.name)).toEqual(['scoreboard', 'auth-extra']);
    expect(result.index.entries[1]?.tags).toEqual([]);
    expect(result.index.entries[0]?.versions[1]?.dependencies).toEqual({ 'team-data': '^1.0.0' });
  });

  it('refuses another format version and unknown fields', () => {
    expect(errorsOf({ ...valid(), index: 2 }).join()).toMatch(/^index:/);
    expect(errorsOf({ ...valid(), extra: true }).join()).toMatch(/extra/);
  });

  it('refuses names that are no bundle names, and duplicate entries and versions', () => {
    const index = valid();
    (index.entries[0] as { name: string }).name = 'Score Board';
    expect(errorsOf(index).join()).toMatch(/entries\.0\.name/);

    const twice = valid();
    twice.entries.push({ ...(twice.entries[0] as (typeof twice.entries)[0]) });
    expect(errorsOf(twice).join()).toMatch(/twice/);

    const version = valid();
    const versions = version.entries[0]?.versions as unknown[];
    versions.push(versions[0]);
    expect(errorsOf(version).join()).toMatch(/1\.0\.0.*twice/);
  });

  it('refuses control characters and texts that are too long', () => {
    const index = valid();
    (index.entries[0] as { title: string }).title = 'Score\u001b[2Jboard';
    expect(errorsOf(index).join()).toMatch(/control characters/);
    (index.entries[0] as { title: string }).title = 'x'.repeat(201);
    expect(errorsOf(index).join()).toMatch(/at most 200/);
  });

  it('bounds the number of entries, versions and tags', () => {
    const entry = valid().entries[1];
    const many = Array.from({ length: MAX_INDEX_ENTRIES + 1 }, (_, i) => ({
      ...entry,
      name: `m${i}`,
    }));
    expect(errorsOf({ index: 1, entries: many }).join()).toMatch(/entries/);
    const tags = valid();
    (tags.entries[0] as { tags: string[] }).tags = Array.from({ length: 21 }, (_, i) => `t${i}`);
    expect(errorsOf(tags).join()).toMatch(/tags/);
  });

  it('takes https sources only, plain http for this machine alone, and no credentials', () => {
    const source = (url: string) => {
      const index = valid();
      const first = index.entries[1]?.versions[0] as unknown as { source: { url: string } };
      first.source.url = url;
      const result = parseRegistryIndex(index, { loopback: true });
      return result.ok ? '' : result.errors.map((error) => error.message).join();
    };
    expect(source('http://example.org/a.zip')).toMatch(/https/);
    expect(source('http://127.0.0.1:8080/a.zip')).toBe('');
    expect(source('http://localhost/a.zip')).toBe('');
    expect(source('https://user:secret@example.org/a.zip')).toMatch(/credentials/);
    expect(source('ftp://example.org/a.zip')).toMatch(/https/);
    expect(source('../outside.zip')).toMatch(/relative/);
    expect(source('/absolute.zip')).toMatch(/relative/);
  });

  it('needs a SHA-256 for a ZIP and an https Git address with a plain ref or commit', () => {
    const index = valid();
    const zip = index.entries[0]?.versions[0] as { source: { sha256: string } };
    zip.source.sha256 = 'abc';
    expect(errorsOf(index).join()).toMatch(/sha256/);

    const git = valid();
    const second = git.entries[0]?.versions[1] as unknown as { source: Record<string, string> };
    const source = second.source;
    source.url = 'git@example.org:owner/repo.git';
    source.ref = '--upload-pack=evil';
    source.commit = 'xyz';
    const errors = errorsOf(git).join();
    expect(errors).toMatch(/source\.url/);
    expect(errors).toMatch(/source\.ref/);
    expect(errors).toMatch(/source\.commit/);
    expect(errorsOf({ ...valid(), entries: [] })).toEqual([]);
  });

  it('needs semver versions and version ranges that look like ranges', () => {
    const index = valid();
    (index.entries[0]?.versions[0] as { version: string }).version = 'latest';
    expect(errorsOf(index).join()).toMatch(/version/);
  });

  it('refuses what is no JSON or nested too deep, without throwing', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 100; i++) deep = [deep];
    expect(errorsOf({ ...valid(), title: deep }).length).toBeGreaterThan(0);
    expect(errorsOf('text').length).toBeGreaterThan(0);
  });
});

describe('registryUrlProblem', () => {
  it('takes https and plain http on this machine, nothing else', () => {
    expect(registryUrlProblem('https://example.org/index.json')).toBeUndefined();
    expect(registryUrlProblem('https://user:token@example.org/index.json')).toBeUndefined();
    expect(registryUrlProblem('http://[::1]:9000/index.json')).toBeUndefined();
    expect(registryUrlProblem('http://example.org/index.json')).toMatch(/https/);
    expect(registryUrlProblem('file:///etc/passwd')).toMatch(/https/);
    expect(registryUrlProblem('https://exa mple.org/')).toMatch(/space|control/);
    expect(registryUrlProblem(`https://example.org/${'a'.repeat(3000)}`)).toMatch(/long/);
  });
});

describe('registryUrlProblem, as an address is read where it is used', () => {
  it.each([
    // WHATWG URL reads "\" as "/": the host would be 169.254.169.254, not 127.0.0.1.
    'http://169.254.169.254\\@127.0.0.1/latest/meta-data/',
    'http://localhost\\@evil.example/',
    'https://example.org\\@other.example/',
    // URL strips tabs and newlines; they are refused before it does.
    'http://127.0.0.1\t.evil.example/',
    'http://loc\nalhost/',
    // A host that only starts like this machine.
    'http://127.0.0.1.evil.example/',
    'http://localhost.evil.example/',
    // Forms of an address that URL rewrites into another one.
    'http://2130706433/',
    'http://0x7f.0.0.1/',
    'http://0177.0.0.1/',
    'http://127.1/',
    'https://2130706433/',
    'https://0x7f000001/',
    'http://[0:0:0:0:0:0:0:1]/',
    'http://[::ffff:127.0.0.1]/',
    'https://ex%61mple.org/',
    'http://%6c%6fcalhost/',
  ])('refuses %j', (url) => {
    expect(registryUrlProblem(url)).toBeDefined();
  });

  it.each([
    'https://example.org/index.json',
    'HTTPS://EXAMPLE.org/index.json',
    'HTTP://127.0.0.1:8080/index.json',
    'http://LOCALHOST/index.json',
    'http://[::1]:9000/index.json',
    'https://[2001:db8::1]/index.json',
    'https://reader:s3cret@example.org/index.json',
    'https://read%40er:p%2Fss@example.org/index.json',
  ])('takes %j', (url) => {
    expect(registryUrlProblem(url)).toBeUndefined();
  });

  it('refuses credentials that are no valid percent-encoding with a clear message', () => {
    expect(registryUrlProblem('https://user:%zz@example.org/index.json')).toMatch(/credentials/);
    expect(registryUrlProblem('https://%E0%A4%A@example.org/index.json')).toMatch(/credentials/);
  });

  it('refuses credentials when asked to, also percent-encoded ones', () => {
    expect(registryUrlProblem('https://%75ser@example.org/a.zip', { credentials: false })).toMatch(
      /credentials/,
    );
    expect(registryUrlProblem('https://:x@example.org/a.zip', { credentials: false })).toMatch(
      /credentials/,
    );
  });

  it('refuses this machine altogether where it is not allowed', () => {
    const remote = { credentials: false, loopback: false } as const;
    expect(registryUrlProblem('http://127.0.0.1:8080/a.zip', remote)).toMatch(/this machine/);
    expect(registryUrlProblem('https://127.0.0.1/a.zip', remote)).toMatch(/this machine/);
    expect(registryUrlProblem('https://localhost/a.zip', remote)).toMatch(/this machine/);
    expect(registryUrlProblem('https://[::1]/a.zip', remote)).toMatch(/this machine/);
    expect(registryUrlProblem('https://example.org/a.zip', remote)).toBeUndefined();
  });
});

describe('isLoopbackRegistryUrl', () => {
  it('says whether an address names this machine', () => {
    expect(isLoopbackRegistryUrl('http://127.0.0.1:9/index.json')).toBe(true);
    expect(isLoopbackRegistryUrl('http://user:pw@localhost/index.json')).toBe(true);
    expect(isLoopbackRegistryUrl('http://[::1]/index.json')).toBe(true);
    expect(isLoopbackRegistryUrl('https://example.org/index.json')).toBe(false);
    expect(isLoopbackRegistryUrl('http://169.254.169.254\\@127.0.0.1/')).toBe(false);
    expect(isLoopbackRegistryUrl('not an address')).toBe(false);
  });
});

describe('the addresses an index lists', () => {
  const withSource = (url: string, loopback?: boolean) => {
    const index = valid();
    const first = index.entries[1]?.versions[0] as unknown as { source: { url: string } };
    first.source.url = url;
    const result = parseRegistryIndex(index, loopback === undefined ? {} : { loopback });
    return result.ok ? '' : result.errors.map((error) => `${error.path}: ${error.message}`).join();
  };

  it('are https for an index elsewhere: not this machine, not plain http', () => {
    expect(withSource('http://127.0.0.1:8080/a.zip')).toMatch(/entries\.1\.versions\.0/);
    expect(withSource('https://localhost/a.zip')).toMatch(/this machine/);
    expect(withSource('https://cdn.example.org/a.zip')).toBe('');
    expect(withSource('relative/a.zip')).toBe('');
    const homepage = valid();
    (homepage.entries[0] as { homepage: string }).homepage = 'http://localhost/';
    expect(parseRegistryIndex(homepage).ok).toBe(false);
    const git = valid();
    const second = git.entries[0]?.versions[1] as unknown as { source: { url: string } };
    second.source.url = 'https://127.0.0.1/repo.git';
    expect(parseRegistryIndex(git).ok).toBe(false);
  });

  it('may name this machine over plain http only in an index on this machine', () => {
    expect(withSource('http://127.0.0.1:8080/a.zip', true)).toBe('');
    expect(withSource('http://localhost/a.zip', true)).toBe('');
    expect(withSource('http://example.org/a.zip', true)).toMatch(/https/);
  });
});

describe('the versions an index lists', () => {
  const withVersion = (version: string) => {
    const index = valid();
    (index.entries[0]?.versions[0] as { version: string }).version = version;
    return parseRegistryIndex(index).ok;
  };

  it.each([
    '01.0.0',
    '1.01.0',
    '1.0.01',
    '1.0.0-01',
    '1.0.0-alpha.01',
    '1.0.0-',
    '1.0.0-alpha..1',
    '1.0.0+',
    '1.0.0+a..b',
    '99999999999999999.0.0',
    'v1.0.0',
  ])('refuses %j, which is no semantic version', (version) => {
    expect(withVersion(version)).toBe(false);
  });

  it.each([
    '0.0.0',
    '1.2.3',
    '1.0.0-0',
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-0a.1',
    '1.0.0-x-y-z.--',
    '1.0.0+001',
    '1.0.0-rc.1+build.5',
  ])('takes %j', (version) => {
    expect(withVersion(version)).toBe(true);
  });
});

describe('the texts of an index', () => {
  it.each([
    'Score\u202eboard',
    'Score\u200bboard',
    'Score\u2066board',
    'Score\ufeffboard',
    'Score\u2028board',
    'Score\u2029board',
    'Score\u00adboard',
  ])('refuses invisible format characters in %j', (title) => {
    const index = valid();
    (index.entries[0] as { title: string }).title = title;
    expect(errorsOf(index).join()).toMatch(/entries\.0\.title/);
    const tags = valid();
    (tags.entries[0] as { tags: string[] }).tags = [title];
    expect(errorsOf(tags).join()).toMatch(/entries\.0\.tags/);
  });

  it('takes letters of every script and emoji', () => {
    const index = valid();
    (index.entries[0] as { title: string }).title = 'Anzeigetafel für Spielstände — スコア 🏆';
    expect(errorsOf(index)).toEqual([]);
  });
});

describe('Git sources of an index', () => {
  const git = (source: Record<string, unknown>) => {
    const index = valid();
    (index.entries[0]?.versions[1] as unknown as { source: unknown }).source = {
      type: 'git',
      url: 'https://example.org/scoreboard.git',
      ...source,
    };
    return errorsOf(index).join();
  };

  it('must be pinned to a commit; a ref alone or nothing is refused', () => {
    expect(git({ ref: 'v1.1.0' })).toMatch(/commit/);
    expect(git({})).toMatch(/commit/);
    expect(git({ commit: COMMIT })).toBe('');
    expect(git({ ref: 'v1.1.0', commit: COMMIT })).toBe('');
  });

  it('take a ref by the same rule as the installer', () => {
    for (const ref of ['a//b', 'v1/', 'v1.', 'x.lock', 'a..b', '-x', 'a b']) {
      expect(git({ ref, commit: COMMIT }), ref).toMatch(/ref/);
      expect(gitRefProblem(ref), ref).toBeDefined();
    }
    for (const ref of ['main', 'release/1.x', 'v1.1.0', COMMIT]) {
      expect(git({ ref, commit: COMMIT }), ref).toBe('');
      expect(gitRefProblem(ref), ref).toBeUndefined();
    }
    expect(gitRefProblem(undefined)).toBeUndefined();
    expect(gitRefProblem(42)).toBeDefined();
  });
});

describe('registryIndexJsonSchema', () => {
  it('describes the index for editor completion', () => {
    const schema = registryIndexJsonSchema() as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.required).toEqual(expect.arrayContaining(['index', 'entries']));
    expect(schema.properties).toHaveProperty('$schema');
  });
});
