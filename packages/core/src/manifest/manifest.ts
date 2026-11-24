import { z } from 'zod';
import { jsonProblem } from '../json.js';
import { BUNDLE_NAME_PATTERN } from '../names.js';
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
  .refine(isSafeRelativePath, 'Must be a relative path inside the bundle, without ".." or "\\"');
/** Panels and graphics are served from fixed folders, so their URL follows from their file. */
const fileIn = (dir: string) =>
  z
    .string()
    .refine(
      (path) => isSafeRelativePath(path) && path.startsWith(`${dir}/`),
      `Must be a file under ${dir}/, without ".." or "\\"`,
    );
const positiveInt = z.int().positive();

const panel = z.strictObject({
  id,
  title: z.string().min(1),
  file: fileIn('dashboard'),
  /** Width in dashboard grid columns. */
  width: positiveInt.default(3),
  workspace: z.string().min(1).optional(),
  requires: permissionName.optional(),
});

const dialog = z.strictObject({
  id,
  title: z.string().min(1).optional(),
  file: fileIn('dashboard'),
  width: positiveInt.default(3),
  requires: permissionName.optional(),
});

const graphic = z.strictObject({
  id,
  title: z.string().min(1).optional(),
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
  title: z.string().min(1).optional(),
  /**
   * What may be uploaded: file extensions such as `.png` and media types such as `image/*`.
   * Without it, or with the entry for every media type (a star on both sides of the
   * slash), any file. An empty list would take nothing and is refused.
   */
  accept: z.array(z.string().min(1)).min(1, 'Must name at least one kind of file').optional(),
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
    .regex(BUNDLE_NAME_PATTERN, 'Must be lowercase letters, digits and single dashes'),
  version: z.string().regex(SEMVER_PATTERN, 'Must be a semantic version such as 1.2.3'),
  title: z.string().min(1).optional(),
  engine: z.strictObject({ mooncg: z.string().min(1) }).optional(),
  dependencies: z.record(id, z.string().min(1)).default({}),
  extension: z
    .string()
    .refine(
      (path) => isSafeRelativePath(path) && !/^(dashboard|graphics)\//.test(path),
      'Must be a relative path inside the bundle, outside dashboard/ and graphics/ (those are served to browsers)',
    )
    .optional(),
  permissions: z.record(permissionName, z.string()).default({}),
  defaultRoles: z.record(z.string().min(1), z.array(permissionName)).default({}),
  panels: z.array(panel).default([]),
  dialogs: z.array(dialog).default([]),
  graphics: z.array(graphic).default([]),
  replicants: z.record(memberName, replicant).default({}),
  messages: z.record(memberName, message).default({}),
  assets: z.array(asset).default([]),
  config: z.strictObject({ schema: file }).optional(),
  capabilities: z.array(z.string().min(1)).default([]),
  dev: z.strictObject({ url: z.url() }).optional(),
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
  const errors = [...duplicateIdErrors(manifest), ...permissionReferenceErrors(manifest)];
  return errors.length > 0 ? { ok: false, errors } : { ok: true, manifest };
}

/** The JSON Schema for `mooncg.json`, for publishing and editor completion via `$schema`. */
export function manifestJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(manifestSchema, { io: 'input' });
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
