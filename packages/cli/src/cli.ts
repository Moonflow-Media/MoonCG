import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { ScryptParams } from '@mooncg/server/accounts';
import { type AccountArgs, tokenCommand, UsageError, userCommand } from './accounts-command.js';
import { writeTypes } from './types-command.js';

const USAGE = `Usage: mooncg <command>

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
  They work while a server runs on the same directory.`;

/** Where the command line reads from and writes its messages to. */
export interface CliIo {
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  log(line: string): void;
  error(line: string): void;
  /** Asks for a secret without showing it. Absent when there is nobody to ask. */
  prompt?(question: string): Promise<string>;
}

export interface CliOptions {
  /** The cost of password hashes. Tests lower it. */
  readonly passwordCost?: ScryptParams;
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
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch {
    return usage();
  }
  const { values, positionals } = parsed;
  const [command, first, second, ...rest] = positionals;
  const env = io.env ?? {};
  try {
    if (command === 'types') {
      if (second !== undefined) return usage();
      const file = await writeTypes({
        bundleDir: resolve(io.cwd, first ?? '.'),
        out: values.out === undefined ? undefined : resolve(io.cwd, values.out),
      });
      io.log(`Wrote ${file}`);
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
    },
  });
}
