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

## [0.10.0] - 2026-11-25

### Added

- Dashboard: **Remove** on the Bundles page opens a confirmation in the bundle's row that says
  what is lost, with **Also delete its files** (the text then says how many older backups of
  the bundle remain, or that none does) and **Also delete its data** (purge: settings,
  uploaded assets, stored values and the role grants for the bundle). Removing a bundle that
  enabled bundles need is a separate question that names them and only then sends
  `"force": true`.
- Dashboard: a **Backups** card on the Bundles page lists the backups of every bundle, also
  of one that was removed, and restores one after a question that says what happens to the
  installed version and that the chosen backup is used up. When the list cannot be read, the
  card says why, apart from the jobs; an earlier answer that arrives late is ignored.
- `GET /api/v1/bundles/-/backups`: the backups of every bundle at once, with whether a bundle
  of that name is installed.
- Installing, updating and removing modules through the installer, with the same steps and
  checks as bundles (staging, archive and size bounds, Git hardening, npm trust opt-in):
  `mooncg module install <source>`, `module update <name> [<source>]`,
  `module remove <name> [--purge-data]`, the API below `/api/v1/modules/-/` and
  `/api/v1/modules/<name>/update|remove`, and **Install module**, **Update** and **Remove** on
  the Modules page. It takes `system:modules.manage`. The summary says that a module runs
  inside the server with full access; an installed module is disabled until it is enabled;
  updating or removing an enabled module is blocked while On Air unless overridden; a bundle
  is refused as a module and a module as a bundle. An update that does not start is rolled
  back. See `docs/modules.md`.
- `mooncg init` creates `modules/` and names it in the configuration file.
- `mooncg bundle create <name> --template vue`: a bundle with a panel and a graphic as Vue
  components, built by Vite 8 with `@vitejs/plugin-vue` 6 into `dashboard/` and `graphics/`,
  using `@mooncg/sdk/vue`, with `dev.url` set up for dev mode. Its Vite configuration serves
  the pages below `/b/<name>/` and proxies `/ws`, `/api`, `/sdk` and the bundle's routes and
  assets to MoonCG, so a page of the development server needs no `bundle`, `url` or `graphic`
  for `createClient` and no copy of `/sdk/mooncg.js`. `@mooncg/sdk` is named by its path, as
  it is not on npm; a path with quotes or `$` in it is written correctly, and a command line
  that cannot find `@mooncg/sdk` says so instead of `MODULE_NOT_FOUND`. The proxy answers 403
  to every client that is not on this machine (`local-only.js`, see Security). See
  `docs/development.md`.
- Self-linking: a signed-in user links and unlinks accounts of external providers for
  themselves on the new **Account** page (`/account`, also name, roles and password change).
  Linking starts with a `POST` (`/api/v1/me/identities/:provider/link`) that takes the
  current password, or for a user without one a sign-in of the last five minutes, and so does
  unlinking (`DELETE /api/v1/me/identities/:provider/:subject`); the flow is bound to the
  session that started it; an account linked to another user is never moved;
  realm bindings are kept; the user of dev mode cannot; a user cannot unlink their only way
  of signing in. An administrator switches it off globally or per provider on the Users page
  (`/api/v1/self-linking`); it is on by default, and off when its setting cannot be read. A
  `/account?linked=` in the address is reported only for a provider there is. See
  `docs/external-logins.md`.
- `auth-oidc`: up to three generic OpenID Connect providers, as the fixed sections `oidc`,
  `oidc2` and `oidc3` of its settings, each with its own write-only client secret and its own
  redirect address `/auth/<id>/callback`. `oidc` and its links work as before.
- An opt-in browser test (`MOONCG_VITE_E2E=1 pnpm test:e2e`) of the `vue` template with a real
  Vite development server and MoonCG in dev mode: the panel is sent on to Vite, connects,
  reads and writes a replicant, a graphic is listed as an instance, a saved component is
  applied by hot module replacement without a reload, and the built files work without
  `dev.url`.

- Opt-in tests with the network (`MOONCG_NETWORK_TESTS=1 pnpm test`): staging a public Git
  repository over https, and a real `npm ci` from the registry for a bundle with one small
  dependency. Skipped in the normal run, which needs no network.

### Changed

- A staged bundle that is still within its 30 minutes survives a restart of the server, with
  the trust it was fetched with. It is read and checked again from its files at the start, as
  when it was fetched, and its summary is made anew; only how it was fetched (source, who,
  when, trust, target) is kept in `staged.json` beside it, and of its source only the known
  fields within length limits are taken. One that no longer passes, whose note is missing or
  invalid, whose time is up (never later than 30 minutes after it was staged, whatever the
  note says), whose note says it was staged in the future, whose target is gone, or that is
  one more than may wait staged, is deleted with one line in the log that says why. The trust
  in the note is believed: whoever can write to the data folder can set it. See
  `docs/bundles.md`.
