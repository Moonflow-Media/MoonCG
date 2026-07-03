# Phase 5: Route Libraries Migration to Effect-TS

**Status**: Completed
**Complexity**: ⭐ Easy (most of the heavy lifting already landed with Phase 4)

## Overview

Phase 5 turns the route handler libraries (`graphics`, `dashboard`, `mounts`, `sounds`, `assets`, `shared-sources`) into Effect-based router factories. When this phase started, an audit showed that the bulk of this migration had **already happened as a side effect of Phase 4**: migrating the BundleService consumers required rewriting every route lib as an `Effect.fn` factory so it could subscribe to the PubSub, hold scoped resources, and be yielded from `createServer`. Phase 5 therefore consisted of a per-module audit against the coding guidelines, a small cleanup pass for the remaining imperative/non-idiomatic leftovers, and this documentation.

Guiding rule: **document instead of rewrite** where a module was already fully idiomatic (no churn), and **zero behavior changes** — all routes, paths, status codes and headers stay identical (covered by the E2E suite).

## Goals

- Every route lib is a function returning an Effect that sets up routes (no classes) ✅ (already true post-Phase 4)
- Consistent pattern: `xRouter` as named `Effect.fn`, builds and returns the Express app/router ✅
- BundleService events via eager `PubSub.subscribe` + `Stream.fromQueue` + `Effect.forkScoped` ✅
- Resources (watchers, background fibers) tied to the server scope ✅
- Remove remaining imperative leftovers and guideline violations (type assertions, raw timers) ✅

## Per-Module Audit

### Already fully idiomatic — documented, not touched

- **`dashboard.ts`** (`dashboardRouter`) — `Effect.fn` factory; captured `Runtime.runSync` bridge for the sync route handlers (`bundleService.all()`/`find()` are pure Ref reads); dashboard-context cache invalidated by an eagerly-subscribed `BundleChanged` stream forked with `Effect.forkScoped`.
- **`mounts.ts`** (`mountsRouter`) — `Effect.fn` factory over a bundle **snapshot** (`yield* bundleService.all()` at the call site). Mounts were always computed once at startup in the old `MountsLib`, so snapshot semantics are intentional; no service handle or event subscription needed.
- **`sounds.ts`** (`soundsRouter`) — `Effect.fn` factory over a bundle snapshot + `Replicator`; declares the sound-cue replicants at setup, routes stay sync. Matches the old `SoundsLib` exactly.
- **`assets.ts`** (`assetsRouter`) — the most Effect-native of the set: scoped chokidar watcher via `_effect/chokidar.ts` (`getWatcher` + `listenToAdd/Change/Unlink/Error`), initial-scan batching via `waitForReady` + `Stream.runForEachChunk`, per-file 500ms change debounce via `Stream.groupByKey` + `GroupBy.evaluate` + `Stream.debounce`, all forked with `Effect.forkScoped` so the watcher and fibers die with the server scope.
- **`sentry-config.ts`** (`sentryConfigRouter`) — migrated in Phase 4 (uses `awaitReady` Deferred + eager `GitChanged` subscription with `BundleEvent.$is`); listed here for completeness since it is also a route lib.
- **`graphics/index.ts`** (`graphicsRouter`) — `Effect.fn` factory, `Runtime.runSync` bridge, composes `registrationCoordinator`.
- **`graphics/registration.ts`** (`registrationCoordinator`) — `Effect.fn`, eager `BundleChanged`/`GitChanged` subscription for instance status updates, `Runtime.runSync` bridge inside the Socket.IO handlers.
- **`server/index.ts`** (`createServer`) — already yields all router factories and mounts their results in the original order (registration → graphics → dashboard → mounts → sounds → assets → shared-sources); no changes needed.

### Cleanup pass (this phase's actual code changes)

1. **`graphics/registration.ts`** — the last raw timer in the route libs: the socket `disconnect` handler used `setTimeout(() => removeRegistration(socket.id), 1000)`. Replaced with an `Effect.fn` (`removeRegistrationLater`: `Effect.sleep("1 second")` → remove) forked from the sync callback via the captured runtime:

   ```typescript
   Runtime.runFork(runtime, removeRegistrationLater(socket.id));
   ```

   `Runtime.runFork` is the fire-and-forget analog of the established `Runtime.runSync` bridge — same lifecycle as the old `setTimeout` (not interrupted by scope close, which matches the previous behavior exactly).

