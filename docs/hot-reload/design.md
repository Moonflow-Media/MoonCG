# Voller Bundle-Hot-Reload (Design)

Stand 2026-07-03. Ziel: Bundle-Änderungen ohne Server-Neustart wirksam machen — Client-Auto-Refresh (Dashboard-Panels, optional Graphics) UND Extension-Reload zur Laufzeit.

Grundlage: Bestandsaufnahme (BundleService-Events existieren; Extensions werden heute einmalig beim Start geladen; kein Teardown-Pfad; `extension/` wird nicht gewatcht; Client-Refresh nur manuell und nur für Graphics).

## Konfiguration (neu im Config-Schema)

```
hotReload: {
  dashboard: boolean (default true)   — Panels im Browser bei BundleChanged automatisch neu laden
  graphics:  boolean (default false)  — Graphics-Instanzen automatisch neu laden (Standard AUS: Live-Ausgabe!)
  extensions: boolean (default true)  — Server-Extensions bei Änderungen in extension/ neu laden
}
```

## Teil A: Client-Auto-Refresh

1. Neuer Server-Konsument von `BundleChanged`: debounced (500 ms) pro Bundle:
   - wenn `hotReload.dashboard`: `io.emit("dashboard:bundleRefresh", bundleName)` (neues Socket-Event)
   - wenn `hotReload.graphics`: `io.emit("graphic:bundleRefresh", bundleName)` (bestehendes Event, bestehende Client-Handler in client_registration.ts greifen)
2. Dashboard-Client (React `App.tsx`/`Workspace.tsx`): Listener auf `dashboard:bundleRefresh` → alle Panel-iframes dieses Bundles neu laden (React-Key des iframes erhöhen; Collapse-State/Sortierung bleiben erhalten, da localStorage). Offene Dialoge des Bundles: iframe ebenfalls neu laden.
3. Socket-Protokoll: `dashboard:bundleRefresh` in ServerToClientEvents ergänzen.

## Teil B: Extension-Reload

### Watcher

- BundleService watcht zusätzlich `path.join(bundlePath, "extension")` (Verzeichnis) und `extension.js`/`extension` als Datei-Fälle über den bestehenden Chokidar-Wrapper.
- Neues Event `ExtensionChanged { bundle }` (Data.TaggedEnum erweitern), debounced wie BundleChanged (100 ms Delay + 500 ms Backoff), NICHT über den Manifest-Reparse-Pfad (Extension-Codeänderung ändert das Manifest nicht).

### ExtensionManager-Umbau (extensions.ts + api.server.ts)

1. **Ein einziger `io.on("connection")`-Dispatcher** in serverApiFactory statt eines Handlers pro API-Instanz: Der Dispatcher registriert pro Socket EINEN `message`-Handler, der über `apiContexts` iteriert (behebt zugleich den `setMaxListeners(75)`-Workaround in server/index.ts — entfernen).
2. **Instanz-Teardown** `destroyApiInstance(instance)`:
   - `apiContexts.delete(instance)`, `apiInstances.delete(instance)`
   - `instance.removeAllListeners()` (TypedEmitter), `_messageHandlers.length = 0`
   - alle von der Instanz registrierten Replicant-Listener entfernen (siehe unten)
   - per-Bundle-Mount-Router leeren (siehe unten)
