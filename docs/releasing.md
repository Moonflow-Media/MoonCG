# Releasing

MoonCG is published to npm via GitHub Actions (`.github/workflows/ci.yaml`) using
[release-please](https://github.com/googleapis/release-please) and
[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (OIDC — no npm
tokens are stored in the repo).

## Published packages

| Package                                  | Source                                        |
| ---------------------------------------- | --------------------------------------------- |
| `mooncg`                                 | `workspaces/mooncg`                           |
| `@mooncg/types`                          | `workspaces/mooncg` (republished — see below) |
| `@mooncg/cli`                            | `workspaces/cli`                              |
| `@mooncg/internal-util`                  | `workspaces/internal-util`                    |
| `@mooncg/database-adapter-types`         | `workspaces/database-adapter-types`           |
| `@mooncg/database-adapter-sqlite-legacy` | `workspaces/database-adapter-sqlite-legacy`   |

`@mooncg/types` has no workspace of its own. It is the `mooncg` package published a
second time: `workspaces/mooncg/scripts/prepare-publish-types.ts` rewrites the
`package.json` (renames to `@mooncg/types`, drops `bin`, keeps only the `./types*`
exports remapped to `.`). Its entry points are `workspaces/mooncg/types/*.d.ts`,
which re-export the generated declarations from `workspaces/mooncg/dist/dts/`.

## Publishing a stable release (e.g. 2.9.1)

Releases are fully automated — there is no manual `npm publish` step.

1. **Land changes on `main` with Conventional Commit messages.** The commit type
   determines the version bump:
   - `fix: …` → patch (2.9.0 → 2.9.1)
   - `feat: …` → minor (2.9.0 → 2.10.0)
   - `feat!: …` or a `BREAKING CHANGE:` footer → major (3.0.0)
   - `chore:` / `docs:` / `ci:` → no release
2. **Wait for the release PR.** On every push to `main`, release-please opens or
   updates a PR titled `chore: release main` that bumps versions and writes
   changelogs. The `update-release-pr` job then pushes an updated
   `package-lock.json` to that PR automatically.
   - `cli` and `mooncg` are version-linked (`linked-versions` plugin) and always
     bump together.
   - The other workspace packages only bump when they changed themselves or when
     a workspace dependency bumped (`node-workspace` plugin).
3. **Merge the release PR.** This is the publish button. On merge, release-please
   creates the git tags and GitHub releases, and the `publish` job (environment
   `latest-release`) publishes every released package to npm with the `latest`
   tag — including the double publish of `workspaces/mooncg` as `mooncg` and
   `@mooncg/types`. A root release also builds and pushes the Docker image to
   ghcr.io.

## Canary releases

Every push to `main` that does **not** merge a release PR publishes a canary from
the `publish` job (environment `canary-release`):

- Version: `0.0.0-canary.<commit sha>`, npm dist-tag `canary`.
- `scripts/prepare-prerelease.ts` stamps the version into every workspace
  `package.json` before publishing.

Install with `npm install mooncg@canary`.

**Do not re-run a publish job for the same commit.** The canary version embeds the
commit SHA, so a re-run tries to publish versions that already exist and fails
with `E403 You cannot publish over the previously published versions`. That error
on a re-run is harmless — the packages for that commit are already on npm.

## PR releases

Every pull request publishes prerelease versions `0.0.0-pr<number>.<sha>` with the
dist-tag `pr<number>` (job `pr-release`, environment `pr-release`). The workflow
comments install instructions on the PR: `npm install mooncg@pr<number>`.

## npm authentication (Trusted Publishing)

CI authenticates via OIDC (`permissions: id-token: write`); there is no
`NODE_AUTH_TOKEN`. Each package must have a **Trusted Publisher** configured on
npmjs.com (package → Settings → Trusted Publisher → GitHub Actions):

- Organization: `Moonflow-Media`
- Repository: `MoonCG`
- Workflow filename: `ci.yaml`
- Environment: **leave blank** — the workflow uses three different GitHub
  environments (`pr-release`, `canary-release`, `latest-release`) and npm only
  allows one trusted publisher per package. Pinning an environment breaks the
  other publish paths.

### Adding a new package

Trusted Publishing cannot create packages that do not exist yet. The first
publish of a new package must be done manually once, then the trusted publisher
can be configured:

```powershell
npm whoami                       # log in if needed: npm login
npm ci
npm run build
npx tsx scripts/prepare-prerelease.ts --version 0.0.0-canary.<current main sha>
cd workspaces/<package>          # for @mooncg/types additionally run:
                                 #   npx tsx scripts/prepare-publish-types.ts
npm publish --tag canary --provenance=false
cd ..\..
git checkout -- .                # the prepare scripts mutate package.json files
```

Notes:

- `--provenance=false` is required locally — `publishConfig.provenance: true`
  makes `npm publish` fail outside of CI.
- npm always sets the `latest` dist-tag on the very first publish of a package,
  even with `--tag canary`. It corrects itself with the next stable release.
- After the first publish, configure the trusted publisher (see above), or the
  next CI run fails on that package with
  `E404 Not Found - PUT … could not be found or you do not have permission`.

## Troubleshooting

| Error                                                                                        | Cause                                                                                                                                                                                                                   | Fix                                                                                                               |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `E404 Not Found - PUT …` during publish                                                      | No valid npm auth for that package: trusted publisher missing or misconfigured (wrong repo/workflow/environment), or the package does not exist yet. npm returns 404 instead of 403 to avoid leaking package existence. | Configure the trusted publisher (environment blank); for brand-new packages do the one-time manual first publish. |
| `E403 You cannot publish over the previously published versions`                             | Re-run of a publish job for a commit whose versions are already on npm.                                                                                                                                                 | Nothing to do — that commit is fully published. The next push to `main` publishes cleanly.                        |
| `npm notice publish Provenance statement published to transparency log` followed by an error | The provenance/sigstore upload happens **before** the registry PUT — this notice does not mean the publish succeeded.                                                                                                   | Read the actual error below the notice.                                                                           |
