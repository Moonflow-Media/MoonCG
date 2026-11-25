# MoonCG

MoonCG is a broadcast graphics framework in the spirit of NodeCG, built to be simpler and modular.
A **bundle** brings dashboard panels, graphics for OBS or vMix, and an optional server-side
extension. Bundles share state through **replicants**: values the server owns and syncs to every
panel and graphic over a WebSocket.

This repository has finished milestones 1 to 7 of its plan. It loads bundles from a folder, serves their
panels and graphics, syncs replicants and messages, runs each bundle's extension in its own
worker thread, can enable, disable and reload bundles while it runs, and has users, roles,
permissions and API tokens. Its dashboard has workspaces, pages for bundles, graphics, users,
roles, tokens and logs, dialogs that panels open, a settings form for each bundle's
configuration, and uploaded assets. Bundles are installed, updated and removed while the server
runs, from a Git repository, a ZIP archive or a folder, with a rollback when a new version does
not start: see [docs/bundles.md](docs/bundles.md). For writing bundles there is `mooncg dev`,
which watches the bundle folders and reloads what changes, templates for a new installation
and a new bundle, and an **On Air** lock that keeps all of that away from a running show: see
[docs/development.md](docs/development.md).

## Run the example

Requires Node.js 22.22 or newer and pnpm. (The file watcher behind `--watch` and `mooncg dev`,
chokidar 6, needs that version, so the server and the command line ask for it.)

```sh
pnpm install
pnpm start
```

`pnpm start` builds the packages and starts the server with the bundles in `examples/`. Then:

1. On the first start the server prints a setup URL. Open it and create the first
   administrator, then sign in at <http://127.0.0.1:9090/>.
2. The dashboard shows the workspace `Show` with the panel of the `scoreboard` bundle; the
   page `Bundles` lists the bundle with its state and offers buttons
   to reload or disable it.
3. Open <http://127.0.0.1:9090/b/scoreboard/graphics/overlay.html> in a second tab.
4. Click the buttons in the panel. The graphic follows. `Reset` asks first, in a dialog.
5. Open <http://127.0.0.1:9090/b/scoreboard/api/score> for the score as JSON, served by the
   bundle's extension.
6. On the page `Settings`, change the title and save: the extension restarts with it and the
   graphic shows it. The results service key is a secret: stored, never shown again.
7. On the page `Assets`, upload an image called `home.png` or `away.png`. The graphic shows it
   next to the score without a reload.
8. Open the graphic in a third tab. It takes one instance, and you are the same account, so
   the new tab takes the place and the old one says so. Someone else who opens it is told
   that it is open elsewhere, and takes over when you close yours. The page `Graphics` lists
   which pages are connected and can reload or disconnect each.

Nothing is served without signing in. For OBS, create an API token and put it into the URL of
the browser source:

```sh
node packages/cli/dist/main.js token create OBS --user <you> --grant bundle:scoreboard:view
# http://127.0.0.1:9090/b/scoreboard/graphics/overlay.html?token=mcg_…
```

[docs/permissions.md](docs/permissions.md) describes users, roles, permissions, tokens and the
setup. The server listens on loopback unless started with `--host`.

### Working on a bundle

```sh
pnpm dev
```

`pnpm dev` builds and starts the server in **dev mode** with the bundles in `examples/`: it
watches the bundle folders, and it signs in every request from this machine that brings no
credentials as the administrator `dev`, so <http://127.0.0.1:9090/> opens without a password. Save
`examples/scoreboard/dashboard/control.html` and the panel reloads; save
`extension/index.js` and the extension restarts; break `mooncg.json` and the bundle keeps
running while the Bundles page says what is wrong. Dev mode listens on loopback only, must
never sit behind a proxy or a tunnel, and is never for a show. [docs/development.md](docs/development.md) has all of it, with
`mooncg init` and `mooncg bundle create` for a folder and a bundle of your own.

## Configuration

