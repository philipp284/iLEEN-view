# 00 · Analyse — Sensorstream für iLEEN

**Stand: 2026-09-20** · erhoben am Code, nicht aus der Dokumentation abgeleitet.
Verfasser: planender Agent. Diese Datei beschreibt den **Ist-Zustand** und die
daraus folgenden Entscheidungspunkte — sie schreibt nichts vor.

---

## 0 · Was gleich zu Anfang nicht stimmte

Drei Namen aus dem Auftrag treffen die Wirklichkeit nicht. Die Arbeitspakete
sind davon unmittelbar betroffen, deshalb steht es vorne:

| im Auftrag | tatsächlich | Folge |
|---|---|---|
| Repo `aileen` für Issues | Es gibt kein GitHub-Repo `aileen`. Die neun Steuer-Labels (`status:*`, `needs:philipp`, `repo:backend`, `repo:frontend`) liegen **angelegt** in `philipp284/iLEEN-view` | Issues laufen über `philipp284/iLEEN-view` — dort und nirgends sonst. `philipp284/iLEEN` existiert, ist aber leer (size 0). |
| Branch `gaeco-imp` | Der Branch heißt `geaco-imp` (vertauschte Buchstaben), lokal ausgecheckt, **inhaltlich identisch mit `main`** (`git diff main..geaco-imp` ist leer) | Der Coder arbeitet auf `geaco-imp` oder auf Zweigen davon. Umbenennen wäre möglich, kostet aber den lokalen Stand des Arbeitsbaums. |
| „Backend: Python/FastAPI mit 3D-Tiles-Tiler" im selben Projekt | Das Backend liegt **nicht** in `iLEEN-view`. `iLEEN-view` enthält ausschließlich `frontend/`. Backend und Tiler leben in `~/Projekte/iLEEN` (GitLab, `origin git@gitlab.rlp.net:bim.lab/ileen.git`) | Ein Issue mit `repo:backend` beschreibt Arbeit in einem **anderen Repo als dem, in dem das Issue steht**. Das geht, muss aber im Issue-Body ausdrücklich stehen. |

---

## 1 · Der Tiler (Backend, `~/Projekte/iLEEN/backend`)

### Aufbau

FastAPI, Einstieg `backend/api/main.py`, 21 Router unter `backend/api/routes/`.
Der Tiler ist `backend/tiling/` mit Formatzweigen unter `backend/tiling/formats/`
(`ifc.py` 1091 Zeilen, `pointcloud.py`, `mesh.py`, `splat.py`).

Ausgeliefert wird aus MinIO über einen reinen Proxy: `api/routes/tiles.py`
streamt `tileset.json` und die Tile-Blobs aus dem Bucket `tiles`. Der Endpunkt
kennt den Inhalt nicht; er setzt nur Medientyp und Cache-Header.

### Wie Feature-IDs heute entstehen

`3D Tiles 1.0`, Inhaltsformat **B3DM**. Der Weg ist durchgehend:

1. `tiling/formats/ifc.py:1026 ff.` setzt die Bauteile eines Octree-Knotens zu
   einem Tile zusammen und vergibt dabei je Element einen laufenden
   `batch_id` (`enumerate(elements)`, Zeile 1037) — **tile-lokal, nicht global**.
2. `tiling/gltf.py:196, 343` schreibt diesen Index als `_BATCHID`-Attribut
   in die glTF-Primitive.
3. `tiling/b3dm.py:glb_to_b3dm()` verpackt das GLB mit Feature Table
   (`BATCH_LENGTH`) und Batch Table.
4. Die Batch Table baut `ifc.py:1078 _batch_table()` und hat **genau vier
   Spalten**:

   ```python
   {"GlobalId": [...], "IfcType": [...], "Name": [...], "Geschoss": [...]}
   ```

**Der Tiler erfindet keine eigenen IDs.** Der `batch_id` ist ein Positionsindex
im Tile und verlässt den Tiler nie als Bezeichner; der fachliche Schlüssel ist
die **IFC-GlobalId** aus `element.guid` (`ifc.py:786`). Der im Auftrag
geforderte Grundsatz ist damit im Ist-Zustand bereits eingehalten — es gibt
nichts abzuräumen.

