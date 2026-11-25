import { UsageError } from './accounts-command.js';
import { type ApiArgs, type ApiDeps, createApiClient, printable } from './api-client.js';
import {
  type BundleArgs,
  catalogWarning,
  describeSource,
  installFlow,
  outdated,
  type StagedCommon,
} from './bundle-command.js';

export interface ModuleDeps extends ApiDeps {
  readonly cwd: string;
  log(line: string): void;
  /** Asks a yes-or-no question. Absent when there is nobody to ask. */
  readonly confirm?: ((question: string) => Promise<boolean>) | undefined;
  /** How often a running job is asked about, in milliseconds. */
  readonly pollMs?: number | undefined;
}

/** What the module commands were given besides the server and the token. */
export type ModuleArgs = ApiArgs &
  Pick<BundleArgs, 'yes' | 'ref' | 'scripts' | 'onAir' | 'purgeData' | 'version' | 'index'>;

/** A module as the server tells it. */
interface Listed {
  readonly name: string;
  readonly version?: string;
  readonly state: 'running' | 'disabled' | 'failed';
  readonly internal: boolean;
  readonly enabled?: boolean;
  readonly error?: string;
}

/** A fetched module and what it declares, as the server tells it. */
interface StagedModule extends StagedCommon {
  readonly title?: string;
  readonly enabled?: boolean;
  readonly source: Parameters<typeof describeSource>[0];
  readonly engine?: string;
  readonly main: string;
  readonly config: boolean;
  readonly access: string;
  readonly npm: { readonly needed: boolean; readonly dependencies: readonly string[] };
  readonly installCode?: 'none' | 'on-request' | 'allowed';
  readonly files: number;
  readonly bytes: number;
}

const API = '/api/v1/modules';

/** What a fetched module declares, for whoever decides whether it is installed. */
function summary(staged: StagedModule, scripts: boolean): string[] {
  const title = staged.title === undefined ? '' : ` "${staged.title}"`;
  const code =
    staged.installCode === 'allowed' || (staged.installCode === 'on-request' && scripts)
      ? 'YES, as allowed with --scripts: the install scripts of its npm packages'
      : staged.installCode === 'on-request'
        ? 'no; npm fetches its packages from the registry and runs none of their scripts'
        : 'no';
  return [
    `${staged.name} ${staged.version}${title}, from ${describeSource(staged.source)}`,
    ...(staged.target === undefined
      ? []
      : [
          `  updates ${staged.target} ${staged.replaces ?? '(unknown version)'}${
            staged.enabled ? ', which is enabled and is started again' : ''
          }`,
        ]),
    `  WARNING: ${staged.access}`,
    ...catalogWarning(staged.source),
    `  main file: ${staged.main}`,
    `  runs code while it is installed: ${code}`,
    ...(staged.engine === undefined ? [] : [`  needs MoonCG: ${staged.engine}`]),
    `  npm packages: ${staged.npm.dependencies.length === 0 ? 'none' : staged.npm.dependencies.join(', ')}`,
    `  settings: ${staged.config ? 'yes' : 'no'}`,
    `  size: ${staged.files} files, ${staged.bytes} bytes`,
  ];
}

/**
 * `mooncg module list|enable|disable|install|update|remove`: manages the modules of a running
 * server through its API, with a token that holds `system:modules.manage`. Installing goes
 * through the same steps as for a bundle: fetched, shown, asked, then put in place, where
 * it stays disabled until it is enabled.
 */
export async function moduleCommand(
  action: string | undefined,
  subjects: readonly string[],
  args: ModuleArgs,
  deps: ModuleDeps,
): Promise<void> {
  const call = createApiClient(args, deps, 'system:modules.manage');
  /** Everything that came from the server passes here before it is printed. */
  const log = (line: string) => deps.log(printable(line));
  const [name, ...rest] = subjects;
  const flow = installFlow({
    api: API,
    noun: 'module',
    summary: (staged) => summary(staged as StagedModule, args.scripts),
    // Only the update of an enabled module is what the lock stands in the way of.
    locked: async (target) =>
      (await call<{ modules: Listed[] }>('GET', API)).modules.find(
        (module) => module.name === target,
      )?.enabled === true,
    installed: (staged) =>
      `Installed ${staged.name} ${staged.version}. It is disabled: "mooncg module enable ${staged.name}" starts it.`,
    args,
    deps,
    call,
    log,
  });

  if (action === 'list') {
    if (subjects.length > 0) throw new UsageError();
    const { modules } = await call<{ modules: Listed[] }>('GET', API);
    for (const module of modules) {
      const state =
        module.state === 'failed' ? `failed: ${module.error ?? 'no reason given'}` : module.state;
      // A module of the server itself has no version of its own.
      log(
        [module.name, module.internal ? '(built in)' : (module.version ?? '-'), state].join('  '),
      );
    }
    return;
  }
  if (action === 'outdated') {
    if (subjects.length > 0) throw new UsageError();
    return outdated(call, 'module', log);
  }
  if (action === 'install' || action === 'update') {
    const [source] = action === 'install' ? subjects : rest;
    if (name === undefined || (action === 'install' ? subjects.length !== 1 : rest.length > 1)) {
      throw new UsageError();
    }
    await flow.install(source, action === 'update' ? name : undefined);
    return;
  }
  if (action === 'remove') {
    if (name === undefined || rest.length > 0) throw new UsageError();
    if (
      !(await flow.confirmed(
        `Remove module ${name}? Its files are deleted and its configuration is ${args.purgeData ? 'deleted' : 'kept'}. [y/N] `,
      ))
    ) {
      throw new Error('Nothing was changed.');
    }
    const done = await flow.finished(
      await call('POST', `${API}/${encodeURIComponent(name)}/remove`, {
        ...flow.override,
        purgeData: args.purgeData,
      }),
    );
    if (done.state !== 'succeeded') throw flow.failure(done);
    log(`Removed module ${name}`);
    return;
  }
  if ((action !== 'enable' && action !== 'disable') || name === undefined || rest.length > 0) {
    throw new UsageError();
  }
  const { module } = await call<{ module: Listed }>(
    'POST',
    `${API}/${encodeURIComponent(name)}/${action}`,
    {},
  );
  // Enabling answers also for a module that then failed to start: that is the news.
  if (module.state === 'failed') {
    throw new Error(
      printable(`Module "${module.name}" failed: ${module.error ?? 'no reason given'}`),
    );
  }
  log(`Module "${module.name}" is ${module.state}.`);
}
