# API-Referenz: das `mooncg`-Objekt

MoonCG stellt Bundles in zwei Kontexten eine API-Instanz bereit:

- **Extension-Kontext (Server)**: Die Extension exportiert eine Funktion, die die Instanz erhält — `module.exports = function (mooncg) { … }` (Klasse aus `src/server/api.server.ts`).
- **Panel-/Graphic-Kontext (Client)**: In Panels/Dialogen/Graphics existiert `globalThis.mooncg` (fertige Instanz für das Bundle) sowie die Klasse `window.MoonCG` (`src/client/api/api.client.ts`). Panels/Dialoge teilen sich den Socket des Dashboards, Graphics bauen einen eigenen auf ([Details](bundle-entwicklung.md#panels-dialoge-standalone)).

## Gemeinsame Basis (beide Kontexte)

Aus `src/shared/api.base.ts`:

| Member                                                         | Beschreibung                                                                                           |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `mooncg.bundleName: string`                                    | Name des Bundles dieser Instanz                                                                        |
| `mooncg.bundleConfig`                                          | Geparste Bundle-Config (`cfg/<bundle>.json`, tief readonly)                                            |
| `mooncg.bundleVersion?: string`                                | `version` aus der Bundle-`package.json`                                                                |
| `mooncg.bundleGit`                                             | Git-Infos des Bundles (`branch`, `hash`, `shortHash`, ggf. `date`, `message`) oder `undefined`         |
| `mooncg.log`                                                   | Logger-Instanz: `trace`, `debug`, `info`, `warn`, `error` (Level aus `cfg/mooncg.json`)                |
| `mooncg.Logger`                                                | Logger-Klasse für eigene benannte Logger: `new mooncg.Logger("mein-modul")`                            |
| `mooncg.listenFor(messageName[, bundleName], handler)`         | Registriert einen Message-Handler (mehrere pro Message erlaubt, Aufruf in Registrierungsreihenfolge)   |
| `mooncg.unlisten(messageName[, bundleName], handler): boolean` | Entfernt einen Handler; `true` bei Erfolg                                                              |
| `mooncg.Replicant(name[, namespace][, opts])`                  | Deklariert einen Replicant (siehe unten); `namespace` default: eigener Bundle-Name                     |
| `MoonCG.version` (statisch)                                    | MoonCG-Version (aus der package.json)                                                                  |
| `MoonCG.waitForReplicants(...reps): Promise<void>` (statisch)  | Wartet, bis alle übergebenen Replicants ihr erstes `change` gefeuert haben — nur clientseitig sinnvoll |

```js
mooncg.listenFor("printMessage", (message) => {
	console.log(message);
});
mooncg.listenFor("printMessage", "another-bundle", (message) => { … });
```

## Extension-Kontext (Server)

```js
// bundles/mein-bundle/extension.js
module.exports = function (mooncg) {
  const counter = mooncg.Replicant("counter", { defaultValue: 0 });
  mooncg.listenFor("increment", (_data, ack) => {
    counter.value++;
    if (ack && !ack.handled) {
      ack(null, counter.value);
    }
  });
};
```

### Methoden & Properties

| Member                                                              | Beschreibung                                                                                                                             |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `mooncg.sendMessage(messageName[, data]): void`                     | Sendet eine Message im eigenen Bundle-Namespace an alle Kontexte (Clients + andere Extensions)                                           |
| `mooncg.sendMessageToBundle(messageName, bundleName[, data]): void` | Wie `sendMessage`, aber in fremdem Bundle-Namespace; auch statisch verfügbar                                                             |
| `mooncg.readReplicant(name[, namespaceOderBundle])`                 | Liest einen Replicant-Wert **synchron** (Extensions haben direkten Zugriff); auch statisch: `Klasse.readReplicant(name, namespace)`      |
| `mooncg.Replicant(name[, namespace][, opts])`                       | Liefert einen `ServerReplicant`; statisch: `Klasse.Replicant(name, namespace, opts)`                                                     |
| `mooncg.config`                                                     | Die **volle** Server-Config inkl. Secrets (tief readonly Kopie)                                                                          |
| `mooncg.mount(...)`                                                 | Mountet Express-Middleware in die Haupt-App (nach allen internen Middlewares); wird bei Extension-Hot-Reload automatisch wieder entfernt |
| `mooncg.Router`                                                     | `express.Router` — zum Erstellen eigener Router für `mooncg.mount`                                                                       |
| `mooncg.util.authCheck`                                             | Express-Middleware, die prüft, ob die Session eingeloggt und berechtigt ist (bei deaktiviertem Login: Durchlass)                         |
| `mooncg.extensions`                                                 | Referenzen auf alle geladenen Extensions; Zugriff auf fremde Extensions erfordert einen Eintrag in `mooncg.bundleDependencies`           |
| `mooncg.getSocketIOServer()`                                        | Der Socket.IO-Root-Namespace des Servers                                                                                                 |

```js
// Eigene HTTP-Route:
const router = mooncg.Router();
router.get("/mein-bundle/hello", (req, res) => res.send("hi"));
mooncg.mount(router);

// Geschützte Route:
router.get("/mein-bundle/secret", mooncg.util.authCheck, (req, res) => { … });
```

### Lifecycle-Events

Die Server-Instanz ist ein Event-Emitter (`mooncg.on(event, handler)`), Events aus `ExtensionEventMap` (`src/server/server/extensions.ts`):

| Event               | Payload      | Wann                                                                                                                                     |
| ------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `extensionsLoaded`  | —            | Alle Extensions wurden beim Start geladen (wird bei Hot Reload **nicht** erneut emittiert)                                               |
| `serverStarted`     | —            | Der HTTP-Server nimmt Verbindungen an                                                                                                    |
| `serverStopping`    | —            | Der Server fährt herunter                                                                                                                |
| `login`             | `user`       | Ein Benutzer mit mindestens einer Rolle hat sich eingeloggt                                                                              |
| `logout`            | `user`       | Ein Benutzer mit mindestens einer Rolle hat sich ausgeloggt                                                                              |
| `bundleUnloading`   | —            | Nur an die betroffene Instanz, direkt vor dem Hot-Reload-Entladen — [Aufräum-Vertrag](bundle-entwicklung.md#der-bundleunloading-vertrag) |
| `extensionReloaded` | `bundleName` | An alle Instanzen, nachdem eine Extension erfolgreich hot-reloadet wurde                                                                 |

### Acknowledgements (Server-Seite)

Der `listenFor`-Handler bekommt optional ein `ack` (error-first Callback). Bei mehreren Handlern für dieselbe Message zuerst `ack.handled` prüfen — ein bereits bedientes Ack erneut aufzurufen wirft:

```js
mooncg.listenFor("multiplyByTwo", (value, ack) => {
  if (ack && !ack.handled) {
    ack(null, value * 2); // oder ack(new Error("nope"))
  }
});
```

Fehler, die dem Ack übergeben werden, kommen serialisiert und intakt beim Client an.

## Panel-/Graphic-Kontext (Client)

### Messages

`sendMessage`/`sendMessageToBundle` liefern clientseitig eine Antwort — wahlweise als Promise oder error-first Callback:

```js
// Promise:
const result = await mooncg.sendMessage("multiplyByTwo", 2);

// Callback:
mooncg.sendMessage("multiplyByTwo", 2, (error, result) => { … });
```

| Member                                                       | Beschreibung                                                                            |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `mooncg.sendMessage(name[, data][, cb]): Promise \| void`    | Message im eigenen Namespace; Promise wird mit dem Ack aufgelöst/abgelehnt              |
| `mooncg.sendMessageToBundle(name, bundleName[, data][, cb])` | Message in fremdem Namespace; auch statisch                                             |
| `mooncg.readReplicant(name[, namespace], cb): void`          | Liest einen Replicant-Wert einmalig **asynchron** (Callback ist Pflicht); auch statisch |
| `mooncg.config`                                              | Die **gefilterte** Server-Config (ohne Secrets), eingefroren                            |
| `mooncg.socket`                                              | Der Socket.IO-Client-Socket der Instanz                                                 |
| `MoonCG.declaredReplicants` (statisch)                       | Alle im aktuellen `window` deklarierten Replicants, gruppiert nach Bundle               |

### Dialoge (nur Browser)

| Member                                     | Beschreibung                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `mooncg.getDialog(name[, bundle])`         | Liefert das Dialog-Element (mit `open()`, `close()`, `opened`) aus dem Dashboard oder `undefined` |
| `mooncg.getDialogDocument(name[, bundle])` | Liefert das `document` des Dialog-iframes                                                         |

### Sound-API (nur Browser, benötigt `soundCues` im Manifest)

| Member                                          | Beschreibung                                                                                                                                         |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mooncg.soundsReady: boolean`                   | `true`, sobald alle zugewiesenen Sound-Dateien geladen sind; zusätzlich feuert `window` das Event `ncgSoundsReady`                                   |
| `mooncg.findCue(cueName)`                       | Liefert den Sound-Cue oder `undefined`                                                                                                               |
| `mooncg.playSound(cueName[, { updateVolume }])` | Spielt einen Cue ab, liefert die SoundJS-Instanz; wirft, wenn Cue/Datei fehlt. `updateVolume` (Default `true`): Lautstärke folgt dem Dashboard-Mixer |
| `mooncg.stopSound(cueName)`                     | Stoppt alle laufenden Instanzen des Cues                                                                                                             |
| `mooncg.stopAllSounds()`                        | Stoppt alle Sounds der Seite                                                                                                                         |

### Fehlerverhalten

Bei einem `protocol_error` vom Typ `UnauthorizedError` (z. B. abgelaufene/beendete Session, widerrufener Token) leitet der Client automatisch auf `/authError?code=…&message=…&viewUrl=…` um.

## Replicants

Replicants replizieren einen Wert über alle Extensions, Panels und Graphics; Änderungen lösen überall ein `change`-Event aus.

```js
const myRep = mooncg.Replicant("myRep", { defaultValue: 123 });

myRep.on("change", (newValue, oldValue) => {
  console.log(`myRep: ${oldValue} → ${newValue}`);
});

myRep.value = "Hello!";
myRep.value = { objects: { can: { be: "nested!" } } };
myRep.value.objects.can.be = "mutiert!"; // Proxy: auch tiefe Mutationen replizieren
```

### Optionen (`MoonCG.Replicant.Options`)

| Option                | Typ       | Default                                | Beschreibung                                                                                                 |
| --------------------- | --------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `defaultValue`        | beliebig  | —                                      | Startwert; greift nur, wenn der Replicant weder bereits deklariert ist noch einen persistierten Wert hat     |
| `persistent`          | `boolean` | `true`                                 | Wert wird in der Datenbank persistiert und beim Serverstart wiederhergestellt                                |
| `persistenceInterval` | `number`  | `100` (ms)                             | Throttle-Intervall zwischen Persistierungen                                                                  |
| `schemaPath`          | `string`  | `bundles/<bundle>/schemas/<name>.json` | Pfad zu einem JSON Schema (relativ zum Installations-Root oder absolut); der Replicant-Name wird URI-encoded |

### Semantik

- **Deklaration pro Kontext**: Jeder Kontext (Extension, jedes Panel, jede Graphic), der einen Replicant nutzen will, muss ihn selbst deklarieren. Bei bereits deklarierten Replicants wird der bestehende Wert übernommen.
- **Schema-Validierung**: Existiert ein Schema (`schemas/<name>.json` im Bundle oder via `schemaPath`), werden alle Assignments serverseitig validiert; ungültige Werte werfen (`Invalid value rejected for replicant …`). Ohne `defaultValue` werden die Schema-Defaults als Startwert benutzt; ein persistierter Wert, der das Schema verletzt, wird beim Laden verworfen und durch die Schema-Defaults ersetzt (`src/server/replicant/server-replicant.ts`).
- **`change`-Event**: `(newValue, oldValue, operations)` — beim ersten Feuern gilt der Replicant als fertig deklariert (siehe `MoonCG.waitForReplicants`).
- **Proxy-Mutationen**: `value` ist rekursiv geproxied; Objekt-/Array-Mutationen (`push`, `splice`, Property-Zuweisungen, `delete`, …) werden als Operationen repliziert.
- **Clientseitig asynchron**: Client-Replicants haben ihren Wert erst nach dem ersten `change`; Server-Replicants sind sofort lesbar.
- **Berechtigungen**: Bei aktiviertem Login benötigen Schreiboperationen vom Client WRITE-Rechte, sonst wird das Ack mit einem Unauthorized-Fehler beantwortet (siehe [Auth-Doku](auth/benutzung.md#sicherheitsverhalten)).

## Injizierte Umgebung in Panels/Graphics

Von `src/server/util/injectscripts.ts` bereitgestellt:

| Global                      | Panels/Dialoge                             | Graphics                                     |
| --------------------------- | ------------------------------------------ | -------------------------------------------- |
| `globalThis.ncgConfig`      | gefilterte Server-Config                   | gefilterte Server-Config                     |
| `window.MoonCG`             | vom Dashboard geerbt (`window.top.MoonCG`) | eigenes `/api.js`                            |
| `window.socket`             | vom Dashboard geerbt (`window.top.socket`) | eigener Socket (`/socket.js`)                |
| `globalThis.mooncg`         | fertige API-Instanz des Bundles            | fertige API-Instanz des Bundles              |
| SoundJS (`window.createjs`) | nur im Standalone-Modus bei `soundCues`    | bei `soundCues`                              |
| `client_registration.js`    | —                                          | ja (Instanz-Registrierung, `singleInstance`) |