### Was es **nicht** gibt

* **Kein `EXT_structural_metadata`**, kein `EXT_mesh_features`, kein
  `EXT_feature_metadata` — geprüft über das ganze Backend. Die einzigen Treffer
  sind `_BATCHID` und die 1.0-Batch-Table.
* **Kein 3D Tiles 1.1.** Punktwolken (`tiling/volumenwolke.py:240`) nutzen
  ebenfalls den 1.0-Weg (`BATCH_ID`/`BATCH_LENGTH` in der PNTS-Feature-Table).
* **Kein WebSocket.** `grep -rn "websocket" backend/**/*.py` ist leer; FastAPI
  spricht ausschließlich HTTP.
* **Kein Kafka.** `confluent-kafka` o. ä. steht nicht in
  `backend/requirements.txt`; die einzigen Treffer für „kafka" im Backend
  stammen aus `docker-compose.yml`-Kommentaren und dem Notiz-Modul.
* **Kein Zeitreihenspeicher.** Weder im iLEEN-Backend noch im gaeco-Stack
  (kein Influx, kein Timescale, kein Prometheus in `docker-compose-files/`).

### Wo Zustand heute schon herkommt

`api/routes/elements.py` ist die Blaupause für „mehr Daten zu einem Bauteil,
ohne sie in die Tiles zu schreiben": die vollständigen Property-Sets liegen als
`properties.sqlite` neben dem Tileset im `tiles`-Bucket, werden beim ersten
Zugriff einmal aus MinIO geholt und danach lokal über den Primärschlüssel
`global_id` abgefragt. Die Begründung steht in `semantic/properties.py` im
Dateikopf und gilt für Sensorwerte unverändert: **was sich pro Bauteil ändert
oder groß ist, gehört nicht in die Batch Table.**

---

## 2 · Das Frontend (`~/Projekte/iLEEN-view/frontend`)

### Aufbau

Klassische Skripte, kein Bündel, kein Framework: rund 60 `<script src>`-Zeilen
in `index.html` um ein globales `BimViewer`-Objekt. Vite (`vite.config.js`) ist
nur Entwicklungsserver, **Port 5190, `strictPort: true`** (die Vollfassung
belegt 5181 und läuft dauerhaft).

### Wie Tilesets geladen werden

`core.js:_backendTilesetLaden()` → `loadBackendAsset(jobId)` baut die URL
`${backendUrl}/tiles/${jobId}/tileset.json` und lädt je nach Vorabprüfung
(`detectTilesetKind()`) mit einem von drei Optionssätzen. Die geladenen
Tilesets liegen in `BimViewer.loadedAssets` unter dem Schlüssel
`backend_<jobId>`. `layerManager.js` ist ein zweiter, schlankerer Ladeweg für
Ebenen.

### Wie Features angesprochen werden

Ausschließlich über die Batch Table:
`feature.getPropertyIds()` / `feature.getProperty(name)` (`features.js`
Dateikopf, Zeile 11). `features.js:detectIFCProperties()` sucht den
Typ-Merkmalsnamen zur Laufzeit ab (`IfcType` bei Backend-Tiles, `className` bei
ion).

**Der wichtigste Befund für Sensorwerte** steht in `features.js` ab Zeile 110
und ist bereits ausformuliert: Ein `Cesium3DTileFeature` existiert nur für
Tiles, die **gerade geladen** sind; beim nächsten LOD-Wechsel ist jede direkt
gesetzte `feature.color` wieder fort. Die bestehende Hervorhebung läuft deshalb
über `Cesium3DTileStyle` des Tilesets — eine Bedingungsliste, die jedes
Nachladen übersteht. Und: **ein Tileset hat nur einen Stil**, weshalb
`_applyIFCFilterInner()` Filter und Hervorhebung gemeinsam baut.

Daraus folgt für die Zustandsanzeige zwingend: Sensorzustände werden **nicht**
an Features geschrieben, sondern in einer Tabelle gehalten und über den
Tileset-Stil (oder einen CustomShader) ausgewertet. Wer `feature.color` setzt,
baut etwas, das nach dem ersten Kameraschwenk stillschweigend aufhört zu wirken.

### Zustandsverwaltung, die es gibt

