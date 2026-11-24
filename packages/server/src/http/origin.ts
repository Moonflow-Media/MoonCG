import type { IncomingHttpHeaders } from 'node:http';

/**
 * Whether a request may come from where it says it comes from. A browser page states its
 * origin in the `Origin` header: it is accepted when the page was loaded from this server
 * (same scheme, host and port as the request is addressed to) or from an allowed origin.
 * `https` says whether the server is reached over HTTPS, which only a trusted proxy can tell.
 * A request without `Origin` does not come from a page of another site (a command line tool,
 * OBS, a script) and is accepted. This is what keeps another website from driving the server
 * through a visitor's browser; it is not authentication.
 */
export function originAllowed(
  headers: IncomingHttpHeaders,
  allowedOrigins: readonly string[],
  https = false,
): boolean {
  const { origin } = headers;
  if (origin === undefined) return true;
  if (!URL.canParse(origin)) return false;
  const parsed = new URL(origin);
  const own =
    parsed.protocol === (https ? 'https:' : 'http:') && parsed.host === headers.host?.toLowerCase();
  return own || allowedOrigins.includes(parsed.origin);
}
