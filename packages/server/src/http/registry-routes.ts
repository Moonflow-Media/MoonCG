import {
  BUNDLES_MANAGE,
  MODULES_MANAGE,
  MoonCGError,
  type RegistryEntry,
  SETTINGS_MANAGE,
} from '@mooncg/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { compare, valid } from 'semver';
import type { CatalogOrigin, FetchableSource } from '../install/sources.js';
import { catalogItems, chooseVersion, type Installed, updates } from '../registry/catalog.js';
import type { Registry } from '../registry/registry.js';
import type { BundleInstalls, HttpContext, ModuleInstalls } from './app.js';
import { jsonBody } from './auth-routes.js';

/** What the routes of the registry need of the server. */
export interface RegistryHttp {
  readonly registry: Pick<
    Registry,
    'indexes' | 'entries' | 'add' | 'remove' | 'refresh' | 'refreshMs' | 'address'
  >;
  /** What is installed of each kind, with the index entry it came from. */
  installed(): Promise<Installed>;
  readonly mooncgVersion: string;
  /** How long after a check on request the next one is taken. Defaults to 30 s. */
  readonly refreshIntervalMs?: number | undefined;
  readonly now?: (() => number) | undefined;
}

/** How long after a check on request the next one is taken, unless configured otherwise. */
export const MANUAL_REFRESH_INTERVAL_MS = 30_000;

type Kind = RegistryEntry['kind'];
const KINDS: readonly Kind[] = ['bundle', 'module'];
const MANAGE: Readonly<Record<Kind, string>> = { bundle: BUNDLES_MANAGE, module: MODULES_MANAGE };

/** The longest search text that is taken. */
const MAX_QUERY = 200;

/**
 * The catalog and its indexes. Reading the catalog of a kind takes the permission to manage
 * that kind, since all there is to do with it is to install; nobody else is told what the
 * indexes list. Changing which indexes there are takes `system:settings.manage`, as it is
 * configuration of the server, and the permission to manage bundles or modules besides: an
 * index only matters to whoever installs from it. Adding one grants nothing: installing from
 * it still takes the permission of its kind.
 */
