import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { ScryptParams } from '@mooncg/server/accounts';
import { type AccountArgs, tokenCommand, UsageError, userCommand } from './accounts-command.js';
import { bundleCommand } from './bundle-command.js';
import { createBundle, initInstallation, shownPath } from './create-command.js';
import { moduleCommand } from './module-command.js';
import { registryCommand } from './registry-command.js';
import { writeTypes } from './types-command.js';

const USAGE = `Usage: mooncg <command>

  init [folder]
      Create an installation folder: bundles/, modules/, data/ and mooncg.config.json. The folder
      defaults to the current directory. Nothing that exists is overwritten.

  start [server flags]
  dev [server flags]
      Start the server in the current directory. It reads mooncg.config.json there (or the
      file --config names), then the MOONCG_* environment variables, then the flags, such
      as --port, --host, --bundles-dir, --data-dir, --allowed-origin and --watch; the later
      one wins. dev is for writing bundles on your own machine: it watches the bundle
      folders and reloads what changes, honours the dev.url of a manifest, and signs in
      every request from this machine as an administrator without a password. It listens
      on loopback only and refuses any other host. Never use it for a show.

  bundle create <name> [--template html|vue] [--dir <bundles folder>] [--config <file>]
      Create a bundle from a template in the bundles folder: the one --dir names, else the
      one of the configuration file (mooncg.config.json, or the file --config or
      MOONCG_CONFIG names), else ./bundles. Needs no running server.

  types [bundleDir] [--out <file>]
      Generate mooncg-env.d.ts for a bundle from its replicant schemas, so that
      mc.replicant('name') is typed. bundleDir defaults to the current directory.

  user create <name> [--admin] [--role <role>]... [--password <password>]
  user list
  user passwd <name> [--password <password>] [--keep-tokens]
      Manage the users of a data directory. Without --password the password is taken
      from MOONCG_PASSWORD or asked for. passwd ends the user's sessions and revokes
      the user's API tokens, unless --keep-tokens is given.

  token create <name> --user <owner> --grant <permission>... [--expires <date>]
  token list
  token revoke <id>
      Manage API tokens. A token can hold nothing its owner does not hold.

  user and token commands take --data-dir <dir> (default: ./data, or MOONCG_DATA_DIR).
  They work while a server runs on the same directory.

  bundle list
  bundle install <git-url|zip|folder> [--ref <branch|tag|commit>] [--scripts] [--yes]
  bundle install <name> [--version <version>] [--index <id|url>] [--scripts] [--yes]
  bundle outdated
  bundle update <name> [<git-url|zip|folder>] [--ref <ref>] [--scripts] [--yes] [--on-air]
  bundle remove <name> [--force] [--delete-files] [--purge-data] [--yes] [--on-air]
  bundle enable <name>
  bundle disable <name> [--on-air]
  bundle reload <name> [--on-air]
  bundle backups <name>
  bundle restore <name> <backup> [--yes] [--on-air]
      Manage the bundles of a running server through its API. install and update fetch
      the bundle, show what it declares and ask before anything is installed; --yes
      skips the question. update without a source fetches from where the bundle came
      from. A ZIP file is uploaded; a folder is read by the server under the same path.
      --scripts trusts the bundle to run code while it is installed: the install scripts
      of its npm packages, its .npmrc and dependencies fetched from elsewhere than the
      registry. Without it a bundle that needs any of that is refused. remove keeps the
      files as a backup and keeps the bundle's data, unless --delete-files and
      --purge-data say otherwise; --force removes a bundle others still need, and
      overrides nothing else. While the installation is on air, update, remove, disable,
      reload and restore are refused unless --on-air is given, which takes the same
      permission as the change itself. A removal that both stand in the way of takes both.
      A plain name that is no file or folder here is installed from the catalog of the
      registry indexes: the newest version that runs on this MoonCG, or --version. What
      was installed from an index is updated from it; outdated lists what has a newer
      version there.

  module list
  module enable <name>
  module disable <name>
  module install <git-url|zip|folder|name> [--ref <ref>] [--version <version>] [--scripts] [--yes]
  module outdated
  module update <name> [<git-url|zip|folder>] [--ref <ref>] [--scripts] [--yes] [--on-air]
  module remove <name> [--purge-data] [--yes] [--on-air]
      Manage the modules of a running server through its API. A module is code that runs
      inside the server with full access to it, such as a login provider: one in the
      modules folder runs only once it is enabled, which starts it at once and is
      remembered. install and update fetch the module, show what it declares and ask, as
      for a bundle; an installed module is disabled until it is enabled. remove deletes
      its files and keeps its configuration unless --purge-data is given. While the
      installation is on air, updating or removing an enabled module takes --on-air.

  registry list
  registry add <url>
  registry remove <id|url>
  registry refresh
  registry search [<text>] [--kind bundle|module]
  registry info <name>
      The registry indexes of a running server, static JSON files that list bundles and
      modules, and what they list. An index is not checked by MoonCG: add only those whose
      authors you trust. Adding and removing takes system:settings.manage as well.

  bundle, module and registry commands take --url <url> (default: http://127.0.0.1:9090, or
  MOONCG_URL) and an API token, from MOONCG_TOKEN or --token <token>, that holds
  system:bundles.manage for bundles and system:modules.manage for modules. Prefer
  MOONCG_TOKEN: an argument shows in the process list and the shell history. The token is
  not sent over plain http to another machine unless --insecure is given.`;

