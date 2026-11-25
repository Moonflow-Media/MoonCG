import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  isLoopbackHost,
  isLoopbackRegistryUrl,
  MoonCGError,
  registryUrlProblem,
} from '@mooncg/core';
import { refuse, storageError, storageProblem } from '../install/files.js';
import { withoutCredentials } from '../install/git.js';
import { errorMessage } from '../kernel/logger.js';
import {
  guardedLookup,
  ipProblem,
  type PrivateNetworks,
  plainHttpAllowed,
  type Reach,
  Refused,
  type Resolver,
} from './network.js';

export type { PrivateNetworks, Resolver } from './network.js';

/** How many redirects are followed before a request is given up. */
export const MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export interface HttpGetOptions {
  /** How long the whole request may take, redirects and body included. */
  readonly timeoutMs: number;
  /** How many bytes the body may have. Counted as it arrives. */
  readonly maxBytes: number;
  readonly maxRedirects?: number | undefined;
  /** Ends the request, for instance when the server shuts down. */
  readonly signal?: AbortSignal | undefined;
  /** Resolves host names instead of the system resolver. For tests. */
  readonly resolve?: Resolver | undefined;
  /** The private networks the configuration of the server allows. */
  readonly private?: PrivateNetworks | undefined;
}

/** Whether a content type is one an index may be served as. */
export function isJsonType(type: string | undefined): boolean {
  const essence = type?.split(';')[0]?.trim().toLowerCase();
  if (essence === undefined) return false;
  // A raw file of a Git host is plain text; a page of a login wall is HTML and is not taken.
  return (
    essence === 'application/json' ||
    essence === 'text/json' ||
    essence === 'text/plain' ||
    /^application\/[a-z0-9.+-]+\+json$/.test(essence)
  );
}

/** How a request may go: where it may connect, and who gets credentials. */
interface NetworkPolicy extends Reach {
  /** The credentials to send as a header, and the one origin they go to. */
  readonly credentials?: { readonly origin: string; readonly header: string } | undefined;
}

/** The hosts plain `http://` is taken for besides this machine, under a policy. */
const plainHttpFor = (policy: Reach) => (host: string) => plainHttpAllowed(host, policy.private);

/**
 * Why an address is not asked under a policy, before anything connects: the rules of an
 * index address, and an IP address written in it that is internal, or this machine where
 * that is not allowed. Names are checked again for what they resolve to when the server
 * connects. Plain `http://` is taken for this machine where it may be asked, and for a host
 * of a private network the configuration allows it for.
 */
export function addressProblem(url: string, policy: Reach): string | undefined {
  const problem = registryUrlProblem(url, {
    loopback: policy.loopback,
    plainHttp: plainHttpFor(policy),
  });
  if (problem !== undefined) return problem;
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  return ipProblem(host, policy, host, isPlainRemote(parsed));
}

/** Whether an address is plain `http://` to a host that is not this machine. */
const isPlainRemote = (url: URL) => url.protocol === 'http:' && !isLoopbackHost(url.hostname);

/**
 * Why an address cannot be an index, or `undefined` if it can: the rules of
 * `registryUrlProblem`, with plain `http://` also for a host of a private network the
 * configuration allows it for.
 */
export function indexUrlProblem(url: string, access?: PrivateNetworks): string | undefined {
  return registryUrlProblem(url, { plainHttp: (host) => plainHttpAllowed(host, access) });
}

/** One GET, without following redirects, resolved once the head of the answer arrived. */
function send(
  url: URL,
  headers: Record<string, string>,
  signal: AbortSignal,
  lookup: LookupFunction,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const make = url.protocol === 'https:' ? httpsRequest : httpRequest;
    // A connection of its own for every request: a pooled one may have been checked under
    // another policy.
    const request = make(url, { method: 'GET', headers, signal, agent: false, lookup }, resolve);
    request.on('error', reject);
    request.end();
  });
}

/** What became of a request: a body to read for `200`, none for `304`. */
interface Answer {
  readonly status: 200 | 304;
  readonly headers: IncomingHttpHeaders;
  readonly body?: IncomingMessage | undefined;
}

/** The request of the registry, with what tells its failures apart. */
interface Exchange {
  readonly shown: string;
  readonly deadline: AbortSignal;
  readonly signal: AbortSignal;
  readonly options: HttpGetOptions;
}

