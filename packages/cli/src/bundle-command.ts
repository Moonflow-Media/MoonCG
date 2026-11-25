import { openAsBlob } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { UsageError } from './accounts-command.js';

/** What the bundle commands were given on the command line. */
export interface BundleArgs {
  /** Where the server listens, such as `http://127.0.0.1:9090`. */
  readonly url: string;
  /** The API token. It goes into the `Authorization` header and nowhere else. */
  readonly token: string | undefined;
  /** Go ahead without asking. */
  readonly yes: boolean;
  /** The branch, tag or commit of a Git source. */
  readonly ref: string | undefined;
  /**
   * Trust the bundle to run code while it is installed: the install scripts of its npm
   * packages, its `.npmrc`, and dependencies fetched from elsewhere than the registry.
   */
  readonly scripts: boolean;
  /** Remove a bundle that enabled bundles still need. */
  readonly force: boolean;
  /** Delete the files of a removed bundle instead of keeping them as a backup. */
  readonly deleteFiles: boolean;
  /** Delete what a removed bundle stored: configuration, assets, replicants, role grants. */
  readonly purgeData: boolean;
  /** Send the token over plain http also to a server on another machine. */
  readonly insecure: boolean;
}

export interface BundleDeps {
  readonly cwd: string;
  log(line: string): void;
  /** Told what the person at the terminal should know but did not ask for. */
  warn?(line: string): void;
  /** For tests: stands in for `fetch`. */
  readonly fetch?: typeof fetch | undefined;
  /** Asks a yes-or-no question. Absent when there is nobody to ask. */
  readonly confirm?: ((question: string) => Promise<boolean>) | undefined;
  /** How often a running job is asked about, in milliseconds. */
  readonly pollMs?: number | undefined;
}

/** A source as the server tells it. */
interface Source {
  readonly type: 'git' | 'path' | 'zip' | 'upload';
  readonly location: string;
  readonly ref?: string;
  readonly commit?: string;
}

/** A fetched bundle and what it declares, as the server tells it. */
interface Staged {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly title?: string;
  readonly target?: string;
  readonly replaces?: string;
  readonly source: Source;
  readonly engine?: string;
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
    readonly config?: readonly string[];
    readonly unusual?: readonly string[];
  };
  readonly installCode?: 'none' | 'on-request' | 'allowed';
  readonly roles?: {
    readonly grants: Readonly<Record<string, readonly string[]>>;
    readonly applies: boolean;
  };
  readonly files: number;
  readonly bytes: number;
}

interface Job {
  readonly id: string;
  readonly state: 'queued' | 'running' | 'succeeded' | 'failed' | 'rolled-back';
  readonly step?: string;
  readonly staged?: Staged;
  readonly error?: string;
  readonly rollbackError?: string;
}

interface Listed {
  readonly name: string;
  readonly state: string;
  readonly version?: string;
  readonly errors?: readonly string[];
  readonly source?: Source;
}

const POLL_MS = 500;
const API = '/api/v1/bundles';
const part = encodeURIComponent;
const counted = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/**
 * What the server said, as it may be printed: on one line and without control characters.
 * A manifest is written by whoever wrote the bundle; an escape sequence in it could redraw
 * the terminal and hide what is being asked.
 */
export function printable(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the point
  return text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ');
}

/** An address as it may be shown: without the user name and password in it. */
function shownUrl(url: URL): string {
  const copy = new URL(url);
  copy.username = '';
  copy.password = '';
  return copy.toString().replace(/\/$/, '');
}

function describeSource({ type, location, ref, commit }: Source): string {
  if (type === 'git') {
    const at = ref === undefined ? '' : ` at ${ref}`;
    return `Git repository ${location}${at}${commit === undefined ? '' : ` (${commit.slice(0, 10)})`}`;
  }
  if (type === 'path') return `folder ${location}`;
  return type === 'zip' ? `archive ${location}` : `uploaded archive ${location}`;
}

/** Whether installing the bundle runs code on the server before the bundle is started. */
function installCode(staged: Staged, scripts: boolean): string {
  const { npm } = staged;
  if (staged.installCode === 'allowed') {
    const why = [
      ...(npm.config ?? []).map((file) => `it brings ${file}`),
      ...(npm.unusual ?? []),
      'install scripts of its npm packages',
    ];
    return `YES, as allowed with --scripts: ${why.join('; ')}`;
  }
  if (staged.installCode === 'on-request' && scripts) {
    return 'YES, as allowed with --scripts: the install scripts of its npm packages';
  }
  return staged.installCode === 'on-request'
    ? 'no; npm fetches its packages from the registry and runs none of their scripts'
    : 'no';
}

