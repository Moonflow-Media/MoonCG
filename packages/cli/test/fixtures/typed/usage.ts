// Type-checked by `pnpm typecheck` to prove that the generated mooncg-env.d.ts types
// `replicant()` without a generic. It is never run.
import { createClient } from '@mooncg/sdk/client';

const mc = createClient({ bundle: 'typed', url: 'ws://127.0.0.1/ws' });

// A name from the generated map gets its type from the schema.
const score = mc.replicant('score');
const home: number | undefined = score.value?.home;
const period: 'first' | 'second' | undefined = score.value?.period;
void score.set({ home: 1, away: 2 });
void score.update((draft) => {
  draft.home++;
});

// @ts-expect-error -- "home" is a number in the schema
void score.set({ home: 'one', away: 2 });
// @ts-expect-error -- the schema has no such member
void score.value?.typo;

// The qualified name has the same type; a default-only replicant is inferred from its default.
const qualified: number | undefined = mc.replicant('typed:score').value?.away;
const teams: string[] | undefined = mc.replicant('teams').value;
const anything: unknown = mc.replicant('anything').value;

// Any other name still takes an explicit type, or is unknown.
const other: boolean | undefined = mc.replicant<boolean>('other-bundle:flag').value;
const untyped: unknown = mc.replicant('other-bundle:whatever').value;
// @ts-expect-error -- an unlisted name without a generic is unknown, not any
const wrong: string | undefined = mc.replicant('other-bundle:whatever').value;

export { anything, home, other, period, qualified, teams, untyped, wrong };

// The same map types an extension's context.
import type { BundleContext } from '@mooncg/sdk/extension';

declare const ctx: BundleContext;
const fromExtension: number | undefined = ctx.replicant('score').value?.home;
// @ts-expect-error -- "home" is a number in the schema
void ctx.replicant('score').set({ home: 'one', away: 2 });

export { fromExtension };
