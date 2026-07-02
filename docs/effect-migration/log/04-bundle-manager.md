# Phase 4: BundleManager Migration to Effect-TS

**Status**: ✅ Complete
**Complexity**: ⭐⭐⭐ Complex

## Overview

Migrate BundleManager from class-based EventEmitter architecture to Effect-based service using streams for file watching and PubSub for event distribution. This is the next logical step following the top-down (architecture/data/call flow) migration strategy, as BundleManager is the source of bundles (primary data) that all other subsystems consume.

## Goals

- Replace class-based BundleManager with functional BundleService
- Convert Chokidar file watching to Effect streams
- Replace EventEmitter with PubSub for event distribution
- Maintain hot-reloading functionality for bundles
- Update all consumers (GraphicsLib, DashboardLib, ExtensionManager, etc.)
- Delete old BundleManager code (no legacy code left)

## Current Architecture Analysis

### BundleManager Responsibilities

1. **Initial bundle loading** - Scans multiple paths for bundles at startup
2. **Bundle validation** - Checks compatibleRange, enabled/disabled lists
3. **File watching** - Monitors package.json, dashboard panels, .git changes via Chokidar
4. **Hot-reloading** - Re-parses and reloads bundles when files change
5. **Event emission** - Notifies consumers via events (ready, bundleChanged, gitChanged, invalidBundle, bundleRemoved)

### Dependencies

- `parseBundle` from bundle-parser (fp-ts based, functional)
- `parseBundleGit` for git metadata
- `loadBundleCfg` for bundle configs (cosmiconfig)
- Chokidar file watcher (module-level singleton)

### Consumers

- **GraphicsLib** - Uses `find()`, listens to `bundleChanged`, `gitChanged`
- **DashboardLib** - Uses `all()`, `find()`, listens to `bundleChanged`
- **ExtensionManager** - Uses `all()`, calls `remove()`
- **Server bootstrap** - Uses `all()`, listens to all events for bundles replicant
- **SentryConfig** - Listens to `ready`, `gitChanged`
- **MountsLib, SoundsLib, AssetsLib, SharedSourcesLib** - Uses `all()` snapshot

### Key Challenges

1. **Module-level singleton watcher** - Needs to become scoped resource
2. **Module-level bundles array** - Needs to become service state
3. **Event-based API** - Heavily used by consumers (multiple listeners)
4. **Backoff timer** - Debouncing changes without global state
5. **Git parsing** - Uses `process.chdir()` (side effect, needs isolation)

## Target Architecture

### Service Definition

```typescript
// Service with Ref for mutable state, PubSub for events
class BundleService extends Effect.Service<BundleService>()("BundleService", {
  scoped: Effect.gen(function* () {
    const bundles = yield* Ref.make<Array<MoonCG.Bundle>>([]);
    const pubsub = yield* PubSub.unbounded<BundleEvent>();
    const watcher = yield* createFileWatcher([], watchOptions);

    // Load initial bundles
    const initialBundles = yield* loadInitialBundles();
    yield* Ref.set(bundles, initialBundles);

    // Setup file watching stream
    yield* Effect.forkScoped(watchFiles(watcher, bundles, pubsub));

    // Emit ready event after threshold
    yield* Effect.forkScoped(
      Effect.sleep("1 second").pipe(
        Effect.flatMap(() => PubSub.publish(pubsub, { _tag: "ready" })),
      ),
    );

    return {
      all: Effect.fn(() => Ref.get(bundles)),
      find: Effect.fn((name: string) =>
        Ref.get(bundles).pipe(
          Effect.map((arr) => arr.find((b) => b.name === name)),
        ),
      ),
      subscribe: pubsub,
      add: Effect.fn((bundle) => {
        /* update Ref */
      }),
      remove: Effect.fn((name) => {
        /* update Ref + publish event */
      }),
    };
  }),
}) {}
```

### Event Types