- `system:modules.manage` now lets its holder install modules, and so run code inside the
  server with full access, as the server process: **roles and API tokens that hold it already
  (also through `system:*`) can now do that.** Its description says so: "Install, enable and
  configure modules. Modules run inside the server with full access." Check who holds it.
  Only `*`, `system:*` and the permission itself cover it. In dev mode every process on the
  machine holds it, as it holds everything.
- Confirming one's own password (linking, unlinking): a request without a password is a `400`
  and does not count towards the throttle; only a wrong password does.
- Installing a module: when the server does not take the module, or where it came from cannot
  be written, after its folder was moved into `modules/`, the folder is moved back to staging
  (the module can be installed again) and the module is forgotten, so the folder and the list
  agree. An update that runs is kept when only its source cannot be written; the log says so.

### Security

- Dev mode no longer signs in what a page of another site makes the browser ask for without
  an `Origin`: the `GET` of an `<img>`, `<script>`, `<link>` or `<iframe>` tag and a link or
  redirect the browser follows. A request without `Origin` that says
  `Sec-Fetch-Site: cross-site` (or any value but `none`, `same-origin` and `same-site`) is
  answered like anyone who is not signed in. A link on another site to a page of the
  dashboard gets a short page with a link to the same address instead, which signs in on
  the visitor's click only. Requests without the header (`curl`, older browser sources)
  behave as before, and so do `GET`s a page of any server on this machine causes
  (`same-site`): their answers cannot be read, and what changes something is checked as
  before. See `docs/development.md`.
- The `vue` template's Vite proxy no longer makes dev mode reachable from the network: run
  with `--host`, Vite handed the requests and WebSocket connections of other computers on to
  MoonCG from this machine, which dev mode signed in as the administrator (MoonCG cannot see
  the address behind a proxy). Its `bypass` (`local-only.js`) now answers 403 to every client
  whose address is not loopback, and the docs say to keep Vite on loopback while
  `mooncg dev` runs.
- Self-linking fails closed: when its setting cannot be read at the start, it is off in
  memory, whether or not switching it off can be written.
- Unlinking one's own external account takes the password, or a sign-in of the last five
  minutes, as linking does.
- `bundle-sources.json` and `module-sources.json`, which may hold Git credentials, are written
  with mode 0600 (also the file beside them they are written to first) where the system has
  such modes; on Windows the access list of the data folder protects them.
- Development dependencies: `glob` is held at `^14.0.2` and `minimatch` at `^11.0.1`
  through pnpm overrides (GHSA-3g3m-2fjr-6pw4, GHSA-g3hv-75wg-m249). Both came in through
  `@vue/test-utils` → `js-beautify` and are not part of any published package.

## [0.9.0] - 2026-11-25

Wire protocol: 6 (unchanged). Database: version 8 (was 6), migrated at the first start.

### Added

- Modules: code that runs inside the server. A module is a folder with a `mooncg.json` of
  `"kind": "module"` and a main file whose default export is a setup function; it lives in
  the modules folder of an installation (`modules/`, or `--modules-dir`,
  `MOONCG_MODULES_DIR`, `"modulesDir"` of the configuration file). The folder is read when
  the server starts. A module does nothing until an administrator has enabled it, which is
  remembered in the database; enabling starts it at once, disabling stops it and takes away
  everything it registered. A module that cannot be loaded, whose stored configuration does
  not fit its schema, or whose setup throws, rejects or takes more than ten seconds, shows as
  `failed` with the reason, and the server and the other modules run on. Enabling a failed
  module again reads its manifest and main file anew. A folder whose name no module can
  have is listed as `failed` (_Invalid name_) and never read. See `docs/modules.md`.
- The public module API, `@mooncg/sdk/module`: `defineModule` and the types of the context.
  `ctx.auth.registerProvider` adds a way to sign in, `ctx.http.register` a route below
  `/m/<module>`, `ctx.permissions.define` a permission, `ctx.onDispose` what runs when the
  module stops; `ctx.config` is the module's configuration and `ctx.logger` writes to the
  server log. What a setup returns is run when the module stops as well.
- Module routes say who may call them: a `permission`, checked before the handler runs, or
  `public: true`. A route with neither is refused. They pass the same origin and forgery
  checks as every route of the server, get no cookie, `Authorization` or
  `Proxy-Authorization` header or `token` parameter of the caller, and answer 401 to an
  anonymous caller for everything that is not a public route, so that nothing tells which
  modules and routes exist. What a route answers goes out with the sandboxing
  Content-Security-Policy of uploaded files unless the handler sets its own.
