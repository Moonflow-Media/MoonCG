# Auth-System: Benutzung

Anleitung für Betrieb und Automatisierung des MoonCG-Auth-Systems: Aktivierung, Benutzerverwaltung, Rollen, 2FA, Sessions, API-Keys und die komplette REST-API. Designentscheidungen: [design.md](design.md).

## Aktivierung in der Config

Login wird in der Server-Config (`cfg/mooncg.json`) aktiviert. `sessionSecret` ist bei `enabled: true` Pflicht. Vollständiges Beispiel mit lokalem Login:

```json
{
  "login": {
    "enabled": true,
    "sessionSecret": "bitte-durch-langes-zufaelliges-secret-ersetzen",
    "sessionTTL": 604800,
    "local": {
      "enabled": true,
      "allowedUsers": [
        {
          "username": "admin",
          "password": "einstiegspasswort"
        }
      ]
    }
  }
}
```

- `sessionTTL` (Sekunden, Default `604800` = 7 Tage): Lebensdauer einer Login-Session (Cookie-`maxAge` und DB-`expiredAt`).
- Config-Passwörter dürfen alternativ als HMAC angegeben werden: `"<hashAlgo>:<hex>"` (z. B. `sha256:…`), berechnet als HMAC über das Klartext-Passwort mit dem `sessionSecret` als Schlüssel.
- Daneben existieren die OAuth-Provider `steam`, `twitch` und `discord` (Whitelists via `allowedIds`/`allowedUsernames`/`allowedUserIDs`/`allowedGuilds`; siehe `src/types/mooncg-config-schema.ts`). OAuth-Logins erhalten bei erfolgreicher Whitelist-Prüfung die Rolle `superuser`.

## Bootstrap-Flow

1. In der Config einen Benutzer unter `login.local.allowedUsers` eintragen und den Server starten.
2. Erster Login unter `/login` mit diesem Benutzer: MoonCG legt dafür einen DB-User an (upsert) und weist ihm die Rolle **superuser** zu.
3. Als Superuser im Dashboard unter **Users** (oder per REST-API) echte DB-Benutzer mit Rollen anlegen.
4. Danach kann der Config-Eintrag entfernt werden — DB-Benutzer (Identity mit scrypt-Passwort-Hash) haben beim Login Vorrang vor der Config-Liste.

Passwörter von DB-Benutzern werden mit `node:crypto` scrypt gehasht: `scrypt$N=16384,r=8,p=1$<salt-b64>$<hash-b64>` (`src/server/util/password.ts`).

## Rollen und Berechtigungen

Berechtigungen sind (entityId, Aktions-Bitmaske READ=1/WRITE=2)-Paare an Rollen. Matching (`workspaces/database-adapter-types/src/has-permission.ts`): exakter Match, globales `*` oder Präfix-Wildcard wie `users:*`. **Wichtig:** Das globale `*` deckt den geschützten Namespace `users:` (User-Management) _nicht_ ab — der muss explizit gewährt sein. Die Rolle `superuser` umgeht alle Prüfungen.

Seed-Rollen (Migration `1783038858752-auth-users.ts`):

| Rolle       | Berechtigungen                       | Bedeutet praktisch                                                                            |
| ----------- | ------------------------------------ | --------------------------------------------------------------------------------------------- |
| `superuser` | alles (Bypass)                       | Vollzugriff inkl. Benutzerverwaltung; wird Config-/OAuth-Logins zugewiesen                    |
| `admin`     | `*` READ+WRITE, `users:*` READ+WRITE | Vollzugriff inkl. Benutzerverwaltung                                                          |
| `operator`  | `*` READ+WRITE                       | Dashboard bedienen, Replicants schreiben, Messages senden — **keine** Benutzerverwaltung      |
| `viewer`    | `*` READ                             | Dashboard/Graphics ansehen, Replicants lesen/abonnieren — jeder Schreibversuch wird abgelehnt |

Zugang zum Dashboard hat jeder aktivierte Benutzer, dessen Rollen READ auf `dashboard` gewähren (also alle vier Rollen); zusätzlich muss der Auth-Provider des Benutzers in der Config aktiviert sein (`src/server/util/authcheck.ts`).

## Benutzerverwaltung über die Admin-UI

Die Dashboard-Seite **Users** erscheint nur, wenn Login aktiv ist und der eingeloggte Benutzer `users:*` WRITE hat (Feld `canManageUsers` aus `GET /api/v1/me`). Funktionen (`src/client/dashboard-app/UsersPage.tsx`):

- **Benutzerliste** mit Rollen, Status (enabled), 2FA-Status
- **Add User / Edit**: Name, Passwort, Rollen (Checkboxen), Aktiviert-Flag
- **Sessions**: aktive Sessions eines Benutzers ansehen und einzeln beenden
- **Reset 2FA**: TOTP eines Benutzers zurücksetzen (z. B. bei verlorenem Authenticator)
- **Delete**: Benutzer löschen (inkl. Identitäten, API-Keys, Sessions)

