import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isPlainObject, type Json, type Manifest, MoonCGError, type Validate } from '@mooncg/core';
import { errorMessage, type Logger } from '../kernel/logger.js';
import { compileSchema } from '../replicants/schema.js';

/**
 * A property of a config schema that carries `"x-secret": true` holds a secret. The server
 * hands it to the bundle's extension and to nobody else: it is in no answer, no frame, no log
 * line and no error message.
 */
export const SECRET_KEYWORD = 'x-secret';

/** What stands in a text where a secret was. */
const SCRUBBED = '***';

export type ConfigValues = Record<string, Json>;

/** A bundle as the configuration needs to know it. */
export interface ConfiguredBundle {
  readonly name: string;
  readonly dir: string;
  readonly manifest: Pick<Manifest, 'config'>;
}

export type LoadedConfig =
  | { readonly ok: true; readonly values: ConfigValues }
  | { readonly ok: false; readonly errors: readonly string[] };

/** A bundle's configuration as the API tells it: everything but the secrets. */
export interface DescribedConfig {
  readonly schema: Json;
  readonly values: ConfigValues;
  /** Every secret of the schema, each as a JSON Pointer such as `/apiKey`. */
  readonly secretFields: readonly string[];
  /** Those of them that hold a value. */
  readonly secrets: readonly string[];
  /** Why the stored configuration does not fit the schema; empty when it does. */
  readonly problems: readonly string[];
}

type Path = readonly string[];

const pointer = (path: Path) =>
  `/${path.map((part) => part.replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`;

/** Keywords whose value is a map from names to schemas. The names are no keywords. */
const NAMED = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
  'dependencies',
]);
/** Keywords whose value is data, not a schema. */
const DATA = new Set(['enum', 'const', 'default', 'examples', 'required', 'dependentRequired']);
/** References that are resolved while a value is checked, which nothing here can foresee. */
const DYNAMIC = ['$dynamicRef', '$recursiveRef'];

/** The schemas directly inside a schema, without those under the keywords in `skip`. */
function children(node: Record<string, unknown>, skip: ReadonlySet<string> = new Set()): unknown[] {
  const found: unknown[] = [];
  for (const [keyword, value] of Object.entries(node)) {
    if (skip.has(keyword) || DATA.has(keyword) || keyword === '$ref') continue;
    if (NAMED.has(keyword) && isPlainObject(value)) found.push(...Object.values(value));
    else if (Array.isArray(value)) found.push(...value);
    else found.push(value);
  }
  return found.filter(isPlainObject);
}

/** What a `$ref` inside the same schema points to: `#` or `#/a/path`. Else `undefined`. */
function resolveLocal(root: unknown, ref: unknown): unknown {
  if (ref === '#') return root;
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return undefined;
  let target: unknown = root;
  for (const part of ref.slice(2).split('/')) {
    let key: string;
    try {
      key = decodeURIComponent(part).replaceAll('~1', '/').replaceAll('~0', '~');
    } catch {
      return undefined;
    }
    if (Array.isArray(target)) target = target[Number(key)];
    else if (isPlainObject(target) && Object.hasOwn(target, key)) target = target[key];
    else return undefined;
  }
  return isPlainObject(target) || typeof target === 'boolean' ? target : undefined;
}

/**
 * Throws unless every reference in the schema can be followed here. A secret could sit behind
 * one that cannot, and would then be handed out like any other value, so such a schema is
 * not used at all.
 */
function assertFollowable(root: unknown): void {
  const seen = new Set<unknown>();
  const check = (node: unknown): void => {
    if (!isPlainObject(node) || seen.has(node)) return;
    seen.add(node);
    for (const keyword of DYNAMIC) {
      if (Object.hasOwn(node, keyword)) {
        throw new Error(`"${keyword}" cannot be followed; use "$ref" with a path ("#/…")`);
      }
    }
    if (Object.hasOwn(node, '$ref') && resolveLocal(root, node.$ref) === undefined) {
      throw new Error(
        `The reference "${String(node.$ref)}" cannot be followed; only references into ` +
          'the same schema by path ("#/…") are supported',
      );
    }
    children(node).forEach(check);
  };
  check(root);
}