| Flag                               | Environment variable                    | Default     | Meaning                                            |
| ---------------------------------- | --------------------------------------- | ----------- | -------------------------------------------------- |
| `--port`                           | `MOONCG_PORT`                           | `9090`      | HTTP and WebSocket port                            |
| `--host`                           | `MOONCG_HOST`                           | `127.0.0.1` | Address to listen on                               |
| `--bundles-dir`                    | `MOONCG_BUNDLES_DIR`                    | `bundles`   | Folder with one subfolder per bundle               |
| `--data-dir`                       | `MOONCG_DATA_DIR`                       | `data`      | Folder for what the server stores                  |
| `--allowed-origin`                 | `MOONCG_ALLOWED_ORIGINS`                | none        | Extra origin whose pages may open the WebSocket    |
| `--extension-memory-mb`            | `MOONCG_EXTENSION_MEMORY_MB`            | `256`       | Heap each bundle extension may use, in MiB         |
| `--max-body-bytes`                 | `MOONCG_MAX_BODY_BYTES`                 | `1048576`   | Largest request body a bundle HTTP route accepts   |
| `--asset-max-file-bytes`           | `MOONCG_ASSET_MAX_FILE_BYTES`           | `52428800`  | Largest file that can be uploaded as an asset      |
| `--asset-quota-bytes`              | `MOONCG_ASSET_QUOTA_BYTES`              | `524288000` | What one asset category of a bundle may hold       |
| `--asset-max-files`                | `MOONCG_ASSET_MAX_FILES`                | `1000`      | How many files one asset category may hold         |
| `--bundle-max-archive-bytes`       | `MOONCG_BUNDLE_MAX_ARCHIVE_BYTES`       | `104857600` | Largest ZIP archive a bundle is installed from     |
| `--bundle-max-unpacked-bytes`      | `MOONCG_BUNDLE_MAX_UNPACKED_BYTES`      | `524288000` | Largest bundle that is installed, unpacked         |
| `--bundle-max-files`               | `MOONCG_BUNDLE_MAX_FILES`               | `50000`     | Most files and folders a bundle may consist of     |
| `--bundle-backups-kept`            | `MOONCG_BUNDLE_BACKUPS_KEPT`            | `3`         | Earlier versions kept of each bundle               |
| `--bundle-install-timeout-ms`      | `MOONCG_BUNDLE_INSTALL_TIMEOUT_MS`      | `300000`    | How long Git, and npm, may each take               |
| `--bundle-npm-registry`            | `MOONCG_BUNDLE_NPM_REGISTRY`            | npm's own   | Registry for the npm packages of bundles (https)   |
| `--extension-start-timeout-ms`     | `MOONCG_EXTENSION_START_TIMEOUT_MS`     | `10000`     | How long an extension may take to start            |
| `--extension-heartbeat-timeout-ms` | `MOONCG_EXTENSION_HEARTBEAT_TIMEOUT_MS` | `10000`     | How long a running extension may stay unresponsive |
| `--secure-cookies`                 | `MOONCG_SECURE_COOKIES`                 | off         | Marks session cookies `Secure` (HTTPS only)        |
| `--trust-proxy`                    | `MOONCG_TRUST_PROXY`                    | off         | Believes `X-Forwarded-Proto` and `X-Forwarded-For` |
| `--watch`, `--no-watch`            | `MOONCG_WATCH`                          | off         | Watches the bundle folders and applies changes     |
| `--dev`                            | none, on purpose                        | off         | Dev mode: watcher, `dev.url`, sign-in on loopback  |
| `--config`                         | `MOONCG_CONFIG`                         | see below   | The configuration file to read                     |

Flags win over environment variables. Relative paths resolve against the working directory.
`--allowed-origin` can be repeated; the environment variable takes a comma-separated list.
The switches are on in the environment as `1` or `true`, and each can be turned off on the
command line with `--no-` in front, such as `--no-watch`. For `watch`, the flag wins over
`MOONCG_WATCH` (where `0` turns it off), which wins over the file.

`port`, `host`, `bundlesDir`, `dataDir`, `allowedOrigins` and `watch` can also be set in
`mooncg.config.json` in the directory the server is started in; `mooncg init` writes one.
Flags and environment variables win over the file, and relative paths in it start at the
file's own folder. See [docs/development.md](docs/development.md#the-configuration-file).