/** Turns what went wrong into what is said: a timeout, a shutdown, a refusal. */
function failure(error: unknown, exchange: Exchange): Error {
  const { shown, deadline, options } = exchange;
  if (error instanceof MoonCGError) return error;
  if (deadline.aborted) {
    return new MoonCGError(
      'timeout',
      `${shown} did not answer within ${Math.round(options.timeoutMs / 1000)} s`,
    );
  }
  if (options.signal?.aborted) return new MoonCGError('unavailable', 'The server is shutting down');
  if (error instanceof Refused) return refuse(`${shown}: ${error.message}`);
  const storage = storageProblem(error);
  if (storage !== undefined) return storageError(storage);
  // What the network layer says may quote the address; it goes out without credentials.
  const cause = (error as { cause?: unknown }).cause;
  const said = cause === undefined ? errorMessage(error) : errorMessage(cause);
  return refuse(`${shown} could not be reached: ${withoutCredentials(said)}`);
}

/**
 * The one way the server fetches over the network for the registry: `https://`, or plain
 * `http://` on this machine where the policy allows it, never an internal address, with every
 * redirect checked like the first address, a bounded number of them, and one deadline for all
 * of it, body included. Credentials go as a header, to the origin they were given for alone,
 * and appear in no message.
 */
async function httpGet(
  url: string,
  policy: NetworkPolicy,
  exchange: Exchange,
  options: {
    readonly headers?: Readonly<Record<string, string>> | undefined;
    readonly accept?: ((type: string | undefined) => string | undefined) | undefined;
  },
): Promise<Answer> {
  const { shown, signal } = exchange;
  const settings = exchange.options;
  const first = addressProblem(url, policy);
  if (first !== undefined) throw refuse(`${shown}: ${first}`);
  let current = new URL(url);
  const max = settings.maxRedirects ?? MAX_REDIRECTS;
  for (let hop = 0; ; hop++) {
    current.username = '';
    current.password = '';
    const headers: Record<string, string> = { ...options.headers };
    // Never to another origin a redirect leads to: the credentials are for that one.
    if (policy.credentials !== undefined && current.origin === policy.credentials.origin) {
      headers.authorization = policy.credentials.header;
    }
    // Made for each hop: plain http:// to a host elsewhere goes to an allowed private address only.
    const lookup = guardedLookup(policy, settings.resolve, isPlainRemote(current));
    const response = await send(current, headers, signal, lookup);
    const status = response.statusCode ?? 0;
    if (REDIRECTS.has(status)) {
      response.destroy();
      const location = response.headers.location;
      if (hop >= max) throw refuse(`${shown}: more than ${max} redirects`);
      if (location === undefined) throw refuse(`${shown}: a redirect without a location`);
      const next = URL.canParse(location, current.href)
        ? new URL(location, current.href)
        : undefined;
      // A redirect is held to the policy of the request: one that started elsewhere than this
      // machine never leads here. A `\` is refused as written, before `URL` reads it as `/`.
      const problem =
        next === undefined
          ? 'redirects to an address that is no address'
          : location.includes('\\')
            ? 'the address must not contain "\\"'
            : (registryUrlProblem(next.href, {
                credentials: false,
                loopback: policy.loopback,
                plainHttp: plainHttpFor(policy),
              }) ?? addressProblem(next.href, policy));
      if (next === undefined || problem !== undefined) {
        throw refuse(`${shown}: a redirect was refused: ${problem}`);
      }
      current = next;
      continue;
    }
    if (status === 304) {
      response.destroy();
      return { status: 304, headers: response.headers };
    }
    if (status !== 200) {
      response.destroy();
      throw refuse(`${shown} answered ${status}`);
    }
    const type = response.headers['content-type'];
    const wrong = options.accept?.(type);
    if (wrong !== undefined) {
      response.destroy();
      throw refuse(`${shown}: ${wrong}`);
    }
    const declared = Number(response.headers['content-length'] ?? Number.NaN);
    if (declared > settings.maxBytes) {
      response.destroy();
      throw tooLarge(exchange);
    }
    // The deadline holds for the body too.
    const stop = () => response.destroy(new Error('aborted'));
    signal.addEventListener('abort', stop, { once: true });
    response.once('close', () => signal.removeEventListener('abort', stop));
    return { status: 200, headers: response.headers, body: response };
  }
}

const tooLarge = (exchange: Exchange) =>
  refuse(`${exchange.shown} is larger than ${exchange.options.maxBytes} bytes`);

/** One deadline for a whole request, ended early by `options.signal` too. */
function exchangeFor(url: string, options: HttpGetOptions): Exchange {
  const deadline = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
  return { shown: withoutCredentials(url), deadline, signal, options };
}

