import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api, messageOf } from '../api.js';
import { live } from '../live.js';

/** Where a bundle came from, as the server tells it: without credentials. */
export interface SourceInfo {
  readonly type: 'git' | 'path' | 'zip' | 'upload';
  readonly location: string;
  readonly ref?: string | undefined;
  readonly commit?: string | undefined;
}

/** A bundle that was fetched and waits for a decision, with what it declares. */
export interface StagedInfo {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly title?: string | undefined;
  /** For an update: the installed bundle it is to replace, and the version that is there. */
  readonly target?: string | undefined;
  readonly replaces?: string | undefined;
  readonly source: SourceInfo;
  readonly engine?: string | undefined;
  readonly permissions: readonly { readonly name: string; readonly description: string }[];
  readonly capabilities: readonly string[];
  readonly dependencies: Readonly<Record<string, string>>;
  readonly extension: boolean;
  readonly panels: number;
  readonly dialogs: number;
  readonly graphics: number;
  readonly assets: number;
  readonly config: boolean;
  readonly npm: {
    readonly needed: boolean;
    readonly lockfile: boolean;
    readonly dependencies: readonly string[];
    readonly installed: boolean;
    /** The files in the bundle that steer npm, such as `.npmrc`. */
    readonly config?: readonly string[] | undefined;
    /** What npm would fetch from elsewhere than the registry. */
    readonly unusual?: readonly string[] | undefined;
  };
  /**
   * Whether installing the bundle can run code on the server: not at all, only if install
   * scripts are allowed at commit, or because that was allowed when it was fetched.
   */
  readonly installCode?: 'none' | 'on-request' | 'allowed' | undefined;
  /** The role grants the bundle proposes, and whether installing it makes them. */
  readonly roles?:
    | {
        readonly grants: Readonly<Record<string, readonly string[]>>;
        readonly applies: boolean;
      }
    | undefined;
  readonly files: number;
  readonly bytes: number;
}

/** An installation, update or removal and where it stands. */
export interface JobInfo {
  readonly id: string;
  readonly operation: 'stage' | 'install' | 'update' | 'restore' | 'remove';
  readonly state: 'queued' | 'running' | 'succeeded' | 'failed' | 'rolled-back';
  readonly step?: string | undefined;
  readonly bundle?: string | undefined;
  readonly error?: string | undefined;
  readonly rollbackError?: string | undefined;
}

/** Where a bundle came from, in a few words. */
export function describeSource({ type, location, ref, commit }: SourceInfo): string {
  if (type === 'git') {
    return `${location}${ref ? ` at ${ref}` : ''}${commit ? ` (${commit.slice(0, 7)})` : ''}`;
  }
  if (type === 'path') return `folder ${location}`;
  return type === 'zip' ? `archive ${location}` : `upload ${location}`;
}

/** Whether a job is over, however it ended. */
export const jobOver = (job: JobInfo) => job.state !== 'queued' && job.state !== 'running';

const INSTALLS = '/api/v1/bundles/-';
const part = encodeURIComponent;

/**
 * Installing, updating and removing bundles: what the server says is being done and what
 * was fetched and waits for a decision, and the requests that start each step. Only for
 * those who may manage bundles; nobody else is told any of it.
 */
export const useInstalls = defineStore('installs', () => {
  const jobs = ref<readonly JobInfo[]>([]);
  const staged = ref<readonly StagedInfo[]>([]);
  /** Why the last request was refused; empty when it was not. */
  const problem = ref('');
  /** The job this page started last: how it ends is shown, as no other job's end is. */
  const mine = ref<readonly string[]>([]);
  /** A request is on its way. */
  const sending = ref(false);

  /** Follows the replicant `system:installs`. Returns the function that stops it. */
  function follow(): () => void {
    return live.follow<{ jobs?: readonly JobInfo[]; staged?: readonly StagedInfo[] } | null>(
      'system:installs',
      (value) => {
        jobs.value = value?.jobs ?? [];
        staged.value = value?.staged ?? [];
      },
    );
  }

  /** Sends a request that starts a job, and remembers the job as this page's. */
  async function start(request: () => Promise<{ job: JobInfo }>): Promise<void> {
    problem.value = '';
    sending.value = true;
    try {
      const { job } = await request();
      mine.value = [job.id];
      // Shown at once; the server's own word about it follows.
      if (!jobs.value.some((known) => known.id === job.id)) jobs.value = [job, ...jobs.value];
    } catch (error) {
      problem.value = messageOf(error);
    } finally {
      sending.value = false;
    }
  }

  // Fetching interrupts nothing, so none of these three knows about being on air: the
  // lock is met when what was fetched is put in place, in `commit`.
  const stageGit = (url: string, gitRef: string, target?: string, scripts = false) =>
    start(() =>
      api.request('POST', `${INSTALLS}/stage`, {
        source: {
          type: 'git',
          url: url.trim(),
          ...(gitRef.trim() === '' ? {} : { ref: gitRef.trim() }),
        },
        ...(target === undefined ? {} : { target }),
        // Said only when it was asked for: the bundle may run code while it is installed.
        ...(scripts ? { scripts: true } : {}),
      }),
    );

  const stageUpload = (file: File, target?: string, scripts = false) =>
    start(() =>
      api.upload(
        `${INSTALLS}/stage?filename=${part(file.name)}` +
          (target === undefined ? '' : `&target=${part(target)}`) +
          (scripts ? '&scripts=true' : ''),
        file,
      ),
    );

  /** Fetches the new version of a bundle from where the bundle came from. */
  const refetch = (name: string, scripts = false) =>
    start(() =>
      api.request('POST', `/api/v1/bundles/${part(name)}/update`, {
        ...(scripts ? { scripts: true } : {}),
      }),
    );

  /** `forceOnAir` puts an update in place although the installation is on air. */
  const commit = (id: string, scripts: boolean, forceOnAir = false) =>
    start(() =>
      api.request('POST', `${INSTALLS}/staged/${part(id)}/commit`, {
        scripts,
        ...(forceOnAir ? { forceOnAir: true } : {}),
      }),
    );

  async function discard(id: string): Promise<void> {
    problem.value = '';
    try {
      await api.request('DELETE', `${INSTALLS}/staged/${part(id)}`);
    } catch (error) {
      problem.value = messageOf(error);
    }
  }

  /**
   * `forceOnAir` removes although the installation is on air, and that is all it does. A
   * bundle that others still need is refused by the server either way: the dashboard has
   * no way to remove it from under them.
   */
  const remove = (name: string, forceOnAir = false) =>
    start(() =>
      api.request(
        'POST',
        `/api/v1/bundles/${part(name)}/remove`,
        forceOnAir ? { forceOnAir: true } : {},
      ),
    );

  /** Whether something is being done to the bundle right now. */
  const busy = (name: string) => jobs.value.some((job) => job.bundle === name && !jobOver(job));

  return {
    jobs,
    staged,
    problem,
    mine,
    sending,
    follow,
    stageGit,
    stageUpload,
    refetch,
    commit,
    discard,
    remove,
    busy,
  };
});