`--host 0.0.0.0` opens the server to the network. It speaks plain HTTP, so on a network you do
not fully trust put an HTTPS reverse proxy in front and start with `--secure-cookies
--trust-proxy`; the server warns when it listens beyond loopback without secure cookies. See
[docs/permissions.md](docs/permissions.md#listening-beyond-this-machine).

A browser page may open the WebSocket, or send a request that changes something (anything but
`GET` and `HEAD`), only if it was loaded from the server itself (its `Origin` matches the `Host`
it connects to) or from an allowed origin. Clients that send no `Origin`, such as Node scripts,
curl and OBS, pass this check; they still need a session or a token. A request that changes
something and is authenticated by a cookie must also carry JSON or the header `X-MoonCG-CSRF`.
A WebSocket frame may be at most 1 MiB. Dev mode does not start with an allowed origin that is
not on this machine.

The server listens as soon as it knows its bundles; their extensions start in the background,
and a bundle shows as `enabling` until its extension has started.

The data directory is created on first start. It holds `mooncg.db`, a SQLite database with the
persistent replicants, the list of disabled bundles, and the users, roles, tokens and sessions.
Deleting it resets all of that, and the next start offers the setup again. Beside the
database it holds `config/` and `assets/` of the bundles, `staging/` for bundles that are being
installed, `backups/` with the earlier versions of updated and removed bundles, and
`bundle-sources.json`, which remembers where each bundle was installed from. `data/` is
git-ignored.

To run the built server yourself:

```sh
pnpm build
node packages/server/dist/main.js --bundles-dir examples --port 9090
# or, the same through the command line tool:
node packages/cli/dist/main.js start --bundles-dir examples --port 9090
```

## Development

| Command          | What it does                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `pnpm test`      | Runs all tests with Vitest, straight from the TypeScript sources                              |
| `pnpm typecheck` | Type-checks the packages (`tsc -b`), the tests and a typed fixture                            |
| `pnpm lint`      | Checks formatting and lint rules with Biome (`pnpm format` to fix)                            |
| `pnpm build`     | Compiles every package, bundles the browser SDK, builds the dashboard                         |
| `pnpm test:e2e`  | Builds, then runs the browser smoke test (needs `pnpm exec playwright install chromium` once) |
| `pnpm dev`       | Builds, then starts the server in dev mode with the bundles in `examples/`                    |

TypeScript is compiled with `tsc -b` and the server runs the JavaScript in `dist/`. Nothing runs
TypeScript directly, so rebuild after changing sources. Tests need no build.

## Repository layout

| Path                  | Content                                                                                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`       | Pure logic without IO: manifest parser, replicant engine, message bus, route table, bundle state machine, wire protocol, permissions, session handler                                                         |
| `packages/server`     | Config, logger and lifecycle, bundle manager and installer, schema validation, storage, accounts, worker-thread extension host, HTTP and WebSocket transport                                                  |
| `packages/sdk`        | What bundle authors use: `@mooncg/sdk/client` (browser and Node client), `/extension` (extension context), `/vue` and `/react` adapters                                                                       |
| `docs/`               | `permissions.md` (accounts, roles, tokens, setup), `bundles.md` (installing, updating, removing), `development.md` (live reload, dev mode, On Air), `extensions.md`, `dashboard.md` and `folder-structure.md` |
| `packages/cli`        | The `mooncg` command line: `mooncg init`, `start`, `dev`, `types`, `user`, `token` and `bundle`, with the bundle templates                                                                                    |
| `packages/dashboard`  | The dashboard: a Vue application the server serves at `/`; see [docs/dashboard.md](docs/dashboard.md)                                                                                                         |
| `examples/scoreboard` | A reference bundle with a panel, a dialog, a graphic, an extension, an asset category and a config schema with a secret                                                                                       |

## Writing a bundle

A bundle is a folder named like the bundle, with a `mooncg.json` manifest:

```json
{
  "manifest": 1,
  "kind": "bundle",
  "name": "scoreboard",
  "version": "0.1.0",
  "extension": "extension/index.js",
  "permissions": { "view": "See the scoreboard", "operate": "Change the score" },
  "panels": [
    { "id": "control", "title": "Score", "file": "dashboard/control.html", "requires": "operate" }
  ],
  "graphics": [{ "id": "overlay", "file": "graphics/overlay.html", "width": 1920, "height": 1080 }],
  "replicants": {
    "score": {
      "schema": "schemas/score.json",
      "default": { "home": 0, "away": 0 },
      "persistent": true,
      "read": "view",
      "write": "operate"
    }
  }
}
```

Panel files live under `dashboard/`, graphic files under `graphics/`. They are served at
`/b/<bundle>/dashboard/...` and `/b/<bundle>/graphics/...`. Only real files with exactly the
requested name are served: a name that differs in case, or a path that goes through a symlink or
junction, gets a 404. The extension must live outside those two folders.

A manifest can declare more, each described in [docs/dashboard.md](docs/dashboard.md):

| Manifest                                        | Gives the bundle                                                                             |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `dialogs`                                       | Pages a panel opens over the dashboard with `mc.dialogs.open(id, data)` and gets a result of |
| `"singleInstance": true` on a graphic           | A graphic that one page shows at a time; a second page is told so                            |
| `"config": { "schema": "schemas/config.json" }` | A settings form in the dashboard and `ctx.config` in the extension, with write-only secrets  |
| `assets`                                        | Categories of uploaded files, served under `/b/<bundle>/assets/` and listed in a replicant   |
| `"dev": { "url": "http://localhost:5173" }`     | In dev mode only: the bundle's pages are served by that development server on this machine   |

### Bundle states

A bundle is `running`, `failed` or `disabled` (and briefly `enabling` or `disabling`; while
its files change `installing`, `updating` or `removing`). Bundles can be changed while the
server runs, from the dashboard's bundle page or over HTTP:

```sh
curl -X POST http://127.0.0.1:9090/api/v1/bundles/scoreboard/reload
curl -X POST http://127.0.0.1:9090/api/v1/bundles/scoreboard/disable
curl -X POST http://127.0.0.1:9090/api/v1/bundles/scoreboard/enable
```

- `reload` stops the bundle and starts it from what is on disk now: manifest and extension
  code. A broken manifest or a failing extension leaves it `failed` with the error.
- `disable` stops the extension, saves and removes the bundle's replicants, and takes its
  pages, routes and messages away. Connected pages are told that the replicants are gone,
  and told again when the bundle is back: they subscribe anew by themselves and go on
  without being reloaded. A disabled bundle stays disabled across restarts until it is
  enabled.
- `enable` reads the manifest again, restores persistent replicants and starts the extension.
- A bundle that other running bundles depend on cannot be disabled; reloading it restarts them.
- A change to one bundle does not wait for an unrelated bundle that is busy, for example one
  whose extension is slow to start.
- Only real bundle names are accepted: lowercase letters, digits and dashes.
- These calls need the permission `system:bundles.manage`.
- While the installation is **On Air**, `reload` and `disable` are refused with `409` unless
  the JSON body says `"forceOnAir": true`. See
  [docs/development.md](docs/development.md#the-on-air-lock).
- The states are also a read-only replicant, `system:bundles`, for whoever may manage bundles.
  The dashboard follows `system:revision`, which only counts changes, and asks for the list.

### Installing, updating and removing

```sh
export MOONCG_TOKEN=mcg_…   # an API token that holds system:bundles.manage
mooncg bundle install https://example.org/owner/scoreboard.git --ref v1.2.0
mooncg bundle update scoreboard
mooncg bundle remove scoreboard
```

- A bundle comes from a Git repository (`https://`, `ssh://` or `user@host:path`), a ZIP
  archive or a folder on the server's machine. The dashboard's bundle page takes a Git address
  or a ZIP upload.
- It is fetched into `data/staging/` and checked first. What it declares is shown (whether it
  brings server code, its permissions, capabilities, dependencies and npm packages) before it
  is installed, and it can be discarded instead.
- npm packages are installed with `npm ci --omit=dev --ignore-scripts`, with no configuration
  but the server's. A bundle that would run code while it is installed (install scripts, an
  `.npmrc` of its own, dependencies from elsewhere than the registry) is refused unless that
  is allowed for it (`--scripts`).
