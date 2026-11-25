import { randomBytes, randomUUID } from 'node:crypto';
import {
  ANONYMOUS_PRINCIPAL,
  authorize,
  BUNDLE_NAME_PATTERN,
  effectiveGrants,
  isGrantPattern,
  type Json,
  jsonProblem,
  MoonCGError,
  type Policy,
  type Principal,
  type PrincipalKind,
} from '@mooncg/core';
import type { AuthStore, RoleRecord, TokenRecord, UserRecord } from '../storage/auth-store.js';
import { createLimiter, LimiterFull } from './limiter.js';
import {
  DEFAULT_SCRYPT,
  hashPassword,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  type ScryptParams,
  verifyPassword,
} from './password.js';
import { hashSecret, randomSecret, sameSecret, TOKEN_PREFIX } from './secrets.js';
import { LoginThrottle } from './throttle.js';

export { TOKEN_PREFIX };

/** A user's session ends when it was not used for this long (7 days) ... */
export const SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
/** ... and at the latest this long after signing in (30 days), however much it was used. */
export const SESSION_MAX_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * A browser session a token was exchanged for ends this long after the exchange (90 days), or
 * when the token expires if that is sooner. The URL with the token then issues a new one.
 */
export const TOKEN_SESSION_MAX_MS = 90 * 24 * 60 * 60 * 1000;
/** `last_seen` and `last_used` are written at most this often, to keep reads from writing. */
const TOUCH_INTERVAL_MS = 60 * 1000;
/** How many browser sessions one token keeps. An OBS source reloaded more often replaces old ones. */
const MAX_TOKEN_SESSIONS = 20;
/**
 * How many passwords are hashed at the same time: the size of Node's default thread pool,
 * which file access shares. More would only wait there and hold memory meanwhile.
 */
export const MAX_VERIFICATIONS = 4;
/** How many password checks may wait for a place. Beyond that a login is told to come back. */
const MAX_WAITING_VERIFICATIONS = 32;

const MINUTE = 60 * 1000;
/**
 * Guessing is limited three ways.
 *
 * - One user name from one address: 5 attempts, then blocked for 5 s, doubling up to 15 min.
 *   This is what stops someone guessing a password.
 * - One address, whatever the names: 20 attempts, then the same. Several people may sit
 *   behind one address, so it gets more.
 * - One user name from all addresses together: 100 attempts, then blocked for 30 s, at most
 *   60 s. This is only a circuit breaker against guessing from many addresses at once. It is
 *   deliberately loose and short: whoever knows a name must not be able to lock its owner
 *   out with a trickle of wrong passwords from elsewhere.
 */
const PAIR_LIMIT = { free: 5, baseMs: 5000, maxMs: 15 * MINUTE };
const ADDRESS_LIMIT = { free: 20, baseMs: 5000, maxMs: 15 * MINUTE };
const NAME_LIMIT = { free: 100, baseMs: 30_000, maxMs: MINUTE };

const ADMIN_ROLE = 'admin';
/** The names dev mode gives its user: the first that no real person has. */
const DEV_USER_NAMES = ['dev', 'dev-mode', 'mooncg-dev'];
const LOCAL = 'local';
const USER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** The id of a way to sign in: part of an address and of every stored link. */
const PROVIDER_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_PROVIDER_ID_LENGTH = 64;
const MAX_SUBJECT_LENGTH = 255;
const MAX_REALM_LENGTH = 255;
/**
 * How many users signing up with an external account creates, at most, within a time: 20 an
 * hour, for all providers together. Whoever comes after that is refused like an account
 * nobody linked, until the hour has passed. Counted in memory: a restart begins anew.
 */
export const SIGNUP_LIMIT = { max: 20, windowMs: 60 * MINUTE };
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** Whether a text can be the id of an external provider. `local` is the one of passwords. */
export function isExternalProviderId(id: unknown): id is string {
  return (
    typeof id === 'string' &&
    id.length <= MAX_PROVIDER_ID_LENGTH &&
    PROVIDER_ID.test(id) &&
    id !== LOCAL
  );
}
const ROLE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PREF_KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** Whether a text can be the key of a preference. */
export const isPrefKey = (key: unknown): key is string =>
  typeof key === 'string' && PREF_KEY.test(key);
/** How many preferences one user can keep. Each is at most one request body in size. */
export const MAX_PREFS = 50;

/**
 * Whether a login is worth looking at: the name could be a user name and the password is not
 * longer than any password can be. Anything else is answered like a wrong password without
 * being looked up, kept or hashed.
 */
export function usableLogin(name: unknown, password: unknown): boolean {
  return (
    typeof name === 'string' &&
    USER_NAME.test(name) &&
    typeof password === 'string' &&
    password.length <= MAX_PASSWORD_LENGTH
  );
}

/** Raised when something is tried too often. Answered with 429 and `Retry-After`. */
export class ThrottledError extends MoonCGError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super('unavailable', 'Too many failed attempts. Try again later.');
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** A user as the API shows it. There is no field a password or its hash could be in. */
export interface UserInfo {
  readonly id: string;
  readonly name: string;
  readonly disabled: boolean;
  readonly roles: readonly string[];
  /**
   * `true` for the user dev mode created to act as. It is nobody outside dev mode and
   * cannot be changed, only deleted. Left out for everyone else.
   */
  readonly devMode?: true;
}

/** What a request brought along to say who it is. */
export interface Credentials {
  /** The value of the session cookie. */
  readonly session?: string | undefined;
  /** The value of the cookie a token was exchanged for. */
  readonly tokenSession?: string | undefined;
  /** The token of an `Authorization: Bearer` header. */
  readonly bearer?: string | undefined;
  /** The request cannot be trusted at all, such as one with two session cookies. */
  readonly invalid?: boolean | undefined;
}