- Permissions of modules, `system:module.<module>.<name>`: a namespace no built-in permission
  is in, so a module cannot redefine one. `GET /api/v1/permissions` lists the system
  permissions there are, built-in and of running modules, and the Roles page shows them.
- Module configuration: a JSON Schema named by the manifest, stored in
  `data/config/modules/<name>.json`, with `x-secret` properties that no answer, log line or
  error message contains, edited on the Settings page. Saving starts the module again and
  says so, or says why the module is not running with the new values.
- `system:modules.manage`, a permission of its own for enabling and disabling modules. Their
  configuration takes it together with `system:settings.manage`.
- `GET /api/v1/modules`, `POST /api/v1/modules/:name/enable` and `…/disable`,
  `GET` and `PUT /api/v1/modules/:name/config`.
- `mooncg module list`, `enable <name>` and `disable <name>`, through the API of a running
  server with a token that holds `system:modules.manage`. `enable` exits with 1 and the
  reason when the module then fails.
- Dashboard: a Modules page with state, error, **Enable**, **Disable** and **Try again**; the
  forms of module settings on the Settings page; the external accounts of each user on the
  Users page, with **Link account**, **Unlink** and the list of accounts that tried to sign
  in and belong to nobody; the system permissions on the Roles page.
- External logins. `auth-oidc`, a module shipped with the server as the package
  `@mooncg/module-auth-oidc` and disabled until enabled, signs people in with a generic OpenID
  Connect provider (authorization code flow with PKCE, found by discovery), with Twitch
  (OpenID Connect) or with Discord (OAuth 2.0: who signed in is asked at `/users/@me`, since
  Discord issues no ID token). Each is a section of the module's settings with a client ID, a
  client secret and a switch. See `docs/external-logins.md`.
- The login page shows a link per provider, `Sign in with <name>`, below the password form,
  with an icon the server serves itself. Its Content-Security-Policy is unchanged.
  `GET /api/v1/auth/providers` tells the ways to sign in.
- `GET /auth/<provider>/start` and `GET /auth/<provider>/callback`. The server creates
  `state`, the nonce and the PKCE verifier, keeps them for ten minutes under a ticket that
  only the browser gets (cookie `mooncg_oauth`: `HttpOnly`, `SameSite=Lax`, `Secure` and
  `__Host-` over HTTPS), accepts a `state` once and only with its ticket, and limits returns
  that open no session per address like wrong passwords. The session it opens is the one a
  password opens.
- Starting a sign-in is bounded per address: 30 starts a minute (then 429 with
  `Retry-After`, before the provider is asked) and ten started sign-ins at a time, of which
  an eleventh pushes out the address's own oldest. Of the 1000 kept for everyone, the address
  that holds the most gives one up when it is full, so nobody ends the sign-ins of others by
  starting many.
- The realm of a link. A provider reports with every account who vouches for it (`realm` of
  what `callback` answers; for OpenID Connect and Twitch the issuer, for Discord
  `https://discord.com`), and the link of a user to an account is bound to it
  (`identities.realm`, a new column). An account whose provider reports another realm than
  its link was made for, or none, is refused (`/login?error=realm`) with both in the log, and
  waits in the list of attempts to be linked again. Changing the issuer in the settings
  therefore breaks the links made for the old one instead of handing them to the new one.
  Links made by typing a subject, and links from a database of before, are bound by their
  first sign-in. The client ID is not part of the realm. `PUT
  /api/v1/users/:id/identities/:provider` takes an optional `realm`, and the Users page
  shows the realm of each link and of each attempt.
- Signing up creates at most 20 users an hour, for all providers together; beyond that an
  account is refused like one nobody linked.
- An `https://` public address means HTTPS: requests addressed to it get `Secure`,
  `__Host-` cookies and are checked against the `https://` origin, for HTTP and the WebSocket
  alike, also without `--trust-proxy` and `--secure-cookies`. A plain `http://` public
  address beyond this machine is allowed and warned about at the start.
- The log names every external sign-in (user, provider, subject, address) and every link and
  unlink (who did it, the account, the user, the realm).
- The list of accounts that tried to sign in and belong to nobody holds one entry per
  account and at most five of its twenty from one address; names in it are shown without
  format characters (zero-width, bidirectional overrides) and after the provider and the id.
- `--public-url` (`MOONCG_PUBLIC_URL`, `"publicUrl"`): the origin people reach the server at.
  The address a provider sends the browser back to is built from it and from nothing a
  request says. Without it, external logins work on this machine only, by a loopback name
  and the port the server listens on.
- For OpenID Connect the module verifies the signature of the ID token with the provider's
  published keys and an asymmetric algorithm, `iss`, `aud` (and `azp`), `exp` and the nonce;
  takes an issuer and endpoints over `https://` only, or plain `http://` to this machine;
  checks that the discovery document names the configured issuer; and follows no redirect of
  a provider's endpoint. No token of a provider is stored, logged or sent to a browser.