/** Where the command line reads from and writes its messages to. */
export interface CliIo {
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  log(line: string): void;
  error(line: string): void;
  /** Asks for a secret without showing it. Absent when there is nobody to ask. */
  prompt?(question: string): Promise<string>;
  /** Asks a yes-or-no question. Absent when there is nobody to ask. */
  confirm?(question: string): Promise<boolean>;
  /** For tests: stands in for `fetch`. */
  fetch?: typeof fetch;
  /**
   * Runs the server with these flags and resolves when it has stopped. For tests: stands
   * in for starting a real one.
   */
  serve?(argv: readonly string[]): Promise<void>;
}

export interface CliOptions {
  /** The cost of password hashes. Tests lower it. */
  readonly passwordCost?: ScryptParams;
  /** How often a running job is asked about, in milliseconds. Tests lower it. */
  readonly pollMs?: number;
}

/** Runs the command line and returns the process exit code. */
export async function run(
  argv: readonly string[],
  io: CliIo,
  options: CliOptions = {},
): Promise<number> {
  const usage = () => {
    io.error(USAGE);
    return 1;
  };
  const env = io.env ?? {};
  // The flags of these two are the server's own, which only the server knows how to read.
  if (argv[0] === 'start' || argv[0] === 'dev') {
    // Dev mode exists as this one flag, and nothing but `mooncg dev` adds it.
    const flags = argv[0] === 'dev' ? ['--dev', ...argv.slice(1)] : argv.slice(1);
    try {
      await (io.serve?.(flags) ?? serve(flags, env, io.cwd));
      return 0;
    } catch (error) {
      io.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch {
    return usage();
  }
  const { values, positionals } = parsed;
  const [command, first, second, ...rest] = positionals;
  try {
    if (command === 'init') {
      if (second !== undefined) return usage();
      const dir = resolve(io.cwd, first ?? '.');
      const created = await initInstallation(dir);
      io.log(`Created in ${dir}: ${created.join(', ')}`);
      io.log(
        `Next: "mooncg bundle create <name>" for a first bundle, then "mooncg dev" in ${shownPath(io.cwd, dir)} to work on it, or "mooncg start" to run it.`,
      );
      return 0;
    }
    if (command === 'bundle' && first === 'create') {
      if (second === undefined || rest.length > 0) return usage();
      const { dir, files } = await createBundle({
        name: second,
        bundlesDir: await bundlesDir(values.dir, values.config, env, io.cwd),
        template: values.template,
      });
      io.log(`Created the bundle "${second}" in ${dir}:`);
      for (const file of files) io.log(`  ${file}`);
      io.log('Start "mooncg dev" in the installation folder to work on it.');
      return 0;
    }
    if (command === 'types') {
      if (second !== undefined) return usage();
      const file = await writeTypes({
        bundleDir: resolve(io.cwd, first ?? '.'),
        out: values.out === undefined ? undefined : resolve(io.cwd, values.out),
      });
      io.log(`Wrote ${file}`);
      return 0;
    }
    if (command === 'bundle') {
      await bundleCommand(
        first,
        positionals.slice(2),
        {
          url: values.url ?? env.MOONCG_URL ?? 'http://127.0.0.1:9090',
          token: values.token ?? env.MOONCG_TOKEN,
          yes: values.yes ?? false,
          ref: values.ref,
          scripts: values.scripts ?? false,
          force: values.force ?? false,
          onAir: values['on-air'] ?? false,
          deleteFiles: values['delete-files'] ?? false,
          purgeData: values['purge-data'] ?? false,
          insecure: values.insecure ?? false,
          version: values.version,
          index: values.index,
        },
        {
          cwd: io.cwd,
          log: (line) => io.log(line),
          warn: (line) => io.error(line),
          fetch: io.fetch,
          confirm:
            io.confirm === undefined
              ? undefined
              : (question) => io.confirm?.(question) ?? Promise.resolve(false),
          pollMs: options.pollMs,
        },
      );
      return 0;
    }
    if (command === 'module') {
      await moduleCommand(
        first,
        positionals.slice(2),
        {
          url: values.url ?? env.MOONCG_URL ?? 'http://127.0.0.1:9090',
          token: values.token ?? env.MOONCG_TOKEN,
          insecure: values.insecure ?? false,
          yes: values.yes ?? false,
          ref: values.ref,
          scripts: values.scripts ?? false,
          onAir: values['on-air'] ?? false,
          purgeData: values['purge-data'] ?? false,
          version: values.version,
          index: values.index,
        },
        {
          cwd: io.cwd,
          log: (line) => io.log(line),
          warn: (line) => io.error(line),
          fetch: io.fetch,
          confirm:
            io.confirm === undefined
              ? undefined
              : (question) => io.confirm?.(question) ?? Promise.resolve(false),
          pollMs: options.pollMs,
        },
      );
      return 0;
    }
    if (command === 'registry') {
      await registryCommand(
        first,
        positionals.slice(2),
        {
          url: values.url ?? env.MOONCG_URL ?? 'http://127.0.0.1:9090',
          token: values.token ?? env.MOONCG_TOKEN,
          insecure: values.insecure ?? false,
          kind: values.kind,
        },
        { log: (line) => io.log(line), warn: (line) => io.error(line), fetch: io.fetch },
      );
      return 0;
    }
    if ((command !== 'user' && command !== 'token') || rest.length > 0) return usage();
    const args: AccountArgs = {
      dataDir: resolve(io.cwd, values['data-dir'] ?? env.MOONCG_DATA_DIR ?? 'data'),
      admin: values.admin ?? false,
      roles: values.role ?? [],
      grants: values.grant ?? [],
      user: values.user,
      expires: values.expires,
      keepTokens: values['keep-tokens'] ?? false,
      password: async () =>
        values.password ?? env.MOONCG_PASSWORD ?? (await io.prompt?.('Password: ')),
    };
    const deps = { log: (line: string) => io.log(line), passwordCost: options.passwordCost };
    await (command === 'user' ? userCommand : tokenCommand)(first, second, args, deps);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) return usage();
    io.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

/** Starts the server and resolves when it has stopped. Loaded only when it is needed. */
async function serve(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
): Promise<void> {
  const { runServer } = await import('@mooncg/server');
  const { stopped } = await runServer({ argv, env, cwd });
  await stopped;
}

/**
 * The bundles folder a new bundle goes to: `--dir`, else what the server would use when
 * started in the working directory, which is `./bundles` unless the configuration file or
 * `MOONCG_BUNDLES_DIR` says otherwise. `config` names the configuration file, as `--config`
 * does for the server.
 */
async function bundlesDir(
  given: string | undefined,
  config: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
): Promise<string> {
  if (given !== undefined) return resolve(cwd, given);
  const { loadConfig, readConfigFile } = await import('@mooncg/server');
  const sources = { argv: config === undefined ? [] : ['--config', config], env, cwd };
  return loadConfig({ ...sources, file: await readConfigFile(sources) }).bundlesDir;
}

function parse(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      'data-dir': { type: 'string' },
      admin: { type: 'boolean' },
      role: { type: 'string', multiple: true },
      password: { type: 'string' },
      user: { type: 'string' },
      grant: { type: 'string', multiple: true },
      expires: { type: 'string' },
      'keep-tokens': { type: 'boolean' },
      url: { type: 'string' },
      token: { type: 'string' },
      yes: { type: 'boolean', short: 'y' },
      ref: { type: 'string' },
      scripts: { type: 'boolean' },
      force: { type: 'boolean' },
      'on-air': { type: 'boolean' },
      'delete-files': { type: 'boolean' },
      'purge-data': { type: 'boolean' },
      insecure: { type: 'boolean' },
      template: { type: 'string' },
      dir: { type: 'string' },
      config: { type: 'string' },
      version: { type: 'string' },
      index: { type: 'string' },
      kind: { type: 'string' },
    },
  });
}
