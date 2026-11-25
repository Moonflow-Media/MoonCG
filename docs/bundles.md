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

A staged bundle nobody decides about is deleted after 30 minutes, and the staging folder is
emptied whenever the server starts.

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
- `engine.mooncg` does not allow this MoonCG (`engine.mooncg: needs MoonCG >=1.0.0, but this is 0.7.0`),
- a bundle it depends on is not installed or has the wrong version, or it would close a
  dependency cycle,
- a bundle of that name is installed already (install), or its name is not the name of the
  bundle it is meant to update (update),
- an installed bundle depends on it with a range the new version does not satisfy (update).

## Sources

| Source        | Given as                                   | Where from                                                                                   |
| ------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Git           | `https://…`, `ssh://…` or `user@host:path` | Dashboard, command line, API                                                                 |
| ZIP, uploaded | A file sent to the server                  | Dashboard, command line (a local file is uploaded), API                                      |
| ZIP, by path  | An absolute path on the server's machine   | API only                                                                                     |
| Folder        | An absolute path on the server's machine   | Command line (a folder is read by the server under the same path) and API; not the dashboard |

### Git

- One commit is fetched (`--depth=1`): the given branch, tag or commit, or the default branch.
  The commit that was checked out is recorded and shown. `.git` is removed.
- Only the three forms above are accepted. An address that starts with `-`, `file://`,
  `http://`, `git://`, `ext::` and every other transport is refused before Git is started, and
  Git itself is told `GIT_ALLOW_PROTOCOL=https:ssh`, whatever a redirect says.
- Git is started directly, with the address behind `--`. No shell is involved.
- The Git configuration of the machine and of the server's account still applies where it
  says how to reach a host: credential helpers, SSH settings and `url.*.insteadOf` rewrites,
  so an address can be rewritten by what an administrator of the machine configured. Nothing
  of it that would run a program applies: hooks (`core.hooksPath`), the file system monitor
  and filters are switched off for every call.
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

The server fetches from whatever host is named, also one only it can reach. Whoever may manage
bundles can therefore make the server talk to hosts of its network.

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

A bundle that an enabled bundle depends on is not removed without `--force`. The dashboard's
**Remove** keeps files and data; the flags are for the command line and the API.

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
stored, with the rest of the address, in `<data-dir>/bundle-sources.json`, which is what lets
an update fetch again.

An update or removal goes through the same lock as enable, disable and reload, so none of them
can cross another for the same bundle. A lock for bundles that are on air is planned; update and
remove will refuse while it holds.

## The command line

```
mooncg bundle list
mooncg bundle install <git-url|zip|folder> [--ref <branch|tag|commit>] [--scripts] [--yes]
mooncg bundle update <name> [<git-url|zip|folder>] [--ref <ref>] [--scripts] [--yes]
mooncg bundle remove <name> [--force] [--delete-files] [--purge-data] [--yes]
mooncg bundle enable|disable|reload <name>
mooncg bundle backups <name>
mooncg bundle restore <name> <backup> [--yes]
```

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

| Request                                            | Body                                         | Answer                                          |
| -------------------------------------------------- | -------------------------------------------- | ----------------------------------------------- |
| `POST /api/v1/bundles/-/stage`                     | `{ "source": …, "target"?, "scripts"? }`     | 202, a job; 409 while too much is being fetched |
| `PUT /api/v1/bundles/-/stage?filename=…&target=…`  | The ZIP archive, as it is                    | 202, a job                                      |
| `GET /api/v1/bundles/-/staged`                     |                                              | `{ staged: […] }`                               |
| `POST /api/v1/bundles/-/staged/<id>/commit`        | `{ "scripts"?: true }`                       | 202, a job                                      |
| `DELETE /api/v1/bundles/-/staged/<id>`             |                                              | 204                                             |
| `GET /api/v1/bundles/-/jobs`, `…/jobs/<id>`        |                                              | The latest 20 jobs; one job                     |
| `POST /api/v1/bundles/<name>/update`               | `{ "source"?: … }`                           | 202, a `stage` job                              |
| `POST /api/v1/bundles/<name>/remove`               | `{ "force"?, "deleteFiles"?, "purgeData"? }` | 202, a job                                      |
| `GET /api/v1/bundles/<name>/backups`               |                                              | `{ backups: […] }`                              |
| `POST /api/v1/bundles/<name>/backups/<id>/restore` | `{}`                                         | 202, a job                                      |

A `source` is `{ "type": "git", "url": …, "ref"?: … }`, `{ "type": "path", "path": … }` or
`{ "type": "zip", "path": … }`. `target` names the installed bundle the staged one is to
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
