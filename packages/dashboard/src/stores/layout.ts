import { defineStore } from 'pinia';
import { ref } from 'vue';
import { ApiError, api, messageOf } from '../api.js';
import { arrange, move as moved, type Placement, resize as resized } from '../layout.js';

/** The longest a preference key may be, and what every layout key starts with. */
const MAX_KEY_LENGTH = 64;
const KEY_PREFIX = 'layout.';

/** A short, stable number for a text (FNV-1a), as eight hex digits. */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * The key a workspace's layout is stored under, made of what the server takes in a key.
 * Different names get different keys: lowercase letters and digits stand for themselves,
 * and every other character is written as its number between underscores, so `A b` and
 * `a-b` do not end up as the same key. A name too long for that keeps its beginning and
 * gets a fingerprint of the whole name after a dot, which no short name contains.
 */
export function layoutKey(workspace: string): string {
  const encoded = [...workspace]
    .map((char) => (/[a-z0-9]/.test(char) ? char : `_${char.codePointAt(0)?.toString(16)}_`))
    .join('');
  const room = MAX_KEY_LENGTH - KEY_PREFIX.length;
  if (encoded === '') return `${KEY_PREFIX}_`;
  if (encoded.length <= room) return `${KEY_PREFIX}${encoded}`;
  return `${KEY_PREFIX}${encoded.slice(0, room - 9)}.${fingerprint(workspace)}`;
}

/** The panel ids in whatever was saved as a layout. It comes back from a server, so it is checked. */
function idsOf(saved: unknown): string[] {
  return (Array.isArray(saved) ? saved : [])
    .map((entry) => (entry as { id?: unknown } | null)?.id)
    .filter((id) => typeof id === 'string');
}

/**
 * How each workspace is laid out for the signed-in user. Layouts are kept on the server
 * (`/api/v1/me/prefs/layout.<workspace>`), so they follow the user to another browser.
 */
export const useLayout = defineStore('layout', () => {
  const byWorkspace = ref<Record<string, Placement[]>>({});
  /** The panels a workspace's layout holds, or held, that are not there to show. */
  const absent = ref<Record<string, string[]>>({});
  /** Why the last change could not be saved; empty when it could. */
  const problem = ref('');
  const of = (workspace: string): Placement[] => byWorkspace.value[workspace] ?? [];
  /** The ids of the panels the layout of a workspace knows but that are not on the page. */
  const absentOf = (workspace: string): string[] => absent.value[workspace] ?? [];

  async function load(
    workspace: string,
    panels: readonly { readonly id: string; readonly width?: number | undefined }[],
  ): Promise<void> {
    let saved: unknown;
    try {
      const path = `/api/v1/me/prefs/${layoutKey(workspace)}`;
      saved = (await api.request<{ value: unknown }>('GET', path)).value;
    } catch (error) {
      // Nothing saved yet, or not a user who can save: the default layout it is.
      if (!(error instanceof ApiError)) throw error;
    }
    // What was saved, what was on the page until now and what was missing before: a panel
    // of these that is not there now is remembered, so that the page can say why. Saving
    // a layout drops it from what is stored, so this lasts as long as the page.
    const known = new Set(panels.map((panel) => panel.id));
    const before = [
      ...idsOf(saved),
      ...of(workspace).map((item) => item.id),
      ...absentOf(workspace),
    ];
    absent.value = {
      ...absent.value,
      [workspace]: [...new Set(before)].filter((id) => !known.has(id)),
    };
    byWorkspace.value = { ...byWorkspace.value, [workspace]: arrange(panels, saved) };
  }

  async function store(workspace: string, next: Placement[]): Promise<void> {
    byWorkspace.value = { ...byWorkspace.value, [workspace]: next };
    // The change shows at once. If saving fails the user is told, because otherwise the
    // layout would silently be gone after a reload.
    try {
      await api.request('PUT', `/api/v1/me/prefs/${layoutKey(workspace)}`, { value: next });
      problem.value = '';
    } catch (error) {
      problem.value = `The layout could not be saved: ${messageOf(error)}`;
    }
  }
  const move = (workspace: string, id: string, delta: -1 | 1) =>
    store(workspace, moved(of(workspace), id, delta));
  const resize = (workspace: string, id: string, dw: number, dh: number) =>
    store(workspace, resized(of(workspace), id, dw, dh));

  return { byWorkspace, problem, of, absentOf, load, move, resize };
});
