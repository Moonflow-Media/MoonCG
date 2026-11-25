import { createHash } from 'node:crypto';
import { MoonCGError } from '@mooncg/core';
import { type Auth, ThrottledError } from '../auth/auth.js';
import { hashSecret, randomSecret, sameSecret } from '../auth/secrets.js';
import { LoginThrottle } from '../auth/throttle.js';
import { errorMessage, type Logger, printable } from '../kernel/logger.js';
import type { ProviderRegistry } from './providers.js';

/** How long a started sign-in waits for the browser to come back: 10 minutes. */
export const FLOW_TTL_MS = 10 * 60 * 1000;
/** How many started sign-ins are kept, for everyone together. */
const MAX_PENDING = 1000;
/** How many started sign-ins one address has at a time. Its oldest makes room for a new one. */
export const MAX_PENDING_PER_ADDRESS = 10;
/** How often one address may start a sign-in: 30 times a minute. */
export const START_LIMIT = { max: 30, windowMs: 60 * 1000 };
/** How many addresses are remembered for that limit. The one that started longest ago goes first. */
const MAX_START_KEYS = 10_000;
/** How long a provider may take to answer, unless configured otherwise. */
const PROVIDER_TIMEOUT_MS = 15_000;
/** How many attempts of accounts nobody linked are remembered for the Users page. */
const MAX_UNLINKED = 20;
/** How many of them may come from one address. Its oldest makes room for a new one. */
export const MAX_UNLINKED_PER_ADDRESS = 5;
const MAX_SHOWN_NAME = 64;
/** The same limit a wrong password from one address meets: see `auth.ts`. */
const ADDRESS_LIMIT = { free: 20, baseMs: 5000, maxMs: 15 * 60 * 1000 };

/**
 * Where to send the browser after signing in: a path of this server, or `/`. Whatever was
 * asked for comes from the address of a request, which anybody can write: a link to the
 * server must not end on another site. So it must begin with one slash, hold no backslash
 * (which browsers read as a slash) and no control character, and still be a path of this
 * origin once a browser has resolved it: `/..//evil.example` resolves to `//evil.example`.
 */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2000) return '/';
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the point
  if (!value.startsWith('/') || /[\\\u0000-\u001f\u007f-\u009f]/.test(value)) return '/';
  const base = 'http://mooncg.invalid';
  if (!URL.canParse(value, base)) return '/';
  const url = new URL(value, base);
  const path = `${url.pathname}${url.search}${url.hash}`;
  return url.origin !== base || path.startsWith('//') ? '/' : path;
}

/** The PKCE challenge of a verifier, by the method `S256`. */
export const codeChallenge = (verifier: string) =>
  createHash('sha256').update(verifier).digest('base64url');

/**
 * Removes entries until at most `max` are left, each time the oldest entry of the address
 * that holds the most. Among addresses that hold the same number, the one with the oldest
 * entry gives. So whoever fills a list from one address makes room in it themselves, and
 * what others put there stays. `entries` are oldest first.
 */
function trimHeaviest<T extends { readonly address: string }>(
  entries: Iterable<T>,
  size: number,
  max: number,
  remove: (entry: T) => void,
): void {
  if (size <= max) return;
  /** Per address what it holds, oldest first. A `Map` keeps the order addresses first appear in. */
  const held = new Map<string, T[]>();
  for (const entry of entries) {
    const list = held.get(entry.address);
    if (list) list.push(entry);
    else held.set(entry.address, [entry]);
  }
  for (let excess = size - max; excess > 0; excess--) {
    let heaviest: T[] | undefined;
    for (const list of held.values()) {
      if (heaviest === undefined || list.length > heaviest.length) heaviest = list;
    }
    const oldest = heaviest?.shift();
    if (oldest === undefined) return;
    remove(oldest);
  }
}

interface Pending {
  readonly key: string;
  readonly provider: string;
  readonly state: string;
  readonly nonce: string;
  readonly verifier: string;
  readonly redirectUri: string;
  readonly returnTo: string;
  readonly expires: number;
  /** The address that started it. */
  readonly address: string;
}

/** An account that tried to sign in and belongs to no user, or to one for another realm. */
export interface UnlinkedAttempt {
  readonly provider: string;
  readonly subject: string;
  /** The realm the provider reported for the account, if it reports one. */
  readonly realm?: string;
  /** What the provider calls the account. Whoever has the account chose it. */
  readonly name?: string;
  /** When it last tried, as an ISO 8601 time. */
  readonly at: string;
}

