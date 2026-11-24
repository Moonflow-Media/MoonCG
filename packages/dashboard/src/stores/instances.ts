import { defineStore } from 'pinia';
import { computed, effectScope, reactive, watch } from 'vue';
import { live } from '../live.js';
import { useBundles } from './bundles.js';

/** One page that shows a graphic right now, as the server lists it. */
export interface Instance {
  readonly id: string;
  readonly since: string;
}

/**
 * The pages that show each graphic right now, from the replicants
 * `<bundle>:$instances.<graphic>`. They are followed while someone asks for it: the shell for
 * the count in the navigation, the graphics page for its lists.
 */
export const useInstances = defineStore('instances', () => {
  const bundles = useBundles();
  /** The connected pages of each graphic, by `bundle:graphic`. Nothing for a list not told yet. */
  const byGraphic = reactive(new Map<string, readonly Instance[]>());
  const following = new Map<string, () => void>();
  const listeners = new Set<(bundle: string) => void>();
  // Of its own, so that it does not end with the component that happened to ask first.
  const scope = effectScope(true);
  let stopWatching: (() => void) | undefined;
  let followers = 0;

  const keys = () =>
    bundles.list.flatMap((bundle) => bundle.graphics.map((item) => `${bundle.name}:${item.id}`));

  /** Follows the list of every graphic there is, and lets go of those that are gone. */
  const sync = () => {
    const wanted = new Set(keys());
    for (const [key, stop] of following) {
      if (wanted.has(key)) continue;
      stop();
      following.delete(key);
      byGraphic.delete(key);
    }
    for (const key of wanted) {
      if (following.has(key)) continue;
      const [bundle, graphic] = key.split(':') as [string, string];
      following.set(
        key,
        live.follow<readonly Instance[]>(`${bundle}:$instances.${graphic}`, (value) => {
          byGraphic.set(key, Array.isArray(value) ? value : []);
          for (const listener of [...listeners]) listener(bundle);
        }),
      );
    }
  };

  /** How many graphics are open somewhere. */
  const open = computed(() => [...byGraphic.values()].filter((list) => list.length > 0).length);

  /**
   * Follows the lists until the returned function is called. `onChange` is told the bundle
   * whenever one of its lists arrives, and at once each bundle whose lists are here already:
   * someone else may have followed them for a while.
   */
  function follow(onChange?: (bundle: string) => void): () => void {
    if (onChange) {
      listeners.add(onChange);
      const known = new Set([...byGraphic.keys()].map((key) => key.split(':')[0] as string));
      for (const bundle of known) onChange(bundle);
    }
    if (++followers === 1) {
      stopWatching = scope.run(() => watch(() => keys().join(), sync, { immediate: true }));
    }
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      if (onChange) listeners.delete(onChange);
      if (--followers > 0) return;
      stopWatching?.();
      for (const stop of following.values()) stop();
      following.clear();
      byGraphic.clear();
    };
  }

  return { byGraphic, open, follow };
});