/** Whether `x-secret` is anywhere in a schema or in what it refers to, however deep. */
function mentionsSecret(root: unknown, node: unknown, seen: Set<unknown> = new Set()): boolean {
  if (!isPlainObject(node) || seen.has(node)) return false;
  seen.add(node);
  if (node[SECRET_KEYWORD] === true) return true;
  if (mentionsSecret(root, resolveLocal(root, node.$ref), seen)) return true;
  return children(node).some((child) => mentionsSecret(root, child, seen));
}

const BESIDE_PROPERTIES = new Set(['properties', '$defs', 'definitions']);

/**
 * The properties of a config schema that are secret, each as the names that lead to it.
 * Secrets are found along `properties`, and every `$ref` into the same schema is followed,
 * wherever it stands. Where a secret hides behind something no property name leads through
 * (the items of a list, one of several alternatives, a reference that comes back to where
 * it started), the property around it is secret as a whole. Throws when not even that is
 * possible, because the secret is not below a named property at all, and when the schema has
 * a reference that cannot be followed.
 */
export function secretPaths(schema: unknown): Path[] {
  assertFollowable(schema);
  const found: Path[] = [];
  const mark = (path: Path) => {
    if (path.length === 0) {
      throw new Error(
        `"${SECRET_KEYWORD}" is only supported on named properties of the configuration`,
      );
    }
    found.push(path);
  };
  const walk = (node: unknown, path: Path, seen: ReadonlySet<unknown>): void => {
    if (!isPlainObject(node)) return;
    if (seen.has(node)) {
      // The references came back to where they were: below here the schema repeats itself
      // to any depth, and so does a secret in it.
      if (mentionsSecret(schema, node)) mark(path);
      return;
    }
    const beside = children(node, BESIDE_PROPERTIES);
    if (node[SECRET_KEYWORD] === true || beside.some((child) => mentionsSecret(schema, child))) {
      mark(path);
      return;
    }
    const visited = new Set([...seen, node]);
    walk(resolveLocal(schema, node.$ref), path, visited);
    if (isPlainObject(node.properties)) {
      for (const [name, child] of Object.entries(node.properties)) {
        walk(child, [...path, name], visited);
      }
    }
  };
  walk(schema, [], new Set());
  // A property found twice, through a reference and directly, is listed once. One below
  // another that is secret as a whole adds nothing.
  const pointers = found.map(pointer);
  return found.filter(
    (_path, index) =>
      pointers.indexOf(pointers[index] as string) === index &&
      !pointers.some((other, at) => at !== index && pointers[index]?.startsWith(`${other}/`)),
  );
}