```typescript
import { Data } from "effect";

// Define events using Effect's TaggedEnum
const BundleEvent = Data.taggedEnum<{
  Ready: {};
  BundleChanged: { readonly bundle: MoonCG.Bundle };
  GitChanged: { readonly bundle: MoonCG.Bundle };
  InvalidBundle: { readonly bundle: MoonCG.Bundle; readonly error: Error };
  BundleRemoved: { readonly bundleName: string };
}>();

type BundleEvent = Data.TaggedEnum.Value<typeof BundleEvent>;

// Usage - constructors automatically created:
BundleEvent.Ready({});
BundleEvent.BundleChanged({ bundle });
BundleEvent.GitChanged({ bundle });
BundleEvent.InvalidBundle({ bundle, error });
BundleEvent.BundleRemoved({ bundleName });
```

### Key Patterns

- `Ref<Array<MoonCG.Bundle>>` for mutable bundle list
- `PubSub<BundleEvent>` for event distribution (replaces EventEmitter)
- `Stream` for Chokidar file watching events
- `Effect.acquireRelease` for watcher lifecycle management
- `Effect.forkScoped` for background file watching
- Debouncing via `Effect.sleep` instead of timer references

## Key Decisions

### 1. PubSub vs Queue for Event Distribution

**Decision**: Use `PubSub` for event distribution

**Rationale**:

- Multiple consumers need to receive the same events
- Queue consumes messages (only one subscriber gets each event)
- PubSub broadcasts to all subscribers (EventEmitter replacement)
- Each consumer can filter events they care about via Stream

### 2. Service Layer Parameters vs Config Service

**Decision**: Pass parameters to layer creation function for now

**Rationale**:

- Config service migration is deferred (not prioritized for top-down approach)
- BundleService needs bundle paths, cfgPath, version, config immediately
- Layer creation function can accept these as parameters
- Can refactor to ConfigService later when available

### 3. Chokidar Wrapper Strategy

**Decision**: Create Effect wrapper that converts Chokidar events to Stream

**Rationale**:

- Chokidar is callback-based, needs Effect integration
- Stream is perfect for continuous file events
- `Effect.acquireRelease` ensures watcher cleanup
- Stream can be forked in background with automatic cleanup

### 4. Debouncing Strategy

**Decision**: Use `Effect.sleep` with Ref-based state tracking

**Rationale**:

- No global timer references (pure functional)
- Ref tracks which bundles have pending changes
- Sleep provides natural debounce window
- Composable with Effect error handling

## Implementation Plan

### Step 1: Create General-Purpose File Watching Layer

**New file**: `workspaces/mooncg/src/server/_effect/file-watcher.ts`

General-purpose Chokidar → Effect Stream wrapper for reusable file watching across MoonCG.

