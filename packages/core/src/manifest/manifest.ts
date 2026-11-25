import { z } from 'zod';
import { jsonProblem } from '../json.js';
import { BUNDLE_NAME_PATTERN, isReservedDeviceName } from '../names.js';
import { isLoopbackHost } from '../net.js';
import { isSafeRelativePath } from '../paths.js';

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const PERMISSION_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;
const MEMBER_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.-]*$/;

const id = z
  .string()
  .regex(BUNDLE_NAME_PATTERN, 'Must be lowercase letters, digits and single dashes');
const permissionName = z
  .string()
  .regex(PERMISSION_NAME_PATTERN, 'Must be a lowercase permission name');
const memberName = z
  .string()
  .regex(
    MEMBER_NAME_PATTERN,
    'Must start with a letter and contain only letters, digits, "_", "." or "-"',
  );
const file = z
  .string()
  .max(500)
  .refine(isSafeRelativePath, 'Must be a relative path inside the bundle, without ".." or "\\"');
/** Panels and graphics are served from fixed folders, so their URL follows from their file. */
const fileIn = (dir: string) =>
  z
    .string()
    .max(500)
    .refine(
      (path) => isSafeRelativePath(path) && path.startsWith(`${dir}/`),
      `Must be a file under ${dir}/, without ".." or "\\"`,
    );
const positiveInt = z.int().positive();

/**
 * The address of a bundle's development server. Requests for the bundle's pages are sent
 * there in dev mode, so it may only ever be this machine: no other host, no credentials, and
 * nothing after the path.
 */
const DEV_URL =
  /^https?:\/\/(localhost|\d{1,3}(?:\.\d{1,3}){3}|\[::1\])(?::(\d{1,5}))?(\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?$/i;

function isDevUrl(text: string): boolean {
  // Read by hand: this package has no `URL`, and nothing but this exact shape is wanted.
  const match = DEV_URL.exec(text);
  if (!match) return false;
  const [, host = '', port] = match;
  return isLoopbackHost(host) && (port === undefined || Number(port) <= 65535);
}

/**
 * A manifest is shown to people before its bundle is trusted: in the dashboard, on a
 * terminal and in the log. So what it says is bounded, generously, and holds no control
 * characters, which could redraw a terminal or hide what follows.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const shown = (max: number, min = 1) =>
  z
    .string()
    .min(min)
    .max(max, `Must be at most ${max} characters`)
    .refine((text) => !CONTROL.test(text), 'Must not contain control characters');
const title = shown(200);
/** How many entries a list or a table of the manifest may have. */
const atMost = (max: number) => ({
  check: (value: object) => Object.keys(value).length <= max,
  message: `Must have at most ${max} entries`,
});
const few = atMost(200);
const some = atMost(500);
const lots = atMost(2000);

const panel = z.strictObject({
  id,
  title,
  file: fileIn('dashboard'),
  /** Width in dashboard grid columns. */
  width: positiveInt.default(3),
  workspace: shown(100).optional(),
  requires: permissionName.optional(),
});

const dialog = z.strictObject({
  id,
  title: title.optional(),
  file: fileIn('dashboard'),
  width: positiveInt.default(3),
  requires: permissionName.optional(),
});

const graphic = z.strictObject({
  id,
  title: title.optional(),
  file: fileIn('graphics'),
  width: positiveInt,
  height: positiveInt,
  singleInstance: z.boolean().optional(),
  requires: permissionName.optional(),
});

const replicant = z.strictObject({
  /** Initial value until a persisted one exists. Without it the replicant starts as `null`. */
  default: z.json().optional(),
  schema: file.optional(),
  persistent: z.boolean().optional(),
  read: permissionName.optional(),
  write: permissionName.optional(),
});

const message = z.strictObject({
  send: permissionName.optional(),
  listen: permissionName.optional(),
});

const asset = z.strictObject({
  id,
  title: title.optional(),
  /**
   * What may be uploaded: file extensions such as `.png` and media types such as `image/*`.
   * Without it, or with the entry for every media type (a star on both sides of the
   * slash), any file. An empty list would take nothing and is refused.
   */
  accept: z
    .array(shown(100))
    .min(1, 'Must name at least one kind of file')
    .max(100, 'Must have at most 100 entries')
    .optional(),
  /** Needed to list and load the files. Without it, any permission of the bundle. */
  read: permissionName.optional(),
  /** Needed to upload and delete. Without it, `system:bundles.manage`. */
  write: permissionName.optional(),
});

export const manifestSchema = z.strictObject({
  $schema: z.string().optional(),
  manifest: z.literal(1),
  kind: z.enum(['bundle', 'module']),
  name: z
    .string()
    .max(100)
    .regex(BUNDLE_NAME_PATTERN, 'Must be lowercase letters, digits and single dashes')
    .refine(
      (name) => !isReservedDeviceName(name),
      'Must not be a name that Windows reserves for a device',
    ),
  version: z.string().max(100).regex(SEMVER_PATTERN, 'Must be a semantic version such as 1.2.3'),
  title: title.optional(),
  engine: z.strictObject({ mooncg: shown(200) }).optional(),
  dependencies: z.record(id, shown(200)).refine(few.check, few.message).default({}),
  extension: z
    .string()
    .refine(
      (path) => isSafeRelativePath(path) && !/^(dashboard|graphics)\//.test(path),
      'Must be a relative path inside the bundle, outside dashboard/ and graphics/ (those are served to browsers)',
    )
    .optional(),
  /** The file a module is loaded from. A bundle has `extension` instead. */
  main: file.optional(),
  permissions: z
    .record(permissionName, shown(1000, 0))
    .refine(some.check, some.message)
    .default({}),
  defaultRoles: z
    .record(shown(100), z.array(permissionName).max(500, some.message))
    .refine(atMost(100).check, atMost(100).message)
    .default({}),
  panels: z.array(panel).max(500, some.message).default([]),
  dialogs: z.array(dialog).max(500, some.message).default([]),
  graphics: z.array(graphic).max(500, some.message).default([]),
  replicants: z.record(memberName, replicant).refine(lots.check, lots.message).default({}),
  messages: z.record(memberName, message).refine(lots.check, lots.message).default({}),
  assets: z.array(asset).max(200, few.message).default([]),
  config: z.strictObject({ schema: file }).optional(),
  capabilities: z.array(shown(200)).max(200, few.message).default([]),
  dev: z
    .strictObject({
      url: z
        .string()
        .max(500)
        .refine(
          isDevUrl,
          'Must be an http:// or https:// address on this machine (localhost, 127.0.0.1 or [::1]), without credentials, query or fragment',
        ),
    })
    .optional(),
});

/** A validated manifest with every collection present. `$schema` is dropped. */
export type Manifest = Omit<z.output<typeof manifestSchema>, '$schema'>;

export interface ManifestError {
  /** Dotted path to the offending value, such as `panels.0.file`. Empty for the root. */
  readonly path: string;
  readonly message: string;
}

export type ManifestResult =
  | { readonly ok: true; readonly manifest: Manifest }
  | { readonly ok: false; readonly errors: readonly ManifestError[] };

/** Validates and normalizes the content of a `mooncg.json`. Never throws. */
export function parseManifest(input: unknown): ManifestResult {
  // Refusing extreme nesting first keeps the recursive schema validation from overflowing.
  const problem = jsonProblem(input);
  if (problem !== null) return { ok: false, errors: [{ path: '', message: problem }] };
  const parsed = manifestSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    };
  }
  const { $schema: _ignored, ...manifest } = parsed.data;
  const errors = [
    ...kindErrors(manifest),
    ...duplicateIdErrors(manifest),
    ...permissionReferenceErrors(manifest),
  ];
  return errors.length > 0 ? { ok: false, errors } : { ok: true, manifest };
}