/** Who a request acts as, how that was established, and the policy to check it against. */
export interface Identity {
  readonly principal: Principal;
  readonly policy: Policy;
  /**
   * `session` and `token-session` come from a cookie, which a browser sends by itself, so
   * state-changing requests authenticated that way need protection against forgery. `dev`
   * is the sign-in of dev mode, which a request gets for coming from this machine: it needs
   * that protection all the more.
   */
  readonly via: 'session' | 'token-session' | 'bearer' | 'dev' | 'none';
}

/** Who an external account is, as its provider told it. */
export interface ExternalAccount {
  readonly subject: string;
  /** A name for a new user. Never used to find one. */
  readonly name?: string | undefined;
  /**
   * Who vouches for the account, such as the issuer of an OpenID Connect provider. A link is
   * made for one realm and signs in for that one only.
   */
  readonly realm?: string | undefined;
}

export type ExternalLoginResult =
  | {
      readonly ok: true;
      readonly user: UserInfo;
      readonly session: string;
      /** Whether this sign-in created the user. */
      readonly created: boolean;
    }
  | {
      readonly ok: false;
      /**
       * `not_linked`: no user has this account, and signing up is off. `disabled`: the user
       * it belongs to may not sign in. `setup`: the installation has no user yet.
       */
      readonly reason: 'not_linked' | 'disabled' | 'setup';
      /** With `not_linked`: signing up is on, and as many users as it may create were created. */
      readonly signupLimited?: true;
    }
  | {
      readonly ok: false;
      /**
       * The account is linked, but for another realm than the provider reports now: the id
       * of the provider stands for another issuer than when the link was made, where the
       * same subject is somebody else.
       */
      readonly reason: 'realm';
      /** The realm the link was made for. */
      readonly linkedRealm: string;
    };

/** An external account a user can sign in with. */
export interface LinkedIdentity {
  readonly userId: string;
  readonly provider: string;
  readonly subject: string;
  /** The realm the link is bound to. Left out while it is bound to none. */
  readonly realm?: string;
}

export type LoginResult =
  | { readonly ok: true; readonly user: UserInfo; readonly session: string }
  | { readonly ok: false; readonly reason: 'credentials' }
  | { readonly ok: false; readonly reason: 'throttled'; readonly retryAfterSeconds: number };

export interface PrincipalInfo {
  readonly id: string;
  readonly kind: PrincipalKind;
  readonly name: string | null;
  readonly roles: readonly string[];
  /** The grants the principal effectively holds; for a token, its own. */
  readonly permissions: readonly string[];
}

/** What someone is about to give, take or touch. See `Auth.authorizeChange`. */
export interface AccessChange {
  /** Roles to assign, unassign, create with these names, or delete. */
  readonly roles?: readonly string[];
  /** Grants to add to or remove from a role. */
  readonly grants?: readonly string[];
  /** Ids of users to rename, disable, delete or give a new password. */
  readonly users?: readonly string[];
}

export interface AuthOptions {
  readonly store: AuthStore;
  readonly now?: () => number;
  /** The cost of new password hashes. Tests lower it. */
  readonly scrypt?: ScryptParams;
  /**
   * Whether the server these accounts belong to runs in dev mode. Only then does the user
   * dev mode created act at all: outside it, that user cannot be identified as, its sessions
   * and tokens are not accepted, and no token can be created for it. The command line tool
   * never sets this.
   */
  readonly devMode?: boolean;
  /** How many users signing up may create within a time. Without it, `SIGNUP_LIMIT`. */
  readonly signupLimit?: { readonly max: number; readonly windowMs: number } | undefined;
}

export interface Auth {
  identify(credentials: Credentials): Identity;
  /**
   * Makes sure the user dev mode acts as exists, is enabled and is an administrator, and
   * returns it. It is a user of its own, marked as created by dev mode, and never a real
   * person: it is called `dev`, or by another name if a real user has that one. It has no
   * password. Throws outside dev mode.
   */
  ensureDevUser(): UserInfo;
  /**
   * Who dev mode acts as right now, without any credentials: the user `ensureDevUser`
   * made, or anonymous if that is gone, or outside dev mode. Nothing a request says ever
   * reaches this.
   */
  devIdentity(): Identity;
  /**
   * For a start outside dev mode: deletes the sessions and API tokens of the users dev mode
   * created, and returns those users. They stay, inert, until someone deletes them.
   */
  lockDevUsers(): UserInfo[];
  /** Whether the principal with that id holds the permission right now. */
  check(principalId: string, permission: string): boolean;
  policy(): Policy;
  describe(identity: Pick<Identity, 'principal' | 'policy'>): PrincipalInfo;
  /**
   * Throws `forbidden` unless the actor holds everything the change involves: every grant
   * named, every grant of every role named, and everything every user named holds. Nobody can
   * hand out, take away or take over more than they hold themselves. What does not exist is
   * ignored; the operation itself reports that.
   */
  authorizeChange(actor: Principal, change: AccessChange): void;