/** The credentials an address holds, as a header for its origin, if it holds any. */
function credentialsOf(url: string): NetworkPolicy['credentials'] {
  const parsed = new URL(url);
  if (parsed.username === '' && parsed.password === '') return undefined;
  const user = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  return {
    origin: parsed.origin,
    header: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`,
  };
}

/**
 * The policy of an index, and of what it lists: this machine only for an index on this
 * machine, and its credentials for its own origin. An address that is not usable gets no
 * credentials read; it is refused before anything connects.
 */
function indexPolicy(index: string, access: PrivateNetworks | undefined): NetworkPolicy {
  return {
    loopback: isLoopbackRegistryUrl(index),
    private: access,
    credentials: indexUrlProblem(index, access) === undefined ? credentialsOf(index) : undefined,
  };
}

export type JsonAnswer =
  | {
      readonly status: 'ok';
      readonly value: unknown;
      readonly etag?: string | undefined;
      readonly lastModified?: string | undefined;
    }
  | { readonly status: 'not-modified' };

/**
 * Fetches a JSON document, such as an index. With the validators of the copy that is held,
 * the request is conditional, and an unchanged document answers `not-modified`. This machine
 * is asked only for an index on this machine.
 */
export async function getJson(
  url: string,
  options: HttpGetOptions & {
    readonly etag?: string | undefined;
    readonly lastModified?: string | undefined;
  },
): Promise<JsonAnswer> {
  const exchange = exchangeFor(url, options);
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.etag !== undefined) headers['if-none-match'] = options.etag;
  if (options.lastModified !== undefined) headers['if-modified-since'] = options.lastModified;
  const chunks: Buffer[] = [];
  let answer: Answer;
  try {
    answer = await httpGet(url, indexPolicy(url, options.private), exchange, {
      headers,
      accept: (type) =>
        isJsonType(type) ? undefined : `the content type is ${type ?? 'missing'}, not JSON`,
    });
    let received = 0;
    for await (const chunk of answer.body ?? []) {
      received += (chunk as Buffer).length;
      if (received > options.maxBytes) {
        answer.body?.destroy();
        throw tooLarge(exchange);
      }
      chunks.push(chunk as Buffer);
    }
  } catch (error) {
    throw failure(error, exchange);
  }
  if (answer.status === 304) return { status: 'not-modified' };
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    throw refuse(`${exchange.shown} is not valid JSON: ${errorMessage(error)}`);
  }
  const text = (value: string | string[] | undefined) =>
    typeof value === 'string' ? value : undefined;
  const etag = text(answer.headers.etag);
  const lastModified = text(answer.headers['last-modified']);
  return {
    status: 'ok',
    value,
    ...(etag === undefined ? {} : { etag }),
    ...(lastModified === undefined ? {} : { lastModified }),
  };
}

/**
 * Downloads a file, such as a ZIP archive, into `file`, which must not exist, and says the
 * SHA-256 of what arrived. The checksum is computed as it arrives, not read back. `index` is
 * the address of the index that lists it, credentials included: only an index on this
 * machine may point to this machine, and its credentials go to its own origin. Without it the
 * address is asked like an index on the internet. On every failure the file is removed, if it
 * was made here.
 */
export async function download(
  url: string,
  file: string,
  options: HttpGetOptions & { readonly index?: string | undefined },
): Promise<{ readonly sha256: string; readonly bytes: number }> {
  const exchange = exchangeFor(url, options);
  const hash = createHash('sha256');
  let bytes = 0;
  let made = false;
  try {
    // An address of its own is asked like an index on the internet, with what it holds.
    const policy: NetworkPolicy =
      options.index === undefined
        ? {
            loopback: false,
            private: options.private,
            credentials: indexPolicy(url, options.private).credentials,
          }
        : indexPolicy(options.index, options.private);
    const answer = await httpGet(url, policy, exchange, {});
    const counting = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        bytes += chunk.length;
        if (bytes > options.maxBytes) return done(tooLarge(exchange));
        hash.update(chunk);
        done(null, chunk);
      },
    });
    const out = createWriteStream(file, { flags: 'wx' });
    out.once('open', () => {
      made = true;
    });
    await pipeline(answer.body as IncomingMessage, counting, out);
  } catch (error) {
    if (made) await rm(file, { force: true }).catch(() => {});
    throw failure(error, exchange);
  }
  return { sha256: hash.digest('hex'), bytes };
}
