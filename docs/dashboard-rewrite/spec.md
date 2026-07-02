# Dashboard-Rewrite: Bestandsaufnahme Polymer-Dashboard (Spezifikation)

Grundlage für den React-Neubau. Erstellt 2026-07-03 aus dem Polymer-3-Bestand.

## 1. Komponenten-Hierarchie (Bestand)

```
ncg-dashboard (Root Container)
├── ncg-workspace (pro Workspace)
│   ├── ncg-dashboard-panel (pro Panel)
│   │   └── <iframe src="/bundles/{bundle}/dashboard/{panel.file}">
├── ncg-graphics → ncg-graphics-bundle → ncg-graphic → ncg-graphic-instance (+ -diff)
├── ncg-mixer → ncg-sounds → ncg-sound-cue (+ ui-select)
├── ncg-assets → ncg-asset-category (+ ncg-asset-file, vaadin-upload)
├── ncg-settings
└── #dialogs: ncg-dialog (pro Dialog mit iframe)
```

## 2. Kern-Verhalten

### ncg-dashboard (Root)

- Hash-Routing (app-location), Breakpoint 640px (Drawer auf Mobile)
- Daten: `window.__renderData__.bundles`, `window.__renderData__.workspaces`
- Pages: Workspaces + Graphics, Mixer, Assets, Settings
- Socket-Events → Toasts: `disconnect` („Lost connection"), `reconnect_attempt`, `reconnect`, `reconnect_failed`; `protocol_error` (UnauthorizedError) → Redirect `/authError?code=...&message=...`
- Logout: `window.location.href = "/logout"`

### ncg-workspace

- Masonry-Layout: Packery (columnWidth 128, gutter 16) + Draggabilly (Handle `#dragHandle`)
- Panel-Reihenfolge persistiert: `localStorage['{workspace}_workspace_panel_sort_order']` (JSON-Array der Panelnamen)
- fullbleed-Workspaces: ein Panel, volle Fläche, kein Packery

### ncg-dashboard-panel

- Attribute: bundle, panel, displayTitle, headerColor, width (1–10 → 128×n + 16×(n−1) px), opened, fullbleed
- Collapse-State persistiert: Key `{bundle}.{panel}.opened`
- Header-Buttons: Standalone öffnen (`?standalone=true`), Collapse-Toggle, Drag-Handle
- iframe-Resize via @open-iframe-resizer/core, Event `iframe-resized` aufs iframe dispatchen
- Sentry-Fehlerweiterleitung aus iframe.contentWindow wenn `ncgConfig.sentry.enabled`

### ncg-dialog

- Modal mit Backdrop, ESC-Close, iframe-Inhalt, Confirm/Dismiss-Buttons
- Custom Events an iframe.contentDocument: `dialog-opened`, `dialog-confirmed`, `dialog-dismissed`
- **Öffentlicher Vertrag**: `window.dashboardApi.getDialog(name)` liefert ein Element mit imperativem `open()`/`close()`; `getDialogDocument(name)` liefert das iframe-Document. Bundles rufen `.open()` selbst auf (dialog_opener.js).

### Graphics-Seite

- Replicant `graphics:instances` (ns `mooncg`)
- Socket: `graphic:requestBundleRefresh` (bundleName), `graphic:kill`, `graphic:reload` ({bundleName, pathName, instance})
- Status-Farben: nominal #00A651, out-of-date #FFC700, inaktiv #CACACA; URL kopieren mit Toast

### Mixer-Seite

- Replicants: `volume:master` (ns `_sounds`, 0–100), `volume:{bundle}` (ns `_sounds`), `soundCues` (ns {bundle}), `assets:sounds` (ns {bundle})
- Fader (two-way), Datei-Auswahl pro Cue

### Assets-Seite

- Replicants: `collections` (ns `_assets`), `assets:{categoryName}` (ns {collectionName})
- Upload: POST multipart an `/assets/{collectionName}/{categoryName}` (multer), Accept-Filter aus `category.allowedTypes`
- Delete: HTTP DELETE auf File-URL

### Settings-Seite

- `window.token`, Copy Key, Show Key, Reset Key (Socket `regenerateToken`, danach reload)

## 3. Bootstrapping / Globals (Server-injiziert via dashboard.tmpl)

```
window.__mooncg__ = true
globalThis.ncgConfig = <FilteredConfig>
window.__renderData__ = { bundles, workspaces }
window.token = <string>
window.socket (socket.js), window.MoonCG (api.js)
window.dashboardApi = new MoonCG(...) — im Dashboard-Bundle erzeugt
```

Script-Reihenfolge im Template: inline Globals → soundjs → socket.js → api.js → dashboard.js (IIFE-Bundles aus tsdown).

## 4. Server-Verträge (NICHT ändern)

- GET /dashboard (authCheck) rendert dashboard.tmpl mit {bundles, publicConfig, privateConfig, workspaces, sentryEnabled}
- GET /bundles/:bundle/dashboard/** mit injectscripts (Panels/Dialogs bekommen CSS/Socket/API injiziert)
- Login-Seite ist server-gerendertes Template (kein Polymer): IDs #username, #password, #localSubmit; OAuth-Routen /login/steam|twitch|discord; GET /logout → 302 /login

## 5. Test-Verträge (E2E)

- Bisher: `document.querySelector("ncg-dashboard").shadowRoot…ncg-dashboard-panel[bundle=…][panel=…]` → beim Rewrite auf `data-testid`-basierte Selektoren umstellen UND Tests anpassen
- `window.dashboardApi.getDialog/getDialogDocument` müssen funktionieren (api.client.ts anpassen)
- Login-Formular-IDs bleiben
- `window.WebComponentsReady`-Vertrag entfällt → Tests, die darauf warten, umstellen

## 6. Entschiedene Rewrite-Leitplanken

- React 19, kein zusätzliches UI-Framework (eigenes CSS, bestehende Dark-Theme-Variablen --mooncg-* weiterverwenden)
- Build weiterhin tsdown (TSX), gleiche IIFE-Entry-Namen (dashboard.js etc.)
- Panel-Layout: CSS Grid (128px-Spalten, dense) + @dnd-kit für Drag-Sortierung, gleiche localStorage-Keys
- iframe-Resize weiter mit @open-iframe-resizer/core
- Upload: eigene Dropzone + fetch (ersetzt vaadin-upload)
- Clipboard: navigator.clipboard (ersetzt clipboard.js)
- Dialoge: natives <dialog> mit imperativem Handle (open/close aufs DOM-Element)
- Entfernen: @polymer/_, iron-_/paper-*, @vaadin/vaadin-upload, draggabilly, packery, clipboard.js