  login(name: string, password: string, address: string): Promise<LoginResult>;
  logout(session: string): void;
  /**
   * Signs in whoever a provider has identified. An account belongs to a user only through
   * a link: by its subject at that provider, never by a name or an address. An account
   * without a link is refused, or with `signup` gets a new user that holds no role. The
   * session is the same kind a password opens. Nothing signs in or up while the installation
   * has no user: that is what the setup is for. A link is bound to the realm the provider
   * reports: one without a realm takes that of the first sign-in, and from then on the
   * account is refused (`realm`) when the provider reports another or none. Signing up
   * creates a bounded number of users per hour. Throws `bad_request` for a provider, a
   * subject or a realm that cannot be one.
   */
  externalLogin(
    provider: string,
    account: ExternalAccount,
    options?: { readonly signup?: boolean },
  ): ExternalLoginResult;
  /** Every link of a user to an external account. */
  listIdentities(): LinkedIdentity[];
  /**
   * Lets a user sign in with an external account. An account that another user has is not
   * moved (`conflict`), and the user of dev mode cannot be linked. With a `realm` the link
   * is bound to it; without one it is bound by the first sign-in. Linking an account the
   * user has already replaces the realm of the link.
   */
  linkIdentity(userId: string, provider: string, subject: string, realm?: string): void;
  /** Takes a link away again and ends the sessions of the user. */
  unlinkIdentity(userId: string, provider: string, subject: string): void;
  /**
   * Resolves with a fresh session; all earlier ones of the user are gone. The user's tokens
   * stay unless `revokeTokens` is set. Rejects with `ThrottledError` after too many wrong
   * current passwords.
   */
  changeOwnPassword(
    userId: string,
    current: string,
    next: string,
    options?: { readonly revokeTokens?: boolean },
  ): Promise<string>;

  listUsers(): UserInfo[];
  findUser(name: string): UserInfo | undefined;
  createUser(input: {
    readonly name: string;
    readonly password: string;
    readonly roles?: readonly string[];
  }): Promise<UserInfo>;
  updateUser(id: string, change: { readonly name?: string; readonly disabled?: boolean }): UserInfo;
  deleteUser(id: string): void;
  /** Ends the user's sessions and, unless `revokeTokens` is `false`, deletes their tokens. */
  setPassword(
    id: string,
    password: string,
    options?: { readonly revokeTokens?: boolean },
  ): Promise<void>;
  assignRole(id: string, role: string): void;
  unassignRole(id: string, role: string): void;

  listRoles(): RoleRecord[];
  createRole(name: string, grants?: readonly string[]): RoleRecord;
  deleteRole(name: string): void;
  grant(role: string, permission: string): void;
  revoke(role: string, permission: string): void;

  listTokens(): TokenRecord[];
  /** `creator` is who asks. The token can hold nothing its creator does not hold. */
  createToken(
    creator: Principal,
    input: { readonly name: string; readonly grants: readonly string[]; readonly expires?: number },
  ): { readonly token: TokenRecord; readonly secret: string };
  revokeToken(id: string): void;
  /**
   * Turns a token into a browser session bound to it, and says how long that session lasts.
   * `undefined` for an unusable token.
   */
  exchangeToken(
    secret: string,
  ): { readonly session: string; readonly maxAgeSeconds: number } | undefined;

  /**
   * The code that allows creating the first admin; `undefined` once any user exists, not
   * counting the one dev mode created, and always `undefined` in dev mode.
   */
  setupCode(): string | undefined;
  setup(code: string, name: string, password: string): Promise<UserInfo>;

  /** Turns the `defaultRoles` of bundles seen for the first time into grants. */
  applyBundleDefaults(
    bundles: readonly {
      readonly name: string;
      readonly defaultRoles: Readonly<Record<string, readonly string[]>>;
    }[],
  ): void;
  /**
   * What `applyBundleDefaults` would do for a bundle: the roles that would be granted
   * permissions of it, and whether that happens, which it does only the first time a bundle
   * of this name is seen. Changes nothing.
   */
  bundleDefaults(
    bundle: string,
    defaultRoles: Readonly<Record<string, readonly string[]>>,
  ): { readonly grants: Readonly<Record<string, readonly string[]>>; readonly applies: boolean };
  /**
   * Takes every grant of a permission of the bundle from every role, and forgets that the
   * bundle was seen, so that a bundle of this name starts over. For a bundle that is removed
   * with its data. Grants with a wildcard in the place of the name stay, and so do tokens.
   */
  forgetBundle(bundle: string): void;
  /** A value the user stored under a key, such as a dashboard layout. */
  getPref(userId: string, key: string): Json | undefined;
  /** Stores a value. A user keeps at most `MAX_PREFS` of them. */
  setPref(userId: string, key: string, value: Json): void;
  /** `listener` is called after anything changed that can change someone's access. */
  onChange(listener: () => void): () => void;
  /** What the throttles hold and how many passwords are being checked. A leak shows here. */
  stats(): { throttleKeys: number; verifying: number; waiting: number };
}

const bad = (message: string) => new MoonCGError('bad_request', message);
const missing = (what: string) => new MoonCGError('not_found', `${what} does not exist`);