Es gibt **keinen** zentralen Store. Was existiert:

* Module halten ihren Zustand in ihrem eigenen IIFE-Bereich.
* Verständigung über `document.dispatchEvent(new CustomEvent('…'))` —
  bestehende Namen: `ileen:language-changed`, `ileen:skizzen-geaendert`,
  `tags:changed`, `views:changed`, `annotations:selected`, `pano:changed`.
  Das Präfix `ileen:` ist für hausgemachte Ereignisse üblich.
* `issues-store.js` ist die einzige bestehende **Schreib**-Anbindung ans
  Backend und zugleich das Muster für Netzwerkanbindung mit Ausfallverhalten:
  zuerst lokal, dann an `/issues`, was nicht durchgeht wird vorgemerkt und
  nachgeholt; fehlt das Backend, bleibt alles beim Alten.
* **Kein WebSocket, kein EventSource** im Frontend — geprüft über alle
  `frontend/*.js`.

### Die Steckplätze

Beide Panelgerüste sind reine Gerüste und in beiden Fassungen byte-identisch:

* **links** (Viewer): `BimViewerUI.bereichAnmelden({id, symbol, ordnung, titel,
  inhalt, beimOeffnen})` bzw. `gruppeAnmelden('models', {…})`, `ordnung` 10…90.
* **rechts** (Auswertung): `RightPanel.reiterAnmelden({id, kuerzel, symbol,
  titel, breite, aufbauen, oeffnen, schliessen})` und
  `RightPanel.brueckeAnmelden({…})`.

### Zwei Prüfsteine, die jede Frontend-Arbeit hier begrenzen

1. `frontend/tests/trennung/test-trennung.mjs` — ohne Browser, Sekunden.
   Prüft unter anderem: **keine verwaiste Datei** (jede `.js`/`.css` im
   Frontend-Wurzelverzeichnis muss in `index.html` eingebunden sein) und
   `right-panel.js` meldet selbst keinen Reiter an.
2. `frontend/tests/start/test-start.mjs` — Chrome über `puppeteer-core`,
   Dev-Server auf 5190. Prüft ausdrücklich (Zeilen 218–221):
   **„rechts ist kein Reiter angemeldet"** und **„rechts steht kein
   Werkzeugknopf"**.

**Konsequenz:** Ein Sensor-Panel als `RightPanel.reiterAnmelden(...)` in
`iLEEN-view` lässt `test-start.mjs` rot werden. Sensorik im Viewer-Repo gehört
damit **links** (`bereichAnmelden`) — oder die Trennungsregel wird bewusst
geändert. Das ist keine Geschmacksfrage, sondern eine Weichenstellung, siehe §5.

### Die Repo-Regel

`iLEEN-view/CLAUDE.md` ist darin eindeutig: *„Geändert wird in der Vollfassung,
übernommen wird hierher."* `iLEEN-view` ist eine **Teilmenge** von
`~/Projekte/iLEEN`, kein Fork. Wer hier eine Datei ändert, die es dort auch
gibt, erzeugt zwei Stände desselben Moduls. Genau drei Dateien gehen absichtlich
auseinander (`index.html`, `aufmass-panel.js`, `vite.config.js`), dazu
`config.js` (gitignored, trägt Token und Backend-Adresse).

Der Auftrag setzt den Coder aber auf `iLEEN-view/geaco-imp` an. Beides zugleich
ist nicht durchzuhalten — siehe §5, Entscheidung E1.

---

## 3 · gaeco

Quelle: eigener Durchgang durch `~/Projekte/gaeco` plus
`~/Projekte/iLEEN/GAECO-INTEGRATION.md` (Stand 2026-08-30, Release 0.9.2), deren
Befunde ich stichprobenartig am Repo nachvollzogen habe.

### Was das Repo ist — und was nicht

**Kein Quellcode.** Nur Compose-Dateien, `.env.example`, Demodaten; die Dienste
kommen als Images von `ghcr.io/gaeco-ekkodale`. Der Fork `philipp284/gaeco` hat
nur `main` und keine eigenen Commits; lokal zeigt `origin` sogar auf das
Original. **Es gibt in gaeco also keinen Client-Code und keine Minting-Regel,
die man wiederverwenden könnte** — nur Vertragsformate.