- Linking: an external account belongs to a user only through a link by its id at the
  provider, never by a name or an e-mail address. An account nobody linked is refused, or,
  with _Create a user for an account nobody has linked_ turned on for its provider (off by
  default), gets a new user without any role. `GET /api/v1/identities`,
  `PUT /api/v1/users/:id/identities/:provider` and
  `DELETE /api/v1/users/:id/identities/:provider/:subject`, for holders of
  `system:users.manage` and only for users who hold nothing the caller does not. An account
  that another user has is not moved (409). Unlinking ends the user's sessions.
- External logins are no way around the rest: nothing signs in or up while the installation
  has no user, a disabled user is refused, and the user of dev mode cannot be linked.
- `returnTo` on `/auth/<provider>/start` names where to go after signing in: a path of this
  server, or it is ignored.

### Changed

- The local login is registered like every other way to sign in: the server's own module
  `auth-local` puts a provider `local` into the registry the providers of modules are in, and
  `POST /api/v1/auth/login` asks that registry. `auth-local` always runs and cannot be
  disabled. Nothing changes for whoever signs in with a password.
- `mooncg.json`: `main` names the main file of a module and is refused in a bundle; what
  only a bundle has (`extension`, `permissions`, `panels`, and the rest) is refused in a
  module.
- The configuration file takes `modulesDir` and `publicUrl`. The line the server prints when
  it listens names the modules folder.
- Bundle routes no longer get the `Proxy-Authorization` header of the caller, like
  `Authorization` and `Cookie`.

### Dependencies

- `jose` 6, in `@mooncg/module-auth-oidc`: verifying the signature and the claims of ID
  tokens and fetching a provider's keys. The flow itself (discovery, the authorization
  request, redeeming the code) is written with `fetch`.

### Not in this release

- `storage.registerAdapter`, `registry.registerSource` and `dashboard.registerPage` of the
  plan are not part of the module API: none of them would do anything yet.
- Modules are not installed through the API or the command line: a module is a folder copied
  into `modules/`, found at the next start. They are not watched for changes.
- A signed-in user cannot link an external account themselves; an administrator does.
- One generic OpenID Connect provider per installation.
- The Twitch and Discord presets follow the providers' documentation and are tested against
  an identity provider that runs in the tests. They were not run against Twitch or Discord.

## [0.8.0] - 2026-11-25

Wire protocol: 6 (was 5).

### Added

- Live reload: with `--watch` (`MOONCG_WATCH`, or `"watch": true` in the configuration file)
  the server watches the folder of every enabled bundle and applies what changes, 150 ms
  after the last change. A changed `mooncg.json` or schema reloads the bundle, a change in
  `extension/` or `shared/` restarts its extension, one in `dashboard/` reloads its open
  panel and dialog pages. `node_modules`, `.git` and dot folders are ignored. The watcher is
  off unless turned on; `--no-watch` and `MOONCG_WATCH=0` turn it off again, the flag winning
  over the variable and the variable over the file. See `docs/development.md`.
- An invalid manifest, an unusable schema or a default that no longer fits its schema is not
  applied when the files change: the version that ran before keeps running, and the bundle
  says why in `reloadErrors` (API, `system:bundles`, a `not reloaded` badge on the Bundles
  page) until a valid change arrives. The files are read once: the manifest and schemas that
  were checked are the ones the bundle is started with, so a file that is cut short again a
  moment later cannot leave the bundle failed.
- Graphics are not reloaded by a file change outside dev mode. The connected pages are marked
  `outOfDate` in `<bundle>:$instances.<graphic>`, the Graphics page shows `Out of date` beside
  them, and the existing `Reload` of one instance brings them up to date.
- Dev mode, `mooncg dev` or `--dev`: the watcher is on, graphics reload with their files, the
  `dev.url` of a manifest is honoured, and every request from this machine without
  credentials acts as an administrator. It exists as a flag only and refuses to start with a
  host that is not loopback, with `--trust-proxy`, and with an allowed origin that is not on
  this machine (`--allowed-origin`, `MOONCG_ALLOWED_ORIGINS`, `allowedOrigins` of the
  configuration file). It signs a request in only if its socket address is loopback, it
  carries no proxy header, its `Host` header names this machine, its `Origin` is absent or on
  this machine, and it brings no credentials at all: a session that ended or a token that was
  revoked gets `401`, not an administrator. It warns in the log at every start. Behind a
  reverse proxy or a tunnel on the same machine everyone who reaches it is an administrator,
  which MoonCG cannot detect; `docs/development.md` says so prominently.
