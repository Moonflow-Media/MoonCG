# Roadmap

MoonCG is built in milestones. Each one ends with a working server, its own entry in
[CHANGELOG.md](../CHANGELOG.md), and a commit. Milestones 1–7 are the first complete version;
8 and 9 extend it.

Milestone 6 was postponed and done after 7, so the version numbers do not follow the
milestone numbers.

## Milestones

| #   | Milestone                     | What it covers                                                                                                                     | Status | Version     |
| --- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------- |
| 0   | Tooling                       | pnpm workspace, TypeScript project references, Vitest, Biome                                                                       | Done   | 0.1.0–0.3.0 |
| 1   | Walking skeleton              | Load a bundle, serve panels and graphics, sync a replicant over WebSocket, minimal shell, `authorize()` at every entry point       | Done   | 0.1.0–0.3.0 |
| 2   | Replicants                    | JSON patches, revisions and conflicts, schema validation, persistence, reconnect, Vue and React hooks, `mooncg types`              | Done   | 0.1.0–0.3.0 |
| 3   | Extension runtime             | One worker thread per bundle extension, resource ledger, messages and requests, HTTP routes, crash handling, enable/disable/reload | Done   | 0.1.0–0.3.0 |
| 4   | Accounts and permissions      | Users, sessions, roles, per-bundle permissions, API tokens, first-run setup, enforcement everywhere                                | Done   | 0.4.0       |
| 5   | Dashboard                     | Workspaces, per-user layout, dialogs, graphic instances, assets, bundle config forms, admin pages, logs (redesign in 0.6.0)        | Done   | 0.5.0       |
| 6   | Live reload and developer use | File watcher, page reloads, `dev.url`, `mooncg start`/`dev`/`init`/`bundle create`, `mooncg.config.json`, On Air lock              | Done   | 0.8.0       |
| 7   | Bundle management             | Install from a folder, ZIP or Git, npm dependencies, update with backup and rollback, remove, restore, CLI and dashboard           | Done   | 0.7.0       |
| 8   | Modules and external logins   | Modules in `modules/`, `@mooncg/sdk/module`, the `auth-oidc` module (OpenID Connect, Twitch, Discord), linking external accounts   | Done   | 0.9.0       |
| 9   | Registry and catalog          | Static JSON bundle index (several URLs, pluggable source), catalog page, update checks at start and every 6 hours, update hints    | Done   | 0.11.0      |

## Gaps closed after 0.9.0 (released in 0.10.0)

Before milestone 9, gaps left by milestones 6–8 were closed (in `[Unreleased]` of the
changelog):

- Dev mode: no automatic sign-in for requests another site causes (Fetch Metadata).
- Dashboard: list and restore backups; remove with deleting files or data.
- Staged bundles survive a server restart, checked again from their files.
- Opt-in tests against a real Git repository and a real `npm ci`.
- A Vite + Vue bundle template, checked by an opt-in test with a real Vite dev server; its
  proxy to MoonCG refuses other computers.
- Installing, updating and removing modules through the installer.
- An account page where users link and unlink their own external accounts, with the password
  or a fresh sign-in.
- Up to three OpenID Connect providers per installation.

## After 0.11.0 (released in 0.12.0)

Open points closed after milestone 9 (in `[Unreleased]` of the changelog):

- A real `https://` index: an opt-in test adds the example index of this repository as GitHub
  serves it raw and installs the scoreboard from it through the real download and checks.
- Git sources resolve-checked and pinned: the host is resolved and checked by the rules of the
  registry before git runs, and git is pinned to the checked addresses
  (`http.curloptResolve`) and follows no redirect. SSH addresses are checked, not pinned.
  The pin does not fail open: Git older than 2.37 is refused for `https://`, git runs without
  proxies and without configuration from the environment, `url.*.insteadOf` rewrites are
  checked where they lead, and resolving the host counts towards the time of the stage. Git
  behind an HTTP proxy is no longer supported.
- NAT64 and 6to4 addresses checked as the IPv4 address they carry, or as internal.
- Indexes and sources on a private network, opened by the configuration alone
  (`registryAllowPrivate`, `registryAllowPrivateHttp`).
- Live update hints (`system:updates.bundles`, `system:updates.modules`) on the Bundles,
  Modules and Catalog pages, counting up only when something changed, at least every 2 s
  under a steady stream of changes.
- Dialogs from pages of a development server in dev mode, with a strict per-bundle origin
  check, also for dialog pages served by the development server, over `http://` or
  `https://` on this machine.
- Module hooks `registry.registerSource` and `dashboard.registerPage`.

## After 0.12.0 (released in 0.13.0)

Deferred features taken up after 0.12.0 (in `[Unreleased]` of the changelog, wire protocol
version 7):

- Optimistic replicant updates: `mc.replicant(name, { optimistic: true })` shows the client's
  writes at once, keeps them in order, takes back what the server refuses and applies the
  remaining writes again on top of the server's value. Without the option nothing changed.
- Streamed request and response bodies for extension HTTP routes (`{ stream: true }`,
  `request.stream`, a `ReadableStream` or async iterable as the answer), with backpressure,
  the server's body limit unless the route sets its own, an operator cap for every streamed
  body (`--max-stream-body-bytes`), at most 16 streaming calls per extension, a pace for
  uploads (408) and a drain timeout for answers, and cancellation when the client goes away
  or the extension stops.
- CSS hot swap: a change to nothing but stylesheets of `dashboard/` (and, in dev mode,
  `graphics/`) loads them again in the open pages without a reload. Graphics outside dev mode
  are still only marked out of date.

## Not possible to verify here

- Signing in with real Twitch, Discord or OpenID Connect providers; only a mock provider is tested.
- A real console Ctrl-C on Windows; shutdown is tested with a signal raised in the process.
- A real Git older than 2.37 (refused by its `git --version`, tested with a stand-in), and a
  real proxy or `url.*.insteadOf` setting in the machine's Git configuration (tested with a
  stand-in for git); only Git for Windows 2.52 was used here, with and without its OpenSSL
  backend, the real fetch with the cleaned environment included.
- Schannel with a private certificate authority and its revocation check
  (`http.schannelCheckRevoke`); only public certificates were fetched here.
- A real NAT64 or 6to4 network; the address rules are tested on their own.
- DNS rebinding against SSH Git addresses, which are checked but not pinned.
- Dialogs from a development server in Firefox or Safari, which do not tell a page the origins
  of the frames around it, and from a development server over `https://`; the opt-in Vite test
  runs in Chromium over `http://`.

## Deferred

Planned, but not part of milestones 0–9:

- Sound cues.
- Storage adapters other than SQLite, and `storage.registerAdapter` for modules (see
  [modules.md](modules.md#what-is-not-there-yet) for why it is left out).
- Sandboxing bundles. It conflicts with the trust model: installed bundles are trusted code
  that runs with the rights of the server, and a worker thread is isolation against
  accidents, not a sandbox.
- Translations of the dashboard.
- Signed registry indexes and archives.
- MoonCG publish to npm.
- A public registry with a catalog of bundles and modules, and a way to publish them.
- Detailed documentation of the MoonCG like https://www.nodecg.dev/ just better.
- Standalone Registry Server, with its own configuration, database and catalog page, and a way to publish bundles and modules to it.
