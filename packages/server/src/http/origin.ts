import type { IncomingHttpHeaders } from 'node:http';
import type { Manifest } from '@mooncg/core';

/**
 * The origins of the development servers the running bundles name in `dev.url`. In dev mode
 * a bundle's pages are served from there, so pages of these origins may open a socket, send
 * requests and be framed by the dashboard. Outside dev mode nobody asks for this list.
 */
export function devOrigins(
  bundles: readonly { readonly state: string; readonly manifest: Manifest | undefined }[],
): string[] {
  const origins = bundles.flatMap(({ state, manifest }) =>
    state === 'running' && manifest?.dev ? [new URL(manifest.dev.url).origin] : [],
  );
  return [...new Set(origins)].sort();
}

/** The address a request for a file of a bundle is sent on to: the same file on `devUrl`. */
export function devServerUrl(devUrl: string, file: string, query: string | undefined): string {
  const base = new URL(devUrl);
  const prefix = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
  const path = file.split('/').map(encodeURIComponent).join('/');
  return `${base.origin}${prefix}${path}${query === undefined ? '' : `?${query}`}`;
}

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
