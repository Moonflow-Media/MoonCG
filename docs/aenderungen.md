# Änderungen gegenüber NodeCG

MoonCG ist ein bewusst _breaking_ Fork von NodeCG. Diese Seite fasst alle Änderungsblöcke zusammen und verlinkt die jeweiligen Detail-Dokus.

## 1. Breaking-Rename NodeCG → MoonCG

Vollständige Liste: [rename-mooncg.md](rename-mooncg.md). Die wichtigsten Punkte für Bundle-Autoren:

| Vorher (NodeCG)                                        | Nachher (MoonCG)                                                  |
| ------------------------------------------------------ | ----------------------------------------------------------------- |
| package.json-Feld `nodecg` im Bundle                   | `mooncg` (inkl. `mooncg.compatibleRange`)                         |
| Globales `nodecg`-Objekt in Panels/Graphics/Extensions | Globales `mooncg`-Objekt (`mooncg.Replicant(...)`)                |
| `window.NodeCG` (Client-API-Klasse)                    | `window.MoonCG`                                                   |
| Env-Variablen `NODECG_ROOT`, `NODECG_TEST`, …          | `MOONCG_ROOT`, `MOONCG_TEST`, `MOONCG_TEST_PORT`, …               |
| Server-Config `cfg/nodecg.json\|yaml\|yml\|js`         | `cfg/mooncg.json\|yaml\|yml\|js` (cosmiconfig-Modulname `mooncg`) |
| Root-Erkennung `nodecgRoot: true` (Legacy-Mode)        | `mooncgRoot: true`                                                |
| Pakete `nodecg`, `@nodecg/*`                           | `mooncg`, `@mooncg/*`; CLI-Binary `mooncg`                        |
| Datenbankdatei `db/nodecg.sqlite3`                     | `db/mooncg.sqlite3` (bestehende Installationen: umbenennen)       |

Das Feld heißt weiterhin `compatibleRange` — nur der umgebende Manifest-Schlüssel wurde von `nodecg` zu `mooncg` umbenannt (`workspaces/mooncg/src/server/bundle-parser/manifest.ts`).

## 2. Neue Features

### React-Dashboard

Das Polymer-3-Dashboard wurde durch eine React-App ersetzt (`workspaces/mooncg/src/client/dashboard-app/`). Der öffentliche Vertrag für Bundles (Panel-iframes, `getDialog()`/`getDialogDocument()`, Workspaces, Mixer, Assets, Graphics-Seite) bleibt erhalten. Bestandsaufnahme des Alt-Dashboards und Verhaltensspezifikation: [dashboard-rewrite/spec.md](dashboard-rewrite/spec.md).

### Auth-System mit DB-Benutzern, Rollen, 2FA und Session-Verwaltung

- Lokale Benutzerkonten in der Datenbank (scrypt-gehashte Passwörter) zusätzlich zur statischen Config-Liste (Bootstrap-Pfad)
- Rollensystem mit durchgesetzten Berechtigungen: `superuser`, `admin`, `operator`, `viewer`
- TOTP-2FA für lokale Konten (otpauth-kompatibel)
- Persistente Sessions in der DB, Verwaltung aktiver Sessions (einzeln beenden)
- REST-API unter `/api/v1` sowie Benutzerverwaltungs-UI im Dashboard

Anleitung: [auth/benutzung.md](auth/benutzung.md), Design: [auth/design.md](auth/design.md).

### Voller Hot Reload

Bundle-Änderungen werden ohne Server-Neustart wirksam, konfigurierbar über den `hotReload`-Block der Server-Config:

- `hotReload.dashboard` (Default `true`): offene Dashboard-Panels/Dialoge eines Bundles laden bei Änderungen automatisch neu
- `hotReload.graphics` (Default `false`): offene Graphics laden automatisch neu (Standard aus — Live-Ausgabe!)
- `hotReload.extensions` (Default `true`): Server-Extensions werden bei Codeänderungen zur Laufzeit neu geladen (Replicant-State überlebt; Reload kaskadiert über abhängige Bundles)

Verhalten für Bundle-Autoren inkl. `bundleUnloading`-Vertrag: [bundle-entwicklung.md](bundle-entwicklung.md#hot-reload), Design: [hot-reload/design.md](hot-reload/design.md).

### Effect-TS-Migration

Der Server wird inkrementell auf Effect-TS migriert (z. B. BundleService, Extension-Manager, Route-Bootstrap). Strategie und Konventionen: [effect-migration/strategy.md](effect-migration/strategy.md), Log: [effect-migration/log/README.md](effect-migration/log/README.md).

## 3. Dependency-Modernisierung

Alle semver-kompatiblen Updates plus zahlreiche Major-Updates (zod 4, cheerio 1.2, cosmiconfig 9, passport 0.7, multer 2, serialize-error 13, aktueller Effect-Stack, …); yargs und hasha wurden entfernt. Details und bewusst zurückgestellte Upgrades (Express 5, Sentry 10, TypeORM 1.0, …): [dependency-updates-2026-07.md](dependency-updates-2026-07.md).

## 4. Plattform-Anforderungen

- **Node.js >= 24** (`workspaces/mooncg/package.json`, Feld `engines.node`)
- Build über `tsdown` (gebündelte CommonJS-Ausgabe in `workspaces/mooncg/dist/`)
- Tests über Vitest (`npx vitest run`)
