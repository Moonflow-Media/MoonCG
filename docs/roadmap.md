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
| 9   | Registry and catalog          | Static JSON bundle index (several URLs, pluggable source), catalog page, update checks at start and every 6 hours, update hints    | Next   | —           |

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

## Not possible to verify here

- Signing in with real Twitch, Discord or OpenID Connect providers; only a mock provider is tested.
- A real console Ctrl-C on Windows; shutdown is tested with a signal raised in the process.

## Deferred

Planned, but not part of milestones 0–9:

- Optimistic replicant updates on the client.
- Streaming request and response bodies for extension HTTP routes.
- CSS hot swap without a page reload.
- Sound cues.
- Storage adapters other than SQLite.
- Sandboxing bundles; installed bundles are trusted code.
- Translations of the dashboard.
- Module hooks for storage adapters, registry sources and dashboard pages.
- MoonCG publish to npm.
- A public registry with a catalog of bundles and modules, and a way to publish them.
- Detailed documentation of the MoonCG like https://www.nodecg.dev/ just better.
