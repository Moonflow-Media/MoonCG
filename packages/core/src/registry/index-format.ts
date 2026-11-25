import { z } from 'zod';
import { jsonProblem } from '../json.js';
import { BUNDLE_NAME_PATTERN, isReservedDeviceName } from '../names.js';
import { isLoopbackHost } from '../net.js';

/**
 * A registry index: a static JSON file that lists bundles and modules with the versions there
 * are and where each is fetched from. Anyone can host one; MoonCG vets nothing in it. What it
 * says is shown to administrators before anything is fetched, so, like a manifest, it is
 * bounded and holds no control characters.
 */

/** The format version this MoonCG reads, the `index` field of the file. */
export const REGISTRY_INDEX_FORMAT = 1;
/** How many entries one index may list. */
export const MAX_INDEX_ENTRIES = 1000;
/** How many versions one entry may list. */
export const MAX_INDEX_VERSIONS = 100;
/** How large an index file may be, in bytes. Checked while it arrives. */
export const MAX_INDEX_BYTES = 2 * 1024 * 1024;
/** The longest address an index or a source may have. */
export const MAX_REGISTRY_URL_LENGTH = 2048;

/**
 * A semantic version as semver.org defines it: no leading zero in a number, no empty
 * identifier. Anything looser sorts in more than one way and could hide an update.
 */
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
/** What a version range is made of; whether it parses as one is asked where semver is. */
const RANGE_PATTERN = /^[0-9A-Za-z.*^~<>=|+\- ]+$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
/** A plain branch, tag or commit name, as Git takes it; never an option. */
const REF_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;
const MAX_REF_LENGTH = 200;
/** A path next to the index, such as `zips/scoreboard-1.0.0.zip`. */
const RELATIVE_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._~-]*(\/[A-Za-z0-9_][A-Za-z0-9._~-]*)*$/;

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/**
 * Characters that are not seen but change what is seen: bidirectional overrides, zero-width
 * characters and other format characters, and the line and paragraph separators.
 */