export type CompleteResult =
  | { readonly ok: true; readonly session: string; readonly returnTo: string }
  | {
      readonly ok: false;
      /**
       * `state`: the browser did not bring what a started sign-in gave it. `provider`: the
       * provider refused or could not be asked. The rest is what `Auth.externalLogin` says.
       */
      readonly reason: 'state' | 'provider' | 'not_linked' | 'disabled' | 'setup' | 'realm';
    }
  | { readonly ok: false; readonly reason: 'throttled'; readonly retryAfterSeconds: number };

export interface ExternalLoginsOptions {
  readonly auth: Pick<Auth, 'externalLogin'>;
  readonly providers: ProviderRegistry;
  readonly logger: Logger;
  readonly now?: () => number;
  readonly providerTimeoutMs?: number;
}

/**
 * Signing in with an account kept elsewhere, as far as it is the same for every provider.
 *
 * A sign-in is started here and finished here. Starting creates `state`, `nonce` and the
 * PKCE verifier and keeps them, with the address to come back to, under a ticket only the
 * browser gets, in a cookie. Finishing takes the ticket and the `state` the provider passed
 * back: both must belong to the same started sign-in, which is forgotten the moment it is
 * looked up. So a `state` works once, in the browser that started it, for ten minutes.
 *
 * Starting needs no credentials, so what it keeps is bounded per address: an address starts
 * a sign-in 30 times a minute, holds ten started ones at most, and when it starts another,
 * its own oldest goes. All together 1000 are kept; beyond that the address that holds the
 * most gives one up. Nobody ends the sign-ins of others by starting many.
 */
export class ExternalLogins {
  readonly #options: ExternalLoginsOptions;
  readonly #now: () => number;
  /** By the hash of the ticket, oldest first. */
  readonly #pending = new Map<string, Pending>();
  /** Newest first. */
  readonly #unlinked: (UnlinkedAttempt & { readonly address: string })[] = [];
  readonly #byAddress: LoginThrottle;
  /** When each address started its latest sign-ins, by address. */
  readonly #starts = new Map<string, number[]>();

  constructor(options: ExternalLoginsOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#byAddress = new LoginThrottle({ now: this.#now, ...ADDRESS_LIMIT });
  }

