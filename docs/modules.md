# Modules

A module is code that runs **inside the server**. A bundle makes a show: panels, graphics,
replicants, an extension in its own thread. A module changes the server itself: it adds a way
to sign in, HTTP routes, permissions.

- [Quick path](#quick-path)
- [What a module is, and what it is not](#what-a-module-is-and-what-it-is-not)
- [Where modules come from](#where-modules-come-from)
- [Enabling and disabling](#enabling-and-disabling)
- [Writing a module](#writing-a-module)
- [The manifest](#the-manifest)
- [The context](#the-context)
- [When a module fails](#when-a-module-fails)
- [Who may do this](#who-may-do-this)
- [The API](#the-api)
- [What is not there yet](#what-is-not-there-yet)

## Quick path

```sh
mkdir -p modules/hello
cat > modules/hello/mooncg.json <<'EOF'
{ "manifest": 1, "kind": "module", "name": "hello", "version": "1.0.0", "main": "index.js" }
EOF
cat > modules/hello/index.js <<'EOF'
export default function setup(ctx) {
  ctx.http.register({
    method: 'GET',
    path: '/greeting',
    public: true,
    handler: () => ({ body: { hello: 'world' } }),
  });
}
EOF
# Restart the server so that it finds the folder (or use "mooncg module install",
# see below), then, with a token that holds system:modules.manage:
mooncg module enable hello
curl http://127.0.0.1:9090/m/hello/greeting
```

## What a module is, and what it is not

|               | Bundle                                           | Module                                                 |
| ------------- | ------------------------------------------------ | ------------------------------------------------------ |
| Lives in      | `bundles/<name>/`                                | `modules/<name>/`                                      |
| Manifest      | `mooncg.json` with `"kind": "bundle"`            | `mooncg.json` with `"kind": "module"`                  |
| Runs          | Its extension in a worker thread of its own      | In the server process itself                           |
| Can crash     | Its own thread; the server restarts it           | Nothing when it fails to start; see below for the rest |
| Reaches       | Its own replicants, messages, routes, config     | The server: sign-in, routes, permissions               |
| On by default | Yes, unless disabled                             | No: it runs only once an administrator enabled it      |
| Managed by    | `system:bundles.manage`                          | `system:modules.manage`                                |
| Installed     | Through the dashboard or `mooncg bundle install` | Through the dashboard or `mooncg module install`       |

**A module is trusted code.** It runs with everything the server may do: it can read the
database, the configuration of every bundle with its secrets, and every request. MoonCG does
not sandbox it and does not pretend to. Enable a module only if you would run its code as the
server, because that is what happens.

What MoonCG does do:

- A module in `modules/` does **nothing** until someone with `system:modules.manage` enables
  it. Putting a folder there runs no code.
- Everything a module registers through its context is tracked and taken away when the module
  is disabled or fails.
- A module that cannot be loaded, or whose setup throws, shows as `failed` with the reason.
  The server and the other modules run on.

What it cannot do: an exception a module throws **later** and outside anything the server
called (a timer, an event of a socket it opened itself) reaches the process like any uncaught
error. The server logs it and keeps running, but cannot tell which module it came from.
Handlers the server calls, a route or a login provider, are caught: a route answers 500 and a
sign-in is refused.

## Where modules come from

| Source              | Found in                                 | Shown as   |
| ------------------- | ---------------------------------------- | ---------- |
| The server itself   | Compiled into the server                 | `built in` |
| Shipped with MoonCG | Packages the server depends on           | `built in` |
| The installation    | `modules/<name>/`, one folder per module | —          |

- **`auth-local`** is the sign-in with user name and password. It is part of the server: it
  always runs and cannot be disabled, or nobody could sign in to enable it again. It is listed
  so that you see it goes the same way as every other way to sign in.
- **`auth-oidc`** is shipped with MoonCG as the package `@mooncg/module-auth-oidc` and adds
  sign-in with OpenID Connect, Twitch and Discord. It is disabled until you enable it. See
  [external-logins.md](external-logins.md).
- **Your own** go into the modules folder: `modules/` in the directory the server is started
  in, or what `--modules-dir`, `MOONCG_MODULES_DIR` or `"modulesDir"` of the configuration
  file names. The folder need not exist. Each module is a folder named like the module.

A folder in `modules/` with the name of a module MoonCG ships is ignored, with an error in the
log: the shipped one stays what it is.

A folder whose name no module can have (anything but lowercase letters, digits and single
dashes) is listed as `failed` with the error _Invalid name_, like a bundle folder that cannot
be a bundle, and with a warning in the log. Nothing in it is read or run, and it cannot be
enabled. Its name is shown with characters that draw nothing written out as their code
(`\u{202e}`), so that it reads as what it is.

The modules folder is read when the server starts. A folder you copy there by hand is found at
the next start; one installed with the installer below needs no restart. A module you copy by
hand that has npm dependencies needs them installed in its folder (`npm ci --omit=dev`) before
the server starts.

## Installing, updating and removing

Modules are installed the way bundles are ([bundles.md](bundles.md)): fetched, checked, shown,
and only then put in place. On the **Modules** page (**Install module**, and **Update** and
**Remove** in the row of a module you installed), or:

```sh
mooncg module install https://example.org/owner/greeter.git [--ref v1.2.0] [--scripts] [--yes]
mooncg module install ./greeter.zip
mooncg module update greeter [<source>] [--on-air]
mooncg module remove greeter [--purge-data] [--on-air]
```

1. **Fetch.** From a Git address, from a ZIP archive (uploaded, or a path on the server), or
   from a folder of the server, with the same checks as a bundle: paths in an archive that
   lead out of it are refused; the archive, the unpacked files and their number are bounded by
   the same limits (`--bundle-max-archive-bytes` and the rest); Git runs with the same
   hardening and time limit; a folder or archive inside the modules, bundles or data folder of
   the server is refused. It is fetched into `<data-dir>/module-staging/<id>/`.
2. **Check.** The manifest must say `"kind": "module"`: a bundle is refused here, as a module
   is refused by the bundle installer. The main file must be there, `engine.mooncg` must allow
   this MoonCG, and a new module must not have the name of one that is there (update it
   instead). npm is handled as for a bundle: a module that would make npm do more than fetch
   packages from the registry (an `.npmrc`, dependencies from elsewhere) is refused unless it
   was fetched as trusted (`--scripts`, the checkbox), and install scripts run only when that
   is said.
3. **Read.** The summary names the source, the main file, whether installing runs code, the
   npm packages, whether it has settings and its size, and always says: _Its code runs inside
   the MoonCG server process with full access to the server, its data and secrets, and this
   machine._
4. **Decide.** **Install** puts it into `modules/<name>/`. It is listed **disabled** and stays
   so until someone enables it, also when a module of that name was enabled before it was
   removed. **Discard** deletes what was fetched; it is deleted by itself after 30 minutes,
   and at the next start.

A module can also be installed **from the catalog** of the registry indexes
(`/bundles/catalog?kind=module`, or `mooncg module install <name> [--version <v>]`): the same
steps, with a source the index names (a ZIP checked against its SHA-256, or a Git commit). Its
summary says which index listed it and that MoonCG does not check what an index lists. A
module installed from an index entry shows **Update available** when that entry has a newer
version that runs on this MoonCG; `mooncg module outdated` lists them. See
[registry.md](registry.md).

**Update** fetches the new version from where the module came from, or from the source given,
and shows it with the version it replaces. Putting it in place stops the module, swaps its
folder and, if the module is enabled, starts the new version; if that fails, the earlier
version is put back and started again, and the job ends as `rolled-back`. A disabled module
stays disabled. No backups of modules are kept beyond that.

**Remove** stops the module and deletes its folder. Its configuration
(`<data-dir>/config/modules/<name>.json`) stays for when it is installed again, unless
`--purge-data` (`"purgeData": true`) is given; the dashboard keeps it. That it was enabled is
forgotten.

While the installation is **On Air**, updating or removing an **enabled** module is refused
unless the request says `"forceOnAir": true` (`--on-air`; the dashboard asks). Installing a
new module, and updating or removing a disabled one, interrupt nothing and are not blocked.

Modules shipped with MoonCG (`auth-local`, `auth-oidc`) are updated with MoonCG: they cannot be
updated or removed here (409).

**What an update does not reach.** The new main file is loaded anew, but Node keeps every other
file it has loaded: files that the main file imports stay those of the version that was loaded
first, until the server restarts. A module of one file is updated in full; for any other,
restart the server after the update.

## Enabling and disabling

On the **Modules** page of the dashboard, or:

```sh
mooncg module list
mooncg module enable <name>
mooncg module disable <name>
```

The commands talk to a running server and take `--url` (default `http://127.0.0.1:9090`, or
`MOONCG_URL`) and an API token that holds `system:modules.manage`, from `MOONCG_TOKEN` or
`--token`:

```sh
mooncg token create "modules" --user ada --grant system:modules.manage
```

- **Enabling** starts the module at once and is remembered in the database, so it starts with
  the server from then on. `enable` answers with the module as it then is: if its setup failed,
  the command prints the reason and exits with 1, and the module stays enabled and `failed`.
- **Disabling** stops it: what its setup returned and what it passed to `onDispose` runs, and
  its login providers, routes and permissions are gone. That is remembered as well.
- **Enabling a module that failed** tries again: its manifest and its main file are read anew.
  This is how you try a module you repaired without restarting the server. Files the main file
  imports are **not** read again, because Node keeps what it has loaded: after changing those,
  restart the server.

Grants a role holds of a permission a module defined stay when the module is disabled. They
are a text in the database and mean nothing while nothing asks for them.

## Writing a module

```
modules/
└── hello/
    ├── mooncg.json
    ├── index.js
    ├── config.schema.json     optional
    └── node_modules/          optional, installed by you
```

The main file is an ES module whose default export is the setup function, or an object with a
function `setup`. `defineModule` from `@mooncg/sdk/module` types it and adds nothing at run
time, so a plain function is as good:

```js
import { defineModule } from '@mooncg/sdk/module';

export default defineModule(async (ctx) => {
  ctx.logger.info(`Starting with ${ctx.config.greeting}`);

  const use = ctx.permissions.define('use', 'Use the greeting');
  ctx.http.register({
    method: 'GET',
    path: '/greeting/:name',
    permission: use,
    handler: (request) => ({ body: { hello: request.params.name, by: request.principal.id } }),
  });

  const timer = setInterval(() => ctx.logger.info('still here'), 60_000);
  ctx.onDispose(() => clearInterval(timer));
});
```

The setup may be asynchronous and has ten seconds. It may return a function, which is called
first when the module stops, before what `onDispose` was given, last registered first. What a
module starts beside the context (timers, sockets, files, processes) it stops there itself:
the server can take away what was registered with it, and nothing else.

The server runs JavaScript. For TypeScript, compile and let `main` name the compiled file, as
the shipped `auth-oidc` does (`"main": "dist/index.js"`).

## The manifest

```json
{
  "manifest": 1,
  "kind": "module",
  "name": "hello",
  "version": "1.0.0",
  "title": "Hello",
  "engine": { "mooncg": ">=0.8.0" },
  "main": "index.js",
  "config": { "schema": "config.schema.json" }
}
```

| Field      | Meaning                                                                                |
| ---------- | -------------------------------------------------------------------------------------- |
| `manifest` | Always `1`                                                                             |
| `kind`     | `"module"`. A folder in `modules/` whose manifest says `"bundle"` fails                |
| `name`     | Lowercase letters, digits and single dashes; the folder must have the same name        |
| `version`  | A semantic version                                                                     |
| `title`    | Optional, shown on the Modules page                                                    |
| `engine`   | Optional: the range of MoonCG versions the module runs on. Outside it the module fails |
| `main`     | The file that is loaded, relative to the folder. `index.js` without it                 |
| `config`   | Optional: the JSON Schema of the module's configuration                                |

Everything else a manifest can hold belongs to bundles and is refused in a module:
`extension`, `dependencies`, `permissions`, `defaultRoles`, `panels`, `dialogs`, `graphics`,
`replicants`, `messages`, `assets`, `capabilities`, `dev`. And `main` is refused in a bundle.

## The context

`ctx` is all of the public module API. It is deliberately small: it has what exists and is
tested, and nothing that is only planned.

| Member                                      | Does                                                                |
| ------------------------------------------- | ------------------------------------------------------------------- |
| `ctx.name`, `ctx.dir`                       | The name of the module and the folder it lies in                    |
| `ctx.config`                                | Its configuration as it was when it started. Frozen                 |
| `ctx.logger.info/warn/error(message)`       | Writes to the server log as `[module:<name>]`                       |
| `ctx.auth.registerProvider(provider)`       | Adds a way to sign in. See [external-logins.md](external-logins.md) |
| `ctx.http.register(route)`                  | Adds a route below `/m/<module>`                                    |
| `ctx.permissions.define(name, description)` | Defines a permission and returns its full name                      |
| `ctx.registry.registerSource(source)`       | Adds a registry index the module provides. See below                |
| `ctx.dashboard.registerPage(page)`          | Adds a link to a page of the module to the dashboard. See below     |
| `ctx.onDispose(dispose)`                    | Runs `dispose` when the module stops                                |

Every member that registers something throws when what it is given is not usable, which fails
the setup and so the module, with that message. After the module has stopped they all throw:
a module that was disabled registers nothing any more.

### Configuration

Like a bundle's: a JSON Schema the manifest names, a form drawn from it on the **Settings**
page, values checked against it before they are stored and when the module starts, defaults
of the schema filled in. It is stored in `data/config/modules/<name>.json`, beside the
configuration of the bundles and apart from it, so that a module and a bundle of one name do
not meet.

A property with `"x-secret": true` is a secret: the module gets it, and nobody else does. It
is in no answer of the API, it can be replaced or removed but not read back, and it is taken
out of every log line and error message, also of those the module itself writes. See
[dashboard.md](dashboard.md#bundle-settings) for how secrets behave in the form; all of it
holds for modules.

Saving the configuration **starts the module again** if it is enabled, since `ctx.config` is
what it was at the start. If the module does not start with the new values, the values are
stored all the same and the answer says why it is not running.

### HTTP routes

```js
ctx.http.register({
  method: 'POST', // GET, POST, PUT, PATCH or DELETE; HEAD comes with GET
  path: '/items/:id', // literal segments and :name parameters
  permission: use, // or: public: true
  handler: async (request) => ({ status: 201, headers: { 'x-made': '1' }, body: { ok: true } }),
});
```

The route is served at `/m/<module>/items/:id`.

**A route says who may call it.** It names a `permission`, which the server checks before the
handler runs, or it says `public: true`, which lets anybody call it, signed in or not. A route
with neither is refused: nothing is open by accident. The permission is one the module defined
or a built-in system permission such as `system:settings.manage`; a wildcard or a permission
of another module is refused.

| Caller                                       | Answer                               |
| -------------------------------------------- | ------------------------------------ |
| Not signed in, the route is not public       | 401, whether the route exists or not |
| Signed in, without the permission            | 403                                  |
| Signed in, no such route or module           | 404                                  |
| Signed in, the path takes other methods only | 405 with `Allow`                     |

Module routes go through the same checks as every route of the server. A request that changes
something (anything but `GET` and `HEAD`) is refused from a page of another origin, and when a
cookie authenticates it, it must carry JSON or the header `X-MoonCG-CSRF`. This holds for
public routes too. See [permissions.md](permissions.md#request-forgery).

The handler gets `{ method, path, params, query, headers, body, principal }`. `body` is the
bytes as they came (`Uint8Array`) or `null`; `principal` is `{ id, kind }` of the caller, such
as `user:<id>`, and `anonymous` on a public route nobody signed in for. The handler does
**not** get the caller's `Cookie`, `Authorization` and `Proxy-Authorization` headers or a
`token` query parameter.

It answers `{ status?, headers?, body? }`. A text or bytes are sent as they are, anything else
as JSON. A handler that throws a `MoonCGError` answers with its code; any other error is logged
and answered with 500 without details.

**What a route answers is no page of the dashboard unless it says so.** A module answers from
the origin of the dashboard, so a page it serves could act as the server towards whoever
opens it. Unless the handler sets a `Content-Security-Policy` of its own, the answer goes out
with the policy uploaded files are served with:

```
sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline';
frame-ancestors 'self'
```

A browser that opens such an answer as a document gives it no origin and runs no script in
it. An answer that is data (JSON, text, bytes a script fetches) is not affected. A module that
serves a page with scripts sets its own policy in `headers`, as tight as the page allows, and
is then responsible for what the page does. Every answer also carries
`X-Content-Type-Options: nosniff`, like every answer of the server: set the `content-type`
you mean.

### Permissions

```js
const use = ctx.permissions.define('use', 'Use the greeting');
// use === 'system:module.hello.use'
```

A module defines permissions in a namespace of its own, `system:module.<module>.<name>`. No
built-in permission is in it, so a module cannot redefine `system:users.manage` or any other.
The name is lowercase letters, digits and single dashes.

Defined permissions show on the **Roles** page under _System permissions_, with the
description and the module, and are granted like every other: add
`system:module.hello.use` to a role or a token. `*` and `system:*` cover them, so
administrators hold them without doing anything.

### Login providers

See [external-logins.md](external-logins.md#writing-a-provider).

### Registry indexes of a module

`ctx.registry.registerSource({ id, load })` adds an index whose entries the module provides
itself, for instance read from a private API of a studio:

```js
ctx.registry.registerSource({
  id: 'studio',
  load: async ({ signal }) => {
    const answer = await fetch('https://api.studio.example/mooncg-index', {
      headers: { authorization: `Bearer ${ctx.config.token}` },
      signal,
    });
    return answer.json(); // { "index": 1, "entries": [...] }, as an index file holds it
  },
});
```

- It is listed beside the other indexes as `module://<module>/<id>`, with the origin
  _module_ and the name of the module, and loaded whenever they are: when the server starts or
  the module starts, every 6 hours, and on **Check now**. `id` is lowercase letters, digits and
  dashes; one id once per module.
- What `load` answers is checked like any index (`parseRegistryIndex`), within the time of a
  fetch (30 s) and no larger than an index file (2 MiB). It is copied first: nothing the module
  keeps changes what was checked. An answer that is no valid index makes the index `stale` or
  `error` with the reason, as for a file.
- Its entries must name archives by an `https://` address: there is no file next to which a
  path could be read. This machine and plain `http://` are refused, as in any index that is not
  on this machine.
- Installing from it follows every rule of the catalog. **The server fetches what an entry
  names itself**, with its own checks (the guarded download of a ZIP with its SHA-256, Git
  pinned to a commit, never an internal address unless the configuration allows its private
  network), never through the module: `load` provides a list, not files.
- It is gone when the module is disabled or fails, and cannot be removed in the dashboard
  (409): disable the module instead. What was installed from it stays installed and keeps its
  note of the index; while the index is gone it is offered no update.

A module is trusted code in the server process and could fetch anything itself; what this hook
guarantees is that the catalog, the installers and their checks see what it provides like any
index, so that its entries are bound by the same rules.

### Pages in the dashboard

`ctx.dashboard.registerPage({ id, title, path, permission })` adds a page of the module to the
navigation of the dashboard, under **Modules**:

```js
const view = ctx.permissions.define('stats', 'See the stats');
ctx.http.register({
  method: 'GET',
  path: '/stats',
  permission: view,
  handler: () => ({ headers: { 'content-type': 'text/html' }, body: renderStats() }),
});
ctx.dashboard.registerPage({ id: 'stats', title: 'Stats', path: '/stats', permission: view });
```

- `path` is the path of a `GET` route of the module without parameters; the page is that
  route, `/m/<module><path>`, answered with the same policy as every module route: unless the
  handler sets its own `Content-Security-Policy`, the answer is a sandboxed document that runs
  no script. The route checks its own permission on every request.
- `permission` is one the module defined or a system permission; the page is listed only to
  those who hold it (`GET /api/v1/module-pages`). `title` is at most 60 characters, without
  control or format characters; `id` is unique within the module.
- The navigation shows it as a **link that opens in a tab of its own** (`target="_blank"`,
  `rel="noopener noreferrer"`), not in a frame of the dashboard. A frame sandboxed without
  `allow-same-origin` would keep the page from the dashboard but would also send none of the
  session cookies with the requests the page makes to its own routes, so any page that does
  more than show what its route rendered would not work; a frame with `allow-same-origin` would
  hand the page the window of the dashboard. A tab of its own works for every page and gives it
  no handle on the dashboard.
- It is gone when the module stops. The navigation reads the list when the dashboard loads.

## When a module fails

| What happens                                            | Result                                                    |
| ------------------------------------------------------- | --------------------------------------------------------- |
| No `mooncg.json`, invalid JSON, a field that is refused | `failed`, with what is wrong                              |
| The folder is not named like the module                 | `failed`                                                  |
| `engine.mooncg` does not allow this MoonCG              | `failed`                                                  |
| The stored configuration does not fit the schema        | `failed`; repair it on the Settings page                  |
| The main file is missing or does not load               | `failed`, with the error of the import                    |
| No setup function                                       | `failed`                                                  |
| The setup throws, rejects or takes over ten seconds     | `failed`; what it had registered until then is taken away |
| A route handler throws                                  | That request answers 500; the module keeps running        |
| A login provider throws                                 | That sign-in is refused; the module keeps running         |

`failed` modules are shown with the reason on the Modules page, in `mooncg module list` and in
the log (`Module "<name>" failed: …`). A failed module stays enabled, so it is tried again at
the next start; **Try again** on the Modules page or `mooncg module enable <name>` tries at
once.

A setup that hangs is given up after ten seconds, but MoonCG cannot stop code inside its own
process: whatever the setup still does, it does. Its context is closed, so it registers
nothing.

## Who may do this

| What                                               | Needs                                                    |
| -------------------------------------------------- | -------------------------------------------------------- |
| Listing modules, enabling, disabling               | `system:modules.manage`                                  |
| Reading and writing the configuration of a module  | `system:modules.manage` **and** `system:settings.manage` |
| Seeing the list of system permissions              | `system:users.manage`                                    |
| Installing, updating, removing a module            | `system:modules.manage`                                  |
| Reading the catalog of modules, installing from it | `system:modules.manage`                                  |
| Adding or removing a registry index                | `system:settings.manage` and a manage permission         |
| Putting a module into `modules/` by hand           | Access to the machine                                    |

Only `admin` holds `system:modules.manage` unless you grant it. Of the grants, only `*`,
`system:*` and the permission itself cover it.

**It is the power to run code as the server.** Since modules can be installed through the API,
whoever holds `system:modules.manage` can install a module and enable it, and a module runs
inside the server process with full access to the server, its data and secrets, and the
machine. Treat it like `*`. A role or an API token that held it before modules could be
installed holds that power now: look at which roles and tokens grant it (also through
`system:*`) and take it away where that is more than was meant. In
[dev mode](development.md#dev-mode) every process on the machine holds it.

**Why not `system:bundles.manage`.** Whoever manages bundles decides what runs in worker
threads beside the server. Whoever manages modules decides what runs in the server and, with a
login provider, whom the server believes: changing the issuer of a provider turns every
account linked to it into an account of whoever runs the new issuer. An installation should
be able to let someone install the bundles of a show without handing them that.

**Why both permissions for the configuration.** It is settings with secrets, which is what
`system:settings.manage` is for, and it changes what trusted code does, which is what
`system:modules.manage` is for. Holding only the first must not be enough to redirect a login
provider.

Without the permission these requests answer 403 (401 when not signed in) before anything is
looked at, so they do not tell which modules exist.

## The API

All of it is JSON. Errors are `{ "error": { "code", "message" } }`.

| Request                                         | Does                                                            |
| ----------------------------------------------- | --------------------------------------------------------------- |
| `GET /api/v1/modules`                           | `{ modules: [...] }`, each as below                             |
| `POST /api/v1/modules/:name/enable`             | Enables and starts; `{ module }`, which may be `failed`         |
| `POST /api/v1/modules/:name/disable`            | Stops and disables; `{ module }`. 409 for `auth-local`          |
| `GET /api/v1/modules/:name/config`              | Schema and values without secrets; 404 without a config         |
| `PUT /api/v1/modules/:name/config` `{ values }` | Stores and starts the module again; `restarted`, `restartNote`  |
| `GET /api/v1/permissions`                       | The system permissions, built-in and of running modules         |
| `GET /api/v1/module-pages`                      | The pages of running modules the caller holds the permission of |

Installing, updating and removing:

| Request                                                                | Does                                                   |
| ---------------------------------------------------------------------- | ------------------------------------------------------ |
| `POST /api/v1/modules/-/stage` `{ source, target?, scripts? }`         | Fetches and checks; 202 and a `stage` job              |
| `PUT /api/v1/modules/-/stage?filename=…&target=…&scripts=true`         | The same for a ZIP archive as the body                 |
| `GET /api/v1/modules/-/staged`                                         | `{ staged: [...] }`                                    |
| `POST /api/v1/modules/-/staged/:id/commit` `{ scripts?, forceOnAir? }` | Installs or updates; 202 and a job                     |
| `DELETE /api/v1/modules/-/staged/:id`                                  | Discards; 204                                          |
| `GET /api/v1/modules/-/jobs`, `…/jobs/:id`                             | The latest 20 jobs; one job                            |
| `GET /api/v1/modules/-/sources`                                        | Where each installed module came from, without secrets |
| `POST /api/v1/modules/:name/update` `{ source?, scripts? }`            | Stages the new version; 202 and a `stage` job          |
| `POST /api/v1/modules/:name/remove` `{ purgeData?, forceOnAir? }`      | Removes; 202 and a job                                 |

`source` is as for bundles. A job has `id`, `operation` (`stage`, `install`, `update`,
`remove`), `state` (`queued`, `running`, `succeeded`, `failed`, `rolled-back`), the `step` it is
at, `module`, and when it is over `error` and `rollbackError`. A `stage` job that succeeded
carries `staged`. The read-only replicant `system:module-installs` holds `{ jobs, staged }` for
those who may manage modules. The upload needs the header `X-MoonCG-CSRF` when it is sent with
a session cookie.

A module:

```json
{
  "name": "auth-oidc",
  "title": "External logins (OpenID Connect, Twitch, Discord)",
  "version": "0.8.0",
  "builtin": true,
  "internal": false,
  "enabled": true,
  "state": "running",
  "config": true,
  "providers": ["oidc"],
  "permissions": [],
  "routes": 0,
  "indexSources": [],
  "pages": []
}
```

`indexSources` are the ids of the registry indexes it provides and `pages` the ids of its
pages in the dashboard, while it runs. `state` is `running`, `disabled` or `failed`; a failed one has `error`. `internal` is true for
what is part of the server and cannot be disabled. A folder with a name no module can have is
in the list as `failed`, and every request that names it answers 404.

## What is not there yet

The plan for MoonCG names more hooks than the context has. They are left out rather than
shipped as something that does not work:

| Hook                      | State                                                             |
| ------------------------- | ----------------------------------------------------------------- |
| `storage.registerAdapter` | Not there. See below                                              |
| Password providers        | Internal only: `auth-local` registers the one there is            |
| Reloading on file changes | Not there. The watcher watches bundles; modules are read at start |

`storage.registerAdapter` is left out on purpose. The replicant store has a small interface
(`load`, `save`, `removeBundle`, `close`), but it is chosen before anything else starts: the
replicants of the bundles are restored from it before a module is loaded, and settings,
accounts and sessions share the same database. An adapter a module registers would come too
late for what was restored, would leave with the module while bundles still write to it, and
would need a migration of what is stored; none of that falls out of the present design.

Of the built-in parts of the server, the local login is a module (`auth-local`): it registers
its provider in the same registry the providers of modules are in, and the login route asks
that registry. Storage, the bundle manager and the rest of the server are not modules.