### Das Format, das zählt

Der `GraphDataModelConsumer` des InstanceService hört auf das Topic-Muster
`^.*\..*\..*\.public\..*\.gaecoImport$`, konkret
`ekkodale.gaeco.instance.public.<useCaseId>.gaecoImport`, Broker `localhost:9092`
(im Netz `gaeco-broker:29092`), **genau ein GraphDataModel-Objekt je Nachricht**,
max. 50 MB. Felder: `GraphTemplate`, `GraphData` (Turtle, Relationen),
`AccessRights`, `Guidelines`, `UseCase`, `GraphMetadata[]` mit
`{Id, ClassType, Code, PropertiesValues}`.

**Über Kafka wird `Id` übernommen** — über REST nicht (`CreateInstance` hat kein
`id`-Feld, freie Attribute werden verworfen). Das ist der ganze Grund, warum der
Kafka-Weg und nicht die REST-API der Übertragungsweg ist.

### Der Join-Key

Bereits am laufenden Stack verifiziert (laut `GAECO-INTEGRATION.md` §3):

```python
uuid.uuid5(uuid.NAMESPACE_DNS, ifc_global_id)   # → gaeco-InstanceId
```

Die Zuordnung IFC-GUID → Instanz ist damit **rein rechnerisch, ohne
Mapping-Tabelle** — und sie ist in beide Richtungen nutzbar, solange die
GlobalId in der Batch Table steht (tut sie, §1). Die Brücke „Tile-Feature ↔
gaeco-Instanz" braucht **keine Änderung am Tiler**.

Offen bleibt der **IRI-Namensraum**: Das dokumentierte Beispiel nutzt
`inst: <http://example.org/instances/>`. Ob der InstanceService einen eigenen
Basis-IRI vergibt oder den mitgelieferten übernimmt, ist am Code nicht
feststellbar (kein Quellcode) — nur am laufenden Dienst ablesbar.

### Ontologien werden über eine Link-Ontologie gekoppelt, nicht über IDs

`demodata/gaeco/gaeco.ttl` ist 14 Zeilen lang und zeigt das ganze Muster:

```turtle
links:BuildingHasIfcBuilding a owl:ObjectProperty ;
    rdfs:domain ibpdi:Building ;
    rdfs:range  ifc:IfcBuilding .
```

Zwei getrennte Instanzen, verbunden über eine erlaubte Relation. Keine
Identität, keine ID-Gleichsetzung.

### Sensorik ist in gaeco bereits vorgesehen — über Brick

`demodata/Brick/Brick+patches.ttl` (63.970 Zeilen) bringt die Brick-Ontologie
mit, inklusive `@prefix sosa:` und der vollen `brick:*_Sensor`-Hierarchie
(`brick:Sensor` und Hunderte Unterklassen), dazu
`sosa:FeatureOfInterest`/`sosa:ObservableProperty`. Es gibt dazu eine fertige
`Brick+patches.guideline`.

**Das ist der natürliche Anknüpfungspunkt für die statischen SOSA/SSN-Tripel**:
Sensor als Brick-Instanz, Bauteil als IFC-Instanz, dazwischen eine
Link-Ontologie nach dem Muster oben. Dass die Brick-Guideline tatsächlich
geladen ist und welche Klassifikations-URIs sie führt, ist nur am laufenden
Stack prüfbar.

### Betriebszustand jetzt

`docker ps` zeigt 13 Container. Von gaeco laufen: `guideline-server`,
`keycloak-server`, `ontology-postgres`, `pluginhost-postgres`,
`guideline-postgres`, `apporchestrator-*`, `gaeco-monitor-aspire`.
**Nicht laufend: `instance-server` und `gaeco-broker` (Kafka).** Ports 5000 und
5024 antworten nicht. Das iLEEN-Backend (8100) und beide Frontends (5181, 5190)
laufen.

Alles, was den Kafka-Weg oder Instanz-IRIs berührt, ist derzeit **nicht
verifizierbar**, ohne den Stack vollständig hochzufahren (inkl. der vier
Handgriffe aus `GAECO-INTEGRATION.md` §2: `sslRequired=NONE`, verschobene Ports,
AirPlay aus, Git LFS).

