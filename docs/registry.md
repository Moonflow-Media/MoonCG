# Registry indexes and the catalog

A registry index is a static JSON file that lists bundles and modules: what each is, which
versions there are, and where each version is fetched from. MoonCG reads any number of
indexes and shows what they list in the **Catalog** of the dashboard (`/bundles/catalog`), in
`mooncg registry search` and `info`, and as **Update available** where something installed
from an index has a newer version there.

An index is a list that anyone can publish. MoonCG does not review, sign or scan what it
lists. Adding an index means trusting its author as much as the code it points to.

## Quick path

```sh
# Add an index, with a token that holds system:settings.manage and system:bundles.manage:
mooncg registry add https://example.org/mooncg/index.json

mooncg registry search score          # what the indexes list
mooncg registry info scoreboard       # one entry: versions, compatibility, where from
mooncg bundle install scoreboard      # fetch, show, ask, install (--version 0.1.0 for one)
mooncg bundle outdated                # what has a newer version in its index
mooncg bundle update scoreboard       # takes the newer version from the index
```

In the dashboard: **Bundles → Catalog**, add the address under **Indexes**, then
**Install** on an entry. The bundle is fetched and checked as with any other source. Its
summary on the Bundles page says which index listed it, and nothing is installed until you
press **Install** there.

## The index format

```json
{
  "$schema": "https://example.org/registry-index.schema.json",
  "index": 1,
  "title": "Our studio's bundles",
  "entries": [
    {
      "name": "scoreboard",
      "kind": "bundle",
      "title": "Scoreboard",
      "description": "A score with a panel and a graphic.",
      "author": "Studio",
      "homepage": "https://example.org/scoreboard",
      "license": "MIT",
      "tags": ["sports"],
      "versions": [
        {
          "version": "1.0.0",
          "engine": { "mooncg": ">=0.10.0" },
          "source": {
            "type": "zip",
            "url": "scoreboard-1.0.0.zip",
            "sha256": "2fb654add918ce0ff8df68d9d8a7c89834d0c684124b2f218ca4175888c9eff5"
          }
        },
        {
          "version": "1.1.0",
          "engine": { "mooncg": ">=0.10.0" },
          "dependencies": { "team-data": "^1.0.0" },
          "source": {
            "type": "git",
            "url": "https://github.com/studio/scoreboard.git",
            "ref": "v1.1.0",
            "commit": "0123456789abcdef0123456789abcdef01234567"
          }
        }
      ]
    }
  ]
}
```

| Field                                               | Meaning                                                                                                                                               |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index`                                             | The format version, `1`. Another number is refused.                                                                                                   |
| `title`                                             | What the dashboard calls the index. Optional.                                                                                                         |
| `entries[].name`                                    | The bundle or module name, by the same rules as in a manifest. One entry per kind and name in an index.                                               |
| `entries[].kind`                                    | `bundle` or `module`.                                                                                                                                 |
| `title`, `description`, `author`, `license`, `tags` | Shown in the catalog and searched. No pictures: the catalog loads nothing from other sites.                                                           |
| `homepage`                                          | An `https://` address, shown as a link.                                                                                                               |
| `versions[].version`                                | A semantic version by the semver.org grammar (`1.2.3`, `1.2.3-rc.1`; no leading zeros such as `01.0.0`). Each version once per entry.                 |
| `versions[].engine.mooncg`                          | The range of MoonCG versions it runs on, as in a manifest. A version this MoonCG cannot run is shown, but neither installed nor offered as an update. |
| `versions[].dependencies`                           | The bundles it needs, for people to read. The installer checks the manifest itself.                                                                   |
| `versions[].source`                                 | A ZIP archive (`url` and `sha256`) or a Git repository (`url`, the full `commit`, and optionally the `ref` to fetch it by).                           |

Limits: at most 1000 entries, 100 versions per entry and 20 tags; texts are bounded
(a title 200 characters, a description 2000) and may hold no control characters and no
invisible format characters (a change of writing direction, a zero-width character, a line or
paragraph separator); the file may be at most 2 MiB. An index that breaks a rule is refused as a whole, with the first
problems named on the Catalog page.

A ZIP `url` is either an `https://` address or a path next to the index, such as
`zips/scoreboard-1.0.0.zip`, without `..`. A Git `url` must be `https://`. Addresses in an
index may not hold credentials. Plain `http://` is taken for this machine only
(`localhost`, `127.0.0.1`, `::1`), for an index served while developing: an index on this
machine may list addresses on this machine, over plain `http://` too; an index anywhere else
may list only `https://` addresses that are not this machine (paths next to it are fine).