export function registerRegistryRoutes(
  app: FastifyInstance,
  context: Pick<HttpContext, 'can' | 'deny' | 'fail' | 'failWith'> & {
    actor(request: FastifyRequest): string;
  },
  http: RegistryHttp,
  installers: {
    readonly bundle?: BundleInstalls | undefined;
    readonly module?: ModuleInstalls | undefined;
  },
): void {
  const { can, deny, fail, failWith, actor } = context;
  const { registry } = http;
  /** The kinds whose catalog the caller may read. */
  const readable = (request: FastifyRequest) => KINDS.filter((kind) => can(request, MANAGE[kind]));
  const anyKind = {
    preHandler: async (request: FastifyRequest, reply: FastifyReply) => {
      if (readable(request).length === 0) return deny(request, reply, BUNDLES_MANAGE);
    },
  };
  const mayEdit = (request: FastifyRequest) =>
    can(request, SETTINGS_MANAGE) && readable(request).length > 0;
  const editing = {
    preHandler: async (request: FastifyRequest, reply: FastifyReply) => {
      if (!can(request, SETTINGS_MANAGE)) return deny(request, reply, SETTINGS_MANAGE);
      if (readable(request).length === 0) return deny(request, reply, BUNDLES_MANAGE);
    },
  };
  // Each tells only how many entries of the kinds the caller may read an index has.
  const indexes = (request: FastifyRequest) => ({
    indexes: registry.indexes(readable(request)),
    canEdit: mayEdit(request),
    refreshMs: registry.refreshMs,
  });

  app.get('/api/v1/registry/indexes', anyKind, async (request) => indexes(request));

  app.post('/api/v1/registry/indexes', editing, async (request, reply) => {
    try {
      const { url } = jsonBody(request);
      if (typeof url !== 'string') throw new MoonCGError('bad_request', '"url" must be an address');
      const index = await registry.add(url, actor(request));
      return reply.code(201).send({ index });
    } catch (error) {
      return failWith(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>(
    '/api/v1/registry/indexes/:id',
    editing,
    async (request, reply) => {
      try {
        await registry.remove(request.params.id, actor(request));
        return reply.code(204).send();
      } catch (error) {
        return failWith(reply, error);
      }
    },
  );

  // Fetches the indexes that are configured, and nothing else: no address comes with it. It
  // is taken at most every `refreshIntervalMs`, for everyone together: each check asks every
  // index server, and they are not to be hammered from here.
  const interval = http.refreshIntervalMs ?? MANUAL_REFRESH_INTERVAL_MS;
  const now = http.now ?? Date.now;
  let lastRefresh = Number.NEGATIVE_INFINITY;
  app.post('/api/v1/registry/refresh', anyKind, async (request, reply) => {
    const wait = lastRefresh + interval - now();
    if (wait > 0) {
      const seconds = Math.ceil(wait / 1000);
      reply.header('retry-after', String(seconds));
      return fail(
        reply,
        429,
        'conflict',
        `The indexes were checked moments ago. Try again in ${seconds} s.`,
      );
    }
    lastRefresh = now();
    await registry.refresh();
    return indexes(request);
  });

  app.get<{ Querystring: { kind?: string; q?: string } }>(
    '/api/v1/registry/catalog',
    anyKind,
    async (request, reply) => {
      const { kind, q } = request.query;
      if (kind !== undefined && !KINDS.includes(kind as Kind)) {
        return fail(reply, 400, 'bad_request', '"kind" must be "bundle" or "module"');
      }
      if (kind !== undefined && !can(request, MANAGE[kind as Kind])) {
        return deny(request, reply, MANAGE[kind as Kind]);
      }
      const kinds = kind === undefined ? readable(request) : [kind as Kind];
      const words = (typeof q === 'string' ? q.slice(0, MAX_QUERY) : '')
        .toLowerCase()
        .split(/\s+/)
        .filter((word) => word !== '');
      const matches = (entry: RegistryEntry) => {
        const text = [entry.name, entry.title, entry.description, entry.author, ...entry.tags]
          .join(' ')
          .toLowerCase();
        return words.every((word) => text.includes(word));
      };
      const listed = registry
        .entries()
        .filter(({ entry }) => kinds.includes(entry.kind) && matches(entry));
      return {
        mooncg: http.mooncgVersion,
        entries: catalogItems(listed, await http.installed(), http.mooncgVersion),
        indexes: registry.indexes(kinds),
      };
    },
  );

  app.get('/api/v1/registry/updates', anyKind, async (request) => {
    const kinds = readable(request);
    const listed = registry.entries().filter(({ entry }) => kinds.includes(entry.kind));
    return { updates: updates(listed, await http.installed(), http.mooncgVersion) };
  });

  // Starts the stage → summary → commit flow of the installer with the source an index entry
  // names. The index is asked here, on an administrator's request, and nowhere else.
  app.post('/api/v1/registry/stage', anyKind, async (request, reply) => {
    try {
      const body = jsonBody(request);
      const kind = body.kind as Kind;
      if (!KINDS.includes(kind)) {
        throw new MoonCGError('bad_request', '"kind" must be "bundle" or "module"');
      }
      if (!can(request, MANAGE[kind])) return deny(request, reply, MANAGE[kind]);
      const installer = installers[kind];
      const { index, name, version } = body;
      if (!installer || typeof index !== 'string' || typeof name !== 'string') {
        if (!installer) return fail(reply, 404, 'not_found', 'Not found');
        throw new MoonCGError('bad_request', '"index" and "name" must name an entry');
      }
      if (version !== undefined && typeof version !== 'string') {
        throw new MoonCGError('bad_request', '"version" must be a version');
      }
      const item = registry
        .entries()
        .find(
          (candidate) =>
            candidate.index.id === index &&
            candidate.entry.kind === kind &&
            candidate.entry.name === name,
        );
      if (!item) throw new MoonCGError('not_found', `The catalog has no ${kind} "${name}" there`);
      const chosen = chooseVersion(item.entry, http.mooncgVersion, version);
      if (!chosen) {
        throw new MoonCGError(
          'conflict',
          version === undefined
            ? `No version of "${name}" in this index runs on MoonCG ${http.mooncgVersion}`
            : `Version ${version} of "${name}" is not in this index or does not run on MoonCG ${http.mooncgVersion}`,
        );
      }
      const update = body.update === true;
      if (update) {
        const here = (await http.installed())[kind].get(name);
        if (!here) throw new MoonCGError('not_found', `There is no ${kind} "${name}"`);
        const origin = here.catalog;
        if (origin?.index !== index || origin.kind !== kind || origin.name !== name) {
          throw new MoonCGError(
            'conflict',
            `"${name}" was not installed from this index entry, so it is not updated from it`,
          );
        }
        // The catalog only goes forward. A version back is a decision of its own: remove the
        // installed one and install that version, which says what is lost on the way.
        if (valid(here.version) !== null && compare(chosen.version, here.version) < 0) {
          throw new MoonCGError(
            'conflict',
            `Version ${chosen.version} of "${name}" is older than the installed ${here.version}; the catalog does not downgrade. Remove it and install that version instead`,
          );
        }
      }
      const { source } = chosen;
      const fetchable: FetchableSource =
        source.type === 'zip'
          ? {
              type: 'url',
              url: source.url,
              sha256: source.sha256,
              // Decides whether this machine may be asked, and gives the credentials of the
              // index to its origin. Not kept with the source.
              index: registry.address(item.index.id),
            }
          : {
              type: 'git',
              url: source.url,
              // Pinned: the ref is fetched, or the commit itself, and must be that commit.
              ref: source.ref ?? source.commit,
              commit: source.commit,
              // Decides whether this machine may be asked. Not kept with the source.
              index: registry.address(item.index.id),
            };
      const catalog: CatalogOrigin = {
        index: item.index.id,
        indexUrl: item.index.url,
        kind,
        name,
        version: chosen.version,
      };
      const job = await installer.stage({
        source: fetchable,
        target: update ? name : undefined,
        // Nothing but a plain `true` trusts it to run code while it is installed.
        scripts: body.scripts === true,
        catalog,
        by: actor(request),
      });
      return reply.code(202).send({ job });
    } catch (error) {
      return failWith(reply, error);
    }
  });
}