function valueAt(values: unknown, path: Path): unknown {
  let current = values;
  for (const part of path) {
    if (!isPlainObject(current) || !Object.hasOwn(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

/** The object a path ends in, or `undefined`. With `create`, missing objects are made. */
function parentOf(values: Record<string, unknown>, path: Path, create: boolean) {
  let current = values;
  for (const part of path.slice(0, -1)) {
    let next = Object.hasOwn(current, part) ? current[part] : undefined;
    if (next === undefined && create) {
      next = {};
      current[part] = next;
    }
    if (!isPlainObject(next)) return undefined;
    current = next;
  }
  return current;
}

/** A copy of the values without any of the secrets. */
export function redactConfig(values: ConfigValues, paths: readonly Path[]): ConfigValues {
  const copy = structuredClone(values);
  for (const path of paths) {
    const parent = parentOf(copy, path, false);
    if (parent) delete parent[path.at(-1) as string];
  }
  return copy;
}

/** The secrets that hold a value, as JSON Pointers. */
export function setSecrets(values: ConfigValues, paths: readonly Path[]): string[] {
  return paths.filter((path) => valueAt(values, path) !== undefined).map(pointer);
}

/**
 * What a write makes of the stored secrets: one that is left out stays as it is stored, one
 * that is given replaces it, and one given as `null` is removed.
 */
export function mergeSecrets(
  incoming: ConfigValues,
  stored: ConfigValues,
  paths: readonly Path[],
): ConfigValues {
  const merged = structuredClone(incoming);
  for (const path of paths) {
    const name = path.at(-1) as string;
    const given = valueAt(merged, path);
    if (given === null) {
      const parent = parentOf(merged, path, false);
      if (parent) delete parent[name];
      continue;
    }
    const kept = valueAt(stored, path);
    if (given !== undefined || kept === undefined) continue;
    const parent = parentOf(merged, path, true);
    if (parent) parent[name] = structuredClone(kept);
  }
  return merged;
}

/**
 * A secret shorter than this is not searched for in texts: it would turn up inside ordinary
 * words, and lines with half their letters replaced tell an operator nothing.
 */
export const MIN_SCRUBBED_LENGTH = 8;

/** Every text and number inside the secrets of some values, with the secret it belongs to. */
function secretTexts(
  values: unknown,
  paths: readonly Path[],
): { readonly path: string; readonly text: string }[] {
  const texts: { path: string; text: string }[] = [];
  for (const path of paths) {
    const collect = (value: unknown): void => {
      if (typeof value === 'string' || typeof value === 'number') {
        texts.push({ path: pointer(path), text: String(value) });
      } else if (Array.isArray(value)) value.forEach(collect);
      else if (isPlainObject(value)) Object.values(value).forEach(collect);
    };
    collect(valueAt(values, path));
  }
  return texts.filter(({ text }) => text !== '');
}

/** The texts long enough to be searched for. */
const scrubbable = (texts: readonly { readonly text: string }[]): string[] =>
  texts.map(({ text }) => text).filter((text) => text.length >= MIN_SCRUBBED_LENGTH);

function scrubWith(text: string, secrets: Iterable<string>): string {
  let scrubbed = text;
  // Longest first, so a secret that contains another leaves nothing of itself behind.
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    scrubbed = scrubbed.replaceAll(secret, SCRUBBED);
  }
  return scrubbed;
}

interface Prepared {
  readonly schema: Json;
  readonly validate: Validate;
  readonly paths: readonly Path[];
}

export interface BundleConfigsOptions {
  /** The server's data directory. The configurations are in its folder `config`. */
  readonly dataDir: string;
  /** Told what an administrator should know, such as a secret too short to be masked. */
  readonly warn?: ((message: string) => void) | undefined;
}

/**
 * The configuration of each bundle: one JSON file per bundle in `<data-dir>/config`, checked
 * against the JSON Schema the bundle's manifest names, on every load and before every write.
 */
export class BundleConfigs {
  readonly #dir: string;
  readonly #warn: (message: string) => void;
  /**
   * The secrets each bundle's configuration holds, and those it held before the last change:
   * an extension that still runs was started with the earlier ones. Older ones are forgotten.
   */
  readonly #secrets = new Map<string, { readonly now: string[]; readonly before: string[] }>();
  /** The short secrets that were warned about, so that each is mentioned once. */
  readonly #warned = new Set<string>();
  /** The last write of each bundle, so that two writes do not cross. */
  readonly #writes = new Map<string, Promise<unknown>>();

  constructor(options: BundleConfigsOptions) {
    this.#dir = join(options.dataDir, 'config');
    this.#warn = options.warn ?? (() => {});
  }

  /**
   * The configuration a bundle starts with: what is stored, with the defaults of the schema
   * filled in. A bundle without a schema has an empty one. Never throws: a schema or a stored
   * file that cannot be used is answered with the reasons.
   */
  async load(bundle: ConfiguredBundle): Promise<LoadedConfig> {
    if (bundle.manifest.config === undefined) return { ok: true, values: {} };
    try {
      const prepared = await this.#prepare(bundle);
      const { values, problems } = await this.#read(bundle.name, prepared);
      // The extension starts with what is stored: nothing earlier is in use any more.
      this.#secrets.delete(bundle.name);
      this.#remember(bundle.name, values, prepared.paths);
      if (problems.length > 0) return { ok: false, errors: problems };
      return { ok: true, values: this.#withDefaults(values, prepared) };
    } catch (error) {
      return { ok: false, errors: [errorMessage(error)] };
    }
  }

  /** The configuration as the API tells it. Rejects when the bundle has none. */
  async describe(bundle: ConfiguredBundle): Promise<DescribedConfig> {
    const prepared = await this.#prepareOrRefuse(bundle);
    const { values, problems } = await this.#read(bundle.name, prepared);
    this.#remember(bundle.name, values, prepared.paths);
    return this.#described(values, problems, prepared);
  }

  /**
   * Stores new values after checking them against the schema. A secret that is left out keeps
   * its stored value; `null` removes it. Rejects with `invalid`, and stores nothing, when the
   * result does not fit the schema.
   */
  write(bundle: ConfiguredBundle, incoming: unknown): Promise<DescribedConfig> {
    const earlier = this.#writes.get(bundle.name) ?? Promise.resolve();
    const result = earlier.then(() => this.#write(bundle, incoming));
    this.#writes.set(
      bundle.name,
      result.catch(() => {}),
    );
    return result;
  }

  /** Takes every secret of every bundle's configuration out of a text. */
  scrub(text: string): string {
    const known = [...this.#secrets.values()].flatMap(({ now, before }) => [...now, ...before]);
    return scrubWith(text, new Set(known));
  }

  async #write(bundle: ConfiguredBundle, incoming: unknown): Promise<DescribedConfig> {
    const prepared = await this.#prepareOrRefuse(bundle);
    if (!isPlainObject(incoming)) {
      throw new MoonCGError('invalid', 'The configuration must be a JSON object');
    }
    const { values: stored } = await this.#read(bundle.name, prepared);
    const merged = mergeSecrets(incoming as ConfigValues, stored, prepared.paths);
    // Checked with the defaults filled in, as the extension will get it; stored without them.
    const problems = prepared.validate(structuredClone(merged)) ?? [];
    if (problems.length > 0) {
      // Whatever was sent as a secret is in no answer, not even in the one that refuses it.
      const sent = scrubbable([
        ...secretTexts(incoming, prepared.paths),
        ...secretTexts(merged, prepared.paths),
      ]);
      throw new MoonCGError(
        'invalid',
        scrubWith(`The configuration does not match its schema: ${problems.join('; ')}`, sent),
      );
    }
    await mkdir(this.#dir, { recursive: true });
    const file = this.#file(bundle.name);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      // Complete or not at all: the file is replaced in one step, never written in place.
      await writeFile(temporary, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw new MoonCGError(
        'internal',
        `The configuration could not be stored: ${(error as NodeJS.ErrnoException).code ?? 'error'}`,
      );
    }
    this.#remember(bundle.name, merged, prepared.paths);
    return this.#described(merged, [], prepared);
  }

  /**
   * Deletes the stored configuration of a bundle, for a bundle that is removed with its
   * data. Its secrets stay known a while longer, so that a late log line is still scrubbed.
   */
  async remove(bundle: string): Promise<void> {
    const write = (this.#writes.get(bundle) ?? Promise.resolve())
      .catch(() => {})
      .then(() => rm(this.#file(bundle), { force: true }));
    this.#writes.set(bundle, write);
    await write;
  }

  /** For the API: a schema that cannot be used is a `conflict`, with the reason. */
  async #prepareOrRefuse(bundle: ConfiguredBundle): Promise<Prepared> {
    try {
      return await this.#prepare(bundle);
    } catch (error) {
      if (error instanceof MoonCGError) throw error;
      throw new MoonCGError('conflict', errorMessage(error));
    }
  }

  #file(bundle: string): string {
    return join(this.#dir, `${bundle}.json`);
  }

  #remember(bundle: string, values: unknown, paths: readonly Path[]): void {
    const texts = secretTexts(values, paths);
    for (const { path, text } of texts) {
      const key = `${bundle} ${path}`;
      if (text.length >= MIN_SCRUBBED_LENGTH || this.#warned.has(key)) continue;
      this.#warned.add(key);
      this.#warn(
        `The secret ${path} of bundle "${bundle}" has fewer than ${MIN_SCRUBBED_LENGTH} ` +
          'characters and cannot be kept out of logs and errors',
      );
    }
    const now = [...new Set(scrubbable(texts))];
    const known = this.#secrets.get(bundle);
    const same = known?.now.length === now.length && now.every((text) => known.now.includes(text));
    this.#secrets.set(bundle, same && known ? known : { now, before: known?.now ?? [] });
  }

  #described(values: ConfigValues, problems: readonly string[], prepared: Prepared) {
    return {
      schema: prepared.schema,
      values: redactConfig(values, prepared.paths),
      secretFields: prepared.paths.map(pointer),
      secrets: setSecrets(values, prepared.paths),
      problems,
    };
  }

  #withDefaults(values: ConfigValues, prepared: Prepared): ConfigValues {
    const filled = structuredClone(values);
    prepared.validate(filled);
    return filled;
  }

  /** Reads and compiles the schema the manifest names. Throws with a readable message. */
  async #prepare(bundle: ConfiguredBundle): Promise<Prepared> {
    const file = bundle.manifest.config?.schema;
    if (file === undefined) {
      throw new MoonCGError('not_found', `Bundle "${bundle.name}" has no configuration`);
    }
    const path = 'config.schema';
    let text: string;
    try {
      text = await readFile(join(bundle.dir, file), 'utf8');
    } catch (error) {
      throw new Error(`${path}: "${file}" could not be read: ${errorMessage(error)}`);
    }
    let schema: unknown;
    try {
      schema = JSON.parse(text);
    } catch (error) {
      throw new Error(`${path}: "${file}" is not valid JSON: ${errorMessage(error)}`);
    }
    try {
      // The references are judged first: their refusal says more than the validator's.
      const paths = secretPaths(schema);
      return {
        schema: schema as Json,
        validate: compileSchema(schema, { useDefaults: true }),
        paths,
      };
    } catch (error) {
      throw new Error(`${path}: "${file}" is not a usable schema: ${errorMessage(error)}`);
    }
  }

  /** What is stored for a bundle, and what is wrong with it. Nothing stored is `{}`. */
  async #read(
    bundle: string,
    prepared: Prepared,
  ): Promise<{ values: ConfigValues; problems: string[] }> {
    let text: string | undefined;
    try {
      text = await readFile(this.#file(bundle), 'utf8');
    } catch (error) {
      const { code } = error as NodeJS.ErrnoException;
      if (code !== 'ENOENT') {
        return {
          values: {},
          problems: [`config: the stored configuration could not be read (${code})`],
        };
      }
    }
    let values: unknown = {};
    if (text !== undefined) {
      try {
        values = JSON.parse(text);
      } catch {
        // The parser's own message quotes the text, which may hold a secret.
        return { values: {}, problems: ['config: the stored configuration is not valid JSON'] };
      }
    }
    if (!isPlainObject(values)) return { values: {}, problems: ['config: must be a JSON object'] };
    const secrets = scrubbable(secretTexts(values, prepared.paths));
    const problems = (prepared.validate(structuredClone(values) as Json) ?? []).map((problem) =>
      scrubWith(`config: ${problem}`, secrets),
    );
    return { values: values as ConfigValues, problems };
  }
}

/**
 * A logger that takes the secrets of every bundle's configuration out of each line, whoever
 * logs it, before it reaches the console or the log page.
 */
export function scrubbingLogger(inner: Logger, configs: Pick<BundleConfigs, 'scrub'>): Logger {
  const log = (level: 'info' | 'warn' | 'error') => (message: string) =>
    inner[level](configs.scrub(message));
  return {
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    child: (scope) => scrubbingLogger(inner.child(scope), configs),
  };
}
