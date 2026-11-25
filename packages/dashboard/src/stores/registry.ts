import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api, messageOf } from '../api.js';
import { live } from '../live.js';

export type Kind = 'bundle' | 'module';

/** How an index stands, as the server tells it: its address without credentials. */
export interface IndexInfo {
  readonly id: string;
  readonly url: string;
  readonly origin: 'config' | 'added' | 'module';
  /** The module that provides it, for `module`. */
  readonly module?: string | undefined;
  readonly status: 'pending' | 'ok' | 'stale' | 'error';
  readonly error?: string | undefined;
  readonly title?: string | undefined;
  readonly entries: number;
  readonly fetchedAt?: string | undefined;
  readonly checkedAt?: string | undefined;
}

export interface CatalogVersionInfo {
  readonly version: string;
  readonly engine?: string | undefined;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly compatible: boolean;
  readonly problem?: string | undefined;
  readonly source: {
    readonly type: 'zip' | 'git';
    readonly location: string;
    readonly ref?: string | undefined;
    readonly commit?: string | undefined;
    readonly sha256?: string | undefined;
  };
}

/** An entry of an index, as the catalog shows it. */
export interface CatalogEntry {
  readonly index: {
    readonly id: string;
    readonly url: string;
    readonly title?: string | undefined;
  };
  readonly kind: Kind;
  readonly name: string;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly author?: string | undefined;
  readonly homepage?: string | undefined;
  readonly license?: string | undefined;
  readonly tags: readonly string[];
  readonly versions: readonly CatalogVersionInfo[];
  readonly installed?: { readonly version: string; readonly fromThisEntry: boolean } | undefined;
  readonly update?: { readonly version: string } | undefined;
}

/** A newer version an index offers for something installed from it. */
export interface UpdateHint {
  readonly kind: Kind;
  readonly name: string;
  readonly installed: string;
  readonly available: string;
  readonly index: { readonly id: string; readonly url: string };
}

/** A job as the installers tell it, as far as the catalog follows it. */
export interface StageJob {
  readonly id: string;
  readonly state: 'queued' | 'running' | 'succeeded' | 'failed' | 'rolled-back';
  readonly error?: string | undefined;
}

const REGISTRY = '/api/v1/registry';

/** The replicants the server keeps the update hints in, one per kind. */
export const UPDATES_REPLICANTS: Readonly<Record<Kind, string>> = {
  bundle: 'system:updates.bundles',
  module: 'system:updates.modules',
};

/**
 * The registry indexes and what they list. For those who may manage bundles or modules; the
 * server tells each only the kinds they manage.
 */
export const useRegistry = defineStore('registry', () => {
  const indexes = ref<readonly IndexInfo[]>([]);
  const canEdit = ref(false);
  const refreshMs = ref<number>();
  const entries = ref<readonly CatalogEntry[]>([]);
  const updates = ref<readonly UpdateHint[]>([]);
  const loaded = ref(false);
  /** Why the last request was refused; empty when it was not. */
  const problem = ref('');
  const sending = ref(false);
  /** The last catalog asked for: an earlier answer that comes later is not used. */
  let asked = 0;
  /** The kinds whose hints arrive live: a slower answer of the REST endpoint keeps them. */
  const liveKinds = new Set<Kind>();

  async function run<T>(work: () => Promise<T>): Promise<T | undefined> {
    problem.value = '';
    sending.value = true;
    try {
      return await work();
    } catch (error) {
      problem.value = messageOf(error);
      return undefined;
    } finally {
      sending.value = false;
    }
  }

  const takeIndexes = (answer: {
    indexes?: IndexInfo[];
    canEdit?: boolean;
    refreshMs?: number;
  }) => {
    indexes.value = answer?.indexes ?? [];
    canEdit.value = answer?.canEdit === true;
    refreshMs.value = answer?.refreshMs;
  };

  const loadIndexes = () =>
    run(async () => takeIndexes(await api.request('GET', `${REGISTRY}/indexes`)));

  /** The entries of one kind, or of every kind one may manage, that match `query`. */
  async function loadCatalog(kind: Kind | undefined, query: string): Promise<void> {
    const mine = ++asked;
    const search = new URLSearchParams();
    if (kind !== undefined) search.set('kind', kind);
    if (query.trim() !== '') search.set('q', query.trim());
    const suffix = search.size === 0 ? '' : `?${search}`;
    await run(async () => {
      const answer = await api.request<{ entries?: CatalogEntry[] }>(
        'GET',
        `${REGISTRY}/catalog${suffix}`,
      );
      if (mine !== asked) return;
      entries.value = answer?.entries ?? [];
      loaded.value = true;
    });
  }

  /** The updates there are; nothing is said when they cannot be read. */
  async function loadUpdates(): Promise<void> {
    try {
      const answer = await api.request<{ updates?: UpdateHint[] }>('GET', `${REGISTRY}/updates`);
      const kept = updates.value.filter((hint) => liveKinds.has(hint.kind));
      const told = (answer?.updates ?? []).filter((hint) => !liveKinds.has(hint.kind));
      updates.value = [...kept, ...told];
    } catch {
      updates.value = updates.value.filter((hint) => liveKinds.has(hint.kind));
    }
  }

  /**
   * Follows the update hints of `kinds` live, as the server works them out again whenever an
   * index was fetched or something was installed, updated or removed. `onNews` is called for
   * every value after the first, which is the state when following began. Returns the
   * function that stops following.
   */
  function followUpdates(kinds: readonly Kind[], onNews?: () => void): () => void {
    const stops = kinds.map((kind) => {
      let first = true;
      const stop = live.follow<{ updates?: UpdateHint[] }>(UPDATES_REPLICANTS[kind], (value) => {
        liveKinds.add(kind);
        const hints = (value?.updates ?? []).filter((hint) => hint.kind === kind);
        updates.value = [...updates.value.filter((hint) => hint.kind !== kind), ...hints];
        if (first) first = false;
        else onNews?.();
      });
      return () => {
        stop();
        liveKinds.delete(kind);
      };
    });
    return () => {
      for (const stop of stops) stop();
    };
  }

  const add = (url: string) =>
    run(async () => {
      await api.request('POST', `${REGISTRY}/indexes`, { url });
      return true;
    });
  const remove = (id: string) =>
    run(async () => {
      await api.request('DELETE', `${REGISTRY}/indexes/${encodeURIComponent(id)}`);
      return true;
    });
  /** Checks the indexes now. Resolves `true` once they were; the server takes it every so often. */
  const refresh = () =>
    run(async () => {
      takeIndexes(await api.request('POST', `${REGISTRY}/refresh`, {}));
      return true;
    });

  /** Starts fetching an entry into staging, as an install or as the update of what is there. */
  const stage = (
    kind: Kind,
    index: string,
    name: string,
    options: { readonly version?: string; readonly update?: boolean } = {},
  ) =>
    run(async () => {
      const answer = await api.request<{ job: StageJob }>('POST', `${REGISTRY}/stage`, {
        kind,
        index,
        name,
        ...(options.version === undefined ? {} : { version: options.version }),
        ...(options.update ? { update: true } : {}),
      });
      return answer.job;
    });

  const updateFor = (kind: Kind, name: string) =>
    updates.value.find((hint) => hint.kind === kind && hint.name === name);

  return {
    indexes,
    canEdit,
    refreshMs,
    entries,
    updates,
    loaded,
    problem,
    sending,
    loadIndexes,
    loadCatalog,
    loadUpdates,
    followUpdates,
    add,
    remove,
    refresh,
    stage,
    updateFor,
  };
});