- An update keeps the earlier version in `data/backups/` and puts it back if the new one does
  not start. Settings, assets and persistent replicants stay through an update and, unless
  asked otherwise, through a removal.
- `"engine": { "mooncg": ">=0.6.0" }` in the manifest says which MoonCG a bundle runs on; a
  bundle that asks for another is refused.

[docs/bundles.md](docs/bundles.md) has the sources, the limits, the rollback, the API and what
is kept.

`dependencies` in the manifest (`{ "team-data": "^2.0.0" }`) decide the start order. A bundle
whose dependency is missing, has the wrong version, is not running, or is part of a cycle is
`failed` with a message that says which.

A bundle with a broken manifest or an extension that fails to start is listed as `failed`. It
serves no files and exposes no replicants; the server and the other bundles keep running.

Replicants are declared in the manifest only. A replicant starts with its `default` value, or
`null` without one. Values must be plain JSON, nested at most 64 levels deep: `undefined`, `NaN`,
`Date`, `Map` and the like are rejected with `bad_request`, as is the member name `__proto__`.

### Schemas

`schema` names a JSON Schema file inside the bundle. Every write, from a page or from the
extension, is applied, checked against the schema and then either committed or rejected as a
whole with the code `invalid` and a message such as `/home: must be >= 0`. Rejected writes
change nothing.

