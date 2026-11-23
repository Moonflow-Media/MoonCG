import { grantMatches } from './authorize.js';

/**
 * Capabilities are what a bundle's extension asks for in its manifest (`capabilities`).
 * They limit the extension itself, where permissions limit the people using the bundle.
 *
 * - `bundle:<name>:read`: read replicants of bundle `<name>` and listen to its messages.
 * - `bundle:<name>:write`: write its replicants and send it messages and requests.
 * - `http.routes`: register HTTP routes under `/b/<own bundle>/api/`.
 *
 * `<name>` may be `*`. An extension needs no capability for its own bundle.
 */
export type BundleAccess = 'read' | 'write';

export const HTTP_ROUTES_CAPABILITY = 'http.routes';

export function bundleCapability(target: string, access: BundleAccess): string {
  return `bundle:${target}:${access}`;
}

export function hasCapability(capabilities: readonly string[], capability: string): boolean {
  const wanted = capability.split(':');
  return capabilities.some((granted) => grantMatches(granted, wanted));
}
