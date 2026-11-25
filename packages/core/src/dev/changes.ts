/**
 * What a changed file of a bundle belongs to. `extension` is everything the bundle's extension
 * runs (`extension/` and `shared/`), `other` everything that calls for nothing.
 */
export const CHANGE_AREAS = [
  'manifest',
  'extension',
  'dashboard',
  'graphics',
  'schemas',
  'other',
] as const;
export type ChangeArea = (typeof CHANGE_AREAS)[number];

const MANIFEST_FILE = 'mooncg.json';

const segments = (path: string) => path.split(/[\\/]/);

/**
 * Whether a path inside a bundle is never watched: `node_modules`, `.git`, and every folder
 * or file whose name starts with a dot, at any depth. `path` is relative to the bundle.
 */
export function isIgnoredPath(path: string): boolean {
  if (path === '') return true;
  return segments(path).some((part) => part === 'node_modules' || part.startsWith('.'));
}

/**
 * The area a changed path belongs to. `path` is relative to the bundle folder, with either
 * separator. `schemaFiles` are the schema files the manifest names, for those that do not lie
 * in `schemas/`.
 */
export function changeArea(path: string, schemaFiles: readonly string[] = []): ChangeArea {
  if (isIgnoredPath(path)) return 'other';
  const parts = segments(path);
  const normalized = parts.join('/');
  if (normalized === MANIFEST_FILE) return 'manifest';
  if (schemaFiles.includes(normalized)) return 'schemas';
  // A folder itself, as when it is created, is no change to what is in it.
  if (parts.length < 2) return 'other';
  switch (parts[0]) {
    case 'extension':
    case 'shared':
      return 'extension';
    case 'dashboard':
      return 'dashboard';
    case 'graphics':
      return 'graphics';
    case 'schemas':
      return 'schemas';
    default:
      return 'other';
  }
}

export interface ReloadOptions {
  /** Whether the server runs in dev mode. Only then does a graphic reload by itself. */
  readonly dev: boolean;
  /**
   * Whether the bundle's manifest names a development server (`dev.url`). In dev mode that
   * server reloads the pages itself, so MoonCG leaves them alone.
   */
  readonly devUrl?: boolean | undefined;
  /** The schema files the manifest names, relative to the bundle. */
  readonly schemaFiles?: readonly string[] | undefined;
}

/** What changed files lead to. */
export interface ReloadPlan {
  /**
   * `reload` reads the manifest again and starts the bundle from what is on disk;
   * `restart-extension` starts only its extension again.
   */
  readonly bundle: 'reload' | 'restart-extension' | 'none';
  /** Whether the bundle's panel and dialog pages load themselves again. */
  readonly panels: boolean;
  /**
   * `reload` tells the bundle's graphic pages to load themselves again; `mark-out-of-date`
   * only marks them, and a person decides when each is reloaded.
   */
  readonly graphics: 'reload' | 'mark-out-of-date' | 'none';
}

/** The plan for a set of areas. See `planReload`. */
export function planForAreas(areas: Iterable<ChangeArea>, options: ReloadOptions): ReloadPlan {
  const touched = new Set(areas);
  const served = !(options.dev && options.devUrl === true);
  return {
    bundle:
      touched.has('manifest') || touched.has('schemas')
        ? 'reload'
        : touched.has('extension')
          ? 'restart-extension'
          : 'none',
    panels: served && touched.has('dashboard'),
    graphics: !touched.has('graphics')
      ? 'none'
      : !options.dev
        ? // A graphic may be on air: outside dev mode nothing reloads it but a person.
          'mark-out-of-date'
        : served
          ? 'reload'
          : 'none',
  };
}

/**
 * Decides what the changed files of one bundle lead to. This is the whole rule of live
 * reload; whoever watches the disk only collects paths and carries the plan out.
 */
export function planReload(paths: readonly string[], options: ReloadOptions): ReloadPlan {
  return planForAreas(
    paths.map((path) => changeArea(path, options.schemaFiles)),
    options,
  );
}

/** Whether a plan asks for nothing. */
export function isIdlePlan(plan: ReloadPlan): boolean {
  return plan.bundle === 'none' && !plan.panels && plan.graphics === 'none';
}