Auf der Seite **Settings** verwaltet jeder Benutzer sich selbst: eigene 2FA-Einrichtung (QR-Code) und eigene aktive Sessions (`SettingsPage.tsx`).

## 2FA (TOTP) einrichten — Schritt für Schritt

TOTP-Parameter: 6 Ziffern, 30-Sekunden-Fenster, SHA1, Toleranz ±1 Zeitschritt, Issuer „MoonCG“ (`src/server/util/totp.ts`).

1. Dashboard → **Settings** → **Set Up 2FA** (oder `POST /api/v1/me/2fa/enroll`). Antwort: `{ secret, otpauthUrl }`; die UI zeigt den QR-Code.
2. `otpauthUrl`/QR in eine Authenticator-App übernehmen.
3. Erzeugten 6-stelligen Code bestätigen (`POST /api/v1/me/2fa/verify` mit `{ "token": "123456" }`). Erst danach ist `totp_enabled = true` — ein abgebrochenes Enrollment bleibt wirkungslos.
4. Ab jetzt verlangt der lokale Login zusätzlich das Feld `totp` im Login-POST. Die Login-Seite blendet das Feld automatisch ein, wenn der Server mit `?error=totp_required` oder `?error=totp_invalid` umleitet.
5. Deaktivieren: **Settings** → **Disable 2FA** mit gültigem Code (`DELETE /api/v1/me/2fa`), oder durch einen Admin per **Reset 2FA** (`POST /api/v1/users/:id/2fa/reset`, ohne Code).

## Login-Flow (lokal)

`POST /login/local` mit Formularfeldern `username`, `password` und optional `totp` (`src/server/server/login/index.ts`):

1. Existiert eine DB-Identity (provider `local` mit Passwort-Hash): scrypt-Verify; deaktivierte Benutzer (`enabled = false`) werden abgelehnt.
2. Sonst Fallback auf `login.local.allowedUsers` aus der Config (Bootstrap; erfolgreiche Logins ⇒ superuser).
3. Bei aktiviertem TOTP wird der `totp`-Wert geprüft.

Fehlschläge leiten auf `/login?error=<code>` um:

| Code                  | Bedeutung                                    |
| --------------------- | -------------------------------------------- |
| `invalid_credentials` | Falsches Passwort eines DB-Benutzers         |
| `user_disabled`       | Benutzerkonto ist deaktiviert                |
| `totp_required`       | 2FA aktiv, aber kein `totp`-Feld übermittelt |
| `totp_invalid`        | Übermittelter TOTP-Code ist ungültig         |

Logout: `GET /logout` (zerstört die Session und löscht die Cookies `connect.sid`, `io`, `socketToken`).

## Session-Verwaltung

Sessions liegen in der Datenbank (eigener express-session-Store, `session-store.ts`) und überleben Server-Neustarts. Beim Login werden Metadaten gespeichert (`createdAt`, `ip`, `userAgent`), die in der Session-Liste angezeigt werden. Wird eine Session beendet (eigene über Settings, fremde als Admin, automatisch beim Deaktivieren/Löschen eines Benutzers), werden zusätzlich alle zugehörigen Sockets mit `protocol_error` (Code `invalid_session`, Typ `UnauthorizedError`) benachrichtigt und getrennt — offene Dashboards/Graphics landen auf der Fehlerseite.

## API-Keys für Automationen

- Beim ersten authentifizierten Dashboard-Zugriff erhält jeder Benutzer automatisch einen API-Key; er wird als Cookie `socketToken` gesetzt.
- HTTP-Anfragen können sich alternativ mit `?key=<secret_key>` authentifizieren (`authcheck.ts`) — so funktionieren z. B. OBS-Browser-Sources ohne Session.
- Socket.IO-Verbindungen authentifizieren sich mit `?token=<secret_key>` im Handshake (`socketAuthMiddleware.ts`).
- Über das Socket-Event `regenerateToken` lässt sich der eigene Key rotieren; alle anderen Sockets mit dem alten Key erhalten `protocol_error` (`token_invalidated`) und werden getrennt.
- Der Key unterliegt denselben Rollen-Berechtigungen wie der Benutzer, dem er gehört.

## REST-API-Referenz: `/api/v1`

Quelle: `src/server/server/auth-api/index.ts`. Alle Endpunkte liegen hinter `authCheck` (Cookie- oder `?key=`-Authentifizierung; nicht Eingeloggte werden mit `403` auf `/login` umgeleitet). Fehlerformat einheitlich:

```json
{ "error": { "code": "…", "message": "…" } }
```

Berechtigungsstufen: **[U]** = jeder eingeloggte Benutzer, **[M]** = benötigt `users:*` WRITE (superuser/admin), sonst `403 forbidden`.

### Benutzer & Rollen