- Dev mode acts as a user of its own, `dev` (role `admin`, no password, marked as created by
  dev mode), never as a real person. Outside dev mode that user is inert: it cannot sign in,
  its sessions and API tokens are deleted at the next start without `--dev` and not accepted,
  and it does not count as a user or an administrator, so an installation that was only ever
  used in dev mode still offers the first-run setup. Such a start logs one warning. The user
  cannot be renamed, disabled, given a password or given other roles, only deleted, and is
  shown as `dev mode only` by `mooncg user list` and on the Users page (`"devMode": true` in
  `GET /api/v1/users`).
- `"dev": { "url": "http://localhost:5173" }` in a manifest, in dev mode only: requests for the
  bundle's panel and graphic files are redirected to that development server after the usual
  permission checks, MoonCG leaves reloading its pages to it, and its origin may open the
  WebSocket, send requests and be framed by the dashboard (`frame-src`). The address must be
  `http` or `https` on this machine, without credentials, query or fragment.
- The On Air lock: one switch for the installation, kept across restarts, published as the
  replicant `system:onAir`. While it is on, update, remove, disable, reload and restore of a
  bundle and the restart of an extension are refused with `409` unless the request says
  `"forceOnAir": true`, which takes the same permission as the change
  (`system:bundles.manage`); the watcher records what changed as `pendingChanges` instead of
  acting, and applies it when the switch goes off. An update can still be fetched while on
  air (staging and uploading interrupt nothing); putting it in place is what is refused, and
  the refusal says that the new version stays staged. The lock fails closed: a stored state
  that cannot be read or understood counts as on air, with an error in the log that says how
  to switch it off. `GET` and `PUT /api/v1/on-air`.
- Dashboard: the On Air switch and indicator in the sidebar, `changes pending` and
  `not reloaded` badges on the Bundles page, and a question before a button makes a change
  while on air. The question is about the lock alone and sends `"forceOnAir": true` and
  nothing else. An update is fetched without a question; its card says that putting it in
  place is blocked, and **Update** asks.
- `mooncg start` and `mooncg dev` start the server from the command line tool; `mooncg init`
  creates an installation folder (`bundles/`, `data/`, `mooncg.config.json`, a `.gitignore`
  for `data/`); `mooncg bundle create <name>` creates a bundle from the `html` template, in
  the bundles folder of `--dir` or of the configuration file (`--config`, `MOONCG_CONFIG`), and
  removes its folder again if a file cannot be written.
- `--on-air` on `mooncg bundle update|remove|disable|reload|restore`, for a change while on
  air. Without it, `update` stops before anything is fetched and names the flag.
- The configuration file `mooncg.config.json` (`port`, `host`, `bundlesDir`, `dataDir`,
  `allowedOrigins`, `watch`), read from the working directory or named with `--config` or
  `MOONCG_CONFIG`. Flags win over environment variables, which win over the file. An unknown
  or mistyped setting keeps the server from starting.
- `createClient({ waitForBundle })`: by default a page whose bundle is not running keeps
  asking, with growing pauses up to 15 seconds, instead of giving up.
- `pnpm dev` builds and starts dev mode with the bundles in `examples/`.

### Changed

- Wire protocol 6: the server messages `rep.back` and `msg.back` announce a replicant or a
  message topic that is declared again; `reload` is now sent to any page of a bundle, not
  only to a graphic. Pages that load `/sdk/mooncg.js` get the matching client by themselves;
  a bundle that ships its own copy of `@mooncg/sdk` must rebuild.
- A page that connects while its bundle is not running no longer ends with `ready` rejected
  as `not_found`: it waits for the bundle (see `waitForBundle` above).
- A message topic the server removed is asked for again at the next reconnect, and when the
  server says it is back, instead of being forgotten.
- The Graphics page marks a graphic that is open somewhere as "Open", no longer "On air":
  that name now belongs to the lock.
- `mooncg bundle remove --force` and `"force": true` on `remove` mean what they meant in
  0.7.0, removing a bundle that enabled bundles still need, and nothing more: they do not
  override the On Air lock, which has its own word (`--on-air`, `"forceOnAir": true`). A
  removal that both stand in the way of takes both.
- `dev.url` in a manifest, which 0.7.0 accepted as any URL and did not use, must now be an
  `http://` or `https://` address on this machine (`localhost`, `127.x.x.x` or `[::1]`),
  without user name, password, query or fragment. A manifest with any other value is invalid:
  its bundle does not start and cannot be installed until the value is corrected or removed.
- The database gains the table `settings` (migration 5), which holds the On Air state, and the
  column `users.dev_mode` (migration 6), which marks the user dev mode created.
- Node.js 22.22 or newer is required (was 22): chokidar 6, which watches the bundle folders,
  needs it, and `engines` of the repository, `@mooncg/server` and `@mooncg/cli` say so. It is
  loaded only when watching is on.