- Schemas are draft-07, or draft 2020-12 if their `$schema` says so.
- `format` and unknown keywords are accepted but not enforced. Asynchronous schemas
  (`"$async": true`) are refused.
- A rejected write reports at most ten violations, followed by how many more there were.
- Bundles are trusted code, and so are their schemas: a `pattern` that takes very long on some
  input slows the server down for everyone. Keeping patterns cheap is up to the bundle author.
- The `default` must match the schema. A replicant with a schema needs a default unless the
  schema accepts `null`.
- A schema file that is missing, not JSON or not a valid schema, or a default that does not
  match, marks the bundle `failed` with an error naming the manifest entry.

### Persistence

A replicant with `"persistent": true` keeps its value across server restarts. Without the field
a replicant is not stored and starts from its default every time.

- Changes are written in the background: after 250 ms without a further change, and at the
  latest 1 s after the first unsaved one. Shutting the server down writes what is pending. If
  the process is killed instead, up to the last second of changes can be lost.
- On start, the stored value is used if it still matches the current schema. If not, the
  replicant starts from its default and the server logs a warning.
- The revision number is stored with the value and keeps counting after a restart.
- If a save fails, it is tried again after 1 s, then 2 s, 4 s and so on up to every 30 s,
  and the failure is logged each time.
- What an extension writes while it is starting is only stored once it has started. A bundle
  that fails to start leaves the stored values as they were.
- Run only one server on a data directory. Two servers sharing one are not supported: each
  would overwrite what the other stored.

### Using replicants in a page

Pages import the SDK from the server:

```html
<script type="module">
  import { createClient } from '/sdk/mooncg.js';

  const mc = createClient(); // the bundle comes from the page URL, /b/<bundle>/...
  const score = mc.replicant('score'); // 'other-bundle:name' reaches another bundle

  score.subscribe((value, meta) => console.log(value, meta.rev));
  await score.update((draft) => {
    draft.home++;
  });
  await score.set({ home: 0, away: 0 });
</script>
```

- `subscribe` calls back with the current value as soon as there is one, then on every change.
- `update` sends only the changes. If someone else changed the value first, it runs the recipe
  again on the new value, up to three more times, then rejects with `conflict`.
- `set` replaces the whole value. The last write wins.
- Both reject with a `MoonCGError` whose `code` is `conflict`, `forbidden`, `not_found`,
  `bad_request`, `invalid`, `timeout`, `unavailable`, `internal` or `disconnected`.
- After a dropped connection the client reconnects and tells the server which revision it has.
  The server keeps the last 100 changes of each replicant, up to 1 MiB of them: if that covers
  the gap and is smaller than the value itself, it sends only what was missed, otherwise the
  whole value. After a server restart it always sends the whole
  value. Subscribers are not called when nothing changed. Operations that were waiting for an
  answer reject with `disconnected`.
- `handle.error` is set while a replicant cannot be used, for example after its bundle failed
  and the server removed it. Writes then reject with that error; `value` keeps the last value.
  `handle.onErrorChange(listener)` tells you when it changes.
- `mc.close()` ends the client for good. Everything still waiting, including `ready`, rejects
  with `disconnected`. The same happens with the server's error if it refuses the handshake.
- `mc.status` says where the connection stands, and `mc.onStatusChange(listener)` calls back
  with the new status whenever it changes and returns the function that stops it. The
  listener is not called for the status at the time of asking; read `mc.status` for that.

  | `status`       | Means                                                                       |
  | -------------- | --------------------------------------------------------------------------- |
  | `live`         | The handshake is done; replicants and messages work                         |
  | `reconnecting` | No connection right now, and the client keeps trying. Also before the first |
  |                | connection, and for a graphic that waits for its place                      |
  | `offline`      | The client is down for good: closed, refused by the server, or ended as the |
  |                | instance of its graphic. Create a new client, or reload the page            |

  ```js
  mc.onStatusChange((status) => document.body.classList.toggle('stale', status !== 'live'));
  ```
