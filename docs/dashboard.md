# The dashboard

The dashboard is the page at `/`: a Vue application the server serves once you are signed in.
It is built from `packages/dashboard` and talks to the server only through what bundles and
scripts can use as well, the REST API under `/api/v1` and the SDK client.

- [What is there today](#what-is-there-today)
- [Pages](#pages)
- [Workspaces and layout](#workspaces-and-layout)
- [Graphics and their instances](#graphics-and-their-instances)
- [Dialogs](#dialogs)
- [Bundle settings](#bundle-settings)
- [Assets](#assets)
- [How it is built and served](#how-it-is-built-and-served)
- [Preferences API](#preferences-api)
- [Testing](#testing)

## What is there today

| Feature                                                   | State                                |
| --------------------------------------------------------- | ------------------------------------ |
| Navigation that shows only what you may use, in groups    | Done                                 |
| Counts in the navigation, state of the connection         | Done                                 |
| Workspaces with panels, layout stored per user            | Done; arranged with buttons, no drag |
| Bundle page: state, errors, enable, disable, reload, live | Done; filter by state, key figures   |
| Installing, updating and removing bundles                 | Done; from a Git address or a ZIP    |
| Graphics page: URL, connected instances, reload of one    | Done; no preview of a graphic        |
| Graphics that take a single instance                      | Done; enforced by the server         |
| Dialogs opened by panels                                  | Done; one dialog at a time           |
| Bundle settings: a form from the bundle's config schema   | Done                                 |
| Assets: upload, list, delete, live list for graphics      | Done                                 |
| Users, roles and tokens pages                             | Done                                 |
| Log page with level filter, followed while open           | Done                                 |

## Pages

| Path                           | Shows                                        | Needs                    |
| ------------------------------ | -------------------------------------------- | ------------------------ |
| `/`                            | The first workspace                          | `system:dashboard.view`  |
| `/w/<workspace>`               | The panels of that workspace                 | `system:dashboard.view`  |
| `/bundles`                     | Bundles with state and errors; installing    | `system:dashboard.view`  |
| `/graphics`                    | Graphics with their URLs and connected pages | `system:dashboard.view`  |
| `/assets`                      | The asset categories of each bundle          | `system:dashboard.view`  |
| `/settings`                    | A form for each bundle that has a config     | `system:settings.manage` |
| `/admin/users`, `/admin/roles` | Users and roles                              | `system:users.manage`    |
| `/admin/tokens`                | API tokens                                   | `system:tokens.manage`   |
| `/logs`                        | The latest lines of the server log           | `system:logs.view`       |

The navigation leaves out what you may not use, and pages draw no button the server would
refuse. That is a convenience only: every request is checked by the server, whatever the
dashboard shows. Each list comes from the server already filtered, so a bundle you hold no
permission of does not appear anywhere.

The bundle list is loaded again whenever the replicant `system:revision` moves, so a bundle
that fails or is reloaded shows without reloading the page.

### The frame around the pages

A sidebar holds the navigation, and below it how the connection stands and who is signed in.
Under 900 pixels of width it lies above the page instead of beside it.

| Group      | Entries              | Count beside an entry                                     |
| ---------- | -------------------- | --------------------------------------------------------- |
| Workspaces | Each workspace       | Its panels                                                |
| Show       | Bundles              | Bundles that failed                                       |
|            | Graphics             | Graphics that are open somewhere right now                |
|            | Assets               | none                                                      |
| Admin      | Users, Roles, Tokens | none                                                      |
| System     | Settings             | none                                                      |
|            | Logs                 | Warnings and errors logged since you last opened the page |

A group none of whose entries you may open is left out with its label. A count that is zero
is not shown.

- **Graphics** counts from the replicants `<bundle>:$instances.<graphic>`, the same the
  graphics page follows.
- **Logs** is counted only for holders of `system:logs.view`: the dashboard then asks
  `GET /api/v1/logs` every two seconds, as the log page does, and nobody else asks at all.
  Up to when you have seen the log is kept in the browser (`localStorage`, under your user
  id), as the time of the newest line that was on the log page while you had it open. It is
  per browser: another browser counts from what the server still has.
- **The connection** is the status of the dashboard's SDK client (`live`, `reconnecting`,
  `offline`; see the [README](../README.md#using-replicants-in-a-page)), shown as "Live",
  "Reconnecting…" and "Offline" with the host the page was loaded from.

The mark beside the name is a placeholder (`packages/server/public/logo-mark.svg`); MoonCG has
no logo yet. It is built into `/ui/` like the scripts and styles.

### Bundles

The bundle page starts with four key figures (running, failed, disabled, and the graphics
running bundles serve) and a filter by state. The first three figures are buttons that set
the filter and, pressed again, let go of it. A bundle on its way between states (`enabling`,
`disabling`, `installed`) is drawn amber and shows under "All" only.

A row tells what `GET /api/v1/bundles` tells: for a running bundle how many panels and
graphics it has for you, and for every bundle the bundles it needs (`dependencies`, the names
from its manifest, without those you are not shown). What a bundle that does not run would
bring is not in the list, so the page does not claim it.

#### Installing, updating and removing

For holders of `system:bundles.manage` the page has more; nobody else is shown any of it, and
their browser does not follow the replicant it comes from. [bundles.md](bundles.md) says what
the server does at each step.

| Where               | What                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------- |
| A row               | The version, and where the bundle was installed from (`from <address> at <ref> (<commit>)`) |
| A row               | **Update** turns the form below into the update of that bundle; **Remove** asks first       |
| **Install bundle**  | A Git address with an optional branch, tag or commit, or a ZIP upload                       |
| **Update `<name>`** | The same form, plus **Fetch from …** for a bundle whose source can be fetched again         |
| A fetched bundle    | A card with what it declares, and **Install** (or **Update**) and **Discard**               |
| Below the form      | What is being done right now, by anyone, and how what this page started ended               |

1. **Fetch.** The form sends the address or the archive. The bundle is fetched and checked on
   the server; the page shows the step it is at.
2. **Read.** The card lists the source, whether the bundle brings server code, its permissions,
   capabilities, the bundles and the MoonCG it needs, its npm packages, what it provides and
   its size. An update says which version it replaces. Nothing is installed yet.
3. **Decide.** **Install** puts it in place and starts it; **Discard** deletes it. A bundle with
   npm packages has a checkbox to let their install scripts run, off unless ticked.

The form has a checkbox, off for every fetch, to trust the bundle to run code while it is
installed. Without it a bundle that brings an `.npmrc` or npm packages from elsewhere than the
registry is refused when it is fetched. The card says under "Runs code on install" what applies,
and under "Role grants" which grants the bundle proposes and whether they will be made.

An update that does not start is rolled back by the server; the page then says so, with the
reason, and the row keeps showing the earlier version as running. **Remove** stops the bundle
and moves its files to the backups; its settings, assets and stored values are kept. Deleting
the files, purging the data and installing from a folder of the server are for the command
line and the API. While something is being done to a bundle, the buttons of its row are held.

The progress comes from the replicant `system:installs` (`{ jobs, staged }`), which the server
changes with every step, so a second administrator sees the same staged bundle and the same
job. How a job ended is shown only to the page that started it.

## Workspaces and layout

A panel names its workspace in the manifest (`"workspace": "Show"`); panels that name none are
in the workspace `Main`. A workspace shows each of its panels in an iframe loaded from the
panel's own URL, so a panel is the same page inside and outside the dashboard.

Panels sit in a grid of 12 columns. Each panel has buttons to move it one place towards the
start or the end and to make it wider, narrower, taller or shorter (1 to 12 columns, 1 to 6
rows of 140 pixels). A panel starts as wide as its manifest `width`. Moving a panel reloads
its iframe.

The layout is stored on the server per user and workspace, under the preference
`layout.<workspace>`, and is the same in every browser you sign in from. Panels that were added
since are appended; panels that are gone are dropped.

A panel of your layout that is missing because its bundle does not run is named in a line
below the grid: `"playlist" is hidden: the bundle sponsor-loop is disabled.` The panel is
named by its id, since the server lists no panels, and so no titles, of a bundle that does
not run. The line comes from the stored layout and from what was on the page: once a layout
is saved without the panel, the line is there until the page is loaded again.

The grid is deliberately small and written for this dashboard: order plus width and height,
changed with buttons that work with a keyboard. Dragging is not there yet.

## Graphics and their instances

The graphics page lists every graphic you may open, with its URL and a button that copies it
(and says "Copied" once the browser has taken it), and below each the pages that show it
right now. A graphic that is open somewhere is marked "On air".

The page draws no preview. A page that loads a graphic through the SDK is an instance of it,
so a preview would be listed as one and, for a graphic that takes a single instance, would
take the place from what is on air. Nothing in the dashboard connects as a graphic.

**How the server knows.** A page under `/b/<bundle>/graphics/` that uses the SDK says in its
`hello` which graphic it is. The server keeps the connected pages of each graphic in the
read-only replicant `<bundle>:$instances.<graphic id>`:

```json
[{ "id": "9f0c…", "since": "2026-01-02T03:04:05.000Z" }]
```

It takes the permission the graphic itself takes. It says that a page is connected, not whose:
who each page acts as is told by `GET /api/v1/bundles/<bundle>/instances` to holders of
`system:bundles.manage` only, and the graphics page shows it to them. A page that does not use
the SDK is not listed.

**One instance.** A graphic with `"singleInstance": true` in the manifest is shown by one page
at a time.

| A second page opens the graphic      | What happens                                                               |
| ------------------------------------ | -------------------------------------------------------------------------- |
| As another user or token             | It is refused (`conflict`). The first page stays                           |
| As the same user or token            | It gets the place. The page before is told so and stops                    |
| An operator disconnects the instance | The place is free. The page is told so and stops                           |
| The page that holds the place closes | The place is free; a page that was refused takes it within three seconds   |
| Its machine vanishes without closing | The server notices within about 45 seconds and frees the place (see below) |

A page that was **refused** loads nothing, covers itself with a notice that the graphic is
open elsewhere, and asks again every three seconds. A page that was **replaced or
disconnected** shows a notice and does not come back by itself: two pages of one account
would otherwise take the place from each other for ever. Reload it to ask again. Both can be
handled by the page itself:

```js
createClient({
  onDuplicate: (duplicate) => document.body.classList.toggle('standby', duplicate),
  onEnded: (reason) => console.log(reason), // 'replaced' or 'disconnected'
});
```

Why the same account replaces itself: a browser source that is reloaded in OBS is the same
token coming again, sometimes before the server has noticed that the old connection is dead.
It must not be locked out by its own ghost. Someone else never pushes a page off air.

**Dead connections.** The server pings every socket every 15 seconds and drops one that
leaves two pings in a row unanswered. Browsers answer by themselves. So a machine that lost
power or its network holds nothing for longer than that.

**Reload and disconnect.** For one connected page, by its `id`:

| Request                                                   | Does                                                  |
| --------------------------------------------------------- | ----------------------------------------------------- |
| `POST /api/v1/bundles/<bundle>/instances/<id>/reload`     | Tells the page to load itself again                   |
| `POST /api/v1/bundles/<bundle>/instances/<id>/disconnect` | Takes the page off its graphic; it does not come back |
| `GET /api/v1/bundles/<bundle>/instances`                  | Lists the connected pages with who each acts as       |

All three interrupt or reveal what is on air, so they take `system:bundles.manage` besides
the permission of the graphic. The graphics page has a button for each of the first two.

## Dialogs

A dialog is a page of a bundle that the dashboard shows over everything when a panel asks for
it, and that hands a result back to the panel.

```json
"dialogs": [
  { "id": "confirm-reset", "title": "Reset the score?", "file": "dashboard/confirm-reset.html",
    "width": 4, "requires": "operate" }
]
```

In the panel:

```js
const confirmed = await mc.dialogs.open('confirm-reset', { home: 2, away: 1 });
```

In the dialog page:

```js
const dialog = await createClient().dialogs.current();
// dialog.id, dialog.data
dialog.close(true); // what `open` resolves with in the panel
```

| What happens                                       | `open` in the panel             |
| -------------------------------------------------- | ------------------------------- |
| The dialog page calls `close(result)`              | resolves with `result`          |
| The user closes the dialog (the × or Escape)       | resolves with `null`            |
| No such dialog, or one the user may not open       | rejects with `not_found`        |
| Another dialog is open                             | rejects with `conflict`         |
| The page is not shown inside the dashboard         | rejects with `unavailable`      |
| The panel is reloaded or leaves the page meanwhile | the dialog closes; nobody waits |

`width` is in dashboard columns of 100 pixels (1 to 12, default 3). Data and result are JSON.

**How it travels, and what is checked.** Panel, dashboard and dialog page are three windows of
one origin that talk through `postMessage`. Every message has a fixed shape and is checked
before it is believed:

| Check, by the dashboard                                            | Why                                          |
| ------------------------------------------------------------------ | -------------------------------------------- |
| `event.origin` is the dashboard's own                              | No other site takes part                     |
| `event.source` is the window of a panel frame the dashboard drew   | Only panels open dialogs, and which bundle's |
| The dialog is one of that panel's bundle, and one the user may use | A panel cannot open another bundle's dialog  |
| `close` comes from the window of the dialog's own frame            | Nothing else on the page can answer for it   |

Panel and dialog page in turn believe only their parent window at their own origin, and all
messages are posted to that origin, never to `*`. The dialog file is served under the same
rules as a panel: its `requires`, or any permission of the bundle without one.

## Bundle settings

A bundle that names a JSON Schema in its manifest gets a form on the settings page:

```json
"config": { "schema": "schemas/config.json" }
```

The values are kept in `<data-dir>/config/<bundle>.json`, outside the bundle. The extension
receives them as `ctx.config`, with the defaults of the schema filled in; see
[extensions.md](extensions.md#configuration).

| Request                                            | Does                                                          |
| -------------------------------------------------- | ------------------------------------------------------------- |
| `GET /api/v1/config`                               | Lists the bundles that have a config schema                   |
| `GET /api/v1/bundles/<bundle>/config`              | `{ schema, values, secretFields, secrets, problems, bundle }` |
| `PUT /api/v1/bundles/<bundle>/config` `{ values }` | Checks, stores, restarts the extension; answers like `GET`    |

All three take `system:settings.manage`, whatever else the caller holds of the bundle; why is
in [permissions.md](permissions.md#bundle-settings-assets-dialogs-and-instances).

**Validation.** The values are checked against the schema with Ajv when the bundle starts and
before every write. A write that does not fit answers 400 with the reasons and changes
nothing. A stored file that does not fit (edited by hand, or after the schema changed) keeps
that bundle from starting: it is `failed` with an error such as `config: /maxScore: must be
<= 999`, the server and the other bundles keep running, and the settings page still shows the
form with what is wrong. Saving values that fit starts the bundle.

**Saving restarts the extension, and only the extension.** The replicants and messages the
manifest declares stay, so graphics on air keep running. Whoever holds
`system:settings.manage` can therefore restart the extension of every bundle that has a
config.

The answer to a `PUT` says whether the extension now runs with what was stored. Once the
values are stored the answer is 200, whatever became of the restart:

| `restarted` | `restartNote`                                  | When                                                   |
| ----------- | ---------------------------------------------- | ------------------------------------------------------ |
| `true`      | none                                           | The extension was started again                        |
| `false`     | `The bundle is disabled. The settings apply …` | The bundle was not running                             |
| `false`     | `The bundle has no extension …`                | There is nothing to restart                            |
| `false`     | the error                                      | The extension did not start; the bundle is `failed`    |
| `false`     | the reason                                     | The bundle changed state while the write was under way |

The settings page shows the note. The file is written to a temporary
file first and renamed into place, so it is complete or unchanged.

**Secrets.** A property with `"x-secret": true` in the schema is write-only:

| Rule                                             | Detail                                                                                  |
| ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| It is never sent back                            | `values` leaves it out; `secrets` lists the ones that are set                           |
| Leaving it out of a `PUT` keeps the stored value | So the form can be saved without retyping it                                            |
| `null` removes it                                | The form has a box for that                                                             |
| It is in no log line and no error                | The server replaces it by `***` wherever it would show, if it has at least 8 characters |
| The extension gets it                            | In `ctx.config`, and nowhere else                                                       |

The last-but-one rule covers what the extension does with it as well: a secret in a line the
extension logs, or in the error it fails with, is replaced before the line is printed, kept
for the log page or published as the bundle's error. It does not cover what an extension
writes into a replicant or answers from a route; that is the extension's own decision.

A secret shorter than 8 characters is stored and handed to the extension like any other,
but not searched for in logs and errors: it would turn up inside ordinary words. The server
logs a warning, once and without the value, that such a secret cannot be masked. The server
keeps in mind what is stored now and what was stored before the last change, because a
running extension may still hold the earlier value; older values are forgotten.

`x-secret` belongs on a named property. A `$ref` is followed wherever it stands, as long as
it points into the same schema by path (`#/$defs/key`). A schema with any other reference
(`$anchor` names, `$dynamicRef`, another file or URL) is refused, and the bundle does not
start: a secret could sit behind it unseen. Where a secret sits behind something no property name
leads through, such as the items of a list, the whole property is treated as secret.

**The form.** One field per property:

| Schema                              | Field                                     |
| ----------------------------------- | ----------------------------------------- |
| `type: string`                      | Text                                      |
| `type: number`, `integer`           | Text that must be a number                |
| `type: boolean`                     | Checkbox                                  |
| `enum`                              | Choice                                    |
| `type: object` with `properties`    | A group of fields                         |
| `type: array` of strings or numbers | Text area, one entry per line             |
| `x-secret`                          | Password field, always empty; says if set |
| Anything else                       | Text area that takes JSON                 |

`title` and `description` label a field, `default` fills it until a value is stored, and
`required` marks it. An empty field is left out of what is stored, with one exception: a text
field that is required or has a default is stored as empty text, because leaving it out
would be refused or bring the default back. What is stored under keys the form does not draw
(a schema that allows additional properties) is sent back unchanged, so saving loses nothing.

## Assets

Assets are files people upload for a bundle while the server runs: logos, pictures, sounds. A
bundle declares categories:

```json
"assets": [
  { "id": "logos", "title": "Team logos", "accept": ["image/*"], "read": "view", "write": "operate" }
]
```

| Field    | Meaning                                                                                                                             |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `accept` | Extensions (`.png`) and media types (`image/*`), as in HTML. Without it, or with `*/*`, any file. An empty list is a manifest error |
| `read`   | Permission to list and load the files. Without it, any permission of the bundle                                                     |
| `write`  | Permission to upload and delete. Without it, `system:bundles.manage`                                                                |

The files are in `<data-dir>/assets/<bundle>/<category>/`.

| Request                                                    | Needs   | Does                                                      |
| ---------------------------------------------------------- | ------- | --------------------------------------------------------- |
| `GET /api/v1/bundles/<bundle>/assets/<category>`           | `read`  | `{ files, used, limits }`                                 |
| `PUT /api/v1/bundles/<bundle>/assets/<category>/<name>`    | `write` | Stores the request body as that file; 201 with `{ file }` |
| `DELETE /api/v1/bundles/<bundle>/assets/<category>/<name>` | `write` | Deletes the file; 204                                     |
| `GET /b/<bundle>/assets/<category>/<name>`                 | `read`  | The file                                                  |

An upload is the file itself as the body of the request, not a form:

```sh
curl -X PUT -H "Authorization: Bearer mcg_…" --data-binary @home.png \
  http://127.0.0.1:9090/api/v1/bundles/scoreboard/assets/logos/home.png
```

From a page signed in by cookie, add the header `X-MoonCG-CSRF`: an upload is not JSON, and a
request that changes something needs one of the two.

**For graphics.** The list of each category is the read-only replicant
`<bundle>:$assets.<category>`, an array of `{ name, size, modified, url }`. A graphic that
subscribes to it follows uploads and deletions without reloading:

```js
mc.replicant('$assets.logos').subscribe((files) => {
  const home = files.find((file) => file.name.startsWith('home.'));
  logo.src = home ? `${home.url}?v=${encodeURIComponent(home.modified)}` : '';
});
```

**What an upload is checked against.**

| Guard           | Rule                                                                                        | Answer when broken |
| --------------- | ------------------------------------------------------------------------------------------- | ------------------ |
| Size of a file  | At most `--asset-max-file-bytes` (50 MiB). Counted as it arrives, whatever the request says | 413                |
| Quota           | A category holds at most `--asset-quota-bytes` (500 MiB); a replaced file is not counted    | 413                |
| Number of files | A category holds at most `--asset-max-files` (1000); replacing a file adds none             | 413                |
| Pace            | An upload that sends nothing for 30 seconds is given up                                     | 408                |
| Kind of file    | The category's `accept`, judged by the file name, never by the `Content-Type` of the upload | 415                |
| Name            | No `/`, `\` or NUL, no short name of Windows (`LONGFI~1.PNG`), at most 150 characters       | 400                |
| Permission      | `read` and `write` of the category                                                          | 403, or 404        |

A name is also cleaned, and the answer says what it became: characters Windows forbids
(`< > : " | ? *`) and control characters become `_`, dots and spaces come off both ends, and a
device name of Windows (`CON`, `NUL`, `COM1`, …) gets a `_` in front. Names that differ only
in case are one file, kept under the spelling of the last upload. A file arrives complete or
not at all: it is received in `<data-dir>/assets/.incoming/` and moved into place once every
limit was kept. Receiving holds nothing up, so a slow upload does not block the others; only
the moment of putting a file in place is taken in turn, and that is where quota and count are
decided. What interrupted uploads left in `.incoming` is removed when the server starts. If
the file cannot be put in place the answer is 500, and nothing about the upload is kept.

**How a file is served.** An uploaded file must never act as a page of this server towards
whoever opens it.

| Header                    | Value                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `Content-Type`            | From a fixed list by extension: images, fonts, sound, video, JSON, text, CSV                                             |
| otherwise                 | `application/octet-stream` with `Content-Disposition: attachment`                                                        |
| `X-Content-Type-Options`  | `nosniff`                                                                                                                |
| `Content-Security-Policy` | `sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'` |

A file can be asked for in parts (`Range: bytes=…`, answered with 206, or 416 for a range
outside the file), which players need to seek and loop a clip. The length that is announced
is that of the file that was opened, also if the name gets a new file meanwhile.

So an uploaded `.html` or `.js` is a download, never a page or a script, and an SVG is an
image that a graphic can show but that runs nothing when opened on its own: `sandbox` gives
the document no origin and no scripts.

## How it is built and served

`pnpm build` runs `vite build` in `packages/dashboard` and writes `dist/index.html` and the
scripts and styles under `dist/ui/`. The server answers every dashboard route with that one
page and serves the files below `/ui/`:

| Request      | Answer                                                                       |
| ------------ | ---------------------------------------------------------------------------- |
| a page above | `index.html`; 302 to `/login` when not signed in; 403 without the permission |
| `/ui/<file>` | the built file, to anyone who is signed in                                   |

If the dashboard has not been built, the pages answer 404 and say to run `pnpm build`.

The page is sent with the same strict headers as the login page: scripts and styles only from
this server, no framing. The build emits no inline script and no inline style, and no
component binds a `style`, so the Content-Security-Policy allows styles from files of this
server only (`style-src 'self'`): a style written into a page is refused.

The styles are two files: `packages/server/public/tokens.css` with the design tokens as custom
properties (colours, type, spacing, the width of the sidebar), loaded first, and
`packages/dashboard/src/style.css` with the rules. Both use the fonts of the system and load
nothing from another host. Transitions take their time from two tokens that are zero for
whoever asked the system for reduced motion.

### The sign-in and setup pages

`/login` and `/setup` are plain pages of the server (`packages/server/public`), drawn like the
dashboard: a card in the middle of the page with the mark, the name and the form. They are
for visitors who are not signed in, so they cannot load anything below `/ui/`. The server
serves them exactly three more files, to anyone:

| Request          | Is                                                            |
| ---------------- | ------------------------------------------------------------- |
| `/tokens.css`    | The design tokens. The dashboard is built from this very file |
| `/auth.css`      | The rules of the two pages                                    |
| `/logo-mark.svg` | The mark. The dashboard is built from this very file as well  |

There is one copy of the tokens and of the mark, in `packages/server/public`, because the
server ships them as they are; the dashboard imports them from there when it is built. The
pages carry no inline style and no inline script, and are sent with the same
Content-Security-Policy as the dashboard. What they do is unchanged: `auth.js` posts the form and
shows the message the server answers with.

The components are written in TypeScript with render functions, not as `.vue` files, so the
whole package is checked by the same `tsc` as everything else.

## Preferences API

Small values a user keeps on the server. They belong to a signed-in user; a token has none.

| Request                                    | Does                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------- |
| `GET /api/v1/me/prefs/<key>`               | `{ "value": … }`; `null` if nothing is stored; 404 for a key that cannot be one |
| `PUT /api/v1/me/prefs/<key>` `{ "value" }` | Stores any JSON value; answers 204                                              |

A key has 1 to 64 lowercase letters, digits, dots, dashes or underscores. A request body is at
most 16 KiB (413 beyond), and a user keeps at most 50 keys (409 beyond). Preferences are
deleted with the user.

## Testing

| Command         | What runs                                                                         |
| --------------- | --------------------------------------------------------------------------------- |
| `pnpm test`     | Unit tests, among them the dashboard's logic, stores and pages in a simulated DOM |
| `pnpm test:e2e` | Builds, then runs the smoke test in Chromium with Playwright                      |

The browser tests (`e2e/dashboard.spec.ts`) start the built server once, on a free port with
a temporary data directory and a temporary copy of the `examples` bundles, so that a bundle
installed by a test never lands in the repository. Each test brings about what it needs
itself, so one that fails does not hide the others:

1. Setup, a refused and an accepted sign-in (both pages drawn from their stylesheets, with
   the mark), the scoreboard panel, the graphic, a layout seen from a second browser, the
   bundle page and the log page.
2. The single-instance graphic: another user is refused, the same account replaces its own
   page, the waiting page takes over, and the graphics page reloads and disconnects it.
3. The reset dialog: cancelled, confirmed, and closed when its panel reloads.
4. The settings form: saved, seen by the extension, refused when invalid; the secret is in no
   answer and no socket frame the dashboard, the graphic or a viewer's browser received.
5. A logo uploaded, shown by the graphic, deleted; a file of the wrong kind refused; an SVG
   with a script that does not run; a part of a file by `Range`.
6. The frame: the groups of the navigation for an administrator and for a viewer, the
   counts, the connection, the mark, every page opened without a refused request or a
   complaint on the console, and the navigation above the page on a narrow screen.
7. The filter and key figures of the bundle page, "Copied", the keyboard (arrow keys in a
   filter, a visible focus, Escape in a dialog), the dimmed tools of a panel, reduced motion.
8. A viewer who gets none of the above.
9. A bundle installed from a ZIP upload (the summary first, then running, its panel in the
   workspace), updated to a new version, updated to one whose extension fails (rolled back,
   the earlier version still running and serving), and removed after the question; a viewer
   sees none of the controls and is refused by every request of the installation API.

It needs Chromium once: `pnpm exec playwright install chromium`.

`pnpm screenshots` builds and then writes a picture of every page (1440 pixels wide, some at
800, setup and sign-in with and without an error at both, the dialog, and the focus ring in
three places) to `screenshots/` at the root of the repository (ignored by git), or to the
directory given to `node e2e/screenshots.mjs <directory>`. It is for looking at a change of
layout or styles and is not part of `pnpm test:e2e`. It takes the pictures twice: with the
`examples` as they are, and (`-states` in the name) with a bundle that failed and one that is
disabled beside them.