- Every switch of the server can be turned off on the command line with `--no-` in front,
  such as `--no-watch`.

### Fixed

- Pages that stayed open while their bundle was reloaded, disabled and enabled, updated or
  restarted after a crash went stale: their replicants stayed in the error state and their
  message listeners were silent until the page was reloaded. The server now tells a page when
  what it lost is back, and the SDK subscribes again by itself.
- `ready` of a replicant that was refused once (asked for before it was declared) never
  resolved, even after a later subscription succeeded.
- A message listener was dropped for good when the connection was lost while the page was
  subscribing again after a reconnect.

## [0.7.0] - 2026-11-25

### Added

- Bundles can be installed, updated and removed while the server runs, for holders of
  `system:bundles.manage`. A bundle is fetched into `<data-dir>/staging/` and checked there;
  the server tells what it declares (whether it brings an extension, its permissions,
  capabilities, dependencies, npm packages) before anything is installed, and it is then
  committed or discarded. See `docs/bundles.md`.
- Sources: a Git repository (`https://`, `ssh://` or `user@host:path`, with an optional
  branch, tag or commit; the commit is recorded), a ZIP archive (uploaded, or by a path on
  the server) and a folder on the server. Archives are refused for entries that leave their
  folder, links, reserved Windows names, too many entries, too many bytes or a compression
  ratio no bundle has.
- npm dependencies of a bundle are installed in staging with `npm ci --omit=dev
  --ignore-scripts` (`npm install` without a lockfile), with no npm configuration but the
  server's own. A bundle that would run code while it is installed (install scripts, an
  `.npmrc` or `.yarnrc` of its own, dependencies or lockfile entries from elsewhere than the
  registry) is refused unless it is fetched as trusted, per bundle; the summary says which
  applies. `--bundle-npm-registry` names another registry.
- Git runs with the machine's configuration switched off where it could run a program (hooks,
  file system monitor, filters, Git LFS); files are checked out as committed. Git and npm are
  ended with everything they started when their time is up.
- The summary of a fetched bundle names the role grants it proposes and whether they will be
  made. Removing a bundle with its data also takes its role grants away.
- At most two bundles are fetched at a time and five wait for a decision.
- A manifest's texts are bounded and may hold no control characters; a bundle cannot be named
  like a Windows device (`con`, `nul`, `com1`, …).
- Updates keep the replaced version in `<data-dir>/backups/<bundle>/` and restore it when the
  new version cannot be put in place or does not start. The newest three backups are kept;
  a backup can be restored. Settings, assets and persistent replicants stay through an update.
- Removing a bundle moves it to the backups and keeps what it stored, unless told to delete
  the files and to purge the data. A bundle that enabled bundles need is not removed unless
  forced.
- API under `/api/v1/bundles/-/` (`stage`, `staged`, `staged/<id>/commit`, `jobs`) and
  `/api/v1/bundles/<name>/` (`update`, `remove`, `backups`, `backups/<id>/restore`). What takes
  time answers 202 with a job; the read-only replicant `system:installs` publishes jobs and
  staged bundles.
- `mooncg bundle list|install|update|remove|enable|disable|reload|backups|restore`, which
  talks to a running server with an API token (`--token` or `MOONCG_TOKEN`, `--url` or
  `MOONCG_URL`), shows the summary and asks before it installs (`--yes` to skip).
- Dashboard: an install form on the bundle page (Git address or ZIP upload), the summary of
  each fetched bundle with Install and Discard, Update and Remove on each row, progress and
  errors, and the source of each bundle in its row.
- The manifest's `engine.mooncg` is checked: a bundle that asks for another MoonCG is refused
  when it is installed.
- Server flags `--bundle-max-archive-bytes`, `--bundle-max-unpacked-bytes`,
  `--bundle-max-files`, `--bundle-backups-kept` and `--bundle-install-timeout-ms`.
- Bundle states `installing`, `updating` and `removing`, shown while the files of a bundle
  change.

### Changed

- `GET /api/v1/bundles` is also answered to holders of `system:bundles.manage` who do not hold
  `system:dashboard.view`, and names the `source` of each bundle to those who manage bundles.
- `ReplicantStore` has a new method, `removeBundle(bundle)`, which deletes every record of a
  bundle. A storage backend of your own needs it.
- `AuthStore.bundleDefaults` has a new method, `forget(bundle)`, for the same reason.
- `mooncg bundle` does not send the API token over plain `http://` to another machine unless
  `--insecure` is given, and prints what the server answers without control characters.
- The browser tests run against a temporary copy of `examples/`.

## [0.6.0] - 2026-11-24

### Added

- `status` and `onStatusChange(listener)` on the client of `@mooncg/sdk/client` (and so on a
  `Connection`): where the connection stands, as `live`, `reconnecting` or `offline`.