---

## 4 · Der Zielweg, wie er sich aus dem Ist-Zustand ergibt

```
Geometrie:  IFC/Scan ──► tiling/ ──► B3DM (Batch Table: GlobalId) ──► MinIO ──► /tiles/… ──► Cesium3DTileset
Semantik:   IFC       ──► GraphDataModel (Id = uuid5(NS, GlobalId)) ──► Kafka gaecoImport ──► gaeco-Graph
Zustand:    Sensor    ──► ?TSDB ──► WebSocket ──► Frontend-Tabelle ──► Cesium3DTileStyle/CustomShader
Join:       GlobalId  ◄──uuid5──► gaeco-InstanceId/IRI
```

Was daraus **fertig vorliegt**: die linke Zeile vollständig; der Join
rechnerisch; das Anbindungsmuster mit Ausfallverhalten (`issues-store.js`); das
Muster „Daten neben dem Tileset statt darin" (`elements.py`).

Was **neu gebaut werden muss**: der Exporter iLEEN → Kafka; ein
Zeitreihenspeicher; ein WebSocket-Endpunkt in FastAPI; im Frontend ein
Zustands-Store plus Stil-/Shader-Auswertung plus ein Bedienbereich.

---

## 5 · Entscheidungen, die vor dem ersten Issue fallen müssen

Diese Punkte lassen sich am Code **nicht** beantworten. Sie sind der Grund,
warum das Epic auf `status:blocked` steht.

**E1 · Welches Repo ändert der Coder?**
`iLEEN-view/CLAUDE.md` sagt: geändert wird in der Vollfassung (GitLab),
übernommen wird nach GitHub. Der Auftrag setzt den Coder auf
`iLEEN-view/geaco-imp`. Mögliche Auflösungen: (a) Frontend-Arbeit in der
Vollfassung, `iLEEN-view` bekommt nur den Übernahme-Commit; (b) der
Sensor-Zweig ist die benannte Ausnahme und wird später zurückgeführt;
(c) Backend-Arbeit läuft ohnehin in GitLab, das Issue verweist nur darauf.
Ohne diese Entscheidung ist jedes Frontend-Issue doppeldeutig.

**E2 · Wohin die Messwerte?** Es gibt keine TSDB — weder bei iLEEN noch bei
gaeco. Jede Wahl (InfluxDB, TimescaleDB, QuestDB, oder pragmatisch erst einmal
SQLite/Parquet neben dem Tileset wie `properties.sqlite`) ist eine **neue
externe Abhängigkeit** und damit laut Auftrag `needs:philipp`.

**E3 · Kafka-Client im Backend.** `confluent-kafka` (bzw. `aiokafka`) wäre die
erste Kafka-Abhängigkeit in `backend/requirements.txt`. Ebenfalls neue externe
Abhängigkeit.

**E4 · Woher kommen die Sensordaten im Erprobungsbetrieb?** Es gibt heute
keinen einzigen Sensor und keine Simulationsquelle. Ohne eine benannte Quelle
(echter Sensor, Simulator, aufgezeichneter Datensatz) ist kein
Akzeptanzkriterium überprüfbar formulierbar.

**E5 · Sensor-Bedienung links oder rechts?** Der Start-Prüfstein verbietet in
`iLEEN-view` jeden rechten Reiter (§2). Entweder Sensorik ist ein
Viewer-Bereich links, oder der Prüfstein und die Trennungsregel werden
geändert.

**E6 · Auth.** iLEENs Frontend hat keine Anmeldung, gaeco hängt an Keycloak.
Für den Kafka-Weg ist das zunächst gleichgültig (der Broker ist offen), für
jeden REST-Zugriff auf `:5024` nicht.

**E7 · Guideline für Sensoren.** Brick liegt als Guideline bereit, eine eigene
iLEEN-Guideline plus Link-TTL wäre die Alternative (`GAECO-INTEGRATION.md` §5).
Hängt davon ab, welche Klassifikations-URIs der laufende Stack tatsächlich
führt — am Code nicht feststellbar.

---

## 6 · Vorgeschlagene Reihenfolge der Arbeitspakete