Every address, of an index or in one, must be written plainly, the way it is read when it is
fetched: no backslash, no host that is read as another one (`2130706433`, `0x7f.0.0.1`,
`127.1`, `[0:0:0:0:0:0:0:1]`, a percent-encoded host), and a host name with letters beyond
ASCII in its `xn--` form.

A Git version is pinned to its `commit`. With a `ref`, that branch or tag is fetched and must
be that commit when it arrives; without one, the commit itself is fetched, which the Git host
must allow (fetching by commit hash; GitHub, for one, allows it for commits on a branch or a
tag). A ref follows the rule of the installer: a plain branch or tag name, without `..`,
`//`, a trailing `/` or `.`, or `.lock` at the end.

The JSON Schema of the format is in [`registry-index.schema.json`](registry-index.schema.json);
an editor completes and checks an index that names it in `$schema`. An example index with the
scoreboard is in [`e2e/registry/`](../e2e/registry/index.json); `node
e2e/registry/build-example.mjs` builds it again after `pnpm build`.

## Hosting an index

An index is a file; any static host serves it:

- **GitHub Pages**: put `index.json` and the ZIP archives in a repository, turn on Pages, and
  add `https://<owner>.github.io/<repo>/index.json`. Relative ZIP paths then resolve next to it.
- **A raw file of a Git host** (served as `text/plain`) works too.
- **Any web server or object storage** that answers `GET` with the file. ETag or
  Last-Modified make the checks every few hours cheap: MoonCG asks conditionally and keeps its
  copy on `304 Not Modified`.

The answer must be `application/json` (or `…+json`, `text/json`, `text/plain`); an HTML page,
such as a login wall, is refused. Redirects are followed, at most five, and each new address
is checked like the first one: a redirect never leads from an index elsewhere to this
machine, nor to an internal address.

An index must be on the internet or on this machine: the server does not connect to private,
shared, link-local or unique-local networks (`10.0.0.0/8`, `172.16.0.0/12`,
`192.168.0.0/16`, `100.64.0.0/10`, `169.254.0.0/16`, `fc00::/7`, `fe80::/10`), nor to
unspecified, multicast or reserved addresses, for an index, an archive it lists or a redirect.
IPv6 addresses that carry an IPv4 address count as what they carry or as internal: an address
of the well-known NAT64 prefix `64:ff9b::/96` is checked as its IPv4 address (so
`64:ff9b::a00:1` is `10.0.0.1`, while a NAT64 address of a host on the internet is taken, as
on an IPv6-only network it must be), and local-use NAT64 (`64:ff9b:1::/48`) and 6to4
(`2002::/16`) are internal as a whole.
A name is checked for every address it resolves to at the moment the connection is made, so a
name pointed elsewhere after a check is caught too. An index on a company network is
reachable only when the configuration of the server allows its network (below).

### Indexes and sources on a private network

The configuration of the server, and nothing else, can open hosts and networks of a private
network for indexes, the archives they list, ZIP sources by address and Git repositories:

```json
{
  "registryAllowPrivate": ["git.studio.internal", "10.20.0.0/16", "fd00:1234::/32"],
  "registryAllowPrivateHttp": false
}
```

or `--registry-allow-private <host|network>` (repeatable) and `--registry-allow-private-http`,
or `MOONCG_REGISTRY_ALLOW_PRIVATE` (comma-separated) and `MOONCG_REGISTRY_ALLOW_PRIVATE_HTTP=1`.
It cannot be changed through the API or the dashboard: it widens what the server reaches,
which is a decision about the machine and its network.

- An entry is a host name (exactly that name: `git.studio.internal`, not its subdomains), an
  address, or a network in CIDR form. A network must lie inside `10.0.0.0/8`,
  `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10` or `fc00::/7`; anything else, such as a
  public network, this machine, a link-local address (where cloud metadata services answer),
  multicast or `localhost`, is refused when the server starts.
- **Keep entries narrow**: name the hosts, or the smallest networks, that really serve
  indexes, archives or repositories, not a whole range such as `10.0.0.0/8`. An entry opens
  everything in it to whoever may add an index or install from an address. `100.64.0.0/10`
  in particular is shared address space (carrier-grade NAT, VPNs such as Tailscale) and
  holds services of cloud providers: Alibaba Cloud answers its instance metadata, with the
  credentials of the machine, at `100.100.100.200`. Allowing `100.64.0.0/10` as a whole opens
  that too.