- `GET /api/v1/bundles` names the bundles each bundle needs (`dependencies`, the names from
  its manifest). A bundle the caller is not listed is not named there either, and one that
  is not installed only to holders of `system:bundles.manage`.
- Dashboard: counts in the navigation (panels of a workspace, failed bundles, graphics that
  are open, warnings and errors logged since the last visit of the log page, the last only
  for holders of `system:logs.view`), the state of the connection, a filter by state and key
  figures on the bundle page, "On air" on a graphic that is open, "Copied" after copying a
  URL, thumbnails of uploaded pictures, and a line for each panel that is hidden because its
  bundle does not run.
- `pnpm screenshots` takes a picture of every dashboard page.

### Changed

- Dashboard layout: a sidebar with the navigation in the groups Workspaces, Show, Admin and
  System replaces the top bar; every page starts with a heading and what it is for; lists are
  cards. The styles are built on design tokens (`tokens.css`) with filled buttons. Every
  page, permission and workflow is as before.
- The sign-in and setup pages are drawn in the same design: a centred card with the mark.
  Their styles are files now (`/tokens.css`, `/auth.css`) instead of a `<style>` in each
  page, and with `/logo-mark.svg` these are served to anyone, as `/auth.js` already was.
  Texts, fields and behaviour are unchanged.
- The Content-Security-Policy of the server's own pages (`/`, `/login`, `/setup`) allows
  styles from files of this server only: `style-src 'self'`, no longer `'unsafe-inline'`.
- Bundles on their way between states (`enabling`, `disabling`, `installed`) are drawn amber,
  not green.
- The level filter of the log page is a group of radio buttons, each with the number of
  lines it shows, instead of a select.
- The graphics page shows no preview of a graphic by design: a page that loads one would
  count as an instance of it.

### Fixed

- Escape closes a dialog also while the dialog page has the focus, which is where the
  dashboard puts it when a dialog opens. Before, Escape only worked from the dashboard's own
  page, such as from the × of the dialog.

## [0.5.0] - 2026-11-24

The dashboard, with dialogs, bundle settings and assets. Wire protocol version 5.

### Added

- New package `@mooncg/dashboard`: a Vue 3 application built with Vite and served at `/`, with
  the routes `/w/<workspace>`, `/bundles`, `/graphics`, `/assets`, `/admin/users`,
  `/admin/roles`, `/admin/tokens`, `/settings` and `/logs`. The navigation shows only what the
  signed-in user may use.
- Workspaces: panels are grouped by the manifest's `workspace` (default `Main`) and shown as
  iframes in a 12-column grid that each user can rearrange and resize with buttons.
- Layouts are stored on the server per user: `GET` and `PUT /api/v1/me/prefs/<key>` keep small
  JSON values (16 KiB per request, 50 keys per user) in the new table `user_prefs`.
- Bundle page with state, errors and enable, disable and reload for whoever may manage
  bundles; it follows `system:revision`.
- Graphics page with the URL of every graphic and a copy button.
- Pages for users, roles with their grants, and API tokens, on the existing API.
- Log page at `/logs`: the server keeps its latest 1000 log lines in memory and serves them at
  `GET /api/v1/logs` (`?after=<id>` for what is new) under `system:logs.view`. API tokens and
  the setup code are never in what it serves.
- The dashboard asks before deleting a user, a role or a token, and says so when a layout
  could not be saved.
- `grantsCover` in `@mooncg/core` and `@mooncg/sdk/client`: the rule the server matches grants
  by, which the dashboard now uses instead of a copy.
- Connected graphics: a graphic page says in `hello` which graphic it is, and the server
  lists the connected pages of each graphic in the read-only replicant
  `<bundle>:$instances.<graphic>`, readable with the graphic's own permission. The graphics
  page shows them.
- `"singleInstance": true` on a graphic is enforced by the server: a second page of another
  user or token is refused with `conflict`, shows a notice instead of the graphic and takes
  over when the first is gone. The same user or token opening it again replaces its own
  page, which is told so (`graphic.end`) and does not ask again. `createClient` takes
  `graphic`, `onDuplicate`, `onEnded`, `duplicateRetryMs` and `reloadPage`.
- `POST /api/v1/bundles/<bundle>/instances/<id>/reload` and `…/disconnect` tell one connected
  graphic page to load itself again or take it off its graphic, and
  `GET /api/v1/bundles/<bundle>/instances` lists the connected pages with who each acts as.
  All three are for holders of `system:bundles.manage`. The replicant `$instances` itself
  names no principal.
- Every WebSocket is pinged every 15 seconds and dropped after two unanswered pings, so a
  machine that vanished holds nothing, such as the place of a single-instance graphic.
