# Bundle-Entwicklung

Leitfaden für das Schreiben von MoonCG-Bundles: Verzeichnisstruktur, das `mooncg`-Manifest-Feld in der `package.json`, Bundle-Konfiguration und Hot-Reload-Verhalten. Die zugehörige API (Replicants, Messages, …) ist in der [API-Referenz](api-referenz.md) beschrieben.

## Legacy- vs. Installed-Mode

- **Legacy-Mode**: Die Root-`package.json` der Installation trägt `"mooncgRoot": true`; Bundles liegen in `bundles/<bundle-name>/`. Der Ordnername **muss** dem `name` aus der Bundle-`package.json` entsprechen, sonst bricht der Parser ab („Please rename it to …").
- **Installed-Mode**: MoonCG ist als Dependency installiert; das Projekt-Root selbst ist das Bundle.

Im Legacy-Mode sind das `mooncg`-Feld und ein gültiges `mooncg.compatibleRange` (semver-Range) Pflicht; außerdem prüft der Server beim Laden, ob die laufende MoonCG-Version die Range erfüllt — sonst wird das Bundle mit einer Fehlermeldung übersprungen. Zusätzliche Bundle-Verzeichnisse lassen sich über `bundles.paths` in der Server-Config oder das CLI-Flag `--bundlesPaths` angeben; `bundles.enabled`/`bundles.disabled` wirken als White-/Blacklist.

## Bundle-Anatomie

```
bundles/mein-bundle/
├── package.json          # mit "mooncg"-Manifest-Feld (Pflicht im Legacy-Mode)
├── configschema.json     # optional: JSON Schema für die Bundle-Config
├── mooncg.config.js      # optional: JS-Config (aktuell nur databaseAdapter, experimentell)
├── dashboard/            # Panel-/Dialog-HTML (Pflicht, wenn dashboardPanels definiert)
│   ├── panel.html
│   └── dialogs/dialog.html
├── graphics/             # Graphic-HTML (Pflicht, wenn mooncg.graphics definiert)
│   └── index.html
├── extension.js          # ODER extension/ (Verzeichnis mit index.js) — nie beides
└── schemas/              # optional: JSON Schemas für Replicants (<replicantName>.json)
```

Regeln zur Extension-Datei (`bundle-parser/extension.ts`):

- Es darf **entweder** `extension.js` **oder** ein Verzeichnis `extension/` geben — beides zugleich ist ein Fehler.
- Eine _Datei_ namens `extension` (ohne `.js`) ist illegal; entweder in `extension.js` umbenennen oder ein Verzeichnis anlegen.
- Geladen wird per `require(<bundleDir>/extension)` — bei einem Verzeichnis greift also dessen `index.js`. CommonJS; `export default` (transpiliertes ESM) wird unterstützt.

## Das `mooncg`-Manifest-Feld

Die `package.json` eines Bundles braucht mindestens `name` und `version`. Alle MoonCG-spezifischen Angaben stehen unter dem Schlüssel `mooncg`:

| Feld                            | Typ                         | Pflicht          | Beschreibung                                                                                                 |
| ------------------------------- | --------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------ |
| `compatibleRange`               | `string` (semver-Range)     | ja (Legacy-Mode) | Mit welchen MoonCG-Versionen das Bundle kompatibel ist, z. B. `"^2.0.0"` oder `"*"`                          |
| `dashboardPanels`               | `Panel[]`                   | nein             | Dashboard-Panels und -Dialoge (siehe unten)                                                                  |
| `graphics`                      | `Graphic[]`                 | nein             | Grafiken (siehe unten)                                                                                       |
| `assetCategories`               | `AssetCategory[]`           | nein             | Kategorien für den Asset-Upload im Dashboard                                                                 |
| `soundCues`                     | `SoundCue[]`                | nein             | Sound-Cues für die Sound-API/Mixer-Seite                                                                     |
| `mount`                         | `Mount[]`                   | nein             | Zusätzliche statische Verzeichnisse, die MoonCG ausliefert                                                   |
| `bundleDependencies`            | `Record<string, string>`    | nein             | Abhängigkeiten auf andere Bundles: Bundle-Name → semver-Range                                                |
| `transformBareModuleSpecifiers` | `boolean` (Default `false`) | nein             | **Deprecated**, wird in v3 entfernt; beim Start erscheint eine Warnung mit Migrationshinweis auf Import Maps |

Außerdem übernimmt MoonCG `license`, `description`, `homepage`, `author` und `contributors` aus der `package.json` in das geparste Manifest.

### `dashboardPanels`

Jedes Panel-Objekt (`bundle-parser/panels.ts`, Typ `UnparsedPanel` in `src/types/mooncg.ts`):

| Feld            | Typ                                                | Pflicht | Default     | Beschreibung                                                                                       |
| --------------- | -------------------------------------------------- | ------- | ----------- | -------------------------------------------------------------------------------------------------- |
| `name`          | `string`                                           | ja      | —           | Eindeutiger Panel-Name innerhalb des Bundles (Duplikate → Fehler)                                  |
| `title`         | `string`                                           | ja      | —           | Anzeigename im Dashboard                                                                           |
| `file`          | `string`                                           | ja      | —           | Pfad der HTML-Datei relativ zu `dashboard/`; Datei muss existieren                                 |
| `width`         | `number`                                           | nein    | `1`         | Breite in Rastereinheiten; bei `fullbleed` verboten                                                |
| `headerColor`   | `string`                                           | nein    | `"#525F78"` | Farbe der Panel-Kopfzeile                                                                          |
| `workspace`     | `string`                                           | nein    | `"default"` | Workspace-Zuordnung (wird lowercased); Namen mit Präfix `__mooncg` sind reserviert                 |
| `fullbleed`     | `boolean`                                          | nein    | `false`     | Panel bekommt einen eigenen Workspace in voller Größe; schließt `width`, `workspace`, `dialog` aus |
| `dialog`        | `boolean`                                          | nein    | `false`     | Panel wird als modaler Dialog geöffnet statt in einen Workspace gelegt; schließt `workspace` aus   |
| `dialogButtons` | `{ name: string; type: "dismiss" \| "confirm" }[]` | nein    | —           | Buttons am Dialogrand (nur bei `dialog: true`)                                                     |

Validierungsregeln (führen zu Startfehlern):

- Existiert ein `dashboard/`-Ordner, aber kein `mooncg.dashboardPanels` → Fehler.
- Jede Panel-HTML-Datei braucht `<!DOCTYPE html>` (sonst funktioniert das Panel-Resizing nicht → Fehler).
- Unzulässige Kombinationen: `dialog`+`workspace`, `dialog`+`fullbleed`, `fullbleed`+`workspace`, `fullbleed`+`width`.

### `graphics`

Jedes Graphic-Objekt (`bundle-parser/graphics.ts`):

| Feld             | Typ       | Pflicht | Default | Beschreibung                                                                   |
| ---------------- | --------- | ------- | ------- | ------------------------------------------------------------------------------ |
| `file`           | `string`  | ja      | —       | HTML-Datei relativ zu `graphics/`; pro Bundle eindeutig; Datei muss existieren |
| `width`          | `number`  | ja      | —       | Breite in Pixeln (Anzeige auf der Graphics-Seite)                              |
| `height`         | `number`  | ja      | —       | Höhe in Pixeln                                                                 |
| `singleInstance` | `boolean` | nein    | `false` | Nur eine offene Instanz erlaubt; weitere Aufrufe landen auf einer „Busy“-Seite |

Ein `graphics/`-Ordner ohne `mooncg.graphics` ist ein Fehler — und umgekehrt. Die URL jeder Grafik lautet `/bundles/<bundle>/graphics/<file>`.

### `assetCategories`

| Feld           | Typ        | Pflicht | Beschreibung                                                         |
| -------------- | ---------- | ------- | -------------------------------------------------------------------- |
| `name`         | `string`   | ja      | Kategorie-Schlüssel; `"sounds"` ist reserviert (Fehler)              |
| `title`        | `string`   | ja      | Anzeigename auf der Assets-Seite                                     |
| `allowedTypes` | `string[]` | nein    | Erlaubte Dateiendungen (z. B. `["jpg", "png"]`); muss ein Array sein |

Hochgeladene Dateien erscheinen im Replicant `assets:<kategorie>` (Namespace = Bundle-Name).

### `soundCues`

| Feld            | Typ       | Pflicht | Default | Beschreibung                                                                |
| --------------- | --------- | ------- | ------- | --------------------------------------------------------------------------- |
| `name`          | `string`  | ja      | —       | Cue-Name (Fehler, wenn er fehlt)                                            |
| `assignable`    | `boolean` | nein    | `true`  | Ob auf der Mixer-Seite eine Sound-Datei zugewiesen werden kann              |
| `defaultVolume` | `number`  | nein    | —       | Ausgangslautstärke; wird auf den Bereich 0–100 geklemmt                     |
| `defaultFile`   | `string`  | nein    | —       | Standard-Sounddatei relativ zum Bundle-Root; muss existieren (sonst Fehler) |

### `mount`

| Feld        | Typ      | Pflicht | Beschreibung                                   |
| ----------- | -------- | ------- | ---------------------------------------------- |
| `directory` | `string` | ja      | Verzeichnis relativ zum Bundle-Root            |
| `endpoint`  | `string` | ja      | URL-Segment; abschließende `/` werden entfernt |

Die Dateien werden unter `/bundles/<bundle>/<endpoint>/*` ausgeliefert — hinter dem Login (`authCheck`), wenn Login aktiviert ist (`src/server/server/mounts.ts`).

### `bundleDependencies`

```json
"mooncg": {
  "bundleDependencies": { "other-bundle": "^1.0.0" }
}
```

Extensions werden in Abhängigkeitsreihenfolge geladen; erst wenn alle `bundleDependencies` (nach Name **und** semver-Range gegen die geladene Version) erfüllt sind, wird die eigene Extension gemountet. Bundles mit unerfüllbaren Abhängigkeiten werden mit einer Fehlermeldung entladen. Nur deklarierte Abhängigkeiten dürfen über `mooncg.extensions["other-bundle"]` auf fremde Extensions zugreifen.

### `mooncg.config.js` (optional)

Eine CommonJS-Datei im Bundle-Root, die ein Objekt exportiert (`export default` wird unterstützt). Einziges ausgewertetes Feld ist derzeit `databaseAdapter` — ein experimentelles Feature, um den Datenbank-Adapter des Servers zu ersetzen (nur ein Bundle pro Installation darf das tun; der Server warnt, dass sich das API ohne Major-Bump ändern kann).

## Bundle-Konfiguration (`cfg/<bundle>.json` + `configschema.json`)

Pro Bundle sucht MoonCG im `cfg/`-Verzeichnis der Installation (cosmiconfig) nach — in dieser Reihenfolge:

```
cfg/<bundleName>.json
cfg/<bundleName>.yaml
cfg/<bundleName>.yml
cfg/<bundleName>.js
cfg/<bundleName>.config.js
```

Liegt im Bundle-Root eine `configschema.json` (JSON Schema), gilt:

- **Ohne User-Config**: Die `default`-Werte aus dem Schema bilden die Config.
- **Mit User-Config**: Die User-Config wird validiert; Schema-Defaults werden ergänzt, sofern sie die Config nicht invalidieren. Eine am Ende ungültige Config bricht das Laden ab: `Config for bundle "<name>" is invalid: …` mit den formatierten Schema-Fehlern.

Die fertige Config steht der Extension und den Panels/Graphics als `mooncg.bundleConfig` zur Verfügung (einmalig beim Serverstart gelesen; bei Hot Reload eines Bundles neu eingelesen, da das Bundle neu geparst wird).

## Panels, Dialoge, Standalone

Panels und Dialoge werden als iframes unter `/bundles/<bundle>/dashboard/<file>` ausgeliefert. MoonCG injiziert dabei automatisch (`src/server/util/injectscripts.ts`):

- `globalThis.ncgConfig` — die gefilterte Server-Config (ohne Secrets)
- `window.MoonCG = window.top.MoonCG` und `window.socket = window.top.socket` — Panels/Dialoge teilen sich API-Klasse und Socket des Dashboards
- `globalThis.mooncg` — eine fertige API-Instanz für das Bundle (Name, Bundle-Config, Version, Git-Info)
- Default-Styles (`panel-and-dialog-defaults.css`, plus Panel- bzw. Dialog-Defaults) und für Panels den `dialog_opener.js`
- SoundJS, wenn das Bundle `soundCues` hat (nur Standalone/Graphics; Panels erben Sound über das Dashboard)

**Dialoge** (`dialog: true`) landen nicht in einem Workspace, sondern werden über `mooncg.getDialog("name").open()` (bzw. Elemente mit dem `dialog_opener`) modal geöffnet; `dialogButtons` definieren Confirm-/Dismiss-Buttons, die Events `dialog-confirmed`/`dialog-dismissed` in das iframe-Document dispatchen.

**Standalone**: Jedes Panel lässt sich mit `?standalone=true` direkt im Browser öffnen. Dann lädt es eigene `/api.js`- und `/socket.js`-Skripte statt sie vom Dashboard zu erben.

**Graphics** binden immer eigene Skripte ein (`/socket.io/socket.io.js`, `/socket.js`, `/api.js`, bei `soundCues` SoundJS) und erhalten zusätzlich `client_registration.js` für die Instanz-Registrierung/`singleInstance`-Logik.

## Replicant-Schemas

Legt ein Bundle `schemas/<replicantName>.json` an (Name URI-encoded), wird jeder gleichnamige Replicant serverseitig gegen dieses JSON Schema validiert; ungültige Assignments werfen. Hat der Replicant keinen `defaultValue`, werden die Defaults aus dem Schema als Startwert benutzt; persistierte Werte, die das Schema nicht mehr erfüllen, werden beim Laden verworfen und durch die Schema-Defaults ersetzt. Details: [API-Referenz → Replicants](api-referenz.md#replicants).

## Hot Reload

MoonCG watcht pro Bundle: `package.json`, `dashboard/`, `extension/` bzw. `extension.js` und `.git` (`bundle-service.ts`). Verhalten je Änderung (jeweils debounced):

| Änderung an …                      | Effekt                                                                                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `package.json` oder Panel-HTML     | Bundle wird neu geparst; bei `hotReload.dashboard` (Default an) laden offene Panels/Dialoge des Bundles neu, bei `hotReload.graphics` (Default aus) auch offene Graphics |
| `extension/`-Code / `extension.js` | Bei `hotReload.extensions` (Default an): Extension wird zur Laufzeit neu geladen — **ohne** Manifest-Reparse                                                             |
| `.git` (Commit, Branch-Wechsel, …) | Git-Metadaten des Bundles (`bundleGit`) werden aktualisiert                                                                                                              |

### Extension-Reload im Detail

- Der Reload **kaskadiert topologisch**: Erst werden alle (transitiv) abhängigen Extensions entladen, dann das geänderte Bundle; geladen wird in umgekehrter Reihenfolge.
- **Replicant-State überlebt** den Reload — nur die von der Extension registrierten Listener werden entfernt.
- Über `mooncg.mount()` registrierte Routen werden beim Reload entfernt und von der neuen Extension neu registriert.
- Schlägt das Neuladen fehl, bleibt das Bundle laufen (Graphics/Dashboard funktionieren weiter), aber die Extension bleibt bis zur nächsten erfolgreichen Änderung entladen (Warn-Log).
- Nur CommonJS-Extensions sind hot-reload-fähig (require-Cache-Invalidierung); ESM ist nicht unterstützt.
- Nach erfolgreichem Reload erhalten **alle** API-Instanzen das Event `extensionReloaded` mit dem Bundle-Namen — nützlich für Dependents, die z. B. eine gecachte Referenz aus `mooncg.extensions` erneuern wollen.

### Der `bundleUnloading`-Vertrag

Unmittelbar vor dem Entladen erhält die betroffene API-Instanz das Event `bundleUnloading`. Extensions **müssen** darin alle selbst angelegten Ressourcen aufräumen (Timer, Sockets, DB-Handles, Child-Prozesse) — nicht aufgeräumte Ressourcen leaken:

```js
// bundles/mein-bundle/extension.js
module.exports = function (mooncg) {
  const interval = setInterval(() => {
    mooncg.sendMessage("tick");
  }, 1000);

  mooncg.on("bundleUnloading", () => {
    clearInterval(interval);
  });
};
```

Replicant-`change`-Listener und `listenFor`-Handler räumt MoonCG dagegen automatisch ab (siehe `hot-reload-bundle` in den Test-Fixtures als vollständiges Beispiel).