  /**
   * Starts a sign-in with a provider, for the browser at `address`. Resolves with the address
   * to send the browser to and the ticket to give it as a cookie. Rejects with `not_found`
   * for a provider that is not registered, with a `ThrottledError` for an address that
   * starts too many, and with `unavailable` when the provider cannot say where to go.
   */
  async begin(
    providerId: string,
    request: {
      readonly redirectUri: string;
      readonly returnTo: string;
      readonly address: string;
    },
  ): Promise<{ readonly url: string; readonly ticket: string }> {
    const registered = this.#options.providers.get(providerId);
    if (!registered) throw new MoonCGError('not_found', 'Not found');
    // Asked before the provider is: nobody makes this server knock on its door without end.
    const wait = this.#admitStart(request.address);
    if (wait > 0) throw new ThrottledError(Math.ceil(wait / 1000));
    const ticket = randomSecret();
    const pending: Pending = {
      key: hashSecret(ticket),
      provider: providerId,
      state: randomSecret(),
      nonce: randomSecret(),
      // 43 characters of base64url: what RFC 7636 asks of a verifier.
      verifier: randomSecret(),
      redirectUri: request.redirectUri,
      returnTo: request.returnTo,
      expires: this.#now() + FLOW_TTL_MS,
      address: request.address,
    };
    let url: string;
    try {
      url = await this.#bounded(
        Promise.resolve().then(() =>
          registered.provider.authorize({
            state: pending.state,
            nonce: pending.nonce,
            codeChallenge: codeChallenge(pending.verifier),
            redirectUri: pending.redirectUri,
          }),
        ),
      );
      // Only ever a web address: whatever a provider answers, the browser is not sent to a
      // `javascript:` or `data:` one.
      const target = typeof url === 'string' && URL.canParse(url) ? new URL(url) : undefined;
      if (target?.protocol !== 'https:' && target?.protocol !== 'http:') {
        throw new Error('The provider did not answer with an http(s) address');
      }
    } catch (error) {
      this.#options.logger.warn(
        `Signing in with "${providerId}" could not be started: ${errorMessage(error)}`,
      );
      throw new MoonCGError('unavailable', 'The provider cannot be reached');
    }
    this.#keep(pending);
    return { url, ticket };
  }

  /**
   * Finishes a sign-in: the browser is back from the provider. `ticket` is what its cookie
   * holds and `query` what the provider put into the address. Never rejects.
   */
  async complete(
    providerId: string,
    request: {
      readonly ticket: string | undefined;
      readonly query: Readonly<Record<string, string>>;
      readonly address: string;
    },
  ): Promise<CompleteResult> {
    const { ticket, query, address } = request;
    const { auth, providers, logger } = this.#options;
    const wait = this.#byAddress.blockedFor(address);
    if (wait > 0) {
      return { ok: false, reason: 'throttled', retryAfterSeconds: Math.ceil(wait / 1000) };
    }
    // Counted now, before anything is checked or anyone is asked: attempts that arrive
    // together are limited like attempts that arrive one after another, and nobody makes
    // this server ask a provider more often than that.
    this.#byAddress.fail(address);

    // Looked up and forgotten in one step, whatever comes of it: a state works once.
    const key = ticket === undefined ? undefined : hashSecret(ticket);
    const pending = key === undefined ? undefined : this.#pending.get(key);
    if (key !== undefined) this.#pending.delete(key);
    const { state, ...rest } = query;
    if (
      !pending ||
      pending.expires <= this.#now() ||
      pending.provider !== providerId ||
      typeof state !== 'string' ||
      !sameSecret(state, pending.state)
    ) {
      return { ok: false, reason: 'state' };
    }
    const registered = providers.get(providerId);
    if (!registered) return { ok: false, reason: 'state' };

    let subject: unknown;
    let name: unknown;
    let realm: unknown;
    try {
      const account = await this.#bounded(
        Promise.resolve().then(() =>
          registered.provider.callback({
            query: rest,
            redirectUri: pending.redirectUri,
            nonce: pending.nonce,
            codeVerifier: pending.verifier,
          }),
        ),
      );
      // A provider is code of a module: what it answers is checked, not believed to be typed.
      ({ subject, name, realm } = (account ?? {}) as {
        subject?: unknown;
        name?: unknown;
        realm?: unknown;
      });
      if (typeof subject !== 'string' || subject === '') {
        throw new Error('The provider named no subject');
      }
      if (realm !== undefined && typeof realm !== 'string') {
        throw new Error('The provider named a realm that is no text');
      }
    } catch (error) {
      // Why goes to the log, for whoever runs the installation. The browser learns nothing:
      // what a provider says may hold what only the two of them should know.
      logger.warn(`Signing in with "${providerId}" was refused: ${errorMessage(error)}`);
      return { ok: false, reason: 'provider' };
    }
    const shown = typeof name === 'string' ? name : undefined;
    let result: ReturnType<Auth['externalLogin']>;
    try {
      result = auth.externalLogin(
        providerId,
        { subject, name: shown, realm },
        { signup: registered.provider.allowSignup === true },
      );
    } catch (error) {
      logger.warn(`Signing in with "${providerId}" was refused: ${errorMessage(error)}`);
      return { ok: false, reason: 'provider' };
    }
    const account = `subject ${JSON.stringify(printable(subject))}`;
    if (!result.ok) {
      // The attempt stays counted against the address. The provider vouched for an account,
      // but nobody was signed in: an address that keeps coming back with accounts that
      // belong to nobody here is slowed down like one that guesses.
      const attempt = { provider: providerId, subject, realm, name: shown, address };
      if (result.reason === 'realm') {
        logger.warn(
          `Signing in with "${providerId}" was refused: the account (${account}) is linked for the realm ` +
            `${JSON.stringify(printable(result.linkedRealm))}, and the provider now reports ` +
            `${realm === undefined ? 'none' : JSON.stringify(printable(realm))}. ` +
            'If the provider was moved on purpose, an administrator links the account again on the Users page.',
        );
        this.#noteUnlinked(attempt);
      } else if (result.reason === 'not_linked') {
        if (result.signupLimited) {
          logger.warn(
            `Signing up with "${providerId}" is paused: as many users as signing up may create ` +
              'in an hour were created. The account is refused like one nobody linked.',
          );
        }
        this.#noteUnlinked(attempt);
        logger.info(
          `An account of "${providerId}" that no user is linked to tried to sign in (${account}). ` +
            'An administrator can link it on the Users page.',
        );
      }
      return { ok: false, reason: result.reason };
    }
    // The provider vouched for the account and it is a user here: nobody was guessing.
    this.#byAddress.forgive(address);
    const user = JSON.stringify(result.user.name);
    if (result.created) {
      logger.info(`Signing in with "${providerId}" created the user ${user}, without any role`);
    }
    logger.info(
      `${user} signed in with "${providerId}" (${account}) from ${printable(address, 64)}`,
    );
    return { ok: true, session: result.session, returnTo: pending.returnTo };
  }

  /** The latest attempts of accounts that belong to no user, newest first. */
  unlinked(): UnlinkedAttempt[] {
    return this.#unlinked.map(({ address: _address, ...attempt }) => attempt);
  }

  /** The realm the remembered attempt of an account reported, if there is one and it did. */
  unlinkedRealm(provider: string, subject: string): string | undefined {
    return this.#unlinked.find(
      (attempt) => attempt.provider === provider && attempt.subject === subject,
    )?.realm;
  }

  /** Forgets an attempt: its account was linked. */
  forgetUnlinked(provider: string, subject: string): void {
    const at = this.#unlinked.findIndex(
      (attempt) => attempt.provider === provider && attempt.subject === subject,
    );
    if (at !== -1) this.#unlinked.splice(at, 1);
  }

  stats(): { pending: number; throttleKeys: number; startKeys: number } {
    return {
      pending: this.#pending.size,
      throttleKeys: this.#byAddress.size,
      startKeys: this.#starts.size,
    };
  }

  /**
   * Counts a sign-in an address is about to start. Returns how many milliseconds the address
   * has to wait instead, when it started as many as it may within the last minute.
   */
  #admitStart(address: string): number {
    const now = this.#now();
    const recent = (this.#starts.get(address) ?? []).filter(
      (at) => now - at < START_LIMIT.windowMs,
    );
    const oldest = recent[0];
    if (recent.length >= START_LIMIT.max && oldest !== undefined) {
      this.#starts.set(address, recent);
      return oldest + START_LIMIT.windowMs - now;
    }
    recent.push(now);
    // Moves the address to the end: the map keeps the order of the latest starts.
    this.#starts.delete(address);
    this.#starts.set(address, recent);
    while (this.#starts.size > MAX_START_KEYS) {
      this.#starts.delete(this.#starts.keys().next().value as string);
    }
    return 0;
  }

  /** Keeps a started sign-in, and makes room for it within the limits. */
  #keep(pending: Pending): void {
    const now = this.#now();
    let own = 0;
    for (const [key, entry] of this.#pending) {
      if (entry.expires <= now) this.#pending.delete(key);
      else if (entry.address === pending.address) own++;
    }
    // Of the same address, the oldest goes first: the map is oldest first.
    for (const [key, entry] of this.#pending) {
      if (own < MAX_PENDING_PER_ADDRESS) break;
      if (entry.address !== pending.address) continue;
      this.#pending.delete(key);
      own--;
    }
    this.#pending.set(pending.key, pending);
    trimHeaviest(this.#pending.values(), this.#pending.size, MAX_PENDING, (entry) =>
      this.#pending.delete(entry.key),
    );
  }

  #noteUnlinked(attempt: {
    readonly provider: string;
    readonly subject: string;
    readonly realm: string | undefined;
    readonly name: string | undefined;
    readonly address: string;
  }): void {
    const { provider, subject, realm, address } = attempt;
    // One entry per account: the latest attempt takes the place of the one before.
    this.forgetUnlinked(provider, subject);
    // A stranger chose the name: it is shown without what could redraw a terminal or a page,
    // or make it read as another name.
    const name = attempt.name === undefined ? '' : printable(attempt.name, MAX_SHOWN_NAME).trim();
    const own = this.#unlinked.filter((entry) => entry.address === address);
    for (const entry of own.slice(MAX_UNLINKED_PER_ADDRESS - 1)) {
      this.#unlinked.splice(this.#unlinked.indexOf(entry), 1);
    }
    this.#unlinked.unshift({
      provider,
      subject,
      ...(realm === undefined ? {} : { realm }),
      ...(name === '' ? {} : { name }),
      at: new Date(this.#now()).toISOString(),
      address,
    });
    trimHeaviest([...this.#unlinked].reverse(), this.#unlinked.length, MAX_UNLINKED, (entry) => {
      this.#unlinked.splice(this.#unlinked.indexOf(entry), 1);
    });
  }

  /** Waits for a provider, but not forever. */
  #bounded<T>(work: Promise<T>): Promise<T> {
    const ms = this.#options.providerTimeoutMs ?? PROVIDER_TIMEOUT_MS;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`The provider did not answer within ${ms} ms`)),
        ms,
      );
      work.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }
}