/** What a fetched bundle declares, for whoever decides whether it is installed. */
function summary(staged: Staged, scripts: boolean): string[] {
  const { npm, roles } = staged;
  const list = (items: readonly string[]) => (items.length === 0 ? 'none' : items.join(', '));
  const title = staged.title === undefined ? '' : ` "${staged.title}"`;
  const grants = Object.entries(roles?.grants ?? {})
    .filter(([, permissions]) => permissions.length > 0)
    .map(([role, permissions]) => `${role}: ${permissions.join(', ')}`);
  return [
    `${staged.name} ${staged.version}${title}, from ${describeSource(staged.source)}`,
    ...(staged.target === undefined
      ? []
      : [`  updates ${staged.target} ${staged.replaces ?? '(unknown version)'}`]),
    `  server code: ${staged.extension ? 'yes, an extension that runs on the server' : 'no'}`,
    `  runs code while it is installed: ${installCode(staged, scripts)}`,
    `  permissions: ${list(
      staged.permissions.map(({ name, description }) =>
        description === '' ? name : `${name} (${description})`,
      ),
    )}`,
    `  role grants: ${
      grants.length === 0
        ? 'none'
        : `${grants.join('; ')} (${
            roles?.applies
              ? 'granted when it is installed'
              : 'NOT granted: a bundle of this name was installed before, and the roles are as they were left'
          })`
    }`,
    `  capabilities: ${list(staged.capabilities)}`,
    `  needs bundles: ${list(
      Object.entries(staged.dependencies).map(([name, range]) => `${name} ${range}`),
    )}`,
    ...(staged.engine === undefined ? [] : [`  needs MoonCG: ${staged.engine}`]),
    `  npm packages: ${
      npm.dependencies.length === 0
        ? 'none'
        : npm.needed
          ? `${npm.dependencies.join(', ')}; installed with "npm ${npm.lockfile ? 'ci' : 'install'}" before the bundle starts`
          : `${npm.dependencies.join(', ')}; brought along in node_modules`
    }`,
    `  provides: ${counted(staged.panels, 'panel')}, ${counted(staged.dialogs, 'dialog')}, ` +
      `${counted(staged.graphics, 'graphic')}, ${counted(staged.assets, 'asset category', 'asset categories')}` +
      `${staged.config ? ', settings' : ''}`,
    `  size: ${counted(staged.files, 'file')}, ${staged.bytes} bytes`,
  ];
}

