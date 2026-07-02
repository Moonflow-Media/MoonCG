# Rename NodeCG → MoonCG (Juli 2026)

Komplettes Breaking-Rename, ausgeführt am 2026-07-02. Case-erhaltender Sweep über das gesamte Repo (`nodecg→mooncg`, `NodeCG→MoonCG`, `NODECG→MOONCG`) inklusive Datei-/Verzeichnis-Renames.

## Was sich geändert hat (breaking für bestehende Bundles/Installationen)

- **Pakete**: `nodecg` → `mooncg`, `@nodecg/cli|internal-util|database-adapter-types|database-adapter-sqlite-legacy` → `@mooncg/*`
- **CLI-Binary**: `nodecg` → `mooncg`
- **Bundle-Manifest**: package.json-Feld `nodecg` (compatibleRange etc.) heißt jetzt `mooncg`
- **Root-Erkennung**: package.json-Feld `nodecgRoot` → `mooncgRoot` (Legacy-Mode)
- **Env-Variablen**: `NODECG_ROOT` → `MOONCG_ROOT`, `NODECG_TEST` → `MOONCG_TEST`, `NODECG_TEST_PORT` → `MOONCG_TEST_PORT` usw.
- **Konfigdateien**: `cfg/nodecg.json|yaml|yml|js` → `cfg/mooncg.*` (cosmiconfig-Modulname `mooncg`)
- **Client-API**: `window.NodeCG` → `window.MoonCG`; Bundles nutzen das globale `mooncg`-Objekt (`mooncg.Replicant(...)`)
- **TypeScript**: Namespace `NodeCG` → `MoonCG`, `NodeCGAPIBase` → `MoonCGAPIBase`, `types/nodecg.ts` → `types/mooncg.ts` usw.
- **Datenbankdatei**: `db/nodecg.sqlite3` → `db/mooncg.sqlite3` (bestehende Installationen müssen die Datei umbenennen)
- **Workspace-Verzeichnis**: `workspaces/nodecg` → `workspaces/mooncg`

## Bewusst NICHT umbenannt

- **Externe npm-Pakete** `@nodecg/json-schema-lib` und `@nodecg/json-schema-defaults` — fremde, veröffentlichte Pakete; bleiben als Dependencies.
- **`ncg-*`-Custom-Elements** im Dashboard (`ncg-dashboard`, `ncg-workspace`, …) — interne Implementierungsdetails des Polymer-Dashboards, kein öffentliches API. Umbenennung wäre reine Churn mit Bruchrisiko.
- **CHANGELOG.md, AUTHORS, LICENSE** — historische Dokumente.
- **Git-Historie/Remote** — `origin` zeigt weiterhin auf `github.com/nodecg/nodecg`.

## Offene Punkte (manuell zu erledigen)

1. **GitHub-Remote**: Eigenes Repository anlegen und `git remote set-url origin <neue URL>` setzen. Die `repository`-Felder in den package.json-Dateien zeigen nach dem Sweep auf `github.com/mooncg/mooncg` — auf die echte Organisation anpassen.
2. **Repo-Ordner**: Das lokale Verzeichnis heißt weiterhin `E:\nodecg` (kann von außen zu `E:\mooncg` umbenannt werden; danach IDE/Terminal neu öffnen).
3. **npm-Veröffentlichung**: Die Namen `mooncg` / `@mooncg/*` müssen auf npmjs.com verfügbar sein bzw. die Organisation `@mooncg` registriert werden, bevor die Release-Workflows (release-please) funktionieren.
4. **README/Branding**: Der Sweep hat Texte mechanisch ersetzt (inkl. Links wie `nodecg.dev` → `mooncg.dev`, die noch nicht existieren). Inhaltliche Überarbeitung steht aus.
