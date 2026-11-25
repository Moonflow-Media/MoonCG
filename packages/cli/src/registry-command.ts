import { UsageError } from './accounts-command.js';
import { type ApiArgs, type ApiDeps, createApiClient, printable } from './api-client.js';

export interface RegistryDeps extends ApiDeps {
  log(line: string): void;
}

/** What the registry commands were given besides the server and the token. */
export interface RegistryArgs extends ApiArgs {
  /** `bundle` or `module`: what `search` is narrowed to. */
  readonly kind?: string | undefined;
}

/** An index as the server tells it: its address without credentials. */
interface IndexLine {
  readonly id: string;
  readonly url: string;
  readonly origin: 'config' | 'added';
  readonly status: string;
  readonly error?: string;
  readonly entries: number;
}

interface EntryLine {
  readonly kind: string;
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly author?: string;
  readonly homepage?: string;
  readonly license?: string;
  readonly tags: readonly string[];
  readonly index: { readonly id: string; readonly url: string };
  readonly versions: readonly {
    readonly version: string;
    readonly compatible: boolean;
    readonly problem?: string;
    readonly source: { readonly type: string; readonly location: string };
  }[];
  readonly installed?: { readonly version: string; readonly fromThisEntry: boolean };
  readonly update?: { readonly version: string };
}

const API = '/api/v1/registry';

/** One line about an index: id, how it stands, address, where it was set, and what it holds. */
function indexLine(index: IndexLine): string {
  const told =
    index.status === 'ok'
      ? `${index.entries} ${index.entries === 1 ? 'entry' : 'entries'}`
      : index.status === 'stale'
        ? `${index.entries} entries from the last good copy; ${index.error ?? ''}`
        : (index.error ?? 'not fetched yet');
  return [index.id, index.status, index.url, index.origin, told].join('  ');
}

/**
 * `mooncg registry list|add|remove|refresh|search|info`: the registry indexes of a running
 * server and what they list. Reading takes a token with `system:bundles.manage` or
 * `system:modules.manage`; adding and removing an index takes `system:settings.manage` too.
 */
export async function registryCommand(
  action: string | undefined,
  subjects: readonly string[],
  args: RegistryArgs,
  deps: RegistryDeps,
): Promise<void> {
  const call = createApiClient(
    args,
    deps,
    'system:bundles.manage or system:modules.manage (and system:settings.manage to change indexes)',
  );
  /** Everything that came from the server passes here before it is printed. */
  const log = (line: string) => deps.log(printable(line));
  const indexes = async () =>
    (await call<{ indexes: IndexLine[] }>('GET', `${API}/indexes`)).indexes;
  const printIndexes = (list: readonly IndexLine[]) => {
    if (list.length === 0) log('No registry index is set up.');
    for (const index of list) log(indexLine(index));
  };
  const [first, ...rest] = subjects;

  switch (action) {
    case 'list':
      if (subjects.length > 0) throw new UsageError();
      return printIndexes(await indexes());
    case 'refresh':
      if (subjects.length > 0) throw new UsageError();
      return printIndexes(
        (await call<{ indexes: IndexLine[] }>('POST', `${API}/refresh`, {})).indexes,
      );
    case 'add': {
      if (first === undefined || rest.length > 0) throw new UsageError();
      const { index } = await call<{ index: IndexLine }>('POST', `${API}/indexes`, { url: first });
      log(
        `Added ${index.url}: ${index.status}, ${indexLine(index).split('  ').slice(4).join('  ')}`,
      );
      return;
    }
    case 'remove': {
      if (first === undefined || rest.length > 0) throw new UsageError();
      const found = (await indexes()).find((index) => index.id === first || index.url === first);
      if (!found) throw new Error(`There is no registry index "${printable(first)}".`);
      await call('DELETE', `${API}/indexes/${encodeURIComponent(found.id)}`, {});
      log(`Removed ${found.url}`);
      return;
    }
    case 'search':
    case 'info': {
      if (action === 'info' && (first === undefined || rest.length > 0)) throw new UsageError();
      const query = new URLSearchParams();
      if (args.kind !== undefined) {
        if (args.kind !== 'bundle' && args.kind !== 'module') throw new UsageError();
        query.set('kind', args.kind);
      }
      const text = subjects.join(' ').trim();
      if (text !== '') query.set('q', text);
      const suffix = query.size === 0 ? '' : `?${query}`;
      const { entries } = await call<{ entries: EntryLine[] }>('GET', `${API}/catalog${suffix}`);
      if (action === 'search') {
        if (entries.length === 0) log('Nothing in the catalog matches.');
        for (const entry of entries) {
          const runs = entry.versions.find((version) => version.compatible)?.version ?? '-';
          const about = [entry.title, entry.description].filter(Boolean).join(': ');
          log([entry.kind, entry.name, runs, about].filter((part) => part !== '').join('  '));
        }
        return;
      }
      const matching = entries.filter((entry) => entry.name === first);
      if (matching.length === 0)
        throw new Error(`The catalog has no entry "${printable(first ?? '')}".`);
      for (const entry of matching) {
        log(`${entry.name} (${entry.kind}) in ${entry.index.url}`);
        if (entry.title) log(`  title: ${entry.title}`);
        if (entry.description) log(`  description: ${entry.description}`);
        if (entry.author) log(`  author: ${entry.author}`);
        if (entry.license) log(`  license: ${entry.license}`);
        if (entry.homepage) log(`  homepage: ${entry.homepage}`);
        if (entry.tags.length > 0) log(`  tags: ${entry.tags.join(', ')}`);
        if (entry.installed) {
          log(
            `  installed: ${entry.installed.version}${
              entry.installed.fromThisEntry
                ? ''
                : ', from elsewhere: this index offers it no updates'
            }${entry.update ? `; update available: ${entry.update.version}` : ''}`,
          );
        }
        log('  versions:');
        for (const version of entry.versions) {
          log(
            `    ${version.version}  ${version.source.type} ${version.source.location}${
              version.compatible ? '' : `  (${version.problem ?? 'does not run on this MoonCG'})`
            }`,
          );
        }
        log('  Entries of an index are not checked by MoonCG.');
      }
      return;
    }
    default:
      throw new UsageError();
  }
}
