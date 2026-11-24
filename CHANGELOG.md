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

## [0.4.0] - 2026-11-24

Accounts and permissions. Wire protocol version 4.

### Added

- Users with a user name and a password, signed in through `POST /api/v1/auth/login` with an
  HttpOnly, SameSite=Lax session cookie. Sessions end after 7 days without use and at the latest
  after 30 days. `POST /api/v1/auth/logout`, `GET /api/v1/me` and `POST /api/v1/me/password`.
- First-time setup: with no user in the database the server prints a one-time setup URL;
  `/setup` and `POST /api/v1/setup` create the first administrator and then answer 404.
- Roles and grants, stored in the database. Built-in roles `admin`, `operator`, `viewer` and
  `graphics`. A bundle's `defaultRoles` become grants of the built-in roles the first time the
  server sees the bundle, and are not applied again after that.
- System permissions `system:users.manage`, `system:tokens.manage`, `system:settings.manage`
  and `system:logs.view`, next to `system:dashboard.view` and `system:bundles.manage`.
- REST API for users, roles and grants under `system:users.manage`: `/api/v1/users` and
  `/api/v1/roles`. The last enabled administrator cannot be deleted, disabled or demoted;
  built-in roles cannot be deleted; `admin` always holds `*`.
- API tokens (`mcg_…`) with a name, their own grants and an optional expiry, managed under
  `system:tokens.manage` at `/api/v1/tokens`. Accepted as `Authorization: Bearer` over HTTP and
  when opening the WebSocket. A token holds a permission only while its own grants and its
  owner's roles both cover it.
- `?token=mcg_…` on any `GET` below `/b/` is exchanged for an HttpOnly cookie and redirected to
  the same URL without the token, for browser sources in OBS. Revoking the token ends the cookie.
- Login throttling per user name and per remote address, with a growing delay and 429 answers.
- `mooncg user create|list|passwd` and `mooncg token create|list|revoke`, working directly on a
  data directory, also while a server runs on it.
- `--secure-cookies` and `--trust-proxy` (`MOONCG_SECURE_COOKIES`, `MOONCG_TRUST_PROXY`), and a
  warning when the server listens beyond loopback without secure cookies.
- Login and setup pages; the shell shows who is signed in, has a sign-out button and hides the
  bundle buttons from users who may not manage bundles.
- Extensions: `sender.kind` (`user`, `token` or `extension`) on every message, and
  `ctx.permissions.check(sender, name)` to test a sender against the bundle's own permissions.
- Read-only replicant `system:revision` (`{ bundles: <counter> }`), which moves when a bundle
  changes, for pages that show the bundle list.
- `docs/permissions.md`.
- Bundle route handlers get `request.sender` (`{ principal, kind, bundle }`), the same shape
  as a message's sender.
- `revokeTokens` on `POST /api/v1/me/password` (default `false`) and on
  `PUT /api/v1/users/:id/password` (default `true`); `mooncg user passwd` revokes the user's
  tokens unless `--keep-tokens` is given.
- `X-Content-Type-Options: nosniff` and `Referrer-Policy: same-origin` on every answer; a
  Content-Security-Policy and `X-Frame-Options: DENY` on the server's own pages;
  `frame-ancestors 'self'` on bundle files.

### Changed

- **Breaking:** nothing is served without signing in. The server no longer treats every request
  as a local administrator; a request without a valid session or token is anonymous and gets
  401. After upgrading, open the setup URL the server prints, or run `mooncg user create`.
- **Breaking:** wire protocol version 4. `sender` in `msg` and `msg.call` has the new field
  `kind`; new messages `perm.check` and `perm.res`. Clients of version 3 are refused.
- **Breaking:** the implicit bundle permission `bundle:<name>:access` is gone. A panel, graphic,
  replicant, message, route or file whose manifest entry names no permission is now open to
  whoever holds at least one permission of that bundle. Grants of `bundle:<name>:access` no
  longer match anything.
- **Breaking:** the replicant `system:bundles` now requires `system:bundles.manage` instead of
  `system:dashboard.view`. Pages for everyone follow `system:revision` and fetch
  `GET /api/v1/bundles`.
- **Breaking:** `GET /api/v1/bundles` lists only the bundles the caller holds a permission of
  (all of them with `system:bundles.manage`) and has the new field `canManage`.
- **Breaking:** `/sdk/mooncg.js` and the WebSocket upgrade need a signed-in principal instead of
  `system:dashboard.view`, so a token limited to one bundle permission can run a graphic. An
  anonymous upgrade is refused with 401.
- **Breaking:** a state-changing request authenticated by a cookie must carry
  `Content-Type: application/json` or the header `X-MoonCG-CSRF`, also on bundle routes.
- **Breaking:** a bundle the caller holds no permission of is answered like one that does not
  exist: 404 under `/b/<bundle>/`, `not_found` for its replicants, messages and `hello`.
- **Breaking:** `HttpRequestData` in `@mooncg/core` (the request of an `http.call`) has the
  required field `sender`.
- An open socket is closed with code 4401 when the access of its user or token changes; the SDK
  reconnects.
- The data directory's `mooncg.db` is migrated to schema version 3 (users, identities, roles,
  role grants, user roles, tokens, sessions, bundle defaults). Foreign keys are enforced.
- In `@mooncg/server`, `startServer` and `createApp` take `policy` and `resolvePrincipal` only
  as an injection for tests; `Storage` has the new member `auth`.
- The `scoreboard` example grants `view` to the built-in role `graphics`.

### Security

- Passwords are hashed with scrypt, each with its own salt and with the parameters stored next
  to the hash. A login for an unknown user takes as long as one for a known user and answers
  the same.
- Session and token secrets are stored as SHA-256 hashes only. A token's secret is shown once.
- API tokens are replaced by `mcg_***` in every log line and in every error message.
- Bundle route handlers no longer receive the caller's `Authorization` and `Cookie` headers or
  a `token` query parameter.
- Changing or resetting a password and disabling a user end all sessions of that user.
- The login and the setup are subject to the `Origin` check like every state-changing request.
  The check compares the scheme as well as host and port.
- The setup code is single-use also for requests that arrive at the same moment.
- Login attempts are counted when they arrive, so a burst of simultaneous attempts is throttled
  like a sequence. At most 4 passwords are hashed at a time, with a bounded queue.
- Login throttling is per user name and address, and per address; the limit per user name
  alone is a short circuit breaker (100 attempts, at most 60 s), so knowing a name is not
  enough to lock its owner out.
- A user name that cannot be one and an over-long password are answered like a wrong password
  without being looked up or hashed. The account routes read at most 16 KiB of body.
- Changing the own password is throttled like a login.
- Whoever manages users and roles can only give, take or take over what they hold themselves.
- Session cookies are named with the `__Host-` prefix when they are `Secure`; a request with
  the same session cookie twice is not signed in.
- A browser session a token was exchanged for ends with the token, at most after 90 days.
- A wrong `?token=` no longer overrides valid credentials.
- Bundle errors in `GET /api/v1/bundles` and `system:bundles` have API tokens redacted.
- The database migration takes the write lock before it reads the version.
- A login or password change that overlaps with disabling the user or resetting the password
  no longer wins over it.

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
