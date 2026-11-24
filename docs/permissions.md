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

## First start

While no user exists, the server prints a setup URL when it starts:

```
INFO  No user exists yet. Create the first administrator at http://127.0.0.1:9090/setup?code=…
```

Open it, choose a user name and a password, and sign in. The code is random, lives in the
server's memory only and changes with every start. Once any user exists, `/setup` and
`POST /api/v1/setup` answer 404, and no other route creates a user without signing in.

You can also create the first user from the command line, before or while the server runs:

```sh
mooncg user create ada --admin --data-dir data
```

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

| Permission               | Allows                                                                    |
| ------------------------ | ------------------------------------------------------------------------- |
| `system:dashboard.view`  | The dashboard page, the bundle list, the replicant `system:revision`      |
| `system:bundles.manage`  | Enabling, disabling and reloading bundles; the replicant `system:bundles` |
| `system:users.manage`    | Users, roles and grants, within what the holder holds (see below)         |
| `system:tokens.manage`   | Creating, listing and revoking API tokens                                 |
| `system:settings.manage` | Reading and changing the configuration of bundles; the settings page      |
| `system:logs.view`       | The log page and `GET /api/v1/logs`                                       |

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
- rename, disable, delete or reset the password of a user only if they hold everything that
  user holds.

Anything else is refused with 403. Holders of `*` are not limited by this. The `mooncg`
command works on the data directory directly and is not limited either: whoever can run it
there can read and write the database anyway.

**What you are shown.** `GET /api/v1/bundles` lists only the bundles you hold a permission of
(all of them if you may manage bundles), and of each only the panels, dialogs and graphics you
may open and the asset categories you may read, each with whether you may change it.
The replicant `system:bundles`, which has the state of every bundle, needs
`system:bundles.manage`. Everyone with the dashboard can follow `system:revision`, a counter
that moves when a bundle changes, and ask for the list again.

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

No answer ever contains a password or a hash. Status codes: 400 for unusable input, 401 when
not signed in, 403 without the permission or beyond what you hold, 404 for something that does
not exist, 409 for a taken name, a built-in role, or the last admin, 413 for a body over
16 KiB, 429 for a throttled login or password change.

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
  out deletes it. Changing or resetting a password, and disabling a user, ends all of that
  user's sessions.
- **Cookie names.** When the cookies are `Secure` (`--secure-cookies`, or HTTPS behind a
  trusted proxy) they are named `__Host-mooncg_session` and `__Host-mooncg_token`, which a
  browser only accepts over HTTPS and for this exact host. Over plain HTTP they keep the plain
  names, because a browser would refuse the prefix there.
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
   needs the header.
3. Requests with a bearer token are exempt from the second rule: a browser never attaches a
   token by itself.

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
unless a trusted proxy says `X-Forwarded-Proto: https`, so behind an HTTPS proxy without
`--trust-proxy` a page's `https://…` origin does not match and its requests are refused.

## Response headers

Every answer carries `X-Content-Type-Options: nosniff` and `Referrer-Policy: same-origin`.

The server's own pages (`/`, `/login`, `/setup`) are sent with `X-Frame-Options: DENY` and

```
Content-Security-Policy: default-src 'self'; style-src 'self' 'unsafe-inline';
  img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self';
  frame-ancestors 'none'
```

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
When the server listens on anything but loopback without `--secure-cookies`, it logs a warning.

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
`Authorization` and `Cookie` headers or a `token` query parameter. It gets `request.sender`,
in the same form as a message's sender, so `ctx.permissions.check(request.sender, 'operate')`
works in a route as well.
