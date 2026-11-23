# Changelog

All notable changes to MoonCG are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). All packages in this repository
share one version number.

While the version is below 1.0.0, a minor release (0.x.0) may contain breaking changes; patch
releases (0.x.y) only fix bugs. The wire protocol has its own version number, listed per release.

Versions 0.1.0 to 0.3.0 were developed before the first commit and are recorded together in the
initial commit of the repository.

## [Unreleased]

## [0.3.0] - 2026-11-23

Extension runtime. Wire protocol version 3.

### Added

- Each bundle extension runs in its own worker thread. A crash, an exceeded memory limit
  (`--extension-memory-mb`, default 256) or an unresponsive extension fails only that bundle.
- Automatic restart of a crashed extension after 1 s, 2 s and 4 s, at most three times; one minute
  of stable running resets the count.
- Heartbeat for extensions: 10 s without a reply counts as a crash
  (`--extension-heartbeat-timeout-ms`). Start timeout of 10 s (`--extension-start-timeout-ms`).
- Messages: `send` to all listeners of a topic and `request` to exactly one handler with a timeout
  (default 5 s). Topics are declared under `messages` in `mooncg.json` with `send` and `listen`
  permissions. Available in extensions and in the browser SDK (`mc.send`, `mc.on`, `mc.request`).
- HTTP routes for bundles under `/b/<bundle>/api/…`, registered with `ctx.http.get/post/put/patch/delete`.
  Request bodies are limited by `--max-body-bytes` (default 1 MiB).
- Runtime lifecycle: `POST /api/v1/bundles/<name>/enable`, `disable` and `reload`, without a server
  restart. A disabled bundle stays disabled across restarts.
- Read-only replicant `system:bundles` with the state of every bundle; the shell page follows it
  and offers enable, disable and reload buttons.
- Bundle dependencies: start order follows `dependencies`; a missing dependency, an unsatisfied
  version range or a cycle fails the affected bundles only.
- Capabilities for cross-bundle access from extensions: `bundle:<name>:read`, `bundle:<name>:write`
  and `http.routes`.
- `@mooncg/sdk/extension` with the `BundleContext` types and `MoonCGError` for typed error
  responses. Extensions can import it without installing anything; the server provides its own copy.
- Origin check for all state-changing HTTP requests, matching the existing check for WebSockets.
- Limits against misbehaving extensions: log lines per second, message rate, frame size and the
  number of unanswered calls.
- `docs/extensions.md`.

### Changed

- **Breaking:** wire protocol version 3. Clients built against version 2 are refused.
- **Breaking:** the extension API is asynchronous throughout and `BundleContext` now lives in
  `@mooncg/sdk/extension`.
- **Breaking:** an extension needs both a `dependencies` entry and a capability to use another
  bundle's replicants or messages.
- The server accepts connections as soon as the bundles are known; extensions start in the
  background and show as `enabling` until they are ready.
- A bundle cannot be disabled while running bundles depend on it. Reloading it restarts its
  dependents; if it crashes, its dependents are stopped and started again once it is back.
- Error messages published in the bundle list no longer contain absolute server paths.
- All HTTP errors use the `{ "error": { "code", "message" } }` shape.

## [0.2.0] - 2026-11-23

Replicants complete. Wire protocol version 2.

### Added

- Schema validation: a replicant can name a JSON Schema file in `mooncg.json`. Every change, from
  a browser client or an extension, is validated on the server and rejected with `invalid` if it
  does not match. JSON Schema draft-07 and 2020-12 are supported.
- Persistence: replicants with `persistent: true` are stored in `data/mooncg.db` (SQLite) and
  restored on start. The data directory is set with `--data-dir` or `MOONCG_DATA_DIR`.
- Write-behind saving (250 ms after the last change, at most 1 s after the first) with automatic
  retry after a failed save.
- Reconnect with replay: a client that reconnects receives only the changes it missed when they
  are still buffered, otherwise a full snapshot.
- `@mooncg/sdk/vue` and `@mooncg/sdk/react` with `useReplicant()`; React also has
  `useReplicantError()`.
- `mooncg types`: generates `mooncg-env.d.ts` from a bundle's replicant schemas so that
  `replicant('name')` is typed without a manual type argument.
- Clients are told when a replicant goes away (`rep.gone`); the handle exposes this as `error`.

### Changed

- **Breaking:** wire protocol version 2. Clients built against version 1 are refused.
- Connecting for a bundle that is not running is refused with `not_found`.
- A bundle whose schema file is missing or unusable, or whose default value does not match its
  schema, is marked `failed`.

## [0.1.0] - 2026-11-23

Walking skeleton. Wire protocol version 1.

### Added

- Monorepo with `@mooncg/core`, `@mooncg/server` and `@mooncg/sdk`.
- Bundle manifest `mooncg.json` with validation; an invalid manifest fails only that bundle.
- Replicants: server-authoritative shared state with one revision counter per replicant, changes
  as JSON Patch (`add`, `remove`, `replace`), and rejection of changes based on an outdated revision.
- Replicants are declared in the manifest only; clients cannot declare them.
- HTTP server with the bundle list at `/api/v1/bundles`, panels and graphics under
  `/b/<bundle>/dashboard/…` and `/b/<bundle>/graphics/…`, and a minimal shell page at `/`.
- WebSocket endpoint `/ws` and the browser SDK at `/sdk/mooncg.js`, imported by pages rather than
  injected into them.
- Permission check `authorize()` at every route and for every replicant operation. All users are
  still allowed everything; the server therefore listens on `127.0.0.1` only.
- Origin check for WebSocket connections, with `--allowed-origin` for additional origins.
- Example bundle `examples/scoreboard`.
