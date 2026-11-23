import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { writeTypes } from './types-command.js';

const USAGE = `Usage: mooncg types [bundleDir] [--out <file>]

  types   Generate mooncg-env.d.ts for a bundle from its replicant schemas, so that
          mc.replicant('name') is typed. bundleDir defaults to the current directory.`;

/** Where the command line reads its working directory from and writes its messages to. */
export interface CliIo {
  readonly cwd: string;
  log(line: string): void;
  error(line: string): void;
}

/** Runs the command line and returns the process exit code. */
export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  let parsed: { values: { out?: string }; positionals: string[] };
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: { out: { type: 'string' } },
    });
  } catch {
    io.error(USAGE);
    return 1;
  }
  const [command, bundleDir = '.', ...rest] = parsed.positionals;
  if (command !== 'types' || rest.length > 0) {
    io.error(USAGE);
    return 1;
  }
  try {
    const file = await writeTypes({
      bundleDir: resolve(io.cwd, bundleDir),
      out: parsed.values.out === undefined ? undefined : resolve(io.cwd, parsed.values.out),
    });
    io.log(`Wrote ${file}`);
    return 0;
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
