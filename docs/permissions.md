# Accounts and permissions

Everything MoonCG serves needs a signed-in user or an API token. There is no open mode: a
request without valid credentials is anonymous, and an anonymous request gets nothing but the
login and setup pages.

- [First start](#first-start)
- [The model](#the-model)
- [Built-in roles](#built-in-roles)
- [How a bundle declares permissions](#how-a-bundle-declares-permissions)
- [API tokens, and graphics in OBS](#api-tokens-and-graphics-in-obs)
- [Managing users, roles and tokens](#managing-users-roles-and-tokens)
- [Sessions, passwords and throttling](#sessions-passwords-and-throttling)
- [Request forgery](#request-forgery)
- [Listening beyond this machine](#listening-beyond-this-machine)
- [Response headers](#response-headers)
- [Extensions](#extensions)

Signing in with an account kept elsewhere (OpenID Connect, Twitch, Discord) is in
[external-logins.md](external-logins.md); modules, which add such ways to sign in, routes and
permissions, are in [modules.md](modules.md).

## First start

While no user exists, the server prints a setup URL when it starts:

```
INFO  No user exists yet. Create the first administrator at http://127.0.0.1:9090/setup?code=…
```

Open it, choose a user name and a password, and sign in. The code is random, lives in the
server's memory only and changes with every start. Once any user exists, `/setup` and
`POST /api/v1/setup` answer 404, and no other route creates a user without signing in. The
user that [dev mode](#dev-mode) creates for itself does not count as one: an installation
that was only ever used in dev mode is set up like a fresh one. In dev mode itself there is
no setup.

You can also create the first user from the command line, before or while the server runs:

```sh
mooncg user create ada --admin --data-dir data
```

There is no open mode: nothing is served to someone who is not signed in. The one exception is
made on purpose and for one machine only, [dev mode](#dev-mode).

## The model

| Term       | Meaning                                                                               |
| ---------- | ------------------------------------------------------------------------------------- |
| Principal  | Who acts: a user (`user:<id>`), an API token (`token:<id>`), an extension, or nobody  |
| Permission | A string, such as `system:bundles.manage` or `bundle:scoreboard:operate`              |
| Grant      | A permission or a wildcard pattern that a role or a token holds                       |
| Role       | A named set of grants. Users have roles; roles are the only way a user holds anything |

A grant matches a permission when it is `*`, or when it has the same number of `:`-separated
parts and each part is equal or `*`:

| Grant                       | Covers                                      |
| --------------------------- | ------------------------------------------- |
| `*`                         | Everything                                  |
| `bundle:scoreboard:operate` | That one permission                         |
| `bundle:scoreboard:*`       | Every permission of the bundle `scoreboard` |
| `bundle:*:view`             | The permission `view` of every bundle       |
| `system:*`                  | Every system permission                     |

System permissions:

| Permission                      | Allows                                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `system:dashboard.view`         | The dashboard page, the bundle list, the replicant `system:revision`                                               |
| `system:bundles.manage`         | Installing, updating, removing, enabling, disabling and reloading bundles                                          |
| `system:users.manage`           | Users, roles and grants, within what the holder holds (see below)                                                  |
| `system:tokens.manage`          | Creating, listing and revoking API tokens                                                                          |
| `system:settings.manage`        | Reading and changing the configuration of bundles; the settings page                                               |
| `system:logs.view`              | The log page and `GET /api/v1/logs`                                                                                |
| `system:modules.manage`         | Installing, updating, removing, enabling and disabling modules; with `system:settings.manage`, their configuration |
| `system:module.<module>.<name>` | Whatever the module that defined it says. See [modules.md](modules.md#permissions)                                 |

**`system:modules.manage` is the power to run code as the server.** A module runs inside the
server process with full access, and whoever holds the permission can install one and enable
it. Grant it as you would grant `*`.

`system:users.manage` also covers linking and unlinking the external accounts of users, under
the same rule as everything about users (see below). A module is code that runs inside the
server, which is more than a bundle is, so managing modules is a permission of its own and not
`system:bundles.manage`; [modules.md](modules.md#who-may-do-this) says why. Permissions that
modules define are in a namespace of their own, `system:module.…`, so no module can redefine
a built-in one. `GET /api/v1/permissions` lists all system permissions there are, to holders
of `system:users.manage`, and the Roles page shows them.

Two things need only that you are signed in, with whatever grants: loading the SDK
(`/sdk/mooncg.js`) and opening the WebSocket. Both are what every bundle page does first, also
a graphic opened with a token that holds a single bundle permission. What a socket may do is
checked per replicant and per message.

**Bundle resources without a permission.** A panel, dialog, graphic, replicant, message,
asset category or HTTP route whose manifest entry names no permission, and every other file of
a bundle such as a stylesheet, is open to whoever holds **at least one permission of that
bundle**.

**A bundle you hold nothing of is not there for you.** Its files and routes under
`/b/<bundle>/` answer 404 with the same body as for a bundle that is not installed, and on a
socket its replicants and messages answer `not_found`, as does `hello` for it. So nothing
tells which bundles exist. 403 and `forbidden` are answered only where you can see the bundle
but lack the specific permission.

**Nobody hands out more than they hold.** `system:users.manage` alone does not make an
administrator. Whoever manages users, roles and grants through the API can

- assign or remove a role, or delete one, only if they hold every grant of that role,
- add a grant to a role or remove one, or create a role, only with grants they hold,
- rename, disable, delete or reset the password of a user, or link an external account to
  them or unlink one, only if they hold everything that user holds. Linking an account to a
  user lets whoever has that account act as the user.

Anything else is refused with 403. Holders of `*` are not limited by this. The `mooncg`
command works on the data directory directly and is not limited either: whoever can run it
there can read and write the database anyway.

**What you are shown.** `GET /api/v1/bundles` lists only the bundles you hold a permission of
(all of them if you may manage bundles), and of each only the panels, dialogs and graphics you
may open and the asset categories you may read, each with whether you may change it. The
bundles a bundle needs (`dependencies`) are named under the same rule: one you would not be
listed is not named there either. A bundle that is needed but not installed is named only to
holders of `system:bundles.manage`, whatever a grant with a wildcard would cover.
The replicant `system:bundles`, which has the state of every bundle, needs
`system:bundles.manage`. Everyone with the dashboard can follow `system:revision`, a counter
that moves when a bundle changes, and ask for the list again. Where a bundle was installed from
(`source`) is told to holders of `system:bundles.manage` only, and they get the list also
without `system:dashboard.view`, as a token for the command line may be.

### Installing, updating and removing bundles

An installed bundle is trusted code: its extension runs on the server, with the rights of the
server, limited only by its capabilities. Whoever may install a bundle may therefore run code
on the machine. That is the boundary, and one permission guards all of it:

| What                                                                       | Needs                                                                      |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Fetching a bundle into staging, committing or discarding it                | `system:bundles.manage`                                                    |
| Updating and removing a bundle, listing and restoring backups              | `system:bundles.manage`                                                    |
| Reading jobs and staged bundles, the replicant `system:installs`           | `system:bundles.manage`                                                    |
| Trusting a bundle to run code while it is installed, per bundle            | `system:bundles.manage`                                                    |
| Switching On Air (`PUT /api/v1/on-air`)                                    | `system:bundles.manage`                                                    |
| Making a change although the installation is on air (`"forceOnAir": true`) | `system:bundles.manage`, as the change itself                              |
| Reading where On Air stands (`GET /api/v1/on-air`, `system:onAir`)         | `system:dashboard.view`; who switched it only with `system:bundles.manage` |

Without it these requests answer 403 (401 when not signed in) before anything is looked at,
so they do not tell whether a bundle, a job or a backup exists. The server log records who did
what.

What a holder supplies is still checked as hostile where the server's own files and processes
are concerned: an archive cannot write outside its staging folder, a Git address cannot become
an option or a command, a folder inside the bundles or data folder is refused, and nothing
passes through a shell. What the permission does include, by its nature: the server fetches
from any host a Git address names, also one only it can reach, and reads any folder its account
can read when given a path. [bundles.md](bundles.md) has the details and the limits.

Even a holder is not surprised by a bundle: before it is installed, the summary says whether it
brings server code, whether installing it runs code (install scripts, its own `.npmrc`,
dependencies from elsewhere than the registry, all refused unless allowed for that bundle), and
which role grants it proposes. Git and npm run with the configuration of the machine switched
off wherever that could run a program.

**On Air.** While the installation is on air, updating, removing, disabling and reloading a
bundle are refused unless the request overrides the lock (`"forceOnAir": true`). Overriding is
not a right of its own: whoever may make the change may override the lock for it, and nobody
else can. The lock is a guard against mistakes during a show,
not against a holder of `system:bundles.manage`, who could switch it off just as well. See
[development.md](development.md#the-on-air-lock).

Grants that name a bundle stay when the bundle is removed, and apply again to a bundle of the
same name. `defaultRoles` are turned into grants the first time a bundle name is seen; an
update does not change grants. Removing a bundle with its data (`purgeData`) takes the grants
of its permissions out of every role and forgets the name; API tokens keep what they hold.

### Bundle settings, assets, dialogs and instances

| What                                                | Needs                                                                            |
| --------------------------------------------------- | -------------------------------------------------------------------------------- |
| Reading or writing a bundle's configuration         | `system:settings.manage`                                                         |
| Opening a dialog, loading its file                  | The dialog's `requires`                                                          |
| Listing and loading the files of an asset category  | The category's `read`                                                            |
| Uploading and deleting them                         | The category's `read`, and its `write`; without `write`, `system:bundles.manage` |
| The replicant `<bundle>:$assets.<category>`         | The category's `read`; nobody can write it                                       |
| The replicant `<bundle>:$instances.<graphic>`       | The graphic's `requires`; nobody can write it                                    |
| Reloading or disconnecting a connected graphic page | The graphic's `requires` and `system:bundles.manage`                             |
| Learning who has a graphic open (`GET …/instances`) | `system:bundles.manage`                                                          |

Where a row names a manifest field that the bundle left out, any permission of the bundle
does. The one exception is `write` of an asset category: changing the files a graphic shows
on air is more than using the bundle, so a category that does not say who may takes
`system:bundles.manage`.

The replicant `$instances` says that a page is connected and since when, not who it acts as:
whoever may open a graphic need not learn which accounts and tokens exist.

**Why configuration is a system permission and not one of the bundle.** A bundle's
configuration holds its secrets, and saving it restarts the bundle's extension. Both are
decisions about the installation, not about the show: whoever may change the score should not
thereby be able to replace an API key or restart what is on air. A permission per bundle
would also have to be a name the server reserves inside every bundle's own list of
permissions, which bundles name freely. So it is the one system permission that was reserved
for this, `system:settings.manage`, which only `admin` holds by default. It is checked before
anything about the bundle is looked up: without it the answer is 403 for a bundle that exists
and for one that does not, so it tells nothing. Nothing else gives access to a configuration,
not even every permission of the bundle.

`system:settings.manage` includes restarting the extension of a bundle: saving its
configuration does that. It does not include enabling, disabling or reloading bundles.

Secrets (`"x-secret": true` in the config schema) are not shown to holders of
`system:settings.manage` either. They can be replaced or removed, never read back.

**When access changes.** HTTP requests see a change at once. An open socket whose user or
token lost or gained access is closed with code 4401; the SDK reconnects and gets what it may
have now. A change made with the `mooncg` command reaches open sockets within five seconds.

## Built-in roles

Created with the database. They cannot be deleted, and `admin` always holds `*`. Everything
else about them can be changed.

| Role       | System grants           | Meant for                                                |
| ---------- | ----------------------- | -------------------------------------------------------- |
| `admin`    | `*`                     | Whoever runs the installation                            |
| `operator` | `system:dashboard.view` | People who run the show from the dashboard               |
| `viewer`   | `system:dashboard.view` | People who watch the dashboard without changing it       |
| `graphics` | none                    | Accounts that only open graphics, such as a vision mixer |

What a role may do with a bundle comes from the bundle, see below. The server never runs
without an enabled user who holds `admin`: the last one cannot be deleted, disabled or have
the role removed.

## How a bundle declares permissions

```json
{
  "permissions": { "view": "See the scoreboard", "operate": "Change the score" },
  "defaultRoles": { "operator": ["view", "operate"], "viewer": ["view"], "graphics": ["view"] },
  "panels": [{ "id": "control", "file": "dashboard/control.html", "requires": "operate" }],
  "graphics": [{ "id": "overlay", "file": "graphics/overlay.html", "requires": "view" }],
  "replicants": { "score": { "read": "view", "write": "operate" } },
  "messages": { "reset": { "send": "operate", "listen": "view" } }
}
```

- `permissions` names what the bundle distinguishes, with a description for the dashboard.
  A name `operate` in the bundle `scoreboard` is the permission `bundle:scoreboard:operate`.
- `requires`, `read`, `write`, `send`, `listen` and a route's `permission` say what a resource
  needs. Leaving one out means "any permission of this bundle".
- `defaultRoles` says which built-in roles should hold which of the bundle's permissions. It
  is applied **once**, when the server sees the bundle for the first time, and that is
  recorded. After that the grants are an administrator's: a grant you removed does not come
  back at the next start, and a changed `defaultRoles` is not applied again. Roles other than
  the built-in ones are ignored; `admin` holds everything anyway.

## API tokens, and graphics in OBS

A token is a secret that starts with `mcg_`. It is shown once, when it is created, and stored
as a hash. A token has a name, a list of grants, an owner (the user who created it) and
optionally an expiry.

- A token can be given nothing its creator does not hold at that moment.
- Afterwards it holds a permission only while **both** its own grants and its owner's roles
  cover it. If the owner loses a permission, so does the token; if the owner gets it back, so
  does the token. If the owner is disabled the token stops working, and if the owner is deleted
  the token is deleted.

Send it as `Authorization: Bearer mcg_…`, over HTTP and when opening the WebSocket:

```sh
curl -H "Authorization: Bearer mcg_…" http://127.0.0.1:9090/b/scoreboard/api/score
```

A browser source cannot send a header. Put the token into the URL of the graphic instead:

```
http://127.0.0.1:9090/b/scoreboard/graphics/overlay.html?token=mcg_…
```

The server exchanges the token for an HttpOnly cookie (`mooncg_token`) and redirects to the
same URL without the token, so the page, its scripts and the address it reports never see it.
This works for every `GET` below `/b/`. The cookie is bound to the token: revoking the token
ends it, and closes the sockets opened with it. The cookie and its session last until the
token expires, at most 90 days; after that, loading the URL with the token issues a new one,
which is what OBS does whenever it loads the source. A request that is signed in already (a
session, a bearer token) is not exchanged: the parameter is only taken out of the URL, also
when the token in it is wrong. For a graphic, create a token with the
bundle's `view` permission and nothing else:

```sh
mooncg token create "OBS" --user ada --grant bundle:scoreboard:view
```

Tokens are replaced by `mcg_***` in everything the server logs and in every error message it
sends. The server does not log request URLs.

If a browser has both a user's session and a token cookie, the user's session wins. A request
that carries the same session or token cookie twice is treated as not signed in.

## Managing users, roles and tokens

All of it is JSON over HTTP. Errors are `{ "error": { "code", "message" } }`.

| Request                                           | Needs                  | Does                                            |
| ------------------------------------------------- | ---------------------- | ----------------------------------------------- |
| `POST /api/v1/auth/login` `{username, password}`  | nothing                | Signs in; sets the session cookie               |
| `GET /api/v1/auth/providers`                      | nothing                | The ways to sign in, `local` and external ones  |
| `POST /api/v1/auth/logout`                        | nothing                | Ends the session; clears the cookies            |
| `GET /api/v1/me`                                  | signed in              | `{ user, roles, permissions }`                  |
| `POST /api/v1/me/password` `{current, password}`  | a user's session       | Changes the own password                        |
| `POST /api/v1/setup` `{code, username, password}` | the setup code         | Creates the first admin; 404 once a user exists |
| `GET /api/v1/users`                               | `system:users.manage`  | Lists users                                     |
| `POST /api/v1/users` `{name, password, roles?}`   | `system:users.manage`  | Creates a user                                  |
| `PATCH /api/v1/users/:id` `{name?, disabled?}`    | `system:users.manage`  | Renames, disables or enables                    |
| `DELETE /api/v1/users/:id`                        | `system:users.manage`  | Deletes the user, their sessions and tokens     |
| `PUT /api/v1/users/:id/password` `{password}`     | `system:users.manage`  | Sets a new password                             |
| `PUT` / `DELETE /api/v1/users/:id/roles/:role`    | `system:users.manage`  | Assigns or removes a role                       |
| `GET /api/v1/roles`                               | `system:users.manage`  | Lists roles with their grants                   |
| `POST /api/v1/roles` `{name, grants?}`            | `system:users.manage`  | Creates a role                                  |
| `DELETE /api/v1/roles/:name`                      | `system:users.manage`  | Deletes a role that is not built in             |
| `POST /api/v1/roles/:name/grants` `{permission}`  | `system:users.manage`  | Adds a grant                                    |
| `DELETE /api/v1/roles/:name/grants/:permission`   | `system:users.manage`  | Removes a grant (URL-encode the permission)     |
| `GET /api/v1/tokens`                              | `system:tokens.manage` | Lists tokens, never their secrets               |
| `POST /api/v1/tokens` `{name, grants, expires?}`  | `system:tokens.manage` | Creates a token; the answer has `secret`, once  |
| `DELETE /api/v1/tokens/:id`                       | `system:tokens.manage` | Revokes a token                                 |

Linking external accounts (`/api/v1/identities`, `/api/v1/users/:id/identities/…`) is in
[external-logins.md](external-logins.md#the-api); modules (`/api/v1/modules`,
`/api/v1/permissions`) are in [modules.md](modules.md#the-api).

No answer ever contains a password or a hash. Status codes: 400 for unusable input, 401 when
not signed in, 403 without the permission or beyond what you hold, 404 for something that does
not exist, 409 for a taken name, a built-in role, the last admin, or a change to the user of
dev mode, 413 for a body over 16 KiB, 429 for a throttled login or password change.

The user that [dev mode](#dev-mode) created is listed with `"devMode": true`. It can be
deleted, and nothing else: renaming or disabling it, setting its password and assigning or
removing a role answer 409, and `mooncg user passwd` and `mooncg token create --user` refuse
it. A token for it can only be made in the dashboard while dev mode runs, and lasts until the
next start without dev mode.

Both password routes take `revokeTokens` (true or false). It deletes the API tokens the user
created. An admin's reset (`PUT /api/v1/users/:id/password`) and `mooncg user passwd` revoke
them by default, because a password is reset when someone else may know it and may have made
tokens with it; pass `revokeTokens: false` or `--keep-tokens` to keep them. A user's own change
(`POST /api/v1/me/password`) keeps them by default, because a routine change would otherwise
stop every graphic in OBS; pass `revokeTokens: true` after a leak.

The same from the command line, directly on a data directory:

```sh
mooncg user create <name> [--admin] [--role <role>]... [--password <password>]
mooncg user list
mooncg user passwd <name> [--password <password>]
mooncg token create <name> --user <owner> --grant <permission>... [--expires <date>]
mooncg token list
mooncg token revoke <id>
```

Each takes `--data-dir` (default `data`, or `MOONCG_DATA_DIR`). Without `--password` the
password comes from `MOONCG_PASSWORD` or is asked for. The commands work while a server runs on
the same directory: SQLite lets one process write at a time, the other waits up to five
seconds, and the server reads accounts for every request, so it acts on the change at once.

## Sessions, passwords and throttling

- **Passwords** are hashed with scrypt (N=16384, r=8, p=1), each with its own salt. The
  parameters are stored with the hash, so they can be raised later. The only rule is a
  minimum length of 8 characters.
- **Sessions** are a random 256-bit id in the cookie `mooncg_session` (HttpOnly,
  SameSite=Lax); the database has only its hash. A session ends after 7 days without use and
  at the latest 30 days after signing in. A page with an open socket counts as use. Signing
  out deletes it. Changing or resetting a password, disabling a user, and unlinking an
  external account of theirs, ends all of that user's sessions. A session opened by signing
  in with an external account is the same session, with the same cookie and the same ends.
- **Cookie names.** When the cookies are `Secure` (`--secure-cookies`, HTTPS behind a
  trusted proxy, or a request to an `https://`
  [public address](external-logins.md#the-public-address-and-the-redirect-address)) they are
  named `__Host-mooncg_session` and `__Host-mooncg_token`, which a browser only accepts over
  HTTPS and for this exact host. Over plain HTTP they keep the plain names, because a browser
  would refuse the prefix there.
- **Throttling.** Three limits, each answering 429 with `Retry-After`, also for the right
  password:
  - one user name from one address: 5 failed attempts, then refused for 5 seconds, doubling
    with each failure up to 15 minutes. This is what stops guessing;
  - one address, whatever the names: 20 failed attempts, then the same;
  - one user name from all addresses together: 100 failed attempts, then refused for 30
    seconds, at most 60. This is only a circuit breaker against guessing from many addresses
    at once. It is loose and short on purpose, so that someone who knows your name cannot
    lock you out of your own machine with a trickle of wrong passwords from elsewhere.

  An attempt counts when it arrives, not when its password has been checked, so a burst of
  simultaneous attempts is limited like a sequence. A successful login clears the count for
  that name at that address. Changing the own password with a wrong current password is
  limited the same way, 5 attempts per user. The counters are in memory, limited to 10,000
  entries each, and cleared by a restart; there is no command to unlock a name, because the
  command line tool cannot reach the server's memory. Unknown user names are counted, and
  answered, exactly like known ones.
- **Behind a reverse proxy without `--trust-proxy`** every client has the proxy's address, so
  the per-address limit applies to all of them together. Use `--trust-proxy` there.
- **Load.** At most 4 passwords are checked at a time and 32 more may wait; beyond that a
  login answers 429. A user name that cannot be one (other characters, over 64 long) and a
  password over 1024 characters are answered like a wrong password without being looked up,
  stored or hashed. The account routes read at most 16 KiB of body.

## Request forgery

A page of another site must not be able to act through your browser.

1. A request that changes something (anything but `GET` and `HEAD`) is refused if its `Origin`
   is not the server's own or an `--allowed-origin`. This includes the login.
2. If such a request is authenticated by a **cookie**, it must also carry JSON
   (`Content-Type: application/json`) or the header `X-MoonCG-CSRF` with any value. A form on
   another site can send neither. This applies to your bundle's own routes as well: send JSON,
   or add the header to `fetch`. An asset upload is the file itself and so never JSON: it
   needs the header, and so does the upload of a bundle's ZIP archive.
3. Requests with a bearer token are exempt from the second rule: a browser never attaches a
   token by itself.
4. The sign-in of [dev mode](#dev-mode) counts as a cookie for the second rule: it needs no
   credentials at all, so a request that changes something must still prove it was meant.
5. One request changes something without either: `GET /auth/<provider>/callback`, where an
   external provider sends the browser back to. It opens a session, and it cannot carry JSON
   or a header, because it is the provider that sends the browser there. What stands in is
   `state`: a random value the server handed to this browser, which the browser shows it holds
   by a cookie, and which works once. See
   [external-logins.md](external-logins.md#what-is-checked).

Routes of [modules](modules.md#http-routes) (`/m/<module>/…`) fall under rules 1 to 3 like
every other, also those a module declared public.

## Listening beyond this machine

By default the server listens on `127.0.0.1`. To reach it from other machines:

```sh
node packages/server/dist/main.js --host 0.0.0.0
```

The server speaks plain HTTP. On a network you do not fully trust, put a reverse proxy with
HTTPS in front of it and start with `--secure-cookies --trust-proxy`:

| Flag               | Effect                                                                                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--secure-cookies` | Marks the cookies `Secure`, so browsers send them over HTTPS only                                                                                                 |
| `--trust-proxy`    | Believes `X-Forwarded-Proto` (cookies become `Secure` on HTTPS requests) and the last entry of `X-Forwarded-For` (the address login attempts are counted against) |

Without `--trust-proxy` those headers are ignored, because anyone can send them. The proxy must
pass `Host` and `Origin` through unchanged, or add its public origin with `--allowed-origin`.
The origin check compares scheme, host and port. The server takes its own scheme for `http`
unless a trusted proxy says `X-Forwarded-Proto: https`, or the request is addressed to a
public address (`--public-url`) that is `https://`. So behind an HTTPS proxy without
`--trust-proxy` and without such a public address, a page's `https://…` origin does not match
and its requests are refused.

The three settings agree on one answer per request, used for the cookies, for the origin
check and for the WebSocket alike:

| Setting                  | A request counts as HTTPS when             | Cookies are `Secure` |
| ------------------------ | ------------------------------------------ | -------------------- |
| `--trust-proxy`          | The proxy says `X-Forwarded-Proto: https`  | On those requests    |
| `--public-url https://…` | Its `Host` is that of the public address   | On those requests    |
| `--secure-cookies`       | It does not say; one of the two above does | On every request     |

A public address says nothing about where a request came from: `--trust-proxy` is still what
makes the server count login attempts per client and not per proxy.

## Dev mode

`mooncg dev` (the server's `--dev`) is for writing bundles on your own machine. It signs in
every request from this machine that brings no credentials as an administrator, **without a
password**. That is the only way past signing in that MoonCG has, and it is fenced in:

| Rule                                                  | Why                                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| Only the flag `--dev` turns it on                     | No environment variable or file can leave it on by accident                     |
| The host must be `localhost`, `127.x.x.x` or `::1`    | Otherwise the server refuses to start. So it does with `--trust-proxy`          |
| Every allowed origin must be on this machine          | Otherwise the server refuses to start: allowed is not to mean signed in         |
| The connection must come from this machine            | The address of the socket itself; no header is believed about it                |
| No `Forwarded`, `Via`, `X-Forwarded-*` or `X-Real-IP` | Behind a proxy on this machine everyone would come from loopback                |
| The `Host` header must name this machine              | A site whose name was pointed at `127.0.0.1` (DNS rebinding) sends its own name |
| No `Origin`, or one on this machine                   | A page of another site in a browser here connects from loopback too             |
| No credentials at all in the request                  | A session that ended or a token that was revoked is refused, not replaced       |
| The origin and forgery checks apply as ever           | A page of another site still cannot change anything or open a socket            |
| A warning in the log at every start                   | Nobody runs it without being told                                               |

It never acts as a real person. It acts as a user of its own, `dev`, which it creates with the
role `admin`, without a password and marked as created by dev mode. Whoever brings a session
or a token acts as themselves; whoever brings one that is not accepted gets `401`.

Outside dev mode that user is inert: it cannot sign in, its sessions and tokens are deleted at
the next start without `--dev` and not accepted, no token can be created for it, and it counts
neither as a user nor as an administrator, so an installation that was only ever used in dev
mode still gets its [setup](#first-start). It cannot be renamed, disabled, given a password,
other roles or a link to an external account, only deleted, and shows as `dev mode only` on the Users page and in
`mooncg user list`.

What it cannot protect against is the machine itself: every program and every person that can
connect to loopback there is an administrator while it runs. That includes whatever a reverse
proxy or a tunnel on this machine passes on (nginx, ngrok, a forwarded port): everyone who
reaches it is an administrator, and MoonCG cannot tell. `mooncg start` has none of this.
[development.md](development.md#dev-mode) has the rest, with `dev.url`.

## Response headers

Every answer carries `X-Content-Type-Options: nosniff` and `Referrer-Policy: same-origin`.

The server's own pages (`/`, `/login`, `/setup`) are sent with `X-Frame-Options: DENY` and
the policy below. The login page keeps it also with external providers on it: their buttons
are links, not forms, nothing is loaded from a provider, and their icons are files of this
server (`/auth/<provider>/icon`, sent with the policy of uploaded assets).

```
Content-Security-Policy: default-src 'self'; style-src 'self';
  img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self';
  frame-ancestors 'none'
```

None of these pages has a style written into it: their styles are files of this server.

They load only what this server serves, cannot be framed, and post forms only back here.
Styles written into the page are allowed because these pages carry their styles inline.

A bundle's files are sent with `Content-Security-Policy: frame-ancestors 'self'` and
`X-Frame-Options: SAMEORIGIN`: the dashboard frames panels, no other site can frame a panel or a
graphic. OBS loads a graphic as a page of its own, which this does not affect. Bundle content
gets no further policy; what a bundle's pages load is up to the bundle. Answers of bundle
routes get only the two headers above, and the handler may set its own.

Uploaded assets are not bundle content: users put them there, and users are not trusted the
way an installed bundle is. A file under `/b/<bundle>/assets/` is sent with

```
Content-Security-Policy: sandbox; default-src 'none'; img-src 'self' data:;
  media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'
```

and with a content type from a fixed list that has no page, script or style sheet on it;
anything else is `application/octet-stream` with `Content-Disposition: attachment`. `sandbox`
gives a document opened from such a file no origin and no scripts, so an uploaded HTML page or
SVG cannot act as this server towards whoever opens it. [dashboard.md](dashboard.md#assets)
has the details.
When the server listens on anything but loopback without `--secure-cookies`, it logs a warning,
and another for a public address (`--public-url`) that is plain `http://` and not this machine.

## Extensions

Messages carry who sent them:

```js
await ctx.handle('reset', async (data, { sender }) => {
  // sender = { principal: 'user:…', kind: 'user' | 'token' | 'extension', bundle: 'scoreboard' }
  if (!(await ctx.permissions.check(sender, 'operate'))) {
    throw new MoonCGError('forbidden', 'Only operators may reset');
  }
});
```

`ctx.permissions.check(sender, name)` asks the server whether that sender holds the permission
`name` of the extension's own bundle right now. The manifest's `send` and `listen` already
guard a message; `check` is for decisions inside a handler, such as an action only some
senders may trigger.

An extension reaching into **another** bundle needs the capability (`bundle:<name>:read` or
`write`) and nothing else: it is not checked against the other bundle's user permissions.
Installed bundles are trusted code, and `check` answers yes for a sender of kind `extension`.

Bundle HTTP routes are checked before the handler runs. The handler does not get the caller's
`Authorization`, `Proxy-Authorization` and `Cookie` headers or a `token` query parameter. It gets `request.sender`,
in the same form as a message's sender, so `ctx.permissions.check(request.sender, 'operate')`
works in a route as well.
