# MoonCG-Dokumentation

MoonCG ist ein Broadcast-Graphics-Framework: Es strukturiert Bundles (Grafiken, Dashboard-Panels, Server-Extensions) und stellt eine API bereit, um Daten zwischen Dashboard, Server und Grafiken zu bewegen. MoonCG ist ein Breaking-Fork von NodeCG mit neuen Features: React-Dashboard, Auth-System (Rollen, 2FA, Session-Verwaltung), vollem Hot Reload inklusive Server-Extensions und einer laufenden Effect-TS-Migration.

Benötigt Node.js >= 24.

## Leitfäden & Referenzen

| Dokument                                      | Inhalt                                                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [Änderungen gegenüber NodeCG](aenderungen.md) | Konsolidierte Übersicht: Breaking-Rename, neue Features, Dependency-Modernisierung                                  |
| [Bundle-Entwicklung](bundle-entwicklung.md)   | Bundle-Anatomie, das komplette `mooncg`-Manifest-Feld, Bundle-Config, Panels/Dialoge/Graphics, Hot-Reload-Verhalten |
| [API-Referenz](api-referenz.md)               | Die `mooncg`-API für Extensions (Server) und Panels/Graphics (Client), Replicants, Messages, Lifecycle-Events       |
| [Auth: Benutzung](auth/benutzung.md)          | Login aktivieren, Benutzerverwaltung, Rollen, 2FA, Sessions, API-Keys, komplette REST-API-Referenz (`/api/v1`)      |

## Detail-Dokus (Design & interne Notizen)

| Dokument                                                       | Inhalt                                                                     |
| -------------------------------------------------------------- | -------------------------------------------------------------------------- |
| [Rename NodeCG → MoonCG](rename-mooncg.md)                     | Was beim Breaking-Rename umbenannt wurde (und was bewusst nicht)           |
| [Dependency-Updates Juli 2026](dependency-updates-2026-07.md)  | Durchgeführte Major-Updates und bewusst zurückgestellte Upgrades           |
| [Dashboard-Rewrite: Spezifikation](dashboard-rewrite/spec.md)  | Bestandsaufnahme des Polymer-Dashboards als Grundlage für den React-Neubau |
| [Auth-System: Design](auth/design.md)                          | Designentscheidungen des Auth-Ausbaus (DB-Benutzer, Rollen, 2FA, Sessions) |
| [Hot Reload: Design](hot-reload/design.md)                     | Designentscheidungen des vollen Bundle-Hot-Reloads                         |
| [Effect-TS-Migration: Strategie](effect-migration/strategy.md) | Migrationsstrategie, Konventionen und Kandidatenliste                      |
| [Effect-TS-Migration: Log](effect-migration/log/README.md)     | Fortlaufendes Migrationslog (Entscheidungen, Probleme, Patterns)           |
| [Drizzle + Effect](drizzle-effect.md)                          | Notizen zur Datenbank-Zukunft (Drizzle ORM mit Effect)                     |