/** The JSON Schema for `mooncg.json`, for publishing and editor completion via `$schema`. */
export function manifestJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(manifestSchema, { io: 'input' });
}

/** What only a bundle has, with what a module has in its place where there is something. */
const BUNDLE_ONLY: readonly (readonly [keyof Manifest, string])[] = [
  ['extension', '; a module has "main"'],
  ['dependencies', ''],
  ['permissions', '; a module defines permissions in its setup'],
  ['defaultRoles', ''],
  ['panels', ''],
  ['dialogs', ''],
  ['graphics', ''],
  ['replicants', ''],
  ['messages', ''],
  ['assets', ''],
  ['capabilities', ''],
  ['dev', ''],
];

/** A module is not a bundle with another label: what belongs to the one is refused in the other. */
function kindErrors(manifest: Manifest): ManifestError[] {
  if (manifest.kind === 'bundle') {
    return manifest.main === undefined
      ? []
      : [{ path: 'main', message: 'Only a module has a main file; a bundle has "extension"' }];
  }
  return BUNDLE_ONLY.filter(([key]) => {
    const value = manifest[key];
    return value !== undefined && (typeof value !== 'object' || Object.keys(value).length > 0);
  }).map(([key, instead]) => ({ path: key, message: `Only a bundle has this${instead}` }));
}

function duplicateIdErrors(manifest: Manifest): ManifestError[] {
  const errors: ManifestError[] = [];
  for (const key of ['panels', 'dialogs', 'graphics', 'assets'] as const) {
    const seen = new Set<string>();
    manifest[key].forEach((item, index) => {
      if (seen.has(item.id)) {
        errors.push({ path: `${key}.${index}.id`, message: `Duplicate id "${item.id}"` });
      }
      seen.add(item.id);
    });
  }
  return errors;
}

function permissionReferenceErrors(manifest: Manifest): ManifestError[] {
  const references: [path: string, permission: string | undefined][] = [];
  for (const key of ['panels', 'dialogs', 'graphics'] as const) {
    manifest[key].forEach((item, index) => {
      references.push([`${key}.${index}.requires`, item.requires]);
    });
  }
  for (const [name, declaration] of Object.entries(manifest.replicants)) {
    references.push([`replicants.${name}.read`, declaration.read]);
    references.push([`replicants.${name}.write`, declaration.write]);
  }
  for (const [name, declaration] of Object.entries(manifest.messages)) {
    references.push([`messages.${name}.send`, declaration.send]);
    references.push([`messages.${name}.listen`, declaration.listen]);
  }
  manifest.assets.forEach((category, index) => {
    references.push([`assets.${index}.read`, category.read]);
    references.push([`assets.${index}.write`, category.write]);
  });
  for (const [role, permissions] of Object.entries(manifest.defaultRoles)) {
    permissions.forEach((permission, index) => {
      references.push([`defaultRoles.${role}.${index}`, permission]);
    });
  }
  return references
    .filter(
      ([, permission]) =>
        permission !== undefined && !Object.hasOwn(manifest.permissions, permission),
    )
    .map(([path, permission]) => ({
      path,
      message: `Permission "${permission}" is not declared in "permissions"`,
    }));
}