const INVISIBLE = /[\p{Cf}\u2028\u2029]/u;
const URL_PATTERN =
  /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(?:([^@/?#]*)@)?(\[[0-9A-Fa-f:.]+\]|[^:/?#[\]@]+)(?::(\d{1,5}))?([/?#].*)?$/;

/** What this package needs of the WHATWG `URL`, which every runtime it runs in has. */
interface ParsedUrl {
  readonly protocol: string;
  readonly hostname: string;
  readonly username: string;
  readonly password: string;
}
const WhatwgUrl = (globalThis as unknown as { readonly URL: new (url: string) => ParsedUrl }).URL;

function parseUrl(url: string): ParsedUrl | undefined {
  try {
    return new WhatwgUrl(url);
  } catch {
    return undefined;
  }
}

function decodes(text: string): boolean {
  try {
    decodeURIComponent(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Why a ref is not asked for, or `undefined` if it is: a plain branch, tag or commit name.
 * The one rule for the ref of an index entry and the ref given to the installer.
 */
export function gitRefProblem(ref: unknown): string | undefined {
  if (ref === undefined) return undefined;
  const usable =
    typeof ref === 'string' &&
    ref.length <= MAX_REF_LENGTH &&
    REF_PATTERN.test(ref) &&
    !ref.includes('..') &&
    !ref.includes('//') &&
    !ref.endsWith('/') &&
    !ref.endsWith('.') &&
    !ref.endsWith('.lock');
  return usable ? undefined : 'The ref must be the plain name of a branch, a tag or a commit';
}

/**
 * Why an address cannot be an index or the source of a version, or `undefined` if it can:
 * `https://`, or plain `http://` on this machine alone (an index served while developing,
 * where nothing crosses a network). `loopback: false` refuses this machine altogether, for
 * what an index elsewhere lists; `credentials: false` refuses a user name and a password.
 * `plainHttp` names the other hosts plain `http://` is taken for, as the server's
 * configuration allows it for hosts of a private network (lowercase, IPv6 in brackets).
 *
 * The address is read twice, by hand and as `fetch` reads it (WHATWG `URL`), and taken only
 * when both agree on the scheme and the host: `URL` reads `\` as `/`, drops tabs and
 * newlines, and rewrites hosts such as `2130706433` or `0x7f.1` into `127.0.0.1`, so what was
 * checked would not be what is fetched.
 */
export function registryUrlProblem(
  url: string,
  options: {
    readonly credentials?: boolean;
    readonly loopback?: boolean;
    readonly plainHttp?: ((host: string) => boolean) | undefined;
  } = {},
): string | undefined {
  if (url.length > MAX_REGISTRY_URL_LENGTH) return 'The address is too long';
  if (CONTROL.test(url) || /\s/.test(url)) {
    return 'The address must not contain spaces or control characters';
  }
  if (url.includes('\\')) return 'The address must not contain "\\"';
  const match = URL_PATTERN.exec(url);
  const scheme = match?.[1]?.toLowerCase();
  const host = match?.[3]?.toLowerCase() ?? '';
  const port = match?.[4];
  const parsed = parseUrl(url);
  if (!match || !parsed || (scheme !== 'https' && scheme !== 'http') || host === '') {
    return 'The address must start with https://';
  }
  if (port !== undefined && Number(port) > 65535) return 'The address has no usable port';
  if (parsed.protocol !== `${scheme}:` || parsed.hostname.toLowerCase() !== host) {
    return 'The host of the address must be written plainly: a name, or an IP address in its usual form';
  }
  if (match[2] !== undefined && options.credentials === false) {
    return 'The address must not contain credentials';
  }
  if (!decodes(parsed.username) || !decodes(parsed.password)) {
    return 'The credentials in the address are not valid percent-encoding';
  }
  const local = isLoopbackHost(host);
  if (local && options.loopback === false) {
    return 'The address must not name this machine: only an index on this machine may list one';
  }
  if (scheme === 'http' && !local && options.plainHttp?.(host) !== true) {
    return 'The address must start with https://; plain http:// is for this machine only';
  }
  return undefined;
}

/** Whether an address is usable and names this machine, such as an index served while developing. */
export function isLoopbackRegistryUrl(url: string): boolean {
  if (registryUrlProblem(url) !== undefined) return false;
  const parsed = parseUrl(url);
  return parsed !== undefined && isLoopbackHost(parsed.hostname);
}

const shown = (max: number) =>
  z
    .string()
    .min(1)
    .max(max, `Must be at most ${max} characters`)
    .refine((text) => !CONTROL.test(text), 'Must not contain control characters')
    .refine(
      (text) => !INVISIBLE.test(text),
      'Must not contain invisible format characters, such as a change of writing direction',
    );
const name = z
  .string()
  .max(214)
  .regex(BUNDLE_NAME_PATTERN, 'Must be lowercase letters, digits and single dashes')
  .refine((text) => !isReservedDeviceName(text), 'Is a name Windows reserves for a device');
const version = z
  .string()
  .max(64)
  .regex(SEMVER_PATTERN, 'Must be a semantic version like 1.2.3')
  // semver reads the three numbers as numbers: larger than that, it takes no version at all.
  .refine(
    (text) =>
      text
        .split(/[-+]/)[0]
        ?.split('.')
        .every((part) => Number(part) <= Number.MAX_SAFE_INTEGER) === true,
    'Must be a semantic version with numbers no larger than 9007199254740991',
  );
const range = z.string().min(1).max(100).regex(RANGE_PATTERN, 'Must be a version range');
const absolute = z.string().superRefine((url, context) => {
  const problem = registryUrlProblem(url, { credentials: false });
  if (problem !== undefined) context.addIssue({ code: 'custom', message: problem });
});
/** A ZIP is fetched from an address of its own or from one next to the index. */
const zipUrl = z.string().superRefine((url, context) => {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(url)) {
    const problem = registryUrlProblem(url, { credentials: false });
    if (problem !== undefined) context.addIssue({ code: 'custom', message: problem });
    return;
  }
  if (
    url.length > MAX_REGISTRY_URL_LENGTH ||
    !RELATIVE_PATTERN.test(url) ||
    url.split('/').some((part) => part === '..' || part === '.')
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Must be an https:// address or a relative path next to the index, without ".."',
    });
  }
});

const source = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('zip'),
    url: zipUrl,
    sha256: z.string().regex(SHA256_PATTERN, 'Must be the SHA-256 of the archive in lowercase hex'),
  }),
  z.strictObject({
    type: z.literal('git'),
    url: absolute.refine((url) => /^https:\/\//i.test(url), 'A Git address must be https://'),
    /** What is fetched: a branch or a tag, which must be `commit` when it arrives. */
    ref: z
      .string()
      .max(MAX_REF_LENGTH)
      .regex(REF_PATTERN, 'Must be the plain name of a branch or a tag')
      .superRefine((ref, context) => {
        const problem = gitRefProblem(ref);
        if (problem !== undefined) context.addIssue({ code: 'custom', message: problem });
      })
      .optional(),
    /** Required: a version is one commit, not whatever a ref points to when it is fetched. */
    commit: z.string().regex(COMMIT_PATTERN, 'Must be the full commit hash in lowercase hex'),
  }),
]);