- A private address is then asked when it lies in an allowed network, or when it is what an
  allowed host name resolves to. An allowed name that resolves to a link-local, reserved or
  loopback address is refused all the same; it is checked when the connection is made, as
  ever.
- **Over `https://`** only, unless `registryAllowPrivateHttp` is on: then plain `http://` is
  taken for the allowed hosts and networks too, and a connection over it goes only to an
  allowed private address (an allowed name that resolves to the internet is refused over
  `http://`). Credentials in the address of such an index would then cross the network in
  plain text; prefer `https://`.
- An index on a private host may list archives next to it, and `https://` addresses; an
  absolute `http://` address in an index is still taken only from an index on this machine.
- This machine stays as it was: only an index on this machine may point to it.

The setting is read once, at start.

**Git for Windows and a private certificate authority.** Git for Windows installs with
`http.sslBackend=openssl`, and that backend cannot be combined with the pin the server gives
git: git says so, and the server runs the fetch again with the backend git names, Schannel,
which checks certificates against the certificate store of Windows and, by default, asks
whether a certificate was revoked. A repository whose certificate comes from a private
certificate authority can then fail although it worked in a shell: the authority is not in the
Windows store, or its revocation list cannot be reached from the server
(`CRYPT_E_NO_REVOCATION_CHECK`, `CRYPT_E_REVOCATION_OFFLINE`). What the administrator can do,
in the Git configuration of the machine or of the server's account:

