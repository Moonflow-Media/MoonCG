# Auth-System-Ausbau: Design (Task: DB-Benutzer, Rollen, 2FA, Session-Verwaltung)

Stand 2026-07-03. Baut auf dem Bestand auf (User/Role/Identity/ApiKey/Permission-Entities in `@mooncg/database-adapter-sqlite-legacy`, TypeORM 0.3, Migrationen mit `migrationsRun: true`).

## Ziele

1. Lokale Benutzerkonten in der DB (gehashte Passwörter) statt nur statischer Config-Liste
2. Rollensystem mit durchgesetzten Berechtigungen (admin / operator / viewer, superuser bleibt)
3. TOTP-2FA für lokale Konten
4. Persistente Sessions in der DB + Verwaltung aktiver Sessions (einzeln beenden)
5. REST-API für die kommende React-Admin-UI

## Entscheidungen

### Passwort-Hashing
- **`node:crypto` scrypt** (kein natives Zusatzpaket, Windows-freundlich). Format: `scrypt$N=16384,r=8,p=1$<salt-b64>$<hash-b64>`, per-User-Salt (16 B), 32-B-Key, Vergleich mit `timingSafeEqual`.
- Legacy-Configformat (`sha256:...` HMAC mit sessionSecret, Plain) bleibt für `config.login.local.allowedUsers` funktionsfähig (Bootstrap-Pfad).

### Datenmodell (neue Migration(en), keine Breaking Changes an Bestandstabellen)
- `Identity.provider_secret: string | null` — scrypt-Hash für provider_type "local" (DB-Benutzer). Config-basierte Logins lassen das Feld null.
- `User.totp_secret: string | null`, `User.totp_enabled: boolean (default false)`
- `Session`-Entity um `user_id: string | null` + Index erweitern (für „aktive Sessions pro User")
- Seed-Migration Rollen + Permissions:
  - `admin`: Permission `entityId "*"`, actions READ|WRITE (wie superuser; zusätzlich Zugriff auf User-Management-API)
  - `operator`: `entityId "*"` READ|WRITE, aber **kein** Zugriff auf `users:*` (User-Management)
  - `viewer`: `entityId "*"` nur READ
- superuser bleibt unverändert (Vollzugriff inkl. User-Management).

### Login-Flow (local)
1. Username in DB suchen (Identity provider_type=local mit provider_secret): scrypt-Verify; User gesperrt (`User.enabled=false`? → neue Spalte `User.enabled: boolean default true`) ⇒ ablehnen.
2. Fallback: Config-`allowedUsers` wie bisher (upsert → superuser).
3. Wenn `totp_enabled`: Passport-Strategie verlangt zusätzliches Feld `totp` im Login-POST; fehlend/falsch ⇒ Fehler `totp_required`/`totp_invalid`. Login-Template bekommt optionales TOTP-Feld (`#totp`), progressive Anzeige.
4. TOTP-Lib: `otpauth` (pure JS). Enrollment: Secret generieren → otpauth-URL zurückgeben → erst nach erfolgreichem Verify `totp_enabled=true`.

### Autorisierung
- Neuer Helper im DB-Adapter: `hasPermission(user, entityId, action)` — superuser ⇒ immer true; sonst Rollen-Permissions mit Wildcard-Match (`*`, exakter Match, Präfix `users:*`).
- `authcheck` (Dashboard/HTTP): statt `isSuperUser` ⇒ mindestens eine Rolle mit READ auf `dashboard` (praktisch: jede der vier Rollen). Kein stiller Verhaltensbruch: config-basierte Logins erhalten weiterhin superuser.
- Socket-Middleware: Schreiboperationen (Replicant `proposeOperations`, `proposeAssignment`, `message`) verlangen WRITE; Viewer erhält Reads/Subscriptions, Schreibversuche ⇒ UnauthorizedError-artige Fehlerantwort im ACK (kein Disconnect).
- User-Management-API verlangt WRITE auf `users:*` (superuser/admin).

### Sessions
- Eigener kleiner express-session Store auf Basis der bestehenden `Session`-Entity (get/set/destroy/touch, `expiredAt`), ersetzt MemoryStore. `user_id` wird bei Login gesetzt (aus Passport-Session-JSON extrahiert oder beim serializeUser-Hook).
- Session-TTL: `config.login.sessionTTL` (Sekunden, Default 7 Tage) → cookie.maxAge + expiredAt.
- Verwaltung: eigene Sessions listen (Gerät = User-Agent + IP + createdAt aus JSON), einzelne Session per ID beenden; admin darf Sessions aller User beenden. Beim Beenden zugehörige Sockets trennen (protocol_error InvalidSession).

### REST-API (Express-Router `/api/v1`, JSON, authcheck + Permission-Guard)
- `GET /api/v1/me` — eigener User (id, name, roles, totp_enabled)
- `GET/POST /api/v1/users`, `PATCH/DELETE /api/v1/users/:id` — CRUD (name, password, roles, enabled). Nur `users:*` WRITE. Letzten superuser/admin nicht löschen/degradieren (Guard).
- `POST /api/v1/users/:id/2fa/reset` — 2FA zurücksetzen (admin)
- `POST /api/v1/me/2fa/enroll` → {secret, otpauthUrl}; `POST /api/v1/me/2fa/verify` {token} → aktiviert; `DELETE /api/v1/me/2fa` {token} → deaktiviert
- `GET /api/v1/me/sessions`, `DELETE /api/v1/me/sessions/:id`; `GET /api/v1/users/:id/sessions`, `DELETE ...` (admin)
- `GET /api/v1/roles` — Rollenliste
- Fehlerformat: `{ error: { code, message } }`, HTTP-Statuscodes korrekt (400/401/403/404/409).

### Config-Schema-Erweiterung
```
login.sessionTTL?: number (Sekunden, default 604800)
login.local.allowedUsers bleibt (Bootstrap); DB-Benutzer sind immer aktiv, wenn login.enabled && login.local.enabled
```

### Nicht-Ziele (bewusst)
- Kein Passwort-Reset per E-Mail (kein Mailer im Scope)
- Kein Audit-Log, kein Rate-Limiting (separater Task, wenn gewünscht)
- OAuth-Provider (steam/twitch/discord) bleiben wie bisher superuser-gebunden; Rollen-Mapping für OAuth später

## Tests (Pflicht)
- Unit: scrypt-Hash/Verify, Permission-Matching (Wildcards, Aktionen), TOTP-Verify (otpauth, feste Secrets/Zeit via fake timers)
- E2E (legacy-mode, neue Fixture-Config mit aktiviertem local login):
  - DB-User anlegen via API (als admin/superuser) → Login mit neuem User funktioniert
  - Viewer: Dashboard erreichbar, Replicant-Schreibversuch wird abgelehnt (ACK-Fehler), Read funktioniert
  - 2FA: Enroll+Verify per API, Login ohne TOTP scheitert, mit gültigem TOTP klappt (Token aus otpauth im Test generieren)
  - Sessions: zwei Logins (zwei Browser-Kontexte), Liste zeigt 2, eine beenden → betroffener Kontext ist ausgeloggt
  - Bestehende login.test.ts bleibt unverändert grün (Config-Fallback!)
