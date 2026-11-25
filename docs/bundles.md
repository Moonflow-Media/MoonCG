# Installing, updating and removing bundles

A running server can take a new bundle, replace one with a newer version and remove one, without
a restart. Every bundle is fetched and checked in a staging folder first; nothing of it runs and
nothing installed changes until someone has seen what it declares and said yes. An update keeps
the version it replaces and puts it back by itself if the new one does not start.

Installed bundles are trusted code: an extension runs on the server with the rights of the
server. So all of this takes the permission `system:bundles.manage`, and holding it means being
trusted with the machine. See [Who may do this](#who-may-do-this).

## Quick path

From the command line, against a running server:

```sh
export MOONCG_TOKEN=mcg_…            # an API token that holds system:bundles.manage
mooncg bundle install https://example.org/owner/scoreboard.git --ref v1.2.0
mooncg bundle list
mooncg bundle update scoreboard       # fetches again from where it came from
mooncg bundle remove scoreboard
```

`install` and `update` print what the bundle declares and ask before they go on; `--yes` skips
the question. Each command exits with a status other than 0 when it did not do what was asked.

From the dashboard: the bundle page has an **Install bundle** form below the list (a Git address
or a ZIP upload), shows each fetched bundle with **Install** and **Discard**, and has **Update**
and **Remove** on every row. See [docs/dashboard.md](dashboard.md#bundles).

## The steps

| Step    | What happens                                                                                     | What changes                    |
| ------- | ------------------------------------------------------------------------------------------------ | ------------------------------- |
| Stage   | The source is fetched into `<data-dir>/staging/<id>/` and its manifest is checked                | Nothing that is installed       |
| Decide  | The server tells what the bundle declares; you commit or discard                                 | Nothing                         |
| Commit  | npm dependencies are installed in staging, the folder is moved into `bundles/<name>/`, it starts | The bundle is there and running |
| Discard | The staging folder is deleted                                                                    | Nothing                         |

A staged bundle nobody decides about is deleted after 30 minutes.

**Across a restart** a staged bundle that is still within its 30 minutes is kept, with the
trust it was fetched with (`scripts`) and for the update it was fetched for. Beside its files
the staging folder holds a note, `staged.json`, of how it was fetched: the source, who, when,
the trust and the target. Nothing in it says what the files hold. At the start the bundle is
read from its files and checked again exactly as when it was fetched (the manifest, the
MoonCG and the bundles it needs, npm and what would steer it, the size limits), and its
summary is made anew from that, so what is shown is what is on disk now. Of the note only the
fields of a source, each within a length limit, are taken; a note that says it was written
later than now is not believed, and none is kept longer than 30 minutes from when it says the
bundle was fetched, whatever time it gives. A bundle that no longer passes, whose note is
missing or does not fit its folder, whose time is up, whose target was removed meanwhile, or
that is one more than may wait staged (five) is deleted, and the log says why, one line for
each. Everything else in the staging folder (what an interrupted fetch or removal left) is
deleted at the start as well. The modules' staging folder is still emptied at every start.

The trust in the note (`"trusted": true`) is believed as it is: whoever can write to the data
folder can mark a staged bundle as trusted, so that installing it runs its install scripts.
That is no new way in: whoever can write there can change the database and every installed
bundle as well. Keep the data folder for the server's account alone.

What is shown before the decision, from the manifest and the files:

- name, version, title, and for an update the version it replaces
- where it came from, with the commit for a Git source
- whether it brings an extension, that is: code that runs on the server
- whether installing it, before it is ever started, can run code (see
  [npm dependencies](#npm-dependencies))
- the permissions it declares, with their descriptions
- the role grants it proposes (`defaultRoles`), and whether they will be made: they are only
  the first time a bundle of that name is installed
- its capabilities (what the extension may reach beyond its own bundle)
- the bundles it needs, and the MoonCG it asks for
- its npm packages, and whether they will be installed
- how many panels, dialogs, graphics and asset categories it has, and whether it has settings
- how many files and bytes it is

A bundle is refused at the stage step, with the reason, when

- it has no usable `mooncg.json`, or its `name` is not a bundle name, or it is a module,
- its name is one Windows reserves for a device (`con`, `nul`, `aux`, `prn`, `com0`–`com9`,
  `lpt0`–`lpt9`), on every system, so that a bundle that installs on one machine installs on
  all,
- a text of its manifest that is shown to people holds control characters or is longer, or a
  list in it has more entries, than any bundle needs (a title up to 200 characters, 500
  permissions, panels, dialogs or graphics, and so on),
- it would make npm do more than fetch packages from the registry, and was not fetched as
  trusted (see [npm dependencies](#npm-dependencies)),
- `engine.mooncg` does not allow this MoonCG (`engine.mooncg: needs MoonCG >=1.0.0, but this is 0.13.0`),
- a bundle it depends on is not installed or has the wrong version, or it would close a
  dependency cycle,
- a bundle of that name is installed already (install), or its name is not the name of the
  bundle it is meant to update (update),
- an installed bundle depends on it with a range the new version does not satisfy (update).

## Sources

| Source        | Given as                                                                      | Where from                                                                                   |
| ------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Git           | `https://…`, `ssh://…` or `user@host:path`                                    | Dashboard, command line, API                                                                 |
| ZIP, uploaded | A file sent to the server                                                     | Dashboard, command line (a local file is uploaded), API                                      |
| ZIP, by path  | An absolute path on the server's machine                                      | API only                                                                                     |
| Folder        | An absolute path on the server's machine                                      | Command line (a folder is read by the server under the same path) and API; not the dashboard |
| ZIP, by URL   | An `https://` address (not this machine, no internal address) and its SHA-256 | API; and from a registry index through the catalog and `mooncg bundle install <name>`        |

A registry index names one of these per version: a ZIP by URL, or a Git repository pinned to a
commit. Installing from the **Catalog** (or by name on the command line) goes through every
step and check of this page; the summary also says which index listed it and that MoonCG does
not check what an index lists. See [registry.md](registry.md).

### ZIP by URL

- Downloaded over `https://` only (plain `http://` only from this machine), with at most five
  redirects, each checked again, within the install timeout, and no larger than an archive may
  be, counted while it arrives.
- Its SHA-256 must be the one given; an archive that differs is deleted before it is opened.
  Then it is unpacked with every check of an uploaded ZIP.
- Credentials in the address are sent to that origin only and never shown or logged.

### Git

- One commit is fetched (`--depth=1`): the given branch, tag or commit, or the default branch.
  The commit that was checked out is recorded and shown. `.git` is removed.
- Only the three forms above are accepted. An address that starts with `-`, `file://`,
  `http://`, `git://`, `ext::` and every other transport is refused before Git is started, and
  Git itself is told `GIT_ALLOW_PROTOCOL=https:ssh`, whatever a redirect says.
- Git is started directly, with the address behind `--`. No shell is involved.
- The Git configuration of the machine and of the server's account still applies where it
  says how to reach a host: credential helpers, SSH settings, TLS settings and
  `url.*.insteadOf` rewrites, so an address can be rewritten by what an administrator of the
  machine configured; where a rewrite leads is checked like the address itself (see below).
  Nothing of it that would run a program applies: hooks (`core.hooksPath`), the file system
  monitor and filters are switched off for every call. No proxy applies (see below).
- Git is started without the variables of the server's environment that would undo that:
  proxies (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`, in any case), configuration
  passed through the environment (`GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_*`,
  `GIT_CONFIG_VALUE_*`, `GIT_CONFIG_PARAMETERS`), `GIT_SSL_NO_VERIFY`, `GIT_PROXY_COMMAND`,
  another repository or work tree (`GIT_DIR`, `GIT_WORK_TREE` and the like) and traces
  (`GIT_TRACE*`, `GIT_CURL_VERBOSE`), which would print headers with credentials.
  `GIT_SSH_COMMAND` stays the administrator's, as before; without one, SSH runs in batch mode.
- No filter runs, whatever `.gitattributes` asks for. Files are checked out as they were
  committed; a file kept in Git LFS comes out as its small pointer file. A bundle that needs
  its LFS files is better installed from a ZIP archive.
- While Git fetches, the folder is measured every second, and a fetch that outgrows twice the
  size limit of a bundle is ended.
- Nobody is ever asked for a password (`GIT_TERMINAL_PROMPT=0`, SSH in batch mode). A private
  repository needs credentials the server's account already has: an SSH key, a credential
  helper, or a token in the address (`https://user:token@host/…`).
- Submodules are not fetched. Symbolic links in the repository are checked out as plain files.
- Git must be installed on the server. Without it the answer says so; a ZIP still works.

Where Git may connect is held to the rules of the registry (see
[registry.md](registry.md#indexes-and-sources-on-a-private-network)), for a repository given
directly and for one an index lists, for bundles and modules alike:

- An IP address written in the address is checked before anything starts: never a private,
  shared, link-local, unique-local or reserved address, unless the configuration allows its
  private network (`registryAllowPrivate`), and never this machine, except for a repository an
  index on this machine lists. A repository on this machine is therefore refused when given
  directly; install from its folder instead.
- A host name is resolved by the server before git runs, and every address it resolves to must
  be allowed by the same rules.
- For `https://`, git is then pinned to those addresses with
  `-c http.curloptResolve=<host>:<port>:<addresses>`, so that it does not resolve the name a
  second time (no DNS rebinding between the check and the connection), and it follows no
  redirect (`-c http.followRedirects=false`), since a redirect would lead to a host that was
  not checked. `-c http.curloptResolve=` (empty) comes first, so that no pin of the machine's
  configuration for the same host applies. A repository that moved must be given by its new
  address: git's answer is then "the repository answered with a redirect (HTTP 301); give its
  new address". Git for Windows with `http.sslBackend=openssl` (the default of its installer)
  refuses that backend once a pin is set and names the one its libcurl has (Schannel); when
  git itself says so (its own `fatal:` or `error:` line, not a `remote:` line of the server)
  and the fetch failed, it is run again, still pinned, with that backend, and so with the
  certificate store of Windows. See
  [registry.md](registry.md#indexes-and-sources-on-a-private-network) for what that means for
  a private certificate authority.
- `http.curloptResolve` needs Git 2.37 or newer, and an older Git ignores it without a word.
  So the server asks `git --version` once, and refuses an `https://` source with an older Git
  (or one that does not say its version): "Update Git on the server, or install the bundle
  from a ZIP archive". `ssh://` and `user@host:path` work with any Git.
- `url.*.insteadOf` rewrites of the machine's configuration: before fetching, the server asks
  git what it makes of the address (`git ls-remote --get-url`, in the new, empty repository,
  so that it reads what the fetch reads). Where a rewrite leads is checked like the address:
  it must be one of the accepted forms, and its host must be allowed; then it is what git is
  pinned to.
- **SSH** (`ssh://`, `user@host:path`) resolves names itself and cannot be pinned this way: the
  name is checked, but between that check and the connection of ssh its address could change.
  Use `https://` where that matters.
- **Proxies are not supported for Git.** A proxy would resolve the name and connect in its own
  right, and the pin would not apply. So git gets `-c http.proxy=` and none of the proxy
  variables of the environment, and an address for which the machine's Git configuration
  names a proxy of its own (`http.<url>.proxy`) is refused. A server that can reach a Git host
  through a proxy only cannot fetch from it; install the bundle from a ZIP archive instead.
  Indexes and archives never used a proxy either: the server connects to them directly.

### ZIP

An archive is checked completely before a single file is written, and what is really unpacked is
counted again while writing, because an archive can lie about its sizes. It is refused when

- an entry would land outside the folder (`..`, an absolute path, a drive letter, a backslash),
- an entry is a symbolic link, a device or encrypted,
- a name is reserved on Windows (`CON`, `NUL`, `COM1` …), ends with a dot or a space, or has a
  character Windows does not allow,
- a file comes twice, also when only the case differs, or is a file and a folder at once,
- it is larger, has more entries, unpacks to more bytes or is compressed more than allowed.

An archive with everything inside one folder, as a download of a repository is, is unwrapped.

### Folder

A folder is copied. It must be a folder of a local disk: a network path (`\\server\share`) is
refused, and a path to a file is too, with the hint to give it as an archive. It may not be
inside the bundles folder or the data folder, nor contain them, however the path is written. A link inside the folder is followed only while it stays inside; one that leads out of it
is refused. `.git` at the top is left behind.

The server reads the folder, so the path is one of the server's machine, and whoever may manage
bundles can point it at any folder the server's account can read.

## Limits

| Limit                                     | Default    | Flag                          |
| ----------------------------------------- | ---------- | ----------------------------- |
| Size of a ZIP archive                     | 100 MiB    | `--bundle-max-archive-bytes`  |
| Size of a bundle once unpacked            | 500 MiB    | `--bundle-max-unpacked-bytes` |
| Files and folders in a bundle             | 50 000     | `--bundle-max-files`          |
| Compression ratio of an archive           | 100 to 1   | fixed; applies above 1 MiB    |
| Time for Git, and for npm                 | 5 minutes  | `--bundle-install-timeout-ms` |
| An upload that sends nothing              | 30 seconds | fixed                         |
| Bundles being fetched at the same time    | 2          | fixed                         |
| Bundles fetched or waiting for a decision | 5          | fixed                         |
| A staged bundle waiting for a decision    | 30 minutes | fixed                         |
| Earlier versions kept per bundle          | 3          | `--bundle-backups-kept`       |

Each flag has an environment variable, such as `MOONCG_BUNDLE_BACKUPS_KEPT`. The size and file
limits hold for every source, and are checked again after npm installed packages. A request
beyond the two limits on fetching is answered `409` with the reason. When Git or npm run out
of time, the program and everything it started are ended.

## npm dependencies

A bundle with a `package.json` that lists `dependencies` and no `node_modules` gets them
installed at commit, in staging, before anything installed is touched:

| Lockfile                                     | Command                                   |
| -------------------------------------------- | ----------------------------------------- |
| `package-lock.json` or `npm-shrinkwrap.json` | `npm ci --omit=dev --ignore-scripts`      |
| none                                         | `npm install --omit=dev --ignore-scripts` |

### What can run code while a bundle is installed

Fetching packages from the registry runs nothing. Three things can, and none of them is allowed
unless someone says so for that one bundle:

| What                                                                                                                                                                                           | Why it runs code                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Install scripts of the packages                                                                                                                                                                | They are programs of whoever published a package                     |
| A `.npmrc` or `.yarnrc` at the top of the bundle                                                                                                                                               | It can tell npm which program to run as Git, and where to fetch from |
| A dependency that is no version of a registry package: a Git address, a URL, `file:`, `link:`, `owner/repo`, an alias for one of those, or a lockfile entry that resolves outside the registry | npm runs Git for it, or builds the package                           |

A bundle with the second or third is **refused when it is fetched**, with what was found. To
install it, fetch it as trusted: `--scripts` on the command line, the checkbox in the dashboard's
form, or `"scripts": true` in the stage request. The summary then says "runs code while it is
installed: yes" with the reasons, and the server log records who allowed it. A bundle that was
fetched as trusted is installed with install scripts on. For a bundle that only needs install
scripts, `"scripts": true` at commit is enough.

The line "runs code while it is installed" in the summary is `no` only when none of the three
applies.

### How npm is run

- npm is the one that came with the Node.js the server runs on, started without a shell. If
  there is none, bring `node_modules` in the bundle.
- npm reads no configuration but the server's: its user and global configuration are empty
  files in `<data-dir>/npm/`, its cache is there too, every `npm_config_*` setting is taken out
  of the environment, and the program it runs as Git is plain `git`. So a private registry is
  not picked up from anybody's `.npmrc`. Name it with `--bundle-npm-registry https://…`
  (`MOONCG_BUNDLE_NPM_REGISTRY`), or fetch the bundle as trusted so that its own `.npmrc`
  counts. A registry that needs a token needs the second.
- After npm ran, the bundle is measured again against the limits, and its manifest must still
  be the one that was shown; otherwise nothing is installed.
- What npm prints goes to the server log under `[npm:<bundle>]`, with credentials in addresses
  taken out.
- If npm fails, nothing is installed and the staged bundle stays for another try.
- A bundle that brings its `node_modules` is taken as it is, and npm is not run for it.

## Updating, and rolling back

An update is a staged bundle with the name of an installed one. On commit:

1. npm dependencies of the new version are installed, in staging.
2. The bundle is stopped, and so are the running bundles that depend on it.
3. The installed version moves to `<data-dir>/backups/<name>/<version>-<time>/`.
4. The new version moves into `bundles/<name>/` and is started.
5. The bundles that depend on it are started again.

If the new version cannot be put in place or does not reach `running`, the server takes it out
again, moves the backup back and starts that. The job ends as `rolled-back` with the reason, and
the installation is as it was. If the old version cannot be brought back either, the job ends as
`failed` with both reasons and the bundle is `failed`; the backup is still in the backups folder.

A disabled bundle is swapped and stays disabled. Nothing is started, so nothing can show that it
should be rolled back.

Where no backups are kept (`--bundle-backups-kept 0`) the replaced version is still held
until the new one runs, so the rollback works, and is deleted then.

`mooncg bundle update <name>` without a source fetches from where the bundle came from: the same
repository and ref, the same folder, the same archive path. A bundle that was uploaded, or put
into the bundles folder by hand, needs the source named.

### What is kept

| What                                    | Where                           | Update | Remove             | Remove with purge |
| --------------------------------------- | ------------------------------- | ------ | ------------------ | ----------------- |
| The bundle's settings                   | `<data-dir>/config/<name>.json` | kept   | kept               | deleted           |
| Uploaded assets                         | `<data-dir>/assets/<name>/`     | kept   | kept               | deleted           |
| Persistent replicants                   | `<data-dir>/mooncg.db`          | kept   | kept               | deleted           |
| The bundle's files                      | `bundles/<name>/`               | backup | backup, or deleted | as without purge  |
| Role grants of the bundle's permissions | `<data-dir>/mooncg.db`          | kept   | kept               | deleted           |
| API tokens that name the bundle         | `<data-dir>/mooncg.db`          | kept   | kept               | kept              |
| Whether the bundle is disabled          | `<data-dir>/mooncg.db`          | kept   | forgotten          | forgotten         |

### When the new version's schemas do not fit what is stored

| Stored value                                  | What happens                                                                                                                                             |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A persistent replicant its new schema rejects | The bundle starts with the replicant's `default`; the log has a warning with the reason. The stored value is replaced when the replicant is next written |
| Settings the new config schema rejects        | The bundle does not start, so the update is rolled back, with the reasons in the job                                                                     |

For an update that changes the config schema in a way the stored settings do not fit: disable
the bundle, update it (it is swapped without being started), correct the settings on the
settings page, which now draws the new form, and enable it.

`defaultRoles` of a bundle are turned into grants the first time a bundle of that name is seen.
An update or a later re-installation does not change grants: a role an administrator took a
permission from keeps it taken. The summary of a fetched bundle says which grants it proposes
and whether they will be made. Removing a bundle with `--purge-data` takes its grants out of
every role and forgets that the name was seen, so the next installation starts over.

### Backups

The newest three earlier versions of each bundle are kept; older ones are deleted after an
update or a removal. `mooncg bundle backups <name>` lists them, and `mooncg bundle restore <name>
<backup>` puts one back: the installed version becomes a backup in turn and comes back if the
restored one does not start. The backup of a removed bundle is installed again by `restore`.
`GET /api/v1/bundles/-/backups` lists the backups of every bundle at once, with whether a bundle
of that name is installed: the only list that still names a removed bundle. The dashboard's
**Backups** card shows it.
A restore is checked like an update: the MoonCG the backup asks for, the bundles it needs, and
the installed bundles that need it; a backup that a running bundle could not use is refused and
nothing is stopped. A backup folder that an interrupted update left without a bundle in it is
no backup: it does not count, and is deleted at the next start or update.

## Removing

`mooncg bundle remove <name>` stops the bundle and moves its folder to the backups. Its
settings, assets and replicants stay, so a later installation picks them up again. Where no
backups are kept (`--bundle-backups-kept 0`) the files are deleted, and the question before the
removal says so.

| Flag             | In the API            | Effect                                                              |
| ---------------- | --------------------- | ------------------------------------------------------------------- |
| `--delete-files` | `"deleteFiles": true` | Deletes the bundle's files instead of keeping them as a backup      |
| `--purge-data`   | `"purgeData": true`   | Deletes its settings, assets, persistent replicants and role grants |
| `--force`        | `"force": true`       | Removes it although enabled bundles depend on it; those are stopped |

If the data cannot be purged, the bundle is removed all the same and the job ends as `failed`
with the reason, so that it can be seen and the purge done by hand.

A bundle that an enabled bundle depends on is not removed without `--force`. That is all
`--force` and `"force"` do: they do not remove a bundle while the installation is on air, which
takes `--on-air` or `"forceOnAir": true` (see below), and a removal that both stand in the way
of takes both. The dashboard's **Remove** offers the same choices: deleting the files and
purging the data are boxes in its confirmation, and removing a bundle that others need is a
question of its own (see [dashboard.md](dashboard.md#installing-updating-and-removing)).

## Who may do this

Everything on this page takes `system:bundles.manage`. Without it the API answers 403 (401 when
not signed in), the dashboard shows none of the controls, and the replicant `system:installs` is
not readable. The server log records who staged, installed, updated, removed or restored what,
and who allowed install scripts:

```
INFO  [bundles] ada staged scoreboard 1.2.0 from Git repository https://***@example.org/o/scoreboard.git at v1.2.0 (staging 4f0c…)
INFO  [bundles] ada updated scoreboard from 1.1.0 to 1.2.0
```

Credentials in a Git address are taken out of everything that is shown or logged. They are
stored, with the rest of the address, in `<data-dir>/bundle-sources.json` (for modules,
`module-sources.json`), which is what lets an update fetch again. The file is written
readable by the server's account only (mode 0600) where the system has such modes; on
Windows the access list of the data folder is what protects it.

An update or removal goes through the same lock as enable, disable and reload, so none of them
can cross another for the same bundle.

**On Air.** While the installation is on air (the switch in the dashboard's sidebar, or
`PUT /api/v1/on-air`), remove and restore are refused with `409` before anything is stopped,
and so are disable and reload. An update can still be **fetched**: staging and uploading
interrupt nothing. Putting it in place, the commit, is what is refused, with a message that
says the new version stays staged. `"forceOnAir": true` in the request, `--on-air` on the
command line and a second question in the dashboard let one change through. That is its own
word: `"force"` and `--force` are about a bundle that others still need, and override no
lock. Installing a new bundle and enabling one are not held. See
[development.md](development.md#the-on-air-lock).

**The file watcher.** With `--watch` or in dev mode the server watches every bundle folder.
It lets go of a folder before an update, a restore or a removal moves it, and watches the new
one afterwards: a watched folder cannot be renamed on Windows.

## The command line

```
mooncg bundle list
mooncg bundle install <git-url|zip|folder> [--ref <branch|tag|commit>] [--scripts] [--yes]
mooncg bundle update <name> [<git-url|zip|folder>] [--ref <ref>] [--scripts] [--yes] [--on-air]
mooncg bundle remove <name> [--force] [--delete-files] [--purge-data] [--yes] [--on-air]
mooncg bundle enable <name>
mooncg bundle disable|reload <name> [--on-air]
mooncg bundle backups <name>
mooncg bundle restore <name> <backup> [--yes] [--on-air]
mooncg bundle create <name> [--template html|vue] [--dir <bundles folder>] [--config <file>]
```

`--on-air` on `update`, `remove`, `disable`, `reload` and `restore` goes ahead although the
installation is on air. Without it, `update` asks the server first and stops before anything
is fetched, saying why and naming the flag. `--force` exists on `remove` only, for a bundle
that enabled bundles still need. `bundle create` is the odd one out: it writes a new bundle from a
template into the bundles folder and talks to no server; see
[development.md](development.md#the-command-line).

| Option    | Environment    | Default                 | Meaning                                         |
| --------- | -------------- | ----------------------- | ----------------------------------------------- |
| `--url`   | `MOONCG_URL`   | `http://127.0.0.1:9090` | Where the server listens                        |
| `--token` | `MOONCG_TOKEN` | none                    | An API token that holds `system:bundles.manage` |

The token is sent in the `Authorization` header and never printed. Prefer `MOONCG_TOKEN` over
`--token`: an argument shows in the process list and the shell history. Over plain `http://`
the token is sent only to this machine (`localhost`, `127.0.0.1`, `::1`); for another host the
command stops and asks for `https://`, or for `--insecure` if the network is yours, and then
warns. A user name or password in `--url` is not sent and not shown. What the server answers is
printed without control characters. Create a token with
`mooncg token create deploy --user ada --grant system:bundles.manage`.

A ZIP file is uploaded, so the command line may run on another machine than the server. A
folder is not: its path is handed to the server, which reads it.

Without a terminal there is nobody to ask, so `install`, `update`, `remove` and `restore` need
`--yes` in a script.

## The API

Requests that take time answer `202` with `{ "job": … }`. A job has an `id`, an `operation`
(`stage`, `install`, `update`, `restore`, `remove`), a `state` (`queued`, `running`,
`succeeded`, `failed`, `rolled-back`), the `step` it is at, and when it is over an `error` and a
`rollbackError` where there is one. A `stage` job that succeeded carries `staged`, the summary
with the `id` to commit or discard.

| Request                                            | Body                                                        | Answer                                          |
| -------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------- |
| `POST /api/v1/bundles/-/stage`                     | `{ "source": …, "target"?, "scripts"? }`                    | 202, a job; 409 while too much is being fetched |
| `PUT /api/v1/bundles/-/stage?filename=…&target=…`  | The ZIP archive, as it is                                   | 202, a job                                      |
| `GET /api/v1/bundles/-/staged`                     |                                                             | `{ staged: […] }`                               |
| `POST /api/v1/bundles/-/staged/<id>/commit`        | `{ "scripts"?: true, "forceOnAir"?: true }`                 | 202, a job                                      |
| `DELETE /api/v1/bundles/-/staged/<id>`             |                                                             | 204                                             |
| `GET /api/v1/bundles/-/jobs`, `…/jobs/<id>`        |                                                             | The latest 20 jobs; one job                     |
| `POST /api/v1/bundles/<name>/update`               | `{ "source"?: … }`                                          | 202, a `stage` job                              |
| `POST /api/v1/bundles/<name>/remove`               | `{ "force"?, "forceOnAir"?, "deleteFiles"?, "purgeData"? }` | 202, a job                                      |
| `GET /api/v1/bundles/<name>/backups`               |                                                             | `{ backups: […] }`                              |
| `GET /api/v1/bundles/-/backups`                    |                                                             | `{ bundles: [{ name, installed, backups }] }`   |
| `POST /api/v1/bundles/<name>/backups/<id>/restore` | `{ "forceOnAir"?: true }`                                   | 202, a job                                      |

A `source` is `{ "type": "git", "url": …, "ref"?: … }`, `{ "type": "path", "path": … }`,
`{ "type": "zip", "path": … }` or `{ "type": "url", "url": "https://…", "sha256": … }`. To stage
an entry of a registry index, see [`POST /api/v1/registry/stage`](registry.md#the-api); a source
taken from an index carries `catalog` (`index`, `indexUrl`, `kind`, `name`, `version`). `target` names the installed bundle the staged one is to
update. `"scripts": true` in a stage or update request (`?scripts=true` for the upload) fetches
the bundle as trusted to run code while it is installed. The dash in the path is not the name of a bundle, so no bundle can be in its way.

The upload is the one request without JSON. Sent with a session cookie it needs the header
`X-MoonCG-CSRF`, like an asset upload; with a token in the `Authorization` header it does not.

The replicant `system:installs` holds `{ jobs, staged }` and changes with every step, which is
how the dashboard follows an installation without asking. `GET /api/v1/bundles` names the
`source` of each bundle, and `backupsKept`, to whoever may manage bundles.

No answer and no job names a folder of the server. A failure of the disk (full, read-only, not
permitted) is answered as the server's problem, `internal`, not as a fault of the archive.

## Checklist for a show machine

- [ ] The token for deployments holds `system:bundles.manage` and nothing else, and has an expiry
- [ ] `--bundle-backups-kept` is what you want to be able to go back to
- [ ] Bundles pin their npm packages with a `package-lock.json`, so `npm ci` installs the same every time
- [ ] No installation relies on `--scripts` unless you know which package needs it and why
- [ ] The data folder is backed up; it holds the settings, the assets and the earlier versions
- [ ] The server was started with `mooncg start`, not `mooncg dev`, and On Air is switched on for the show
