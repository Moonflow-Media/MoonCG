import type { Accounts, ScryptParams } from '@mooncg/server/accounts';

/** What the account commands were given on the command line. */
export interface AccountArgs {
  readonly dataDir: string;
  readonly admin: boolean;
  readonly roles: readonly string[];
  readonly grants: readonly string[];
  readonly user: string | undefined;
  readonly expires: string | undefined;
  /** `user passwd` leaves the user's API tokens alone. */
  readonly keepTokens: boolean;
  /** Finds the password: from `--password`, the environment, or by asking. */
  readonly password: () => Promise<string | undefined>;
}

export interface AccountDeps {
  readonly log: (line: string) => void;
  /** The cost of password hashes. Tests lower it. */
  readonly passwordCost?: ScryptParams | undefined;
}

/** Thrown for a command line that does not make sense; the caller prints the usage. */
export class UsageError extends Error {}

const date = (time: number | null) => (time === null ? '-' : new Date(time).toISOString());

/** Opens the accounts of the data directory, runs `work` and closes them again. */
async function withAccounts<T>(
  args: AccountArgs,
  deps: AccountDeps,
  work: (accounts: Accounts) => T | Promise<T>,
): Promise<T> {
  // Loaded here, so `mooncg types` does not pay for loading the server.
  const { openAccounts } = await import('@mooncg/server/accounts');
  const accounts = await openAccounts(
    args.dataDir,
    deps.passwordCost === undefined ? {} : { passwordCost: deps.passwordCost },
  );
  try {
    return await work(accounts);
  } finally {
    await accounts.close();
  }
}

async function requirePassword(args: AccountArgs): Promise<string> {
  const password = await args.password();
  if (password === undefined) {
    throw new Error(
      'No password given. Pass --password, set MOONCG_PASSWORD, or run in a terminal.',
    );
  }
  return password;
}

/** `mooncg user create|list|passwd`. */
export async function userCommand(
  action: string | undefined,
  name: string | undefined,
  args: AccountArgs,
  deps: AccountDeps,
): Promise<void> {
  if (action === 'list' && name === undefined) {
    return withAccounts(args, deps, ({ auth }) => {
      for (const user of auth.listUsers()) {
        const roles = user.roles.join(',') || '-';
        const notes = [
          ...(user.disabled ? ['disabled'] : []),
          // The user "mooncg dev" acts as. It is nobody when the server runs without it.
          ...(user.devMode ? ['dev mode only (cannot sign in; inert outside "mooncg dev")'] : []),
        ];
        deps.log([user.name, roles, ...notes].join('  '));
      }
    });
  }
  if ((action !== 'create' && action !== 'passwd') || name === undefined) throw new UsageError();
  return withAccounts(args, deps, async ({ auth }) => {
    if (action === 'create') {
      const roles = [...new Set([...(args.admin ? ['admin'] : []), ...args.roles])];
      // Checked before the password is asked for, so a typo does not cost typing it.
      if (auth.findUser(name)) throw new Error(`The name "${name}" is taken`);
      const user = await auth.createUser({ name, password: await requirePassword(args), roles });
      deps.log(`Created user "${user.name}" (${user.roles.join(', ') || 'no role'})`);
      return;
    }
    const user = auth.findUser(name);
    if (!user) throw new Error(`There is no user "${name}"`);
    await auth.setPassword(user.id, await requirePassword(args), {
      revokeTokens: !args.keepTokens,
    });
    deps.log(
      `Changed the password of "${user.name}". Every session of this user has ended` +
        (args.keepTokens ? '; the API tokens were kept.' : ' and the API tokens were revoked.'),
    );
  });
}

/** `mooncg token create|list|revoke`. */
export async function tokenCommand(
  action: string | undefined,
  subject: string | undefined,
  args: AccountArgs,
  deps: AccountDeps,
): Promise<void> {
  if (action === 'list' && subject === undefined) {
    return withAccounts(args, deps, ({ auth }) => {
      const names = new Map(auth.listUsers().map((user) => [user.id, user.name]));
      for (const token of auth.listTokens()) {
        deps.log(
          [
            token.id,
            token.name,
            `by ${names.get(token.createdBy) ?? token.createdBy}`,
            token.grants.join(','),
            `expires ${date(token.expires)}`,
            `last used ${date(token.lastUsed)}`,
          ].join('  '),
        );
      }
    });
  }
  if ((action !== 'create' && action !== 'revoke') || subject === undefined) throw new UsageError();
  return withAccounts(args, deps, ({ auth }) => {
    if (action === 'revoke') {
      auth.revokeToken(subject);
      deps.log(`Revoked token ${subject}`);
      return;
    }
    // A token belongs to a user and can hold nothing that user does not hold.
    if (args.user === undefined) throw new Error('Say whose token this is with --user <name>');
    const creator = auth.findUser(args.user);
    if (!creator) throw new Error(`There is no user "${args.user}"`);
    let expires: number | undefined;
    if (args.expires !== undefined) {
      expires = Date.parse(args.expires);
      if (Number.isNaN(expires)) {
        throw new Error(`"${args.expires}" is not a date. Use something like 2030-01-31`);
      }
    }
    const { token, secret } = auth.createToken(
      { id: `user:${creator.id}`, kind: 'user', roles: creator.roles },
      { name: subject, grants: args.grants, ...(expires === undefined ? {} : { expires }) },
    );
    deps.log(`Created token ${token.id} "${token.name}" (${token.grants.join(', ')})`);
    deps.log('This is the only time its secret is shown:');
    deps.log(secret);
  });
}