| Methode & Pfad      | Stufe | Request-Body                                                              | Response                                               | Fehler                                                                                                                   |
| ------------------- | ----- | ------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `GET /me`           | [U]   | —                                                                         | User-Objekt + `canManageUsers: boolean`                | `401 unauthorized`                                                                                                       |
| `GET /roles`        | [U]   | —                                                                         | `[{ id, name, permissions: [{ entityId, actions }] }]` | —                                                                                                                        |
| `GET /users`        | [M]   | —                                                                         | `User[]`                                               | `403 forbidden`                                                                                                          |
| `POST /users`       | [M]   | `{ name: string, password: string, roles?: string[], enabled?: boolean }` | `201` + User-Objekt                                    | `400 invalid_request` (name/password fehlt, roles kein String-Array), `400 unknown_role`, `409 conflict` (Name vergeben) |
| `PATCH /users/:id`  | [M]   | `{ name?, password?, roles?, enabled? }` (alle optional)                  | User-Objekt                                            | `404 not_found`, `400 invalid_request`, `400 unknown_role`, `409 conflict`, `409 last_admin`                             |
| `DELETE /users/:id` | [M]   | —                                                                         | `204` (löscht auch Identitäten, API-Keys, Sessions)    | `404 not_found`, `409 last_admin`                                                                                        |

User-Objekt: `{ id, name, created_at, enabled, totp_enabled, roles: string[] }`.

Besonderheiten:

- `PATCH` mit `enabled: false` beendet zusätzlich alle aktiven Sessions des Benutzers (inkl. Socket-Disconnect).
- **Last-Admin-Guard** (`409 last_admin`): Der letzte aktivierte Benutzer mit Rolle `superuser` oder `admin` kann weder gelöscht noch deaktiviert noch auf eine Nicht-Admin-Rolle degradiert werden.

### 2FA

| Methode & Pfad              | Stufe | Request-Body        | Response                      | Fehler                                                                      |
| --------------------------- | ----- | ------------------- | ----------------------------- | --------------------------------------------------------------------------- |
| `POST /me/2fa/enroll`       | [U]   | —                   | `{ secret, otpauthUrl }`      | `409 already_enrolled` (2FA bereits aktiv), `404 not_found`                 |
| `POST /me/2fa/verify`       | [U]   | `{ token: string }` | User-Objekt (2FA jetzt aktiv) | `400 invalid_request` (token fehlt), `400 not_enrolled`, `400 totp_invalid` |
| `DELETE /me/2fa`            | [U]   | `{ token: string }` | User-Objekt (2FA deaktiviert) | `400 not_enrolled`, `400 invalid_request`, `400 totp_invalid`               |
| `POST /users/:id/2fa/reset` | [M]   | —                   | `204`                         | `404 not_found`                                                             |

### Sessions

| Methode & Pfad                          | Stufe | Response                                                           | Fehler                             |
| --------------------------------------- | ----- | ------------------------------------------------------------------ | ---------------------------------- |
| `GET /me/sessions`                      | [U]   | `Session[]` (nur nicht abgelaufene; `current` markiert die eigene) | —                                  |
| `DELETE /me/sessions/:sessionId`        | [U]   | `204` (trennt zugehörige Sockets)                                  | `404 not_found` (nicht die eigene) |
| `GET /users/:id/sessions`               | [M]   | `Session[]`                                                        | `404 not_found`                    |
| `DELETE /users/:id/sessions/:sessionId` | [M]   | `204`                                                              | `404 not_found`                    |

Session-Objekt: `{ id, expiredAt, createdAt?, ip?, userAgent?, current }`.

### Sonstiges

- Unbekannte `/api/v1`-Pfade antworten mit `404 not_found` („Unknown API endpoint.“).
- Unerwartete Serverfehler enden im generischen Express-Fehlerhandler (`500`).

## Sicherheitsverhalten

- **Viewer-Schreibablehnung**: Bei aktiviertem Login prüft der Server jede Schreiboperation eines Sockets gegen die Rollen (`canSocketWrite`, `src/server/util/socket-write-guard.ts`). Ohne WRITE-Recht wird das Acknowledgement mit einem Fehler beantwortet, die Verbindung bleibt bestehen:
  - Messages (`entityId messages:<bundle>`): Ack-Fehler `"Unauthorized: sending messages requires WRITE permission"`; Extension-Handler werden nicht aufgerufen.
  - Replicant-Änderungen (`entityId replicants:<namespace>:<name>`): Ack-Fehler `"Unauthorized: modifying replicants requires WRITE permission"` plus Full-Update mit dem Serverstand, damit der Client seinen lokalen Wert zurücksetzt.
  - Lesen/Abonnieren von Replicants bleibt für Viewer uneingeschränkt möglich.
- **`user_disabled`**: Deaktivierte Benutzer können sich nicht einloggen; beim Deaktivieren werden bestehende Sessions sofort beendet und Sockets getrennt.
- **Last-Admin-Guard**: verhindert, dass die Instanz ohne verwaltungsberechtigten Benutzer zurückbleibt (siehe oben).
- **Geschützter Namespace `users:`**: selbst `operator` mit globalem `*`-WRITE kann die Benutzerverwaltungs-API nicht nutzen.
- Bei deaktiviertem Login (`login.enabled: false`) sind sämtliche Checks aus; `/login*` leitet aufs Dashboard um.
