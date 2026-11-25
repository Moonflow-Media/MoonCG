import type { RegistryEntry, RegistryVersion } from '@mooncg/core';
import { compare, prerelease, valid } from 'semver';
import { engineProblem } from '../bundles/dependencies.js';
import { withoutCredentials } from '../install/git.js';
import type { CatalogOrigin } from '../install/sources.js';
import type { ListedEntry } from './registry.js';

type Kind = RegistryEntry['kind'];

/** What is installed of each kind, by name: its version and the index entry it came from. */
export type Installed = Readonly<
  Record<
    Kind,
    ReadonlyMap<string, { readonly version: string; readonly catalog?: CatalogOrigin | undefined }>
  >
>;

/** A version of an entry as the catalog tells it. */
export interface CatalogVersion {
  readonly version: string;
  readonly engine?: string | undefined;
  readonly dependencies: Readonly<Record<string, string>>;
  /** Whether this MoonCG can run it, by its `engine.mooncg`. */
  readonly compatible: boolean;
  readonly problem?: string | undefined;
  /** Where it would be fetched from, without credentials. */
  readonly source: {
    readonly type: 'zip' | 'git';
    readonly location: string;
    readonly ref?: string | undefined;
    readonly commit?: string | undefined;
    readonly sha256?: string | undefined;
  };
}

export interface CatalogItem {
  readonly index: ListedEntry['index'];
  readonly kind: Kind;
  readonly name: string;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly author?: string | undefined;
  readonly homepage?: string | undefined;
  readonly license?: string | undefined;
  readonly tags: readonly string[];
  /** Newest first. */
  readonly versions: readonly CatalogVersion[];
  /**
   * What is installed of this name, and whether it was installed from this very entry. Only
   * then does the entry offer it updates.
   */
  readonly installed?: { readonly version: string; readonly fromThisEntry: boolean } | undefined;
  readonly update?: { readonly version: string } | undefined;
}

export interface UpdateHint {
  readonly kind: Kind;
  readonly name: string;
  readonly installed: string;
  readonly available: string;
  readonly index: ListedEntry['index'];
}

/**
 * The versions of an entry newest first, without any that is no semantic version: an index
 * cannot list one, but a version that semver does not read would make the order depend on
 * the order of the list, and could hide an update.
 */
const newestFirst = (versions: readonly RegistryVersion[]): RegistryVersion[] =>
  versions
    .filter((version) => valid(version.version) === version.version)
    .sort((a, b) => compare(b.version, a.version));

/**
 * The version of an entry to install: the one asked for, if this MoonCG can run it, else the
 * newest it can run. A pre-release is only taken when it is asked for by name.
 */
export function chooseVersion(
  entry: RegistryEntry,
  mooncg: string,
  wanted?: string,
): RegistryVersion | undefined {
  const runs = (version: RegistryVersion) =>
    engineProblem(version.engine?.mooncg, mooncg) === undefined;
  if (wanted !== undefined) {
    const found = newestFirst(entry.versions).find((version) => version.version === wanted);
    return found && runs(found) ? found : undefined;
  }
  return newestFirst(entry.versions).find(
    (version) => runs(version) && prerelease(version.version) === null,
  );
}

/**
 * Whether an installed thing came from this entry of this index. Matching is by where it was
 * installed from, never by name alone: an index that lists the name of something installed
 * from elsewhere, or from another index, offers it nothing.
 */
const fromEntry = (catalog: CatalogOrigin | undefined, item: ListedEntry) =>
  catalog !== undefined &&
  catalog.index === item.index.id &&
  catalog.kind === item.entry.kind &&
  catalog.name === item.entry.name;

/** The newest version this MoonCG can run that is newer than `installed`, if there is one. */
function newer(entry: RegistryEntry, installed: string, mooncg: string): string | undefined {
  const best = chooseVersion(entry, mooncg);
  if (!best || !valid(installed) || !valid(best.version)) return undefined;
  return compare(best.version, installed) > 0 ? best.version : undefined;
}

/** The updates the indexes offer for what was installed from them. */
export function updates(
  entries: readonly ListedEntry[],
  installed: Installed,
  mooncg: string,
): UpdateHint[] {
  return entries.flatMap((item) => {
    const { kind, name } = item.entry;
    const here = installed[kind].get(name);
    if (!here || !fromEntry(here.catalog, item)) return [];
    const available = newer(item.entry, here.version, mooncg);
    return available === undefined
      ? []
      : [{ kind, name, installed: here.version, available, index: item.index }];
  });
}

/** The entries of the indexes as the catalog shows them. */
export function catalogItems(
  entries: readonly ListedEntry[],
  installed: Installed,
  mooncg: string,
): CatalogItem[] {
  return entries.map((item) => {
    const { entry, index } = item;
    const here = installed[entry.kind].get(entry.name);
    const mine = here !== undefined && fromEntry(here.catalog, item);
    const available = mine ? newer(entry, here.version, mooncg) : undefined;
    return {
      index,
      kind: entry.kind,
      name: entry.name,
      ...(entry.title === undefined ? {} : { title: entry.title }),
      ...(entry.description === undefined ? {} : { description: entry.description }),
      ...(entry.author === undefined ? {} : { author: entry.author }),
      ...(entry.homepage === undefined ? {} : { homepage: entry.homepage }),
      ...(entry.license === undefined ? {} : { license: entry.license }),
      tags: entry.tags,
      versions: newestFirst(entry.versions).map((version) => {
        const problem = engineProblem(version.engine?.mooncg, mooncg);
        const { source } = version;
        return {
          version: version.version,
          ...(version.engine === undefined ? {} : { engine: version.engine.mooncg }),
          dependencies: version.dependencies,
          compatible: problem === undefined,
          ...(problem === undefined ? {} : { problem }),
          source:
            source.type === 'zip'
              ? { type: 'zip', location: withoutCredentials(source.url), sha256: source.sha256 }
              : {
                  type: 'git',
                  location: withoutCredentials(source.url),
                  ...(source.ref === undefined ? {} : { ref: source.ref }),
                  ...(source.commit === undefined ? {} : { commit: source.commit }),
                },
        };
      }),
      ...(here === undefined ? {} : { installed: { version: here.version, fromThisEntry: mine } }),
      ...(available === undefined ? {} : { update: { version: available } }),
    };
  });
}