```typescript
import { Data, Stream, Effect, Scope, Schedule, Duration } from "effect";
import type * as fs from "node:fs";
import type * as chokidar from "chokidar";

// File watcher events using TaggedEnum
export const FileEvent = Data.taggedEnum<{
  Add: { readonly path: string; readonly stats?: fs.Stats };
  Change: { readonly path: string; readonly stats?: fs.Stats };
  Unlink: { readonly path: string };
  AddDir: { readonly path: string; readonly stats?: fs.Stats };
  UnlinkDir: { readonly path: string };
  Ready: {};
}>();

export type FileEvent = Data.TaggedEnum.Value<typeof FileEvent>;

// Error types - separate initialization vs runtime errors
export class FileWatchInitError extends Data.TaggedError("FileWatchInitError")<{
  readonly cause: unknown;
}> {}

export class FileWatchError extends Data.TaggedError("FileWatchError")<{
  readonly cause: unknown;
}> {}

/**
 * Creates a file watcher as a scoped resource.
 * Automatically closes watcher when scope exits.
 *
 * @fails FileWatchInitError - When watcher creation fails (e.g., invalid path, permissions)
 */
export const createWatcher = (
  paths: string | ReadonlyArray<string>,
  options?: chokidar.WatchOptions,
): Effect.Effect<chokidar.FSWatcher, FileWatchInitError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.try({
      try: () => chokidar.watch(paths, options),
      catch: (cause) => new FileWatchInitError({ cause }),
    }),
    (watcher) => Effect.promise(() => watcher.close()),
  );

/**
 * Converts a Chokidar watcher to an Effect Stream of file events.
 * Stream continues until watcher is closed or error occurs.
 *
 * @fails FileWatchError - When filesystem errors occur during watching
 */
export const toStream = (
  watcher: chokidar.FSWatcher,
): Stream.Stream<FileEvent, FileWatchError> =>
  Stream.async<FileEvent, FileWatchError>((emit) => {
    const onAdd = (path: string, stats?: fs.Stats) =>
      emit.single(FileEvent.Add({ path, stats }));
    const onChange = (path: string, stats?: fs.Stats) =>
      emit.single(FileEvent.Change({ path, stats }));
    const onUnlink = (path: string) => emit.single(FileEvent.Unlink({ path }));
    const onAddDir = (path: string, stats?: fs.Stats) =>
      emit.single(FileEvent.AddDir({ path, stats }));
    const onUnlinkDir = (path: string) =>
      emit.single(FileEvent.UnlinkDir({ path }));
    const onReady = () => emit.single(FileEvent.Ready({}));
    const onError = (error: Error) =>
      emit.fail(new FileWatchError({ cause: error }));

    watcher.on("add", onAdd);
    watcher.on("change", onChange);
    watcher.on("unlink", onUnlink);
    watcher.on("addDir", onAddDir);
    watcher.on("unlinkDir", onUnlinkDir);
    watcher.on("ready", onReady);
    watcher.on("error", onError);

    return Effect.sync(() => {
      watcher.removeListener("add", onAdd);
      watcher.removeListener("change", onChange);
      watcher.removeListener("unlink", onUnlink);
      watcher.removeListener("addDir", onAddDir);
      watcher.removeListener("unlinkDir", onUnlinkDir);
      watcher.removeListener("ready", onReady);
      watcher.removeListener("error", onError);
    });
  });

/**
 * Creates watcher and returns Stream. Watcher is scoped to Stream's lifecycle.
 * Optionally retries on errors with exponential backoff.
 *
 * @param paths - Paths to watch
 * @param options - Chokidar watch options
 * @param retryConfig - Optional retry configuration for automatic error recovery
 * @returns Stream of file events
 * @fails FileWatchInitError | FileWatchError - Initialization or runtime errors
 *
 * @example
 * // Simple watch (no retry)
 * FileWatcher.watch(paths, { ignored: /node_modules/ })
 *
 * // With automatic retry (recommended for production)
 * FileWatcher.watch(paths, options, {
 *   maxRetries: 5,
 *   baseDelay: "1 second" // Exponential: 1s, 2s, 4s, 8s, 16s (with jitter)
 * })
 */
export const watch = (
  paths: string | ReadonlyArray<string>,
  options?: chokidar.WatchOptions,
  retryConfig?: {
    readonly maxRetries?: number;
    readonly baseDelay?: Duration.DurationInput;
  },
): Stream.Stream<
  FileEvent,
  FileWatchInitError | FileWatchError,
  Scope.Scope
> => {
  const stream = Stream.acquireRelease(
    createWatcher(paths, options),
    (watcher) => Effect.promise(() => watcher.close()),
  ).pipe(Stream.flatMap(toStream));

  // Apply retry if config provided
  if (retryConfig) {
    const maxRetries = retryConfig.maxRetries ?? 5;
    const baseDelay = retryConfig.baseDelay ?? "1 second";

    const retrySchedule = Schedule.exponential(baseDelay).pipe(
      Schedule.compose(Schedule.recurs(maxRetries)),
      Schedule.jittered, // Add randomness to prevent thundering herd
    );

    return stream.pipe(Stream.retry(retrySchedule));
  }

  return stream;
};
```

**Usage in BundleService**:

```typescript
import * as FileWatcher from "../_effect/file-watcher";

// Option 1: Simple watch (no retry)
yield *
  Effect.forkScoped(
    FileWatcher.watch(bundlePaths, {
      ignored: /node_modules/,
      ignoreInitial: true,
    }).pipe(
      Stream.filter((event) => event._tag === "Change"),
      Stream.runForEach((event) => handleChange(event.path)),
    ),
  );

// Option 2: Watch with automatic retry (RECOMMENDED for production)
yield *
  Effect.forkScoped(
    FileWatcher.watch(
      bundlePaths,
      {
        ignored: /node_modules/,
        ignoreInitial: true,
      },
      {
        maxRetries: 5,
        baseDelay: "1 second", // 1s, 2s, 4s, 8s, 16s (with jitter)
      },
    ).pipe(Stream.runForEach((event) => handleFileEvent(event))),
  );

// Option 3: Manual control (create watcher separately)
const watcher =
  yield *
  FileWatcher.createWatcher(bundlePaths, {
    ignored: /node_modules/,
    ignoreInitial: true,
  });

yield *
  Effect.forkScoped(
    FileWatcher.toStream(watcher).pipe(
      Stream.runForEach((event) => handleFileEvent(event)),
    ),
  );
```