- Fix the backend: `git config --system http.sslBackend schannel` (or choose "Use the native
  Windows Secure Channel library" when installing Git for Windows). Then the server runs git
  once, with that backend, and the settings below apply from the start.
- Put the private authority into the Windows certificate store (Trusted Root Certification
  Authorities) of the server's account or of the machine.
- Make its revocation list reachable from the server. Only where that cannot be done:
  `http.schannelCheckRevoke false`, best only for that host
  (`git config --system http.https://git.studio.internal/.schannelCheckRevoke false`), which
  gives up the revocation check there.

`http.sslCAInfo` (a CA file for OpenSSL) does not apply once Schannel is used, unless
`http.schannelUseSSLCAInfo` is set as well.

A private index can carry credentials in its address, such as
`https://reader:token@example.org/index.json`. They are sent as an `Authorization` header
(Basic) to that origin only: for the index itself, and for every archive the index lists on
that origin, by a path next to it or by an absolute address. They never go to another origin,
also not to one a redirect leads to, and are never shown or logged: the API, the dashboard and
the log show `https://***@example.org/index.json`. Credentials that are no valid
percent-encoding are refused when the index is added.

Where they are kept: the address of an added index, credentials included, is stored as it was
given in the setting `registryIndexes` of the database in the data folder, in plain text, like
the rest of the configuration; a configured one stays where it was configured. Nothing else
holds them: the address of an archive is resolved against the index address without them, and
the download asks the index for them when it runs. So `bundle-sources.json`,
`module-sources.json` and the notes of staged bundles hold no credentials of an index. An
update without a source of something installed from an index fetches it again with the
credentials the index has then; once the index is removed, it is fetched without any. A ZIP or
Git source given directly with credentials in its address keeps them there, as before.

To publish a version:

1. Build the ZIP archive of the bundle (the folder with `mooncg.json` at its root, or one
   folder that holds it) and compute its checksum: `sha256sum scoreboard-1.1.0.zip`, or
   `Get-FileHash -Algorithm SHA256` in PowerShell (lowercase the result).
2. Or tag a commit and list `url`, `ref` and the full `commit`.
3. Add the version to the entry and publish the index.

## Where indexes come from

- The configuration: `--registry-index <url>` (repeatable), `MOONCG_REGISTRY_INDEXES`
  (comma-separated) or `"registryIndexes": [...]` in `mooncg.config.json`. These are shown with
  the badge _configuration_ and are changed there, not in the dashboard.
- Added at run time in the dashboard or with `mooncg registry add`; they are kept in the
  database and survive restarts. At most 20 indexes in all.

The server fetches every index when it starts and then every 6 hours
(`--registry-refresh-ms`, `MOONCG_REGISTRY_REFRESH_MS`), and when someone presses **Check
now** or runs `mooncg registry refresh`, at most every 30 seconds for everyone together: a
request sooner is answered `429` with `Retry-After`, and the dashboard and the command line
say when to try again. Fetching never holds up the start, and an index that
is slow or gone stops nothing else: a fetch takes at most 30 seconds.

The last good copy of each index is kept in `data/registry/<id>.json`. When a fetch fails, or
what arrives is no valid index, that copy is used and the index is shown as **stale** with the
reason; without a copy it is shown as **error** and lists nothing. A copy is checked again
when it is read, like a fresh download. Why an index could not be used is told and logged
without control or format characters and at most 500 characters long.

Fetching an index fetches the index and nothing else. What an entry points to is fetched only
when an administrator installs or updates it.

## Installing from the catalog

**Install** (or `mooncg bundle install <name>`) starts the usual
[stage → summary → commit](bundles.md#the-steps) flow with the source the entry names, at the
newest version that runs on this MoonCG (or the one `--version` names):

- **ZIP**: the archive is downloaded over https, at most as large as an archive may be
  (`--bundle-max-archive-bytes`), counted while it arrives. Its SHA-256 must be the one the
  index names; otherwise it is deleted before a single entry is read. Then it goes through
  every check of a ZIP upload.
- **Git**: through the same hardened Git path as any repository. With a `commit`, the fetched
  ref must be exactly that commit, or nothing is kept; with a `commit` alone, that commit is
  fetched.

The staged bundle must have the name and the version of the entry: an archive whose manifest
says another version than the index claims is refused, naming both. Its summary shows the
source, the index and that entries of an index are not checked by MoonCG. Everything else is as for any bundle or
module: the engine range, the dependencies, npm and its trust opt-in, the On Air lock for an
update, a module staying disabled until it is enabled.

## Indexes a module provides

A module can provide an index of its own, for instance read from a private API, with
`ctx.registry.registerSource`. It shows as `module://<module>/<id>` with the origin _module_,
is checked like any index, must name archives by `https://` address, and is gone with the
module. The server downloads what it lists itself, through the same checks. See
[modules.md](modules.md#registry-indexes-of-a-module).

## How updates are found

Updates are matched by **where something was installed from**, not by its name. When a bundle
or module is installed from an index entry, its remembered source (`bundle-sources.json`,
`module-sources.json`) notes the index (by a hash of its address without credentials), the
kind, the name and the version. For each installed thing with such a note, the same entry of
the same index is asked for the newest version that:

- is greater than the installed version by semver,
- runs on this MoonCG by its `engine.mooncg`,
- is no pre-release (unless asked for by name with `--version`).

So an index that lists the name of a bundle installed from a folder, a ZIP upload, a Git
address or another index offers it nothing: no hint and no one-click update, and
`POST /api/v1/registry/stage` with `"update": true` refuses it with 409. To move such a
bundle to an index, remove it and install it from the catalog.

The hints show as **Update available** on the Bundles and Modules pages and in the catalog,
and in `mooncg bundle outdated` / `module outdated`. The pages get them live: the server keeps
them in the replicants `system:updates.bundles` and `system:updates.modules`
(`{ updates, revision }`), read with `system:bundles.manage` and `system:modules.manage`
respectively, and works them out again whenever an index was fetched, added or removed and
whenever something was installed, updated or removed. Changes that come close together are
taken as one (after 100 ms of quiet, and at least every 2 s however steadily they come), and
`revision` counts up only when the hints of that kind, the entries of the indexes or what is
installed really changed, not on every progress of a job. A badge appears without reloading
the page, and the catalog reads its entries again. `GET /api/v1/registry/updates` stays. **Update to x.y.z** stages that version as
an update of the installed one; it is put in place like every update, with a backup and a
rollback, and blocked while On Air unless overridden. `mooncg bundle update <name>` without a
source takes the newer version from the index it was installed from, also when other indexes
list the same name; with `--version` naming a pre-release, it says so.

The catalog never downgrades: an update to a version older than the installed one is refused
(409). Going back is a decision of its own: remove the bundle (its data stays unless purged)
and install the older version with `--version`. An update that names no source
(`POST /api/v1/bundles/<name>/update` without one) fetches what came from an index again as
the entry said, the archive with the credentials of the index or the repository at the same
commit, and it stays tied to that entry.

`mooncg bundle install <name>` looks a name up in the catalog when there is no file or folder
of that name here. When there is both, it is refused with a hint: `./<name>` for the folder,
`--index <id|url>` for the catalog.

## Who may do this

| What                                                            | Takes                                          |
| --------------------------------------------------------------- | ---------------------------------------------- |
| Read the catalog of bundles, install or update a bundle from it | `system:bundles.manage`                        |
| Read the catalog of modules, install or update a module from it | `system:modules.manage`                        |
| List the indexes and how they stand, check them now             | either of the two                              |
| Add or remove an index                                          | `system:settings.manage` and either of the two |

Reading the catalog of a kind takes the permission to install that kind, as installing is all
there is to do with it. The list of indexes is configuration of the server, hence
`system:settings.manage`; adding one grants nothing, as installing from it still takes the
permission of its kind.

## The API

All below `/api/v1/registry`, all through `authorize()`; changes need a JSON body or the
`X-MoonCG-CSRF` header.

| Request                                                            | What it does                                                                                                                                                                               |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /indexes`                                                     | `{ indexes, canEdit, refreshMs }`; each index with `id`, `url` (without credentials), `origin`, `status`, `error`, `entries` (of the kinds the caller may read), `fetchedAt`, `checkedAt`. |
| `POST /indexes` `{ "url" }`                                        | Adds an index and fetches it: `201 { index }`.                                                                                                                                             |
| `DELETE /indexes/:id`                                              | Removes an added index and its copy: `204`; `409` for one of the configuration.                                                                                                            |
| `POST /refresh`                                                    | Fetches every index now: `{ indexes, … }`; `429` with `Retry-After` within 30 s of the last one.                                                                                           |
| `GET /catalog?kind=&q=`                                            | `{ mooncg, entries, indexes }`; each entry with its versions (newest first, `compatible`), `installed { version, fromThisEntry }` and `update`.                                            |
| `GET /updates`                                                     | `{ updates: [{ kind, name, installed, available, index }] }`.                                                                                                                              |
| `POST /stage` `{ kind, index, name, version?, update?, scripts? }` | Stages the entry: `202 { job }`, followed as any install job.                                                                                                                              |

A ZIP from an address can also be staged directly with
`{ "source": { "type": "url", "url": "https://…", "sha256": "…" } }` on the stage routes of
bundles and modules. Such an address is held to the rules of an index on the internet:
`https://` only, never this machine and never an internal address, since whoever may install
could otherwise make the server ask services only it can reach. An archive on this machine is
staged as a `zip` path instead.

## Security notes

- **An index is trust in its author.** It decides what the catalog offers and where it comes
  from. MoonCG shows that on every summary; it cannot tell a good entry from a bad one.
- **Checksums** bind a ZIP to the bytes the index names: a changed or swapped archive on the
  host is refused. They do not make the index itself trustworthy: whoever controls the index
  controls the checksum.
- **Git commit pinning** binds a version to one commit: a tag that is moved later is refused.
  An index must name the commit of every Git version.
- Only `https://` (and `http://` on this machine, for an index on this machine, or on a
  private network the configuration allows it for) is fetched, never an internal address the
  configuration does not allow, redirects are limited and checked again, every download is
  bounded in size and time, and credentials appear in no message.
- The network checks are done by the server itself, with `node:http` and `node:https` and a
  resolver of its own that checks every address a name resolves to when it connects; a
  connection is never reused across requests.
- Git sources are fetched by `git`, which resolves names itself. So the server resolves the
  host of a Git address first, by the same rules (never an internal address unless its private
  network is allowed; this machine only for what an index on this machine lists), and then pins
  git to the addresses it checked with `-c http.curloptResolve=<host>:<port>:<addresses>`, and
  `-c http.followRedirects=false`, so that a redirect does not lead to a host that was not
  checked. Git older than 2.37, which would ignore the pin, is refused for `https://`; no proxy
  is used; a `url.*.insteadOf` rewrite is checked where it leads. See
  [bundles.md](bundles.md#git) for what remains: SSH is checked, not pinned.
- **Versions** follow the semver.org grammar strictly, so a list of versions sorts one way only
  and no version hides an update. The catalog never goes back a version.
- An index never makes the server fetch anything but the index itself, except when an
  administrator installs or updates from it.
- The catalog loads nothing from other sites: no icons and no pictures, and the built-in
  Content Security Policy of the dashboard is unchanged.

## Not there yet

- No signatures of indexes or archives; no public MoonCG index.
