/** Where the server is and how the command line shows who it is. */
export interface ApiArgs {
  /** Where the server listens, such as `http://127.0.0.1:9090`. */
  readonly url: string;
  /** The API token. It goes into the `Authorization` header and nowhere else. */
  readonly token: string | undefined;
  /** Send the token over plain http also to a server on another machine. */
  readonly insecure: boolean;
}

export interface ApiDeps {
  /** Told what the person at the terminal should know but did not ask for. */
  warn?(line: string): void;
  /** For tests: stands in for `fetch`. */
  readonly fetch?: typeof fetch | undefined;
}

/** Asks the server. Rejects with what it said when it refuses. */
export type ApiCall = <T>(method: string, path: string, body?: unknown | Blob) => Promise<T>;

/**
 * What the server said, as it may be printed: on one line and without control characters.
 * A manifest is written by whoever wrote the bundle; an escape sequence in it could redraw
 * the terminal and hide what is being asked.
 */
export function printable(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the point
  return text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ');
}

/** An address as it may be shown: without the user name and password in it. */
function shownUrl(url: URL): string {
  const copy = new URL(url);
  copy.username = '';
  copy.password = '';
  return copy.toString().replace(/\/$/, '');
}

/**
 * The way the command line talks to the API of a running server: with an API token as a
 * bearer, which `permission` says what it must hold. The address is checked once, when the
 * first request is about to go there: the token is not sent over plain http to another
 * machine unless that was asked for.
 */
export function createApiClient(args: ApiArgs, deps: ApiDeps, permission: string): ApiCall {
  const send = deps.fetch ?? fetch;
  let checked: { readonly base: string; readonly shown: string } | undefined;
  const server = () => {
    if (checked) return checked;
    const url = URL.canParse(args.url) ? new URL(args.url) : undefined;
    if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
      throw new Error('--url must be the address of the server, such as http://127.0.0.1:9090');
    }
    const shown = shownUrl(url);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const local = host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
    if (url.protocol === 'http:' && !local) {
      if (!args.insecure) {
        throw new Error(
          `${shown} is plain http on another machine: the API token would cross the network unencrypted. ` +
            'Use an https:// address, or pass --insecure if the network is yours.',
        );
      }
      deps.warn?.(`Warning: the API token is sent to ${shown} unencrypted (--insecure).`);
    }
    checked = { base: shown, shown };
    return checked;
  };

  return async <T>(method: string, path: string, body?: unknown | Blob): Promise<T> => {
    if (args.token === undefined || args.token === '') {
      throw new Error(
        `No API token given. Set MOONCG_TOKEN or pass --token; the token must hold ${permission}.`,
      );
    }
    const { base, shown } = server();
    const upload = body instanceof Blob;
    let response: Response;
    try {
      response = await send(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${args.token}`,
          ...(body === undefined
            ? {}
            : { 'content-type': upload ? 'application/zip' : 'application/json' }),
        },
        ...(body === undefined ? {} : { body: upload ? body : JSON.stringify(body) }),
      });
    } catch {
      throw new Error(`No MoonCG server answers at ${shown}. Is it running? Check --url.`);
    }
    if (response.status === 204) return undefined as T;
    const answer = (await response.json().catch(() => undefined)) as
      | { error?: { message?: string } }
      | undefined;
    if (response.ok) return answer as T;
    if (response.status === 401) throw new Error('The server did not accept the API token.');
    throw new Error(printable(answer?.error?.message ?? `The server answered ${response.status}`));
  };
}
