/**
 * What can be done to the files of a bundle: `stage` fetches a bundle and checks it without
 * touching what is installed, `install`, `update` and `restore` put files in place, `remove`
 * takes them away. Each runs as a job that passes through its steps in order.
 */
export type BundleOperation = 'stage' | 'install' | 'update' | 'restore' | 'remove';

/**
 * The life of a job:
 *
 *     queued ─start→ running ─succeed→ succeeded
 *        │              ├────fail────→ failed
 *        └────fail──────┘ └─roll-back→ rolled-back
 *
 * `rolled-back` is a failure that left the installation as it was before the job.
 */
export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'rolled-back';
export type JobEvent = 'start' | 'succeed' | 'fail' | 'roll-back';

const JOB_TRANSITIONS: Readonly<Record<JobState, Partial<Record<JobEvent, JobState>>>> = {
  queued: { start: 'running', fail: 'failed' },
  running: { succeed: 'succeeded', fail: 'failed', 'roll-back': 'rolled-back' },
  succeeded: {},
  failed: {},
  'rolled-back': {},
};

/** The state an event leads a job to, or `undefined` if it makes no sense in that state. */
export function nextJobState(state: JobState, event: JobEvent): JobState | undefined {
  return JOB_TRANSITIONS[state][event];
}

/** Whether a job is over, however it ended. */
export function isJobFinished(state: JobState): boolean {
  return Object.keys(JOB_TRANSITIONS[state]).length === 0;
}

/**
 * The steps of each operation, in the order they run:
 *
 * - `fetch`: bring the source into a staging folder. `validate`: read its manifest.
 * - `dependencies`: install npm packages, still in staging.
 * - `disable`: stop the installed version. `backup`: move it out of the bundles folder.
 * - `place`: move the new version in. `enable`: start it.
 * - `erase`: take the files away. `purge`: delete what the bundle stored, if asked to.
 *
 * Whoever runs an operation names its steps from this table, and `rollback` for the one
 * step that is no part of a plan: bringing the earlier version back.
 */
export const OPERATION_STEPS = {
  stage: ['fetch', 'validate'],
  install: ['dependencies', 'place', 'enable'],
  update: ['dependencies', 'disable', 'backup', 'place', 'enable'],
  restore: ['disable', 'backup', 'place', 'enable'],
  remove: ['disable', 'erase', 'purge'],
} as const satisfies Readonly<Record<BundleOperation, readonly string[]>>;

/** One step of `Operation`. */
export type OperationStep<Operation extends BundleOperation = BundleOperation> =
  (typeof OPERATION_STEPS)[Operation][number];

/** What the rule about removing needs to know of a bundle. */
export interface RemovalCandidate {
  readonly name: string;
  /** Whether the bundle is meant to run: anything but disabled. */
  readonly enabled: boolean;
  /** The names of the bundles it depends on. */
  readonly dependencies: readonly string[];
}

/**
 * The enabled bundles that would lose a bundle they need if `name` were removed, directly or
 * through other enabled bundles, sorted. Removing is refused while there are any, unless it
 * is forced. A disabled bundle blocks nothing, and neither does what only it holds up.
 */
export function removalBlockers(
  name: string,
  bundles: readonly RemovalCandidate[],
  force = false,
): string[] {
  if (force) return [];
  const blocked = new Set<string>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const bundle of bundles) {
      if (!bundle.enabled || bundle.name === name || blocked.has(bundle.name)) continue;
      if (bundle.dependencies.some((needed) => needed === name || blocked.has(needed))) {
        blocked.add(bundle.name);
        grew = true;
      }
    }
  }
  return [...blocked].sort();
}

/** How many earlier versions of a bundle are kept unless configured otherwise. */
export const DEFAULT_BACKUPS_KEPT = 3;

/** A version of a bundle that was moved aside. */
export interface BackupRef {
  /** The name of its folder: the version, a dash and the time, as `backupId` writes it. */
  readonly id: string;
  readonly version: string;
  /** When it was moved aside, in milliseconds since the epoch. */
  readonly time: number;
}

const BACKUP_ID =
  /^([0-9A-Za-z][0-9A-Za-z.+-]*)-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/;

/**
 * The folder name of a backup: `<version>-<UTC time to the millisecond>`. It holds nothing
 * but letters, digits, `.`, `+` and `-`, and the names of one version sort by time.
 */
export function backupId(version: string, time: number): string {
  const stamp = new Date(time).toISOString().replace(/[-:.]/g, '');
  return `${version}-${stamp}`;
}

/** Reads a backup's folder name. `undefined` for anything `backupId` would not have written. */
export function parseBackupId(id: string): BackupRef | undefined {
  const match = BACKUP_ID.exec(id);
  if (!match) return undefined;
  const [, version = '', year, month, day, hour, minute, second, ms] = match;
  if (version.includes('..')) return undefined;
  const time = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}.${ms}Z`);
  // A date that does not exist is either refused or rolled over; neither names this folder.
  return Number.isNaN(time) || backupId(version, time) !== id ? undefined : { id, version, time };
}

/** The ids of the backups to delete so that the `keep` newest stay, oldest first. */
export function backupsToPrune(backups: readonly BackupRef[], keep: number): string[] {
  if (!Number.isInteger(keep) || keep < 0) {
    throw new Error(`The number of backups to keep must be a whole number of 0 or more`);
  }
  const oldestFirst = [...backups].sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  return oldestFirst.slice(0, Math.max(0, oldestFirst.length - keep)).map((backup) => backup.id);
}
