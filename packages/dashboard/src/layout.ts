/** The grid has this many columns; a panel is between 1 and all of them wide. */
export const MAX_WIDTH = 12;
/** A panel is between 1 and this many rows high. */
export const MAX_HEIGHT = 6;
const DEFAULT_WIDTH = 3;
const DEFAULT_HEIGHT = 2;

/** Where a panel sits: the list order is the order on screen. */
export interface Placement {
  readonly id: string;
  readonly w: number;
  readonly h: number;
}

const clamp = (value: number, max: number) => Math.min(max, Math.max(1, Math.round(value)));

/**
 * Combines the panels there are with the layout a user saved: saved panels keep their order
 * and size, panels that are gone drop out, new ones are appended with the width their
 * manifest asks for. Whatever was saved is checked, because it comes back from a server.
 */
export function arrange(
  panels: readonly { readonly id: string; readonly width?: number | undefined }[],
  saved: unknown,
): Placement[] {
  const known = new Set(panels.map((panel) => panel.id));
  const placed: Placement[] = [];
  for (const entry of Array.isArray(saved) ? saved : []) {
    const { id, w, h } = (entry ?? {}) as Partial<Placement>;
    if (typeof id !== 'string' || !known.has(id) || placed.some((item) => item.id === id)) continue;
    placed.push({
      id,
      w: clamp(typeof w === 'number' ? w : DEFAULT_WIDTH, MAX_WIDTH),
      h: clamp(typeof h === 'number' ? h : DEFAULT_HEIGHT, MAX_HEIGHT),
    });
  }
  for (const { id, width } of panels) {
    if (placed.some((item) => item.id === id)) continue;
    placed.push({ id, w: clamp(width ?? DEFAULT_WIDTH, MAX_WIDTH), h: DEFAULT_HEIGHT });
  }
  return placed;
}

/** Moves a panel one place towards the start (-1) or the end (1). */
export function move(list: readonly Placement[], id: string, delta: -1 | 1): Placement[] {
  const from = list.findIndex((item) => item.id === id);
  const to = from + delta;
  const next = [...list];
  if (from < 0 || to < 0 || to >= list.length) return next;
  [next[from], next[to]] = [next[to] as Placement, next[from] as Placement];
  return next;
}

/** Changes a panel's width and height by the given steps, within the grid. */
export function resize(
  list: readonly Placement[],
  id: string,
  dw: number,
  dh: number,
): Placement[] {
  return list.map((item) =>
    item.id === id
      ? { id, w: clamp(item.w + dw, MAX_WIDTH), h: clamp(item.h + dh, MAX_HEIGHT) }
      : item,
  );
}
