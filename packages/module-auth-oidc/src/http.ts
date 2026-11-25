/** How long a provider may take to answer one request. */
export const REQUEST_TIMEOUT_MS = 10_000;
/** The largest answer of a provider that is read: 1 MiB. None of them is near that. */
const MAX_ANSWER_BYTES = 1024 * 1024;

const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * Checks an address of a provider and returns it. It must be `https://`: what travels there
 * is a client secret, a code and tokens, and what comes back decides who signs in. The one
 * exception is plain `http://` to this machine by a loopback name, for a provider that runs
 * here: a test, or one behind a tunnel on the same host. No user name or password in it.
 */
export function providerUrl(text: unknown, what: string): URL {
  const url = typeof text === 'string' && URL.canParse(text) ? new URL(text) : undefined;
  if (!url) throw new Error(`${what} is not an address: ${JSON.stringify(text)}`);
  const host = url.hostname.toLowerCase();
  const loopback = host === 'localhost' || host === '[::1]' || LOOPBACK_V4.test(host);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(
      `${what} must be an https:// address (plain http:// only to this machine): ${url.origin}`,
    );
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error(`${what} must not hold a user name or a password`);
  }
  return url;
}

export type Fetch = typeof fetch;

/**
 * Asks a provider and reads its answer as JSON. Redirects are not followed: an endpoint that
 * was checked must not hand the request, with what it carries, on to another.
 */
export async function requestJson(
  send: Fetch,
  url: URL,
  init: { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: string },
  what: string,
): Promise<{ status: number; json: unknown }> {
  let response: Response;
  try {
    response = await send(url, {
      ...init,
      headers: { accept: 'application/json', ...init.headers },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`${what} could not be reached: ${(error as Error).message}`);
  }
  const text = await boundedText(response, what);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, json };
}

/**
 * The body of an answer as text, read piece by piece and no further than `MAX_ANSWER_BYTES`.
 * An answer that is longer, by what it states or by what it sends, is given up on at that
 * point: the rest is not taken, and the other end is told that nobody is reading. So a
 * provider, or whoever answers in its place, cannot make this server hold what it sends.
 */
async function boundedText(response: Response, what: string): Promise<string> {
  const tooMuch = () => new Error(`${what} answered with too much`);
  const stated = Number(response.headers.get('content-length') ?? '0');
  if (stated > MAX_ANSWER_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw tooMuch();
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_ANSWER_BYTES) throw tooMuch();
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (bytes > MAX_ANSWER_BYTES) throw error;
    throw new Error(`${what} could not be read: ${(error as Error).message}`);
  }
  return text + decoder.decode();
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]+/g;

/** A text a provider sent, as it may be put into a log line: short and without control characters. */
export function shown(value: unknown): string {
  return String(value).replace(CONTROL, ' ').slice(0, 200);
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** How a client proves to the token endpoint that it is the client. */
export type ClientAuth = 'basic' | 'post';

/**
 * Redeems an authorization code at a token endpoint and returns what it answered. The client
 * secret goes into the `Authorization` header (`basic`) or the form (`post`), as the provider
 * wants it; a client without a secret names itself in the form. The PKCE verifier always
 * goes along.
 */
export async function redeemCode(
  send: Fetch,
  endpoint: URL,
  request: {
    readonly code: string;
    readonly redirectUri: string;
    readonly codeVerifier: string;
    readonly clientId: string;
    readonly clientSecret: string | undefined;
    readonly clientAuth: ClientAuth;
  },
): Promise<Record<string, unknown>> {
  const { clientId, clientSecret, clientAuth } = request;
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: request.code,
    redirect_uri: request.redirectUri,
    code_verifier: request.codeVerifier,
  });
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
  };
  if (clientSecret !== undefined && clientAuth === 'basic') {
    // RFC 6749 2.3.1: both parts are form-encoded before they are joined and base64-encoded.
    const encode = (part: string) => new URLSearchParams({ v: part }).toString().slice(2);
    const pair = `${encode(clientId)}:${encode(clientSecret)}`;
    headers.authorization = `Basic ${Buffer.from(pair).toString('base64')}`;
  } else {
    form.set('client_id', clientId);
    if (clientSecret !== undefined) form.set('client_secret', clientSecret);
  }
  const { status, json } = await requestJson(
    send,
    endpoint,
    { method: 'POST', headers, body: form.toString() },
    'The token endpoint',
  );
  if (status !== 200 || !isRecord(json)) {
    const reason = isRecord(json) && json.error !== undefined ? `: ${shown(json.error)}` : '';
    throw new Error(`The token endpoint refused the code (${status})${reason}`);
  }
  return json;
}

/** The code of a callback. Throws with what the provider said when it sent an error instead. */
export function codeOf(query: Readonly<Record<string, string>>): string {
  if (query.error !== undefined) {
    throw new Error(`The provider answered with the error "${shown(query.error)}"`);
  }
  if (typeof query.code !== 'string' || query.code === '') {
    throw new Error('The provider sent no code');
  }
  return query.code;
}

/** What is set at the authorization endpoint for every provider. */
export function authorizationUrl(
  endpoint: URL,
  parameters: Readonly<Record<string, string | undefined>>,
): string {
  const url = new URL(endpoint);
  for (const [name, value] of Object.entries(parameters)) {
    if (value !== undefined) url.searchParams.set(name, value);
  }
  return url.href;
}