const indexVersion = z.strictObject({
  version,
  engine: z.strictObject({ mooncg: range }).optional(),
  dependencies: z
    .record(name, range)
    .refine((value) => Object.keys(value).length <= 100, 'Must have at most 100 entries')
    .default({}),
  source,
});

const entry = z
  .strictObject({
    name,
    kind: z.enum(['bundle', 'module']),
    title: shown(200).optional(),
    description: shown(2000).optional(),
    author: shown(200).optional(),
    homepage: absolute.optional(),
    license: shown(100).optional(),
    tags: z.array(shown(40)).max(20, 'Must have at most 20 tags').default([]),
    versions: z
      .array(indexVersion)
      .min(1)
      .max(MAX_INDEX_VERSIONS, `Must have at most ${MAX_INDEX_VERSIONS} versions`),
  })
  .superRefine((value, context) => {
    const seen = new Set<string>();
    value.versions.forEach((item, index) => {
      if (seen.has(item.version)) {
        context.addIssue({
          code: 'custom',
          path: ['versions', index, 'version'],
          message: `Version ${item.version} is listed twice`,
        });
      }
      seen.add(item.version);
    });
  });

export const registryIndexSchema = z
  .strictObject({
    $schema: z.string().max(MAX_REGISTRY_URL_LENGTH).optional(),
    index: z.literal(REGISTRY_INDEX_FORMAT),
    title: shown(200).optional(),
    entries: z
      .array(entry)
      .max(MAX_INDEX_ENTRIES, `Must have at most ${MAX_INDEX_ENTRIES} entries`),
  })
  .superRefine((value, context) => {
    const seen = new Set<string>();
    value.entries.forEach((item, index) => {
      const key = `${item.kind} ${item.name}`;
      if (seen.has(key)) {
        context.addIssue({
          code: 'custom',
          path: ['entries', index, 'name'],
          message: `The ${item.kind} "${item.name}" is listed twice`,
        });
      }
      seen.add(key);
    });
  });

/** A validated index. `$schema` is dropped. */
export type RegistryIndex = Omit<z.output<typeof registryIndexSchema>, '$schema'>;
export type RegistryEntry = RegistryIndex['entries'][number];
export type RegistryVersion = RegistryEntry['versions'][number];
export type RegistrySourceSpec = RegistryVersion['source'];

export type RegistryIndexResult =
  | { readonly ok: true; readonly index: RegistryIndex }
  | {
      readonly ok: false;
      readonly errors: readonly { readonly path: string; readonly message: string }[];
    };

/** How many problems of an index are told: one broken entry repeated is no list to read. */
const ERRORS_TOLD = 20;

/**
 * What an index that is not on this machine may not list: plain `http://` and this machine
 * itself. Otherwise an index elsewhere could make the server ask its own services.
 */
function remoteProblems(index: RegistryIndex): { path: string; message: string }[] {
  const problems: { path: string; message: string }[] = [];
  const check = (url: string | undefined, path: string) => {
    if (url === undefined || !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(url)) return;
    const message = registryUrlProblem(url, { credentials: false, loopback: false });
    if (message !== undefined) problems.push({ path, message });
  };
  index.entries.forEach((entry, at) => {
    check(entry.homepage, `entries.${at}.homepage`);
    entry.versions.forEach((version, which) => {
      check(version.source.url, `entries.${at}.versions.${which}.source.url`);
    });
  });
  return problems;
}

/**
 * Validates the content of an index file. Never throws. `loopback` says that the index was
 * fetched from this machine: only then may it list addresses on this machine, over plain
 * `http://` too.
 */
export function parseRegistryIndex(
  input: unknown,
  options: { readonly loopback?: boolean } = {},
): RegistryIndexResult {
  const problem = jsonProblem(input);
  if (problem !== null) return { ok: false, errors: [{ path: '', message: problem }] };
  const parsed = registryIndexSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.slice(0, ERRORS_TOLD).map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    };
  }
  const { $schema: _ignored, ...index } = parsed.data;
  const remote = options.loopback === true ? [] : remoteProblems(index);
  if (remote.length > 0) return { ok: false, errors: remote.slice(0, ERRORS_TOLD) };
  return { ok: true, index };
}

/** The JSON Schema of an index file, for publishing and editor completion via `$schema`. */
export function registryIndexJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(registryIndexSchema, { io: 'input', unrepresentable: 'any' });
}