- Dialogs: `dialogs` in the manifest, `mc.dialogs.open(id, data)` in a panel, which resolves
  with the dialog's result, and `mc.dialogs.current()` in the dialog page. They travel as
  typed `postMessage` between panel, dashboard and dialog page; the dashboard checks origin,
  source window and that the dialog belongs to the calling panel's bundle, and closes a
  dialog whose panel is reloaded or goes away.
- Bundle configuration: `"config": { "schema": … }` in the manifest names a JSON Schema. The
  values are kept in `<data-dir>/config/<bundle>.json`, checked with Ajv on load and before
  every write, written atomically, and handed to the extension as `ctx.config` with the
  schema's defaults. `GET /api/v1/config`, `GET` and `PUT /api/v1/bundles/<bundle>/config`
  under `system:settings.manage`. Saving restarts the bundle's extension and nothing else, so
  pages keep the replicants they follow.
- Secrets: a config property with `"x-secret": true` is never sent back, is kept when a write
  leaves it out and removed by `null`, and is replaced by `***` in every log line and error,
  also in those the extension produces. A `$ref` into the same schema is followed wherever it
  stands; a schema with a reference that cannot be followed is refused. A secret shorter than
  8 characters is not masked, and the log says so once.
- The answer to `PUT …/config` says with `restarted` and `restartNote` whether the extension
  runs with the stored values; it is 200 once the values are stored.
- A stored configuration that does not fit its schema fails that bundle with a readable error;
  the server keeps running, and saving values that fit starts the bundle.
- The settings page: a form drawn from each bundle's schema (text, numbers, switches, choices,
  nested objects, lists of text or numbers, JSON for the rest, password fields for secrets).
- Assets: `assets` categories in the manifest with `accept` and optional `read` and `write`
  permissions. Upload with `PUT /api/v1/bundles/<bundle>/assets/<category>/<name>` (the file
  as the request body), list with `GET …/assets/<category>`, delete with `DELETE`. Files are
  kept in `<data-dir>/assets/<bundle>/<category>/`, served at
  `/b/<bundle>/assets/<category>/<name>`, and listed in the read-only replicant
  `<bundle>:$assets.<category>`. The assets page uploads, lists and deletes.
- Limits for assets: `--asset-max-file-bytes` (50 MiB), `--asset-quota-bytes` (500 MiB per
  category) and `--asset-max-files` (1000 per category). An upload that sends nothing for 30
  seconds is given up, and a slow upload holds up no other. File names are cleaned (Windows
  device names, forbidden characters, dots and spaces at the ends); names that are paths or
  short names of Windows (`~1`) are refused.
- A category without `write` takes `system:bundles.manage` to upload and delete. `accept`
  takes `*/*` for any file; an empty `accept` is a manifest error.
- Assets are served with `Accept-Ranges: bytes` and answer `Range` requests (206, 416).
- What interrupted uploads left behind is removed when the server starts.
- The example bundle has a dialog that confirms a reset, an asset category for team logos
  that the overlay shows, and a config schema with a title, a highest score and a secret.
- `pnpm test:e2e`: a Playwright smoke test that runs the built server, the dashboard and the
  example bundle in Chromium.
- `docs/dashboard.md`.

### Changed

- **Breaking:** the minimal shell page (`index.html`, `/shell.js`) is gone. `/` serves the
  built dashboard and answers 404 with a hint until `pnpm build` has been run.
- **Breaking:** wire protocol version 5. `hello` may carry `graphic`, and the server may send
  `reload` and `graphic.end`. Clients built against version 4 are refused; pages that load `/sdk/mooncg.js`
  from the server get the new client by themselves.
- **Breaking:** a graphic with `singleInstance` is now really limited to one page. A setup
  that had the same graphic open twice shows the notice in the second one.
- `system:settings.manage` is no longer only reserved: it gives access to the configuration
  of every bundle.
- `ctx.config` is frozen and holds the stored configuration; it was always empty before.
- Uploaded assets are served with `Content-Security-Policy: sandbox; …` and, unless they are
  an image, a font, sound, video, JSON or text, as a download. No other header changed.
- The database is migrated to schema version 4 (`user_prefs`).
- `pnpm build` also builds the dashboard; `pnpm typecheck` also checks it.

- **Breaking:** layouts are stored under a new preference key that is different for every
  workspace name (`A b` and `a-b` used to share one). Layouts saved before are not found
  again and start from the default.
- `GET /api/v1/logs` answers `last` as the id of the newest line the server has, also when
  `after` is beyond it, so the log page starts over after a server restart.

### Known limits

- One dialog is open at a time, and a dialog cannot open another.
- A graphic page that does not use the SDK is neither listed as an instance nor held to
  `singleInstance`.
- A page that was replaced or disconnected stays away until it is reloaded.
- The settings form does not follow `$ref`, `oneOf` and the like: such a property is one field
  that takes JSON.

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
