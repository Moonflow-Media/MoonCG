import { satisfies, validRange } from 'semver';

/** What the dependency rules need to know about a bundle. */
export interface Dependable {
  readonly name: string;
  readonly version: string;
  /** Bundle name to semver range, from the manifest's `dependencies`. */
  readonly dependencies: Readonly<Record<string, string>>;
}

export interface StartPlan {
  /** The bundles that can start, each after everything it depends on. */
  readonly order: readonly string[];
  /** Why each of the other bundles cannot start. */
  readonly problems: ReadonlyMap<string, string>;
}

/** Why `bundle` cannot use `dependency` as it is installed, or `undefined` if it can. */
export function dependencyProblem(
  name: string,
  range: string,
  installed: Dependable | undefined,
): string | undefined {
  const path = `dependencies.${name}`;
  if (!installed) return `${path}: bundle "${name}" is not installed`;
  if (validRange(range) === null) return `${path}: "${range}" is not a version range`;
  if (!satisfies(installed.version, range, { includePrerelease: true })) {
    return `${path}: needs version ${range}, but ${installed.version} is installed`;
  }
  return undefined;
}

/**
 * Works out the order to start bundles in. A bundle with a missing dependency, an unsatisfied
 * version range or a part in a dependency cycle cannot start, and neither can anything that
 * depends on such a bundle.
 */
export function planStart(bundles: readonly Dependable[]): StartPlan {
  const byName = new Map(bundles.map((bundle) => [bundle.name, bundle]));
  const names = [...byName.keys()].sort();
  const problems = new Map<string, string>();

  for (const name of names) {
    const bundle = byName.get(name) as Dependable;
    for (const [dependency, range] of Object.entries(bundle.dependencies)) {
      const problem = dependencyProblem(dependency, range, byName.get(dependency));
      if (problem && !problems.has(name)) problems.set(name, problem);
    }
  }
  for (const name of names) {
    const cycle = problems.has(name) ? undefined : findCycle(name, byName);
    if (cycle) problems.set(name, `dependencies: part of a cycle (${cycle.join(' → ')})`);
  }

  // Take what has everything it needs started, until nothing more can be taken.
  const order: string[] = [];
  const waiting = new Set(names.filter((name) => !problems.has(name)));
  // Each round takes, in name order, what was ready when the round began.
  for (let progressed = true; progressed; ) {
    progressed = false;
    const started = new Set(order);
    for (const name of [...waiting]) {
      const needs = Object.keys((byName.get(name) as Dependable).dependencies);
      const blocked = needs.find((dependency) => problems.has(dependency));
      if (blocked !== undefined) {
        problems.set(name, `dependencies.${blocked}: bundle "${blocked}" cannot start`);
      } else if (!needs.every((dependency) => started.has(dependency))) continue;
      else order.push(name);
      waiting.delete(name);
      progressed = true;
    }
  }
  return { order, problems: new Map([...problems].sort(([a], [b]) => a.localeCompare(b))) };
}

/** A path from `start` back to itself along dependencies, if there is one. */
function findCycle(start: string, byName: ReadonlyMap<string, Dependable>): string[] | undefined {
  const visit = (name: string, path: readonly string[]): string[] | undefined => {
    for (const dependency of Object.keys(byName.get(name)?.dependencies ?? {}).sort()) {
      if (dependency === start) return [...path, start];
      if (path.includes(dependency)) continue;
      const cycle = visit(dependency, [...path, dependency]);
      if (cycle) return cycle;
    }
    return undefined;
  };
  return visit(start, [start]);
}

/**
 * Every bundle that depends on `name`, directly or through others, ordered so that each comes
 * after the bundles it depends on.
 */
export function dependentsOf(name: string, bundles: readonly Dependable[]): string[] {
  const found = new Set<string>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const bundle of bundles) {
      if (found.has(bundle.name) || bundle.name === name) continue;
      const needs = Object.keys(bundle.dependencies);
      if (needs.some((dependency) => dependency === name || found.has(dependency))) {
        found.add(bundle.name);
        grew = true;
      }
    }
  }
  const { order } = planStart(bundles);
  const rest = [...found].filter((dependent) => !order.includes(dependent)).sort();
  return [...order.filter((dependent) => found.has(dependent)), ...rest];
}