Ohne Anspruch auf Vollständigkeit; die Zuschnitte folgen erst nach der
Freigabe des Epics.

| # | Paket | Repo | hängt an |
|---|---|---|---|
| 1 | gaeco-Stack vollständig hochfahren und den Kafka-Weg einmal reproduzieren (IRI-Namensraum, Brick-Guideline, Klassifikations-URIs festhalten) | — (Betrieb) | E6, E7 |
| 2 | Exporter `backend/ileen/gaeco_export.py`: `properties.sqlite` → GraphDataModel, `Id = uuid5(NS, GlobalId)`, Chunking unter 50 MB | backend | 1, E3 |
| 3 | Zeitreihenspeicher + Aufnahme-Endpunkt (Sensorwert rein, Abfrage raus) | backend | E2, E4 |
| 4 | WebSocket-Endpunkt in FastAPI: Abonnement je Tileset/IRI-Menge, Auslieferung der letzten bekannten Werte beim Verbinden | backend | 3 |
| 5 | Frontend-Zustands-Store: IRI → letzter Wert, Ereignis `ileen:sensor-geaendert`, Ausfallverhalten nach dem Muster `issues-store.js` | frontend | 4, E1 |
| 6 | Zustandsdarstellung über `Cesium3DTileStyle`/`ShaderVerbund` — ohne `feature.color`, LOD-fest | frontend | 5 |
| 7 | Bedienbereich (links, `bereichAnmelden`): Sensorliste, Schwellwerte, Alarmanzeige | frontend | 6, E5 |

---

## 7 · Belege

| Aussage | Fundstelle |
|---|---|
| Batch Table hat vier Spalten | `backend/tiling/formats/ifc.py:1078-1090` |
| `batch_id` ist tile-lokal | `backend/tiling/formats/ifc.py:1037` |
| fachlicher Schlüssel ist `element.guid` | `backend/tiling/formats/ifc.py:786` |
| B3DM = 3D Tiles 1.0 | `backend/tiling/b3dm.py` Dateikopf |
| kein `EXT_structural_metadata` | `grep -rn "EXT_structural_metadata\|EXT_mesh_features" backend` → leer |
| Tiles sind ein MinIO-Proxy | `backend/api/routes/tiles.py:1-40` |
| „nicht in die Batch Table, sondern daneben" | `backend/semantic/properties.py` Dateikopf |
| Features nur über `getProperty()` | `frontend/features.js:11` |
| `feature.color` überlebt LOD-Wechsel nicht | `frontend/features.js:110-120` |
| Tileset hat nur einen Stil | `frontend/features.js:118-120` |
| Ladepfad der Tilesets | `frontend/core.js:869-900` |
| Ereignisnamen mit `ileen:`-Präfix | `frontend/i18n.js:816`, `frontend/skizzen-store.js:152` |
| Anbindungsmuster mit Ausfallverhalten | `frontend/issues-store.js`, beschrieben in `CLAUDE.md` |
| rechts darf kein Reiter stehen | `frontend/tests/start/test-start.mjs:218-221` |
| keine verwaiste Datei erlaubt | `frontend/tests/trennung/test-trennung.mjs:85-98` |
| Steckplatz-Signaturen | `frontend/right-panel.js:86`, `iLEEN-view/CLAUDE.md` „Wie ein Werkzeug dazukommt" |
| gaeco hat keinen Quellcode | `~/Projekte/gaeco` — nur Compose, `.env.example`, `demodata/` |
| Kafka-Topic und -Format | `GAECO-INTEGRATION.md` §3; `docker-compose-files/addons/ifc-parser.yml:56-63` |
| `Id` wird über Kafka übernommen | `GAECO-INTEGRATION.md` §3 (am Stack verifiziert) |
| Link-Ontologie-Muster | `~/Projekte/gaeco/demodata/gaeco/gaeco.ttl` |
| Brick/sosa liegen bereit | `~/Projekte/gaeco/demodata/Brick/Brick+patches.ttl:21, 2436 ff.` |
| keine TSDB im Stack | `grep -rln "influx\|timescale\|prometheus" docker-compose-files` → leer |
| Instance-Service und Kafka laufen nicht | `docker ps`, `curl localhost:5024` → keine Antwort |
