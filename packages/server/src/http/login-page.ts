import type { ProviderRegistry } from '../modules/providers.js';

export const escapeHtml = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

/** Where the login page has its links to the external providers put in. */
export const PROVIDERS_SLOT = '<!-- providers -->';

/**
 * The links of the login page to the external providers. They are links and not forms on
 * purpose: the policy of the page lets a form post back to this server only
 * (`form-action 'self'`), and browsers apply that to where a form is redirected as well, so
 * a form that ends at a provider would be blocked. A link is a plain navigation. Nothing is
 * loaded from the provider: the icon is a file this server serves. The id of a provider is
 * lowercase letters, digits and dashes, checked when it was registered; its name is escaped.
 */
export function providerLinks(providers: ProviderRegistry): string {
  const external = providers.external();
  if (external.length === 0) return '';
  const links = external.map(({ provider: { id, name, icon } }) => {
    const image =
      icon === undefined ? '' : `<img src="/auth/${id}/icon" alt="" width="18" height="18" />`;
    return `<a class="provider" href="/auth/${id}/start" data-provider="${id}">${image}<span>Sign in with ${escapeHtml(name)}</span></a>`;
  });
  return `<div class="providers"><p class="or">or</p>${links.join('')}</div>`;
}
