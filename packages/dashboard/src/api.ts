/** An answer of the server that is an error: `{ error: { code, message } }`. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * The one way the dashboard talks to the server's REST API. Requests that change something
 * always carry JSON, which is what the server asks of requests authenticated by a cookie.
 * `request` and `upload` are properties so that tests can put their own in their place.
 */
export const api = {
  /** Called when the server says nobody is signed in. */
  onUnauthenticated(): void {
    location.assign('/login');
  },

  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const sends = method !== 'GET';
    const response = await fetch(path, {
      method,
      ...(sends
        ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }
        : {}),
    });
    return answerOf<T>(response);
  },

  /**
   * Uploads a file as the body of a `PUT`. An upload is no JSON, so it carries the header
   * the server asks of such a request instead.
   */
  async upload<T = unknown>(path: string, file: Blob): Promise<T> {
    const response = await fetch(path, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream', 'x-mooncg-csrf': '1' },
      body: file,
    });
    return answerOf<T>(response);
  },
};

/** The body of an answer, or the error it stands for. */
async function answerOf<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  const answer = (await response.json().catch(() => undefined)) as
    | { error?: { code?: string; message?: string } }
    | undefined;
  if (!response.ok) {
    if (response.status === 401) api.onUnauthenticated();
    throw new ApiError(
      response.status,
      answer?.error?.code ?? 'internal',
      answer?.error?.message ?? `The server answered ${response.status}`,
    );
  }
  return answer as T;
}

/** The message of whatever was thrown, for showing it. */
export const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
