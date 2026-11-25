import type { BundlePages, ConnectedPage, Stylesheet } from '@mooncg/core';

/**
 * The connected pages of every bundle: panels, dialogs and graphics. A page is listed when
 * its session welcomed it and taken off when its connection ends. It is what lets the
 * server tell the pages of one bundle to load themselves again after its files changed.
 */
export class ConnectedPages implements BundlePages {
  readonly #pages = new Map<string, Set<ConnectedPage>>();

  join(bundle: string, page: ConnectedPage): () => void {
    let pages = this.#pages.get(bundle);
    if (!pages) {
      pages = new Set();
      this.#pages.set(bundle, pages);
    }
    pages.add(page);
    return () => {
      const listed = this.#pages.get(bundle);
      listed?.delete(page);
      if (listed?.size === 0) this.#pages.delete(bundle);
    };
  }

  /**
   * Tells the panel and dialog pages of a bundle, or its graphic pages, to load themselves
   * again. Answers how many were told.
   */
  reload(bundle: string, kind: 'panels' | 'graphics'): number {
    let told = 0;
    for (const page of [...(this.#pages.get(bundle) ?? [])]) {
      if (page.graphic !== (kind === 'graphics')) continue;
      try {
        page.reload();
        told++;
      } catch {
        // A socket that is closing cannot be told; its page is on its way out anyway.
      }
    }
    return told;
  }

  /**
   * Tells the panel and dialog pages of a bundle, or its graphic pages, that these
   * stylesheets changed, so that they load them again in place. Each page is named only the
   * ones its principal may fetch. Answers how many pages were told.
   */
  restyle(bundle: string, kind: 'panels' | 'graphics', styles: readonly Stylesheet[]): number {
    let told = 0;
    for (const page of [...(this.#pages.get(bundle) ?? [])]) {
      if (page.graphic !== (kind === 'graphics')) continue;
      try {
        page.restyle(styles);
        told++;
      } catch {
        // As above: a closing socket's page is on its way out anyway.
      }
    }
    return told;
  }

  /** How many pages are connected, of one bundle or of all. */
  count(bundle?: string): number {
    if (bundle !== undefined) return this.#pages.get(bundle)?.size ?? 0;
    let total = 0;
    for (const pages of this.#pages.values()) total += pages.size;
    return total;
  }
}