3. **Replicant-Listener-Tracking**: Die per-Instanz `_replicantFactory` gibt weiterhin die geteilte ServerReplicant-Instanz zurück, aber verpackt in einen leichten Proxy, der `on/once/addListener/prependListener` abfängt und die (event, listener)-Paare in der API-Instanz registriert; `off/removeListener` entfernt sie aus dem Tracking. Beim Teardown werden alle getrackten Listener vom echten Replicant gelöst. (`declaredReplicants` und Replicant-STATE bleiben unangetastet — gewünschtes Verhalten: State überlebt Reload.)
4. **Entfernbare Mounts**: `mount` der API-Instanz schreibt nicht mehr direkt in die Haupt-App, sondern in einen per-Bundle-Wrapper-Router (`Router()`), der einmal in die App gemountet wird. Teardown ersetzt den Wrapper-Inhalt (`router.stack.length = 0` vermeiden — stattdessen indirekter Dispatch: App mountet eine stabile Middleware, die an den aktuellen per-Bundle-Router delegiert; Reload tauscht die Referenz).
5. **Neues Extension-Lifecycle-Event** `bundleUnloading` (nur an die betroffene Instanz): Vertrag für Extensions, eigene Ressourcen (Timer, Sockets, DB-Handles) aufzuräumen. In ExtensionEventMap + Doku.
6. **require.cache-Invalidierung**: rekursiv alle Cache-Einträge löschen, deren Dateipfad unter `bundle.dir` liegt (isChildPath nutzen); zusätzlich deren Eltern-`children`-Arrays bereinigen. Node-Interna kapseln in `util/module-cache.ts`.
7. **Reload-Sequenz** `reloadExtension(bundleName)`:
   1. Abbruch, wenn Bundle keine Extension hat oder `hotReload.extensions` aus
   2. Dependents ermitteln (Bundles, deren `bundleDependencies` das Bundle enthalten und die selbst eine geladene Extension haben) → Reload kaskadiert topologisch (erst Dependents entladen, dann Ziel, Laden in umgekehrter Reihenfolge)
   3. je Instanz: `bundleUnloading` emittieren → `destroyApiInstance` → `delete extensions[name]`
   4. require.cache für betroffene Bundle-Verzeichnisse purgen
   5. neu laden wie beim Start (require, new ExtensionApi, extensions[name] setzen, Mount-Wrapper neu verbinden)
   6. Fehler beim Neuladen: Warn-Log + `InvalidBundle`-Publikation; Bundle bleibt (Graphics/Dashboard laufen weiter), Extension bleibt bis zur nächsten erfolgreichen Änderung entladen
   7. Erfolg: Log + `extensionsLoaded` NICHT global re-emittieren (Semantik „alle geladen beim Start" bleibt); stattdessen neues Event `extensionReloaded` an alle Instanzen (Signal für Abhängige)
8. **Konsument**: server/index.ts (oder ExtensionManager selbst) abonniert `ExtensionChanged` aus dem BundleService-PubSub → `reloadExtension` (Effect-Konventionen: Stream + forkScoped, eager PubSub.subscribe wie bei den anderen Konsumenten).

### Bekannte, dokumentierte Grenzen

- Dependents, die sich Referenzen auf `mooncg.extensions[x]` zur Load-Zeit in lokale Variablen kopiert haben, sehen bis zu ihrem eigenen (kaskadierten) Reload die alte Referenz — Kaskade minimiert das.
- Ressourcen, die eine Extension nicht in `bundleUnloading` aufräumt, leaken (dokumentierter Vertrag).
- ESM-Extensions (import) sind nicht cache-invalidierbar — Extensions sind heute CJS (require-Pfad); ESM bleibt unsupported für Hot-Reload (Warn-Log).

## Tests (Pflicht)

- Unit (bundle-service.test.ts erweitern): Änderung unter `extension/` → `ExtensionChanged`-Event (debounced, kein BundleChanged)
- Unit: module-cache purge (Fixture-Module in Temp-Dir, require → ändern → purge → require liefert neue Version)
- E2E (legacy-mode, neue Datei hot-reload.test.ts, eigenes Fixture-Bundle mit Extension + Panel):
  - Extension-Datei zur Laufzeit ändern → neuer listenFor-Handler antwortet mit neuem Wert; alter Handler feuert nicht doppelt (Message-Antwort exakt einmal, neuer Inhalt)
  - Replicant-State überlebt Reload (Wert vor Änderung gesetzt, nach Reload noch da)
  - bundleUnloading wird beim Reload in der alten Instanz emittiert (Extension schreibt Marker z. B. in Replicant/Datei)
  - Panel-HTML ändern → Panel-iframe lädt automatisch neu (hotReload.dashboard=true); mit false kein Reload
  - graphics default: kein Auto-Reload der Graphic bei Änderung (hotReload.graphics default false)
- Bestehende Suite bleibt grün (insbesondere general.test.ts mount/messaging und installed-mode critical-path)