- A subscriber that throws is reported with `console.error`; the other subscribers still run.

Two limits of `ready` to know about:

- It settles once. If the first subscription is refused, for example with `forbidden`, `ready`
  stays rejected even if a later reconnect could read the replicant. Create a new client then.
- While the server cannot be reached, `ready` stays pending: the client keeps reconnecting.

Outside a `/b/<bundle>/` page, for example in Node, pass the bundle and URL:
`createClient({ bundle: 'scoreboard', url: 'ws://127.0.0.1:9090/ws' })`. The bundle must be
running on the server, or the handshake is refused with `not_found`.

### Vue and React

Bundles with a build step can install `@mooncg/sdk` and use its adapters. `vue` and `react` are
optional peer dependencies; the plain `/sdk/mooncg.js` contains neither.

```ts
// Vue: a readonly shallow ref that stops following when the component is unmounted.
import { createClient } from '@mooncg/sdk/client';
import { useReplicant } from '@mooncg/sdk/vue';

const mc = createClient();
const { data, error, ready, set, update, stop } = useReplicant(mc.replicant('score'));
```

`data` and `error` are readonly shallow refs; `error` mirrors `handle.error`. Inside a
component's `setup()` or another effect scope, following stops when the scope ends. Called
anywhere else, nothing ends it for you: call `stop()` when you are done.

```tsx
// React: built on useSyncExternalStore. Create the handle once, outside the component.
import { createClient } from '@mooncg/sdk/client';
import { useReplicant } from '@mooncg/sdk/react';

const score = createClient().replicant('score');

function Score() {
  const value = useReplicant(score); // undefined until the first value arrives
  return <output>{value ? `${value.home}:${value.away}` : ''}</output>;
}
```

`useReplicantError(score)` from the same module returns `handle.error` and re-renders only
when that changes.

### Typed replicants

`mooncg types` writes a `mooncg-env.d.ts` for a bundle from its replicant schemas, so that
`mc.replicant('score')` has the right type without a generic:

```sh
node packages/cli/dist/main.js types examples/scoreboard
```

Include the generated file in the bundle's TypeScript project. Replicants without a schema are
typed from their `default`, or as `unknown` without one. Names that are not in the file still
accept a type argument: `mc.replicant<Team[]>('other-bundle:teams')`.

The generator covers `type`, `properties` and `required`, `additionalProperties`, `items`,
tuples, `enum`, `const`, `anyOf`, `oneOf`, `allOf` and `$ref` within the same file. Tuple members
beyond `minItems` are optional, as in JSON Schema. Recursive or external references and anything
else become `unknown`, as do references past the first 500 a schema expands. Run it again after changing a schema.

### Messages

Messages are declared in the manifest and named like replicants, `bundle:name`:

```json
"messages": { "reset": { "send": "operate", "listen": "view" } }
```

```js
await mc.send('goal', { side: 'home' }); // to everyone listening to it
const stop = await mc.on('goal', (data, { sender }) => {});
const result = await mc.request('reset'); // asks the one handler, an extension
```

A message reaches only those listening to that message. `request` rejects with `not_found` if
nobody handles it, `timeout` after 5 seconds (set `{ timeout }` to change that), or
`unavailable` if the handler's bundle stops first. Pages can send, listen and request;
only extensions can handle requests.

### Extensions

The extension is an ES module that runs in its own worker thread and gets the same replicant
and message API, plus request handlers and HTTP routes:

```js
export default async function start(ctx) {
  const score = ctx.replicant('score');
  await ctx.handle('reset', async () => {
    await score.set({ home: 0, away: 0 });
    return score.value;
  });
  await ctx.http.get('/score', () => ({ body: score.value })); // GET /b/<bundle>/api/score
  ctx.onDispose(() => ctx.log.info('Stopped'));
}
```

[docs/extensions.md](docs/extensions.md) describes the whole API, the configuration an
extension receives as `ctx.config`, capabilities, and what changes for authors coming from
NodeCG.

An extension that throws, rejects, exits, loops or runs out of memory ends its own thread, not
the server: the bundle becomes `failed` with the error and is restarted up to three times. So
does an extension that stops responding for ten seconds, for example in a long synchronous
loop. Errors shown in the bundle list have file paths shortened; the server log has them in
full. The
server still catches unhandled rejections and uncaught exceptions of its own process and logs
them, but only as a last resort; with extensions in their own threads it should never fire.