function checkPassword(password: unknown): asserts password is string {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw bad(`A password needs at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw bad(`A password can have at most ${MAX_PASSWORD_LENGTH} characters`);
  }
}

function checkUserName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || !USER_NAME.test(name)) {
    throw bad('A user name has 1 to 64 letters, digits, dots, dashes or underscores');
  }
}

function checkExternal(provider: unknown, subject: unknown): asserts subject is string {
  if (!isExternalProviderId(provider)) {
    throw bad('An external provider has an id of lowercase letters, digits and single dashes');
  }
  if (
    typeof subject !== 'string' ||
    subject === '' ||
    subject.length > MAX_SUBJECT_LENGTH ||
    CONTROL.test(subject)
  ) {
    throw bad(`A subject has 1 to ${MAX_SUBJECT_LENGTH} characters and no control characters`);
  }
}

function checkRealm(realm: unknown): asserts realm is string | undefined {
  if (realm === undefined) return;
  if (
    typeof realm !== 'string' ||
    realm === '' ||
    realm.length > MAX_REALM_LENGTH ||
    CONTROL.test(realm)
  ) {
    throw bad(`A realm has 1 to ${MAX_REALM_LENGTH} characters and no control characters`);
  }
}

/** What a provider calls an account, made into something a user can be called. */
function userNameFrom(name: string | undefined, provider: string): string {
  const cleaned = (name ?? '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[._-]+/, '')
    .slice(0, 48)
    .replace(/[._-]+$/, '');
  return cleaned === '' ? `${provider.slice(0, 40)}-user` : cleaned;
}

function checkGrant(permission: unknown): asserts permission is string {
  if (typeof permission !== 'string' || !isGrantPattern(permission)) {
    throw bad(
      'A grant is "*", "system:<permission>" or "bundle:<name>:<permission>", where "*" may stand for a part',
    );
  }
}

/**
 * Accounts, sessions, tokens and roles. Nothing is cached: every question is answered from the
 * store, so a change made by another process, such as the `mooncg` command line tool, applies
 * to the next request.
 */
export function createAuth(options: AuthOptions): Auth {
  const { store } = options;
  const { users, identities, roles, tokens, sessions } = store;
  const now = options.now ?? Date.now;
  const scrypt = options.scrypt ?? DEFAULT_SCRYPT;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of [...listeners]) listener();
  };
  const byPair = new LoginThrottle({ now, ...PAIR_LIMIT });
  const byAddress = new LoginThrottle({ now, ...ADDRESS_LIMIT });
  const byName = new LoginThrottle({ now, ...NAME_LIMIT });
  /** Wrong current passwords when changing the own password, per user. */
  const byUser = new LoginThrottle({ now, ...PAIR_LIMIT });
  const signupLimit = options.signupLimit ?? SIGNUP_LIMIT;
  /** When signing up created its latest users, oldest first. */
  let signups: number[] = [];
  const hashing = createLimiter({ max: MAX_VERIFICATIONS, queue: MAX_WAITING_VERIFICATIONS });
  let setupCode: string | undefined;
  /** Set while the one accepted setup request creates its user. */
  let setupClaimed = false;
  /** What an unknown user's password is checked against, so that takes as long as a known one's. */
  let dummyHash: Promise<string> | undefined;

  const info = (user: UserRecord): UserInfo => ({
    id: user.id,
    name: user.name,
    disabled: user.disabled,
    roles: users.roles(user.id),
    ...(user.devMode ? { devMode: true as const } : {}),
  });
  const devMode = options.devMode === true;
  /** Whether the user is dev mode's own and this is not dev mode: then it is nobody. */
  const inert = (user: UserRecord) => user.devMode === true && !devMode;
  /** The user dev mode created belongs to dev mode: nobody edits it into something else. */
  const changeable = (id: string): UserRecord => {
    const user = existing(id);
    if (user.devMode) {
      throw new MoonCGError(
        'conflict',
        `The user "${user.name}" belongs to dev mode and cannot be changed. It can be deleted; dev mode creates it again when it needs it.`,
      );
    }
    return user;
  };
  const existing = (id: string): UserRecord => {
    const user = users.get(id);
    if (!user) throw missing('The user');
    return user;
  };
  const existingRole = (name: string): RoleRecord => {
    const role = roles.get(name);
    if (!role) throw missing(`The role "${name}"`);
    return role;
  };
  /** Runs a change and undoes it if it would leave the server without an enabled admin. */
  const keepingAnAdmin = <T>(work: () => T): T =>
    store.transaction(() => {
      const before = users.admins();
      const result = work();
      if (before > 0 && users.admins() === 0) {
        throw new MoonCGError(
          'conflict',
          'The last administrator cannot be removed, disabled or demoted',
        );
      }
      return result;
    });

  const userPrincipal = (user: UserRecord): Principal => ({
    id: `user:${user.id}`,
    kind: 'user',
    roles: users.roles(user.id),
  });
  /** A token acts only while it has not expired and its creator is an enabled user. */
  const tokenPrincipal = (token: TokenRecord | undefined): Principal | undefined => {
    if (!token || (token.expires !== null && token.expires <= now())) return undefined;
    const creator = users.get(token.createdBy);
    if (!creator || creator.disabled || inert(creator)) return undefined;
    return {
      id: `token:${token.id}`,
      kind: 'token',
      roles: users.roles(creator.id),
      only: token.grants,
    };
  };
  const usedToken = (token: TokenRecord | undefined): Principal | undefined => {
    const principal = tokenPrincipal(token);
    if (principal && token && now() - (token.lastUsed ?? 0) >= TOUCH_INTERVAL_MS) {
      tokens.touch(token.id, now());
    }
    return principal;
  };
  const userOfSession = (secret: string): Principal | undefined => {
    const hash = hashSecret(secret);
    const session = sessions.get(hash);
    if (!session || session.userId === null) return undefined;
    if (now() - session.lastSeen > SESSION_IDLE_MS || now() - session.createdAt > SESSION_MAX_MS) {
      sessions.delete(hash);
      return undefined;
    }
    const user = users.get(session.userId);
    // Dev mode's own user never signs in, so a session of it is nothing to honour.
    if (!user || user.disabled || user.devMode) return undefined;
    if (now() - session.lastSeen >= TOUCH_INTERVAL_MS) sessions.touch(hash, now());
    return userPrincipal(user);
  };
  const tokenOfSession = (secret: string): Principal | undefined => {
    const hash = hashSecret(secret);
    const session = sessions.get(hash);
    if (!session || session.tokenId === null) return undefined;
    if (now() - session.createdAt > TOKEN_SESSION_MAX_MS) {
      sessions.delete(hash);
      return undefined;
    }
    return usedToken(tokens.get(session.tokenId));
  };
  const openSession = (userId: string): string => {
    const secret = randomSecret();
    sessions.create({
      hash: hashSecret(secret),
      userId,
      tokenId: null,
      createdAt: now(),
      lastSeen: now(),
    });
    return secret;
  };
  /** Hashes or verifies a password, a few at a time. Rejects with `LimiterFull` when swamped. */
  const hashed = (password: string) => hashing.run(() => hashPassword(password, scrypt));
  const verified = (password: string, stored: string) =>
    hashing.run(() => verifyPassword(password, stored));
  /** Everything the roles grant, as one list. */
  const grantsOf = (names: readonly string[], policy: Policy) =>
    names.flatMap((role) => policy.roles[role] ?? []);

  /** Creates a user. `first` creates the first one only: it fails if any user exists by then. */
  const create = async (
    input: { name: string; password: string; roles?: readonly string[] },
    first: boolean,
  ): Promise<UserInfo> => {
    const { name, password, roles: wanted = [] } = input;
    checkUserName(name);
    checkPassword(password);
    for (const role of wanted) existingRole(role);
    if (users.byName(name)) throw new MoonCGError('conflict', `The name "${name}" is taken`);
    const secret = await hashPassword(password, scrypt);
    const user: UserRecord = { id: randomUUID(), name, disabled: false, createdAt: now() };
    store.transaction(() => {
      // Checked again: the hash took a while, and someone else may have been faster.
      if (first && users.count() > 0) throw new MoonCGError('not_found', 'Not found');
      if (users.byName(name)) throw new MoonCGError('conflict', `The name "${name}" is taken`);
      users.create(user);
      identities.put({ provider: LOCAL, subject: user.id, userId: user.id, secret });
      for (const role of wanted) users.addRole(user.id, role);
    });
    setupCode = undefined;
    changed();
    return info(user);
  };

  const auth: Auth = {
    identify(credentials) {
      const policy = roles.policy();
      const found = (principal: Principal | undefined, via: Identity['via']): Identity =>
        principal
          ? { principal, policy, via }
          : { principal: ANONYMOUS_PRINCIPAL, policy, via: 'none' };
      const { bearer, session, tokenSession } = credentials;
      if (credentials.invalid) return found(undefined, 'none');
      // Whoever sends a token means to act as that token, whatever cookies came along.
      if (bearer !== undefined) {
        return found(usedToken(tokens.byHash(hashSecret(bearer))), 'bearer');
      }
      const user = session === undefined ? undefined : userOfSession(session);
      if (user) return found(user, 'session');
      return found(
        tokenSession === undefined ? undefined : tokenOfSession(tokenSession),
        'token-session',
      );
    },

    ensureDevUser() {
      if (!devMode) throw new MoonCGError('conflict', 'This is not dev mode');
      const user = store.transaction(() => {
        const [found] = users.devMode();
        if (found) {
          // Whatever became of it: dev mode needs it enabled and an administrator.
          if (found.disabled) users.update(found.id, { disabled: false });
          users.addRole(found.id, ADMIN_ROLE);
          return users.get(found.id) ?? found;
        }
        const name = DEV_USER_NAMES.find((candidate) => !users.byName(candidate));
        if (name === undefined) {
          throw new MoonCGError(
            'conflict',
            `Dev mode needs a user of its own, and the names ${DEV_USER_NAMES.join(', ')} are all taken by real users. Rename one of them.`,
          );
        }
        // No identity and so no password: nothing can ever sign in as this user.
        const created: UserRecord = {
          id: randomUUID(),
          name,
          disabled: false,
          createdAt: now(),
          devMode: true,
        };
        users.create(created);
        users.addRole(created.id, ADMIN_ROLE);
        return created;
      });
      changed();
      return info(user);
    },

    devIdentity() {
      const policy = roles.policy();
      const user = devMode ? users.devMode().find((candidate) => !candidate.disabled) : undefined;
      return user
        ? { principal: userPrincipal(user), policy, via: 'dev' }
        : { principal: ANONYMOUS_PRINCIPAL, policy, via: 'none' };
    },

    lockDevUsers() {
      const found = users.devMode();
      if (found.length === 0) return [];
      store.transaction(() => {
        for (const user of found) {
          sessions.deleteForUser(user.id);
          tokens.deleteForUser(user.id);
        }
      });
      changed();
      return found.map(info);
    },

    check(principalId, permission) {
      const [kind, ...rest] = principalId.split(':');
      const id = rest.join(':');
      // Installed bundles are trusted code, limited by their capabilities only.
      if (kind === 'extension') return id !== '';
      let principal: Principal | undefined;
      if (kind === 'user') {
        const user = users.get(id);
        principal = user && !user.disabled && !inert(user) ? userPrincipal(user) : undefined;
      } else if (kind === 'token') principal = tokenPrincipal(tokens.get(id));
      return principal !== undefined && authorize(principal, permission, roles.policy());
    },

    policy: () => roles.policy(),

    describe({ principal, policy }) {
      const { grants, only } = effectiveGrants(principal, policy);
      const kind = principal.kind ?? 'user';
      const id = principal.id.slice(principal.id.indexOf(':') + 1);
      const name =
        kind === 'user'
          ? (users.get(id)?.name ?? null)
          : kind === 'token'
            ? (tokens.get(id)?.name ?? null)
            : null;
      const permissions =
        only === undefined ? grants : only.filter((grant) => authorize(principal, grant, policy));
      return { id: principal.id, kind, name, roles: principal.roles, permissions };
    },

    authorizeChange(actor, change) {
      const policy = roles.policy();
      const involved = [
        ...(change.grants ?? []),
        ...grantsOf(change.roles ?? [], policy),
        ...(change.users ?? []).flatMap((id) => grantsOf(users.roles(id), policy)),
      ];
      const beyond = involved.find((permission) => !authorize(actor, permission, policy));
      if (beyond !== undefined) {
        throw new MoonCGError(
          'forbidden',
          `This involves "${beyond}", and you do not hold it yourself. ` +
            'Nobody can give, take or take over more than they hold.',
        );
      }
    },

    async login(name, password, address) {
      const usable = usableLogin(name, password);
      // Keys are made only of what passed the checks above, so their size is bounded.
      const nameKey = usable ? name.toLowerCase() : undefined;
      const counters: [LoginThrottle, string][] = [[byAddress, address]];
      if (nameKey !== undefined) {
        counters.push([byPair, `${nameKey}|${address}`], [byName, nameKey]);
      }
      const wait = Math.max(...counters.map(([throttle, key]) => throttle.blockedFor(key)));
      if (wait > 0) {
        return { ok: false, reason: 'throttled', retryAfterSeconds: Math.ceil(wait / 1000) };
      }
      // Counted now, before the password is checked: attempts that arrive together are
      // limited like attempts that arrive one after another.
      for (const [throttle, key] of counters) throttle.fail(key);
      const forgive = () => {
        for (const [throttle, key] of counters) throttle.forgive(key);
      };

      const user = usable ? users.byName(name) : undefined;
      const stored = user && identities.get(LOCAL, user.id)?.secret;
      let matches: boolean;
      try {
        dummyHash ??= hashPassword(randomSecret(), scrypt);
        // The password is checked even when there is nobody to check it for, so the time
        // taken does not tell whether the name exists.
        matches = await verified(usable ? password : '', stored ?? (await dummyHash));
      } catch (error) {
        if (!(error instanceof LimiterFull)) throw error;
        forgive();
        return { ok: false, reason: 'throttled', retryAfterSeconds: 1 };
      }
      // Looked at again: the check took a while, and the user may have been disabled or
      // given another password meanwhile.
      const current = user && users.get(user.id);
      const unchanged = user && identities.get(LOCAL, user.id)?.secret === stored;
      // The user dev mode created has no password and never signs in with one.
      if (!matches || !stored || !current || current.disabled || current.devMode || !unchanged) {
        return { ok: false, reason: 'credentials' };
      }
      // Not a failure after all. The name at this address starts afresh.
      forgive();
      if (nameKey !== undefined) byPair.succeed(`${nameKey}|${address}`);
      // The moment to clear out what has expired; nothing else needs a timer for it.
      sessions.deleteUserSessionsBefore({
        lastSeen: now() - SESSION_IDLE_MS,
        createdAt: now() - SESSION_MAX_MS,
      });
      return { ok: true, user: info(current), session: openSession(current.id) };
    },

    logout(session) {
      sessions.delete(hashSecret(session));
      changed();
    },

    externalLogin(provider, account, { signup = false } = {}) {
      const { subject, realm } = account;
      checkExternal(provider, subject);
      checkRealm(realm);
      // Without a user the installation is not set up, and signing up here would end the
      // setup with a user who holds nothing. The user of dev mode does not count as one.
      if (users.count() === 0) return { ok: false, reason: 'setup' };
      const outcome = store.transaction(() => {
        const linked = identities.get(provider, subject);
        if (linked) {
          const user = users.get(linked.userId);
          // The user of dev mode never signs in; nothing links it, and nothing stored does.
          if (!user || user.disabled || user.devMode) return 'disabled' as const;
          const bound = linked.realm ?? undefined;
          // Bound to a realm, the link is that account there and nowhere else: under another
          // issuer the same subject is another person. A provider that names no realm any
          // more is not believed either.
          if (bound !== undefined && bound !== realm) return { linkedRealm: bound };
          // Not bound yet, as a link from before realms were kept or one an administrator
          // typed in: this sign-in says what it is bound to.
          if (bound === undefined && realm !== undefined) identities.put({ ...linked, realm });
          return { user, created: false };
        }
        if (!signup) return 'not_linked' as const;
        signups = signups.filter((at) => now() - at < signupLimit.windowMs);
        if (signups.length >= signupLimit.max) return 'limited' as const;
        // A new user, whatever the provider calls the account: a name that is taken gets a
        // number, and is never taken for the user who has it.
        const wanted = userNameFrom(account.name, provider);
        let name = wanted;
        for (let n = 2; users.byName(name); n++) {
          name = n <= 50 ? `${wanted}-${n}` : `${wanted}-${randomBytes(4).toString('hex')}`;
        }
        const user: UserRecord = { id: randomUUID(), name, disabled: false, createdAt: now() };
        users.create(user);
        identities.put({ provider, subject, userId: user.id, secret: null, realm });
        return { user, created: true };
      });
      if (outcome === 'limited') return { ok: false, reason: 'not_linked', signupLimited: true };
      if (typeof outcome === 'string') return { ok: false, reason: outcome };
      if ('linkedRealm' in outcome) {
        return { ok: false, reason: 'realm', linkedRealm: outcome.linkedRealm };
      }
      if (outcome.created) signups.push(now());
      if (outcome.created) changed();
      sessions.deleteUserSessionsBefore({
        lastSeen: now() - SESSION_IDLE_MS,
        createdAt: now() - SESSION_MAX_MS,
      });
      return {
        ok: true,
        user: info(outcome.user),
        session: openSession(outcome.user.id),
        created: outcome.created,
      };
    },

    listIdentities: () =>
      identities.listExcept(LOCAL).map(({ userId, provider, subject, realm }) => ({
        userId,
        provider,
        subject,
        ...(realm == null ? {} : { realm }),
      })),

    linkIdentity(userId, provider, subject, realm) {
      checkExternal(provider, subject);
      checkRealm(realm);
      store.transaction(() => {
        const user = changeable(userId);
        const holder = identities.get(provider, subject);
        if (holder && holder.userId !== user.id) {
          throw new MoonCGError(
            'conflict',
            'This account is linked to another user. Unlink it there first.',
          );
        }
        identities.put({ provider, subject, userId: user.id, secret: null, realm });
      });
      changed();
    },

    unlinkIdentity(userId, provider, subject) {
      checkExternal(provider, subject);
      store.transaction(() => {
        existing(userId);
        if (identities.get(provider, subject)?.userId !== userId) throw missing('The link');
        identities.delete(provider, subject);
        // Whoever signed in through it is signed out, as after a new password.
        sessions.deleteForUser(userId);
      });
      changed();
    },

    async changeOwnPassword(userId, current, next, { revokeTokens = false } = {}) {
      const user = existing(userId);
      const stored = identities.get(LOCAL, user.id)?.secret;
      const wait = byUser.blockedFor(user.id);
      if (wait > 0) throw new ThrottledError(Math.ceil(wait / 1000));
      byUser.fail(user.id);
      let matches: boolean;
      try {
        matches =
          typeof current === 'string' &&
          current.length <= MAX_PASSWORD_LENGTH &&
          stored !== undefined &&
          stored !== null &&
          (await verified(current, stored));
      } catch (error) {
        if (!(error instanceof LimiterFull)) throw error;
        byUser.forgive(user.id);
        throw new ThrottledError(1);
      }
      if (!matches) throw new MoonCGError('forbidden', 'The current password is wrong');
      byUser.succeed(user.id);
      checkPassword(next);
      const secret = await hashed(next);
      const session = store.transaction(() => {
        // Looked at again: someone may have disabled the user or reset the password meanwhile,
        // and this must not undo that.
        const latest = users.get(user.id);
        if (!latest || latest.disabled || identities.get(LOCAL, user.id)?.secret !== stored) {
          throw new MoonCGError('forbidden', 'The account changed meanwhile. Sign in again.');
        }
        identities.put({ provider: LOCAL, subject: user.id, userId: user.id, secret });
        sessions.deleteForUser(user.id);
        if (revokeTokens) tokens.deleteForUser(user.id);
        return openSession(user.id);
      });
      changed();
      return session;
    },

    listUsers: () => users.list().map(info),

    findUser(name) {
      const user = users.byName(name);
      return user && info(user);
    },

    createUser: (input) => create(input, false),

    updateUser(id, { name, disabled }) {
      const user = changeable(id);
      if (name !== undefined) {
        checkUserName(name);
        const holder = users.byName(name);
        if (holder && holder.id !== id) {
          throw new MoonCGError('conflict', `The name "${name}" is taken`);
        }
      }
      keepingAnAdmin(() => {
        users.update(id, {
          ...(name === undefined ? {} : { name }),
          ...(disabled === undefined ? {} : { disabled }),
        });
        // A disabled user is signed out everywhere and stays so when enabled again.
        if (disabled === true) sessions.deleteForUser(id);
      });
      changed();
      return info(users.get(id) ?? user);
    },

    deleteUser(id) {
      existing(id);
      keepingAnAdmin(() => users.delete(id));
      changed();
    },

    async setPassword(id, password, { revokeTokens = true } = {}) {
      const user = changeable(id);
      checkPassword(password);
      const secret = await hashPassword(password, scrypt);
      store.transaction(() => {
        // The user may have been deleted while the password was hashed.
        existing(user.id);
        identities.put({ provider: LOCAL, subject: user.id, userId: user.id, secret });
        sessions.deleteForUser(user.id);
        // Whoever resets a password does so because it may be known to someone else, and
        // that someone may have made tokens with it.
        if (revokeTokens) tokens.deleteForUser(user.id);
      });
      changed();
    },

    assignRole(id, role) {
      changeable(id);
      existingRole(role);
      users.addRole(id, role);
      changed();
    },

    unassignRole(id, role) {
      changeable(id);
      existingRole(role);
      keepingAnAdmin(() => users.removeRole(id, role));
      changed();
    },

    listRoles: () => roles.list(),

    createRole(name, grants = []) {
      if (typeof name !== 'string' || name.length > 64 || !ROLE_NAME.test(name)) {
        throw bad('A role name has lowercase letters, digits and single dashes');
      }
      for (const permission of grants) checkGrant(permission);
      if (roles.get(name)) throw new MoonCGError('conflict', `The role "${name}" exists already`);
      store.transaction(() => {
        roles.create(name);
        for (const permission of grants) roles.grant(name, permission);
      });
      changed();
      return existingRole(name);
    },

    deleteRole(name) {
      if (existingRole(name).builtin) {
        throw new MoonCGError('conflict', `The built-in role "${name}" cannot be deleted`);
      }
      roles.delete(name);
      changed();
    },

    grant(role, permission) {
      checkGrant(permission);
      existingRole(role);
      roles.grant(role, permission);
      changed();
    },

    revoke(role, permission) {
      existingRole(role);
      if (role === ADMIN_ROLE && permission === '*') {
        throw new MoonCGError('conflict', 'The role "admin" always holds "*"');
      }
      roles.revoke(role, permission);
      changed();
    },

    listTokens: () => tokens.list(),

    createToken(creator, { name, grants, expires }) {
      if (typeof name !== 'string' || name.trim() === '' || name.length > 100) {
        throw bad('A token needs a name of at most 100 characters');
      }
      if (!Array.isArray(grants) || grants.length === 0) {
        throw bad('A token needs at least one grant');
      }
      for (const permission of grants) checkGrant(permission);
      if (expires !== undefined && (!Number.isSafeInteger(expires) || expires <= now())) {
        throw bad('A token can only expire in the future');
      }
      const [kind, id] = [creator.kind ?? 'user', creator.id.slice(creator.id.indexOf(':') + 1)];
      const owner = kind === 'token' ? tokens.get(id)?.createdBy : kind === 'user' ? id : undefined;
      const ownedBy = owner === undefined ? undefined : users.get(owner);
      if (owner === undefined || !ownedBy) {
        throw new MoonCGError('forbidden', 'Only a user or a token can create tokens');
      }
      if (inert(ownedBy)) {
        throw new MoonCGError(
          'forbidden',
          `The user "${ownedBy.name}" belongs to dev mode and is nobody outside it: it cannot have tokens`,
        );
      }
      const policy = roles.policy();
      const beyond = grants.find((permission) => !authorize(creator, permission, policy));
      if (beyond !== undefined) {
        throw new MoonCGError('forbidden', `A token cannot hold "${beyond}": you do not hold it`);
      }
      const secret = `${TOKEN_PREFIX}${randomSecret()}`;
      const token: TokenRecord = {
        id: randomBytes(8).toString('hex'),
        name: name.trim(),
        grants: [...new Set(grants)].sort(),
        expires: expires ?? null,
        lastUsed: null,
        createdBy: owner,
        createdAt: now(),
      };
      tokens.create(token, hashSecret(secret));
      return { token, secret };
    },

    revokeToken(id) {
      if (!tokens.get(id)) throw missing('The token');
      tokens.delete(id);
      changed();
    },

    exchangeToken(secret) {
      const token = tokens.byHash(hashSecret(secret));
      if (!token || !usedToken(token)) return undefined;
      const session = randomSecret();
      sessions.create({
        hash: hashSecret(session),
        userId: null,
        tokenId: token.id,
        createdAt: now(),
        lastSeen: now(),
      });
      sessions.trimForToken(token.id, MAX_TOKEN_SESSIONS);
      const lifetime =
        token.expires === null
          ? TOKEN_SESSION_MAX_MS
          : Math.min(TOKEN_SESSION_MAX_MS, token.expires - now());
      return { session, maxAgeSeconds: Math.ceil(lifetime / 1000) };
    },

    setupCode() {
      // Dev mode is no time to set an installation up: it signs in as its own user, which
      // does not count as one. The first real start offers the setup.
      if (setupClaimed || devMode || users.count() > 0) {
        if (!setupClaimed) setupCode = undefined;
        return undefined;
      }
      setupCode ??= randomSecret();
      return setupCode;
    },

    async setup(code, name, password) {
      const expected = auth.setupCode();
      // Once a user exists there is no setup, and nothing tells that there ever was.
      if (expected === undefined) throw new MoonCGError('not_found', 'Not found');
      if (typeof code !== 'string' || !sameSecret(code, expected)) {
        throw new MoonCGError('forbidden', 'The setup code is wrong');
      }
      // What the caller can put right is checked before the code is used up.
      checkUserName(name);
      checkPassword(password);
      // The code is single-use from here, before anything is awaited: of all the requests
      // that arrive with it at the same moment, this one alone goes on.
      setupClaimed = true;
      try {
        return await create({ name, password, roles: [ADMIN_ROLE] }, true);
      } finally {
        // If creating the user failed and there still is none, the code works again.
        setupClaimed = false;
      }
    },

    applyBundleDefaults(bundles) {
      let applied = false;
      for (const { name, defaultRoles } of bundles) {
        if (store.bundleDefaults.applied(name)) continue;
        store.transaction(() => {
          for (const [role, permissions] of Object.entries(defaultRoles)) {
            const target = roles.get(role);
            // `admin` holds everything already; other roles are an administrator's to fill.
            if (!target?.builtin || role === ADMIN_ROLE) continue;
            for (const permission of permissions) roles.grant(role, `bundle:${name}:${permission}`);
          }
          store.bundleDefaults.markApplied(name);
        });
        applied = true;
      }
      if (applied) changed();
    },

    bundleDefaults(bundle, defaultRoles) {
      const grants: Record<string, readonly string[]> = {};
      for (const [role, permissions] of Object.entries(defaultRoles)) {
        // The same roles `applyBundleDefaults` fills.
        if (roles.get(role)?.builtin && role !== ADMIN_ROLE) grants[role] = [...permissions];
      }
      return { grants, applies: !store.bundleDefaults.applied(bundle) };
    },

    forgetBundle(bundle) {
      if (!BUNDLE_NAME_PATTERN.test(bundle)) return;
      const prefix = `bundle:${bundle}:`;
      store.transaction(() => {
        for (const role of roles.list()) {
          for (const grant of role.grants) {
            if (grant.startsWith(prefix)) roles.revoke(role.name, grant);
          }
        }
        store.bundleDefaults.forget(bundle);
      });
      changed();
    },

    getPref(userId, key) {
      const json = store.prefs.get(userId, key);
      return json === undefined ? undefined : (JSON.parse(json) as Json);
    },

    setPref(userId, key, value) {
      existing(userId);
      if (typeof key !== 'string' || !PREF_KEY.test(key)) {
        throw bad(
          'A preference key has 1 to 64 lowercase letters, digits, dots, dashes or underscores',
        );
      }
      if (jsonProblem(value) !== null) throw bad('A preference must be JSON');
      store.transaction(() => {
        if (store.prefs.get(userId, key) === undefined && store.prefs.count(userId) >= MAX_PREFS) {
          throw new MoonCGError('conflict', `A user can keep at most ${MAX_PREFS} preferences`);
        }
        store.prefs.put(userId, key, JSON.stringify(value));
      });
    },

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    stats() {
      const { running, waiting } = hashing.stats();
      return {
        throttleKeys: byPair.size + byAddress.size + byName.size + byUser.size,
        verifying: running,
        waiting,
      };
    },
  };
  return auth;
}
