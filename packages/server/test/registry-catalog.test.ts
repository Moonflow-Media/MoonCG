import type { RegistryEntry } from '@mooncg/core';
import { describe, expect, it } from 'vitest';
import type { CatalogOrigin } from '../src/install/sources.js';
import { catalogItems, chooseVersion, type Installed, updates } from '../src/registry/catalog.js';
import type { ListedEntry } from '../src/registry/registry.js';

const SHA = 'a'.repeat(64);
const version = (number: string, engine?: string) => ({
  version: number,
  dependencies: {},
  ...(engine === undefined ? {} : { engine: { mooncg: engine } }),
  source: { type: 'zip' as const, url: `https://example.org/board-${number}.zip`, sha256: SHA },
});
const entry = (versions: RegistryEntry['versions'], name = 'board'): RegistryEntry => ({
  name,
  kind: 'bundle',
  tags: [],
  versions,
});
const INDEX = { id: 'aaaaaaaaaaaaaaaa', url: 'https://one.example.org/index.json' };
const OTHER = { id: 'bbbbbbbbbbbbbbbb', url: 'https://two.example.org/index.json' };
const listed = (value: RegistryEntry, index = INDEX): ListedEntry => ({ index, entry: value });
const origin = (index = INDEX, name = 'board'): CatalogOrigin => ({
  index: index.id,
  indexUrl: index.url,
  kind: 'bundle',
  name,
  version: '1.0.0',
});
const installed = (version: string, catalog?: CatalogOrigin): Installed => ({
  bundle: new Map([['board', { version, ...(catalog === undefined ? {} : { catalog }) }]]),
  module: new Map(),
});

describe('chooseVersion', () => {
  it('takes the newest version this MoonCG can run', () => {
    const value = entry([
      version('1.0.0'),
      version('1.2.0', '>=0.10.0'),
      version('2.0.0', '>=5.0.0'),
    ]);
    expect(chooseVersion(value, '0.10.0')?.version).toBe('1.2.0');
    expect(chooseVersion(value, '0.10.0', '2.0.0')).toBeUndefined();
    expect(chooseVersion(value, '0.10.0', '1.0.0')?.version).toBe('1.0.0');
  });

  it('does not take a pre-release unless asked for by name', () => {
    const value = entry([version('1.0.0'), version('1.1.0-beta.1')]);
    expect(chooseVersion(value, '0.10.0')?.version).toBe('1.0.0');
    expect(chooseVersion(value, '0.10.0', '1.1.0-beta.1')?.version).toBe('1.1.0-beta.1');
  });
});

describe('versions that are no semantic versions', () => {
  // Not taken by an index any more; a copy of another kind of source must not trip anything.
  const loose = entry([
    version('1.0.0'),
    version('01.0.0'),
    version('1.0.0-01'),
    version('2.0.0'),
    version('latest'),
    version('1.5.0'),
  ]);

  it('are never chosen, and sort the same whatever order they come in', () => {
    expect(chooseVersion(loose, '0.10.0')?.version).toBe('2.0.0');
    expect(chooseVersion(loose, '0.10.0', 'latest')).toBeUndefined();
    const shuffled = entry([...loose.versions].reverse());
    const order = (value: RegistryEntry) =>
      catalogItems([listed(value)], installed('0.1.0'), '0.10.0')[0]?.versions.map(
        (item) => item.version,
      );
    expect(order(loose)).toEqual(['2.0.0', '1.5.0', '1.0.0']);
    expect(order(shuffled)).toEqual(order(loose));
  });

  it('hide no update', () => {
    expect(updates([listed(loose)], installed('1.5.0', origin()), '0.10.0')).toEqual([
      expect.objectContaining({ available: '2.0.0' }),
    ]);
  });
});

describe('updates', () => {
  it('offers a newer compatible version of what was installed from the same index entry', () => {
    const entries = [
      listed(entry([version('1.0.0'), version('1.1.0'), version('1.2.0', '>=9.0.0')])),
    ];
    expect(updates(entries, installed('1.0.0', origin()), '0.10.0')).toEqual([
      expect.objectContaining({
        kind: 'bundle',
        name: 'board',
        installed: '1.0.0',
        available: '1.1.0',
      }),
    ]);
  });

  it('offers nothing for an engine-incompatible newer version', () => {
    const entries = [listed(entry([version('1.0.0'), version('2.0.0', '>=9.0.0')]))];
    expect(updates(entries, installed('1.0.0', origin()), '0.10.0')).toEqual([]);
  });

  it('offers nothing when an index lists a bundle it did not install', () => {
    const entries = [listed(entry([version('9.0.0')])), listed(entry([version('9.0.0')]), OTHER)];
    // Installed from a folder: no index claims it.
    expect(updates(entries, installed('1.0.0'), '0.10.0')).toEqual([]);
    // Installed from the first index: the second, with the same name, claims nothing.
    expect(updates([entries[1] as ListedEntry], installed('1.0.0', origin()), '0.10.0')).toEqual(
      [],
    );
    // Nor does an entry of another name in the same index.
    expect(
      updates([listed(entry([version('9.0.0')], 'other'))], installed('1.0.0', origin()), '0.10.0'),
    ).toEqual([]);
  });
});

describe('catalogItems', () => {
  it('tells versions, compatibility, and what is installed from where', () => {
    const entries = [
      listed({ ...entry([version('1.0.0'), version('2.0.0', '>=9.0.0')]), title: 'Board' }),
      listed(entry([version('3.0.0')]), OTHER),
    ];
    const [mine, theirs] = catalogItems(entries, installed('1.0.0', origin()), '0.10.0');
    expect(mine).toMatchObject({
      name: 'board',
      title: 'Board',
      index: INDEX,
      installed: { version: '1.0.0', fromThisEntry: true },
      versions: [
        { version: '2.0.0', compatible: false, problem: expect.stringMatching(/9\.0\.0/) },
        { version: '1.0.0', compatible: true },
      ],
    });
    expect(mine?.update).toBeUndefined();
    expect(theirs).toMatchObject({ installed: { version: '1.0.0', fromThisEntry: false } });
    expect(theirs?.update).toBeUndefined();
    // The addresses of archives go out without credentials.
    expect(mine?.versions[0]?.source).toEqual({
      type: 'zip',
      location: 'https://example.org/board-2.0.0.zip',
      sha256: SHA,
    });
  });
});
