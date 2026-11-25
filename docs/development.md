# Developing bundles: live reload, dev mode and the On Air lock

This page is for whoever writes a bundle, and for whoever runs a show while a bundle is still
being finished. It covers:

- [the command line](#the-command-line) for a new installation and a new bundle,
- [the configuration file](#the-configuration-file),
- [live reload](#live-reload): what the server does when a bundle's files change,
- [dev mode](#dev-mode): `mooncg dev`, and what it opens up,
- [`dev.url`](#a-development-server-devurl): pages served by Vite or another dev server,
- [the On Air lock](#the-on-air-lock), which keeps all of that away from a running show.

## Quick path

```sh
mooncg init my-show          # bundles/, data/, mooncg.config.json
cd my-show
mooncg bundle create lower-third
mooncg dev                   # http://127.0.0.1:9090/, signed in, watching bundles/
```

Edit `bundles/lower-third/dashboard/control.html` and save: the panel reloads. Before a show,
stop `mooncg dev` and run `mooncg start`.

In this repository the command is `node packages/cli/dist/main.js` after `pnpm build`;
`pnpm dev` builds and starts dev mode with the bundles in `examples/`.

## The command line

| Command                                                                            | What it does                                              |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `mooncg init [folder]`                                                             | Creates an installation folder. Overwrites nothing        |
| `mooncg bundle create <name> [--template html] [--dir <folder>] [--config <file>]` | Creates a bundle from a template. Needs no running server |
| `mooncg start [server flags]`                                                      | Starts the server in the current directory                |
| `mooncg dev [server flags]`                                                        | Starts the server in [dev mode](#dev-mode)                |

`mooncg init` creates `bundles/`, `data/`, `mooncg.config.json` and, unless there is one, a
`.gitignore` that keeps `data/` out of a repository: the database in it holds password hashes
and session secrets. A folder that already has a `mooncg.config.json` is refused.

`mooncg bundle create` writes `<bundles folder>/<name>/` from a template that ships with the
command line. The bundles folder is the one `--dir` names, else the one the server would use
in the current directory: `MOONCG_BUNDLES_DIR`, else `bundlesDir` of the configuration file
(`mooncg.config.json`, or the file `--config` or `MOONCG_CONFIG` names, as for the server),
else `./bundles`. A folder that exists is never written to. If a file cannot be written, the
folder the command created is removed again, so that nothing half-written stays and the
command can simply be run once more. There is one template, `html`: a panel, a graphic, an
extension and a replicant with a schema, in plain HTML and JavaScript without a build step.
A Vite and Vue template does not exist yet.

`mooncg start` and `mooncg dev` take every flag of the server (see the
[README](../README.md#configuration)). `mooncg dev` is `mooncg start --dev`.

## The configuration file

The server reads `mooncg.config.json` from the directory it is started in. `--config <file>`
or `MOONCG_CONFIG` name another file, which must then exist.

```json
{
  "port": 9090,
  "host": "127.0.0.1",
  "bundlesDir": "bundles",
  "dataDir": "data",
  "allowedOrigins": [],
  "watch": false
}
```

| Setting          | Flag                    | Environment variable     |
| ---------------- | ----------------------- | ------------------------ |
| `port`           | `--port`                | `MOONCG_PORT`            |
| `host`           | `--host`                | `MOONCG_HOST`            |
| `bundlesDir`     | `--bundles-dir`         | `MOONCG_BUNDLES_DIR`     |
| `dataDir`        | `--data-dir`            | `MOONCG_DATA_DIR`        |
| `allowedOrigins` | `--allowed-origin`      | `MOONCG_ALLOWED_ORIGINS` |
| `watch`          | `--watch`, `--no-watch` | `MOONCG_WATCH`           |

A flag wins over the environment variable, which wins over the file, which wins over the
default. That holds for turning `watch` off as well as on: `--no-watch` wins over everything,
and `MOONCG_WATCH=0` (anything but `1` or `true`) turns off what `"watch": true` in the file
turns on. A variable that is set to nothing counts as not set. Relative paths in the file
start at the folder the file is in; relative paths in flags and environment variables start
at the working directory. A setting the server does not
know, or of the wrong type, keeps it from starting and is named in the error: a typo is not
passed over. Everything else is configured with flags and environment variables only.

`dev` cannot be set in the file, and there is no environment variable for it. See
[dev mode](#dev-mode) for why.

## Live reload

With the watcher on, the server watches the folder of every bundle that is not disabled and
applies what changes. The watcher is **off** unless `--watch` (or `MOONCG_WATCH=1`, or
`"watch": true` in the file) turns it on, and `--no-watch` or `MOONCG_WATCH=0` turn it off
again. Dev mode always turns it on.

| What changed                                    | What happens                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------ |
| `mooncg.json`                                   | The bundle is reloaded, if the new manifest is valid (see below)         |
| `schemas/**`, and any schema the manifest names | The bundle is reloaded, if every schema is usable and every default fits |
| `extension/**`, `shared/**`                     | The bundle's extension is restarted. Its replicants and messages stay    |
| `dashboard/**`                                  | The bundle's open panel and dialog pages load themselves again           |
| `graphics/**` in dev mode                       | The bundle's open graphic pages load themselves again                    |
| `graphics/**` outside dev mode                  | Nothing is reloaded. The open pages are marked **out of date**           |
| anything else                                   | Nothing                                                                  |

- Changes are collected for 150 ms after the last one, then applied once.
- `node_modules`, `.git` and every folder or file whose name starts with a dot are never
  looked at, at any depth.
- A change to several areas at once does all of the above; a reload of the bundle stands in
  for a restart of its extension, and the pages are told after the bundle is back.
- A bundle that failed gets another try when its extension or manifest changes: the fix for a
  bundle that does not start is usually an edit.
- A disabled bundle is not watched.

### An invalid manifest or schema

If `mooncg.json` on disk is not a valid manifest, or a schema is not usable, or a replicant's
default no longer fits its schema, the bundle is **not** reloaded. The version that ran
before keeps running, with its panels, graphics and replicants, and the bundle carries the
reason in `reloadErrors`: the Bundles page shows the badge `not reloaded` with the errors, and
the log has them. The next change that makes the files valid reloads the bundle and takes the
errors away. Nothing has to be restarted by hand.

The files are read once for this. The manifest and the schemas that were checked are the
ones the bundle is started with, so an editor that saves in two steps, and leaves a file cut
short for a moment right after it was found valid, cannot turn a running bundle into a failed
one. The later change is seen like any other, and then stops nothing.

What cannot be checked without starting, such as an extension that throws, is found the usual
way: the bundle is `failed` with its error, and the next change gives it another try.

### Graphics are never reloaded behind your back

A graphic may be on air. Outside dev mode nothing reloads a graphic page but a person: the
watcher only marks the connected pages. The Graphics page shows `Out of date` beside each of
them, next to the `Reload` button that has always been there (it takes
`system:bundles.manage` besides the graphic's own permission). The page that connects after
the reload is listed without the mark. The mark is also in the replicant
`<bundle>:$instances.<graphic>`, as `outOfDate: true`.

In dev mode graphics reload with their files like panels do.

### Pages survive a restart of their bundle

When a bundle is reloaded, disabled and enabled, updated, or restarted after a crash, its
replicants and message topics go away and come back. Pages that were open stay connected and
recover by themselves:

- The server tells a page which replicant or topic it lost (`rep.gone`, `msg.gone`), and
  tells it again when it is declared anew (`rep.back`, `msg.back`). The SDK then subscribes
  again; the request is checked like the first one, so a page gets back only what it may have
  under the new manifest. `ReplicantHandle.error` is set in between and cleared afterwards;
  `useReplicant` and friends follow it.
- A page that connects while its bundle is not running is not turned away for good: the SDK
  keeps asking, after 1, 2, 4, 8 and then every 15 seconds, and `status` stays
  `reconnecting`. `createClient({ waitForBundle: false })` restores the old behaviour, where
  `ready` rejects with `not_found`.

This needs protocol version 6 on both sides, which pages that load `/sdk/mooncg.js` have by
themselves. A bundle that brings its own copy of `@mooncg/sdk` must rebuild.

### Updating and removing while the watcher is on

A folder that is being watched cannot be renamed on Windows. The bundle manager therefore
closes the watcher of a bundle before its folder is swapped by an update or a restore, or
taken away by a removal, and opens a new one afterwards. All watchers are closed when the
server shuts down.

The watcher is [chokidar](https://github.com/paulmillr/chokidar) 6, which needs Node.js 22.22
or newer; that is why the server and the command line ask for that version (`engines` in
their `package.json`). It is only loaded when watching is on.

## Dev mode

`mooncg dev` (or `--dev` on the server) is for writing bundles on your own machine. It does
three things that a server for a show must never do:

1. **It watches** the bundle folders, and reloads graphics with their files.
2. **It honours `dev.url`** of a manifest: see [below](#a-development-server-devurl).
3. **It signs you in.** Every request from this machine that brings no credentials acts as an
   administrator, without a password.

> **Warning: never run dev mode behind a reverse proxy or a tunnel.** nginx, Caddy, ngrok,
> Cloudflare Tunnel, `ssh -R`, the port forwarding of VS Code or of a container: whatever
> accepts connections from elsewhere and passes them on to MoonCG on this machine makes
> **everyone who can reach it an administrator, without a password**. To MoonCG their
> requests come from this machine, like your own. It refuses a request that carries a proxy
> header and one whose `Host` does not name this machine, but a proxy or tunnel need not
> send either, and several rewrite `Host` to `localhost` by default. **MoonCG cannot detect
> that.** If anyone else is to reach the server, run `mooncg start` and let them sign in.

The third is why dev mode is fenced in:

- It exists as the flag `--dev` only. No environment variable and no configuration file turns
  it on, so it cannot be left on by accident in a service definition or a shell profile.
- It listens on loopback only. A host other than `localhost`, `127.x.x.x` or `::1` is
  refused, and the server does not start. So is `--trust-proxy`.
- It refuses to start with an allowed origin that is not on this machine, wherever it was
  configured (`--allowed-origin`, `MOONCG_ALLOWED_ORIGINS`, `allowedOrigins` in the
  configuration file, which is read from the working directory). `http://localhost:5173` is
  fine; `https://example.com` is not: its pages would be let through to a server that asks
  nobody for a password.
- For every request, the sign-in applies only if **all** of this holds:
  - the other end of the TCP connection is this machine (the socket's own address; no header
    is believed about it);
  - the request carries no proxy header (`Forwarded`, `Via`, `X-Forwarded-*`, `X-Real-IP`);
  - its `Host` header names this machine (`localhost`, `127.x.x.x` or `[::1]`), which keeps a
    website whose name was pointed at `127.0.0.1` (DNS rebinding) out;
  - it states no `Origin`, or one on this machine: the server's own, that of another server
    here, or that of a `dev.url`, which can only be on this machine. A browser on this
    machine connects from loopback whatever page it shows, so the address says nothing about
    the page; its origin does;
  - it brings **no credentials at all**: no session or token cookie, no `Authorization`
    header, no `token` in its address. Credentials that are not accepted (a session that
    ended, a token that was revoked or mistyped) are answered with `401` as they are outside
    dev mode, and never turned into an administrator.
- The server says so at every start, as a warning in the log.

What that means for **a page of another site** that is open in a browser on this machine,
exactly:

- Its `fetch` and `XMLHttpRequest` calls and its WebSocket state its origin. They are not
  signed in, so they are anonymous: the API answers `401`, and the WebSocket is refused,
  with `403` because the origin is not allowed (dev mode does not start with a foreign one
  allowed) and with `401` even if it were.
- A request of it that changes something (anything but `GET` and `HEAD`) is refused with
  `403` for its origin, as outside dev mode. A request that is signed in by dev mode and
  changes something needs a JSON body or the header `X-MoonCG-CSRF`, exactly as with a
  session cookie, which a form on another site cannot send.
- What a browser sends **without** an `Origin` is signed in: a link or redirect to MoonCG
  that the browser follows, and the `GET` of an `<img>`, `<script>` or `<iframe>` tag. A
  session cookie would not go along with the last three; the sign-in of dev mode does. The
  other site cannot read the answers (MoonCG sends no CORS headers, the dashboard and the
  login page refuse to be framed, and a bundle's pages may be framed by MoonCG only), with
  the exception that is as old as the web: a JavaScript file it loads with a `<script>` tag
  runs in its page. And such a request does reach a bundle's own `GET` routes. So keep the
  `GET` routes of an extension free of side effects, and while dev mode runs, do not browse
  sites you do not trust in the browser you develop in.

### The user `dev`

Dev mode never acts as a real person. It acts as a user of its own, created at the first
start in dev mode: `dev`, with the role `admin`, marked as created by dev mode and without a
password. (If a real user is called `dev`, it takes `dev-mode`, or `mooncg-dev`.) In dev mode
that user is an ordinary administrator, so preferences and API tokens work as usual, and the
log says `dev` did what was done without a password.

Outside dev mode that user is **inert**:

- It cannot sign in. It has no password and cannot be given one, by the API, the dashboard
  or `mooncg user passwd`.
- Its sessions and API tokens are not accepted, and they are deleted at the next start
  without `--dev`. A token for a show must be created by a real user.
- It does not count as a user or as an administrator. An installation that was only ever
  used in dev mode is still a fresh one: `mooncg start` prints the one-time setup link and
  `/setup` creates the first administrator. Nor can the last real administrator be removed
  because `dev` is there.
- A start without `--dev` says once in the log, as a warning, that such a user exists.

It cannot be turned into a normal account: it cannot be renamed, disabled, given a password
or given or taken a role. It can only be deleted (on the Users page, where it is listed as
`dev mode only`, as it is by `mooncg user list`); dev mode creates it again at its next start.
There is no setup in dev mode: create real users on the Users page or with
`mooncg user create`.

Whoever brings credentials acts as themselves, also in dev mode: sign in at `/login` as
another user, or send an API token, to see what a viewer sees. One thing is done for a
browser that still holds a cookie from an earlier start whose session has ended: when it
opens a page of the dashboard, the server deletes that cookie and sends the browser to the
same page again, which it then gets without credentials. Nothing else is done for stale
credentials; an API request with one is answered `401`.

What dev mode does not protect against: other people and other programs **on the same
machine**, and whatever passes connections on to it (see the warning above). Anything that
can open a connection to loopback is an administrator. Do not run dev mode on a machine
others log in to, and never for a show. `mooncg start` has none of it.

## A development server: `dev.url`

A bundle whose pages are built by Vite, or served by any other development server with hot
module replacement, names that server in its manifest:

```json
{ "dev": { "url": "http://localhost:5173" } }
```

**In dev mode only**, for a bundle that runs:

- A request for `/b/<bundle>/dashboard/…` or `/b/<bundle>/graphics/…` is answered with a
  redirect to the same path on the development server
  (`http://localhost:5173/dashboard/control.html`), after the same permission checks as ever.
  A query string is kept. Assets and HTTP routes of the bundle are not redirected.
- MoonCG does not reload that bundle's pages when `dashboard/` or `graphics/` change: the
  development server does that better. Changes to the manifest, schemas and the extension
  are applied as usual.
- Pages of that origin may open the WebSocket and send requests, and the dashboard may show
  them in a frame: its Content-Security-Policy gets `frame-src 'self' <that origin>` added,
  and nothing else changes.

The address must be `http://` or `https://` on this machine (`localhost`, `127.x.x.x` or
`[::1]`), without user name, password, query or fragment; a manifest with any other address
is invalid. Outside dev mode `dev.url` is ignored: the files come from the bundle folder, no
origin is allowed and the policy is the built-in one to the letter. So a bundle can keep
`dev.url` in its manifest when it is installed for a show, as long as its built files are in
`dashboard/` and `graphics/`.

A page served by the development server is not under `/b/<bundle>/`, so it says who it is:

```js
import { createClient } from '@mooncg/sdk/client';

const mc = createClient({ bundle: 'lower-third', url: 'ws://localhost:9090/ws' });
```

Limits to know:

- Use the same host name for both servers (`localhost` and `localhost`, not `localhost` and
  `127.0.0.1`), so that a session cookie is sent along. With the sign-in of dev mode it works
  either way.
- `import '/sdk/mooncg.js'` resolves against the development server. Bundle the SDK, or let
  the development server proxy `/sdk` to MoonCG.
- Dialogs (`mc.dialogs.open`) talk to the dashboard by `postMessage` between pages of one
  origin, so they do not work from a page of the development server. Test dialogs against the
  built files.
- A graphic says which graphic it is by its path under `/b/<bundle>/graphics/`. A page of the
  development server passes `graphic: 'graphics/overlay.html'` to `createClient` to be listed
  as an instance.

## The On Air lock

One switch for the whole installation. While it is on:

- **Putting an update in place, remove, disable, reload** of a bundle, **restoring a
  backup** over an installed bundle and **restarting an extension** are refused with
  `409 conflict` and a message that says why, unless the request overrides the lock.
- **The watcher acts on nothing.** What changes on disk is recorded per bundle as
  `pendingChanges` (the areas that changed, such as `dashboard` and `extension`), shown on the
  Bundles page as `changes pending`. When the switch goes off, the pending changes are
  applied, as if the files had just been saved.
- **Saving a bundle's settings** stores them, but does not restart the extension; the answer
  says so, and the settings apply at the next start.

What it does not block: enabling a bundle, the automatic restart after a crash (both bring
something back and take nothing away), `Reload` and `Disconnect` of one graphic page (they are
an operator's tools during a show), installing a new bundle, **fetching an update** (from Git,
a folder or an upload: it waits staged, and only putting it in place is blocked), and
replicants, messages and assets, which are the show itself.

It is one switch and not one per bundle on purpose. Bundles depend on each other, so a lock on
one would still let a reload of what it needs take it down; and under pressure nobody
remembers which of ten bundles they forgot to lock.

| Request                                  | Permission                                         | Answer                                                            |
| ---------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------- |
| `GET /api/v1/on-air`                     | `system:dashboard.view` or `system:bundles.manage` | `{ onAir, since?, by?, canSwitch }`. `by` only for who may switch |
| `PUT /api/v1/on-air` `{ "onAir": true }` | `system:bundles.manage`                            | The same                                                          |

The state is kept in the database and survives a restart. It is also the read-only replicant
`system:onAir` (`{ onAir, since? }`), for everyone with `system:dashboard.view`. Who switched
it is written to the log.

The lock **fails closed**. If the stored state cannot be read at a start, or is not
something the server stored, the installation counts as on air, and the log says so as an
error together with how to end it: switch On Air off in the dashboard or with
`PUT /api/v1/on-air`, which works as ever and stores a fresh state. A lock that is on by
mistake costs a click; one that is off by mistake can cost a show. Only an installation that
never stored a state starts off air.

**Overriding the lock.** A change goes through although the installation is on air when its
JSON body says `"forceOnAir": true`, and nothing but a plain `true` counts. It takes the same
permission as the change itself, `system:bundles.manage`; there is no separate right for it.
It applies to:

| Request                                            | What `"forceOnAir": true` lets through |
| -------------------------------------------------- | -------------------------------------- |
| `POST /api/v1/bundles/<name>/{reload,disable}`     | The reload, the disabling              |
| `POST /api/v1/bundles/<name>/remove`               | The removal                            |
| `POST /api/v1/bundles/-/staged/<id>/commit`        | Putting a staged update in place       |
| `POST /api/v1/bundles/<name>/backups/<id>/restore` | The restore over an installed bundle   |
| `PUT /api/v1/bundles/<name>/config`                | The restart of the extension           |

`"force"` is another word and overrides no lock. It exists on `remove` only and means what it
meant before there was a lock: remove the bundle although enabled bundles still need it. A
removal that both stand in the way of takes both.

Fetching is never refused: `POST /api/v1/bundles/<name>/update`,
`POST /api/v1/bundles/-/stage` and the upload answer as they do off air. The commit of an
update is what meets the lock; its refusal says that the new version stays staged, so it can
be put in place when On Air is off, until it expires like every staged bundle.

On the command line it is `--on-air` on `mooncg bundle update|remove|disable|reload|restore`;
`--force` on `remove` is for a bundle others still need and nothing else. `mooncg bundle
update` without `--on-air` asks the server first and stops before anything is fetched, with
the reason and the flag. In the dashboard, the switch is in the sidebar for whoever holds
`system:bundles.manage`, and everyone sees where it stands; while it is on, **Reload**,
**Disable** and **Remove** ask first and then override the lock, and only the lock. An update
can be fetched without a question; its card says that putting it in place is blocked, and
**Update** asks before it does it anyway.

## Checklist before a show

- Run `mooncg start`, not `mooncg dev`. The log must not say `DEV MODE`.
- Leave the watcher off, or accept what it does: panels reload on a change, graphics do not.
- Switch **On Air** on when the show starts, and off when it is over.
- If something must be changed during the show, override the lock for that one change,
  knowingly.