/** `mooncg bundle <action>`: manages the bundles of a running server through its API. */
export async function bundleCommand(
  action: string | undefined,
  subjects: readonly string[],
  args: BundleArgs,
  deps: BundleDeps,
): Promise<void> {
  const [first, second, ...rest] = subjects;
  const takes = (least: number, most = least) => {
    if (subjects.length < least || subjects.length > most || rest.length > 0) {
      throw new UsageError();
    }
  };
  const send = deps.fetch ?? fetch;
  /** Everything that came from the server passes here before it is printed. */
  const log = (line: string) => deps.log(printable(line));

  /** Where the server is, checked once, when the first request is about to go there. */
  let checked: { readonly base: string; readonly shown: string } | undefined;
  const server = () => {
    if (checked) return checked;
    const url = URL.canParse(args.url) ? new URL(args.url) : undefined;
    if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
      throw new Error('--url must be the address of the server, such as http://127.0.0.1:9090');
    }
    const shown = shownUrl(url);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const local = host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
    if (url.protocol === 'http:' && !local) {
      if (!args.insecure) {
        throw new Error(
          `${shown} is plain http on another machine: the API token would cross the network unencrypted. ` +
            'Use an https:// address, or pass --insecure if the network is yours.',
        );
      }
      deps.warn?.(`Warning: the API token is sent to ${shown} unencrypted (--insecure).`);
    }
    checked = { base: shown, shown };
    return checked;
  };

  /** Asks the server. Rejects with what it said when it refuses. */
  const call = async <T>(method: string, path: string, body?: unknown | Blob): Promise<T> => {
    if (args.token === undefined || args.token === '') {
      throw new Error(
        'No API token given. Set MOONCG_TOKEN or pass --token; the token must hold system:bundles.manage.',
      );
    }
    const { base, shown } = server();
    const upload = body instanceof Blob;
    let response: Response;
    try {
      response = await send(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${args.token}`,
          ...(body === undefined
            ? {}
            : { 'content-type': upload ? 'application/zip' : 'application/json' }),
        },
        ...(body === undefined ? {} : { body: upload ? body : JSON.stringify(body) }),
      });
    } catch {
      throw new Error(`No MoonCG server answers at ${shown}. Is it running? Check --url.`);
    }
    if (response.status === 204) return undefined as T;
    const answer = (await response.json().catch(() => undefined)) as
      | { error?: { message?: string } }
      | undefined;
    if (response.ok) return answer as T;
    if (response.status === 401) throw new Error('The server did not accept the API token.');
    throw new Error(printable(answer?.error?.message ?? `The server answered ${response.status}`));
  };

  /** Follows a job to its end, naming each step as it begins. */
  const finished = async ({ job }: { job: Job }): Promise<Job> => {
    let current = job;
    let step: string | undefined;
    for (;;) {
      if (current.step !== undefined && current.step !== step) {
        step = current.step;
        log(`  ... ${step}`);
      }
      if (['succeeded', 'failed', 'rolled-back'].includes(current.state)) return current;
      await new Promise((done) => setTimeout(done, deps.pollMs ?? POLL_MS));
      current = (await call<{ job: Job }>('GET', `${API}/-/jobs/${part(current.id)}`)).job;
    }
  };
  const failure = (job: Job) =>
    new Error(
      printable(
        (job.error ?? 'The server gave no reason') +
          (job.rollbackError === undefined
            ? ''
            : `. The earlier version could not be restored either: ${job.rollbackError}`),
      ) +
        // What the server calls allowing install scripts is a flag here.
        (/install scripts allowed/.test(job.error ?? '') && !args.scripts
          ? ' (That is --scripts on this command line.)'
          : ''),
    );

  /** Whether to go ahead: `--yes`, or the answer of whoever sits at the terminal. */
  const confirmed = async (question: string): Promise<boolean> => {
    if (args.yes) return true;
    if (!deps.confirm) {
      throw new Error(
        'Nothing was changed: there is nobody to ask. Run the command again with --yes to go ahead.',
      );
    }
    return deps.confirm(printable(question));
  };

  /** Fetches a bundle into staging: from `text`, or for an update from where it came from. */
  const stage = async (text: string | undefined, target: string | undefined): Promise<Job> => {
    const { scripts } = args;
    if (text === undefined) {
      if (args.ref !== undefined) throw new Error('--ref needs a Git address to go with');
      return finished(await call('POST', `${API}/${part(target ?? '')}/update`, { scripts }));
    }
    const isGit =
      /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(text) ||
      /^[^\\/\s@]+@[^\\/\s:]+:/.test(text) ||
      text.includes('::');
    if (isGit) {
      const source = {
        type: 'git',
        url: text,
        ...(args.ref === undefined ? {} : { ref: args.ref }),
      };
      return finished(await call('POST', `${API}/-/stage`, { source, target, scripts }));
    }
    if (args.ref !== undefined) throw new Error('--ref is for Git addresses only');
    const path = resolve(deps.cwd, text);
    const stats = await stat(path).catch(() => undefined);
    if (!stats) {
      throw new Error(
        `There is no file or folder "${text}". A Git address starts with https:// or ssh://, or looks like user@host:path.`,
      );
    }
    if (stats.isDirectory()) {
      return finished(
        await call('POST', `${API}/-/stage`, { source: { type: 'path', path }, target, scripts }),
      );
    }
    // A file is sent to the server, which may be another machine.
    const query = new URLSearchParams({ filename: basename(path) });
    if (target !== undefined) query.set('target', target);
    if (scripts) query.set('scripts', 'true');
    return finished(await call('PUT', `${API}/-/stage?${query}`, await openAsBlob(path)));
  };

  /** Stages, shows what was fetched, asks, and installs. */
  const install = async (text: string | undefined, target: string | undefined) => {
    log(target === undefined ? 'Fetching the bundle' : `Fetching the new version of ${target}`);
    const fetched = await stage(text, target);
    const { staged } = fetched;
    if (fetched.state !== 'succeeded' || !staged) throw failure(fetched);
    for (const line of summary(staged, args.scripts)) log(line);

    const discard = () => call('DELETE', `${API}/-/staged/${part(staged.id)}`, {}).catch(() => {});
    let go: boolean;
    try {
      go = await confirmed(
        staged.target === undefined
          ? `Install ${staged.name} ${staged.version}? [y/N] `
          : `Update ${staged.target} from ${staged.replaces ?? 'an unknown version'} to ${staged.version}? [y/N] `,
      );
    } catch (error) {
      await discard();
      throw error;
    }
    if (!go) {
      await discard();
      throw new Error('Nothing was changed.');
    }
    const done = await finished(
      await call('POST', `${API}/-/staged/${part(staged.id)}/commit`, { scripts: args.scripts }),
    );
    if (done.state === 'rolled-back') {
      throw new Error(
        printable(
          `The update was rolled back; ${staged.replaces ?? 'the earlier version'} is in place again. ` +
            `The new version failed: ${done.error ?? 'no reason given'}`,
        ),
      );
    }
    if (done.state !== 'succeeded') throw failure(done);
    log(
      staged.target === undefined
        ? `Installed ${staged.name} ${staged.version}`
        : `Updated ${staged.name} to ${staged.version}`,
    );
  };

  switch (action) {
    case 'list': {
      takes(0);
      const { bundles } = await call<{ bundles: Listed[] }>('GET', API);
      const rows = bundles.map((bundle) => ({
        name: printable(bundle.name),
        version: printable(bundle.version ?? '-'),
        state: printable(bundle.state),
        source: bundle.source ? describeSource(bundle.source) : '-',
      }));
      const width = (key: 'name' | 'version' | 'state') =>
        Math.max(0, ...rows.map((row) => row[key].length));
      for (const row of rows) {
        log(
          [
            row.name.padEnd(width('name')),
            row.version.padEnd(width('version')),
            row.state.padEnd(width('state')),
            row.source,
          ].join('  '),
        );
      }
      return;
    }
    case 'install':
      takes(1);
      return install(first, undefined);
    case 'update':
      takes(1, 2);
      return install(second, first);
    case 'remove': {
      takes(1);
      const name = first as string;
      if (!args.yes) {
        // What becomes of the files depends on the server: it may keep no backups at all.
        const { backupsKept } = await call<{ backupsKept?: number }>('GET', API);
        const files = args.deleteFiles
          ? 'deleted'
          : backupsKept === 0
            ? 'deleted (the server keeps no backups)'
            : 'kept as a backup';
        const go = await confirmed(
          `Remove ${name}? Its files are ${files} and its data is ${args.purgeData ? 'deleted' : 'kept'}. [y/N] `,
        );
        if (!go) throw new Error('Nothing was changed.');
      }
      const done = await finished(
        await call('POST', `${API}/${part(name)}/remove`, {
          force: args.force,
          deleteFiles: args.deleteFiles,
          purgeData: args.purgeData,
        }),
      );
      if (done.state !== 'succeeded') throw failure(done);
      log(`Removed ${name}`);
      return;
    }
    case 'enable':
    case 'disable':
    case 'reload': {
      takes(1);
      const { bundle } = await call<{ bundle: Listed }>(
        'POST',
        `${API}/${part(first as string)}/${action}`,
        {},
      );
      if (bundle.state === 'failed') {
        throw new Error(printable(`${bundle.name} failed: ${(bundle.errors ?? []).join('; ')}`));
      }
      log(`${bundle.name} is ${bundle.state}`);
      return;
    }
    case 'backups': {
      takes(1);
      const { backups } = await call<{
        backups: { id: string; version: string; time: string; reason: string }[];
      }>('GET', `${API}/${part(first as string)}/backups`);
      if (backups.length === 0) log(`${first} has no backups`);
      for (const { id, version, time, reason } of backups) {
        log([id, version, time, `moved aside by ${reason}`].join('  '));
      }
      return;
    }
    case 'restore': {
      takes(2);
      const [name, backup] = [first as string, second as string];
      if (!(await confirmed(`Restore ${name} from the backup ${backup}? [y/N] `))) {
        throw new Error('Nothing was changed.');
      }
      const done = await finished(
        await call('POST', `${API}/${part(name)}/backups/${part(backup)}/restore`, {}),
      );
      if (done.state === 'rolled-back') {
        throw new Error(
          printable(
            `The backup does not start, so the version that was installed is in place again: ${done.error ?? ''}`,
          ),
        );
      }
      if (done.state !== 'succeeded') throw failure(done);
      log(`Restored ${name} from ${backup}`);
      return;
    }
    default:
      throw new UsageError();
  }
}
