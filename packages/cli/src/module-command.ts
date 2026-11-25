import { UsageError } from './accounts-command.js';
import { type ApiArgs, type ApiDeps, createApiClient, printable } from './api-client.js';

export interface ModuleDeps extends ApiDeps {
  log(line: string): void;
}

/** A module as the server tells it. */
interface Listed {
  readonly name: string;
  readonly version?: string;
  readonly state: 'running' | 'disabled' | 'failed';
  readonly internal: boolean;
  readonly error?: string;
}

const API = '/api/v1/modules';

/**
 * `mooncg module list|enable|disable`: manages the modules of a running server through its
 * API, with a token that holds `system:modules.manage`. Enabling starts the module at once
 * and disabling stops it; the server remembers either. Getting a module onto the machine is
 * not done here: its folder is copied into the modules folder.
 */
export async function moduleCommand(
  action: string | undefined,
  subjects: readonly string[],
  args: ApiArgs,
  deps: ModuleDeps,
): Promise<void> {
  const call = createApiClient(args, deps, 'system:modules.manage');
  /** Everything that came from the server passes here before it is printed. */
  const log = (line: string) => deps.log(printable(line));
  const [name, ...rest] = subjects;

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