**New file**: `workspaces/mooncg/src/server/_effect/git-parser.ts`

Effect wrapper for git parsing (isolates process.chdir side effect):

```typescript
import { Effect } from "effect";
import { parseBundleGit } from "../bundle-parser/git";

export const parseGit = Effect.fn("parseGit")(function* (bundleDir: string) {
  return yield* Effect.sync(() => parseBundleGit(bundleDir));
});
```

### Step 2: Implement BundleService

**New file**: `workspaces/mooncg/src/server/bundle-service.ts`

Core service implementation with:

- Initial bundle loading
- Ref for bundle list state
- PubSub for events
- File watcher setup
- File event processing stream
- Bundle change/git change handlers
- Debouncing logic

### Step 3: Update Consumers

**Pattern for migrating EventEmitter listeners to PubSub streams**:

```typescript
// Before (EventEmitter)
bundleManager.on("bundleChanged", (bundle) => {
  // Handle change
});

// After (PubSub + Stream)
yield *
  Effect.forkScoped(
    Stream.fromPubSub(bundleService.subscribe).pipe(
      Stream.filter((event) => event._tag === "BundleChanged"),
      Stream.runForEach((event) =>
        Effect.sync(() => {
          // Handle change with event.bundle
        }),
      ),
    ),
  );

// Or handle multiple event types
yield *
  Effect.forkScoped(
    Stream.fromPubSub(bundleService.subscribe).pipe(
      Stream.filter(
        (event) =>
          event._tag === "BundleChanged" || event._tag === "GitChanged",
      ),
      Stream.runForEach((event) =>
        Effect.sync(() => {
          // Both events have bundle property
          rebuildPanels(event.bundle);
        }),
      ),
    ),
  );
```

**Files to update**:

- `server/server/index.ts` - Replace BundleManager instantiation, update event listeners
- `server/graphics/index.ts` - Migrate event listeners
- `server/graphics/registration.ts` - Migrate event listeners
- `server/dashboard/index.ts` - Migrate event listeners
- `server/util/sentry-config.ts` - Migrate event listeners

### Step 4: Provide BundleService Layer

**Layer creation**:

```typescript
export const makeBundleServiceLayer = (
  bundlesPaths: string[],
  cfgPath: string,
  mooncgVersion: string,
  mooncgConfig: Record<string, any>,
) => Layer.scoped(BundleService /* implementation */);
```

**Bootstrap integration**:

```typescript
// In bootstrap.ts
const bundleServiceLayer = makeBundleServiceLayer(
  bundlesPaths,
  cfgPath,
  mooncgPackageJson.version,
  config,
);

yield * createServer().pipe(Effect.provide(bundleServiceLayer));
```

### Step 5: Update Tests

**Pattern**:

```typescript
test("bundle loading", async () => {
  await testEffect(
    Effect.gen(function* () {
      const bundleService = yield* BundleService;
      const bundles = yield* bundleService.all();

      expect(bundles.length).toBeGreaterThan(0);

      // Subscribe to events
      const events: BundleEvent[] = [];
      yield* Effect.forkScoped(
        Stream.fromPubSub(bundleService.subscribe).pipe(
          Stream.take(1),
          Stream.runForEach((event) => Effect.sync(() => events.push(event))),
        ),
      );

      // Trigger change, verify event received
    }).pipe(Effect.provide(testBundleServiceLayer)),
  );
});
```

**Files to update**:

- `workspaces/mooncg/src/server/bundle-manager.test.ts` - Rewrite for Effect
- `workspaces/mooncg/test/helpers/setup.ts` - Provide BundleService layer

### Step 6: Delete Old Code

Once all consumers migrated and tests passing:

- Delete `workspaces/mooncg/src/server/bundle-manager.ts`

## Files Modified

**New files**:

- `workspaces/mooncg/src/server/bundle-service.ts` - Main service
- `workspaces/mooncg/src/server/_effect/file-watcher.ts` - Chokidar wrapper
- `workspaces/mooncg/src/server/_effect/git-parser.ts` - Git parsing wrapper

**Modified files**:

- `workspaces/mooncg/src/server/server/index.ts` - Use BundleService
- `workspaces/mooncg/src/server/graphics/index.ts` - Subscribe to events
- `workspaces/mooncg/src/server/graphics/registration.ts` - Subscribe to events
- `workspaces/mooncg/src/server/dashboard/index.ts` - Subscribe to events
- `workspaces/mooncg/src/server/util/sentry-config.ts` - Subscribe to events
- `workspaces/mooncg/src/server/bundle-manager.test.ts` - Update to Effect
- `workspaces/mooncg/test/helpers/setup.ts` - Provide BundleService layer

**Deleted files**:

- `workspaces/mooncg/src/server/bundle-manager.ts` - Replaced by bundle-service.ts

## Testing Strategy

1. **Unit tests** - Test BundleService in isolation with mock file watcher
2. **Integration tests** - Test file watching with temp directories
3. **E2E tests** - Test bundle hot-reloading in real scenarios
4. **Regression tests** - Ensure all existing tests still pass

## Risks

1. **PubSub complexity** - Multiple consumers with different event filtering needs
2. **Chokidar lifecycle** - Proper cleanup of file watchers, avoiding leaks
3. **Race conditions** - File events vs bundle state updates (need proper sequencing)
4. **Backoff logic** - Debouncing rapid changes without global mutable state
5. **Git parsing isolation** - `process.chdir()` side effect needs careful handling
6. **Consumer migration scope** - Many files depend on BundleManager events

## Open Questions

1. **Debouncing strategy** - Should we use `Effect.debounce` or manual timing with `Ref`?
2. **Git parsing isolation** - Should we wrap `process.chdir()` more carefully or accept the side effect?
3. **Event filtering** - Should consumers filter PubSub events themselves, or should service provide filtered subscriptions?
4. **Error recovery** - How should service handle invalid bundles? Continue watching or fail?

## Next Steps

- [x] ~~Create file-watcher.ts wrapper~~ (superseded by existing `_effect/chokidar.ts`, see Implementation Notes)
- [x] ~~Create git-parser.ts wrapper~~ (not needed, see Implementation Notes)
- [x] Implement BundleService core
- [x] Implement file event processing
- [x] Update server/index.ts consumer
- [x] Update graphics consumer
- [x] Update dashboard consumer
- [x] Update other consumers
- [x] Update tests
- [x] Verify all tests pass
- [x] Delete bundle-manager.ts
- [x] Update this log with problems/solutions
- [x] Mark as Completed

## Implementation Notes

Implemented 2026-07-03. The plan above was written before the Phase 3 chokidar wrapper landed; the final implementation deviates from it in several places, documented below.

### Final Shape

- **New file**: `workspaces/mooncg/src/server/server/bundle-service.ts` (note: `src/server/server/`, next to the old `bundle-manager.ts`, not `src/server/` as the plan said)
  - `BundleEvent` via `Data.TaggedEnum` (`Ready`, `BundleChanged`, `GitChanged`, `InvalidBundle`, `BundleRemoved`)
  - `makeBundleService(options)` — `Effect.fn` returning the scoped service implementation (`all`, `find`, `add`, `remove`, `subscribe` (the `PubSub`), `awaitReady`)
  - `class BundleService extends Effect.Service<BundleService>()("BundleService", { scoped: makeBundleService })`
- **Deleted**: `bundle-manager.ts`, `bundle-manager.test.ts` (no legacy code kept)
- **Tests**: `bundle-service.test.ts` (all 9 test cases of the old suite migrated)

### Deviations from the Plan

1. **No `_effect/file-watcher.ts`** — The plan predates Phase 3. The existing `_effect/chokidar.ts` wrapper (`getWatcher` + `listenToAdd/Change/Unlink/Error` streams built on `_effect/event-listener.ts`) is used instead. Streams are subscribed _before_ initial bundle loading (mirroring the old handler registration order) and consumed with `Effect.forkScoped`.