2. **`graphics/index.ts`**, **`shared-sources.ts`** — removed the `req.params as Record<string, string>` type assertions (guideline: no type assertions). Express's `RouteParameters` inference plus plain destructuring (the pattern `dashboard.ts` already used) suffices.

3. **`assets.ts`** — removed the `(e as Error).stack` assertion in the watcher error stream; replaced with an `instanceof Error` narrowing (`error instanceof Error ? error.stack : error`), identical output for the only realistic case.

No routes, paths, status codes, headers, or timings changed.

## Key Decisions

### 1. No new `Effect.Service` wrappers for route libs

**Decision**: Keep the route libs as plain `Effect.fn` factories, not `Effect.Service` classes.

**Rationale**: They are constructed exactly once inside `createServer`, take per-server parameters (`io`, `bundleService`, `replicator`, bundle snapshots), and return an Express router — there is no shared capability other code needs to resolve from context. Wrapping them in services would be the "don't wrap Effect services" anti-pattern from the guidelines and would add DI machinery with no consumer.

### 2. Snapshot parameters stay (mounts, sounds, assets, shared-sources)

**Decision**: These four keep receiving `MoonCG.Bundle[]` snapshots (`yield* bundleService.all()` at the call site in `createServer`) instead of the `BundleService` handle.

**Rationale**: The old classes also worked off a one-time `bundleManager.all()` snapshot (routes for hot-added bundles were never registered dynamically). Passing the service handle would suggest reactivity these libs never had; behavior parity wins. Revisit if/when dynamic mount/sound registration becomes a feature.

### 3. `Runtime.runFork` for fire-and-forget delays from sync callbacks

**Decision**: Bridge delayed work out of sync Socket.IO callbacks with `Runtime.runFork(runtime, effect)` rather than `Effect.forkScoped` (impossible from a sync callback) or keeping `setTimeout`.

**Rationale**: Completes the bridge-pattern family: `Runtime.runSync` for sync reads, `Runtime.runFork` for fire-and-forget effects. The fiber is a root fiber, mirroring `setTimeout`'s independence from the server scope — intentional here, because pending removals should complete (or die with the process), just like before.

## Effect Patterns Established

### Runtime bridge family for sync callback contexts

Capture the runtime once at setup, then from sync Express/Socket.IO callbacks:

- `Runtime.runSync(runtime, bundleService.find(name))` — synchronous, effect is a pure Ref read
- `Runtime.runFork(runtime, removeRegistrationLater(socket.id))` — fire-and-forget with `Effect.sleep`, functional replacement for `setTimeout` at the imperative boundary

### Router factory shape

```typescript
export const xRouter = Effect.fn("xRouter")(function* (deps) {
  const runtime = yield* Effect.runtime(); // only if sync handlers need bridging
  const app = express();
  // ... declare replicants, acquire scoped resources, register routes ...
  const subscription = yield* PubSub.subscribe(bundleService.subscribe); // eager!
  yield* Effect.forkScoped(Stream.fromQueue(subscription).pipe(/* ... */));
  return app;
});
```

`createServer` composes them: `app.use(yield* xRouter(deps))`.

## Lessons Learned

### Migration accounting

- Top-down consumer migrations (Phase 4) can silently complete most of a later phase. Auditing the actual code before planning avoided rewriting seven already-idiomatic modules; Phase 5 shrank to a cleanup + documentation pass.
- The remaining violations were all at the imperative boundary (sync callbacks): type assertions on `req.params` and a `setTimeout`. Worth grepping for `as ` and `setTimeout|setInterval` explicitly when auditing "already migrated" modules.

## Files Modified

- `workspaces/mooncg/src/server/server/graphics/registration.ts` — `setTimeout` → `removeRegistrationLater` (`Effect.fn` + `Effect.sleep`) forked via `Runtime.runFork`
- `workspaces/mooncg/src/server/server/graphics/index.ts` — removed `req.params` type assertion
- `workspaces/mooncg/src/server/server/shared-sources.ts` — removed `req.params` type assertion
- `workspaces/mooncg/src/server/server/assets.ts` — removed `as Error` assertion (instanceof narrowing)
- `docs/effect-migration/strategy.md` — Phase 5 marked complete with implementation summary

Audited, unchanged (already idiomatic): `dashboard.ts`, `mounts.ts`, `sounds.ts`, `sentry-config.ts`, `graphics/index.ts` (structure), `server/index.ts`.

## Verification

- `npm run build`, `npm run typecheck`, `npm run lint` — clean
- `FORCE_COLOR=0 npx vitest run` — full suite green (exact numbers in the phase report)