2. **No `_effect/git-parser.ts`, and no `GitService` usage** — The existing `_effect/git-service.ts` (isomorphic-git) returns a different shape than `MoonCG.Bundle.GitData` (`branch` is `Option<string>` there, plain `string` here) and `parseBundle` itself still calls the synchronous `parseGit` (git-rev-sync) internally. To keep behavior and data shape identical, the `gitChanged` handler keeps calling the synchronous `parseGit` wrapped in `Effect.sync`. Unifying on `GitService` is deferred until the bundle-parser itself is migrated.

3. **Layer creation via `Effect.Service` args instead of a custom `makeBundleServiceLayer`** — `Effect.Service` supports `scoped: (…args) => Effect`, which turns the generated `BundleService.Default` into a _function_ `(options) => Layer<BundleService>`. That is the parameterized layer factory the plan asked for, with zero extra code.

4. **`createServer` builds the service directly, not via Layer** — The constructor parameters (`bundlesPaths`, `cfgPath`, version, config) are computed inside `createServer`, so it does `BundleService.make(yield* makeBundleService(options))` in the server scope and passes the instance to consumers as a parameter (same call topology as before). Full context-based DI (providing `BundleService.Default(options)` in bootstrap) is deferred; `BundleService.Default(options)` exists for tests and future use.

5. **`awaitReady` instead of `ready` flag + event** — Readiness is a `Deferred<void>`. `createServer` waits on `bundleService.awaitReady` with the same 15s timeout; this covers both the "already ready" and "not yet ready" branches of the old code. The `Ready` event is still published on the PubSub for parity.

### Behavior Parity

All timing/behavior of the old class was reproduced functionally:

- **READY_WAIT_THRESHOLD (1s, refreshed by `add` events)**: a `lastAddTime` Ref updated by `add` events (only before ready) plus a sleep-loop fiber that publishes `Ready` once 1s has elapsed since the last add.
- **100ms change delay**: `handleChange` forks `Effect.sleep("100 millis") → processChange` (does not block the event stream, like the old `setTimeout`).
- **500ms backoff**: a backoff fiber stored in a `Ref<Option<Fiber>>`; `resetBackoffTimer` interrupts and re-forks it (functional `clearTimeout`/`setTimeout`). Pending bundle names accumulate in a `Ref<HashSet<string>>`.
- **250ms git debounce**: same interruptible-fiber pattern; matches lodash `debounce` semantics (only the _last_ invocation's arguments within the window are processed, one shared debounce state for all bundles).
- **Blacklist** (`node_modules`, `bower_components`, dot-directories), **enabled/disabled config filter**, **compatibleRange check only in legacy mode**, and the **`watcher.add()` symlink workaround** (chokidar#419) were ported 1:1.
- **`add()` still publishes `BundleRemoved`** when replacing an existing bundle (the old `add` → `remove` → `emit` chain), so replicant updates behave identically.
- Log messages were kept semantically identical, emitted via `yield* Effect.log*` with `Effect.annotateLogs("module", "bundle-manager")` applied to the whole service scope (forked fibers inherit the annotation).

### Problems & Solutions

#### Problem 1: PubSub subscription race lost events

**Problem**: E2E test `bundles replicant` failed (6 bundles instead of 5) — the `BundleRemoved` event published while the ExtensionManager unloads a bundle with unsatisfied dependencies never reached the replicant updater.

**Root Cause**: `Stream.fromPubSub` only subscribes when the forked fiber actually starts running. The old `EventEmitter.addListener` subscribed synchronously. Events published between `Effect.forkScoped(...)` and the fiber's startup were dropped.

**Solution**: Subscribe eagerly with `yield* PubSub.subscribe(pubsub)` (scoped `Dequeue`) at setup time and consume with `Stream.fromQueue(subscription)` inside the forked fiber. Applied to all consumers (server/index.ts, dashboard.ts, graphics/registration.ts, sentry-config.ts).

```typescript
const subscription = yield * PubSub.subscribe(bundleService.subscribe);
yield *
  Effect.forkScoped(
    Stream.fromQueue(subscription).pipe(
      Stream.filter((event) => event._tag === "BundleChanged"),
      Stream.runForEach(handle),
    ),
  );
```

#### Problem 2: Mutual recursion between backoff and change handler

**Problem**: The old logic is cyclic: `handleChange → processChange → resetBackoffTimer → (timer fires) → handleChange`. With `const`-bound `Effect.fn` definitions and the "no return type annotations" rule, TypeScript cannot infer types in a reference cycle.

**Solution**: The backoff fiber does not call `handleChange` directly; it offers the pending bundle names to a `Queue<string>` (`delayedChanges`), and a separately forked consumer stream calls `handleChange`. This breaks the static reference cycle while preserving runtime behavior exactly.

#### Problem 3: Sync Express/Socket.IO handlers need `all()`/`find()`

**Problem**: Route and socket handlers are synchronous callbacks, but the service API is effectful.

**Solution**: The Phase-2 bridge pattern — capture the runtime once (`const runtime = yield* Effect.runtime()`) and call `Runtime.runSync(runtime, bundleService.find(name))` inside the callbacks. `all`/`find` are pure `Ref` reads, so `runSync` is safe.

#### Problem 4: Latent bug in sentry-config's `ready` listener

**Problem (pre-existing)**: The old code registered `once("ready")` inside `sentryConfigRouter`, but `createServer` only calls `sentryConfigRouter` _after_ awaiting the ready event — so the listener could never fire and the Sentry bundle metadata stayed empty.

**Solution**: `sentry-config.ts` now uses `bundleService.awaitReady` (a `Deferred`), which resolves even when readiness happened earlier. This intentionally fixes the latent bug (metadata is now populated); noted here as the one deliberate behavior change.

### Testing

- `bundle-service.test.ts` uses the `testEffect()` helper (repo is on vitest v4, so `@effect/vitest` was avoided per the guidelines; it would also inject `TestClock`, which conflicts with the service's live `Effect.sleep`-based timers).
- The long-lived service instance is created in `beforeAll` inside a manually managed `Scope.make()` and closed in `afterAll` (`Scope.close`), matching the old shared-`BundleManager` test structure. `MOONCG_ROOT` is set before a dynamic `import()` of the module, as before.
- Watcher tests subscribe eagerly via `PubSub.subscribe` _before_ touching files, then take the first matching event from the stream.
- The server handle now exposes `bundleService` instead of `bundleManager`; `test/helpers/setup.ts`, `test/installed-mode/setup.ts` and `test/legacy-mode/core.test.ts` were updated (`Effect.runSync(server.bundleService.all())`).

### Verification

- `npm run build`, `npm run typecheck`, `npm run lint` — clean
- `bundle-service.test.ts`: 9/9 passed
- `test/legacy-mode`: 184 passed, 5 skipped (18 files)
- `test/installed-mode`: 11 passed
- All other unit tests (`workspaces/mooncg/src`): 113 passed (18 files)

## Effect Patterns to Establish

### Pattern: Data.TaggedEnum for Event Types

Using `Data.TaggedEnum` to define discriminated union types with automatic constructors:

```typescript
const EventType = Data.taggedEnum<{
  TypeA: { readonly field: string };
  TypeB: { readonly num: number };
}>();

type EventType = Data.TaggedEnum.Value<typeof EventType>;

// Automatic constructors
const a = EventType.TypeA({ field: "value" });
const b = EventType.TypeB({ num: 42 });

// Pattern matching
if (event._tag === "TypeA") {
  console.log(event.field); // TypeScript knows the shape
}
```

**Benefits**: Type-safe constructors, automatic pattern matching support, follows Effect conventions.

### Pattern: Chokidar → Stream Conversion

Wrapping callback-based file watchers as Effect streams for composable file watching with proper resource management.

### Pattern: EventEmitter → PubSub Migration

Converting class-based EventEmitter APIs to functional PubSub + Stream patterns for event distribution to multiple consumers.

### Pattern: Stateful Service with Ref

Using `Ref` for mutable state within Effect services while maintaining referential transparency and composability.

### Pattern: Background Stream Processing

Forking long-running streams with `Effect.forkScoped` for automatic cleanup when scope closes.
