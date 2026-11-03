---
title: "CesiumBackend — Self-hosted Tiling Pipeline + File Storage + Semantic Extraction"
type: project
scope: development
status: active
last_updated: "2026-08-06"
technology: [Python, FastAPI, Docker, MinIO, py3dtiles, IfcOpenShell, trimesh, LanceDB, sentence-transformers, Kreuzberg]
domain: [BIM, GIS, 3D-Tiles, Punktwolken, 3DGS, Semantic-Web, RAG]
institution: Hochschule Mainz — Tragwerkslabor / BIM.Labor
server: "eigener Server — Docker Compose"
license: "AGPL-3.0-only (backend/LICENSE)"
related:
  - path: /Users/philippschafer/Projekte/iLEEN/frontend/CLAUDE.md
    label: iLEEN Frontend — Viewer
  - path: /Users/philippschafer/Projekte/semantic-pipeline/CLAUDE.md
    label: Semantic Pipeline (Ursprungsprojekt, bleibt unberührt)
  - path: /Users/philippschafer/Projekte/kreuzberg/CLAUDE.md
    label: Kreuzberg — Textextraktion (hier als Python-Bibliothek, nicht als REST-API)
  - path: /Users/philippschafer/Projekte/iLEEN/GAECO-INTEGRATION.md
    label: gaeco — iLEEN als Modul im Plugin Host, Brücke, Export über Kafka, Einrichtung
---

# CesiumBackend — Self-hosted Tiling Pipeline

Vollständig selbst gehosteter Backend-Stack für das iLEEN-Frontend:
**Upload → Tiling → 3D Tiles in MinIO → Semantic Extraction → LanceDB**

Kein Cesium ion benötigt; Tiles liegen im eigenen MinIO.

## Architektur

```
Browser / iLEEN-Frontend               Asset-Manager :8100/ui
        │  POST /upload/<datei>          │  Upload, Verortung, Vorschau
        ▼                                ▼
  FastAPI :8100 ◀──────────────────────────
        │
        ├── MinIO :9000/:9001
        │     ├── Bucket: uploads   (Quelldateien)
        │     ├── Bucket: tiles     (fertige 3D Tiles, öffentlich lesbar)
        │     └── Bucket: semantic  (reserved)
        │
        ├── Tiling Pipeline (Background-Task)
        │     ├── IFC        → IfcOpenShell → Octree → B3DM je Knoten (LOD)
        │     ├── LAS/LAZ    → py3dtiles → PNTS-Hierarchie (echtes LOD)
        │     ├── XYZ/PTS    → py3dtiles → PNTS-Hierarchie
        │     ├── PLY Splat  → SPZ → GLB (KHR_gaussian_splatting), Octree
        │     ├── PLY Wolke  → py3dtiles → PNTS-Hierarchie
        │     └── OBJ/STL/GLB→ trimesh → B3DM
        │
        └── Semantic Extraction (Background-Task)
              IFC → properties.sqlite aus dem Tiling (Typ, Name, Geschoss, Psets)
              Dokumente → Kreuzberg (Python-API, in-process)
                    │
              sentence-transformers (all-MiniLM-L6-v2)
                    │
              LanceDB (lokal, /data/lancedb) + FTS-Index
```

## Georeferenzierung (zentral für die Darstellung)

3D-Tiles-Koordinaten sind ECEF. Ein IFC/OBJ mit Koordinaten um (0,0,0) läge
sonst im Erdmittelpunkt und wäre unsichtbar. `tiling/georef.py` löst zwei Dinge:

1. **`root.transform`** — ENU→ECEF-Matrix am Referenzpunkt aus
   `TILESET_ORIGIN_LON/LAT/HEIGHT`, entspricht `Cesium.Transforms.eastNorthUpToFixedFrame()`.
2. **Hochachse** — glTF ist Y-up, 3D Tiles Z-up. CesiumJS rotiert B3DM-Inhalte
   automatisch; CAD/BIM ist aber schon Z-up. `Z_UP_TO_Y_UP` nimmt die Rotation
   vorweg, sodass sie sich exakt aufhebt.

Mesh-/IFC-Modelle werden zusätzlich auf ihren Ursprung zentriert (XY-Mitte,
Z-Unterkante) — sonst zerstören Landeskoordinaten wie UTM-Rechtswerte die
float32-Präzision. Punktwolken zentriert py3dtiles selbst auf den
Datenschwerpunkt; steht im LAS-Header ein CRS (oder in `POINTCLOUD_CRS_IN`),
wird dieser Schwerpunkt zum Referenzpunkt der Platzierung — mit der
Meridiankonvergenz als `heading` und dem Punktmaßstab als `scale`. Siehe
`georef.placement_from_projected()`; Genauigkeit: Zentimeter über eine
Ausdehnung von 500 m, geprüft in `tests/test_georef.py`.

## Verortung nachträglich ändern (Asset-Manager)

`TILESET_ORIGIN_*` ist nur der Startwert. Die endgültige Position wird im
Browser gesetzt — **http://localhost:8100/ui** zeigt eine Cesium-Ansicht mit
Assetliste, Karte und Formular für Länge/Breite/Höhe, Heading/Pitch/Roll und
Maßstab. Das ist das Gegenstück zu "Adjust tileset location" in Cesium Ion.

```
GET  /assets/{job_id}/placement    # aktuelle Werte
PUT  /assets/{job_id}/placement    # {lon, lat, height, heading, pitch, roll, scale}
```

Gespeichert wird direkt in den `root.transform` der `tileset.json` im
tiles-Bucket — jeder Viewer sieht die neue Position sofort, ohne neu zu tilen.
Die Eingabewerte selbst liegen daneben in `placement.json`; aus der fertigen
4x4-Matrix ließen sich Referenzpunkt und Drehung nicht zurücklesen.

Drei Punkte, die dabei leicht schiefgehen:

* **`base_transform`.** Der Anteil des Transforms, den der Handler selbst
  gesetzt hat. Er bleibt beim Verschieben stehen und wird von der Platzierung
  nur vormultipliziert. Für Punktwolken ist er heute leer: py3dtiles' Translation
  auf den Datenschwerpunkt *wird* der Referenzpunkt, statt vor ihm zu stehen.
  Das war einmal anders, und bei Landeskoordinaten ist der Unterschied brutal —
  ein UTM-Schwerpunkt als `base_transform` wandert durch den ENU-Transform als
  Ost-Nord-Versatz von Millionen Metern: die Wolke schwebt im All und steht
  schief (Marksburg-Scan, September 2026). Altbestand repariert
  `scripts/punktwolken_verorten.py` ohne Neukonvertierung.
* **`adjustable: false`.** Für Tilesets, die schon in ECEF liegen und deshalb
  nicht mehr verortet werden dürfen; die API lehnt das mit 409 ab. Punktwolken
  fallen seit dem CRS-Fix nicht mehr darunter — auch eine Wolke mit
  Landeskoordinaten bleibt verschiebbar und lässt ihre Höhe gegen das Gelände
  auflösen, was sie braucht: ein Scan sitzt selten auf dem Terrain, das der
  Viewer zeigt.
* **Winkelkonvention.** `heading` dreht im Uhrzeigersinn um die Hochachse
  (90° = Modell-Nord zeigt nach Ost), `pitch` um die Ost-, `roll` um die
  Nordachse. `api/static/index.html` rechnet für die Live-Vorschau dieselbe
  Matrix in JavaScript nach — beide Seiten müssen zusammen geändert werden.

Tilesets, die vor dieser Erweiterung entstanden sind, haben keine
`placement.json`. Für sie wird die Platzierung aus dem vorhandenen
`root.transform` rekonstruiert (Rest gegen den aktuellen Referenzpunkt als
`base_transform`), sodass sie zunächst exakt liegen bleiben.

### Verschiebe-Handle (XYZ-Pfeile)

Neben dem Formular gibt es im Viewer drei farbige Pfeile am Modellursprung
(rot = Ost, grün = Nord, blau = Hoch) — Ziehen daran verschiebt das Modell
direkt, ohne Umweg über Zahlenfelder. Reine Client-Logik in
`api/static/index.html`, kein neuer Endpunkt: das Ziehen schreibt nur in
dieselben Formularfelder wie „Auf Karte setzen" und ruft danach `preview()`
auf; gespeichert wird weiterhin erst per Klick auf „Speichern".

Technik dahinter:

* **Achsgebundenes Ziehen über eine Hilfsebene.** Die Maus bewegt sich frei im
  3D-Raum, gebraucht wird nur ihre Position entlang einer Achse. Bei Ost/Nord
  ist die Hilfsebene die lokale Horizontale durch den Ursprung; bei Hoch eine
  kameraseitig ausgerichtete Vertikalebene (`camera.rightWC` als Normale) —
  sonst stünde die Ebene bei Blick von oben fast parallel zum Sichtstrahl und
  der Schnittpunkt würde numerisch instabil. Schnittpunkt (`IntersectionTests.rayPlane`)
  auf die Achse projizieren (Skalarprodukt), Differenz zum Startwert ist die
  gezogene Strecke.
* **Hoch-Ziehen addiert direkt aufs Höhenfeld**, unabhängig vom gewählten
  Höhenbezug (`terrain`/`msl`/`ellipsoid`): `elevation.to_ellipsoid()` ist in
  `height` affin mit Steigung 1, eine Verschiebung um Δ ändert die
  Ellipsoidhöhe immer um genau Δ, egal welcher Bezug gerade gilt.
* **Pfeillänge folgt `tileset.boundingSphere.radius`** (geklemmt auf 3–300 m) —
  eine feste Pixelbreite wäre bei einem 200-m-Campusmodell unsichtbar klein
  oder bei einer kleinen Sonde riesig.
* **Der Klick nach dem Ziehen wird unterdrückt** (`gizmoJustDragged`,
  selbstlöschend per `setTimeout(0)`): sonst würde derselbe Mausklick, der das
  Ziehen beendet, zusätzlich ein Bauteil auswählen oder — im Modus „Auf Karte
  setzen" — die Position ein zweites Mal setzen.
* Blendet sich aus bei `adjustable: false` (schon in ECEF verortete Tilesets)
  und im Modus „Auf Karte setzen", um Konflikte mit dem Terrain-Klick zu
  vermeiden.

### Mehrere Modelle gleichzeitig (Ausrichten aufeinander)

Ein Modell auf ein anderes auszurichten geht nur, wenn beide zu sehen sind.
Deshalb hält der Asset-Manager nicht *ein* Tileset, sondern eine Karte
`layers: job_id → { asset, tileset, loadedMatrix, placement, opacity }`.
Bearbeitet wird trotzdem immer nur **eine** Ebene: die des in der Liste
ausgewählten Assets. Alle anderen behalten ihre gespeicherte Platzierung —
Formular, Pfeile und „Speichern" rühren sie nicht an.

* **👁 je Assetzeile** lädt ein Modell zusätzlich in die Szene oder nimmt es
  wieder heraus, unabhängig von der Auswahl. Ein Klick auf den Namen wählt zum
  Bearbeiten aus und lädt dabei mit.
* **Kamerasprünge nur beim Erstladen.** `select()` fliegt das Tileset nur an,
  wenn es vorher nicht geladen war (`wasLoaded`). Sonst würde jeder Wechsel
  zwischen zwei Modellen die Kamera versetzen — genau das, was man beim
  Ausrichten nicht gebrauchen kann.
* **Deckkraft je Ebene** (Regler im Positionsformular) über
  `tileset.style = color('#ffffff', a)`: Farbe und Textur bleiben, nur die
  Deckkraft sinkt, sodass man das dahinterliegende Modell sieht. Bei 100 % wird
  der Stil wieder entfernt — er überschriebe sonst dauerhaft die
  Auswahlfarbe des angeklickten Bauteils. Gaussian-Splat-Tilesets kennen keinen
  Stil und bleiben undurchsichtig.
* **Bauteilauswahl folgt dem Tileset, nicht der Liste.** `selectFeature()` sucht
  die Ebene über `picked.tileset` und holt die Property-Sets von *deren*
  `job_id`. Ohne das kämen bei zwei geladenen IFC-Modellen die Eigenschaften
  aus dem falschen.
* **Der Formularstand bleibt je Ebene erhalten** (`layer.form`). Beim
  Ausrichten wechselt man zwischen zwei Modellen hin und her; ohne das wäre
  jede noch nicht gespeicherte Verschiebung beim Zurückwechseln wieder aus dem
  Formular verschwunden, obwohl die Vorschau sie noch zeigt. Nach dem Speichern
  wird `layer.placement` mitgezogen — sonst stünden dort weiter die Werte von
  vorher.
* **„Nur dieses" / „Alle ausblenden"** unter der Liste, damit die Szene nach
  ein paar Klicks nicht zuwächst.

Beim Entladen wird die Bauteilauswahl vorher aufgehoben (`unloadLayer`): danach
zeigt die Feature-Referenz ins Leere und das Zurücksetzen ihrer Farbe wirft.

### Assets löschen und umbenennen

```
DELETE /assets/{job_id}          # entfernt Tiles, Quelldatei, Properties, Vektorindex
PUT    /assets/{job_id}/name     # {name} — Anzeigename, unabhängig vom Dateinamen
```

Löschen räumt vier Stellen auf: `tiles/{job_id}/*` und `uploads/{job_id}/*` in
MinIO, die lokale `properties.sqlite`-Kopie (`api/routes/elements.py`) und die
LanceDB-Zeilen des Jobs (`semantic/extractor.delete_job()`). Der Vektorindex
ist dabei absichtlich nicht fatal: schlägt er fehl, wird nur gewarnt, die
MinIO-Objekte sind trotzdem weg.

Der Anzeigename liegt separat in `tiles/{job_id}/meta.json` und überschreibt
nur die Anzeige — welches Icon/Tag ein Asset bekommt (`_content_type()`)
richtet sich weiter nach dem tatsächlichen Namen der hochgeladenen Datei,
sonst verliert ein umbenanntes Asset sein Format-Tag.

### Die Assetliste steht rechts, nicht in der Formularspalte

Bis September 2026 teilten sich Liste und Positionsformular die linke Spalte.
Das ging, solange ein Backend fünf Modelle hielt: die Liste bekam den Rest der
Höhe (`flex: 1 1 0`), und der Rest war bei geöffnetem Bearbeitungspanel eine
Handvoll Zeilen. Bei über sechzig Assets ist das keine Liste mehr, sondern ein
Guckloch — und zwar genau dann, wenn man beides gleichzeitig braucht: ein
Modell ausrichten und daneben das Referenzmodell finden.

Die Liste ist deshalb ein eigenes Panel rechts über der Szene (`#assets-panel`):

* **ausblendbar** über ⟩ im Listenkopf; zurück holt sie ☰ oben rechts.
* **in der Breite ziehbar** am linken Rand, 240–720 px, nach oben zusätzlich
  begrenzt auf `innerWidth − 420`, damit zwischen den Panels Szene bleibt.
* **Filterpillen** je `content_type` (IFC, Mesh, Punktwolke, Splat,
  Sonstiges) mit Anzahl, dazu ein Namensfeld; die Zahl im Kopf zeigt
  „sichtbar / alle". Gefiltert wird nur die Anzeige — `assets` bleibt der
  vollständige Serverstand, weil Layer, Geländereferenz und Umbenennen darauf
  arbeiten.
* **Zeilenaktionen erst unter dem Zeiger.** 🎨 ⬇ ✎ 🗑 erscheinen an der Zeile,
  über der der Zeiger steht, und an der ausgewählten (`.asset-mini.aktion`,
  nur bei `hover: hover` — auf dem Tablet bleiben sie stehen). 👁 und ⛰ stehen
  immer, weil sie einen Zustand zeigen. Meldungen der Liste (Laden, Export,
  Umbenennen, Löschen) gehen in die eigene Statuszeile `#assets-status`, nicht
  ins Upload-Panel, das gerade zugeklappt sein kann.

Ein Ding, das dabei leicht fehlt: **Ein Filter auf eine leere Kategorie fällt
auf „Alle" zurück.** Breite, Sichtbarkeit und Filter überleben im
`localStorage`; wer zuletzt nach IFC gefiltert und danach das letzte IFC
gelöscht hat, sähe sonst eine leere Liste ohne sichtbaren Grund.

### Oberfläche wie im Viewer: Leiste, Akkordeon, Design *(2026-10-18)*

Der Asset-Manager trägt dieselbe Oberfläche wie iLEEN: links eine
Aktivitätsleiste mit der iLEEN-Marke, daneben das Panel des offenen Bereichs,
rechts die Assetliste, Grau und MiB-Grün statt des früheren Blaugraus.

| Bereich | Gruppen (Akkordeon) |
|---|---|
| 📥 Hochladen | Modell hochladen · Fotos → Splat (Kopf zeigt „n läuft") |
| 📍 Verortung | *angeheftet:* ausgewähltes Modell, Status, Verwerfen/Speichern · Position · Drehung & Maßstab · Darstellung · Geländereferenz · Rekonstruktion zu BIM (nur Punktwolken) · Tileset |

* **Die Gruppen sind ein Akkordeon** — dieselbe Regel wie `frontend/ui.js`:
  ein `toggle`-Lauscher am Dokument in der Erfassungsphase schließt die
  geöffneten Geschwister derselben Ebene. Speichern und Verwerfen stehen
  deshalb angeheftet über den Gruppen: sie werden aus jeder Gruppe heraus
  gebraucht.
* **Bedienung wie im Viewer:** zweiter Klick auf das aktive Symbol schließt das
  Panel, ⇤ oder die Taste M fährt die Leiste hinaus, ☰ holt sie zurück, der
  rechte Panelrand ist ziehbar (260–640 px). Auswahl eines Assets öffnet
  „Verortung"; der zuletzt offene Bereich und die Breite überleben im
  `localStorage` (`ileen.backend.*`).
* **Die Szene füllt das Fenster, die Panels schweben darüber.** Damit ändert
  keine Panelbreite die Leinwand, und `viewer.resize()` ist entfallen. Was
  sonst über der Szene liegt, rückt um die Panels ein: `belegungMessen()`
  setzt `--links-belegt` / `--rechts-belegt`, daran hängen die Bauteilkarte
  (`#feature`), die Materialpalette (`#mm-panel` in `material-modus.css`) und
  Cesiums Quellenangabe. Gemessen wird der Zustand, nicht das Bild — die
  Leiste fährt per Transform hinaus, ihre Lage mitten im Übergang wäre falsch.
* **Cesium setzt die Quellenangabe per Inline-Stil** (`left: 5px`). Eine
  Klassenregel greift dort nicht, auch keine spezifischere — nur `!important`.
* **`ileen-ui.css` ist ein Abbild** von `frontend/style.css` (Leiste, Panel,
  Kopf) und `frontend/design-system.css` (Marken, Schaltfläche, Eingaben,
  `.panel-group`, Pillen), mit denselben Klassennamen. Ein Verweis auf das
  Frontend ginge nicht: die Seite kommt vom Backend (:8100/ui) und muss ohne
  den Vite-Server stehen. Wer dort einen Baustein ändert, zieht ihn hier mit.
  Die Schaltfläche steht dort am Element (`:where(button)`, Spezifität null),
  weil die Dialoge ihre Knöpfe ohne Klasse anlegen; die alten Kurznamen
  `--panel`, `--line`, `--accent` … zeigen auf die neuen Marken, damit
  `materials.css` und `material-modus.css` ohne Umbau mitziehen.
* `ileen-marke.svg` und `favicon.svg` sind Kopien aus `frontend/` und behalten
  ihren Lizenzkopf (PolyForm Noncommercial).

## Gaussian Splats — warum es SPZ sein muss

3DGS-PLYs werden als **echte Gaussian Splats** ausgeliefert, nicht als
Punktwolke: ausgerichtete Ellipsoide mit Deckkraft und alphakorrektem Blending.
Frühere Fassungen exportierten nur die Gauß-Zentren als PNTS — sichtbar war
eine Punktwolke.

CesiumJS rendert Splats über die glTF-Extensions `KHR_gaussian_splatting` und
`KHR_gaussian_splatting_compression_spz_2`. Die unkomprimierte Variante der
Extension ist zwar spezifiziert, in CesiumJS 1.141 aber **nicht benutzbar**:
`GltfLoader` legt Vertexattribute nur als typed array ab, wenn ein
Nachbearbeitungsschritt sie anfordert — und den setzt ausschließlich der
SPZ-Zweig (`PrimitiveLoadPlan.needsGaussianSplats`). `GaussianSplat3DTileContent`
greift danach hart auf `attribute.typedArray` zu. Ohne SPZ ist das Feld leer und
das Tile stirbt beim ersten Frame. Deshalb schreibt `tiling/spz.py` einen
vollständigen SPZ-v2-Container.

Vier Punkte, an denen es sonst scheitert:

* **Beide Extensions müssen im Tileset stehen**, in `extensionsUsed` *und*
  `extensionsRequired` unter `3DTILES_content_gltf`. CesiumJS entscheidet allein
  daran, ob ein `.glb`-Tile als Splat-Content geladen wird
  (`GaussianSplat3DTileContent.tilesetRequiresGaussianSplattingExt`) — auch wenn
  die Datei selbst gar nicht komprimiert wäre.
* **Der SPZ-Block muss bufferView 0 sein** — bis CesiumJS 1.144. Seit 1.145
  liest `GltfSpzLoader` die Angabe der Extension (CHANGES.md, #12847); der
  Writer bleibt trotzdem bei 0, damit ältere Viewer die Tiles lesen.
* **Attributnamen mit Unterstrich**, also `_SCALE` und `_ROTATION` (und
  `_SH_DEGREE_l_COEF_n`). CesiumJS akzeptiert auch `KHR_gaussian_splatting:SCALE`,
  aber der Doppelpunkt verstieß gegen die glTF-Namensregel und ließ jedes Tile
  am Validator scheitern. Die inzwischen ratifizierte Fassung von
  `KHR_gaussian_splatting` schreibt genau die Doppelpunkt-Namen vor — beim
  nächsten Validator-Stand prüfen und dann umstellen.
* **Die Knotenmatrix ist Pflicht.** `GaussianSplatPrimitive.transformTile()`
  liest `content.worldTransform` ungeprüft; der Wert ist die `matrix` des ersten
  Knotens. Fehlt sie, ist er `undefined`.

Quantisierung und Konventionen (Details in `tiling/spz.py`): Positionen als
24-Bit-Festkomma mit 12 Nachkommabits (±2048 m um den Tile-Ursprung, deshalb
hat jeder Octree-Knoten seinen eigenen `transform`), Skalen logarithmisch in
einem Byte, Rotationen als drei Byte mit rekonstruiertem w, Farbe aus dem
SH-DC-Koeffizienten. 3DGS speichert Quaternionen als (w,x,y,z) — glTF und SPZ
erwarten (x,y,z,w); ohne Umsortieren stehen alle Splats schief.

Was voreingestellt wegfällt: **die höheren SH-Ordnungen** (`f_rest_*`). Damit
entfällt die blickwinkelabhängige Farbe; die Basisfarbe bleibt exakt. Seit #8
schreibt `SPLAT_SH_GRAD=1..3` sie mit (je ein Grad für das ganze Tileset —
CesiumJS 1.145 nimmt den Grad von `tiles[0]` und verrutscht bei gemischten
Graden). Gemessen an der Zitadelle: Grad 3 kostet +78 % Größe und die
2,5-fache Ladezeit, sichtbar nur aus der Nähe; bei 14 Mio. gleichzeitig
gerenderten Splats kommt die SH-Textur gar nicht zustande, ohne Meldung.

### LOD-Aufbau: zusammengeführte Eltern statt Zufallsauswahl (#8)

Bis #8 war der Splat-Octree ADD mit Zufallsauswahl: jeder Knoten trug 250 000
zufällige Splats seines Teilbaums in Originalgröße. Aus der Ferne sah man
wenige kleine Splats mit Lücken — und luden sich trotzdem Millionen davon,
weil der geometrische Fehler den Abstand, nicht die Deckung misst.

`SPLAT_LOD=hlod` (Standard, `tiling/splat_hlod.py`): Blätter tragen die
Originale (≤ `SPLAT_HLOD_TILE_POINTS`, 100 000), jeder Elternknoten eine per
Moment-Matching zusammengeführte Fassung seiner Kinder (~1/4), `refine:
REPLACE`, geometricError = Rasterweite des Zusammenführens. Gewichtet mit
Deckkraft × Fläche, Deckkraft über die bedeckte Fläche — Begründung im Kopf
des Moduls. Gemessen gegen den alten Aufbau: Flug 1,5- bis 2,6-mal flüssiger, Ruckler
über 50 ms von 53–119 auf 7–17 je Flug, Ladezeiten halbiert, Fernansicht geschlossen
statt gesprenkelt. Einzelheiten und die verworfenen Wege (gemessener
Nachbarabstand als geometricError, PCA-Kästen, Auslichten als Standard):
`frontend/tests/splat-bench/ergebnisse/VERGLEICH.md` und die Commits zu #8.

**Der Wurzelursprung bleibt der alte.** `build_tileset()` verwirft die
Translation des Wurzelknotens (dieselbe Konvention wie beim IFC-Octree), das
Modell liegt deshalb um die Mitte des Wurzelkastens versetzt — bei der Kirche
29 m unter der Verortung. Das ist nicht neu und bleibt so, damit bestehende
Verortungen stimmen; der Versatz steht jetzt in
`root.extras.ileen_splat.modellversatz`. Wer es richtig machen will, ändert es
für IFC und Splats gemeinsam und zieht das Frontend mit.

**Der HLOD-Aufbau gilt nur für neue Uploads.** Ein Asset, das vor #8 getilt wurde,
bleibt im Bucket ADD-Octree mit Zufallsauswahl — ob ein Asset schon HLOD ist,
zeigt `root.extras.ileen_splat.lod` (fehlt bei Altbestand). Für den Bestand gibt
es `tiling/splat_neu.py`, das aus der Quell-PLY im `uploads`-Bucket neu kachelt
und die Platzierung (`placement.json`, `root.transform`, `extras.ileen`)
übernimmt:

```bash
docker exec cesium-api python -m tiling.splat_neu liste
docker exec cesium-api python -m tiling.splat_neu neu <job_id> --trocken   # prüfen
docker exec cesium-api python -m tiling.splat_neu neu <job_id>             # tauschen
```

Vor dem Tausch wird die Zahl der Splats im alten Tileset (aus den GLB-Köpfen)
mit der des neuen verglichen: der Modellursprung ist die Mitte der Splats, die
der Tiler behält, und nur bei derselben Auswahl bleibt die Verortung gültig.
Weicht sie ab (etwa weil `SPLAT_MAX_POINTS` damals eine Stichprobe gezogen hat),
bleibt das Asset unberührt. Gemessen an der Kirche (14 Mio. Splats): 214 → 643
Kacheln, 27 s, Transform bitgleich. Das Image enthält das Modul erst nach
`docker compose build api`; bis dahin per `docker cp` einspielen.

Alle Stellschrauben: `.env.example`, Abschnitt Gaussian Splats. Messen:
`frontend/tests/splat-bench/README.md`.

**Ausreißerfilter.** 3DGS-Trainings hinterlassen einige riesige, halbdurchsichtige
Gaußverteilungen. Sie überdecken aus jeder Blickrichtung fast das ganze Bild und
machen das Modell als helle Schlieren praktisch unkenntlich. Gemessen wird an der
größten Halbachse: die Ausreißer sind fast immer extrem anisotrop (1:1000 und mehr
ist normal), also Nadeln, die bei 3σ Länge ein Vielfaches der Szene überstreichen,
ohne nennenswert Volumen zu haben.

Zwei Grenzen, verworfen wird bei Überschreitung der kleineren:
`SPLAT_MAX_SCALE_RATIO` (Standard 0,05) als Anteil der Szenenausdehnung und
`SPLAT_MAX_SCALE_MEDIANS` (Standard 8) als Vielfaches der Median-Halbachse.

Die Szenenausdehnung ist dabei die Diagonale des **1–99-Perzentil-Kastens**, nicht
die der Bounding Box. Das ist keine Feinheit, sondern der Kern des Filters: die
weit abliegenden Ausreißer, die er entfernen soll, blähen die Bounding Box um ein
Vielfaches auf — jeder Ausreißer hebt also die Grenze mit an, an der er selbst
gemessen wird, und der Filter entwaffnet sich selbst. Bei einem 3DGS-Buddha standen
10,6 m Bounding-Box gegen 4,4 m tatsächliche Szene; die Grenze lag damit bei 0,53 m
statt 0,22 m und ließ die beiden schlimmsten Splats (σ = 1,47 m und 0,94 m bei
Achsenverhältnis 1:39000 und 1:1900, beide nahezu deckend — also 4,4 bzw. 2,8 m
lange, praktisch undurchsichtige Striche quer durch eine 4,4-m-Szene) mit durch.
Die zweite Grenze am Median greift auch dort, wo selbst das Perzentil noch von
Ausreißern dominiert wird.

Wie viele entfernt wurden, steht im Log — mehr als ein paar Promille sind ein
Hinweis auf die Quelldatei, nicht auf den Filter.

Genauigkeit gegen den Decoder gemessen, den CesiumJS bündelt
(`@spz-loader/core` 0.3.1, an echten Splat-Daten): Positionen 0,12 mm, Skalen
3,2 % relativ, Deckkraft 2·10⁻³, Farbe 0,004 im darstellbaren Bereich,
Rotationen im Median 0,6° (p95 3,6°). Die Rotationsabweichung ist die
Formatgrenze der Drei-Byte-Quaternion von SPZ v2, nicht ein Rundungsfehler des
Encoders.

### Behobener Bug: große Scans wirkten löchrig — `SPLAT_MAX_POINTS`

Ein 912-MB-Kirchenscan (`Kirche_Laubenheim_außen.ply`, 14.057.985 Splats) sah
nach dem Tiling im Viewer sichtbar unvollständig aus — vor allem Vegetation
wirkte ausgedünnt statt flächig. Ursache war keine Render- sondern eine
Tiling-Entscheidung: `_MAX_POINTS` (aus `SPLAT_MAX_POINTS`, Standard 6 Mio.)
zieht *vor* dem Octree-Aufbau eine zufällige Stichprobe der Gesamtszene — bei
dieser Datei blieben mit dem damaligen `.env`-Wert `SPLAT_MAX_POINTS=2000000`
nur rund 14 % aller Splats übrig. Gerade bei dünn besetzter Geometrie wie
Blattwerk macht sich eine gleichverteilte Unterabtastung sofort als Lücken
bemerkbar, nicht als gleichmäßig gröberes Bild.

Zwei unabhängige Dinge kamen hinzu, als das untersucht wurde:

* **Alle `logger.info()`-Aufrufe im Projekt landeten nirgends.** Ohne
  `logging.basicConfig()` hat der Root-Logger keinen Handler; nur
  Uvicorns eigene Logger (`uvicorn`, `uvicorn.access`) waren konfiguriert.
  Genau die Meldungen, die eine Splat-Reduktion angezeigt hätten (`Auf X von
  Y Splats reduziert`, `X von Y Splats … entfernt`), verschwanden also
  spurlos — sichtbar in `docker logs` waren nur Tracebacks. Behoben in
  `api/main.py` mit `logging.basicConfig(level=logging.INFO, …)` vor dem
  Erzeugen der FastAPI-App.
* **`_drop_oversized()` konnte sich selbst leerlaufen.** Wenn die berechnete
  Ausreißergrenze kleiner als jede tatsächliche Splat-Halbachse in der Datei
  ist (degenerierte Szene), verwarf der Filter *alle* Splats; `recenter()`
  crashte danach auf dem leeren Array mit „zero-size array to reduction
  operation minimum which has no identity" — real aufgetreten bei einem
  anderen Upload (Log vom 2026-08-10, 17:22 Uhr). Der Filter überspringt
  jetzt sich selbst und loggt eine Warnung, wenn er `100 %` der Splats
  treffen würde, statt den Job abstürzen zu lassen.

`SPLAT_MAX_POINTS=0` schaltet die Obergrenze jetzt vollständig ab (vorher
hätte `0` durch `count > _MAX_POINTS` sofort auf null Splats reduziert — der
Wert war schlicht nicht vorgesehen). Das ist die aktuelle Einstellung in der
`.env`; wer sie wieder braucht (sehr große Szenen, begrenztes GPU-Budget beim
Zielgerät), setzt einen konkreten Wert — die LOD-Hierarchie sorgt ohnehin
dafür, dass aus der Ferne nur die groben Octree-Knoten geladen werden, die
Grenze greift nur, wenn wirklich die ganze Szene gleichzeitig sichtbar ist.

### Kein Bug: Splat-Sortierung und `tileset.modelMatrix`

**Diesen Patch nicht wieder einbauen.** Er stand von 2026-08-06 bis 2026-08-10 in
`api/static/index.html` und war die Ursache für verwaschene, durchmischte Splats
beim Live-Verorten — also genau für das Symptom, das er beheben sollte.

Die Annahme war: der Gaussian-Splat-Sorter sortiere mit
`viewMatrix · rootTransform`, während der Zeichenbefehl mit
`viewMatrix · tileset.modelMatrix · rootTransform` zeichne — `modelMatrix` fehle
also in der Sortierung. Der Patch ergänzte sie deshalb um
`(view · modelMatrix · view⁻¹)`.

Tatsächlich benutzen **beide dieselbe Matrix**, und `modelMatrix` steckt in
keiner von beiden — sondern in den Positionen:

* `Cesium3DTile.updateVisibility()` setzt für den Wurzelknoten
  `parentTransform = tileset.modelMatrix`, `computedTransform` enthält sie also.
* `GaussianSplatPrimitive.transformTile()` bäckt
  `inverse(rootTransform) · computedTransform · …` fest in die Splat-Positionen.
* Sortierung *und* Zeichenbefehl multiplizieren danach mit `rootTransform`, das
  sich gegen das eingebackene `inverse(rootTransform)` weghebt. Cesium schreibt
  das selbst in `GaussianSplatPrimitive.js` an die Stelle, an der die
  Draw-Command-Matrix gesetzt wird: *„tileset.modelMatrix is baked into the splat
  positions by transformTile and must not appear here as well."*

`modelMatrix` ein zweites Mal in die Sortiermatrix zu multiplizieren verschiebt
daher nur die Sortierung gegen das Zeichnen. Bei Identität ist das ein No-op —
deshalb sah ein frisch hochgeladenes Modell normal aus und wurde erst in dem
Moment matschig, in dem `preview()` die erste Drehung auf `modelMatrix` legte.

Merksatz für künftige Sortierfehler: Splat-Positionen sind **bereits
welttransformiert**. Alles, was zusätzlich in die Sortierung multipliziert wird,
ist doppelt.

## Splat-Training — Fotos hinein, verorteter Splat heraus *(2026-10-10)*

Fotos (Handy, Drohne, Video) als ZIP, Ordner oder lose Dateien in den Asset-Manager ziehen —
oder AirDrop in den Eingangsordner —, und am Ende steht ein Gaussian Splat im Viewer, **in
Metern, Z oben, an der Stelle der Welt, wo er aufgenommen wurde**. Dazu zwei Zugaben, die
dieselbe Kachel-Pipeline benutzen: ein **Laserscan als Splat** (ohne Training) und ein
**SOG-Export** für jedes Splat-Asset.

```
Browser (Asset-Manager)                        Mac-Host
  ┌──────────────────────┐                  ┌───────────────────────────────┐
  │ Fotos → Splat        │  POST            │ splatwerk/worker.py (launchd) │
  │ Drop: Bilder/ZIP/    │ /splat-training  │  entpacken → vorbereiten      │
  │ Ordner/HEIC/Video    │────────┐         │  → COLMAP (Merkmale, Abgleich,│
  └──────────────────────┘        ▼         │    Mapper) → ausrichten (GPS) │
        cesium-api (Container)  data/training/  → entzerren → Spirula        │
        ├ api/routes/splattraining.py ◀─────────  status.json / ergebnis.ply  │
        │   übernimmt "trainiert":   Dateien, kein Netz                       │
        │   Kachel-Pipeline + Verortung  eingang/ ◀── Hotfolder (AirDrop)     │
        └ api/routes/splat_export.py (SOG, PLY)└───────────────────────────────┘
```

**Warum der Worker auf dem Mac läuft.** COLMAP und Spirula Studio brauchen die Metal-GPU; Docker
Desktop reicht sie nicht durch. Ein Spirula im Linux-Container liefe über Software-Vulkan.
Container und Worker reden deshalb **nur über Dateien** (`data/training/`, Bind-Mount): kein
Netzaufruf, der ausfallen kann, und beide Seiten dürfen jederzeit neu starten. Der Worker
setzt `wartet → laeuft → trainiert`; der Container übernimmt `trainiert → uebernehme → fertig`.
Die Übergänge überlappen sich nie — deshalb genügt das atomare Ersetzen von `status.json`
ohne Sperre. Abbruch ist eine **Marke** (`abbruch`-Datei), kein Eintrag in `status.json`: so
schreiben nie zwei Seiten dieselbe Datei.

### Betrieb

```bash
brew install colmap ffmpeg                       # Spirula Studio: DMG aus den GitHub-Releases, App nach ~/Projekte/spirula-studio-app/
pip3 install -r splatwerk/requirements-worker.txt
splatwerk/splatwerk-installieren.sh              # launchd-Agent com.philippschafer.splatwerk
splatwerk/splatwerk-installieren.sh status|entfernen
python3 splatwerk/worker.py einmal               # ohne Agent: Warteschlange abarbeiten
python3 splatwerk/worker.py anlegen Fotos/ --name "Hof" --qualitaet standard
```

Der **Eingangsordner** ist `data/training/eingang/` (Hotfolder). ZIP-Dateien und Ordner sind je
ein Auftrag; lose Bilder und Videos — so kommt ein AirDrop mit vielen Fotos an — bilden *einen*
Auftrag, sobald sie 15 s still sind (AirDrop und Finder kopieren nicht atomar; `_ruhig()` wartet
auf eine unveränderte Größe). **AirDrop landet immer in `~/Downloads`**, nicht im Eingangsordner:
ein Ordner dort zu überwachen hieße, jeden Download als Foto-Auftrag zu behandeln. Die Dateien
von Hand in den Eingangsordner ziehen, oder gleich in den Browser.

Qualitätsstufen (`auftrag.QUALITAET`; Schritte · längste Bildkante beim Training · Obergrenze der Splats):
`schnell` 6 000 · 1280 · 1,5 Mio., `standard` 30 000 · 1920 · 4 Mio., `hoch` 45 000 · 2560 · 8 Mio.

Gemessen (M4 Pro, 40 Drohnenfotos Marksburg, `schnell`): mit Brush (bis 2026-10-31) COLMAP 69 s gesamt, Brush 236 s,
**5 min** insgesamt, 474 081 Splats; mit Spirula Studio siehe „Trainer: Spirula Studio statt Brush“. COLMAP läuft ohne CUDA auf der CPU; **bis etwa 250 Bilder
werden alle Paare abgeglichen, darüber nur Nachbarn** (Aufnahmereihenfolge + GPS-Radius). Der
Datensatz `Campus_3DGS` (2 161 Bilder, 3,6 GB Datenbank, leeres `sparse/`) ist an genau dieser
Grenze gescheitert, bevor es das hier gab.

### Trainer: Spirula Studio statt Brush *(2026-11-01)*

Die Stufe `training` ruft `spirula train` auf statt Brush. COLMAP, Ausrichtung, Entzerren, Atlas-Weg, Übernahme
und Export bleiben, wie sie waren. Quelle: `github.com/harry7557558/spirula-studio` (GPL-3.0), das macOS-DMG
(Vulkan über MoltenVK, ein einziges Binary ohne Python) aus den Releases — Stand v2026.10.30. Die App liegt unter
`~/Projekte/spirula-studio-app/Spirula Studio.app` (`SPIRULA_BIN` überschreibt, `worker.SPIRULA`); der Quellklon
`~/Projekte/spirula-studio` ist nur zum Nachlesen (`docs/`, `src/app/webviewer/`). **Spirula wird nur als eigenes
Programm aufgerufen — kein Code daraus gehört in dieses Repo** (GPL-3.0 gegen AGPL-3.0 im Backend und PolyForm NC im Frontend).

```
spirula train 3dgs --data train --data-format colmap --colmap-recon-dir sparse/0
    --output-dir-prefix <Auftrag> --output-dir-name spirula
    --num-iterations <schritte> --cap-max <max_splats> --steps-per-save <schritte>
    --scene-center none --eval-lpips 0 --lang en
    [--train-resolution-divisor <Teiler>]
    [--disable-viewer 1]  |  [--viewer-port <p> --keep-viewer-alive 0]      # mit Fenster
```

* **`--scene-center none` ist Pflicht.** Mit `auto` verschiebt Spirula Szenen weit vom Ursprung; die Georeferenzierung
  steckt aber im Modell (`ausrichtung`). Nach dem Lauf prüft `_pruefe_rahmen`, ob `scene_transform.json` die Identität
  ist — sonst bricht die Stufe ab, statt einen versetzten Splat zu liefern.
* **Die Bildgröße ist ein Teiler**, kein Höchstmaß: Brushs `--max-resolution` heißt hier
  `--train-resolution-divisor = längste Kante / aufloesung` (`_aufloesungsteiler`, gebrochene Werte gehen,
  der Parser rechnet `floor(Seite / Teiler)`; weniger als 2 % darüber: kein Teiler).
* **`--quality` bleibt weg.** Mit ausdrücklichen `--num-iterations` und `--cap-max` ändert es an der Konfiguration nichts
  (gemessen: `config.json` der drei Stufen bis auf die Bezeichnung gleich).
* **`--lang en` ist Pflicht**, die Ausgabe folgt sonst der Systemsprache; der Fortschritt kommt als
  `step  101/300 (33%)  splats 20000  [elapsed … | ETA …]` alle 100 Schritte.
* **Startpunkte** liest Spirula aus `points3D` — auch die Atlas-Punkte ohne Spur (geprüft: „seed points: 3000“, kein
  Zufallsstart). Fehlt die Datei, startet es zufällig um die Kameras.
* **Ergebnis:** `spirula/step-<n>.ckpt/splat.ply` (+ `state.tar`). **Die PLY hat keinen `Vertical axis`-Kommentar.**
  Der Kachel-Handler nimmt dann Z-up an (richtig), der SOG-Export dreht aber nur PLYs, die `z` melden —
  `plyhilfe.trage_hochachse_ein` fügt ihn ein (die Datei wird dafür einmal neu geschrieben, 372 MB in unter einer
  Sekunde). Danach werden die Prüfpunkte gelöscht; `config.json` und `scene_transform.json` bleiben als Nachweis.
* **Nur ein Prüfpunkt am Ende** (`--steps-per-save = schritte`): bei 4 Mio. Splats ist jeder ein Gigabyte.

**Das Fenster** (Option `fenster`: Haken im Reiter 📸 „Trainings-Fenster öffnen“ und im Asset-Manager, `--fenster` bei
`worker.py anlegen`, `SPIRULA_FENSTER=1`). Gezeigt wird Spirulas eigener Web-Viewer („Spirula Studio Viewer“: Livebild,
Fortschritt, Training anhalten, Navigation) in einem Chrome-Fenster ohne Adressleiste. Eine Fernsteuerung der
Desktop-GUI (`SS_GUI_AUTOMATION`) wurde verworfen: sie klickt Widgets per Namen an und setzt keine Trainingsparameter.

* **Eigene Chrome-Instanz mit eigenem Profilordner** (`<Auftrag>/_fenster`), und das ist keine Schönheit: der Viewer
  schaltet bei Serverende seine Navigation ab („Disconnected. Retrying…“), ein offen gebliebenes Fenster sah eingefroren aus
  (am 2026-11-01 so gemeldet). `_fenster_schliessen` beendet genau diese Instanz mit dem Training (auch bei Abbruch und
  Fehler), das Chrome des Nutzers bleibt unberührt; `_verwaiste_fenster_schliessen` räumt beim Start nach, falls der
  Worker mitten im Training starb. Geprüft: 10 Prozesse während des Trainings, 0 danach, Haupt-Chrome unverändert.
* **Die Startansicht muss eingestellt werden.** Der Viewer zentriert auf die **Kameramitte** und stellt die Kamera
  eine Einheit entfernt auf — für eine Drohnenaufnahme in Metern ist das leere Luft, und das Fenster zeigte nur Schwarz
  (am 2026-11-01 gemeldet; der Server renderte, wie ein Bild aus 1 m und 5 m Abstand vom Szenenmittelpunkt zeigte).
  Die Seite hat keinen Startparameter. Deshalb öffnet die Chrome-Instanz einen **DevTools-Port** (`--remote-debugging-port=0`,
  nur 127.0.0.1, nur dieses Fenster, nur während des Trainings; der Port steht in `<Profil>/DevToolsActivePort`), und
  `_fenster_einrichten` wählt dort einmal „Point cloud median“ und zieht die Kamera auf den Radius der Szene zurück
  (`_szenenradius`: 90-%-Abstand der Modellpunkte vom Median, **ohne Spurfilter** — die Atlas-Punkte haben keine
  Spur). Das WebSocket-Gespräch ist in `_cdp` von Hand geschrieben (der Worker läuft mit der Systempython;
  Prüfstein mit einem Mini-Server in `tests/test_splatwerk.py`). Es ist Komfort: scheitert es, bleibt das Fenster
  benutzbar, man wählt die Mitte dann im Fenster („Center“, danach „Reset Camera“).
* **`open -n` ist nötig**, sonst reicht `open` die Argumente nicht an ein laufendes Chrome weiter. Ohne Chrome geht die
  Adresse an den Standardbrowser — der lässt sich nicht gezielt schließen.
* **Der Viewer lauscht auf allen Schnittstellen** (`0.0.0.0`, gemessen), `--viewer-port` ist die einzige Einstellung.
  Er ist deshalb nur im Fenster-Modus an und geht ohne Haken gar nicht erst auf (`--disable-viewer 1`). Der Port ist der
  erste freie ab 7007 (`SPIRULA_VIEWER_PORT`).
* **`spirula gui --help` startet die GUI**, statt Hilfe zu zeigen; `spirula train --help` und `--help-all` sind ungefährlich.

**Gemessen** (M4 Pro, 40 Drohnenfotos Marksburg, `schnell`, mit Fenster): 7 min gesamt, Training 277 s für 6 000 Schritte,
Obergrenze von 1,5 Mio. Splats erreicht (Brush kam auf 474 081), 42 664 Startpunkte, PSNR rund 30 dB auf den Trainingsbildern;
`gps_3d`, RMS 0,02 m, 40 von 40 Inliern; `ergebnis.ply` 372 MB; im Backend 1 435 260 Splats nach dem Ausreißerfilter,
verortet bei 7,649° O / 50,272° N. **Lage:** Abstand COLMAP-Punkt → nächster Splat Median 2,9 cm, 90 % unter 8,8 cm (bei
absichtlich um 5 m verschobenen Splats 1,64 m — die Probe trennt).

**Offen:** `spirula sfm auto` (GPU-Merkmale, Abgleich, Mapper, liest und schreibt COLMAP-Formate, kann GPS und
Beschleunigungsmesser) könnte die COLMAP-CPU-Stufen ersetzen und die 250-Bilder-Grenze heben — nicht angeschlossen, weil
`ausrichtung` und `georef.py` auf COLMAPs Modell aufbauen. Der **SOG-Export** einer SH-3-PLY mit 1,4 Mio. Splats lief über
11 Minuten einkernig im Container (`splat-transform`, k-Means über die SH-Bänder); ob `sh_grad=` am Export genügt, ist nicht
gemessen. Noch nicht geprüft: die Qualitätsstufe `hoch` (8 Mio. Splats) und ein Lauf über 1 000 Bilder.

### Aufnahmepakete: Gaussian Splat King (`splatwerk/splatpack.py`, `iphone.py`) *(2026-10-10)*

Die iPhone-App „Gaussian Splat King“ nimmt mit **beiden Kameras gleichzeitig** auf (Weitwinkel
`wide` + Ultraweit `ultra`) und exportiert einen Ordner mit `splatpack.json` (Schema `splatpack.v2`).
Der Ordner kommt als ZIP oder als entpackter Ordner in `~/Downloads` an; beides geht hinein.

| Typ | Inhalt | Was die Pipeline daraus macht |
|---|---|---|
| `photo_dual` (`PhotoSeries_…`) | `wide_<id>.jpg` + `ultra_<id>.jpg` je Auslösung, je Bild eine `<name>.json` (Ort samt Genauigkeit, Bildschärfe, Beschleunigungsmesser), `splatpack.json` mit Zeiten | Kamera je Strom; Ort und Genauigkeit aus der Begleitdatei; **als `poor` eingestufte (verwackelte) Bilder fliegen raus**, solange es ≤ 30 % sind |
| `video_dual` (`Video_…`) | `wide.mov`, `ultra.mov`, `frame_timecodes.csv` (Unix-Zeit je Bild), `metadata.json` (Sichtfeld), Positionsspur in `splatpack.json` (1 Hz) | Je Video die **schärfsten** Bilder; Ort je Bild aus der Spur; Sichtfeld → Startbrennweite |

* **Eine COLMAP-Kamera je Optik** (`kamera` in `bilder.json`; `merkmale` ruft `feature_extractor` je Gruppe mit
  `--image_list_path` + `single_camera 1`). Vorher waren es bei zwei Brennweiten *vierhundert* Kameras (eine je Bild).
  Videobilder tragen keine EXIF-Brennweite: das Sichtfeld der App (`fieldOfView`, horizontal über die lange
  Kante) wird zu `f = (Kante/2)/tan(FOV/2)` und als `--ImageReader.camera_params` mitgegeben.
* **Bildauswahl aus Videos** (`_video_auswahl`): einmal klein dekodieren (384 × 384 grau, ffmpeg, ~40 s für
  4 597 Bilder in 4K), je Gradientenstärke bewerten, **je Zeitfenster das schärfste Bild**; ein zweiter
  Durchlauf (`select=eq(n,…)`) schreibt nur diese Bilder, schon auf `bild_max` verkleinert. Höchstens
  5 Bilder je Sekunde; bei einem Doppelvideo 60 % von `video_bilder` je Strom.
* **Der Abgleich kennt Kameras** (`_paare`, > 250 Bilder): Nachbarn je Kamera + die gleichzeitigen Bilder der
  anderen Kamera + GPS-Nachbarn **nur, wenn das GPS etwas auflöst** (Ausdehnung ≥ 3 × Genauigkeit; sonst
  Zufallspaare) + **Schleifenschluss über 24 × 24-Miniaturen** (die vier ähnlichsten Bilder jenseits von
  ±30 Plätzen). Der alte Lauf mit denselben Videos zerfiel in 9 Teilmodelle, das größte mit 123 von 400 Bildern.
* **Hochachse aus der Schwerkraft des Geräts.** Jedes iPhone-Foto trägt im MakerNote den Beschleunigungs-
  messer (Tag 8, Einheit g); `iphone.py` liest ihn aus dem EXIF (eigener Parser, bei allen 88 Testbildern
  identisch mit der Begleitdatei) oder aus `{MakerApple}["8"]`. Über die EXIF-Orientierung wird er in den
  Rahmen des aufrechten Bildes gedreht (`hoch_im_bild`, alle vier Haltungen getestet) und über die
  COLMAP-Pose in den Weltrahmen. `georef.ausrichtung(schwerkraft=…)` nimmt sie **vor** der Kameralage, die
  Kameras bleiben Gegenprobe (`abweichung_schwerkraft_kameras_deg`, Hinweis ab 10°) und Rückfall.
  Das gilt für **jedes** iPhone-Foto, nicht nur für Aufnahmen der App.
* **Ordnerstruktur im Upload.** Die Drop-Zone schickt `Ordner/Datei.jpg` als Dateinamen
  (`auftrag.sauberer_pfad`, ohne `..`), und `.json/.csv/.ndjson` zählen als Begleitdateien (nur zusammen mit
  mindestens einem Medium). Der Hotfolder nimmt lose Begleitdateien mit. Ohne die Begleitdateien fehlten
  Ort, Zeit und Sichtfeld — das Paket wäre nur ein Haufen Bilder.
* **Ohne messbaren Maßstab wird einer geschätzt — und so genannt.** Im Innenraum ist das GPS Rauschen
  (Buddha: 8 m Streuung, Genauigkeit 4–39 m), Modus `schwerkraft`. COLMAP-Einheiten sind dann beliebig
  (Buddha: 20-mal zu groß, 30 m breit). `ausrichtung` nimmt deshalb an, dass die Kameras im Mittel 1 m vom
  Gesehenen standen (`ANGENOMMENER_ABSTAND_M`, Median der Kamera→Punkt-Abstände aus `points3D.txt`), und
  setzt `massstab_geschaetzt` + Hinweis; `massstab_bekannt` bleibt `False`. Eine Handaufnahme liegt zwischen
  0,3 und 3 m — die Annahme verfehlt höchstens um etwa 3, nicht um 20. Der Buddha kam so auf Maßstab 0,152.
  **Die Größe stimmt nur der Größenordnung nach; im Positionsformular mit einem bekannten Maß nachstellen.**
  (Offene Idee: der Abstand der Linsenmitten Wide↔Ultra ist ein Lineal — im Modell Median 0,29 Einheiten
  bei MAD 30 % über 35 Paare —, braucht aber den Linsenabstand des Telefons.)
* **Unterkante aus den sicheren Punkten, nicht aus dem Splat.** Trainer lassen Ausreißer zurück (Brush, Buddha:
  Splats bei −18 m und +11 m um ein 1-m-Objekt); die Hüllbox-Mitte lag unter der Kommode, und „Unterkante
  aufs Gelände“ hätte den Splat 20 m hoch schweben lassen. `ausrichtung` schreibt `boden_z_enu` (1-%-Perzentil
  der Punkte mit Spur ≥ 3 und Fehler < 2 px) in `georef.json`; `uebernahme.unterkante_fuer` nimmt sie und darf
  negativ werden (Verortungspunkt im Boden, Splat darauf).
* **`caffeinate -i` um jedes Programm** (`worker.lauf`): der Mac schläft auf Akku nach einer Minute im Leerlauf.
  Der Buddha-Lauf zeigte außerdem Schwankungen bis zum 50-Fachen (Merkmale 20 min statt 30 s) — im Akkubetrieb mit
  laufendem Backup-Dienst; in Ruhe gemessen 0,4 s/Bild. Für lange Läufe am Netz betreiben.
* **Gemessen (Buddha, Foto-Serie, `standard`):** 88 Bilder, 12 als verwackelt aussortiert, **76 von 76 in einem Modell**,
  Reprojektionsfehler Wide 1,46 px / Ultra 1,40 px (Brennweiten 1675 / 912 px), Schwerkraft über alle Bilder auf
  1,46° einheitlich (die Kameralage allein wäre 7° daneben gewesen), 625 034 Splats, 147 MB; Gegenprobe mit einem
  eigenen Rasterizer aus den Aufnahmekameras und aus einer neuen Ansicht dazwischen: Lage, Tiefenordnung und
  Feinheiten stimmen.
* **Gemessen (Video, `schnell`, dieselben 2 × 4 597 Bilder wie der Altlauf):** `vorbereiten` 260 s (2 × 4K dekodieren,
  72 schärfste Bilder je Strom), Merkmale 32 s, Abgleich 2 089 statt ~10 000 Paare 45 s, Rekonstruktion 22 s —
  **ein Modell mit 94 von 144 Bildern (65 %)**; der Altlauf (gleichmäßig gezogen, Kamera je Bild, nur Nachbarn im
  Video) zerfiel in 9 Teilmodelle, das größte mit 123 von 400 (31 %). Training 168 s, 156 621 Splats,
  insgesamt 8,8 min statt 60. Das Video hat keine Schwerkraftdaten: die Hochachse kommt aus den Kameras.
* **Platz:** nach `vorbereiten` wird `roh/` gelöscht (bei 4,6 GB Video wären es sonst zweimal 4,6 GB);
  der Upload in `eingang/` bleibt bis zum Ende. **Große Videopakete besser per
  `worker.py anlegen <Ordner>`** (Hardlinks, keine Kopie) oder in den Hotfolder als Ordner ziehen
  als durch den Browser zu schicken.

### Die Georeferenzierung (`splatwerk/georef.py`)

COLMAP rekonstruiert in einem willkürlichen Rahmen (Maßstab, Drehung, Ursprung bei der ersten
Kamera); **der Trainer schreibt die PLY unverändert in diesem Rahmen** (Brush an `Buddah/` gemessen: Identität,
Medianabstand 4 cm; Spirula Studio an Marksburg mit `--scene-center none`: Median 2,9 cm). Eine fertige PLY nachträglich zu drehen hieße, die SH-Bänder
mitzudrehen (Wigner-D). Deshalb wird das **COLMAP-Modell vor dem Training** transformiert
(`model_transformer`), und der Trainer trainiert gleich in Ost/Nord/Oben, Metern.

| Modus | Wann | Was bekannt ist |
|---|---|---|
| `gps_3d` | Drohne (Make „DJI“), GPS-Höhe genau | Position, Maßstab, Richtung — volle 7-Parameter-Anpassung |
| `schwerkraft_gps` | Handy mit GPS, ≥ 4 Bilder, ≥ 15 m Ausdehnung | dito; **GPS-Höhe geht nur als Mittelwert ein** |
| `schwerkraft` | GPS, aber Aufnahme kleiner als das Rauschen | Ort, Hochachse — **Maßstab und Richtung unbekannt** |
| `annahme` | kein GPS, Hochachse nicht ableitbar | nichts; oben = −y von COLMAP |

* **Die Hochachse kommt aus den Kameras, nicht aus der GPS-Höhe**, wo sie es kann. Ein Handy-
  GPS streut in der Höhe um ±10 m; über 50 m Ausdehnung wären das 10° Kippung, wenn die Höhen
  in die Drehung eingingen. Der Trick (`hochachse_aus_kameras`): bei aufrechten Fotos ist „Bild
  rechts“ **waagerecht, egal wie steil die Kamera schaut** — die Hochachse ist die Richtung
  geringster Streuung aller Rechtsvektoren. Das trägt auch für Senkrechtaufnahmen, wo die
  Bildoberkante nichts über die Schwerkraft sagt. Sind alle Rechtsvektoren parallel
  (Drohnenraster, alle gleich ausgerichtet), ist sie nur bis auf eine Drehung bestimmt — dann
  entscheidet `gps_3d` mit den (bei Drohnen genauen) Höhen.
* **Ob eine GPS-Anpassung Signal oder Rauschen ist,** entscheidet nicht die Ausdehnung der
  Positionen — das Rauschen bläht sie selbst auf (60 Punkte mit σ = 4 m spannen 20 m auf). Es
  zählt der **Anteil der Streuung, den die Anpassung erklärt** (`signalanteil` ≥ 0,5). Eine
  3-m-Umrundung eines Objekts mit Handy-GPS fällt damit auf `schwerkraft` zurück, statt einen
  erfundenen Maßstab zu liefern. Geprüft in `tests/test_splat_georef.py` (Fall 3).
* **Ausreißer im GPS** (Mehrwege, erster Fix) werden per RANSAC aussortiert; beim 10-%-Ausreißer-
  Test bleibt der Maßstab auf 0,4 %.
* **Der Ursprung des ENU-Systems liegt am Median der Bildpositionen** und der Höhe (`ursprung`
  in `georef.json`). Die Höhe der EXIF-Daten gilt als **m ü. NHN** (`msl`); fehlt sie, setzt die
  Übernahme die Unterkante aufs Gelände.
* **Was nicht geht, steht im Auftrag** (`georef.hinweise`) und in der Oberfläche — nicht nur im
  Log. Ein Splat ohne Maßstab ist kein Fehler, aber der Nutzer muss es wissen, bevor er ihn
  vermisst.

### Die Verortung im Backend (`splatwerk/uebernahme.py`)

Der Splat-Handler zentriert auf die Mitte der Hüllbox und schreibt den Inhalt relativ zur Mitte
des Wurzelkastens (siehe „Gaussian Splats → LOD-Aufbau“, `modellversatz`). Die Platzierung gilt
daher für **diese Mitte**, nicht für den Quellursprung. Wer eine Position aus den
Quellkoordinaten kennt (GPS, CRS), muss sie umrechnen: `quelloffset − modellversatz`.
`tile_splat()` schreibt dafür seit dem 2026-10-10 `root.extras.ileen_splat.quelloffset`. Ohne
das läge jeder verortete Splat um die halbe Modellausdehnung daneben — still, weil das Modell
trotzdem sichtbar ist.

Auftragskennung = Asset-Kennung (`job_id`): keine Zuordnungstabelle. Die Quelle in `uploads/`
ist die trainierte PLY, damit das Asset als Splat geführt wird und der Export seine Eingabe an
der einen Stelle findet.

### Laserscan → Splat (`splatwerk/scan2gs.py`)

Upload mit `POST /upload/?als=splat[&voxel_cm=…]` (Haken „Punktwolke als Gaussian Splat
umrechnen“ im Asset-Manager). Portiert aus `~/Projekte/Scan23dgs/scan2gs.py`, **derselbe
Rechenweg und dieselben Voreinstellungen**; geprüft an `Project6.las`: 705 989 Surfels gegen
705 603 im Original, σ_t-Median 1620,35 gegen 1620,03 mm, Schwerpunktversatz bis auf die
vierte Nachkommastelle gleich. Geändert hat sich, *wie* gerechnet wird:

* **Kein Open3D.** Voxel-Mittelung, Ausreißerfilter und lokale PCA waren die drei Stellen, die
  es brauchten. Alle drei sind NumPy/SciPy; **ein** kNN-Aufruf dient Ausreißern *und* PCA. Open3D
  zählt den Punkt selbst zur Nachbarschaft (`k = 16` heißt 16 Punkte *einschließlich* seiner
  selbst) — ohne das lagen die Surfels 6 % zu groß.
* **Gestreamt** in Blöcken zu 4 Mio. Punkten, jeder sofort auf ein Voxelraster reduziert.
* **Voxelgröße automatisch**, bis höchstens `SCAN_SPLAT_MAX` (6 Mio.) übrig sind. Ein 5-mm-Scan
  mit 300 Mio. Punkten scheitert sonst an der Datei statt an einer Einstellung.
* **CRS aus dem LAS-Kopf** verortet wie eine Punktwolke (`placement_from_projected`: Meridian-
  konvergenz als `heading`, Punktmaßstab als `scale`). Ohne CRS steht die Unterkante auf dem
  Gelände am Referenzpunkt.
* E57 geht weiterhin nicht (pye57 hat keine Linux-arm64-Wheels); vorher nach LAS/LAZ wandeln.

**`lazrs` fehlte im Container.** `py3dtiles[las]` zieht laspy, aber kein Entpackprogramm für
`.laz`: *jeder* LAZ-Upload scheiterte bis dahin erst im Tiling mit „No LazBackend selected“,
obwohl die Upload-Maske `.laz` annimmt. Jetzt in `requirements-splat.txt`, mit eigenem Docker-
Layer, damit eine Änderung dort nicht den großen pip-Layer (JAX, torch) neu bauen lässt.

### SOG-Export (`splatwerk/sog.py`, `api/routes/splat_export.py`)

```
POST /assets/{job}/export/sog?ausrichtung=auto&sh_grad=   anstoßen (Treffer im Cache: sofort fertig)
GET  /assets/{job}/export/sog/status                      wartet · laeuft · fertig · fehler
GET  /assets/{job}/export/sog                             die Datei
GET  /assets/{job}/export/ply                             die 3DGS-PLY (Quelle des Tilings)
```

Im Asset-Manager der Knopf ⬇ an jedem Splat-Asset (Umschalt: PLY). Gerechnet wird mit PlayCanvas'
eigenem `@playcanvas/splat-transform` (Node ≥ 22, im Image per Multi-Stage-Build; `-g cpu`). Das
Format selbst nachzubauen hieße, einen k-Means-Kodierer zu pflegen, der sich mit jeder Version
verschiebt. Ein Export läuft im Hintergrund und einer nach dem anderen (Speicher); das Ergebnis
liegt im Bucket `exports` — die Quelle ändert sich nie, also gilt der Cache für immer. Beim
Löschen des Assets räumt `purge_exports()` mit weg.

**Ausrichtung.** Die Welt der Splat-Werkzeuge (SuperSplat, PlayCanvas, `splides`) ist die von
COLMAP: y unten. Ein georeferenzierter Splat von hier ist Z-up. Unverändert exportiert läge er
dort auf der Seite. Bei `ausrichtung=auto` wird eine PLY, die `Vertical axis: z` meldet (alles,
was `splatwerk` erzeugt), um **−90° um x** gedreht, `(x, y, z) → (x, −z, y)`. Nicht `+90°`: die
Richtung von `splat-transform -r` ist an einer Probe gemessen, `+90` ergibt `(x, z, −y)`, also
einen Kopfstand. Splat-Orientierungen drehen mit (Normalen am Boden zeigen danach entlang −y).
Eine PLY ohne Hochachsen-Angabe — fremde Trainer — bleibt unberührt: sie liegt schon im Rahmen
der Werkzeuge.

### Fallen, an denen es sonst still falsch wird

* **Brushs `Vertical axis: y` ist ein Etikett, keine Aussage** (nur noch für Brush-PLYs von Hand; Spirula
  schreibt gar keinen Kommentar, siehe unten). Brush schrieb es immer, auch für eine Szene, die Z-up trainiert wurde. `tiling/formats/splat.py` dreht bei `y` die ganze
  Szene um 90° — ein ENU-ausgerichtetes Modell läge danach auf der Seite. Der Worker berichtigt
  den Kommentar am Ende an Ort und Stelle (`plyhilfe.setze_hochachse`: `y` und `z` sind gleich
  lang, kein Umkopieren). **Wer eine Brush-PLY von Hand hochlädt, die aus einem Z-up-Modell
  stammt, muss dasselbe tun.**
* **`colmap model_transformer` liest keine Matrix.** Die Datei besteht aus **einer Zeile**
  `Maßstab qw qx qy qz tx ty tz`. Eine 3×4- oder 4×4-Matrix wird *stillschweigend* falsch
  gelesen: heraus kommen NaN-Posen, ohne Fehler. Abgeleitet aus der Ausgabe von
  `model_aligner --transform_path`; geschrieben von `colmap_modell.schreibe_sim3`. Der Worker
  prüft das Ergebnis gegen die berechnete Matrix (`ausrichtung()`, Gegenprobe).
* **`images.txt` statt `images.bin`.** COLMAP 3.12 hat Rigs und Frames eingeführt; das Textformat
  der Posen ist davon unberührt (`model_converter --output_type TXT`).
* **Eine Kamera je Optik** (Größe, Gerät, EXIF-Brennweite, bei Paketen der Strom): ein Handy mit
  Weitwinkel und Tele hat bei gleicher Bildgröße zwei Brennweiten. Früher gab es dann *eine Kamera
  je Bild* (`single_camera 0`) — jetzt läuft `feature_extractor` je Gruppe.
* **EXIF-Orientierung wird eingebacken**, die Bilder sind danach aufrecht und ohne Tag. Die
  Hochachsen-Schätzung setzt das voraus — ein hochkant gehaltenes Foto hat sonst Bild-oben auf
  der Sensor-x-Achse. Die 35-mm-Brennweite (Tag `0xA405`) wird mitgeschrieben: COLMAP nimmt sie
  als Startwert („Prior“), ohne sie muss es die Brennweite aus 1,2 · Bildkante erraten.
* **Der Trainer bekommt verzeichnungsfreie Bilder.** `image_undistorter` vor dem Training bleibt (Brush kannte
  keine Linsenverzeichnung; Spirula kennt sie, aber das Modell ist darauf ausgerichtet); der Trainer liest
  `train/images` und `train/sparse/0`.
* **Der Auftrag heißt `laedt`, solange der Upload läuft.** Der Worker nimmt nur `wartet` auf —
  ein halb übertragener Auftrag darf ihm nicht in die Hände fallen.
* **Kennungen kommen aus URLs.** `auftrag.verzeichnis()` lässt nur UUIDs zu; sonst wäre `../`
  ein Weg aus dem Volume. Ein ZIP aus dem Internet wird mit Zip-Slip-Schutz entpackt.
* **`docker compose build` hängt, wenn der Anmeldehelfer (`docker-credential-desktop`) auf eine
  Keychain-Abfrage wartet** — am 2026-10-10 dreizehn Minuten lang, ohne Meldung. Abhilfe ohne
  die eigene Konfiguration anzufassen: `DOCKER_CONFIG` auf ein Verzeichnis mit
  `{"auths":{}}` und einem Link auf `~/.docker/cli-plugins` setzen.

### Grenzen

COLMAP auf der CPU: ab etwa 600 Bildern dauert allein der Abgleich Stunden. Ein Splat aus Handy-
Fotos von einem kleinen Objekt hat keinen Maßstab (die Aufnahme ist kleiner als das GPS-
Rauschen) — Positionsformular, Feld „Maßstab“. Das Training läuft stehend durch; ein Neustart
des Workers setzt bei der ersten nicht abgeschlossenen **Stufe** fort, nicht mitten im Trainings-
lauf. Videos werden je Zeitfenster auf das schärfste Bild reduziert (siehe „Aufnahmepakete“), aber
nicht auf Überlappung geprüft: steht die Kamera still, sind benachbarte Bilder fast gleich.

### Prüfen

```bash
python3 tests/test_splat_georef.py   # 29 Prüfungen: Hochachse aus Kameras, GPS-Anpassung, Ausreißer, EXIF
python3 tests/test_splatwerk.py      # Surfels, Hochachsen-Kommentar, Warteschlange, ZIP, SOG-Lage
python3 tests/test_splatpack.py      # Aufnahmepakete, Schwerkraft (4 Haltungen), Videoauswahl, Kamerapaare, COLMAP-Kameras
```

Der Teil mit COLMAP und Spirula wird mit echten Fotos geprüft, nicht im Test: 40 Drohnenfotos aus
`~/Projekte/DJI_202502180839_001/images_original` (`python3 splatwerk/worker.py anlegen … --qualitaet
schnell`, dann `worker.py einmal`) liefern in sieben Minuten `gps_3d` mit 2 cm Abweichung zum GPS.

### Verfahren „Atlas" und Mesh — World Labs in der Pipeline *(2026-10-21)*

Zwei Auftragsoptionen (`auftrag.json` → `optionen`), beide über das Formular (`POST /splat-training`:
`verfahren`, `mesh`, `mesh_ansicht`), den iLEEN-Reiter 📸 „Fotos → 3D" und den Asset-Manager:

| Option | Wirkung |
|---|---|
| `verfahren: colmap` | der bisherige Weg, unverändert (Vorgabe; Aufträge ohne das Feld und der Hotfolder) |
| `verfahren: atlas` | World Labs `images2PosedRGBD` schätzt Kameras **und dichte Tiefe**; Spirula trainiert lokal |
| `mesh: true` | nach der Übernahme `splats2Mesh` → eigenes Mesh-Asset, deckungsgleich (für **beide** Verfahren) |

```
COLMAP:  entpacken → vorbereiten → merkmale → abgleich → rekonstruktion → ausrichtung → entzerren → training → abschluss
Atlas:   entpacken → vorbereiten → atlas_posen → atlas_modell → atlas_ausrichtung →             training → abschluss
```

* **`atlas_posen`** (Worker): Bilder inline hochladen, ein Auftrag je Teil (bis `ATLAS_MAX_BILDER` = 100,
  sonst überlappende Teile zu je 100 mit 20 gemeinsamen), `targetResolution` = Seitenverhältnis der Mehrheit,
  lange Kante `ATLAS_RASTER` = 1280, `refinePoses` ab zwei Bildern. **Hochgeladen wird jedes Bild schon im
  Seitenverhältnis des Rasters** (`atlas_rekon.vorrahmen`, mittig beschnitten, in `zustand.json` →
  `vorrahmen`): Atlas *verzerrt* ein Bild, das nicht passt, statt es zu beschneiden. Tiefe (EXR), Konfidenz
  (PNG) und das zurückgegebene Bild **jedes** Frames landen in `atlas/`. **Was bezahlt ist, wird nicht noch einmal bezahlt:**
  hochgeladene Assets, Operation und Fertigstand je Teil stehen in `atlas/zustand.json`; ein Neustart des
  Workers wartet auf dieselbe Operation weiter, statt neu einzureichen (Idempotenzschlüssel
  `ileen-splat-<auftrag>-<teil>-<versuch>`).
* **`atlas_modell`** (`splatwerk/atlas_rekon.py`, rein): Teile über die gemeinsamen Bilder zusammensetzen
  (Ähnlichkeit aus Zentren *und* Punkten in Blickrichtung — auf einer Drohnenbahn wäre die Drehung um die
  Bahn sonst frei), Tiefe → Startpunkte mit drei Filtern (Konfidenz ≥ 0,5, Tiefensprung > 4 % → „fliegende
  Punkte" weg, Ferne > 4 × Median → Himmel weg), Voxel ≈ 2 Pixel in mittlerer Entfernung, höchstens
  `ATLAS_STARTPUNKTE` = 800 000, Farben aus Atlas' eigenem Bild (pixelgenau zur Tiefe). **Welchen Ausschnitt
  Atlas genommen hat, wird je Bild gemessen, nicht angenommen** (`ausschnitt_messen`: SIFT + RANSAC, Abbildung
  `p_hoch = a·p_raster + b` je Achse; Intrinsik `fx = a_x·fx_t`, `cx = a_x·cx_t + b_x + Vorrahmen`). Ein Bild
  ohne Struktur bekommt den Median-Anteil der übrigen, ein verzerrt zurückgegebenes fliegt raus (`isotrop`;
  sicher verzerrt ist jedes, das nicht im Seitenverhältnis des Rasters hochging). Ergebnis im Protokoll
  („Atlas-Ausschnitt: die mittleren 75,0 % × 75,5 % …") und im Bericht der Stufe (`ausschnitt`).

  **Gemessen am ersten echten Lauf (2026-10-21, 10 iPhone-17-Pro-Fotos, Raster 960×1280):** Atlas nimmt die
  **mittleren ~75 % je Achse** und zieht sie aufs Raster — ein Zoom um 1,33, die Intrinsik gilt für diesen
  Ausschnitt (fx ≈ 1200 px statt ≈ 850). Die erste Fassung nahm „scale-to-cover ohne Zoom" an und rechnete
  damit einen um ein Drittel zu engen Bildwinkel (fx 1497 statt 1123 px auf 1200×1600) — die Probe hat es
  gemeldet, das Training lief trotzdem (jetzt: abgebrochen, nachgerechnet). Ein Querformat im
  Hochformat-Auftrag kam **verzerrt** zurück (× 1,24 / × 0,71, Konfidenz fast null). Nach der Messung: Farben
  der Startpunkte in den eigenen Bildern Abweichung ≈ 30 statt 41–52 Grauwerte (ohne Verdeckungstest). Atlas
  antwortete nach ~5 s (10 Bilder).
* **`atlas_ausrichtung`**: `georef.ausrichtung` wie im COLMAP-Weg, Hochachse aus der Schwerkraft des Geräts,
  sonst aus Atlas (die Rekonstruktion ist schwerkraftgerichtet, Y oben → `hochachse_quelle: atlas`). Ohne
  tragendes GPS gilt **Maßstab 1 = Atlas' metrische Schätzung** (`massstab_quelle: atlas`), nicht die
  1-m-Annahme des COLMAP-Wegs. Modell nach `colmap/txt_ausgerichtet/` und `train/sparse/0/` — als
  Textmodell, PINHOLE je Bild, Punkte **ohne Spur** (Brush und Spirula lesen sie als Startpositionen, beide geprüft), Bilder
  per Hardlink nach `train/images/`. COLMAP wird auf diesem Weg nicht gebraucht.
* **Mesh** (Container, `ileen/atlas_mesh.py`, `api/routes/atlas.py` → `mesh_*`): siehe „Atlas — World Labs".
  Ansichtspunkte für `splats2Mesh` sind bei Foto-Splats die **echten Aufnahmeorte** (`manual_anchors`,
  höchstens 64, gleichmäßig ausgedünnt) aus `colmap/txt_ausgerichtet/images.txt` — die Datei bleibt beim
  Aufräumen deshalb liegen.

**Behobener Lesefehler (betraf auch COLMAP-Modelle):** `colmap_modell.lese_bilder_txt` filterte leere Zeilen
und paarte danach Kopf- und Punktzeilen. Ein Bild ohne 2D-Punkte hat aber eine *leere* zweite Zeile — danach
war jede zweite Kamera falsch. Jetzt zählen leere Zeilen mit.

**Probelauf ohne Schlüssel und ohne Kosten:** `tests/worldlabs_attrappe.py --vorlage data/training/<auftrag>`
spricht die benutzten Teile der API und beantwortet `images2PosedRGBD` mit den Kameras und Punkten eines
fertigen COLMAP-Auftrags — gedreht (63° um die Hochachse), verschoben, Maßstab 0,37, das Bild **wie das echte
Atlas** auf die mittleren 75,4 % gezogen (bei falschem Seitenverhältnis verzerrt) — und `splats2Mesh` mit
Würfeln an den Splat-Positionen. Gemessen an Marksburg Hof (40 Drohnenfotos, `schnell`): **alle 40 Kameras
auf 0,0 cm / 0,000° dort, wo der COLMAP-Lauf sie hatte**, Maßstab 2,7027 (= 1/0,37) gefunden, 758 338
Splats, 6 min gesamt; Mesh-Asset deckt sich im Viewer mit dem Splat. Mit dem 75,4-%-Ausschnitt nachgeprüft
(Stufen ohne Trainer): 40 von 40 Ausschnitten gemessen (Restfehler 0,04 px), Kameras 0,00 cm, fx 1130,91 gegen
1130,92 px. Für Anfragen *aus dem Container* muss die
Attrappe im Container laufen (`docker cp` nach `/tmp`, `PYTHONPATH=/app`): Docker Desktop leitet
`host.docker.internal` nicht auf Dienste, die nur an `127.0.0.1` lauschen. Puppeteer-Fallen beim Prüfen:
binäre Körper kommen nur über `fetchPostData()`, und `sendBeacon` läuft am Abfangen vorbei.

```bash
python3 tests/test_splat_atlas.py    # Raster, Vorrahmen, Ausschnitt messen, Intrinsik, RUB↔COLMAP, Tiefe→Punkte, Teile, Mesh
```

## Höhenbezug — warum Modelle ~170 m zu tief lagen

Die Höhe im `root.transform` ist zwingend eine Höhe über dem **WGS84-Ellipsoid**.
Damit arbeitet aber niemand: Bauwerke sind in Metern über NHN geplant, und
CesiumJS zeigt sie auf Cesium World Terrain, dessen Oberfläche ellipsoidisch
referenziert ist. Am Campus Holzstraße stecken darin zwei getrennte Beträge:

```
  Geländeoberkante      130 m ü. NHN     (Copernicus DEM)
+ Geoidundulation        47,6 m          (EGM2008, regional nahezu konstant)
= ellipsoidische Höhe   177,6 m
```

Ein mit `TILESET_ORIGIN_HEIGHT=90` als Ellipsoidhöhe verortetes Modell lag
damit ~88 m unter dem Gelände — der Geoid allein erklärte nur gut ein Viertel
der Differenz, der große Rest war schlicht Topografie.

`tiling/elevation.py` löst beides auf. `TILESET_ORIGIN_HEIGHT_REFERENCE` und
das Feld `height_reference` je Platzierung bestimmen, wie die eingegebene Höhe
gemeint ist:

| Bezug | Bedeutung | Auflösung |
|---|---|---|
| `terrain` | über Geländeoberkante (Standard) | Höhe + DEM-Höhe + Undulation |
| `msl` | über NHN / Meeresspiegel | Höhe + Undulation |
| `ellipsoid` | roh, wie im Transform | unverändert |

Der aufgelöste Wert wird als `height_ellipsoid` in der `placement.json`
mitgeschrieben — die Matrix bleibt damit ohne DEM-Abfrage reproduzierbar, und
Bestandsplatzierungen ohne `height_reference` gelten weiter als `ellipsoid`.

Drei Dinge, die man dazu wissen muss:

* **Der DEM-Aufruf ist der einzige Punkt im Stack, der ins Internet greift**
  (`ELEVATION_API_URL`, Copernicus DEM 90 m über Open-Meteo, ohne Schlüssel).
  Leer setzen schaltet ihn ab, dann wirkt `terrain` wie `msl`. Ein Fehlschlag
  bricht das Tiling nie ab, er fällt auf den Geoidbezug zurück.
* **Copernicus GLO-90 ist ein Oberflächenmodell.** In bebautem Gebiet liegt es
  einige Meter über dem echten Boden — am Campus 177,6 m gegenüber 170 m, die
  sich beim Einpassen von Hand ergeben hatten. Wer es genau braucht, gibt unter
  `terrain` eine negative Höhe an oder bleibt bei `ellipsoid`.
* **Die Undulation ist eine Konstante, kein Gitter** (`GEOID_UNDULATION_M`,
  47,6 m für Rhein-Main). Sie ändert sich in Deutschland um weniger als einen
  Meter je 50 km — ein EGM-Gitter im Container wäre ein Megabyte für einen
  Effekt unterhalb der Genauigkeit, mit der ein IFC-Nullpunkt angegeben ist.

Im UI stellt der Höhenbezug sich als Auswahl dar, `Auf Gelände` setzt in einem
Klick auf `terrain`/0, und die Infozeile zeigt durchgehend, was daraus
ellipsoidisch wird. Die Geländeauskunft selbst liefert `GET /geo/elevation`.

### Warum der Viewer die Auflösung wiederholen muss

Die aufgelöste Höhe steht als feste Ellipsoidhöhe im `root.transform` — sie
gilt gegen *das Geländemodell des Backends* (Copernicus GLO-90 oder die lokale
Referenz). CesiumJS zeigt aber Cesium World Terrain: dieselbe Stelle, andere
Datenquelle, andere Geländehöhe. Genau um diese Differenz schwebte oder versank
ein Modell im Viewer, obwohl im Asset-Manager „auf Gelände" eingestellt war.

Deshalb schreibt `georef.placement_extras()` die *Absicht* zusätzlich in die
tileset.json:

```json
"root": {
  "transform": [...],
  "extras": { "ileen": {
    "lon": 8.256, "lat": 49.995,
    "height": 0.0, "heightReference": "terrain",
    "heightEllipsoid": 166.6, "geoidUndulation": 47.6,
    "adjustable": true
  }}
}
```

Der Transform allein sagt nur, *wo* das Modell liegt, nicht *wie* die Position
gemeint war. Mit diesen Feldern rechnet `terrain-align.js` im Frontend dieselbe
Auflösung gegen sein eigenes Terrain nach und legt die Differenz als
Vertikalversatz auf die `modelMatrix`.

Bewusst in der tileset.json und nicht nur über `GET /assets/{id}/placement`: so
funktioniert es auch, wenn die Tiles direkt aus dem öffentlichen MinIO-Bucket
geladen werden. `georef.apply_placement()` schreibt Matrix und Extras immer
zusammen — sonst laufen sie auseinander. Tilesets von vor dieser Erweiterung
haben keine Extras; das Frontend fällt für sie auf die Placement-API zurück.

## DGM1 RLP — das Gelände des Viewers *(2026-11-01)*

`GET /gelaende/dgm1/info` und `GET /gelaende/dgm1/{z}/{x}/{y}` (`api/routes/gelaende.py`). Der Viewer
(`frontend/gelaende.js`) nimmt es vor DGM5 (basemap.de) und Terrain Tiles; in RLP verfeinert er bis Ebene 18.
Anlass: der BKG-Server fiel am 2026-10-31 aus, und das DGM5 darf ohnehin nicht zwischengespeichert werden. Das DGM1
steht unter dl-de/by-2-0 und darf hier liegen und ausgeliefert werden.

* **Kacheln auf Anfrage**, nicht vorab (bei 1 m wären es über eine Million). Kachelschema = Cesiums
  `GeographicTilingScheme` (y von Norden), 65 × 65 Stützstellen, Float32, Reihe 0 im **Süden**, m ü. NHN, NaN
  ohne Daten, 204 ganz außerhalb. Den EGM96-Aufschlag macht der Viewer.
* **Quelle nach Stützstellenabstand:** ≤ 6 m die 1-m-Originale (LRU 48 Kacheln), ≤ 24 m Übersicht 8 m, ≤ 96 m 32 m,
  sonst 128 m. Gemessen: 1-m-Kachel 50–70 ms, Übersicht 1 ms.
* **Daten** (beide nur lesend gemountet, siehe `docker-compose.yml`): Originale 31 GB unter
  `projekte/2026_1031_mainz_zwilling/arbeit/dgm1_rlp/` (`skripte/dgm1_rlp.py`), Übersichten 1,3 GB unter
  `data/dgm1/` (`skripte/dgm1_uebersichten.py`, uint16 = (h + 100) · 50).
* Eingespielt per `docker compose build api` + `up -d --no-deps api` (Image vom 2026-11-01; vorher lief eins vom
  2026-10-21 mit per `docker cp` nachgereichten Dateien).

## Lokale Geländereferenz — genauer als Copernicus GLO-90

Copernicus GLO-90 ist 90 m aufgelöst und ein Oberflächenmodell (siehe oben) —
für den Abgleich mit einem tatsächlich vermessenen oder modellierten Gelände
reicht das nicht. `tiling/terrain.py` erlaubt deshalb, ein im Backend
hochgeladenes Modell (IFC, Mesh oder Punktwolke) als Geländereferenz zu
markieren; ab da liefert `elevation.ground_msl()` für „über Gelände"
Platzierungen die Höhe aus diesem Modell statt aus dem externen Dienst —
außerhalb seiner Abdeckung bleibt das DEM der Fallback.

```
PUT    /geo/terrain-reference/{job_id}   # markiert das Asset, baut das Raster
GET    /geo/terrain-reference            # aktive Referenz, null wenn keine
DELETE /geo/terrain-reference            # entfernt sie wieder
```

Im Asset-Manager sitzt der Button „Als Geländereferenz verwenden" in der
Gruppe „Geländereferenz" des Bereichs 📍 Verortung — das Modell muss also vorher (auch mit dem
Verschiebe-Handle) exakt eingepasst sein, denn genau diese Platzierung geht in
das Raster ein. `GET /geo/elevation` bekommt zusätzlich ein Feld `source`
(`local`/`dem`/`none`), im UI direkt in der Höhen-Infozeile sichtbar.

Ablauf beim Markieren:

```
Quelldatei (uploads-Bucket) → Geometrie laden (IfcOpenShell/trimesh/laspy)
    → georef.recenter() (dieselbe Konvention wie beim Tiling)
    → georef.placement_transform() der aktuellen Platzierung → ECEF
    → georef.ecef_to_geodetic() → (lon, lat, Höhe über Ellipsoid)
    → in ein lon/lat-Raster gebinnt (Mittelwert je Zelle, Zellgröße in Metern
      über TERRAIN_GRID_RESOLUTION_M, Standard 2 m)
```

Für Mesh- und IFC-Quellen ist das exakt, weil beide Handler mit
`base_transform=None` tilen (siehe oben) — die Weltposition eines Vertex ist
schlicht `placement_transform() @ recenter(vertex)`, exakt nachvollzogen ohne
den Umweg über das Tiling selbst. Für Punktwolken gilt dieselbe Rechnung:
py3dtiles zentriert auf den Datenschwerpunkt statt auf die Grundflächenmitte,
aber dieser Schwerpunkt ist der Referenzpunkt der Platzierung — bei einer Wolke
mit CRS steht dann kein `base_transform` mehr dazwischen. Abgelehnt wird nur,
was `adjustable: false` trägt: Tilesets, die schon in ECEF liegen und deren
Weltposition dieses Modul nicht nachrechnet.

Das Raster liegt als zwei Objekte unter einem festen Präfix im tiles-Bucket
(`_terrain/reference.json`, `_terrain/grid_meta.json` +
`_terrain/grid_heights.npy`) — nicht unter einer job_id, weil es
bucket-weit genau eine aktive Referenz gibt. `assets.list_assets()` überspringt
Präfixe, die mit `_` beginnen, sonst erschiene `_terrain` als Phantom-Asset.
Nächste-Zelle-Abfrage statt bilinear: bei 1–2 m Zellgröße liegt der
Unterschied unter dem, was die Platzierung ohnehin nur auf Meter genau
eingibt, und NaN-Nachbarn (Lücken im Raster, keine Punkte in der Zelle)
müssten sonst gesondert behandelt werden — so liefert eine Lücke einfach
„außerhalb der Abdeckung" und der DEM-Fallback greift.

## Projektstruktur

```
CesiumBackend/
├── api/
│   ├── main.py                  # FastAPI App, CORS, Router, /ui-Mount
│   ├── static/
│   │   ├── index.html           # Asset-Manager: Upload, Verortung, Vorschau, Bauteilinfo
│   │   ├── ileen-ui.css         # Leiste, Panel, Bausteine wie im Viewer (Abbild aus frontend/)
│   │   ├── ileen-marke.svg      # Marke der Aktivitätsleiste (Kopie aus frontend/)
│   │   ├── materials.js         # Textur-Zuordnungsassistent (Dialog, Liste)
│   │   ├── materials.css        # dessen Styles
│   │   ├── material-modus.js    # Materialmodus: Texturen auf Bauteile ziehen
│   │   └── material-modus.css   # dessen Styles
│   └── routes/
│       ├── upload.py            # POST /upload/ (streamend) + GET /upload/status/{id}
│       ├── tiles.py             # GET /tiles/{job_id}/tileset.json + Tiles (gestreamt)
│       ├── assets.py            # GET /assets/, PUT .../name, DELETE {job_id}
│       ├── placement.py         # GET/PUT /assets/{job_id}/placement
│       ├── elements.py          # GET /assets/{job_id}/elements/{global_id} → Psets
│       ├── materials.py         # Texturbibliothek + Zuordnungsassistent + Re-Tiling
│       ├── geo.py               # GET /geo/elevation, PUT/GET/DELETE .../terrain-reference
│       ├── gelaende.py          # /gelaende/dgm1 — DGM1 RLP als Geländekacheln (65×65, NHN), siehe „DGM1 RLP“
│       ├── plan.py              # GET .../storeys, .../elements/{gid}/box, POST .../section
│       ├── fem.py               # POST/GET/DELETE /assets/{job}/fem — Statikrechnungen
│       ├── tragwerk.py          # POST/GET .../tragwerk — Lastabtrag über alle Geschosse
│       ├── tragwerk_eingriffe.py # .../tragwerk/eingriffe — das System ändern
│       ├── energie.py           # POST/GET/DELETE .../energie — GEG-Bilanzen, /energie/katalog
│       ├── flug.py              # GET /flug/zustaende, /flug/spur, /flug/stand — OpenSky
│       ├── einsturz.py          # /einsturz — Einsturzpakete ablegen, andocken, ausliefern
│       ├── bauplaner.py         # /bauplaner — Tragwerksaufträge aus dem Bauplaner und Ergebnisse aus twp
│       ├── baugrund.py          # /baugrund — Baugrundmodelle und Bilder, Bildlesen (Gemma 4), GGU-Import
│       ├── gaeco.py             # /gaeco — Modell als Instanzgraph nach gaeco (Kafka), Anmeldeprüfung
│       ├── splattraining.py     # /splat-training — Fotos → Splat: Aufträge, Übernahme ins Backend
│       ├── splat_export.py      # /assets/{job}/export/sog|ply — SOG- und PLY-Export
│       ├── atlas.py             # /atlas — World Labs: atlasChisel-Läufe, Mesh aus Splat (splats2Mesh)
│       └── semantic.py          # GET /semantic/search + /vector
├── tiling/
│   ├── pipeline.py              # Dispatcher: Format → Handler → MinIO
│   ├── georef.py                # ENU→ECEF, Z-up→Y-up, Zentrierung, Tile-Baum
│   ├── elevation.py             # Höhenbezug Gelände/NHN → Ellipsoid (DEM + Geoid)
│   ├── terrain.py               # Lokale Geländereferenz: Höhenraster aus einem Asset
│   ├── b3dm.py                  # B3DM-Encoder (BATCH_LENGTH, Batch Table, Alignment)
│   ├── gltf.py                  # GLB-Writer: Mesh mit _BATCHID, Splat mit SPZ
│   ├── spz.py                   # SPZ-Encoder für Gaussian Splats (Version 2)
│   ├── glb.py                   # trimesh → GLB mit garantiertem PBR-Material
│   ├── materials.py             # IfcSurfaceStyle-Name → Texturkategorie (längstes Keyword)
│   ├── stilindex.py             # Bauteil → Oberflächenstil + Stilfarbe, ohne Geometrie
│   ├── textures.py              # Registry der 73 Kategorien: Bilder, PBR-Faktoren, Quelle
│   ├── section.py               # Bauzeichnung: Schnittfiguren, Ansichtskanten, Räume aus dem IFC
│   ├── raumsemantik.py          # IfcSpace: Psets, Klassifikation, Zonen — eigener Cache, ohne Geometrie
│   ├── ergebniswolke.py         # Ergebnisfelder als PNTS-Tileset, Legende, Punktabfrage
│   ├── signaturen.json          # Schraffurkatalog (DIN 1356-1), über SIGNATUR_KATALOG ersetzbar
│   └── formats/
│       ├── ifc.py               # IFC → Octree aus B3DM-Tiles, Batch Table, Psets
│       ├── pointcloud.py        # LAS/LAZ/XYZ/PTS/PLY → PNTS (py3dtiles)
│       ├── mesh.py              # OBJ/STL/GLB/GLTF → B3DM (trimesh)
│       └── splat.py             # 3DGS-PLY → SPZ-GLB-Octree (echte Splats)
├── splatwerk/                   # Fotos/Laserscan → verorteter Gaussian Splat (siehe „Splat-Training“)
│   ├── worker.py                # Mac-Host: ZIP → COLMAP → Ausrichtung → Spirula (launchd-Agent)
│   ├── auftrag.py               # die Warteschlange als Verzeichnis (Container und Worker teilen sie)
│   ├── georef.py                # EXIF-GPS, ENU, Hochachse aus Kameras, robuste Ähnlichkeitstransformation
│   ├── colmap_modell.py         # images.txt lesen, Sim3-Datei für model_transformer schreiben
│   ├── splatpack.py             # Aufnahmepakete (Gaussian Splat King, splatpack.v2): Ort/Zeit/Sichtfeld je Bild
│   ├── iphone.py                # Schwerkraft aus dem MakerNote (Beschleunigungsmesser) → Hochachse im Bild
│   ├── scan2gs.py               # LAS/LAZ/XYZ/PLY → 3DGS-PLY (Surfels, ohne Open3D; aus Scan23dgs)
│   ├── sog.py                   # PLY → SOG über @playcanvas/splat-transform
│   ├── worldlabs.py             # World-Labs-Client für Worker und Container: Schlüssel, Assets, Operationen, EXR
│   ├── atlas_rekon.py           # Atlas-Weg: Raster, Intrinsik, RUB→COLMAP, Tiefe→Startpunkte, Teile, Textmodell
│   ├── plyhilfe.py              # PLY-Kopf lesen, Hochachsen-Kommentar berichtigen
│   ├── uebernahme.py            # trainierten/umgerechneten Splat kacheln, verorten (Container)
│   ├── splatwerk-installieren.sh # launchd-Agent einrichten/entfernen
│   └── requirements-worker.txt  # was der Worker auf dem Mac braucht
├── ileen/                       # Statik: Plattenberechnung nach EC2 (aus ~/Projekte/JaxFEM)
│   ├── rechnung.py              # der Ablauf des Notebooks als Funktion, schreibt Bilder + Bericht
│   ├── plate.py                 # Einlesen, Netz, Lasten, Kombinationen, Momente, Querkräfte
│   ├── loeser.py                # eine Zerlegung, viele Lastfälle, Auflagerkräfte, Superposition
│   ├── scheibe.py               # Wind und Schiefstellung, Aussteifung, Membrankräfte
│   ├── unterzug.py              # Balkenschnittgrößen aus dem Volumenmodell, Plattenbalken
│   ├── beton.py                 # Bemessung nach EC2: Biegung, Querkraft, Staffelung, Rissbreite
│   ├── zeichnen.py              # Ergebniskarten, Trajektorien, Stufenkarten, Ampel (matplotlib)
│   ├── kette.py                 # Lastabtrag: Geschoss für Geschoss von oben nach unten
│   ├── lastabtrag.py            # Bauteilkonten, Lastpakete je Lastfall, Erhaltungsprobe
│   ├── tragwerksmodell.py       # IFC-Geschoss → Statikmodell (Wandachse, LoadBearing)
│   ├── eingriffe.py             # Eingriffe am abgeleiteten System
│   ├── tragend.py               # Tragwerkserkennung: Material vor Property-Set
│   ├── raumlasten.py            # Nutzlast je Raum, Trennwandzuschlag
│   ├── raumdaten.py             # IfcSpace-Psets → Merkmale mit Fundstelle, DIN 277 (Raumansicht)
│   ├── raum_ifc.py              # Pset_iLEEN_Raum + Herkunft in eine IFC-Kopie, Normsätze nur füllen
│   ├── stand.py                 # Eingabe-Hash, Veraltung, inkrementelle Kette
│   ├── plan_svg.py              # Geschossplan je Submodell, deterministisch
│   ├── submodell.py             # Geschosskürzel, Submodellnamen, Feldordnung
│   ├── wand.py                  # Knicknachweis unbewehrter Wände, EC2 12.6.5.2
│   ├── stuetze.py               # Stützen: Nennkrümmung EC2 5.8.8, N-M-Interaktion
│   ├── tragwerk_ifc.py          # Pset_iLEEN_Lastabtrag in eine IFC-Kopie schreiben
│   ├── energie.py               # GEG-Monatsbilanz: Hülle → Q_p, H_T', Referenzgebäude
│   ├── einsturz.py              # Einsturzpakete: Bezug aus GlobalIds, Referenz-Schreiber des Formats
│   ├── baugrund_ground.py       # GGU-CONNECT .GROUND → Baugrundmodell (Aufschlüsse, Gliederungen, Kennwerte)
│   ├── baugrund_lesen.py        # Bild eines Aufschlusses → Schichten über Ollama/Gemma 4, Aufbereitung
│   ├── atlas.py                 # atlasChisel: Tiefe aufbereiten, Kameras prüfen, Anfragekörper
│   ├── atlas_mesh.py            # Splat → SPZ (Y oben) → splats2Mesh → GLB zurück, Platzierung wie der Splat
│   ├── gaeco_export.py          # IFC → gaeco-Instanzgraph: Knoten, Kanten, GraphDataModel, Kafka
│   ├── shims/gmsh.py            # Ersatzmodul, wo es kein gmsh-Wheel gibt (Linux-arm64)
│   └── beispiel_*_fem.json      # drei Modelle zum Prüfen ohne IFC-Upload (eins mit Unterzug)
├── tests/
│   ├── test_storey.py           # Geschosszuordnung (Contained vs. Decomposes)
│   ├── test_kette.py            # Lastabtrag ohne IFC und ohne JAX, mit Attrappen
│   ├── test_eingriffe.py        # Wandachse, Eingriffe, Fortpflanzung bis zur Gründung
│   ├── test_tragend.py          # Materialklassen, Quellenreihenfolge, tragende Schicht
│   ├── test_oeffnungen.py       # Treppenauge und Schächte als Löcher im Netz
│   ├── test_raumlasten.py       # Nutzung je Raum, Flächenbilanz, Trennwandzuschlag
│   ├── test_raumdaten.py        # Raum-Psets dreier Erzeuger → Merkmale, Einheiten, DIN 277
│   ├── test_raum_ifc.py         # Raumdaten ins IFC und zurück: Herkunft, Normsätze, IFC4/IFC2X3
│   ├── test_stand.py            # Eingabe-Hash, Veraltung nach unten, Gesamtzustand
│   ├── test_plan_svg.py         # Determinismus und Vollständigkeit des Geschossplans
│   ├── test_splat_georef.py     # Verortung einer Foto-Rekonstruktion (Hochachse, GPS, Ausreißer)
│   ├── test_splatwerk.py        # Scan → Splat, Warteschlange, Hochachsen-Kommentar, SOG, ZIP
│   └── test_submodell.py        # Geschosskürzel, Feldordnung, Stabilität der Namen
├── notebooks/
│   └── iLEEN_Plattenstatik.ipynb  # dieselbe Rechnung als Werkstatt, Abschnitt für Abschnitt
├── semantic/
│   ├── extractor.py             # IFC-Psets / Kreuzberg → Embeddings → LanceDB
│   └── properties.py            # properties.sqlite: Bauteileigenschaften je Job
├── storage/
│   └── minio_client.py          # MinIO Singleton + upload_directory()
├── scripts/
│   ├── fetch_textures.py        # einmaliger CC0-Texturdownload (Poly Haven / ambientCG)
│   ├── einsturz_hochladen.py    # Einsturzpaket ablegen und an das IFC andocken
│   ├── gaeco_guideline_index.py # Klassen + Property-Klarnamen aus gaecos ifc4_3.guideline
│   └── citygml2tiles.py         # CityGML LoD2 (ADV/AAA) → 3D Tiles, außerhalb der Pipeline
├── docker/
│   └── Dockerfile.api           # Python 3.12-slim
├── data/                        # Lokale Dev-Daten (gitignored)
│   ├── uploads/
│   ├── tiles/
│   └── lancedb/
├── docker-compose.yml           # MinIO + minio-setup + API
├── requirements.txt
└── .env.example                 # MinIO-Zugang, TILES_PUBLIC_URL, TILESET_ORIGIN_*
```

## Schnellstart (lokal / Server)

```bash
# 1. Env konfigurieren
cp .env.example .env
# .env anpassen: MINIO_ROOT_PASSWORD, TILES_PUBLIC_URL

# 2. Stack starten
docker compose up -d

# 3. Status prüfen
curl http://localhost:8100/health
# Asset-Manager:  http://localhost:8100/ui   ← Upload + Verortung im Browser
# MinIO Console:  http://localhost:9001
# API Docs:       http://localhost:8100/docs

# 4. Test-Upload — liefert eine job_id zurück
curl -F "file=@meinmodell.ifc" http://localhost:8100/upload/

# 5. Fortschritt verfolgen (queued → tiling → indexing → done/failed)
curl http://localhost:8100/upload/status/<job_id>

# 6. Assets abrufen
curl http://localhost:8100/assets/
```

## CesiumJS Integration

Im Frontend (`frontend/core.js`, `loadBackendAsset`) statt Cesium ion:

```javascript
const tileset = await Cesium.Cesium3DTileset.fromUrl(
  "http://localhost:8100/tiles/<job_id>/tileset.json"
);
viewer.scene.primitives.add(tileset);
```

## Unterstützte Formate

| Format | Endung | Handler | Output |
|--------|--------|---------|--------|
| IFC | .ifc | IfcOpenShell → Octree | B3DM-Hierarchie mit Batch Table |
| LAS/LAZ | .las .laz | py3dtiles (laspy) | PNTS-Hierarchie |
| XYZ/PTS | .xyz .pts | py3dtiles | PNTS-Hierarchie |
| PLY Punktwolke | .ply | py3dtiles (plyfile) | PNTS-Hierarchie |
| PLY 3DGS-Splat | .ply | SPZ-Encoder → Octree | GLB-Hierarchie (Gaussian Splats) |
| LAS/LAZ/XYZ/PTS/PLY als Splat | `?als=splat` | `splatwerk/scan2gs` → SPZ-Encoder | wie PLY 3DGS-Splat; Quelle im Bucket wird die erzeugte Splat-PLY |
| Fotos, Videos, ZIP | `POST /splat-training` | Worker auf dem Mac: COLMAP + Spirula Studio | wie PLY 3DGS-Splat, verortet über das GPS der Bilder |
| OBJ/STL | .obj .stl | trimesh | B3DM |
| GLTF/GLB | .gltf .glb | trimesh | B3DM |

**E57 wird nicht unterstützt.** pye57 bietet keine Linux-arm64-Wheels; eine
Unterstützung im Container hieße, libE57Format aus dem sdist zu bauen. E57-Scans
vorher nach LAS/LAZ oder PLY konvertieren (CloudCompare, oder `Scan23dgs`, das
E57 über pye57 bereits liest).

## CityGML LoD2 — der eine Weg an der Pipeline vorbei

`scripts/citygml2tiles.py` rechnet eine amtliche LoD2-Abgabe (ADV/AAA-CityGML,
Länder-Kacheldownload) in 3D Tiles um:

```bash
python3 scripts/citygml2tiles.py \
    "…/LoD2_32_444_5536_2_RP.gml" ../frontend/data/rlp-lod2 --split 4
```

**Warum kein Handler in `tiling/pipeline.py`.** Die Pipeline nimmt eine
hochgeladene Datei, legt einen Job an, tilt und schiebt das Ergebnis nach
MinIO — sie ist auf *Projektmodelle* zugeschnitten, auf Dinge, die verortet,
umbenannt, mit Materialien versehen und wieder gelöscht werden. Eine
Landeskachel ist nichts davon: sie ist Kulisse, sie ändert sich einmal im Jahr,
und sie gehört in keinem Sinne zu einem Job. Sie wird deshalb einmal von Hand
umgerechnet und liegt danach als statische Datei im Frontend.

Wiederverwendet wird trotzdem alles, was die Pipeline schon hat: `mesh_glb()`
aus `tiling/gltf.py` (inklusive `_BATCHID`), `glb_to_b3dm()` aus
`tiling/b3dm.py` und `enu_transform()` / `make_tile()` aus `tiling/georef.py`.
Das Skript hängt sein Elternverzeichnis in `sys.path` und läuft damit ohne
Container, aber mit denselben Encodern — ein zweiter B3DM-Writer wäre genau die
Art Zwilling, die irgendwann auseinanderläuft.

Fachliche Festlegungen (Höhenbezug, Batch je Gebäude, `iter` statt `findall`
wegen `BuildingPart`, Ear-Clipping, UTM32 ohne pyproj) stehen im Kopf des
Skripts und ausführlicher in `frontend/CLAUDE.md`, Abschnitt „Amtliche
Gebäudekulisse“ — dort werden sie gebraucht, wenn jemand die Ebene im Viewer
anfasst.

## Flugverkehr — Proxy auf OpenSky (`api/routes/flug.py`)

Der einzige Endpunkt im Backend, der nach draußen telefoniert und dabei ein
Geheimnis hütet. Er versorgt `frontend/flight-tracker.js` mit den
Zustandsvektoren des OpenSky Network.

```
GET /flug/zustaende?lamin&lomin&lamax&lomax   Flugzeuge in einer Box
GET /flug/spur?icao24=3c4b2f                  geflogener Weg eines Flugzeugs
GET /flug/stand                               Modus, Takt, Restguthaben
```

**Warum überhaupt serverseitig?** OpenSky hat Basic Auth abgeschafft; Zugang
läuft über OAuth2 Client Credentials. Ein `client_secret` im Browser-Bundle
wäre in den Devtools lesbar. Dazu rechnet OpenSky in Credits — 4 000 am Tag mit
Zugangsdaten, 400 ohne, je Boxabfrage bis 25 Quadratgrad einer. Der Cache hier
macht aus zehn offenen Tabs eine Abfrage.

Drei Dinge, die den Endpunkt tragen:

* **Der Token wird geteilt, nicht je Anfrage geholt.** Gültig 30 Minuten,
  erneuert 60 s vor Ablauf, hinter einem `asyncio.Lock` mit zweiter Prüfung —
  sonst holen zehn gleichzeitige Anfragen zehn Token.
* **Die Box wird auf 0,25° gerastert, bevor sie Cacheschlüssel wird.** Ohne das
  ist jede Kamerabewegung eine neue Abfrage; mit ihm bleibt ein langsam
  schwenkender Viewer im selben Eimer.
* **Der Takt kommt aus der Antwort, nicht aus dem Viewer.** `intervall_s` ist
  20 s mit Zugangsdaten, 60 s anonym. Wer das ändern will, setzt
  `OPENSKY_POLL_S` — an einer Stelle, nicht in jedem Client.

Ohne `OPENSKY_CLIENT_ID`/`OPENSKY_CLIENT_SECRET` läuft der Dienst anonym
weiter: dieselben Daten, gröberer Takt, kleineres Kontingent. Das ist kein
Fehlerfall, sondern der Auslieferungszustand — deshalb steht `modus` in jeder
Antwort.

**`/flug/spur` ist wackelig.** OpenSky führt `/tracks/all` als experimentell und
antwortet für fremde Flugzeuge oft mit 404 (im anonymen Betrieb geprüft: 404).
Der Viewer verlässt sich deshalb nicht darauf, sondern baut die Spur aus den
eigenen Abfragen auf — das kostet keine Credits und funktioniert immer.

---

## Validierung

Alle Pfade sind gegen den offiziellen Cesium-Validator geprüft — auch das
161-Tile-Campusmodell (0 Fehler, 0 Warnungen):

```bash
npm install 3d-tiles-validator
npx 3d-tiles-validator --tilesetFile <pfad>/tileset.json
```

Bei Änderungen am B3DM-/PNTS-Encoder **und am glTF-Inhalt** immer erneut
validieren — das eingebettete Material zählt mit. Die Fallstricke, die dabei
aufgefallen sind: fehlendes `BATCH_LENGTH`, unaligned Feature-Table (der
28-Byte-Header zählt beim 8-Byte-Alignment mit), eine Tile-Gesamtlänge, die
kein Vielfaches von 8 ist (gelöst über Leerzeichen-Padding im glTF-JSON-Chunk),
und Vertexattribute, deren Element nicht auf 4 Byte ausgerichtet ist — deshalb
ist `_BATCHID` ein FLOAT und kein UNSIGNED_SHORT.

Der Validator kennt die Splat-Extensions nicht und meldet sie als INFO. Dass
CesiumJS die Tiles tatsächlich als Splats lädt und rendert, ist damit **nicht**
geprüft. Dafür gibt es zwei Wege, die sich bewährt haben:

* **Zahlen gegen den echten Decoder.** `@spz-loader/core` in der Version, die
  CesiumJS bündelt (0.3.1), dekodiert eine erzeugte Datei; die Werte werden
  gegen die Quelldaten gerechnet. Das findet Konventionsfehler
  (Quaternionreihenfolge, log/linear, Farbskalierung), die ein Bild nur ahnen
  lässt.
* **Bild aus echtem Chrome.** `puppeteer-core` gegen das installierte Chrome,
  eine Seite mit CesiumJS, Tileset laden, `scene.pick()` in die Bildmitte,
  Screenshot. `tileset.statistics` zeigt dabei, welchen Weg der Inhalt genommen
  hat: `Punkte > 0, Dreiecke = 0` heißt Splat-Content, umgekehrt Mesh.

## Große IFC-Modelle: Octree statt einem Riesen-Tile

Bis Version 0.1 verschmolz der IFC-Handler alle Bauteile zu einem Mesh und
schrieb daraus **ein** B3DM. Ein 207-MB-IFC ergab 358 MB in einem Tile; beim
529-MB-Campusmodell BA1-2 lief schon das Zusammenführen aus dem Ruder, weil
sämtliche Bauteile gleichzeitig als Trimesh-Objekte im RAM lagen.

Der Handler arbeitet jetzt zweistufig:

1. **Auslagern.** Der Geometrie-Iterator schreibt jedes Bauteil sofort als rohe
   float32/uint8-Blöcke in eine temporäre Datei. Im Speicher bleibt nur ein
   Verzeichnis mit Bounding Box und Byte-Offsets, rund hundert Byte je Bauteil.
   trimesh kommt im IFC-Pfad überhaupt nicht mehr vor.

2. **Octree mit ADD-Verfeinerung.** Jedes Bauteil landet auf der Ebene, die zu
   seiner Größe passt (`level = log2(Modellgröße / Bauteilgröße)`): Wände,
   Decken und Dach im Wurzeltile, Beschläge und Möblierung weiter unten.
   Übervolle Knoten schieben ihre kleinsten Bauteile eine Ebene tiefer, bis
   keins mehr über `IFC_TILE_TRIANGLES` liegt; Teilbäume, die zusammen in ein
   Tile passen, werden wieder eingesammelt (ohne diesen Schritt zerfällt ein
   kleines Modell in dutzende Tiles mit je ein paar hundert Dreiecken).

Weil jedes Bauteil genau **einmal** vorkommt, bleibt die Geometrie vollständig.
Das ist der Grund für ADD statt REPLACE: bei REPLACE müsste jede Ebene den
gesamten Inhalt ihrer Kinder noch einmal enthalten.

**Ausgeschlossene Typen.** `IfcOpeningElement` sind Aussparungs*volumen*: die
Wand hat ihr Loch bereits, der Negativkörper steckt zusätzlich als massiver
Quader darin und ragt als Platte durch die Fassade. Im Campus-Modell waren das
2583 Stück. Zusammen mit `IfcSpace`, `IfcVirtualElement`, `IfcAnnotation` und
`IfcGrid` gehen sie über `IFC_EXCLUDE_TYPES` gar nicht erst in den Iterator.

Messwerte für `OPL_BIMLabor_HSM-Campus_BA1-2.ifc` (554 MB, 34 376 Bauteile
nach Ausschluss der Aussparungen, 7,13 Mio. Dreiecke) auf einem
Apple-Silicon-Laptop:

| | vorher | nachher |
|---|---|---|
| Tiles | 1 | 141, Baumtiefe 5 |
| größtes Tile | ~900 MB (hochgerechnet) | 4,4 MB |
| Tiles gesamt | ~900 MB | 171 MB |
| Laufzeit | — (RAM erschöpft) | 219 s |
| Spitzenspeicher | — | 5,6 GB |

Der Speicherbedarf steckt fast vollständig in `ifcopenshell.open()` und den
Threads des Geometrie-Iterators, nicht in unserem Code. Auf kleinen Servern
hilft `IFC_JOBS=1..2`.

**Normalen sind kein Beiwerk.** Ohne `NORMAL`-Attribut schaltet CesiumJS auf
`LightingModel.UNLIT` und stellt das Modell als flache Farbfläche ohne jede
Plastizität dar. Bei eingeschaltetem Welding liefert IfcOpenShell keine
Normalen mit, also mittelt `_normals()` sie flächengewichtet selbst — dieselbe
weiche Schattierung, die trimesh früher erzeugt hat. Wer scharfe Kanten
braucht, setzt `IFC_WELD_VERTICES=false`: dann kommen echte Flächennormalen aus
IfcOpenShell, bei etwa dreifacher Vertexanzahl.

Was bewusst offen bleibt: die Tiles sind unkomprimiert. Draco oder meshopt
würden nochmals rund eine Größenordnung bringen, brauchen aber einen Encoder,
den es für Python nicht ohne Weiteres mit Unterstützung generischer Attribute
(`_BATCHID`!) gibt.

## Kacheln ausliefern: Zwischenspeicher, ETag, Kompression *(2026-10-24)*

`api/routes/tiles.py` schickte Kacheln und `tileset.json` ohne `Cache-Control`, `ETag` und `Last-Modified`
hinaus — der Kommentar nannte die Kacheln „unveränderlich", geschickt wurde davon nichts. Der Browser (und
der Quest-Browser) konnte nichts aus seinem HTTP-Cache holen: jede Kachel, die der Kachelspeicher der
VR-Seite verwarf, und jede zweite Sitzung holte alles neu übers WLAN (Campus-IFC: 410 MB, 292 Kacheln).

`tiling/http_kopf.py` (ohne FastAPI und MinIO, Prüfstein `python3 tests/test_tiles_kopf.py`, 66 Prüfungen,
darunter die echte Route mit einer MinIO-Attrappe):

| Objekt | `Cache-Control` | Warum |
|---|---|---|
| Kacheln (`.b3dm .glb .pnts .cmpt .i3dm .bin`, Bilder) | `public, max-age=86400` + ETag | gehören zu einem Tiling-Lauf, ein neuer Lauf ist ein neuer Job |
| Unter-Tilesets (`tileset.12.json`, py3dtiles) | wie Kacheln | Teil desselben Laufs |
| Wurzel `tileset.json`, `placement.json`, `meta.json`, `materials.json` | `no-cache` + ETag | ändern sich beim Verorten, Umbenennen, Zuordnen |

* **304:** passt `If-None-Match` (auch `*`, Listen, `W/"…"`) auf den ETag aus MinIO, geht die Antwort ohne Körper
  hinaus und **gibt die MinIO-Verbindung frei** (sonst läuft der Pool voll). Sie trägt `Cache-Control` und
  `ETag`, sonst verlängert sie nichts.
* **JSON wird gezippt** (`Accept-Encoding: gzip`, 1 kB bis 16 MB; `tileset.json` 10:1), Kacheln nie — GLB und B3DM
  sind kaum komprimierbar. `Vary: Accept-Encoding` an jeder JSON-Antwort, `mtime=0` für gleiche Körper.
* **Die Route liefert alles unter dem Job-Präfix aus**, nicht nur Kacheln. Deshalb ist die Regel eine Liste
  der Unveränderlichen und nicht „alles außer tileset.json" — `placement.json` für einen Tag zu cachen hieße,
  eine Verortung scheinbar nicht zu speichern.
* **HTTP/2 gab es schon:** der Quest-Vite (`tools/quest-wlan.sh`, Port 5443) antwortet mit `HTTP/2`. Ein
  Caddy ist dafür nicht nötig; Range-Requests brauchen die Kacheln nicht (ganze Objekte).

**Nicht eingespielt.** Der Code liegt im Image; der laufende Container `cesium-api` hat den alten Stand. Einspielen
(kurzer Neustart der API):

```bash
docker cp backend/tiling/http_kopf.py cesium-api:/app/tiling/http_kopf.py
docker cp backend/api/routes/tiles.py cesium-api:/app/api/routes/tiles.py
docker restart cesium-api
```

Danach prüfen: `curl -sI localhost:8100/tiles/<job>/tile_1.b3dm` (ETag, `Cache-Control: public, max-age=86400`),
`curl -s -o /dev/null -w '%{http_code}' -H 'If-None-Match: "<etag>"' …` → 304.

### Befunde zum Tiler (nicht geändert, nur gemessen)

Am Campus-IFC (`bf9da2a7`, 292 Kacheln, ADD, Tiefe 6, keine 404, `geometricError` monoton):

* **Texturen je Kachel statt geteilt:** 3 × 512² JPEG je Material (Farbe, Normale, Rauheit/AO), 16–30 Bilder je
  Kachel, dekodiert ≈ 21 MB; **71 % der Bilder sind Duplikate über Kacheln hinweg** (57 verschiedene bei 195).
  Der Viewer teilt sie jetzt (`frontend/vr-texturen.js`), der Tiler könnte sie einmal ablegen oder als KTX2.
* **Zu große Kacheln:** bis 880 000 Vertices (30–35 MB Geometrie, 40 Byte je Vertex: Position, Normale, UV,
  Farbe, `_batchid`). Für die Quest wären ≤ 100 000 Vertices je Kachel und Normalen/UV in 8/16 Bit sinnvoll.
* **`geometricError` 164 → 82 → 41 … 0** (halbiert je Ebene, Blätter 0): die Verfeinerung stoppt erst, wenn der
  Abstand die Zellgröße übersteigt — am Campus nie. Deshalb prunt ein höherer Fehlerwert die Blätter nur aus der
  Ferne. Ein objektbezogener Fehlerwert (Größe des größten Objekts der Zelle) würde das ändern.
* LoD2 der BKG (`lod2_4326_dgm5.json`): Wurzel mit 1347 überlappenden Zellen (bis 8° × 7°), 13 enthalten den
  Campus — der Viewer schneidet auf 15 km Umkreis (`frontend/vr-rechnen.js → zellenImUmkreis`).

## Anklickbare Bauteile

Jedes IFC-Tile trägt ein `_BATCHID` je Vertex und eine Batch Table mit
GlobalId, IfcType, Name und Geschoss. Daraus baut CesiumJS
`Cesium3DTileFeature`-Objekte — `viewer.scene.pick()` liefert sie direkt,
`feature.color = …` hebt sie hervor.

Die vollständigen Property-Sets stehen **nicht** im Tile. Sie lägen dort
vervielfacht in jedem Tile und müssten bei jedem Nachladen mitübertragen
werden; stattdessen schreibt das Tiling sie in eine `properties.sqlite` neben
die `tileset.json`:

```
GET /assets/{job_id}/elements              # Anzahl erfasster Bauteile
GET /assets/{job_id}/elements/{global_id}  # Typ, Name, Geschoss, alle Psets
```

`api/routes/elements.py` holt die Datei beim ersten Zugriff einmal aus MinIO
nach `/tmp/properties` und fragt danach lokal ab. Ein Streaming-Zugriff wäre
hier wertlos: SQLite springt im File umher, das ginge über S3 nur mit
Range-Requests je Seite — und die Datei gehört zu einem unveränderlichen
Tiling, ist also dauerhaft gültig. Der Browser bekommt davon nichts ab, er
erhält nur die JSON-Antwort zum angeklickten Bauteil.

Die Property-Sets liegen je Zeile **zlib-komprimiert**. ArchiCAD-Exporte
bringen rund 4 kB Text je Bauteil mit, überwiegend immer dieselben deutschen
Schlüsselnamen; beim Campus-Modell schrumpft die Datei dadurch von 150 MB auf
49 MB. Der `id`-Schlüssel, den IfcOpenShell je Pset einfügt, wird verworfen —
das ist nur die Entity-Nummer des Property-Sets.

Im Asset-Manager erscheint beim Klick auf ein Bauteil rechts eine Karte mit
Batch-Table-Werten und nachgeladenen Property-Sets. Ein Klick ins Leere hebt
die Auswahl auf. Im Modus „Auf Karte setzen" hat der Klick weiterhin die
Bedeutung, die Position zu setzen.

Die Semantikindexierung nutzt dieselbe Datei: `extract_and_index()` liest die
Bauteiltexte aus `properties.sqlite` statt die IFC-Datei ein zweites Mal zu
parsen — bei 500 MB spart das Minuten und mehrere Gigabyte.

### Behobener Bug: IFC-Modelle erschienen komplett weiß

Zwei unabhängige Ursachen, die dasselbe Symptom erzeugt haben. Die zweite blieb
übrig, nachdem die erste behoben war — daran lohnt sich zu erinnern: dass die
Farbe *extrahiert* wird, heißt nicht, dass sie *gerendert* wird.

**1. Farbe wurde gar nicht gelesen.** `ifcopenshell.geom` liefert
`material.diffuse` als `colour`-Objekt mit `r()`/`g()`/`b()` als **Methoden**,
nicht als iterierbares Tupel — `list(diffuse)` wirft `TypeError`. Ebenso ist
`has_transparency` eine Methode, kein Attribut: `getattr(mat,
"has_transparency", False)` lieferte das Methodenobjekt selbst zurück, das als
bool immer truthy ist. Beide Fehler landeten im breiten
`except Exception: return None` und ließen jedes Element ohne Farbe. Fix:
`diffuse.r()/.g()/.b()` und `mat.has_transparency()` aufrufen, `transparency`
zusätzlich auf `NaN` prüfen. Das `except` loggt jetzt, statt zu schlucken.

**2. Farbe war da, aber ohne Material.** trimesh schreibt Vertexfarben aus
`ColorVisuals` zwar als `COLOR_0` ins glTF, legt dafür aber **kein Material**
an — das Primitive bleibt ohne `material`-Index. glTF schreibt für diesen Fall
das Default-Material vor, und das hat `metallicFactor: 1.0`. In CesiumJS ist
der diffuse Anteil `baseColor * (1 - metallic)`, bei vollmetallisch also null;
sichtbar bleibt nur die Spiegelung des Image-Based-Lightings, das bei Cesium
aus dem hellen Himmel kommt. Ergebnis: ein einheitlich weißes Modell, obwohl
`COLOR_0` korrekt im Tile steht.

Für trimesh-Quellen (OBJ/STL/GLB) löst `tiling/glb.py` das über
`TextureVisuals` — den einzigen trimesh-Pfad, der Material *und* Vertexfarben
exportiert. Der IFC-Pfad geht seit dem Octree-Umbau gar nicht mehr über
trimesh: `tiling/gltf.py` schreibt das Material direkt. Gesetzt wird in beiden
Fällen `metallicFactor 0.0`, `roughnessFactor 1.0`, `doubleSided true` und
`BLEND` nur, wenn wirklich Alpha < 255 vorkommt. Bringt eine Quelldatei ein
eigenes Material mit (GLB/GLTF, OBJ mit MTL), bleibt es unangetastet.

Zusätzlich färbt `ifc.py` je `geo.material_ids` statt je Element: Fenster aus
Rahmen und Glas oder mehrschichtige Wände bekamen sonst eine Einheitsfarbe.
Getrennt wird über eigene Vertex-Arrays je Material — durch `weld-vertices`
teilen sich Nachbardreiecke ihre Vertices, Face-Farben würden beim Umrechnen
auf Vertexfarben an der Materialgrenze ineinanderlaufen.

**Bestehende Tilesets werden davon nicht rückwirkend repariert** — das B3DM
liegt fertig in MinIO. Betroffene Modelle müssen einmal neu hochgeladen werden.
Das gilt genauso für alles, was seither dazugekommen ist: LOD-Hierarchie,
Batch Table, Normalen, Splat-Rendering.

### Derselbe Fehlertyp, zweite Runde: Bauteile ohne Eigenschaften

Beim Einbau der anklickbaren Semantik trat er noch einmal auf. Der
Geometrie-Iterator gibt über `shape.product` eine `entity_instance` des
C++-Wrappers zurück, die **ihre Datei nicht kennt**;
`ifcopenshell.util.element.get_psets()` scheitert daran mit
`'NoneType' object has no attribute 'schema'`. In einem `except Exception`
bleibt davon nichts übrig — die `properties.sqlite` war vollständig gefüllt,
nur eben mit leeren Property-Sets, und das fällt erst beim Klicken im Viewer
auf. Richtig ist `ifc_file.by_id(shape.id)`. Fehlschläge werden jetzt gezählt
und am Ende als Warnung ausgegeben.

## Material-Texturen (IFC)

IFC-Dateien enthalten praktisch nie eingebettete Bildtexturen — nur benannte
`IfcSurfaceStyle`-Diffusfarben (z.B. "Beton - Estrich", "Metall Aluminium,
matt"). `tiling/materials.py::classify_material()` ordnet solche Namen per
Keyword-Matching einer von **73 Kategorien** zu; die zugehörigen CC0-PBR-Sets
liegen unter `tiling/textures/library/<category>/` (BaseColor + Normal + ORM,
512px JPEG, per `scripts/fetch_textures.py` einmalig offline geladen — läuft
nicht im Container, die Bilder werden committet). Stile ohne sicheren Treffer —
Farbanstriche, Glas, generische/Default-Stile — bleiben bewusst unverändert
einfarbig; sie zu texturieren wäre falsch oder beliebig.

### Die Registry ist die einzige Wahrheit

`tiling/textures.py::CATEGORIES` deklariert je Kategorie Anzeigename, Gruppe,
Quelle (Poly Haven / ambientCG), Asset-Slug, UV-Kachelgröße und PBR-Faktoren.
Alles andere leitet sich daraus ab: `materials.py` prüft beim Import, dass es
für jedes Keyword-Set eine Kategorie gibt; `scripts/fetch_textures.py` lädt
anhand von `source`/`slug`; `api/routes/materials.py` liefert `label`/`group`
an den Assistenten. Eine neue Kategorie braucht deshalb genau drei Schritte:
Eintrag in der Registry, Keywords in `materials.py`, ein Lauf des Skripts.

### Längstes Keyword gewinnt

Materialnamen sind zusammengesetzt ("Stahlbeton - Ortbeton C30/37"), und das
spezifischere Wort ist fast immer das längere. Die frühere Fassung verließ
sich auf die Reihenfolge der Kategorien — mit fünf Kategorien noch überschaubar,
mit 73 nicht mehr zu überblicken. Jetzt entscheidet die Länge des Treffers:
"stahlbeton" (10) schlägt "stahl" (5), "dachziegel" (10) schlägt "ziegel" (6),
"betonwerkstein" (14) schlägt "beton" (5). Die Deny-Liste wird nach derselben
Regel abgewogen, damit "Betonfarbe" ein Anstrich bleibt und "Farbbeton" ein
Beton wird.

Umlaute werden auf beiden Seiten transliteriert (`ä`→`a`), weil Exporte
uneinheitlich sind — "Aussenputz" und "Außenputz" treffen dieselbe Kategorie.
Dasselbe gilt für die polnischen Diakritika (`ł`→`l`, `ż`→`z`, …): das
GESTAMP-Testmodell ist durchgängig polnisch benannt ("Wełna mineralna",
"Żelbet monolityczny"), und ohne Transliteration fiel davon kein einziges
Material in eine Kategorie.

**Sammelbegriffe greifen zuletzt.** "Metall", "Metal", "Kunststoff" und
"Izolacja" nennen nur die Warengruppe und stehen in zusammengesetzten Namen
regelmäßig *neben* dem eigentlichen Material — "Metall Chrom", "Kunststoff
Linoleum", "Izolacja - Celuloza". Nach der reinen Längenregel gewönnen sie
dort, weil "metall" (6) länger ist als "chrom" (5), und das Ergebnis wäre
durchweg die gröbere Kategorie. `_GENERIC_KEYWORDS` prüft sie deshalb erst,
wenn kein anderes Keyword gegriffen hat: "Kunststoff PE weiss" landet
weiterhin bei `plastic`, "Kunststoff Linoleum" aber bei `linoleum`.

### ORM-Maps: Rauheit ist ortsabhängig

Neben BaseColor und Normal liegt je Kategorie eine `orm.jpg`: **R = Ambient
Occlusion, G = Roughness, B = Metallic**. glTF liest Roughness aus dem Grün-
und Metallic aus dem Blaukanal der `metallicRoughnessTexture`; der Rotkanal ist
dort frei, weshalb dieselbe Textur zusätzlich als `occlusionTexture` dient —
ein Bild, drei Wirkungen, kein zusätzlicher Speicher.

Vorher galt je Kategorie ein konstanter Rauheitswert für die ganze Fläche;
jedes Material glänzte dadurch gleichmäßig wie Plastik. Die Faktoren in der
Registry bleiben gültig, wirken laut Spezifikation aber multiplikativ auf die
Texturwerte und stehen deshalb bei Kategorien mit ORM-Map auf 1.0.

**`subsampling=0` beim Speichern ist Pflicht, nicht Feinschliff.** JPEG tastet
die Farbkanäle standardmäßig 4:2:0 ab und mittelt sie über 2×2-Blöcke. Bei
einem Farbbild ist das unsichtbar, in einer ORM-Map laufen dadurch Roughness
und Metallic ineinander — eine raue Kante glänzt dann teilmetallisch.

Fehlt die Datei (die Quelle liefert keine Roughness-Map), fällt das Tiling auf
die konstanten Faktoren zurück; `textures.has_orm()` entscheidet das je
Kategorie, ohne Sonderfall im Aufrufer.

### Zuordnungsassistent

Keyword-Erkennung trifft Firmenstandards, Fantasienamen und Fremdsprachen
naturgemäß nicht zuverlässig. Der Assistent im Asset-Manager macht sie
korrigierbar:

```
GET  /materials/library                     Kategorien nach Gruppen
GET  /materials/library/{category}/preview  Vorschaukachel (JPEG)
GET  /assets/{job_id}/materials             Stile + Vorschlag + Konfidenz
PUT  /assets/{job_id}/materials             Zuordnung speichern
POST /assets/{job_id}/materials/retile      mit dieser Zuordnung neu tilen
GET  /assets/{job_id}/materials/retile      Fortschritt
```

**Bewusst zweistufig.** Der Upload tilt sofort mit der automatischen Erkennung
durch, das Modell ist direkt sichtbar, und wer die Zuordnung gut findet, öffnet
den Dialog nie — nach dem Upload erscheint nur ein Hinweis mit der Trefferquote
("34 von 41 Stilen automatisch texturiert") und den Schaltflächen „Texturen
prüfen" / „Passt so". Jeden Upload hinter einem Pflichtdialog zu blockieren
wäre der falsche Tausch.

Beim Tiling schreibt `ifc.py::_write_material_report()` eine `materials.json`
neben die tileset.json: alle Stilnamen mit Vorschlag, Konfidenz und Häufigkeit,
absteigend nach Vorkommen sortiert — im Dialog stehen damit die Stile oben, die
das Erscheinungsbild tatsächlich bestimmen. Die manuelle Zuordnung liegt
getrennt in `material_overrides.json`, weil sie ein Re-Tiling überleben muss;
`GET /assets/{id}/materials` führt beides zusammen, sodass eine geänderte
Zuordnung sofort sichtbar ist, auch ohne neu zu tilen.

Ein leerer Wert in den Overrides heißt ausdrücklich „keine Textur" und ist
damit von „nicht zugeordnet" unterscheidbar — sonst ließe sich eine falsche
automatische Erkennung nicht abschalten.

#### Die Bedienung: Texturwand links, Materialien rechts

Bis September 2026 war der Dialog eine Liste mit einem Auswahlfeld je Zeile.
Das ist der kürzeste Weg zu einer korrigierbaren Zuordnung und der längste zu
einer guten: 73 Kategorien in einem Klappmenü zeigen jeweils eine, ihre Namen
stehen für Bilder, die man sich nicht merken kann, und die Zuordnung ist genau
dann leicht, wenn man die Textur **sieht**.

Der Dialog hat deshalb zwei Spalten — links die Materialien des Modells, rechts
die Bibliothek als Kachelwand mit Suchfeld — und zwei Wege, die dasselbe tun:

| Weg | Wirkt auf |
|---|---|
| Kachel auf eine Materialzeile **ziehen** | diese Zeile; liegt sie in der Auswahl, die ganze Auswahl |
| Kachel auf die **Kopfzeile** der Materialliste ziehen | alle Materialien des Modells |
| Materialien **auswählen**, dann Kachel **anklicken** | die Auswahl (Strg/Cmd einzeln, Umschalt als Bereich, „Alle auswählen") |

Der Ziehweg ist der schnellere für den Einzelfall, der Auswahlweg der einzige,
mit dem sich mehrere Materialien in einem Zug texturieren lassen. Beide laufen
über dieselbe Funktion (`zuweisen()`), damit sie nicht auseinanderlaufen können.

**„Automatisch" und „Keine Textur" sind selbst Kacheln.** Sie stehen als erste
Gruppe in der Bibliothek und lassen sich ziehen wie jede Textur — sonst wäre
das Zurücknehmen einer Zuordnung der einzige Vorgang, der einen anderen Weg
nimmt als das Setzen.

**Über der Kachelwand steht, worauf ein Klick wirkt.** Ohne diese Zeile ist die
Wand eine Schaltfläche ohne erkennbares Ziel: bei leerer Auswahl passiert beim
Klicken nichts, und der Grund dafür muss sichtbar sein, bevor man klickt — nicht
erst danach.

**Die Zuordnung bleibt auf Ebene der Oberflächenstile**, also je Material, nicht
je Bauteil. Ein einzelnes Bauteil abweichend zu texturieren hieße, den Override
an die GlobalId zu hängen und ihn in `_store_element()` gegen die Stilzuordnung
zu stellen — machbar (die GUID liegt dort als `shape.guid` vor), aber eine
Änderung am Tiling und am Speicherformat, nicht an der Oberfläche.

### Materialmodus — Texturen auf das Bauwerk ziehen

Eine Liste von Stilnamen genügt, um eine Zuordnung zu **korrigieren**, und
genügt nicht, um sie zu **finden**: „#Metall Fassade MUSTER_1" sagt niemandem,
welche Fläche im Bau das ist. Der Materialmodus (`api/static/material-modus.js`,
🎨 an der Assetzeile) dreht die Richtung um — man sieht das Bauteil und zieht
die Textur darauf.

    Palette am linken Viewerrand          Modell in der Szene
    ├ Materialien des Modells             Zeigen  → „Unter dem Zeiger: Beton…"
    │   Farbe · Name · Anzahl · Kachel    Klicken → alles andere tritt zurück
    └ Texturen + Vollton + Suche          Ziehen  → Zuordnung für dieses Material

**Die fehlende Brücke ist Bauteil → Stil.** Die Batch Table der Tiles führt
GlobalId, Typ, Name und Geschoss, aber keinen Stil: texturiert wird eine Ebene
tiefer, je Material-Chunk innerhalb eines Bauteils. `tiling/stilindex.py` baut
die Zuordnung deshalb aus dem Entitätsgraphen der IFC-Datei — **ohne Geometrie**,
am 554-MB-Campusmodell 1,7 s gegenüber 15 s für das Öffnen der Datei allein.
Eine Geometrie-Iteration wären Minuten.

```
GET /assets/{job}/materials/index
    → { styles: [{name, farbe, transparenz, zuweisungen, bauteile}],
        elemente: { GlobalId: [Stilnummer] } }
```

Die Antwort geht als Ganzes über die Leitung (Campus: 2 MB) und bleibt im
Viewer liegen. Das ist Absicht: beim Ziehen über die Szene muss unter dem
Zeiger **sofort** feststehen, welches Material dort liegt — eine Rückfrage je
Mausbewegung wäre nicht bedienbar. Geschrieben wird der Index beim Tiling
(`_write_material_report()`, wo die Datei ohnehin offen ist); fehlt er, baut
die Route ihn im Hintergrund nach und antwortet so lange mit `202`.

Zwei Wege führen im IFC vom Bauteil zum Stil, und **beide** kommen vor: direkt
über ein `IfcStyledItem` am Geometrie-Item (so ArchiCAD, IFC4
`IfcPolygonalFaceSet`) und über die Darstellung des zugeordneten `IfcMaterial`
(so regelmäßig Revit und Allplan). `bauteil_stile()` fragt beide ab; am
Campusmodell trägt der erste Weg alles, und die 34 376 zugeordneten Bauteile
sind genau die, die auch getilt wurden.

**Hervorgehoben wird durch Zurücktreten.** Ein Klick auf ein Bauteil färbt
nicht dessen Material ein, sondern dämpft alle anderen
(`feature.color` multipliziert; Ziel `WHITE`, Rest ein dunkles Grau). Eine
eingefärbte Wand verlöre genau die Farbe, um die es hier geht. Nachgeladene
Tiles übernehmen die Hervorhebung über `tileset.tileVisible` — ohne das wäre
sie nach dem ersten Kameraflug lückenhaft.

**`scene.pick()` beim Ziehen ist gedrosselt** (80 ms). Der Aufruf kostet einen
eigenen Renderdurchgang; bei jedem `dragover` — dutzende je Sekunde — bricht
sonst die Bildrate ein.

**Mehrschichtige Bauteile fragen nach.** Trägt das getroffene Bauteil mehrere
Stile, erscheint ein kleines Menü statt einer Annahme: getroffen wird der
Körper, nicht die Schicht, und welcher Stil gemeint ist, kann der Zeiger nicht
wissen.

Was der Modus **nicht** kann: die Textur sofort zeigen. Sie steckt in den
B3DM-Tiles und erscheint erst nach dem Neu-Tiling. Sichtbar wird die Zuordnung
stattdessen in der Palette — Kachel und Häkchen an der Materialzeile.

### Volltonfarbe statt Textur — `farbe:#rrggbb`

Für gestrichene Flächen, Kunststoffe und alles, wofür es keine sinnvolle Textur
gibt, trägt eine Zuordnung statt einer Kategorie eine **Farbe**:
`{"Farbe weiß": "farbe:#e8e4dc"}`. Sie steht in denselben Overrides, läuft
durch dieselbe Route und dasselbe Re-Tiling — sie beantwortet dieselbe Frage
(„was gilt für diesen Stil").

**Es ist kein neuer Renderpfad.** Der Flachfarben-Pfad des Tilings schreibt
ohnehin `metallicFactor 0.0` und `roughnessFactor 1.0`, also genau die
Kennwerte einer matten, nichtmetallischen Oberfläche. Eine Farbzuordnung
tauscht deshalb nur die Vertexfarbe des Material-Chunks
(`_style_color_map()` → `_textured_arrays()`) und erzeugt kein zusätzliches
glTF-Material, kein Bild und keine UV-Koordinaten. Sie ist billiger als jede
Textur.

Gesetzt wird sie **je Chunk und nicht im glTF-Material**, weil ein Bauteil aus
Rahmen und Glas sonst eine Einheitsfarbe bekäme — derselbe Grund, aus dem
`ifc.py` schon die IFC-Farben je `material_ids` trennt.

`tiling/materials.py::farbe_aus_wert()` nimmt Lang- und Kurzform (`#abc`); die
Route lehnt alles andere mit 422 ab, statt einen Tippfehler als „unbekannte
Kategorie" durchgehen zu lassen.

### Behobener Zählfehler: `occurrences` war bei jeder IFC4-Datei null

`_style_usage()` griff die Stile so ab:

```python
candidates = getattr(assignment, "Styles", None) or [assignment]   # falsch
```

Gedacht war: IFC2x3 schiebt eine `IfcPresentationStyleAssignment` dazwischen,
IFC4 verweist direkt auf den Stil. Übersehen wurde, dass ein `IfcSurfaceStyle`
**selbst** ein Attribut `Styles` hat — die Liste seiner Rendering-Angaben. Bei
IFC4 lieferte der Ausdruck also `[IfcSurfaceStyleRendering]`, und die Prüfung
`is_a("IfcSurfaceStyle")` verwarf alles.

Die Wirkung war still: keine Ausnahme, keine Warnung, nur `occurrences: 0` für
jeden Stil. Der Assistent sortierte dann nicht nach Häufigkeit, sondern
alphabetisch — und die Angabe „412×", an der man sieht, welcher Stil das
Erscheinungsbild bestimmt, fehlte ganz. Am Campusmodell sind es tatsächlich
104 635 Zuweisungen auf 84 Stile.

Unterschieden wird jetzt über den Typ, nicht über das Vorhandensein des
Attributs (`stilindex.surface_styles()`, eine Stelle für beide Aufrufer).

**Re-Tiling erhält die Verortung.** `_retile_job()` sichert die
`placement.json` vor dem Löschen der alten Tiles und wendet sie danach wieder
an; ohne das spränge das Modell nach jeder Texturänderung an den
Standard-Referenzpunkt zurück. Die alten Tiles werden zuerst gelöscht, weil ein
Modell mit weniger Tiles als zuvor sonst Reste des vorherigen Laufs behielte,
die die neue tileset.json nicht mehr referenziert.

**Zugriffspfad auf den echten Stilnamen.** `geometry.materials[i].name` aus
dem IfcOpenShell-Iterator ist *kein* beschreibender Name, sondern ein
synthetischer Platzhalter wie `"IfcSurfaceStyleRendering-78499"` (die
Rendering-Sub-Entity hat kein `Name`-Attribut). Der echte Name hängt an der
Eltern-`IfcSurfaceStyle`-Entity, erreichbar über
`ifc_file.by_id(m.instance_id()).Name`. `_style_category_map()` in `ifc.py`
baut daraus einmalig (analog zu `_storey_map()`) ein Dict Entity-ID →
Kategorie; im Hot-Loop wird nur noch `dict.get(m.instance_id())` aufgerufen.
IfcOpenShells synthetischer `DefaultMaterial`-Fallback für Elemente ohne
zugewiesenen Stil hat `instance_id() == 0` — taucht in der Map nie auf,
`.get()` liefert dafür korrekt `None`, ganz ohne Sonderfall oder
`ifc_file.by_id(0)`-Aufruf (der wirft `RuntimeError: Instance #0 not found`).

**UV-Koordinaten werden erzeugt, nicht extrahiert** — IFC-Geometrie hat keine.
`_project_uv()` projiziert box-/triplanar: je Vertex bestimmt die dominante
Normalenachse die Projektionsebene, geteilt durch eine kategorieabhängige
`tile_size_m` (Meter Weltgröße je Texturwiederholung). Bei
`IFC_WELD_VERTICES=true` (Standard) hat ein Vertex an einer Kante zwischen
unterschiedlich orientierten Flächen nur eine gemittelte Normale — die
Achsenwahl kann dort für eine der beiden Flächen leicht "falsch" sein
(sichtbare Naht an scharten Kanten). Mit `IFC_WELD_VERTICES=false` (echte
Face-Normalen) verschwindet das vollständig, bei ~3x Geometriedaten.

**Material-Chunk-Grenzen bleiben erhalten**, statt wie bisher sofort zu einem
Element-Mesh zu verschmelzen: `_textured_arrays()` (vormals `_colored_arrays`)
gibt zusätzlich `material_chunks` zurück — eine Liste aus (Kategorie,
Index-Start, Index-Anzahl) je Element, klein genug (typ. 1–5 Einträge), um
ohne RAM-Risiko im `_Element`-Verzeichnis zu leben (siehe "Große
IFC-Modelle" oben). `_build_b3dm()` gruppiert diese Chunks aller Elemente
eines Knotens nach Kategorie; enthält ein Tile nur `None`-Chunks (der
Normalfall für die meisten Tiles), läuft exakt der unveränderte
`mesh_glb()`-Pfad. Erst wenn echte Kategorien vorkommen, baut
`mesh_glb_textured()` in `tiling/gltf.py` mehrere glTF-Primitives — eines je
in diesem Tile vorkommender Kategorie plus eines für den Flachfarben-Rest —
mit gemeinsamem Vertexpuffer, aber eigenem Bild/Material je Kategorie. **Nur
die im jeweiligen Tile tatsächlich verwendeten Texturen werden eingebettet**,
nicht global alle fünf — das hält das Tile-Wachstum proportional zum
texturierten Anteil statt es zu vervielfachen. Gemessen am Campus-Testmodell
(OPL, 342k Dreiecke, `IFC_WELD_VERTICES=true`): +23 % Gesamtgröße gegenüber
der unveränderten Flachfarben-Baseline (14,0 → 17,2 MB).

`IFC_TEXTURES_ENABLED=false` schaltet die Zuordnung komplett ab — die Ausgabe
ist dann byte-identisch zum Verhalten vor dieser Erweiterung (schneller
Rollback-Hebel, kein neuer Code-Pfad in `mesh_glb()` selbst berührt).

**Bekannter, bewusst in Kauf genommener Validator-Warnhinweis:** Da kein
`TANGENT`-Vertexattribut mitgeliefert wird, meldet der `3d-tiles-validator`
bei jedem texturierten Primitive "Material requires a tangent space but the
mesh primitive does not provide it" (WARNING, kein ERROR). CesiumJS und
praktisch jeder andere glTF-Renderer generiert den Tangentenraum in diesem
Fall selbst aus Bildschirmraum-Ableitungen — visuell ohne wahrnehmbaren
Unterschied. Explizite Tangenten mitzuliefern wäre möglich (Standard-Verfahren
aus Positions-/UV-Gradienten je Dreieck, akkumuliert und gegen die
Vertexnormale orthogonalisiert), ist aber bewusst zurückgestellt, um die
Änderung an `tiling/gltf.py`/`ifc.py` auf das Nötigste zu begrenzen.

**Was ausdrücklich nicht Teil dieser Erweiterung ist:** mehrere
Qualitätsstufen (High/Mid/mehrere Auflösungen je Tile-Set) und die
CesiumJS-Frontend-Umschaltung dafür — bewusst auf einen späteren Durchgang
verschoben, nachdem das visuelle Ergebnis dieser ersten High-Quality-Variante
geprüft wurde.

## Räume — warum sie nicht in den Tiles stehen

`GET /assets/{job_id}/rooms` gibt alle `IfcSpace` mit Hüllquader heraus. Die
Route existiert, weil der Viewer die Räume auf keinem anderen Weg bekommt:

**Der Tiler lässt `IfcSpace` bewusst weg.** `tiling/formats/ifc.py` führt sie in
`_EXCLUDE_TYPES` neben `IfcOpeningElement` und `IfcAnnotation` — ein Raumkörper
ist ein massives Volumen und deckte jede Wand darunter zu. Das ist richtig für
das Bild und lässt den Viewer trotzdem ohne Räume zurück: Er findet über die
Batch Table keinen einzigen, und zwar bei **jedem** über das Backend geladenen
Modell. Die Fehlersuche landet dann verlässlich beim falschen Verdächtigen.

Das Raumverzeichnis entsteht ohnehin — `section._room_index()` braucht es für
die Raumstempel im Grundriss und die Energiebilanz für das beheizte Volumen.
Die Route reicht es nur heraus.

| | `POST /section` mit `with_rooms` | `GET /rooms` |
|---|---|---|
| Umfang | ein Ausschnitt | das ganze Gebäude |
| Geometrie | Schnittpolygon in Schnitthöhe | Hüllquader, tile-lokal |
| Zweck | Beschriftung auf dem Blatt | „welche Räume hat der Bau" |

`raumkennwerte(src, job_id, mit_box=True)` stellt `lo`/`hi` dazu — in derselben
Zentrierung wie `element_box`, der Viewer kann sie also unverändert über
`root.computedTransform` nach ECEF bringen. Voreinstellung ist `False`: Die
Energiebilanz reicht ihre Raumliste unverändert in die Antwort durch, und sechs
zusätzliche Zahlen je Raum wären dort nur Ballast.

**Geschosszuordnung: Räume hängen anders als Bauteile.** `_storey_of()` fragte
nur `get_container()` ab — also `IfcRelContainedInSpatialStructure`, den Weg der
Bauteile. `IfcSpace` ist aber selbst Teil der räumlichen Struktur und wird dem
Geschoss über `IfcRelAggregates` untergeordnet, also über `Decomposes`. Ergebnis
war `storey: None` bei **jedem** Raum, und im Viewer landete alles in einem
Sammelgeschoss „ohne Geschoss". Seit August 2026 geht die Funktion bei leerem
Container die Zerlegungskette nach oben, bis ein `IfcBuildingStorey` kommt.
Prüfstein: `python3 tests/test_storey.py` — acht Fälle, darunter der Vorrang des
Containers, eine Kette ohne Geschoss und ein zyklisch fehlerhaftes Modell.

**Was die Route nicht kann:** Räume erfinden. Führt die IFC-Datei keine
`IfcSpace`, kommt eine leere Liste — und das ist die richtige Antwort. Von den
sieben Modellen, die im August 2026 unter `data/uploads/` lagen, führte
**keines** Räume; das ist bei Fachmodellen aus der Tragwerks- und TGA-Planung
der Normalfall, denn Räume legt das Architekturmodell an.

Geprüft wurde die Route deshalb gegen „Architektenhaus mit Landschaft.ifc"
(16 Räume, drei Geschosse) — HTTP 200, Flächen aus `Qto_SpaceBaseQuantities`,
Volumen aus dem Netz, Quader plausibel zum Grundriss.

### Was ein Raum über sich sagt — für die Raumansicht *(2026-10-17)*

```
GET  /assets/{job_id}/rooms?grundriss=true   + Grundrissfigur je Raum (tile-lokal, Außenring + Löcher)
GET  /assets/{job_id}/rooms/{global_id}       alle Psets eines Raums (Steckbrief, lazy)
POST /assets/{job_id}/rooms/ifc               IFC-Kopie mit Pset_iLEEN_Raum (siehe „Zurück ins IFC")
```

Jeder Raum in `/rooms` trägt zusätzlich `merkmale` (je Angabe `{wert, quelle}`,
umgerechnet mit `roh`), `ifc` (PredefinedType, ObjectType, Description,
Klassifikation, IfcZone) und `nutzlast`. Die Nutzlast folgt derselben
Reihenfolge wie der Lastabtrag (`plan._statik_nutzlast()`):

1. ein **Eingriff** `nutzlast_raum` auf die GlobalId (`eingriff: <Nr.>`, `gedeutet` daneben);
2. die Kategorie aus `raumlasten.kategorie_von()`, **dieselbe Funktion wie im Lastabtrag**;
3. die **Vorgabe des letzten abgeschlossenen Laufs** (`vorgabe: true`, Lauf und Datum in
   `herkunft`) — `tragwerk.nutzlast_stand()`;
4. sonst `kategorie: None` statt einer geratenen Zahl: welche Vorgabe gilt, legt erst ein Lauf fest.

| Modul | Aufgabe |
|---|---|
| `tiling/raumsemantik.py` | IfcSpace lesen: Psets, Klassifikation, Zonen — ohne Geometrie, eigener Cache `{job}.raumsem2.json` (2: liest `Pset_iLEEN_Raum` zurück) |
| `ileen/raumdaten.py` | deuten: Merkmal ← Kandidatenliste über `pset.eigenschaft`, Einheiten, DIN 277, Psets für die Anzeige sieben |

**Eigener Cache, kein neues Feld im Raumverzeichnis.** `rooms4` braucht einen
Geometrielauf, und an ihm hängen Lastabtrag und GEG. Eine neue Formatversion
dort rechnete bei jedem Modell die Geometrie neu, nur um Texte dazuzulegen.
Fehlt die Semantik (Fehler beim Lesen), kommt die Raumliste trotzdem — ohne
`merkmale`.

**Kandidatenlisten, weil die Normnamen fast niemand schreibt.** Gefunden an den
Modellen im Backend: ArchiCAD `Pset_SpaceCommon.Category` („Büroarbeit") und
`ArchiCADProperties.Raumkategoriecode` („02 NUF"), Revit `Energy Analysis.*`
(W/m², m²/Person), HSM-Campus `HSM_Raumdaten.Nutzung_Plantext`. Normname zuerst,
dann Erzeugername, dann deutscher Freitext; der erste **verwertbare** Treffer
gewinnt. Leer sind auch „0" (ArchiCAD, als Ganzzahl!), `<Fertigboden>`
(ArchiCAD-Platzhalter in spitzen Klammern), `<Default>` (Revit), und bei Zahlen
die 0 (Revit: „nicht gesetzt").

**Einheiten:** Normsätze sind SI — Temperatur > 150 gilt als Kelvin, Volumenstrom
< 5 als m³/s (× 3600). Freitext-Eigenschaften bleiben, wie sie sind.

**ArchiCADs Raumstempel-Pset** (`AC_Pset_Raumstempel_DIN_24`) hat im GoOP-Modell
**809** Eigenschaften je Raum — Stifte, Schriften, Zeilen je Maßstab — und
mittendrin echte Raumdaten (Bodenbelag, Deckenbelag, Wandbelag, Raumhöhe), die
nirgends sonst stehen. Er wird nicht verworfen, sondern je Eigenschaft gesiebt
(`_STEMPEL_LAYOUT`: interner Name in Klammern beginnt klein, Layoutwörter).

**DIN 277:** „02 NUF" → NUF 2, „VF" → VF 9, „TF" → TF 8, „NF 2.1" → NUF 2,
„NUF" ohne Ziffer bleibt „NUF" (GoOP: 184 von 269 Räumen). ArchiCAD legt die
Raumkategorie außerdem als Klassifikationsverweis **ohne System** ab; der gilt,
wenn seine Kennung das Kürzel trägt.

Gemessen (erster Aufruf, Semantik + Geometrie aus dem Cache): ArchiCAD-OPL 75
Räume 3,5 s, GoOP 269 Räume 9,7 s, HSM-Campus 340 Räume 14,9 s; danach Cache.
Eingespielt am 2026-10-17 per `docker cp` + `docker restart cesium-api`
(`ileen/raumdaten.py`, `tiling/raumsemantik.py`, `api/routes/plan.py`) — beim
nächsten `docker compose build api` fest im Image.

Prüfstein: `python3 tests/test_raumdaten.py` (Psets der drei Erzeuger, Leerwerte,
Einheiten, Stempelsiebung, DIN 277).

### Zurück ins IFC — `Pset_iLEEN_Raum` *(2026-10-18)*

`POST /assets/{job_id}/rooms/ifc` mit `{raeume: {GlobalId: {klasse,
klasse_bezeichnung, klasse_herkunft, werte: {kriterium: {wert, quelle_art,
quelle_text}}}}, normsaetze}` liefert eine Kopie der Quelldatei zum
Herunterladen (`<name>_raeume.ifc`, gestreamt per `FileResponse`, Arbeitsordner
danach weggeräumt). Das Protokoll steht in den Kopfzeilen `X-iLEEN-Raeume`,
`-Werte`, `-Ersetzt`, `-Normsaetze`, `-Normsaetze-Geteilt`, `-DIN277`,
`-Nicht-Gefunden` (für den Browser in `Access-Control-Expose-Headers`).

**Die Werte rechnet der Viewer, nicht diese Route.** Er ist die eine Stelle, an
der IFC, Statik, Katalog und Handzuordnung zusammenkommen
(`RaumMerkmale.ifcWerte()`); eine zweite Rechnung hier liefe auseinander. Das
Backend legt nur fest, **wie** es im IFC steht: `raumdaten.ILEEN_FELDER`
(Kriterium → Eigenschaftsname, Typ, Merkmal beim Zurücklesen) — eine Tabelle
für beide Richtungen.

| Festlegung | Warum |
|---|---|
| Zwei Sätze: `Pset_iLEEN_Raum` (Wert) und `Pset_iLEEN_RaumHerkunft` (`"katalog: Raumklasse Büro · EN 12464-1"`) | Ein Katalogrichtwert sieht im IFC aus wie eine Angabe der Fachplanung — eine Zahl |
| `IfcReal` mit Einheit im Namen (`Nutzlast_kNm2`, `Heizlast_W`, `Raumtemperatur_C`) | `IfcPlanarForceMeasure` läse sich ohne Krafteinheit in der Datei als Pa: 2,0 kN/m² kämen als 2 N/m² an |
| Ein zweiter Export ersetzt den ersten (`_alte_ileen_saetze_entfernen`) | sonst hinge nach jedem Export ein weiterer Satz am Raum |
| Normsätze (`Pset_SpaceOccupancyRequirements`, `…Lighting…`, `…Thermal…`, `…FireSafety…`, `Pset_SpaceCommon.HandicapAccessible`, DIN-277-Klassifikation) nur auf Wunsch, **nur leere Felder**, **nie in geteilten Sätzen** | ArchiCAD und Revit hängen einen Satz an viele Räume; eine Ergänzung dort schriebe in alle |
| Temperatur im Normsatz in der Einheit der Datei (°C nur, wenn vereinbart, sonst K) | der IFC-Standard |
| IFC2X3: Klassifikation mit `Source`, `ItemReference` statt `Identification` | sonst schreibt ifcopenshell eine ungültige Datei |

**Beim Zurücklesen** (`raumdaten._ileen_merkmale()`, angehängt an
`merkmale()`) gilt der Satz nur, wo die übrigen Psets schweigen — Ausnahme die
Raumklasse (`ileen_klasse`), die als frühere Entscheidung den Namen sticht.
**Katalog und Abgeleitetes kommen nicht zurück** (`_NICHT_ZURUECK`), Prüfbefunde
auch nicht (kein Merkmal: die Ansicht rechnet sie neu). Jedes zurückgelesene
Merkmal trägt `herkunft` (`ifc`, `statik`, `hand`), damit die Ansicht eine
Handzuordnung als Hand zeigt und eine eigene Statikangabe nicht als Widerspruch
zur Statik meldet. Der Satz selbst wird aus der normalen Kandidatensuche
herausgehalten — sonst fände „Nutzlast" ihn zweimal.

Gemessen (curl gegen den Container): OPL (60 MB, 75 Räume) 4,6 s, GoOP
(155 MB, 269 Räume) 10,8 s — fast alles `ifcopenshell.open()` und `write()`
(GoOP 4,6 + 4,1 s), die Sätze selbst unter einer Sekunde. Rundlauf an der OPL:
75 von 75 Klassen zurück (15 als Hand), Nutzlastkategorie mit Herkunft Statik,
kein Katalogwert als Angabe.

**404 heißt zweierlei, und die Meldung sagt welches.** `plan._local_source()`
unterscheidet: gar keine Quelldatei unter `uploads/{job}/` → „gibt es im Backend
nicht mehr — gelöscht oder unter neuer Kennung neu hochgeladen"; Quelldatei,
aber kein IFC → „keine IFC-Quelldatei". Vorher lief beides unter der zweiten
Meldung, und ein Viewer, der ein gelöschtes Modell noch aus dem Zwischenspeicher
zeigt, suchte den Fehler beim Format. Beim Löschen räumt `plan.purge_cache()`
jetzt auch `{job}.raumsem*.json` weg (`raumsemantik.purge_cache()`).

Prüfstein: `python3 tests/test_raum_ifc.py` (IFC4 ohne und IFC2X3 mit
Celsius-Vereinbarung: Herkunft je Wert, Rundlauf, 750 lx des Planers bleiben,
geteilter Thermosatz unberührt, DIN-Klassifikation, zweiter Export ersetzt).

Eingespielt am 2026-10-18 per `docker cp` + `docker restart cesium-api`
(`ileen/raumdaten.py`, `ileen/raum_ifc.py`, `ileen/eingriffe.py`,
`ileen/kette.py`, `ileen/raumlasten.py`, `tiling/raumsemantik.py`,
`api/routes/plan.py`, `api/routes/tragwerk.py`,
`api/routes/tragwerk_eingriffe.py`); die alten `raumsem1`-Caches sind gelöscht.

## Bauzeichnungen — Grundriss und Schnitt aus dem IFC

`tiling/section.py` schneidet ein Modell entlang einer Ebene und gibt die
getroffenen Bauteile als Polygone zurück, jeweils mit dem Schraffurmuster aus
`tiling/signaturen.json`. Der Ausschnitt kommt als Quader herein — dieselbe Box
in denselben tile-lokalen Koordinaten, die das Clipping-Werkzeug im Frontend
ohnehin führt.

**Warum das nicht im Browser geht.** Die B3DM-Tiles sind gebatcht, in float32
und um ihren Tile-Ursprung verschoben. Eine Schnittkontur ließe sich daraus nur
näherungsweise rekonstruieren; Wandanschlüsse fielen millimeterweise
auseinander und erschienen im Plan als Haarrisse in jeder Ecke. IfcOpenShell
liefert dieselbe Geometrie in float64 und mit Elementbezug, also samt Typ,
Geschoss und Material für die Signatur.

**Erst `storeys()`, dann schneiden.** Die Schnitthöhe ist relativ zum
Geschossfußboden gemeint, und wo der liegt, weiß nur das Modell — Fundamente
und Sockelgeschosse verschieben den Nullpunkt. Im ArchiCAD-Testmodell beginnt
das EG bei 1,75 m; ein auf 1,20 m geratener Schnitt traf dort die Oberkante der
Fundamentwände und lieferte vier Figuren statt 111.

**Der Zentrierungs-Offset wird nachgerechnet.** `tile_ifc()` ruft
`write_placement()` ohne `base_transform` auf, der Offset aus `_recenter()`
landet also nirgends. `build_index()` rechnet ihn nach derselben Konvention wie
`georef.recenter()` neu und legt ihn mit den Element-Bounding-Boxen unter
`SECTION_CACHE` ab. Ändert sich die Konvention in `georef`, muss sie hier
mitgezogen werden — sonst liegt der Plan versetzt zum Modell.

**Kein `rtree`.** Trimesh braucht es für `polygons_full`, also für die Frage,
welcher Ring ein Loch im anderen ist. Statt der C-Bibliothek macht `_nest()`
die Zuordnung über die Verschachtelungstiefe nach der Even-Odd-Regel. Bei einer
Handvoll Ringe je Bauteil kostet der quadratische Test nichts.

**Ansichtskanten sind Silhouetten**, nicht die sichtbaren Kanten nach
DIN 1356-1. Für die Verortung im Plan reicht das, für einen Abgabeplan nicht —
dafür müsste die Dreiecksnachbarschaft ausgewertet werden statt vereinigt.

### Die Hüllbox eines Bauteils — für die Schnittbox im Viewer

```
GET /assets/{job_id}/elements/{global_id}/box
    → { global_id, ifc_type, name, storey, center, size, lo, hi }
```

Das Elementverzeichnis führt die Bounding Box ohnehin — sie ist der Vorfilter
jedes Schnitts (`Box.contains()`). Der Endpunkt gibt sie einzeln heraus, damit
die Schnittbox im Viewer sich auf ein angeklicktes Bauteil einpassen lässt
(`frontend/section-box.js`, Knopf „Auf Bauteil"). Im Browser gibt es diese
Angabe nicht: ein B3DM ist gebatcht, die Ausdehnung eines einzelnen Bauteils
steckt dort nur verstreut in den Vertices hinter seiner Batch-ID.

Zwei Punkte, die daran hängen:

* **Dieselben Koordinaten wie `SectionRequest`.** `center`/`size` sind
  tile-lokal und zentriert wie in `build_index()`; der Viewer weitet den Quader
  nur auf und reicht ihn unverändert an `POST .../section` zurück. Wer die
  Zentrierungskonvention ändert, ändert beide Enden gleichzeitig.
* **Nicht in `elements.py`, obwohl der Pfad danach aussieht.** Die
  Bauteilsemantik kommt aus `properties.sqlite`, die Geometrie aus dem
  Elementverzeichnis — zwei verschiedene Dateien mit zwei verschiedenen
  Lebensläufen. Der Endpunkt steht deshalb bei dem Modul, dessen Cache er
  liest. Beide Router hängen unter `/assets`, das zusätzliche Pfadsegment
  `/box` unterscheidet sie.

Aussparungen, Räume und Anmerkungen stehen nicht im Verzeichnis
(`_excluded()`), für sie kommt 404 mit genau dieser Begründung.

### `cut_offset` — die Schnittebene in einer stehenden Box verschieben

Im Schnitt liegt die Ebene in der Box-Mitte; das ist richtig, solange man die
Schnittscheibe um die gewünschte Lage herum aufzieht. Die Schnittbox im Viewer
bleibt aber stehen und zeichnet aus **einer** Box drei Ebenen (XY, XZ, YZ) —
dort muss die Ebene innerhalb der Box wandern können, ohne den Ausschnitt zu
verändern. `cut_offset` misst dafür von der Kante `−size[1]/2` aus, also
dasselbe, was `cut_height` im Grundriss über der Unterkante tut.

Ohne Angabe bleibt es bei der Box-Mitte — der Plan-Reiter schickt weiterhin nur
`cut_height` und merkt von der Erweiterung nichts. Verschoben wird ausschließlich
`origin` entlang `across`; `to_2d` bleibt in X auf die Box-Mitte bezogen (der
Versatz ist orthogonal dazu) und in Y auf das tile-lokale Z. Ein Schnitt, dessen
Höhenmaße sich mit der Ebenenlage verschöben, wäre gegen `storeys()` nicht mehr
lesbar.

### Behobener Fehler: der Schnitt hielt sich nicht an die Box

`cut()` schnitt die Figuren nur im Grundriss auf den Ausschnitt zu — im Schnitt
stand dort `clip = None`. Das fiel nicht auf, solange ein Schnitt das ganze
Geschoss zeigen sollte: die Box war ohnehin so groß wie das Gebäude, und der
Zuschnitt hätte nichts weggenommen. Sobald die Schnittbox im Viewer daraus
Ausschnitte von ein paar Metern macht, zeichnete ein Detail die getroffenen
Bauteile in voller Länge — eine 3-m-Box um einen Wandanschluss lieferte die
14 m lange Wand.

`_clip(box, mode)` baut den Zuschnitt jetzt in Koordinaten der **Zeichenebene**,
und die sind im Schnitt andere als im Modell: X läuft entlang der Box (Nullpunkt
in ihrer Mitte), Y ist die Höhe als tile-lokales Z. Der Zuschnitt ist damit das
Rechteck `[−size[0]/2, +size[0]/2] × [Unterkante, Oberkante]`. `box.polygon()`
dorthin zu reichen wäre der naheliegende Fehler: das Polygon liegt in
tile-lokalen X/Y und beschriebe im Schnitt eine völlig andere Fläche.

Gemessen am Testmodell: 3-m-Box, Schnitt XZ — vorher 14,1 m breit, jetzt 3,0 m.
Der Geschoss-Schnitt aus dem Plan-Reiter bleibt unverändert (11 Figuren,
Ausdehnung 16,9 × 3,9 m), weil seine Box das Gebäude umschließt.

### Räume als Beschriftung, nicht als Figur

`with_rooms=true` liefert im Grundriss zusätzlich die `IfcSpace` des
Ausschnitts — mit Umriss, Nummer (`Name`), Nutzung (`LongName`), Fläche, lichter
Höhe und einem Ankerpunkt für den Stempel. Sie stehen als eigenes Feld `rooms`
neben `figures` und nicht darin: gezeichnet werden sie nicht (siehe Hinweis 16),
beschriftet schon. Ohne diese Daten gibt es keinen Positionsplan — die
Raumnutzung ist es, aus der die Nutzlast folgt.

Drei Punkte, die dabei zählen:

* **Der Anker ist `polylabel`, nicht der Schwerpunkt.** Bei einem L-förmigen
  Raum liegt der Schwerpunkt in der Kerbe, also im Nachbarraum, und der Stempel
  stünde über fremder Wand. `polylabel` sucht den Punkt mit dem größten Abstand
  zum Rand.
* **Die Fläche kommt aus dem Mengenset, wenn sie zur Geometrie passt.**
  `Qto_SpaceBaseQuantities.NetFloorArea` ist die Nutzfläche, wie der
  Entwurfsverfasser sie meint; das Schnittpolygon misst dagegen den Umriss in
  1,20 m Höhe und weicht bei Nischen und Vorwandinstallationen davon ab. Weicht
  das Qto um mehr als die Hälfte ab — eine falsch gelesene Einheit etwa —, gilt
  die gemessene Fläche.
* **Ringe werden vor dem Verschachteln repariert.** `_rings_from()` rundet auf
  0,1 mm; bei einem Umriss mit Nischen berührt der zurückgebaute Ring sich
  dadurch selbst und `_nest()` sortiert ihn als ungültig aus. Beim Büro 0.07 des
  ArchiCAD-Testmodells blieb so von 26 m² nur die 0,05 m² große Stütze darin
  übrig, die eigentlich ein Loch ist. `_repariert()` fängt das mit
  `make_valid()` ab.

Das Raumverzeichnis liegt getrennt vom Elementverzeichnis
(`{job}.rooms.npz` unter `SECTION_CACHE`), weil `_excluded()` die Räume aus dem
Iterator hält — sie stehen also gar nicht erst im Hauptindex.

## PDF-Vorlagen — pdf2svg für den Zeichenmodus

`tiling/pdf2svg.py` + `POST /plan/pdf` (auf `plan.catalog_router`, also unter
`/plan` statt `/assets/{job}`, weil kein Job entsteht) wandeln eine
hochgeladene PDF-Seite in ein Vektor-SVG samt Papiergröße — die Grundlage für
einen im Frontend-Zeichenmodus geladenen Bestandsplan (`plan-pdf.js`, siehe
frontend/CLAUDE.md, Abschnitt „PDF-Vorlagen als Blatt").

**Warum `pdf2svg` (Systempaket, poppler + cairo) und nicht PyMuPDFs eigener
SVG-Export.** PyMuPDF steht ohnehin in den Abhängigkeiten — aber nur, um die
MediaBox zu lesen (`page_size_mm()`, eine Kopfzeile der Datei, kein Rendern).
Für die eigentliche Umwandlung liefert `pdf2svg` sauberere, kleinere SVGs mit
Text als echten `<text>`-Elementen statt als Pfade; bei einem Bestandsplan mit
viel Beschriftung macht das den Unterschied zwischen einer Datei, die man noch
mit dem Editor ansehen kann, und einer, die nur noch der Browser verdaut.

**Zustandslos, mit Absicht.** Die Datei landet nur für die Dauer der Anfrage
in einer temporären Datei (`tempfile.NamedTemporaryFile`), es entsteht kein
Job, keine `job_id`, kein Eintrag in MinIO. Ein Seitenwechsel bei einer
mehrseitigen Vorlage schickt die Datei deshalb erneut mit — bei den paar
Megabyte einer Planvorlage kein Aufwand, der ein serverseitiges
Zwischenspeichern samt Aufräumpfad rechtfertigt.

`pdf2svg` schreibt nur in eine Zieldatei, nie nach stdout — `to_svg()` nimmt
deshalb den Umweg über ein `tempfile.TemporaryDirectory()`. Fehlt das Paket im
Container (`FileNotFoundError`), meldet die Route 500 statt den Prozess mit
einem rohen Traceback sterben zu lassen; das Paket kommt über
`docker/Dockerfile.api` (`apt-get install … pdf2svg`) ins Image.

## Statik — eine Decke rechnen, die im Plan gezeichnet wurde

Der Zeichenmodus im Frontend erzeugt aus einem Grundriss ein statisches System
(Systemfläche, Auflager, Lasten, Positionen) und schickt es hierher. `ileen/`
rechnet es durch — Platte, Scheibe, Bemessung, Nachweise —, legt rund dreißig
Bilder und einen Bericht ab, und der Plan zeigt sie wieder an.

```
POST   /assets/{job_id}/fem                      → { result_id, status }
GET    /assets/{job_id}/fem                       alle Rechnungen dieses Modells
GET    /assets/{job_id}/fem/{result_id}           Status, Bericht, Bildliste
GET    /assets/{job_id}/fem/{result_id}/bild/{n}  ein Bild als PNG
GET    /assets/{job_id}/fem/{result_id}/modell    die gerechnete Eingabe
DELETE /assets/{job_id}/fem/{result_id}
```

Der Rechenweg selbst ist unverändert der aus
`notebooks/iLEEN_Plattenstatik.ipynb`; `ileen/rechnung.py` ordnet ihn nur an
und zeichnet. Wer an der Statik etwas ändert, ändert es in `plate.py`,
`scheibe.py` oder `beton.py` und prüft es im Notebook — dort sieht man die
Wirkung sofort.

**Die Ergebnisse hängen am Asset, nicht am Blatt.** Ein Grundriss ist eine
Sicht auf ein Bauwerk: dasselbe Geschoss wird als Aufsicht und als Untersicht
gezeichnet, in zwei Maßstäben. Die Rechnung gehört zum Bauwerk, deshalb liegt
sie unter der `job_id` des Modells. Wer im Viewer ein Modell auswählt, sieht
genau dessen Rechnungen — der Plantitel steht als Feld daneben.

**Eigener Bucket `fem`, nicht `tiles/{job}/fem/`.** Das Re-Tiling nach einer
Texturänderung (`materials._retile_job()`) leert den Tile-Präfix des Jobs, und
eine Deckenrechnung hat mit den Texturen nichts zu tun. Gelöscht wird sie
trotzdem mit dem Asset: `assets.delete_asset()` ruft `fem.purge(job_id)`.

**Eine Rechnung zur Zeit** (`asyncio.Semaphore(1)` in `fem.py`). JAX belegt für
die Zerlegung mehrere Gigabyte und hält den Prozess an einem Kern fest; zwei
parallele Läufe wären nicht schneller, sondern beide vom Speicher bedroht. Der
Lauf selbst geht über `asyncio.to_thread`, damit der Server währenddessen
antwortet, und `ileen.rechnung` wird erst im Thread importiert — JAX kostet
beim ersten Import mehrere Sekunden und ein paar hundert Megabyte, die ein
Backend, aus dem niemand rechnet, nicht bezahlen soll.

**Jeder Abschnitt darf einzeln scheitern** (`Lauf.versuche()`). Eine Decke ohne
Punktauflager hat keinen Durchstanznachweis, eine ohne aussteifende Wände keine
Scheibenrechnung; beides ist eine Eigenschaft des Bauteils und kein Fehler der
Eingabe. Was nicht geht, steht als Hinweis im Bericht, der Rest wird fertig
gerechnet. Nur `rechnung.Abbruch` bricht durch — fehlende Systemfläche,
fehlende Auflager, ein Netz jenseits von `max_freiheitsgrade`. Diese Meldungen
sind für den Menschen im Zeichenmodus geschrieben und landen im Statusfeld.

**Die Gleichgewichtsprobe steht in jedem Bericht.** R = K·u − f: an freien
Knoten null, an gehaltenen die Auflagerkraft, ihre Summe gleich der
aufgebrachten Last. Das ist die schärfste Prüfung, die eine FE-Rechnung
zulässt, und sie kostet eine Matrixmultiplikation. Gemessen liegt die relative
Abweichung bei 10⁻¹²; alles über 10⁻⁶ wird als Hinweis vermerkt.

### Karten zweimal: zum Ansehen und zum Überlagern

Jede Ergebniskarte entsteht zweimal. Einmal als Bild mit Achsen und Farbskala
für die Galerie, und einmal nackt — nur die Fläche, transparent außerhalb der
Platte, ohne Rahmen — mit den Modellkoordinaten ihrer Ecken im Bericht
(`ausdehnung: [x_min, y_min, x_max, y_max]` in Metern der Zeichenebene). Die
zweite Fassung legt der Zeichenmodus deckungsgleich über den Grundriss.

Zwei Feinheiten, die dabei zählen:

* **`bbox_inches='tight'` ist bei der Überlagerung verboten.** Es beschneidet
  die Ränder um einen Betrag, den der Aufrufer nicht kennt — die angegebene
  Ausdehnung stimmte danach nicht mehr, und die Karte läge um Zentimeter
  versetzt über der Zeichnung.
* **Die Skala fängt nicht bei null an.** `zeichnen.karte()` tut das für
  Beträge, und für die Galerie ist das richtig. Bei der Bewehrung liegt der
  Wert aber auf dem größten Teil der Fläche auf a_s,min: eine Skala ab null
  färbt die ganze Platte gleich ein, und genau die Stellen mit Zulage
  verschwinden. Die Überlagerung nimmt deshalb das 0,5-Perzentil als Untergrenze.

Die Farbskala geht als Hex-Stützstellen (`farben`) mit, damit das Frontend
dieselbe Legende zeichnet, ohne matplotlibs Verläufe nachzubauen.

### Unterzüge: im Netz seit jeher, im Ergebnis seit `unterzug.py`

`plate.vernetze()` bildet einen Unterzug geometrisch ab — die Rasterspalten im
Balkenstreifen bekommen zusätzliche Elementlagen nach unten (beim Überzug nach
oben). Er steht damit im Gleichungssystem, versteift die Decke, zieht Last an
sich und verändert Durchbiegung, Momentenverteilung und Auflagerkräfte. Was
fehlte, war die **Auswertung**: „Moment je Meter Plattenbreite" ist im Steg
keine Größe, `plate.schnittgroessen()` setzte dort NaN, und damit endete die
Rechnung. Der Balken war im Modell, aber nicht im Ergebnis — keine
Schnittgröße, keine Bewehrung, kein Nachweis.

`ileen/unterzug.py` schließt das. Die Zuständigkeiten sind sauber getrennt:
`plate` wertet die Fläche je Meter aus und setzt im Balkenstreifen NaN (die
Maske kommt als `im_balken` mit), `unterzug` integriert dort über den ganzen
Querschnitt.

**Die Integration ist der Kern, und sie hat eine Falle.** Naheliegend ist
`M = −Σσ·(z − z_s)·dA` über die Elementmitten. Das ist um exakt 1/n² zu klein —
bei zwei Lagen über die Plattendicke also um **25 %**, in jeder Netzfeinheit
dieselben 25 %, weil die Mittelpunktregel ∫z²dz systematisch unterschätzt.
Gegen eine Kontrollrechnung gemessen fehlte genau dieser Faktor. Richtig ist
derselbe Weg, den `plate.schnittgroessen()` für die Platte geht: den linearen
Spannungsverlauf im Sinne kleinster Quadrate anpassen und mit dem **exakten**
Flächenträgheitsmoment integrieren, `I = Σ dA·(ζ² + Δz²/12)` (Steiner je
Element). Danach liefern beide Module an derselben Stelle bis auf die letzte
Stelle dasselbe — das ist der Regressionstest, wenn hier etwas geändert wird.

**Die Integrationsbreite ist eine Entscheidung, keine Naturkonstante.** In
einem Kontinuum aus Platte und Steg gibt es keinen eindeutigen „Balken": je
breiter man integriert, desto mehr Moment schreibt man ihm zu. Genommen wird
b_eff nach EC2 5.3.2.1, also genau die Breite, mit der auch bemessen wird —
Schnittgröße und Querschnitt sind damit dieselbe Annahme. l₀ kommt aus den
Nullstellen des gerechneten Momentenverlaufs, nicht aus den Faustwerten der
Norm. Weil das Raster diskret ist, wird `breite_ist_m` ausgewiesen und
verwendet, nicht der Sollwert.

Drei Punkte, die bei der Bemessung leicht falsch werden:

* **Feld und Stütze sind verschiedene Querschnitte, nicht nur verschiedene
  Vorzeichen.** Im Feld liegt die Druckzone im Gurt (b = b_eff), über der
  Stütze im Steg (b = b_w) — das ist ein Faktor sieben und mehr. `_druckzone()`
  in `unterzug.py` führt die Tabelle, `beton.plattenbalken()` zerlegt den
  T-Querschnitt, wenn x über den Gurt hinausläuft.
* **Beim Querkraftnachweis entfällt der Betontraganteil vollständig.** Ein
  Balken mit Bügeln trägt über das Fachwerk, nicht über die Rissverzahnung;
  v_Rd,c und die Bügel zu addieren zählt die Tragfähigkeit doppelt.
  `beton.querkraftbewehrung()` folgt dem NA (1 ≤ cot θ ≤ 3, V_Rd,cc nur in der
  zulässigen Neigung, nicht als Traganteil).
* **Das Versatzmaß ist nicht d.** Mit Querkraftbewehrung gilt a_l = z·cot θ/2,
  bei cot θ = 3 also rund das Anderthalbfache — die Zulagen werden länger als
  bei der Platte. Und die Grundbewehrung ist nicht A_s,min, sondern mindestens
  ein Viertel der Feldbewehrung (EC2 9.2.1.4).

### Das Stabbild: wie viele Stäbe, in wie vielen Lagen

Bis August 2026 endete die Bewehrungsführung bei einer *Menge*: `staffelung()`
lieferte „2 Ø 14 durchlaufend + 5 Ø 14 Zulage", und damit war die Sache erledigt.
Drei Dinge blieben dabei offen, und alle drei sind im Bild sichtbar geworden:

* **Die Summe war keine.** Grundbewehrung und Zulage wurden getrennt gewählt
  (`waehle_staebe()` sieht immer nur eine von beiden); geprüft wurde ihre Summe
  nur an einer groben Schranke `n > 2 · n_je_lage`. Was an der ungünstigsten
  Stelle tatsächlich nebeneinander im Bügel liegt, stand nirgends.
* **Der Querschnitt zeigte nur die untere Lage.** Beim Plattenbalken über einer
  Stütze liegt oben der schmalere Druckquerschnitt und damit regelmäßig *mehr*
  Stahl als unten — im Beispiel 5 Ø 25 gegen 7 Ø 14. Ein Querschnitt ohne die
  obere Lage verschweigt die größere Hälfte, und die Skizze im Aufriss ebenso.
* **d war eine Annahme.** `nutzhoehen()` rechnete mit „ein Stab Ø 16 in einer
  Lage", unabhängig davon, was gewählt wurde. Bei Ø 25 sind das 5 mm, bei zwei
  Lagen 3 cm — und die gehen unmittelbar in die Bewehrungsmenge zurück.

`beton.stablagen()` schließt das. Es ist die Portierung von
`rebarLayout.ts` aus dem Betonmodul von **StaLite** (`~/Projekte/TM_tools/
stalite-web/src/concrete/`) — dieselbe Rechnung, dieselben Regeln, damit ein
Querschnitt in beiden Werkzeugen dieselbe Bewehrung bekommt:

```
Randbedingungen + Stabzahl  →  Lagen  →  Stabachsen  →  Schwerpunkt → d
```

| Größe | Regel |
|---|---|
| lichter Mindestabstand | EC2 8.2 (2) + NA(D): s_min = max(Ø; d_g + 5 mm; 20 mm) |
| Stäbe je Lage | n ≤ L/(Ø + s_min) + 1 über die **Achsspanne** L = b_w − 2·(c_nom + Ø_Bügel + Ø/2) |
| Lagenaufteilung | gleichmäßig, äußere Lage nie weniger als die darüber |
| Lage 2 und 3 | Stabachsen aus dem Raster der ersten Lage — die Rüttelgassen müssen durchgehen (EC2 8.2 (4)) |
| Nutzhöhe | d = h − Schwerpunkt aller Lagen, **nicht** h − Randabstand |

**Der Größtkornterm ist der, der leicht fehlt.** `GROESSTKORN_MM = 16` ist der
Regelfall im Hochbau; bei 32 mm Korn wird s_min = 37 mm, und in einen 30er Steg
gehen dann statt sieben Ø 14 nur noch fünf. Wer die Annahme ändert, ändert damit
die Lagenzahl und über sie die Bewehrungsmenge.

**Die Nutzhöhe ist seither ein Ergebnis, keine Eingabe.** `unterzug.rechne()`
bemisst, staffelt, liest das Stabbild und bemisst erneut, bis d steht (Abbruch
bei 1 mm, spätestens nach drei Durchgängen). Ohne diese Schleife wäre die
Lagenzahl zwar richtig gezeichnet, aber mit einem d gerechnet, das es nicht gibt.

Im Ergebnis steht das Bild unter `staffelung_*["bild"]`, im Bericht als `staebe`,
`lagen`, `d_m`, `s_licht_mm`, `s_min_mm` und `passt`. Der Querschnitt
(`zeichnen.balkenquerschnitt`) zeichnet daraus beide Lagen mit maßstäblichem
Stabdurchmesser — gefüllt die durchlaufenden Stäbe, hell die Zulagen —, die
Bewehrungsskizze (`seite="beide"`) beide Lagen im Aufriss mit fortlaufender
Positionsnummer.

**Was `stablagen()` nicht tut:** die obere Bewehrung über b_eff verteilen. EC2
9.2.1.2 verlangt das für den gezogenen Gurt (siehe den Hinweis unten), das Bild
legt sie trotzdem in den Steg — dort hält sie der Bügel, und dort wird sie
gezählt. Bei einem breiten Gurt ist das die konservative Anordnung: sie führt
eher zu einer zweiten Lage als zu einer zu großen Nutzhöhe.

**Nicht addieren:** Plattenbewehrung im Gurt und obere Balkenbewehrung sind
über der Stütze dieselbe Bewehrung (EC2 9.2.1.2 verlangt, sie über b_eff zu
verteilen). Der Bericht vermerkt das als Hinweis.

Nicht gerechnet werden Torsion (Randunterzug unter auskragender Platte) und
schräg zum Raster liegende Balken — die versteifen die Decke richtig, werden
aber gemeldet und übersprungen, weil eine Treppe kein Querschnitt ist.

### NaN ist ansteckend

Die NaN-Konvention im Balkenstreifen ist bewusst, aber sie färbt ab:
`np.max`, `np.percentile` und `np.argmax` geben NaN weiter, und ein einziges
NaN machte aus der Bewehrungsfläche der *ganzen* Decke NaN — `NaN > 1.0` ist
dabei `False`, ein Nachweis stünde also fälschlich als erfüllt da. Alle
Auswertungen in `plate.py`, `rechnung.py` und im Notebook sind deshalb
NaN-tolerant (`plate.hoechstwert()`, `plate.einhuellende()`, `np.nanargmax`).
Wer dort eine neue Auswertung ergänzt, prüft sie an einem Modell **mit**
Unterzug — ohne einen fällt es nicht auf.

### Behobener Lastfehler: `netz.groesse²` ist nicht die Zellfläche

`vernetze()` teilt die Bounding Box in ganze Zellen (`nx = round(Δx/ziel)`);
dx und dy sind dabei nur zufällig gleich, und `netz.groesse` ist das Maximum
der beiden. An der Beispieldecke (12,0 × 9,0 m, ziel = 0,11 m) sind es 0,110092
gegen 0,109756 — 0,31 % Unterschied in der Fläche.

Jede Last, die über „Kraft geteilt durch getroffene Fläche" verschmiert wird —
Linienlast, Einzellast, Windrand, Schiefstellung —, kam damit um genau diesen
Betrag zu klein an. **Und zwar still:** die Gleichgewichtsprobe vergleicht den
*angesetzten* Lastvektor mit den Auflagerkräften und bestätigt den zu kleinen
Wert mit einer Abweichung von 10⁻¹². Sichtbar wurde es erst im Vergleich mit
`scheibe.gesamtkraft()`, also mit der Last, die man aufbringen wollte: −0,30 %
Wind bei der Netzfeinheit des Notebooks. `plate.zellflaechen()` und
`plate.zellvolumen()` rechnen die Fläche jetzt aus der Elementgeometrie; danach
stimmt der Windansatz auf 0,00 %.

### `scheibe.membrankraefte()`: Summe mal Δz, nicht Mittelwert mal Dicke

Für die ebene Platte ist beides dasselbe, im Streifen eines Unterzugs nicht:
dort hat die Säule fünf statt zwei Lagen, der Mittelwert wurde über alle fünf
gebildet und mit der Dicke der *Grundplatte* multipliziert. Die Membrankraft
kam dadurch um das Verhältnis der Lagenzahlen zu klein heraus — beim
Beispielunterzug (h = 55 cm bei d = 22 cm) um den Faktor 2,5, und genau dort,
wo die Scheibe ihre Zugkraft konzentriert: der Unterzug ist der Gurt des tiefen
Trägers. Richtig ist n = Σσ_k·Δz über die tatsächliche Säulenhöhe; `hoehe_m`
kommt mit heraus, damit die Betonspannung der Druckstrebe im Balkenstreifen
nicht mit der Plattendicke gerechnet wird.

### Abhängigkeiten: was daran heikel ist

`jax-fem` ist **GPL-3** und wird deshalb als Abhängigkeit installiert, nicht in
dieses Repository kopiert. Es deklariert im Wheel **keine** `Requires-Dist` —
sämtliche Abhängigkeiten (jax, basix, gmsh, meshio, pyfiglet) stehen deshalb
einzeln in `requirements.txt`, sonst scheitert erst der erste Rechenlauf am
Import.

**Für gmsh gibt es kein Linux-arm64-Wheel** — für kein einziges Release, seit
es das Paket gibt. `jax_fem.generate_mesh` importiert es aber auf Modulebene,
und `jax_fem.problem` importiert `generate_mesh`: ohne das Modul lässt sich der
Löser nicht einmal laden. Auf einem arm64-Container (Apple Silicon, Graviton)
tritt deshalb `ileen/shims/gmsh.py` an seine Stelle — ein Modul, das den Import
überlebt und bei jedem echten Zugriff mit einer Erklärung abbricht. Der
Rechenweg braucht gmsh nicht: `plate.vernetze()` legt ein Raster über den
Umriss, gmsh käme nur in `plate.vernetze_gmsh()` vor. Das Dockerfile setzt den
Ersatz nur ein, wenn das echte Paket fehlt.

`jax-fem==0.0.12` ist gepinnt und mit einem vollständigen Lauf geprüft. Die
Version davor (0.0.11) hieß den Quadraturparameter noch `gauss_order` und
rechnete die Geometriegrößen in NumPy statt JAX; `loeser.Loeser` übergibt
keinen der Namen und rührt die Geometriegrößen nicht an, deshalb tragen beide.
Beim Anheben die Signatur von `Problem` und die Felder `I/J/V` prüfen.

## Lastabtrag — das ganze Haus, von oben nach unten

Der Abschnitt darüber rechnet **eine** Decke. Das beantwortet „trägt diese
Platte", nicht „trägt dieses Haus": die Auflagerkräfte einer Decke sind die
Last der Wände darunter, deren Fußkräfte die Last der Decke darunter, und so
fort bis zur Gründung. `ileen/kette.py` rechnet diese Folge in einem Zug und
schreibt das Ergebnis **an die Bauteile** — je GlobalId und Geschoss ein Konto.

```
POST   /assets/{job_id}/tragwerk/lastabtrag              Kette starten
GET    /assets/{job_id}/tragwerk                         alle Läufe
GET    /assets/{job_id}/tragwerk/{lauf}                  Stand, Bilanz, Gründung
GET    /assets/{job_id}/tragwerk/{lauf}/bauteile         alle Konten (filterbar)
GET    /assets/{job_id}/tragwerk/{lauf}/bauteil/{gid}    ein Bauteil
GET    …/{lauf}/geschoss/{deckenfeld}                    FE-Bericht eines Felds
GET    …/{lauf}/felder/{deckenfeld}                      darstellbare Größen
GET    …/wolke/{deckenfeld}/{groesse}/tileset.json       Ergebnisgröße als PNTS
GET    …/wolke/{deckenfeld}/{groesse}/skala.json         Legende: Stufen, Grenzen, Histogramm
GET    …/{lauf}/punkt/{deckenfeld}?x=&y=                 alle Größen an einer Stelle
GET    …/{lauf}/zeichnung/{deckenfeld}                  die Schnitte, aus denen gerechnet wurde
POST   /assets/{job_id}/tragwerk/{lauf}/ifc              angereicherte IFC
DELETE /assets/{job_id}/tragwerk/{lauf}

GET    /assets/{job_id}/tragwerk/uebersicht              der Baum des FE-Browsers
GET    …/tragwerk/submodell/{name}/rechnungen            alle Stände eines Submodells
GET    …/tragwerk/{lauf}/plan/{submodell}                der Geschossplan als SVG

GET    /assets/{job_id}/tragwerk/eingriffe               alle Eingriffe am System
GET    …/tragwerk/eingriffe/arten                        Katalog der Eingriffsarten
POST   /assets/{job_id}/tragwerk/eingriffe               einen anlegen
DELETE /assets/{job_id}/tragwerk/eingriffe/{nr}          einen aufheben
```

Die Wolken-Endpunkte nehmen `stufen`, `verlauf` und `ueberhoehung`; alle drei
gehen in den Speicherpfad ein, weil dieselbe Größe in zwei Farbgebungen zwei
Wolken sind — und zwei Legenden.

| Modul | Aufgabe |
|---|---|
| `ileen/lastabtrag.py` | Konten, Lastpakete, Kombination, Erhaltungsprobe |
| `ileen/tragwerksmodell.py` | IFC-Geschoss → `ileen.plan.fem`-Modell, Wandachsen |
| `ileen/eingriffe.py` | Eingriffe am abgeleiteten System |
| `ileen/tragend.py` | Welche Bauteile tragen — Material vor Property-Set |
| `ileen/raumlasten.py` | Nutzlast je Raum aus der Nutzung, Trennwandzuschlag |
| `ileen/stand.py` | Eingabe-Hash, Veraltung, was neu zu rechnen ist |
| `ileen/plan_svg.py` | Geschossplan je Submodell — maßstäblich und deterministisch |
| `ileen/submodell.py` | Geschosskürzel, Submodellnamen, Ordnung der Deckenfelder |
| `ileen/wand.py` | Knicknachweis unbewehrt, EC2 12.6.5.2 |
| `ileen/stuetze.py` | Nennkrümmungsverfahren, EC2 5.8.8 |
| `ileen/kette.py` | die Reihenfolge und die Übergabe zwischen den Geschossen |
| `ileen/tragwerk_ifc.py` | `Pset_iLEEN_Lastabtrag` in eine IFC schreiben |
| `tiling/ergebniswolke.py` | Ergebnisfelder als PNTS-Tileset, Legende, Punktabfrage |

### Die Zeichnung eines Laufs — Grundlage der erzeugten Planblätter

Das Frontend erzeugt aus einem abgeschlossenen Lastabtrag je Deckenfeld zwei
Planblätter (`frontend/tragwerk-plaene.js`). Dafür braucht es die Zeichnung, in
der gerechnet wurde — nicht eine ähnliche, die es sich selbst zusammenstellt:
ein eigener Schnitt träfe womöglich eine andere Höhe, und dann läge das System
neben dem Grundriss.

**Gemerkt wird die Schnittlage, nicht die Zeichnung.** `kette.rechne_kette()`
schreibt Box, Bezugshöhe und die beiden Schnitthöhen als
`modell.plan.schnittlage` ins Statikmodell — fünf Zahlen, die ohnehin im
Geschossbericht landen. Die Figuren mitzuspeichern wären zwei Grundrisse à
mehrere Megabyte je Deckenfeld, bei neun Feldern über fünfzig Megabyte für
einen Lauf, dessen übrige Ausgabe zusammen ein Zehntel davon wiegt.
`GET …/zeichnung/{feld}` schneidet damit neu; das ist bitgleich dieselbe
Zeichnung, und der Section-Cache (`/tmp/section`, eigenes Volume) macht den
zweiten Aufruf schnell.

**Zwei Schnitte, weil es zwei Blätter sind.** `decke` liegt in der
Plattenmitte und zeigt die Deckenfelder — der Schalplan. `waende` liegt auf
halber Wandhöhe des Geschosses darunter und zeigt den Grundriss, auf dem die
Decke aufliegt — der Positionsplan. Ohne den zweiten schwebte das statische
System über einem leeren Blatt, und ob ein Auflager wirklich auf einer Wand
liegt, wäre nicht zu sehen.

Läufe aus der Zeit vor dieser Ergänzung haben keine Schnittlage; die Route
antwortet dann mit 409 und dem Hinweis, dass ein neuer Lastabtrag sie anlegt.
Ein stillschweigend geratener Schnitt wäre die schlechtere Antwort.

### Die Ergebniswolke: Farbe, Legende, Punktabfrage

Eine eingefärbte Punktwolke beantwortet die Frage „wo ist es viel". Die beiden
Fragen danach — „wieviel" und „was gilt sonst noch an dieser Stelle" — brauchen
mehr als Farbe, und beides steht in `tiling/ergebniswolke.py`.

**Die Legende liegt neben den Kacheln, nicht in der Antwort.** `aufbauen()`
schreibt `skala.json` in dasselbe Verzeichnis wie `tile.pnts`: Stufen mit ihren
Grenzwerten, Farbe, Punktzahl darin, dazu Einheit, Extremwerte und die
tile-lokale Ausdehnung. Der Viewer lädt das Tileset über Cesium und sieht das
Protokoll des erzeugenden Aufrufs nie — läge die Legende nur dort, müsste er
die Farbskala nachbauen, und beim ersten Eingriff in `_rampe()` liefen Bild und
Beschriftung auseinander.

**Die Punktzahl je Stufe ist keine Zugabe.** Sie macht aus der Legende ein
Histogramm, und das entscheidet über die Einschätzung: eine rote Stufe mit drei
Punkten ist die rechnerisch unvermeidliche Singularität am Auflagerrand (siehe
`plate._anteile`), eine mit dreitausend ist ein Bemessungsproblem. Die Farbe
allein sieht in beiden Fällen gleich aus.

**Dieselben sechzehn Farben im Bericht.** `ileen/zeichnen.py` registriert die
Tafel als `ileen_regenbogen` (und `ileen_regenbogen_r`) bei matplotlib; die
Durchbiegungskarte, ihre Überlagerung und die 3D-Verformungsfigur zeichnen
damit. Wer Bericht und Viewer nebeneinander sieht, sieht dieselbe Farbe für
denselben Wert — vorher war das eine `viridis`, das andere ein Regenbogen, und
das sah nach zwei Ergebnissen aus.

Die acht Stützstellen stehen dafür an zwei Stellen: hier und in
`zeichnen.REGENBOGEN`. Der Grund ist derselbe wie beim PNTS-Schreiben —
`ileen` greift nirgends auf `tiling` zu, sonst hinge die Rechenschicht an der
Kachelschicht, und `ergebniswolke.py` käme nicht mehr ohne matplotlib aus.
Beide Stellen verweisen aufeinander.

Achtung beim Vorzeichen: die Karten rechnen `w = -u_z` (Senkung positiv), die
`felder.npz` und die Verformungsfigur behalten `u_z` (Senkung negativ). Rot ist
in allen dreien die stärkste Senkung — deshalb läuft die eine Skala umgekehrt.

**Sechzehn abgesetzte Regenbogenstufen für die Durchbiegung.** Ein stetiger
Verlauf zeigt die Form der Biegefläche, aber man kann ihm keinen Wert ablesen —
zwischen zwei ähnlichen Blautönen liegt womöglich ein Millimeter oder ein
Zehntel. Abgesetzte Stufen machen daraus ein Höhenlinienbild: jede Kante ist
eine Isolinie, und die Legende sagt, welcher Wert dort steht. Der Regenbogen
ist als *stetige* Skala zu Recht verrufen (er erfindet Helligkeitssprünge);
in Stufen ist genau das sein Vorzug, weil benachbarte Stufen sicher
unterscheidbar bleiben. Momente behalten den stetigen divergenten Verlauf, weil
dort die Lage der Nulllinie zählt und nicht der Zahlenwert.

Die Durchbiegung läuft auf `regenbogen_r`, dem umgekehrten Verlauf: eine
Senkung ist negativ, und ohne Umkehr bekäme die stärkste Senkung die kälteste
Farbe.

**`werte_am_ort()` fragt beide Raster getrennt.** Verschiebungen sitzen auf den
Knoten, Schnittgrößen in den Elementmitten. Dazwischen zu interpolieren wäre
bequemer und würde die Kanten verwischen, die man sehen will — also wird je
Raster der nächste Ort gesucht und der Abstand mitgeliefert. Er sagt, wie genau
die Auskunft zum gefragten Punkt gehört; bei 40 cm Netzweite sind ein bis
zwanzig Zentimeter üblich. Weiter als anderthalb Elementweiten neben der
nächsten Elementmitte kommt `auf_platte: false` zurück, statt einen Randwert
als Auskunft auszugeben.

**Die Biegerandspannung ist Zustand I.** σ = 6·m/h² je Laufmeter, umgerechnet
auf N/mm². Sie steht in der Punktabfrage an beiden Rändern mit umgekehrtem
Vorzeichen — welcher Rand zieht, ist genau die Frage, die man an einer
Momentenkarte hat. Bemessen wird trotzdem mit den Momenten: sobald der Beton
reißt, und das tut er bei üblichen Decken schon unter Gebrauchslast, wandert
die Zugkraft in den Stahl und die wirkliche Betonspannung liegt anders.

### Nutzlasten kommen aus den Räumen, nicht aus einer Annahme

Bis September 2026 bekam jedes Geschoss **eine** Nutzlast: eine Kategorie aus
den Annahmen, gleichmäßig über die ganze Decke. Für ein Wohnhaus ist das
vertretbar, für alles andere ist es eine andere Rechnung. Ein Geschoss mit Büro
(2,0 kN/m²), Archiv (5,0) und Treppenhaus (3,0) hat drei Flächenlasten, und die
Stelle mit dem Archiv ist genau die Stelle, an der die Decke bemessen wird.

    IfcSpace.LongName  →  Kategorie  →  q_k        (ileen/raumlasten.py)
    „Büro"             →  B1         →  2,0 kN/m²
    „Archiv"           →  E1.1       →  5,0 kN/m²
    „Treppenhaus"      →  T1         →  3,0 kN/m²

**Der Raum-Iterator liefert jetzt Grundrissfiguren.** Das ist der Umbau, ohne
den das Ganze nicht geht. `_room_index()` führte je Raum nur einen Hüllquader;
für einen rechteckigen Raum genügt der, für ein L-förmiges Wohnzimmer liegt die
Kerbe darin, bei einem Flur um die Ecke fast der halbe Grundriss. Sobald daraus
**Lastflächen** werden, überlappen sich die Boxen benachbarter Räume, die
Nutzlast wird doppelt aufgebracht, und die Summenkontrolle zeigt einen
Fehlbetrag, den niemand erklären kann. Eine Fläche, die als Last dient, muss die
tatsächliche sein.

`_raum_grundriss()` schneidet deshalb waagerecht durch das Raumvolumen — mit
derselben Maschinerie, die auch die Bauteilfiguren bildet (`_section_rings()`,
`_nest()`), damit dieselbe Geometriefrage nicht an zwei Stellen beantwortet
wird. Geschnitten wird einen Meter über dem Boden: ein Raumvolumen ist unten und
oben von waagerechten Flächen begrenzt, und eine Ebene, die eine davon streift,
liefert Splitter oder nichts. Die Cache-Version steht deshalb auf `rooms4`.

**Die Restfläche ist der Teil, der leicht fehlt.** Räume decken den
Deckenumriss nie vollständig ab — Wandquerschnitte liegen dazwischen, Schächte
haben keinen IfcSpace, Nebenflächen sind oft gar nicht als Raum geführt. Ohne
Restfläche fehlte dort jede Nutzlast, und der Fehlbetrag wäre unsichtbar: die
Rechnung liefe durch, und die Gleichgewichtsprobe stimmte, weil sie prüft, ob
die Auflagerkräfte zur *angesetzten* Last passen. `_nutzlastflaechen()` bildet
deshalb `Umriss − Öffnungen − alle Raumflächen` und gibt ihr die
Vorgabekategorie; die Summe der Teilflächen ist damit genau die Systemfläche.

**Überlappende Räume tragen die Last einmal.** Jeder Raum wird um die bereits
vergebenen Flächen vermindert, größter zuerst — sonst zerschnitte ein Schacht
das Zimmer, in dem er steht.

**Die Zuordnung ist überschreibbar, weil sie eine Deutung ist.** „Lager" kann
ein Abstellraum (A3, 2,0) oder ein Lagerraum mit Regalen (E2.1, 7,5) sein — ein
Faktor knapp vier. `nutzlast_je_raum` in den Annahmen sticht die Deutung, und
jede Fläche trägt ihre `herkunft` in den Bericht: erkannt, gesetzt oder
Vorgabe.

Seit 2026-10-18 setzt man sie in der Raumansicht als **Eingriff
`nutzlast_raum`** (GlobalId des IfcSpace, `wert.kategorie` aus
`raumlasten.NUTZLASTEN`, sonst lehnt `eingriffe.pruefe()` ab). `kette._platte_rechnen()`
legt `eingriffe.nutzlast_vorgabe()` unter `nutzlast_je_raum` — stehen beide für
denselben Raum, gilt die Annahme. `anwenden()` meldet den Eingriff nur dort als
gegriffen, wo eine Nutzlastfläche mit `bezug == GlobalId` liegt; damit geht er
in den Eingabe-Hash genau des Deckenfelds ein, unter dem der Raum liegt — die
Geschosse darüber bleiben gültig, die darunter veralten über die Propagierung. Herkunft im Bericht: „von Hand gesetzt
(Eingriff am System)". Geprüft in `tests/test_eingriffe.py` Teil D.

### Der Trennwandzuschlag — verschmiert, weil die Norm es verlangt

Nichttragende Wände fielen bis September 2026 restlos aus der Rechnung: die
Erkennung verwarf sie als Auflager, und damit war ihr Gewicht fort. Eine Wand,
die weder trägt noch wiegt, gibt es nicht.

`raumlasten.trennwandzuschlag()` rechnet ihr Gewicht aus der tatsächlichen
Geometrie — Länge × Höhe × Dicke × Wichte — und verschmiert es über die Decke.
Verschmiert nicht aus Bequemlichkeit: DIN EN 1991-1-1/NA 6.3.1.2 (8) verlangt
es, weil eine Trennwand versetzt werden kann und die Decke für den ungünstigsten
Stellplatz tragen muss.

Der Regelweg ist umgekehrt — man schätzt die Wandlast je Meter und liest die
Stufe (0,5 / 0,8 / 1,2 kN/m²) ab. Hier steht die Geometrie zur Verfügung, also
wird sie benutzt und das Ergebnis auf die nächste Stufe gehoben; ergibt die
Geometrie mehr (viele Wände auf wenig Fläche), gilt der gerechnete Wert. Die
Stufe ersetzt die Abschätzung der Wandlast, nicht die Bilanz.

**Über 3,0 kN/m Wandlast steht ein Hinweis statt einer Zahl.** Dort verlangt
die Norm den Ansatz als Einzellast an ihrer Stelle. Das ist eine Entscheidung
des Tragwerksplaners, und sie stillschweigend auf 1,2 kN/m² zu kappen wäre die
gefährlichste Auslegung.

Geprüft in `tests/test_raumlasten.py` (Deutung, Reihenfolge der Schlüsselwörter,
Flächenbilanz, Überlappung, Öffnungen, die Stufen der Norm) und in
`tests/test_kette.py` Abschnitt 3b: die Gipskartonwand des Prüfkörpers erzeugt
1,2 kN/m², und die Erhaltungsprobe geht damit auf 0,000 % auf.

### Charakteristische Anteile, keine Bemessungswerte

Die eine Entscheidung, an der die Richtigkeit der ganzen Kette hängt.

Ein Bemessungswert trägt die Teilsicherheits- und Kombinationsbeiwerte der
Kombination in sich, aus der er stammt. Gibt man ihn nach unten weiter und
kombiniert dort erneut, steht γ zweimal darin; über drei Geschosse wächst der
Fehler auf γ³ ≈ 2,5 statt 1,35. Er fällt nicht auf, weil jede einzelne Rechnung
für sich stimmt und das Ergebnis nur „konservativ" aussieht.

Die Rückrechnung „N_d / 1,4" hilft nicht: der Faktor hängt vom
Mischungsverhältnis aus ständigem und veränderlichem Anteil ab, und genau das
ändert sich von Geschoss zu Geschoss — oben liegt fast nur Nutzlast, unten
überwiegt das Eigengewicht der Wände.

Gebucht wird deshalb **je Lastfall getrennt und charakteristisch**. Dafür
schreibt `rechnung.rechne()` seit dem Lastabtrag `bericht["auflager_
lastfallweise"]` mit: dieselbe `plate.auflagerbilanz()`, einmal je Lastfall
statt nur für die maßgebende Kombination. Es kostet je Fall eine Rückrechnung
R = K·u − f, keine zweite Zerlegung — die Lösungen liegen aus `loese_alle()`
ohnehin vor.

Kombiniert wird einmal, dort wo ein Nachweis geführt wird. Am selben Ort greift
die Abminderung der Nutzlast über die Geschosse (α_n, DIN EN 1991-1-1/NA
6.3.1.2(11)) — ohne sie ist ein mehrgeschossiger Lastabtrag durchweg zu schwer.

### Ein Geschoss hat so viele Decken, wie das Gebäude Abschnitte hat

Der teuerste Irrtum dieser Kette, und der am schwersten zu sehende.

Die erste Fassung rechnete je Geschoss **eine** Platte — die flächengrößte. Das
geprüfte Modell besteht aus zwei Baukörpern (x −0,1…40,4 und x 46,8…86,8, 87 m
Gesamtlänge), jedes Geschoss hat also zwei Deckenfelder. Gerechnet wurde nur
das größere.

Der Verlust blieb nicht bei dessen Ergebnissen. Die Wandlasten des anderen
Baukörpers wurden weitergereicht, landeten außerhalb des Systemumrisses und
wurden von `plate._anteile()` **stillschweigend verworfen** — die Funktion
merkt so etwas zwar an (`modell.warnungen`), aber die Rechnung läuft weiter und
das Ergebnis sieht plausibel aus. Messbar wurde es erst an drei Zahlen
nebeneinander:

```
OG2  Systemumriss  x 46,82…86,81     Linienlasten  x 26,01…30,81
     39 Lasten, 570,9 kN aufgebracht  →  ABG = 0,0 kN angesetzt
UG   Systemumriss  x −0,11…40,36     Linienlasten  x 18,38…70,86
     107 Lasten, 22 818,7 kN         →  ABG = 679,8 kN angesetzt
```

`kette.deckenplatten()` (Plural) liefert deshalb **alle** Felder eines
Geschosses, `_platte_rechnen()` rechnet jedes einzeln, und
`lasten_verteilen()` ordnet die Lasten von oben nach ihrer Lage dem Feld zu,
über dem sie stehen.

**Es kostet keinen zusätzlichen Schnitt.** Die Felder eines Geschosses liegen
auf derselben Höhe — sie sind dieselbe Decke, nur getrennt. Ein waagerechter
Schnitt trifft sie alle; `hoehengruppen()` fasst zusammen, was sich einen
Schnitt teilen kann. Nur die FE-Rechnungen vervielfachen sich, und die sind
gegenüber der Geometrie des Schnitts der schnelle Teil.

Drei Dinge, die daran hängen:

* **`statikmodell()` bekommt `platte_gid`.** Ohne diese Angabe nähme es wieder
  die größte Schnittfigur — und die muss nicht die sein, für die die
  Schnitthöhe bestimmt wurde. Zwei verschiedene Platten für Höhe und
  Systemfläche waren ein eigener Fehler derselben Fassung.
* **Die Wände werden auf den Plattenumriss gefiltert.** Derselbe Schnitt
  liefert auch die Wände des anderen Baukörpers; als Auflager angesetzt lägen
  sie außerhalb, das System wäre scheinbar reich gelagert und tatsächlich
  kinematisch.
* **Das Eigengewicht zählt einmal je Bauteil und Geschoss**, nicht einmal je
  Feld, das die Wand trägt. Eine Wand zwischen zwei Feldern wird zweimal
  gebucht; ihr Gewicht darf nur einmal weiterwandern
  (`Konto._eigengewicht_weitergegeben`).

Was auf **kein** Feld fällt, geht nicht verloren: solche Lasten stehen auf
Wänden, die im Geschoss darunter ohne Decke weiterlaufen, und werden
durchgereicht — mit einem Hinweis im Bericht.

### `EG` ist besetzt — der Lastfall, der das Eigengewicht auffrisst

`plate.EIGENGEWICHT` ist die feste Kennung `"EG"` für das Plattengewicht, und
`einzelfelder()` legt sie zuerst an. Danach läuft die Funktion über die
Lastfälle des Modells und schreibt für jeden, auf dem eine Last liegt, ein Feld
in dasselbe Wörterbuch. Heißt einer davon ebenfalls `EG`, **überschreibt er das
Plattengewicht**.

Das ist eine latente Falle, kein Randfall: der Zeichenmodus legt einen Lastfall
`EG` („Eigengewicht") an, und `tragwerksmodell` tat es ihm nach. Solange keine
Last darauf verweist, fällt nichts auf — `einzelfelder()` überspringt leere
Lastfälle. Der geschossweise Lastabtrag verwies dann darauf, weil er die
Wandlasten von oben nach ihrem ursprünglichen Lastfall weiterreichte.

Die Wirkung ist still. Die Rechnung läuft durch, die Bilder sehen aus wie immer,
die Gleichgewichtsprobe stimmt — sie prüft ja, dass die Auflagerkräfte zu der
Last passen, die tatsächlich angesetzt wurde. Nur war das eine andere als
gemeint: bei einer 718-m²-Decke fehlten 4 667 kN Eigengewicht je Geschoss, und
sichtbar wurde es erst an der Erhaltungsprobe über die ganze Kette — 88 %
Fehlbetrag zwischen dem, was oben eingetragen, und dem, was unten gebucht wurde.

Behoben an beiden Enden:

* `einzelfelder()` **addiert** jetzt, statt zu überschreiben, wenn ein Lastfall
  `EG` heißt und eigene Lasten trägt — inhaltlich auch das Richtige: was im
  Lastfall „Eigengewicht" steht, gehört zum Eigengewicht. Ein Hinweis geht in
  den Bericht.
* Der Lastabtrag verwendet für den ständigen Anteil den eigenen Lastfall `ABG`.

### Der veränderliche Anteil bekommt *keinen* eigenen Lastfall

Für den ständigen Anteil ist `ABG` richtig, für den veränderlichen wäre ein
`ABQ` falsch — und zwar aus einem Grund, der sich nicht aus der Programmierung
ergibt, sondern aus DIN EN 1990:

Nach Gl. 6.10 geht genau *eine* veränderliche Einwirkung voll ein, jede weitere
mit ψ₀. Die Nutzlast aus dem Geschoss darüber ist aber keine zweite,
unabhängige Einwirkung — es ist dieselbe Nutzlast derselben Kategorie, ein
Stockwerk höher. Als eigener Lastfall geführt, würde sie gegen die Nutzlast
dieses Geschosses mit ψ₀ = 0,7 abgemindert, **zusätzlich** zur Abminderung über
die Geschosszahl (α_n). Zweimal dasselbe Argument, und der Lastabtrag käme
systematisch zu leicht heraus.

Sie fließt deshalb in den vorhandenen Nutzlastfall ein und addiert sich dort.
Die Abminderung über die Geschosse macht allein `lastabtrag.bemessungswert()`
mit α_n, an der Stelle, an der ein Nachweis geführt wird.

### Die Deckenplatte wird gesucht, nicht geschätzt

`IfcBuildingStorey.Elevation` ist die Oberkante des **fertigen** Fußbodens. Die
Rohdecke liegt um den Estrichaufbau tiefer. Die erste Fassung der Kette schnitt
bei „Elevation des nächsten Geschosses minus 5 cm" und lag damit systematisch
über jeder Platte: an einem sechsgeschossigen Modell mit 37 Slabs meldete sie
**sechs von sechs Geschossen** als „keine Deckenplatte geschnitten". Der Abstand
betrug dort 17 cm (Rohdecke 7,54…8,00 m, Elevation OG1 8,17 m).

`kette.deckenplatte()` sucht die Platte stattdessen im Elementverzeichnis:
alle Slabs, deren Mitte zwischen zwei Geschossen liegt, gefiltert nach Dicke
(ein 3-cm-Element ist ein Belag) und Grundfläche relativ zur größten (ein
Treppenpodest hat dieselbe Dicke und ein Zwanzigstel der Fläche). Von dort
kommen Schnitthöhe **und** Dicke — beide gemessen statt geschätzt. Die
Wandhöhe ist dann die lichte Höhe bis zur Deckenunterkante; die Geschosshöhe
anzusetzen zählte die Decke zweimal.

### Deckenöffnungen sind Löcher im Netz, keine weiche Stelle

Treppenauge, Schächte, Aussparungen: bis September 2026 nahm `statikmodell()`
aus der geschnittenen Deckenfigur nur `rings[0]` und warf die inneren Ringe
weg. Die Decke wurde über dem Treppenauge durchgerechnet, als läge dort Beton —
zu viel Fläche, zu viel Eigengewicht, und an den Rändern der Öffnung fehlten
genau die Momentenspitzen, wegen derer man dort bewehrt.

**Ausgestanzt, nicht abgemindert.** Der naheliegende Ersatz — ein weiches
Material im Bereich der Öffnung — spannt dort trotzdem, nur schlechter, und die
Momente daneben stimmen dann nicht. `plate.vernetze()` verwirft stattdessen die
Zellen, deren Mittelpunkt in einem Loch liegt; das Netz hat dort keine
Elemente.

**Welcher Ring ein Loch ist, entscheidet die Verschachtelungstiefe.**
`ringgruppen()` führt dieselbe Unterscheidung schon für die Wandquerschnitte:
gerade Tiefe beginnt eine Fläche, ungerade ist ein Loch darin. Ein Schacht mit
Innenschale hat sonst ein Loch im Loch — also wieder Decke —, und das wäre als
zweite Öffnung gezählt und die Fläche doppelt abgezogen worden.

**`Netz.auf_platte()` ist die eine Stelle, an der „liegt hier Decke" entschieden
wird.** Es gibt ein halbes Dutzend Aufrufer — die wirksame Länge einer
Linienlast, der Ort einer Einzellast, die Rasterdarstellung, die Maskierung der
Karten —, und ein vergessener davon setzt eine Last ins Treppenauge, wo keine
Fläche ist. Vorher fragte jeder für sich `innen(…, netz.polygon)`, was ohne
Löcher richtig war und mit ihnen still falsch geworden wäre.

**Die Systemfläche wird netto geführt.** `flaeche_m2` zieht die Öffnungen ab.
Sie geht in die Bilanz der Kette ein, und mit der Bruttofläche käme dort mehr
Last an, als das FE-Netz trägt — die Erhaltungsprobe schlüge an, ohne zu sagen,
warum.

Geprüft in `tests/test_oeffnungen.py`: Elementzahl gegen die Öffnungsfläche,
mehrere Öffnungen, eine Linienlast quer über das Auge (12 m Wand, 8 m wirksam),
und das Loch im Loch.

### Die Wanddicke ist zweimal etwas anderes

Eine mehrschichtige Außenwand kommt als mehrere Ringe zurück. Für das
**Eigengewicht** zählt die Summe aller Schichten — das ist die Masse, die auf
der Decke steht. Für den **Knicknachweis** zählt sie gerade nicht: tragend ist
die dickste Einzelschicht, und wer 43 cm einsetzt, wo 17,5 cm tragen, rechnet
die Wand um den Faktor sechs zu steif (Steifigkeit ~ t³).

Die Dicke je Schicht folgt aus Fläche und Umfang, `t = U/4 − √((U/4)² − A)` —
exakt für gerade Wandstücke und für umlaufende Wandbänder. Vorher werden die
Ringe nach **Verschachtelungstiefe** gruppiert: gerade Tiefe beginnt eine
Fläche, ungerade ist ein Loch. Ohne das zieht eine umlaufende Betonwand mit
Dämmung drei innere Ringe vom äußersten ab und bekommt negative Fläche.

Die tragende Länge ist die **Achslänge** (A/t). Sie stimmt seit `wandachse()`
mit der Länge des Auflagers überein — vorher lieferte `auflagerlinien()` beide
Wandlängsseiten, also rund die doppelte Länge, und jede daraus gebildete
Linienlast wäre halbiert herausgekommen.

### Ein Lager je Wand, und es liegt auf ihrer Achse

Bis August 2026 wurde jede hinreichend lange Kante einer Wandfigur zum
Linienlager — bei einer geraden Wand also **zwei**, eines je Wandfläche. Das ist
geometrisch die Wand und statisch etwas anderes: zwei Lager im Abstand der
Wanddicke halten die Decke gegen Verdrehen, die Platte ist dort eingespannt
statt frei drehbar gelagert, und das Stützmoment über einer 24er Wand fällt
entsprechend zu groß aus. Eine Wand trägt als eine Linie, und diese Linie ist
ihre Achse.

`tragwerksmodell.wandachse()` baut sie:

1. **Die tragende Schicht wählen** — bei einem mehrschaligen Aufbau die
   Ringgruppe mit der größten Banddicke, denn auf ihr liegt die Decke auf. Bei
   11,5 + 14 + 17,5 ist das die 17,5er, und die Achse liegt in *deren* Mitte,
   nicht in der Mitte der 43 cm.
2. **Abschnitte trennen** — was innerhalb von 15 % ebenso dick ist, ist ein
   weiterer Abschnitt derselben Schicht und bekommt sein eigenes Lager.
   Dieselbe Regel wie in `wandquerschnitt()`, und aus demselben Grund: eine Tür
   teilt die Wand in zwei Stücke, die beide tragen.
3. **Mitteln** — der längste Kantenzug führt, und zu jedem seiner Punkte wird
   der nächste Punkt der gegenüberliegenden Fläche gesucht; die Mitte beider
   ist ein Achspunkt.

**Das Abstandsfenster bei der Suche nach der Gegenfläche ist der ganze Trick.**
Gesucht wird nur, was zwischen 0,35 und 3 Wanddicken entfernt liegt. Ohne diese
Schranke fände die Suche den kollinearen Nachbarn *derselben* Fläche im Abstand
null — ein Kantenzug wird an jeder kurzen Kante getrennt, und ein Wandende
teilt die lange Kante in zwei Stücke, die sich gegenseitig „gegenüberliegen"
würden.

Bei der **umlaufenden Außenwand** verschmelzen Außen- und Innenring auf diese
Weise zu einem umlaufenden Achszug — auch über Ecken, wo die Mitte zwischen
Außen- und Innenecke gerade die Achsecke ist. Geprüft an 10 × 8 m mit t = 0,30:
Achse bei 0,15/0,15, Mittelumfang 34,80 m. Bei einer **einringigen L-Figur**
(zwei im Schnitt verschmolzene Wände) liegt der innere Eckpunkt um eine halbe
Wanddicke daneben — auf zehn Meter Achslänge zwölf Zentimeter an einem Punkt,
innerhalb der Genauigkeit, die eine Vorbemessung ohnehin hat.

### Welche Wand trägt — Material vor Property-Set

Bis September 2026 hing die Frage an einem einzigen Property:
`Pset_WallCommon.LoadBearing`. Das ist die richtige Quelle, wo sie gepflegt
ist — und sie ist es in den wenigsten Modellen. Ein Architekturmodell aus
Revit, ArchiCAD oder Allplan führt sie oft gar nicht; dann war *jede* Wand ein
Auflager, die Gipskartonwand vor dem Aufzugsschacht eingeschlossen, und die
Decke lag auf einem Wald aus Lagern, der sie steifer machte, als sie ist.

`ileen/tragend.py` dreht die Reihenfolge um und fragt zuerst das **Material** —
das steht in fast jedem Modell, denn ohne es ließe sich das Bauteil nicht
darstellen. Die Regel ist die des Auftrags: eine Wand aus **Mauerwerk oder
Stahlbeton** trägt, **jede Stütze** trägt unabhängig vom Material, alles Übrige
geht nur als Last ein.

| # | Quelle | Warum an dieser Stelle |
|---|---|---|
| 1 | Rolle `stuetze`/`fundament` | Eine Stütze, die nicht trägt, ist keine |
| 2 | `IfcMaterialLayer.IsLoadBearing` | Aussage über **genau diese Schicht** |
| 3 | `Pset_WallCommon.LoadBearing` | Aussage über das Bauteil; richtig, wo gepflegt |
| 4 | Materialschichten | Trägt eine Schicht ein tragendes Material, trägt die Wand |
| 5 | Materialname | Bei einschaligen Bauteilen die einzige Angabe |

**Stufe 4 fragt alle Schichten, nicht die dickste.** Das ist der Punkt, an dem
`section._material_of()` nicht ausreicht: es nennt die dickste Schicht, weil im
Grundriss der tragende Kern schraffiert wird. Bei einer modernen Außenwand aus
17,5 cm Kalksandstein plus 20 cm Dämmung ist die dickste Schicht die Dämmung —
eine Erkennung, die nur sie ansieht, erklärt eine tragende Außenwand für
nichttragend. Und eine Wand weniger fällt in einem Grundriss mit achtzig Wänden
niemandem auf. `section.materialschichten_of()` liefert deshalb alle Schichten
mit Dicke; unter mehreren tragenden gilt die dickste, denn auf ihr liegt die
Decke auf.

**Gedeutet wird der Name, nicht ein Kennwert.** Naheliegend wäre die Rohdichte
oder die Festigkeitsklasse aus `IfcMaterialProperties` — beides ist in
Architekturmodellen so gut wie nie gefüllt. Der Name ist gefüllt, weil er in
der Legende auftaucht.

**Teilstring, nicht Wortgrenze — und dafür eine Ausnahmeliste.** Das Deutsche
schreibt zusammen: „Zementestrich" enthält „estrich" mitten im Wort, eine Suche
mit Wortgrenze findet ihn nicht. Als Teilstring gesucht, fängt „beton" aber
auch das „Gasbeton", und eine 24er Porenbetonwand wäre plötzlich eine
Stahlbetonwand — dieselbe Wand, dreifache Wichte. `SONDERFAELLE` führt die
knappe Liste solcher Wörter und wird vor allem anderen geprüft. Stämme bis drei
Buchstaben (`ks`, `gk`) verlangen weiterhin beidseitige Wortgrenzen, sonst
fände „ks" das „Werkstoff".

**`tragend = None` bleibt ein Auflager.** Wo das Modell nichts hergibt — kein
Material, kein Pset —, wird nicht geraten. Die Wand bleibt als Lager stehen und
die Herkunft steht als „keine Angabe im Modell" im Protokoll. Sie
herauszuwerfen wäre die gefährlichere Auslegung: ein Modell ohne jede
Materialangabe verlöre alle Wände, und das System wäre kinematisch.

Geprüft in `tests/test_tragend.py` (Klassifikation, Quellenreihenfolge, die
Falle der dicksten Schicht) und in `tests/test_kette.py` Abschnitt 9: derselbe
Prüfkörper einmal über das Pset und einmal über die Materialschichten muss
dieselbe Gründungslast ergeben, und die Gipskartonwand quer durch den Baukörper
darf in keinem Fall ein Konto führen.

### Jedes Bauteil wog Beton — der Vorgabewert, der nie überschrieben wurde

`eigengewicht_wand()` und `eigengewicht_stuetze()` nehmen eine Wichte, und ihr
Vorgabewert ist `25.0` — Stahlbeton. `kette.py` hat sie nie mitgegeben. Damit
wog jede Wand und jede Stütze Beton: eine Holzständerwand das Fünffache, eine
Mauerwerkswand das Anderthalbfache, quer durch alle Geschosse bis in die
Gründungslast.

**Warum keine Probe angeschlagen hat.** Die Erhaltungsprobe vergleicht, was in
die Kette hineingeht, mit dem, was unten ankommt. Ein zu schweres Bauteil geht
auf beiden Seiten mit derselben zu großen Zahl ein — die Bilanz stimmt exakt,
und zwar umso besser, je falscher gerechnet wird. Eine Probe prüft die
Buchführung, nicht die Buchungssätze.

Aufgefallen ist es an einem Einfamilienhaus in Holzständerbauweise (Königstein,
LPH 4): iLEEN wies 3508 kN Gründungslast aus, eine Handrechnung 2288 kN. Die
Nachrechnung traf iLEENs Zahl auf 0,0 kN genau — womit die Ursache feststand,
denn nur ein systematischer Faktor trifft so.

Die Wichten stehen jetzt in `lastabtrag.WICHTEN_TRAGEND`, nach DIN EN 1991-1-1
Anhang A, und `wichte_tragend()` gibt neben der Zahl zurück, **ob sie aus dem
Modell stammt**:

| Klasse | Wand | Stütze | |
|---|---|---|---|
| `stahlbeton` | 25,0 | 25,0 | |
| `mauerwerk` | 18,0 | 18,0 | |
| `holz` | 5,0 | 4,2 | Ständerwand über die Gesamtdicke gemittelt / Vollholz |
| `stahl` | 78,5 | 78,5 | |
| `leichtbau` | 9,0 | 9,0 | |

**Wand und Stütze stehen getrennt, weil dasselbe Bruttovolumen Verschiedenes
meint.** Eine Stütze ist auf ihrer ganzen Querschnittsfläche aus ihrem
Werkstoff; eine Holzständerwand ist es nicht — zwischen den Ständern liegt
Dämmung, außen Beplankung. Über die Gesamtdicke gemittelt wiegt sie rund
5 kN/m³, das Vollholz darin 4,2. Bei Stahlbeton und Mauerwerk fällt der
Unterschied weg.

Ohne erkannten Werkstoff bleibt es bei 25 kN/m³ — der schwerste übliche
Baustoff und damit für den Lastabtrag nach unten die sichere Seite. Aber das
Konto sagt es dann: `wichte_kNm3` steht in der Bauteilausgabe, und ein Hinweis
nennt die Annahme beim Namen. 25 an einer Holzwand ist der sichtbare Beleg
dafür, dass das Modell keinen Werkstoff hergibt.

**Der zweite Fehler steckte eine Ebene tiefer.** `beurteile()` beantwortete
zwei verschiedene Fragen aus derselben Quelle. Sagt ein Pset, dass die Wand
trägt, gab die Funktion als Werkstoff `materialklasse(material)` zurück — und
`material` ist bei einem mehrschichtigen Aufbau die *dickste* Schicht. Bei
17,5 cm Kalksandstein hinter 20 cm Dämmung ist das die Dämmung. Solange die
Klasse nur im Bericht stand, fiel das nicht auf; sobald die Wichte daran hängt,
wird daraus ein Rechenfehler. *Ob* ein Bauteil trägt, sagt oft das Pset;
*woraus* es ist, sagen nur die Schichten. `werkstoffklasse()` beantwortet
seitdem die zweite Frage für sich.

Dazu die Festigkeitsklassen des Holzbaus in `MATERIALKLASSEN`: ein Träger heißt
im Modell oft nur `GL24h`, ohne das Wort Brettschichtholz davor, und fiel damit
auf „kein Werkstoff erkannt“ zurück. Verwechslungsfrei gegenüber Beton, weil
die Betonklassen nach EN 206 immer zwei Zahlen führen (`C30/37`) und in der
Liste vorher stehen — nacktes `C30` ist eindeutig Nadelholz.

Geprüft in `tests/test_kette.py` Abschnitt 9b, an den Konten selbst und nicht
an der Tabelle: dazwischen liegt der Aufruf, der der eigentliche Fehler war.

### Stützen wurden nie erkannt — und warum das niemandem auffiel

Alle vier Kanten einer 30er Stütze sind 0,30 m lang, also kürzer als die
Mindestlänge von 0,80 m. `auflagerlinien()` gab für sie nichts zurück, und das
`if not linien: continue` darüber warf sie hinaus, **ehe** der Zweig für
Punktlager überhaupt erreicht war. Der Code für Stützen als Punktlager war
vorhanden, vollständig und tot.

Auffallen konnte es nicht: ein Skelettbau ohne Stützenlager ist nicht
kinematisch, solange irgendwo Wände stehen — die Decke spannt eben weiter, die
Bilanz stimmt, die Gleichgewichtsprobe stimmt, und die Last der Stütze steht
im Konto der nächsten Wand. Eine Stütze taucht in der Bauteilliste schlicht
nicht auf, und ein fehlender Eintrag fällt in einer Liste nicht auf.

Stützen laufen deshalb gar nicht mehr über Kanten, sondern über
`schwerpunkt()` — den Flächenschwerpunkt der Schnittfigur, über das
Flächenintegral und nicht als Mittel der Eckpunkte: eine aus einem Bogen
entstandene Rundstütze hat dicht gesetzte Punkte an einer Seite, und die zögen
den Punktmittelwert dorthin.

### Die Grenze des Verfahrens: Auflager aus Wandquerschnitten

Der Lastabtrag rechnet vollständig und bilanziert sauber. Die **einzelnen
Wandkräfte** sind trotzdem mit Vorsicht zu lesen, und der Grund liegt nicht im
Programm, sondern im Modell, das ihm zugrunde liegt.

Die Auflager entstehen aus Wandquerschnitten, nicht aus einem Tragwerksmodell.
Bei einem realen Grundriss mit vielen kurzen Wandstücken ist die Platte damit
hochgradig statisch unbestimmt gelagert: kurze, steife Lager ziehen Kraft an,
benachbarte heben ab. Aus dem geprüften Modell:

```
Wand,  L = 1,60 m :   7 568 kN  →  4 730 kN/m
Wand,  L = 14,51 m:  12 307 kN  →    848 kN/m
ein Nachbarlager  :  −4 134 kN            (abhebend)
```

Eine 24-cm-Wand aus C25/30 trägt unbewehrt rund 1 800 kN/m. 4 730 kN/m ist
kein Ergebnis, sondern ein Zwängungsartefakt.

**Die Gleichgewichtsprobe schlägt dabei nicht an** — sie prüft, ob die
Reaktionen zur angesetzten Last passen, und das tun sie. Auch die
Erhaltungsprobe über die Kette bleibt gültig, weil sich Anziehen und Abheben
in der Summe aufheben. Beide Prüfungen sind richtig und übersehen es trotzdem.

`_lagerguete()` misst deshalb, was keine der beiden misst:

| Kennzahl | Bedeutung |
|---|---|
| `lager_abhebend` | wie viele Lager Zug bekommen statt Druck |
| `zwanganteil` | abhebende Kraft geteilt durch drückende |
| `spitze_kN_je_m` | größte Linienlast eines Lagers |
| `lagerguete` | brauchbar · fraglich · unbrauchbar |

Ab einem Zwanganteil über 0,25 oder einer Linienlast über 3 000 kN/m gilt die
Lagerung als unbrauchbar; das steht dann als Hinweis im Bericht, mit dem
ausdrücklichen Zusatz, dass die **Gesamtbilanz** davon unberührt bleibt.

Was dagegen hilft, ist kein besserer Solver, sondern ein besseres Modell.
Zwei der drei damals genannten Schritte sind seit August 2026 gemacht:

* **Wandachsen statt Wandquerschnitte** — siehe den Abschnitt darunter. Eine
  Wand ist ein Lager, nicht zwei, und die beiden Lager im Abstand der
  Wanddicke waren ein guter Teil der Zwängung: sie hielten die Decke gegen
  Verdrehen, wo sie frei drehbar aufliegt.
* **Federsteifigkeit statt starrem Auflager** — nicht als Voreinstellung, aber
  als Eingriff (`lager_art` mit `feder`, siehe unten). Wo eine Vorbemessung
  Zwangskräfte zeigt, lässt sich das Lager nachgiebig setzen und neu rechnen.

Seit September 2026 ist der dritte gemacht: **Wandstücke werden zu einem Lager
zusammengeführt** (`tragwerksmodell.lager_zusammenfuehren()`). Ob eine 12 m
lange Wand im IFC ein Bauteil ist oder fünf, entscheidet das Autorenwerkzeug —
Revit legt an jeder Raumgrenze ein neues Wandobjekt an, ArchiCAD an jedem
Materialwechsel. Aus fünf Bauteilen wurden fünf Lager, und das ist statisch
etwas anderes als eines.

Verschmolzen wird nur, was **aneinanderstößt**: fünf Zentimeter Toleranz und
fünf Grad Winkelabweichung. Das deckt Rundungen und Fugen ab, nicht aber eine
Öffnung — eine Tür teilt die Wand weiterhin in zwei Abschnitte mit je eigenem
Lager. Das ist konservativ und bewusst: über einer Tür trägt ein Sturz, und der
trägt anders als die Wand daneben. Ein Modellierungszufall ist die
Zerstückelung, eine Tür ist es nicht.

Nicht verschmolzen wird außerdem, was verschiedene Lagerarten hat — welche
gälte für das vereinte Lager? Die Frage darf nicht stillschweigend entschieden
werden. Ecken scheitern an der Winkelprüfung, Punktlager bleiben unberührt.

**Die Kraftaufteilung wandert mit, und das ist der Teil, der leicht fehlt.**
Ein zusammengeführtes Lager trägt `bauteil_anteile` — GlobalId → Achslänge —,
und `lastabtrag.aus_auflagerbilanz()` teilt danach auf. Vorher teilte es
gleichmäßig, weil ein Lager höchstens zufällig mehrere Bauteile trug; nach dem
Zusammenführen bekäme ein 2-m-Stück damit so viel wie ein 12-m-Stück, und sein
Knicknachweis fiele um das Sechsfache zu ungünstig aus.

Geprüft in `tests/test_eingriffe.py` Teil B — beides, was verschmelzen muss
(drei Stücke in beliebiger Reihenfolge, auch gegenläufig modelliert) und was
nicht (Ecke, Tür, parallele Wände, verschiedene Lagerarten).

### Das System ändern — die Eingriffe

Die Ableitung aus dem IFC ist eine Vermutung. Sie liest aus Geometrie, was
eigentlich eine Entscheidung des Tragwerksplaners ist: welche Wand trägt, wo
sie gelenkig und wo eingespannt gelagert ist, welche nur aussteift.

`ileen/eingriffe.py` hält die **Eingriffe**: kleine, benannte Änderungen am
abgeleiteten System. Die Ableitung bleibt unverändert und wird bei jedem Lauf
neu gemacht; die Eingriffe legen sich darüber.

| Art | Wirkung |
|---|---|
| `lager_entfernen` | Das Bauteil trägt nicht mehr |
| `lager_art` | gelenkig · eingespannt · feder (+ Steifigkeit) |
| `lager_verschieben` | neue Polylinie oder neuer Punkt |
| `lager_hinzufuegen` | ein Lager, das im Modell nicht steht (`E1`, `E2`, …) |
| `bauteil_tragend` | sticht Materialerkennung und `Pset_WallCommon.LoadBearing` |
| `annahme` | Deckendicke oder Flächenlast eines Submodells |
| `nutzlast_raum` | Nutzlastkategorie eines **Raums** (GlobalId des IfcSpace), sticht die Deutung aus der Nutzung |

**Die Weitergabe nach unten stimmt von selbst.** Die Kette ist eine reine
Funktion ihrer Eingaben; wer ein Auflager entfernt, entfernt damit

    kein Lager  →  keine Auflagerkraft  →  kein Konto  →  keine Fußkraft
                →  keine Linienlast auf die Decke darunter

und das setzt sich bis zur Gründung fort, ohne dass irgendwo eine
Fortpflanzungsregel stünde. Die Decke darüber verteilt ihre Last zugleich auf
die verbliebenen Lager um — sie spannt jetzt weiter. Genau deshalb ist ein
Eingriff für sich noch kein Ergebnis: er ändert keine einzige Zahl, bis neu
gerechnet wurde. Am Prüfkörper aus `tests/test_kette.py` fällt die Gründungslast
nach einem entfernten Auflager im ersten Obergeschoss von 6 000 auf 4 382 kN.

**Der Anker ist die GlobalId, nicht `A7`.** Lagerkennungen entstehen beim
Ableiten und zählen die Reihenfolge, in der der Schnitt die Wände zurückgibt.
Eine andere Netzweite, eine andere Schnitthöhe, eine Wand mehr — und `A7` ist
eine andere Wand. Ein Eingriff darauf wäre beim nächsten Lauf still auf das
falsche Bauteil gewandert; still, weil `A7` ja existiert.

**`bauteil_tragend` wirkt als einzige Art vor der Ableitung.** Eine Wand, die
die Tragwerkserkennung verworfen hat, steht im fertigen Modell nirgends mehr —
ihre Geometrie ist fort, und kein nachträglicher Eingriff könnte sie
zurückholen. `statikmodell()` fragt deshalb `eingriffe.tragend_vorgabe()` ab,
während es die Wände durchgeht.

**Ohne Angabe eines Submodells gilt ein Eingriff überall.** Eine GlobalId gibt
es nur einmal im Bauwerk — wer sagt „diese Wand trägt nicht", meint sie überall.
Das Feld `submodell` ist für den Sonderfall da, dass dieselbe Wand unter zwei
Deckenfeldern liegt und nur unter einem davon anders gelagert sein soll. Ein
Eingriff **mit** Submodellangabe bleibt draußen, solange kein Submodell genannt
ist: ihn dann mitzunehmen wäre die gefährlichere Auslegung.

#### Warum es keine Zweige mehr gibt

Bis September 2026 lagen die Eingriffe als **Subpläne** in **Zweigen**, die in
einen Hauptstand überführt wurden — eine Versionsverwaltung mit Konfliktprüfung,
rund 1 500 Zeilen. Sie ist ersatzlos entfallen, und zwar aus zwei Gründen.

Der erste ist Bedienung: es gab damit zwei Wege durch die Anwendung, und die
Frage „auf welchem Zweig bin ich" war der Fehler, der dabei passierte. Es gibt
jetzt genau einen Weg — Gesamtsystem, FE-Browser, Submodell.

Der zweite ist die Aktualität. Ein Zweig trug ein Merkmal `gerechnet.veraltet`,
das jemand setzen musste. Die Frage, auf die es antwortete — *gilt die Zahl, die
ich sehe, für das System, das ich sehe?* — beantwortet jetzt der **Eingabe-Hash
des Submodells**: ein Eingriff geht in ihn ein, der Hash stimmt nicht mehr mit
dem des letzten Rechenstands überein, und das Submodell samt allem darunter
steht auf „veraltet". Ein Hash kann nicht vergessen werden, ein Merkmal schon.

Die Eingriffe liegen als **eine** flache Liste unter `{job}/_eingriffe.json` im
`tragwerk`-Bucket — der Unterstrich hält sie aus der Laufliste heraus, die alles
unter `{job}/` als Lauf liest.

### Die Bodenplatte — ein eigenes Submodell, und das einzige mit Bettung

Bis September 2026 endete die Kette am Wandfuß des untersten Geschosses:
`_gruendung()` sammelte die Fußkräfte, und das war die Eingangsgröße für einen
Gründungsnachweis, den jemand anders führen musste. Die Sohlplatte selbst wurde
nie gerechnet.

`kette.bodenplatte()` sucht sie, `_bodenplatte_rechnen()` rechnet sie als
`submodell.FUND` (bei mehreren Baukörpern `.1`, `.2`).

**Warum sie nicht wie ein Geschoss läuft.** Eine Geschossdecke bekommt ihre
Lager aus den Wänden darunter. Unter der Bodenplatte steht keine Wand, sondern
Boden — die Lagerung ist flächig und nachgiebig statt linienförmig und starr.
Die Wände *über* ihr sind keine Auflager, sondern die Last. Deshalb wird für sie
kein Wandschnitt gemacht: `statikmodell()` bekommt eine leere Wandantwort, die
Fußkräfte als Linienlasten und die Bettung anstelle der Lager.

**Ohne Bettung gibt es diese Rechnung nicht.** Ein System ohne jedes Lager ist
kinematisch, und `statikmodell()` bricht dann ab — mit einer Ausnahme genau für
diesen Fall: `bettung_kNm3` gesetzt heißt, die Federn halten sie. Fehlt der
Wert, tritt `BETTUNG_VORSCHLAG_KNM3 = 20 000 kN/m³` ein (mitteldicht gelagerter
Sand/Kies) und steht als **Annahme** im Bericht, nicht als Zahl ohne Herkunft.

**Die Deckendicke gilt für die Bodenplatte nicht.** Wer in den Annahmen „22 cm"
vorgibt, meint die Geschossdecken; eine Sohlplatte ist regelmäßig dicker, und
die Dicke geht mit der dritten Potenz in die Steifigkeit ein. Sie nimmt deshalb
ihre gemessene Dicke, sofern nicht `bodenplatte_dicke_m` ausdrücklich etwas
anderes sagt. Beim Bauen hat genau dieser Durchgriff eine 30er Platte mit 22 cm
gerechnet — still, und um ein Drittel zu leicht.

**Sie zählt nicht in die Erhaltungsprobe der Wandkette.** Die fragt, ob am
*Wandfuß* ankommt, was auf den Decken darüber eingetragen wurde. Die
Bodenplatte steht unter diesem Fuß: ihre eigene Last — Eigengewicht, Ausbau,
Nutzlast im Keller — geht direkt in den Baugrund und taucht in keinem
Wandkonto auf. Mitgezählt ergäbe sie einen Fehlbetrag in genau ihrer Höhe, und
der sähe aus wie verlorene Last. Ausgewiesen wird sie als eigener Posten unter
`gruendung.bodenplatte`.

Geprüft in `tests/test_kette.py` Abschnitt 3c: zwei gebettete Platten ohne
Auflager, der Vorschlagswert mit seiner Herkunft, und die Sohle trägt
1 344 kN eigene Last über die 6 288 kN aus den Wänden hinaus.

### Der Zustandsbestand — eine Datei je Modell, nicht je Lauf

`{job}/_submodelle.json` beschreibt den **Zustand**, nicht ein Ergebnis: je
Submodell seine Art, sein aktueller Eingabe-Hash und der Lauf, unter dem es
zuletzt gerechnet wurde. Ein Lauf vergeht, die Frage „was ist aktuell" bleibt.

Jeder Lauf trägt für die Submodelle ein, die er gerechnet hat. Was er nicht
angefasst hat, bleibt stehen — genau darauf beruht die inkrementelle Rechnung:
`stand.zu_rechnen()` liest den Bestand und nennt, was nachzuziehen ist.

**`GET …/tragwerk/uebersicht` rechnet nicht.** Die Antwort kommt aus zwei
kleinen Dateien — dem Bestand und den Eingriffen —, nicht aus den
Rechenständen. Ein Browser, der beim Öffnen acht Geschossberichte lädt, um
einen Baum zu zeigen, braucht dafür Sekunden; hier sind es Millisekunden. Das
ist die Anforderung „reaktionsschnell auch bei vielen Geschossen" in einer
Zeile Architektur.

**Der Plan liegt beim Submodell und zusätzlich beim Lauf.** Beim Submodell
(`{job}/{submodell}/zeichnungen/grundriss.svg`), weil er zu dem Ausschnitt
gehört, den er zeigt, und das Aufräumen alter Rechenstände überleben soll.
Beim Lauf, weil ein Plan zu genau einem Rechenstand gehört — wer einen alten
Stand ansieht, will dessen Blatt und nicht das von heute.

### Die Erhaltungsprobe

Die Summe aller Lastpakete ist **keine** Kontrollgröße: eine Last aus dem
obersten Geschoss taucht in jedem darunterliegenden Auflager erneut auf. Sie
wächst mit der Zahl der Geschosse, ohne dass etwas falsch wäre.

`lastabtrag.gesamtbilanz()` vergleicht deshalb, was **neu** eingetragen wurde
(je Geschoss Plattengewicht und Flächenlasten) plus alle Eigengewichte mit dem,
was am Fuß ankommt. Klaffen sie auseinander, ist Last aus der Kette gefallen:
ein Auflager ohne Bauteilbezug, eine Wand ohne Fortsetzung, ein übersprungenes
Geschoss. Der Fehlbetrag steht im Bericht statt in niemandes Kenntnis.

### Prüfen ohne Server

`tests/test_kette.py` stellt Schnitt und Rechnung durch Attrappen nach: die
Rechenattrappe verteilt die Last nach einer von Hand nachrechenbaren Regel, und
jede Abweichung gehört damit der Kette, nicht dem Solver. Der Prüfkörper trägt
ausdrücklich einen Fußbodenaufbau von 18 cm, ein Treppenpodest und einen 3-cm-
Belag — genau die drei Dinge, an denen die erste Fassung scheiterte.

```bash
python3 tests/test_kette.py
python3 tests/test_eingriffe.py # Wandachse, Eingriffe, Fortpflanzung
python3 tests/test_tragend.py   # Materialklassen, Quellenreihenfolge, tragende Schicht
python3 tests/test_oeffnungen.py # Treppenauge und Schächte als Löcher im Netz
python3 tests/test_raster.py    # Rasterlinien, eine Knotenreihe je Lager, gedrehtes Raster
python3 tests/test_raumlasten.py # Nutzung je Raum, Flächenbilanz, Trennwandzuschlag
python3 tests/test_stand.py     # Eingabe-Hash, Veraltung nach unten, Gesamtzustand
python3 tests/test_plan_svg.py  # Determinismus und Vollständigkeit des Geschossplans
python3 tests/test_submodell.py # Geschosskürzel, Feldordnung, Stabilität der Namen
```

`test_eingriffe.py` leiht sich für seinen letzten Teil den Prüfkörper von
`test_kette.py` und misst die Fortpflanzung an der Zahl, auf die es ankommt:
der Gründungslast.

### Der Geschossplan — automatisch, maßstäblich, deterministisch

Für jedes Submodell entsteht bei jeder Rechnung ein Plan (`ileen/plan_svg.py`).
Nicht auf Knopfdruck: wer ein Haus durchrechnet, will die Blätter, nicht die
Erinnerung daran, sie noch erzeugen zu müssen. Er kostet Millisekunden
gegenüber einer FE-Rechnung von Minuten, und scheitert er, geht der Lauf
trotzdem durch — die Zahlen sind gerechnet, nur das Blatt fehlt.

**Gezeichnet wird das Modell, nicht der IFC-Schnitt.** Das ist ein Unterschied:
das Modell enthält die tragenden Wände als Achsen, die Decke als Systemfläche,
die Lasten als Polygone mit Werten. Ein Plan aus dem Schnitt zeigte die
Wandquerschnitte und wäre schöner — er zeigte aber nicht, worauf die Zahlen
beruhen. Wo Rechnung und Bauwerk auseinanderlaufen, soll das Blatt die Rechnung
zeigen.

**Nur örtliche Lasten kommen ins Bild.** Ausbaulast und Trennwandzuschlag
liegen über der ganzen Systemfläche; als Schraffur decken sie den Grundriss zu
und sagen nichts, was die Legende nicht besser sagt — sie haben keinen Ort.
Gezeichnet wird, was einen hat: die Nutzlast je Raum, die Restfläche, jede Last
auf einem Teilbereich. Die Unterscheidung läuft über den Flächenanteil und
nicht über den Lastfall, damit eine örtliche Ausbaulast (ein Gründach über
einem Teil der Decke) ins Bild kommt.

**Linienlasten werden je Achse gebündelt.** Die Kette reicht je Lastfall eine
eigene Last weiter; drei Pfeilreihen auf derselben Wandachse sind im Bild nicht
zu unterscheiden. Auf dem Blatt steht die Summe, in der Legende die Lastfälle,
aus denen sie besteht.

**Der Eingabe-Hash steht im Kopf, und das ist kein Schmuck.** Ein ausgedruckter
Plan überlebt den Rechenstand, aus dem er stammt. Wer in einem halben Jahr ein
Blatt in der Hand hält, kann daran erkennen, ob es zu der Rechnung gehört, die
gerade gilt.

#### Determinismus

Gleiche Rechnung, gleiches SVG — Byte für Byte. Bedingung dafür, dass zwei
Stände vergleichbar sind: ein `diff` soll die Änderung zeigen und nicht die
Sortierung eines Wörterbuchs. Drei Regeln halten das:

1. **Kein Zeitstempel im Blatt.** Wann gerechnet wurde, steht am Rechenstand.
2. **Jede Liste wird sortiert** — nach einem Schlüssel aus der Geometrie, nicht
   nach `L7` oder `A3`; die zählen die Reihenfolge, in der `statikmodell()` die
   Einträge anlegt, und die hängt an der Reihenfolge der Räume.
3. **Zahlen werden gerundet**, bevor sie ins Markup gehen — auf zwei Stellen in
   Blattmillimetern, genauer als jeder Drucker auflöst.

Der Maßstab ist der **größte** passende aus 1:20 … 1:1000: ein Plan soll das
Blatt füllen. Bauteilnamen laufen durch `html.escape()` — sie kommen aus dem
IFC und sind fremder Text.

Geprüft in `tests/test_plan_svg.py` (52 Prüfungen): zweimal erzeugt bitgleich,
umgekehrte Eingabereihenfolge ändert nichts, andere Lagerkennungen ändern
nichts, kein Datum im Blatt — und eine geänderte Nutzlast ändert es sehr wohl.

    GET /assets/{job}/tragwerk/{lauf}/plan/{submodell}   der Plan als SVG

### Gilt die Zahl, die ich sehe, für das System, das ich sehe?

Die einzige wirklich gefährliche Frage dieses Werkzeugs. Ein Lastabtrag über
sechs Geschosse dauert Minuten bis eine halbe Stunde; in der Zwischenzeit ändert
jemand eine Deckendicke, hebt ein Auflager auf, setzt eine andere Nutzlast. Die
Zahlen auf dem Bildschirm gehören dann zu einem System, das es nicht mehr gibt —
und sie sehen genauso aus wie vorher.

Bis September 2026 antwortete darauf ein Merkmal `gerechnet.veraltet`, das
jemand setzen musste. `ileen/stand.py` antwortet mit einem **Eingabe-Hash**, und
der kann nicht vergessen werden.

**Was hineingeht:** Umriss, Öffnungen, Dicke, Bettung, Material, Auflager,
Lasten, Lastfälle, Unterzüge, Netzweite und die Eingriffe, die hier greifen.
**Was nicht:** Zeitstempel, Lauf-Kennungen, Bildlisten, Fortschrittstexte — und
die Reihenfolge der Listen.

Drei Feinheiten entscheiden darüber, ob der Hash brauchbar ist:

* **Listen werden sortiert.** Zwei Läufe über dasselbe IFC liefern die Auflager
  womöglich anders geordnet; die Reihenfolge hängt am Schnitt. Ein Hash darauf
  meldete bei jedem Lauf „geändert" — und eine Warnung, die immer erscheint,
  wird ignoriert.
* **Lagerkennungen bleiben draußen.** `A7` wird bei jedem Lauf neu vergeben.
* **Ganze und gebrochene Zahlen zählen gleich.** Ein Umriss aus dem IFC kommt
  als `[[0, 0], …]`, derselbe nach einer Geometrieoperation als
  `[[0.0, 0.0], …]`. `json.dumps` schreibt „0" und „0.0" — zwei Hashes für
  dieselbe Geometrie. Gerundet wird auf sechs Stellen (ein Mikrometer), und die
  Null wird vereinheitlicht, weil `round(-1e-12, 6)` ein `-0.0` liefert.

**Nur Eingriffe, die tatsächlich greifen, gehen ein.** Ein Eingriff ohne
Ortsangabe gilt überall, seine GlobalId kommt aber nur in einem Geschoss vor.
Nähme man ihn überall mit, veraltete ein Eingriff im ersten Obergeschoss auch
das zweite darüber. Was gegriffen hat, steht im Protokoll von
`eingriffe.anwenden()`.

#### Die Propagierung

    OG3   gültig      ← darüber, unberührt
    OG2   GEÄNDERT
    OG1   veraltet    ← weil OG2 anders abgibt
    EG    veraltet
    FUND  veraltet
    ────────────────
    Gesamtsystem veraltet

Nach oben läuft nichts: die Kette rechnet abwärts und kennt keine Rückkopplung.
`stand.propagiere()` sortiert nach `submodell.rang()` und markiert alles
unterhalb des obersten nicht-aktuellen Submodells mit — samt Begründung, welches
das war. `zu_rechnen()` macht daraus die Liste für eine **inkrementelle**
Neuberechnung: was aktuell ist, bleibt liegen.

**Eine Nebenrechnung veraltet nichts und veraltet nicht.** Ein Submodell, das
von Hand im Zeichenmodus angelegt wurde, steht neben der Kette. Ohne diese
Unterscheidung risse jede Nebenrechnung die ganze Gesamtstatik in den Zustand
„veraltet".

#### Der Fehler, den das Kriterium gefunden hat

Die Prüfung der Veraltung an echten Kettenhashes (`test_kette.py` Abschnitt 10)
hat einen Fehler aufgedeckt, den keine der bestehenden Proben zeigte: **die
Bodenplatte bekam gar keine Last von oben.** `letztes = (i == len(geschosse)-1)`
ließ das unterste Geschoss seine Fußkräfte als Gründungslasten buchen statt sie
weiterzureichen, und die Bodenplatte wurde mit ihrem Eigengewicht allein
gerechnet.

Es fiel nicht auf, weil eine gebettete Platte auch ohne Auflast ein plausibles
Ergebnis liefert — Durchbiegung, Momente, Sohlspannung, alles im erwarteten
Bereich, nur um den Faktor sechs zu klein. `bodenplatte()` wird deshalb jetzt
**vor** der Geschossschleife gesucht: sie entscheidet, ob das unterste Geschoss
die Kette schließt.

### Systembildung an Prüfhäusern geprüft *(2026-10-26)*

Fünf kleine Häuser mit bekannter Lösung (Massivbau, Mehrschichtwand mit
Treppenauge, Skelett mit Flachdecken, Unterzug, Holzbalkendecke), jedes auch um
33° gedreht, dazu Weihgold LPH 4 (Holzbau auf Beton-KG). Werkstatt, Skripte und
die Liste aller Befunde (B1–B39): `projekte/2026_1026_statik_systembildung/`
(`BEFUNDE.md`; `skripte/kette_lokal.py` rechnet die Kette ohne Server,
`haeuser.py [--drehung 33]` baut die Prüfhäuser, `netzstudie.py` vergleicht mit
Navier, `bild_platte.py` zeichnet System und Durchbiegung). Ergebnis: alle
Bilanzen erhalten, gedreht = ungedreht bis auf die letzte Stelle, Holzbalkendecke
H5 9,57 mm gegen 9,6 mm Balkentheorie.

#### Das Raster liegt auf den Lagerachsen

Ein Lager fing früher alle Knoten im Suchradius 0,6 Δ — je nachdem, wo die
Wandachse zwischen zwei Knotenreihen fiel, eine Reihe oder zwei. Zwei Reihen
halten die Decke wie eine Teileinspannung. Am Flachdach H1 (9,76 × 7,76 m) kam
bei Δ = 0,10 m 94 % der Navier-Durchbiegung heraus, bei Δ = 0,08 m 35 % und das
halbe Moment, und die Lastaufteilung auf die Wände kippte — dieselbe Decke,
eine andere Netzweite.

* `plate._rasterlinien()` legt Rasterlinien auf achsparallele Lagerachsen,
  Punktlager, Umriss- und Öffnungskanten und Unterzugflanken (Rang bei weniger
  als max(2 cm, 0,05 Δ) Abstand: Hülle, Rand, Lager, Balken), dazwischen
  gleichmäßig aufgefüllt (5 % Übermaß je Zelle). Die Zellen sind dadurch
  ungleich breit; alles, was Flächen braucht, rechnet mit `zellflaechen()`,
  `auf_raster()` fällt bei ungleichem Raster auf die nächste Elementmitte zurück.
* `plate.lagerknoten()` ist die eine Stelle, an der ein Lager seine Knoten
  wählt — `randbedingungen()` und `auflagerbilanz()` benutzen sie gemeinsam:
  je Rasterspalte die nächste Knotenreihe, nie zwei. Gefangen wird bis
  max(0,6 Δ, ½·`breite_m` + 2 cm).
* **`breite_m` am Lager** (`tragwerksmodell.statikmodell`: Wand = tragende
  Schicht, Stütze = √A). Eine Decke, die an der Innenseite einer Wand endet,
  liegt auf ihr; ohne die Breite hing die Decke über dem KG der LPH 4 bei
  Δ = 0,25 m frei (140 mm), bei 0,5 m nicht. Die Breite steht im Eingabe-Hash —
  Stände von vor dieser Änderung gelten als veraltet.

#### Das Raster dreht mit dem Gebäude

Das Projektsystem eines IFC folgt oft dem Lageplan (EFH Weihgold: 33°). Ein
Raster in Weltachsen hatte dann keine Lagerlinie, jede Wand wurde eine
Zickzackreihe, der Rand eine Treppe: H1 gedreht gab die halbe Durchbiegung.
`plate.hauptrichtung()` bestimmt die Richtung aus Umriss und Lagerachsen
(längengewichtet, auf 90° gefaltet), `vernetze()` rastert gedreht, die Knoten
stehen in Weltkoordinaten (`Netz.drehung`, `Netz.lokal()`).

* **Momente und Querkräfte in Gebäudeachsen**: `spannungen(im_raster=True)`
  in `schnittgroessen()` und `querkraefte()`; m_x ist dann das Moment in
  Richtung x', die Bewehrung a_sx liegt parallel dazu. Orte (`xy`) bleiben
  Weltkoordinaten. `hauptmomente()` liefert φ gegen x'; zum Zeichnen wird die
  Drehung addiert. `querkraefte_aus_momenten()` leitet im Rastersystem ab.
  Schnitte (Staffelung, Momentenschnitte) laufen über `plate.rasterlinie()`.
* `unterzug.py` arbeitet im Rastersystem (`finde`, Streifen, Durchbiegung,
  Lager, b_eff) — ein Unterzug in Gebäudeachse ist dort achsparallel und wird
  bemessen.
* Die Scheibe (`scheibe.py`) rechnet weiter in Weltachsen, mit ihrem eigenen
  Suchradius; ihre Membrankräfte gehen über `plate.huelle_ins_raster()` in
  die Biegebemessung.

#### Was auf einem Lager steht, geht direkt hinein

Eine Wand des OG über der Wand des EG gibt ihre Last durch die Deckendicke
weiter, die Decke biegt sich dabei nicht. Im Netz lag sie als Streifenlast auf
Knoten bis eine Netzweite neben dem Lager — bei einer Holzbalkendecke
(quer weich) bog die Giebelwand des OG die Decke um 18 mm durch.
`kette.durchleiten()` nimmt, nach den Eingriffen, aus jeder Linien- und
Einzellast heraus, was innerhalb der tragenden Breite eines Lagers steht
(ohne Überstand über das Wandende, Stummel unter 5 cm mit), und legt es unter
`modell["durchleitung"]`; der Rest bleibt Last auf der Platte (Tür, versetzte
Wand, Abfangung). `durchleitung_buchen()` schlägt es nach der Rechnung je
Lastfall auf `auflager_lastfallweise` — auch für Lastfälle, die die Platte gar
nicht mehr sieht. Steht im Eingabe-Hash und im Geschossplan („… kN/m direkt").

#### Holzbalkendecken als orthotrope Ersatzplatte

Eine Holzbalkendecke ist keine IfcSlab; früher fehlte ihr Geschoss ganz.
`kette.balkenlagen()` erkennt eine Lage (≥ 4 liegende, schlanke,
gleichgerichtete Balken mit gleicher Oberkante unter dem Boden darüber) und
macht daraus eine Platte `balkenlage:<Geschoss>:<n>`; `ersatzplatte_werkstoff()`
rechnet sie orthotrop (längs E₀·b/e, quer /50, Rollschub und Drillung /10,
**senkrecht steif** — sonst drückte eine Wand von oben die Ersatzplatte über
dem Lager zusammen), das Eigengewicht ist gemessen (Volumen × Wichte der
Deckenzone), Nicht-Holz in der Zone wird Ausbaulast aus dem Modell.

* **Richtung, Länge, Breite aus `section.bauteilform()`** (Grundrissrechteck
  je Bauteil, Cache `{job}.form2.json`, ersetzt `volumen1`) — die Hüllbox
  eines Balkens unter 33° ist nicht schlank.
* **Randbalken und Wechsel gehören dazu** (Balken auf Lagenhöhe ab 0,3 m, die
  an einen Kern mit ≥ 4 Lagenbalken anschließen): an der LPH 4 enden die
  Balken 3,4 cm vor der Betonwand am Randbalken; ohne ihn lag das Lager neben
  der Platte, das Treppenloch war 30 % zu groß und schnitt den Unterzug.
* **Querweitung nur bis an ein Lager**: Streifen von der Lage bis zu einer
  Wand oder Stütze höchstens e/2 + 0,6 m daneben, beschnitten auf den Bereich
  quer neben der Lage. Die pauschale Weitung auf die Hülle aller Stützen zog
  die Decke über Terrassenpfosten hinaus.
* **Zonen mit eigener Balkenrichtung** (≥ 3 gleichgerichtete Quer- oder
  Stichbalken außerhalb des Kerns, breiter als 0,3 m): `plate.werkstofftabelle()`
  dreht dort den Werkstoff. Grenze: eine Auskragung ohne modellierte
  Rückverankerung hält am Ansatz nur über die Querrichtung.

#### Bauteile aus Teilen, Profile als Proxy

ArchiCAD schreibt mehrschichtige Wände, Decken und zusammengesetzte Stützen
als Bauteil **ohne eigenen Körper**; die Geometrie steckt in
`IfcBuildingElementPart` (`IfcRelAggregates`). Für die Kette waren das
„sonstiges" — an Lucy (Holzhaus auf Schraubfundamenten) fand keine Decke ein
Lager, weil jedes Schraubfundament eine `IfcColumn` aus vier Teilen ist.

* `section.bauteil_eltern()` (ohne Geometrie, Cache `{job}.eltern1.json`)
  liefert Teil → Elternbauteil; `kette.Zugang(eltern=…)` fasst im Verzeichnis
  zusammen (Box vereinigt, Volumen summiert, je Teil eine Materialschicht —
  bei Wänden mit der Breite des Teils als Dicke) und hüllt den Schnitt ein
  (alle Ringe der Teile in einer Figur, wie eine Mehrschichtwand).
* **Eine Decke aus Balkenteilen ist eine Balkenlage**: besteht eine IfcSlab
  aus ≥ 4 Teilen, davon vier Fünftel liegende schlanke Stäbe (Lucys Dach,
  256 Balken 12/24), bleiben die Teile einzeln und gelten als `IfcBeam`.
* **Stahlprofile als Proxy** (`IfcBuildingElementProxy` „HEA 240", IPE …):
  liegend `IfcBeam`, stehend `IfcColumn` (`_profile_deuten`, der ursprüngliche
  Typ bleibt unter `ifc_type_quelle`).

#### Lasten ohne Decke, Füße auf dem Gelände

* `kette._direkt_auf_lager()`: eine Last von oben, die auf keine Platte fällt,
  aber auf einer tragenden Wand oder Stütze dieses Geschosses steht, wird ihr
  gebucht (`quelle_art = "direkt"`) und an ihrem Fuß weitergegeben — in
  Geschossen mit und ohne Decke.
* `kette._auf_dem_gelaende()`: was am Ende der Kette offen ist und der Fuß
  eines Bauteils, das bis ins unterste Geschoss reicht, steht auf dem Gelände
  ohne modelliertes Fundament (Lucys Carportstützen, 656 kN). Es geht unter
  `gruendung.ohne_fundament` in die Gründung. Offen bleiben Lasten über einem
  nicht gerechneten Feld (beim Durchreichen markiert, `ueber_nicht_gerechnet`)
  und Füße, die höher enden — sie hängen in der Luft.
* Balkenlagen werden auch neben Plattendecken gesucht (Haus mit Balkendach,
  Carport mit Betondach) und dürfen bis 30 cm über die Geschosslinie
  hinausragen (Lucys Dachlage lag 26 cm über „Dachaufsicht" und fehlte ganz).
  Streifen unter 0,3 m Breite (ein Randbalken über einer Lücke) gehören nicht
  in den Umriss.

#### Kinematisch, ohne dass der Löser es merkt

Eine Platte auf einer einzigen Lagerreihe hat eine singuläre Matrix; der
direkte Löser liefert dann w = 10¹² mm und Reaktionen, die ein Achtel der Last
tragen. Die Gleichgewichtsprobe sah es (112 %), gefragt wurde sie nicht.
`kette.PROBE_GRENZE` (10⁻³): darüber gilt das Feld als nicht gerechnet, die
Lasten von oben gehen durch, seine eigene Last steht als Fehlbetrag in der
Bilanz.

#### Netzweite: HEX8 sperrt

Mit Δ/h > 1 versteift HEX8 (`_netzguete` warnt): Flachdach H1 gegen Navier bei
Δ = 0,5/0,25/0,125/0,10/0,08 m → 44/74/89/92/93 % der Durchbiegung, gleichmäßig
steigend. Der Betrieb rechnet mit Δ = h/2. Für die Lastaufteilung reicht
0,25 m (6 % daneben), 0,5 m nicht (20 %).

#### Geschosse aus Decken und Balkenlagen (Modelle ohne IfcBuildingStorey)

Tragwerksmodelle (Weihgold VA3) führen keine Geschosse. `geschosse_aus_decken()`
bündelt die Oberkanten der Decken **und der Holzbalkenlagen**
(`_balkenebenen()`: ≥ 4 Balken gleicher Oberkante, nebeneinander ≤ 1,5 m und
längs überlappend — Schwellen und Rähme fallen damit heraus). Unter der
untersten und über der obersten Ebene beginnt ein Geschoss erst ab
`MIN_TRAEGER_GESCHOSS` = 3 Wänden/Stützen, die bis an die Ebene reichen: eine
Stützmauer am Hang allein machte sonst die Bodenplatte zur Decke über einem
„Erdgeschoss". Abgeleitete Geschosse tragen `abgeleitet: True`; bei ihnen gilt
als lichte Mindesthöhe die halbe Geschosshöhe (`_lichte_mindesthoehe`) — sonst
fände die Dachlage über einem 0,68 m hohen Pfostengeschoss keine Decke. Der
Wandschnitt liegt in niedrigen Geschossen höchstens auf halber Höhe
(`_wandschnitt_ueber_boden`), sonst lief er über die Stiele unter Rähm und
Pfette. `bodenplatte()` behält `IfcFooting` unabhängig von der Fläche. VA3:
94 % Fehlbetrag → 0,03 %.

#### Die Decke liegt auf der Wandkrone

Querschnitt, Länge und Nachweis einer Wand kommen aus dem Schnitt in
Brüstungshöhe (0,4–1,2 m); dort hat sie an jedem Fenster eine Lücke. Die
**Lagerlinie** kommt seit 2026-10-26 aus dem Schnitt 4 cm unter der Platte
(`kette._kronenschnitt`, derselbe wie für die Unterzüge;
`statikmodell(kronen=…)`): über einem Fenster trägt der Sturz, über einer
raumhohen Öffnung nicht. Genommen wird die Krone nur, wo ihre Achse länger ist
(`protokoll.lager_ueber_sturz`, Hinweis im Modell). Dabei aufgefallen:
`auflagerlinien()` brach Kantenzüge an kollinearen Zwischenpunkten ab (ein
Kronenring hat einen Punkt an jeder Fensterkante darunter) — die Achse wurde
ein Stück der Wand, an der falschen Fläche. `_ring_vereinfachen()` entfernt
sie vorher; auch die Pfeiler im Brüstungsschnitt werden dadurch richtig lang
(SampleHouse Ostwand 3,72 → 5,80 m).

#### Ständer gehören zu ihrer Wand

Holzbau-Berechnungsmodelle führen die Ständer einer Holzständerwand als eigene
`IfcColumn` neben der Wand (VA3: 214 Ständer). Trägt die Wand selbst, lag die
Decke doppelt: auf der Wandachse und auf jedem Ständer (19 von 81 Lagern hoben
ab). `tragwerksmodell.staender_in_waenden()`: Holz- oder Stahlstützen bis
0,06 m², deren Schwerpunkt im Querschnitt einer tragenden Wand liegt, mindestens
zwei je Wand — kein eigenes Lager; ihr Gewicht (Volumen im Geschoss × Wichte)
geht als `staender_kN` an die Wand. Eine einzelne Stütze in einer Wand bleibt
ein Punktlager.

#### Freie Plattenränder

`freie_raender()` misst den Außenrand des Systemumrisses ohne Lager oder
Unterzug (halbe Bauteilbreite + 0,60 m — die Decke reicht bis an die Außenfläche des Wandaufbaus). Ab 2 m wird gemeldet („Auskragung,
oder fehlt dort ein Lager?"); Ränder zwischen zwei Stützen erst ab 8 m
(Flachdecke). Steht in `protokoll.freie_raender` und im Kurzbericht
(`freier_rand_m`). Anlass: das SampleHouse hat über der Pfosten-Riegel-Fassade
keinen Träger, die Ecke kragt 9,8 m Randlänge frei aus (56 mm) — richtig
gerechnet, aber nirgends gesagt.

#### Das Kassenbuch des Lastflusses (`lastfluss`)

Die Erhaltungsprobe prüft das ganze Haus; ob jedes **Geschoss** aufgeht und
wohin die Last darin geht, sagt sie nicht. `_geschossbuch()` führt deshalb je
Geschoss ein Kassenbuch nach Art (G/Q, nicht nach Lastfall — die Wandlasten von
oben heißen auf der Platte darunter `ABG`): hinein von oben, neu auf den
Platten (`eingetragen_je_fall_kN`), Eigengewicht der Wände und Stützen; hinaus
nach unten und in die Gründung. Der Rest muss null sein, sonst steht
„Lastfluss …: das Geschoss geht nicht auf" in den Hinweisen. `lastfluss_text()`
schreibt daraus in Sätzen, wie die Last fließt (je Platte: von oben, davon
direkt durch die Decke, neu je Fall, an welche Bauteile die Lager abgeben).
Ergebnis unter `lastfluss` (`geschosse`, `gelaende_kN`, `nicht_abgesetzt_kN`,
`text`); `kette_lokal.py` druckt den Text.

Was das Kassenbuch an Lucy gefunden hat, sah keine andere Probe:

* **Die Dachbalkenlagen wogen nichts.** Die Wägung der Deckenzone endete an
  der Geschosslinie + 5 cm, Lucys Lage liegt 26 cm darüber — ihre eigenen
  Balken fielen heraus, und kein Konto fing sie auf (fehlt auf beiden Seiten
  der Erhaltungsprobe). Jetzt endet die Zone über der Lage, die Balken der
  Lage zählen immer: +145 kN.
* **Eine Ersatzplatte mit Wichte 0 verlor das Gewicht ihrer Unterzüge** — das
  Netz führte das Stegeigengewicht als Beiwert auf die Plattenwichte. Jetzt
  `Netz.eg_wichte`: absolute Wichte je Zelle.
* **Kreuzende Unterzüge:** eine Spalte gehört dem tieferen, der flachere
  verlor dort sein Gewicht (Lucys UG, 141 Holzbalken: 2,4 kN). Jetzt wird das
  Gewicht jedes Stegs auf die Zellen gelegt, die ihm gehören.
* **Das Netz trug am runden Rand nicht die Last der Figur** (Zellen mit
  Mittelpunkt im Umriss: ±0,2–0,4 %). `tm.lastflaechen_festhalten()` schreibt
  an jede Flächenlast ihre wahre Fläche auf der Platte (`flaeche_m2`, nicht im
  Eingabe-Hash), `plate._anteile()` rechnet daraus die Intensität wie bei
  Linienlasten, und `vernetze()` legt die Plattenwichte auf die Figurfläche um
  (nur bei ±10 %; grobe Abweichungen bleiben sichtbar).

#### Steildächer: Sparren und Pfetten (`ileen/dach.py`)

Bis Oktober 2026 kannte die Kette Dächer nur als Platten. Ein Pfettendach
stand im Bericht als „was darauf liegt, steht nicht im Modell der Kette", und
sein Gewicht fehlte bis in die Gründung. `dach.dachlasten()` rechnet es jetzt
aus den Stäben selbst:

* **Stäbe aus `section.bauteilform()`**: die 3D-Stabachse (`achse`,
  `querschnitt_m`; SVD über die Netzpunkte, Cache `{job}.form3.json`). Sparren
  sind Stäbe mit 10–75° Neigung, Träger (Pfetten, Wechsel) liegen ≤ 5°.
* **Lasten je Sparren** über seine Einzugsbreite (am Rand halber Abstand +
  halbe Breite): Eigengewicht aus Volumen × Wichte, Dachaufbau
  `steildach_aufbau_kNm2` (Vorgabe 1,0 kN/m² **Dachfläche**), Schnee
  μ₁(α)·s_k (`schnee_sk_kNm2`, Vorgabe 0,85) über die **Grundfläche**.
  Lastfälle `EG`/`AUS` ständig, `S` veränderlich.
* **Jeder Stab ist ein Durchlaufträger** (`durchlauftraeger()`, Euler–Bernoulli,
  Kragarme erlaubt) auf den Lagern, die die Geometrie hergibt: Wand, Stütze
  oder liegender Träger unter der Stabunterkante (±10 cm). Durchgehende
  Auflage (Fußpfette auf dem Kniestock) alle 0,50 m. Träger werden von oben
  nach unten gerechnet, sobald alles auf ihnen liegt. Knoten auf ganze
  Millimeter (gedreht trafen die Sparren beider Seiten die Firstpfette 5 µm
  auseinander — ein 5-µm-Element machte die Matrix unlösbar schlecht, die Lager
  trugen ein Siebtel der Last), und jeder Träger prüft sein Gleichgewicht.
* **In der Kette** (`kette._steildaecher()`): ein Sparren gehört zu dem
  Geschoss, in dem sein unteres Ende liegt. Seine Lasten sind dort **neu**
  (Erhaltungsprobe, Kassenbuch `steildach`): im Geschoss ohne Decke gehen sie
  über `_direkt_auf_lager` in Kniestock, Stiele und Traufwände; was kein
  Bauteil fängt, fällt auf die Decke darunter. Im Geschoss mit Decke liegt,
  was über der Decke ankommt, auf den Platten, der Rest auf den Wänden.
  Balken einer Balkenlage zählen nicht mit.
* **Kniestock**: im Geschoss ohne Decke ein zweiter Wandschnitt 0,30 m über der
  Oberkante der Decke darunter (nicht über der Geschosslinie: Lucys Dachlage
  liegt darüber, der Schnitt traf sonst die durchlaufenden Stützen), und nur,
  was auf ihr steht — unter dem Brüstungsschnitt fehlten niedrige Bauteile ganz.
* **Dach oder Decke** entscheiden nur Bauteile ab 1,20 m Höhe: eine Attika,
  ein Kniestock, eine PV-Aufständerung machen kein Dach zur Decke (zwei von
  Lucys Modulen liefen deshalb mit Nutzlast statt Dachlast).
* **Stiel auf dem Kniestock** (`_im_geschoss_stapeln()`): ein Fuß, der im
  Geschoss auf der Oberkante eines anderen Bauteils endet, geht in dieses.
* **Trefferwahl** in `_direkt_auf_lager`: das Bauteil, auf das die Last zeigt,
  vor der Stütze, vor der Wand, dann der Abstand. Nach dem Schwerpunkt allein
  gewann der Giebel-Kniestock gegen den Stiel auf seiner Mitte.
* **Eine Platte unter einem Steildach ist kein Dach** (`_unter_steildach`):
  Aufbau und Schnee trägt das Dach; sonst stünden sie zweimal darin.

Prüfhaus H6 (Pfettendach, Kniestock 0,5 m, Firstpfette auf drei Stielen):
gerade und um 33° gedreht 174,7 kN Dach (Aufbau 117,5, Schnee 40,8 wie das
Soll), Traufwände je 51,2 kN, Mittelstiel 43,6 kN (Zweifeldträger 10/16),
Giebelstiele je 14,3 kN in den Giebel-Kniestock. Prüfstein:
`python3 tests/test_dach.py`.

Grenzen: Sparrendach ohne Pfetten (Horizontalschub am Fuß), Kehlbalken,
Wind und Abheben, Gratsparren und Walme sind nicht gerechnet; ein Sparren
ohne Lager gibt seine Last an seiner Mitte ab und wird gemeldet.

#### Wichten

`schichtwichte("Ortbeton - bewehrt Verputzt")` war 18 (Putz griff vor Beton) —
„verputzt" nennt die Oberfläche, nicht den Körper. Ein Bauteil ohne erkannten
Werkstoff, aber mit Schichtaufbau, wiegt mit dessen mittlerer Wichte
(`lastabtrag.mittlere_schichtwichte`), nicht mit 25 kN/m³ — auch wenn sein
Schnitt nicht zur Schichtsumme passt (Wandenden von Holzständerwänden).

### Vorbemessung, nicht Nachweis

Die Auflager entstehen aus Wandquerschnitten, nicht aus einem Tragwerksmodell.
Mit `nur_tragende` bleiben Wände draußen, die im IFC ausdrücklich als
nichttragend geführt sind (`Pset_WallCommon.LoadBearing`) — bei Modellen ohne
dieses Pset ändert das nichts, und der Unterschied zwischen „nichttragend" und
„nicht angegeben" bleibt im Ergebnis sichtbar. Horizontallasten werden nicht
über die Geschosse summiert, die Gründung nicht nachgewiesen.

## Bauteile räumlich — Volumenmodell aus der Auswahl im Viewer

`plate.py` rechnet Decken, `lastabtrag.py` das ganze Haus. Beides idealisiert:
eine Decke ist eine Fläche, eine Wand ein Querschnitt. Für die Frage „wie
verteilt sich die Beanspruchung **im** Bauteil" reicht das nicht — und genau
die stellt man bei einem Holzbalken mit Ausklinkung, einem Stahlträger mit
Aussparung oder einem Unterzug, der auf einer Stütze aufliegt.

Der Weg dorthin ist der kürzeste denkbare: **im Viewer Bauteile anklicken,
rechnen lassen, das Ergebnis liegt als Punktwolke im Bauteil.**

    Auswahl im Viewer ──▶ IFC-Geometrie ──▶ Voxelnetz ──▶ Löser ──▶ Wolke
      (GlobalIds)          volumen_ifc      volumen      loeser    volumenwolke

| Modul | Aufgabe |
|---|---|
| `ileen/werkstoff.py`   | Beton, Holz, Stahl als 6×6-Steifigkeitsmatrix, Spannungsnachweis |
| `ileen/volumen.py`     | Voxelnetz, Auflager, Lasten, Auswertung, Schnittgrößen |
| `ileen/volumen_ifc.py` | Bauteile aus dem IFC, Werkstoff aus dem Materialnamen |
| `tiling/volumenwolke.py` | PNTS mit **allen** Werten je Punkt (Batch-Table) |
| `api/routes/volumen.py`  | die Endpunkte, Lauf im Hintergrund, Wolke beim Abruf |
| `frontend/volumen-panel.js` | Mehrfachauswahl, Werkstoffwahl, Ergebnis |
| `frontend/volumen-ergebnisse.js` | Legende und Klick auf den Punkt |

### Holz ist der Grund für den ganzen Aufwand

Beton und Stahl sind isotrop; für sie genügen E und ν, und der Löser konnte
das schon. Holz nicht: längs zur Faser ist Fichte rund 11 000 N/mm² steif,
quer dazu 370 — Faktor 30. Deshalb führt `werkstoff.py` die Steifigkeit als
volle Matrix in Voigt-Notation und dreht sie in die Faserrichtung des
Bauteils; `loeser.ElastischHeterogen` nimmt sie **elementweise** entgegen.

Übergeben wird dabei nicht die Matrix je Element, sondern ein Index in eine
kleine Tabelle. Ein Bauwerk hat keine 100 000 Werkstoffe, sondern drei — als
interne Variable je Quadraturpunkt wären die 36 Einträge sonst 230 MB, die
durch jeden JIT-Aufruf wandern.

Der bisherige isotrope Pfad ist unverändert: `Loeser(netz, E, nu, bc)` baut
weiter `Elastisch`, `Loeser(netz, bc_info=…, C_tabelle=…, material=…)` den
neuen. Beide liefern beim isotropen Stoff dieselbe Lösung (Prüfung in
`tests/test_volumen.py`, relativ 1e-9).

### Warum Voxel und nicht Tetraeder

Weil damit **mehrere Bauteile ohne Kontaktalgorithmus zu einem System
werden**: alle liegen auf demselben Raster, ihre Knoten fallen an den
Berührflächen von selbst zusammen. Ein Balken auf einer Stütze ist verbunden,
ohne dass irgendwo eine Kopplungsbedingung steht. Der Preis: die Verbindung
ist starr und voll — ein aufgelegter Balken, der abheben könnte, wird
festgehalten, ein Zapfen überträgt Moment.

Das Raster ist an der Zellgröße ausgerichtet, nicht an der Auswahl. Sonst
verschöbe sich das ganze Netz, sobald ein weiteres Bauteil dazukommt, und mit
ihm jede Elementnummer und jeder Punkt der Wolke; zwei Läufe wären nicht mehr
vergleichbar.

`zusammenhang()` meldet vor dem Lösen, wenn die Auswahl in mehrere Teile
zerfällt. Ohne das bekäme man bei zwei sich nicht berührenden Bauteilen eine
singuläre Matrix und als Auskunft Zahlensalat.

### Die Auflagerbreite ist die teuerste Falle

Ein aufgelegtes Lager ist **eine Knotenreihe breit**. Eine breitere
Auflagerfläche wirkt am Volumenmodell nicht wie ein größeres Lager, sondern
wie eine Teileinspannung: die gehaltene Unterkante muss über die ganze Länge
gerade bleiben. Am Einfeldträger 5,0 m mit 20/40 cm gemessen:

| Lagerbreite | Durchbiegung | Feldmoment |
|---|---|---|
| eine Knotenreihe | 100 % | 99 % |
| 5 cm  | 79 % | 84 % |
| 10 cm | 58 % | 66 % |
| 20 cm | 32 % | 44 % |

Zehn Zentimeter — auf dem Papier eine Selbstverständlichkeit — kosten ein
Drittel des Feldmoments, auf der **unsicheren** Seite und völlig unauffällig:
die Biegelinie bleibt glatt, das Gleichgewicht stimmt, die Auflagerkräfte
stimmen. Wer eine echte Auflagerbank abbilden will, nimmt ein zweites Bauteil
darunter, kein breiteres Dirichlet-Lager.

### Steht es oder liegt es?

`auflager_automatisch()` entscheidet, ob die Fußpunkte gehalten werden (Wand,
Stütze, Geschossausschnitt) oder die Enden (Balken, Sparren). Die naheliegende
Regel — „höher als breit, also steht es" — greift bei **beiden** Fällen
daneben, die man wirklich hat: ein Balken 20/50 ist höher als das Doppelte
seiner Breite und liegt, ein Ausschnitt aus zwei Wänden und einer Decke ist
viel breiter als hoch und steht.

Entschieden wird deshalb über den **belegten Boden**: wie viele Rasterspalten
haben ihre tiefste Zelle ganz unten? Bei einem liegenden Balken alle, bei
einem Geschossausschnitt nur die über den Wänden und Stützen — darüber ist
Luft. Unter 50 % heißt „steht". Dazu der einfache Fall: ist die längste Achse
die Hochachse, steht es ohnehin.

Der gewählte Grund steht im Lagernamen und damit im Bericht
(`Fußpunkte (nur 10 % der Grundfläche sind unten belegt)`) — eine angenommene
Lagerung, die sich nicht zu erkennen gibt, ist die gefährlichste Annahme im
ganzen Modell.

### Momente an den Gauß-Punkten, Querkräfte in der Elementmitte

`schnittgroessen()` integriert das Spannungsfeld zu N, V und M — die Brücke
vom Kontinuum zurück zum Stabwerk, mit dem EC2, EC3 und EC5 nachweisen.
Ausgewertet wird an den 2×2×2-Gauß-Punkten, und zwar aus zwei
gegenläufigen Gründen:

* **Für M** ist die Mittelpunktsregel zu ungenau. Sie unterschlägt je Zelle
  den Anteil h²/12 des Hebelarms; am Kragarm mit sechs Lagen über die Höhe
  waren das 6,5 % — alle in dieselbe Richtung, das Moment zu klein. Die
  2-Punkt-Gauß-Formel integriert den quadratischen Integranden exakt.
* **Für V** sind die Gauß-Punkte einzeln unbrauchbar. Die parasitäre
  Schubverzerrung des HEX8 wechselt zwischen den beiden Ebenen das Vorzeichen:
  einzeln ausgewertet springt die Querkraft zwischen +4 und −25 kN, wo −10
  stehen müsste.

Deshalb: **eine Station je Zellreihe, über beide Gauß-Ebenen gemittelt.** Dann
stimmen beide — dieselbe Eigenschaft, die die Elementmitte zum Barlow-Punkt
macht.

### Die Wolke trägt ihre Werte selbst

`tiling/volumenwolke.py` schreibt in die Batch-Table der PNTS-Kachel **jede**
gerechnete Größe je Punkt: Durchbiegung, alle sechs Spannungskomponenten,
Hauptspannungen, Vergleichsspannung, Ausnutzung, jeden Teilnachweis und die
Bauteilnummer. Ein Klick im Viewer liest sie direkt aus der Kachel — kein
Netzweg, und es funktioniert auch dann noch, wenn die Rechnung im Backend
gelöscht ist. Zahlen binär als `float32`, Text als Index in eine Tabelle in
der `skala.json`: ein Bauteilname wiederholt sich über zehntausend Punkte.

**`BATCH_ID` je Punkt ist dabei nicht Formsache, sondern die Bedingung.** Die
Spezifikation kennt für PNTS auch „per-point properties" ohne Batch-Zuordnung,
und die sind hier das Naheliegende — jeder Punkt ist ohnehin sein eigenes
Ding. Im Viewer bleibt das Ergebnis dann aber **stumm**: CesiumJS legt ohne
`BATCH_LENGTH` gar keine Features an (`content.featuresLength === 0`), die
Werte sind dort nur für Stilausdrücke da, und ein Klick findet nichts, woran
`getProperty()` ansetzen könnte. Am fertigen Tileset nachgemessen, nicht aus
der Spezifikation geschlossen. Der Preis ist gering: die Feature-Objekte
entstehen erst beim Zugriff, dauerhaft belegt wird nur die Nummer je Punkt.

Gefärbt wird nach *einem* Feld, gewählt beim Abruf; alle anderen fahren mit.
Deshalb legt der Lauf nur die `punkte.npz` ab, und jede Wolke entsteht beim
ersten Abruf daraus — zwanzig Größen im Voraus zu tilen hieße, neunzehn
umsonst zu erzeugen.

### Was hier nicht gerechnet wird

Linear-elastisch, ein Werkstoffgesetz ohne Reißen, Fließen und Kriechen. Die
Ausnutzung ist ein Spannungsvergleich, kein Traglastnachweis; beim Beton ist
die Hauptzugspannung ein Hinweis, *wo* Bewehrung hin muss, und bemessen wird
weiter mit `beton.py`. Keine Stabilität (Knicken, Kippen, Beulen), keine
Kontaktbedingungen, keine Vorspannung. Der Treppenrand des Voxelnetzes
erzeugt an einspringenden Ecken Spannungsspitzen, die es im Bauteil nicht
gibt — deshalb weist `ausnutzung()` neben dem Maximum immer auch das
98-%-Quantil aus.

## Energie — die GEG-Bilanz des ganzen Gebäudes

Das Gegenstück zur Statik: dort wird eine Decke gerechnet, hier das Bauwerk als
Ganzes. `ileen/energie.py` nimmt eine Liste von Hüllflächen mit U-Werten und
liefert Jahres-Primärenergiebedarf, spezifischen Transmissionswärmeverlust und
beide Nachweise gegen das Referenzgebäude nach GEG Anlage 1.

```
POST   /assets/{job_id}/energie                     rechnen → Bericht
GET    /assets/{job_id}/energie                      alle Bilanzen dieses Modells
GET    /assets/{job_id}/energie/{result_id}          Bericht und Bildliste
GET    /assets/{job_id}/energie/{result_id}/bild/{n} ein Bild als PNG
DELETE /assets/{job_id}/energie/{result_id}
GET    /assets/{job_id}/energie-huelle               Hüllflächen aus dem IFC
GET    /assets/{job_id}/energie-geometrie            Volumen und Fläche aus dem IFC
GET    /energie/katalog                              Erzeuger, Träger, Bauteilarten
```

### Vorbemessung, nicht Nachweis — und wie das Verhältnis zu GEG-Nachweis ist

**Dies ist ausdrücklich eine Vorbemessung.** Für den prüffähigen Nachweis gibt
es im Werkstattbestand ein eigenes Projekt: `~/Projekte/GEG-Nachweis`, der
Web-Nachbau der MoBi-Excel der Uni Kassel — Monatsbilanz mit Anlagenbewertung
nach **DIN V 4701-10** im Tabellenverfahren, gegen ebendiese Excel validiert
(58 Tests), Schichtaufbauten nach ISO 6946 mit 565-Stoff-Datenbank, IFC-Import
samt Orientierung aus der Geometrie, Druckbericht in Fachberichtsform und
Energieausweis im Anlage-10-Layout.

Zwei Rechenwege nebeneinander sind nur vertretbar, solange klar ist, welcher
welche Frage beantwortet:

| | `ileen/energie.py` | `~/Projekte/GEG-Nachweis` |
|---|---|---|
| Frage | Wie steht dieser Entwurf da? | Hält das Gebäude den Nachweis? |
| Anlagentechnik | pauschale Aufwandszahlen | DIN V 4701-10, Musteranlagen |
| Validierung | Kreuzprobe der Bilanz von Hand | gegen die MoBi-Excel, exakt |
| Orientierung | aus der Bauteil-Hüllbox, achsparallel | aus der Geometrie |
| Ergebnis | Einordnung in Minuten | prüffähige Unterlage |

Deshalb trägt **jeder** Bericht die Felder `einordnung: "VORBEMESSUNG"` und
`einordnung_text`. Sie stehen an den Zahlen und nicht nur in der Oberfläche:
eine Kennwerttabelle wird herauskopiert, ein Bildschirmhinweis nicht. Das
Frontend zieht sie in die Skizze und von dort als Warnkasten in den Bauantrag.

**Was das Verfahren rechnerisch ist.** Die Monatsbilanz nach DIN V 4108-6, also
das vereinfachte Wohngebäudeverfahren. Es ist **nicht** DIN V 18599: Kühlung,
Beleuchtung und Lüftungsanlagen fehlen als eigene Teilbilanzen. Ein
Nichtwohngebäude wird gerechnet, aber mit einem Hinweis im Bericht versehen,
dass 18599 zu führen ist.

**Synchron, anders als die Statik.** Die Bilanz ist eine Handvoll
Matrixoperationen über zwölf Monate und braucht auch bei hundert Bauteilen unter
einer Sekunde — Statusabfragen wären hier Verwaltung ohne Nutzen. Der einzige
Grund für die Sperre in `energie.py` ist matplotlib: `pyplot` hält globalen
Zustand, und FastAPI führt synchrone Endpunkte im Threadpool aus.

### Die Monatsbilanz und warum sie monatlich sein muss

```
Q_h = Σ_Monat max(0, Q_Verlust − η · Q_Gewinn)
```

Das `max(0, …)` je Monat ist der Kern. Eine Jahresbilanz verrechnet den
Sommerüberschuss mit dem Januar und kommt dadurch weit zu günstig heraus. Der
Ausnutzungsgrad η nach DIN V 4108-6 Gl. (17) bildet ab, dass ein Gewinn nur
nützt, solange geheizt wird: er geht gegen 1, wenn die Verluste überwiegen, und
gegen 0, wenn die Sonne in ein ohnehin warmes Haus scheint. Am Beispielgebäude
sind das im Januar η = 1,00 und im Juli η = 0,11.

Die Zeitkonstante darin kommt aus der wirksamen Speicherfähigkeit — ein
Massivbau puffert einen sonnigen Nachmittag in die Nacht, ein Leichtbau nicht.

**Das Referenzgebäude ist dasselbe Gebäude in anderer Ausführung.** Gleiche
Geometrie, gleiche Orientierung, gleiche Flächen; nur U-Werte, g-Werte,
Wärmebrückenzuschlag und Anlagentechnik sind die der GEG-Anlage 1. Deshalb darf
`_referenzgebaeude()` nichts aus dem Entwurf übernehmen außer der Geometrie —
sonst verglichen sich zwei Gebäude mit derselben Heizung, und der Nachweis sagte
über die Anlagentechnik nichts mehr aus.

Die Effizienzhaus-Stufe folgt aus der **schlechteren** der beiden Kennzahlen.
Am Beispiel: Primärenergie bei 28 % der Referenz (EH 40), H_T' bei 77 % — daraus
wird EH 70, nicht EH 40. Ein Haus lässt sich nicht allein über eine gute Heizung
in eine Effizienzstufe rechnen.

### Hüllflächen aus dem IFC — und was dabei stillschweigend schiefgeht

`huelle_aus_bauteilen()` liest dieselbe `properties.sqlite`, aus der die
Bauteilanzeige ihre Psets holt (über `elements.alle_bauteile()`), und macht
daraus die Bauteilliste. Zwei Fallen, beide der stillen Sorte:

* **`GlazingAreaFraction` enthält `area`.** Eine reine Teilstringsuche nach der
  Fläche greift bei einem Fenster deshalb den Glasflächen*anteil* 0,7 ab, bevor
  sie `Area` = 12,0 m² erreicht. Ein Fenster mit 0,7 m² statt 12 m² fällt in
  keiner Summe auf, verfälscht aber Transmission und solare Gewinne um mehr als
  eine Größenordnung. `_feldwert()` sucht deshalb **erst exakt, dann als
  Teilstring**, und beides in der Reihenfolge der Muster.
* **Weder Orientierung noch Plattenart stehen in den Property-Sets.** Beides
  steckt in der Lage des Bauteils. Der `PredefinedType`, der ein `IfcSlab` als
  Dach oder Bodenplatte auswiese, ist ein Entitätsattribut und wird von der
  Bauteilablage nicht geführt.

**`IsExternal` entscheidet, und zwar für jede Bauteilart.** Ein Bauteil ohne
diese Angabe gehört nicht in die Hülle. Bis 2026-08 galt für Fenster und Türen
eine Ausnahme — sie liegen ja fast immer in einer Außenwand —, aber „fast
immer" ist bei einer Innentür schlicht falsch, und die Ausnahme machte die
Hüllfläche zu einer Größe, deren Zustandekommen man dem Ergebnis nicht mehr
ansah. Jedes verworfene Bauteil steht mit Grund und GlobalId in
`ausgeschlossen`; das Werkzeug färbt sie im Modell ein (`geg-huelle.js`), weil
ein *fehlendes* Bauteil in einer Tabelle nicht auffällt und im Bild sofort.

**Die Bauteillage kommt aus dem Elementverzeichnis** (`section.build_index()`),
also aus derselben Quelle wie die Bauzeichnungen — als optionaler Parameter
`geometrie`, weil ein Modell ohne greifbare IFC-Quelldatei trotzdem eine
verwertbare Hüllfläche liefern soll. Damit werden zwei Dinge bestimmt, die
vorher geraten oder pauschal gesetzt waren:

| | Regel | Grenze |
|---|---|---|
| Plattenart | Oberkante nahe Bauwerksoberkante → `dach`, Unterkante nahe Bauwerksunterkante → `boden_erdreich`, dazwischen → `decke_unbeheizt`. Toleranz ist ein Zehntel der Bauwerkshöhe | ein Staffelgeschoss mit eigener Dachfläche in halber Höhe wird als Decke geführt |
| Orientierung | die kürzeste Kante der Hüllbox zeigt in Richtung der Normalen; das Vorzeichen folgt aus der Lage gegenüber der Bauwerksmitte. Ist die kurze Kante die Hochachse → `dachfenster` | nur bei achsparallelen Bauten. Sind beide Grundrisskanten ähnlich lang (gedrehte oder gerundete Fassade), wird **nicht** geraten: es bleibt bei Ost mit Mangeleintrag |

Was gar nicht geht, wird **übersprungen und gemeldet**, nicht geraten: ein
Bauteil ohne Fläche fällt heraus und steht in `maengel`. Fehlt nur der U-Wert,
kommt der Referenzwert der Bauteilart hinein und das Feld `bemerkung` sagt es —
im Werkzeug ist diese Zeile dann am gelben Rand erkennbar.

### Beheiztes Volumen: zwei Wege, und der Unterschied ist kein Detail

V_e und A_N wurden bisher von Hand eingetragen oder geschätzt — ohne Volumen
setzt die Bilanz A/V = 0,7 1/m an, was bei einem gedrungenen Bau um ein Drittel
danebenliegt. `GET .../energie-geometrie` holt beides aus dem Modell.
`section.raumkennwerte()` und `section.geschosskennwerte()` lesen es aus dem
IFC, `energie.volumen_aus_geometrie()` rechnet daraus:

| Weg | Rechnung | Ergebnis |
|---|---|---|
| **Räume** (Vorzug) | Σ Raumvolumen ÷ `NETTO_ZU_BRUTTO` (0,80) | ein Nettomaß, hochgerechnet — beschreibt aber genau die **beheizte** Zone |
| **Geschosse** | Bruttogrundfläche × Geschosshöhe | unmittelbar ein Bruttomaß, umfasst aber alles, was die Deckenplatten überdecken |

**Warum die Räume und nicht die Geschosse den Vorzug haben**, obwohl der
Geschossweg das Bruttomaß ohne Umrechnung liefert: eine Deckenplatte weiß
nicht, wo geheizt wird. Am `Ifc4_SampleHouse` misst die Bodenplatte 146 m², die
drei Räume darauf zusammen 76 m² — die Platte reicht über die beheizte Zone
hinaus, und V_e kam mit 444 m³ statt rund 333 m³ um ein Drittel zu groß heraus.
Der Geschossweg ist deshalb der Rückfall für Modelle ohne Räume, nicht der
Regelfall.

Liegen beide vor, bleibt der jeweils andere als Kontrollzahl stehen; laufen sie
um mehr als 15 % auseinander, steht das als Hinweis dabei — entweder fehlen
Räume, oder die Deckenplatten greifen über die beheizte Zone hinaus.

Fünf Punkte, an denen es sonst still falsch würde:

* **Die Einheiten eines Mengensatzes sind nicht verlässlich gemischt.** Im
  `Ifc4_SampleHouse` (Revit, Längeneinheit mm) steht im Wohnzimmer
  `NetFloorArea = 51,99`, `Height = 2500,0`, `GrossVolume = 129,99` — Fläche
  und Volumen bereits metrisch, die Höhe in Millimetern. Wer alles mit dem
  Längenmaßstab multipliziert (Flächen im Quadrat), macht aus 51,99 m²
  0,000052 m², und in einer Bilanz fällt eine Null nicht auf. `_masse_pruefen()`
  entscheidet deshalb nicht nach der Einheitenangabe der Datei, sondern hält
  skaliert *und* unskaliert gegen den Hüllquader des Raums und nimmt, was
  hineinpasst. Passt keiner, entfällt die Angabe und die Geometrie tritt ein.
* **Ein Geschoss ist, was `IfcBuildingStorey` heißt.** Das Feld `storey` im
  Elementverzeichnis kommt aus `get_container()` und liefert den *unmittelbaren*
  Container — bei einer Wand das Geschoss, bei einem Stuhl den Raum. Als
  Geschossliste gelesen ergab das am SampleHouse vier „Geschosse" (Ground
  Floor, Roof, „1 - Living room", „2 - Bedroom"), und weil die beiden Phantome
  auf der Kote des Erdgeschosses sitzen, schrumpfte dessen Höhe auf null.
  Bauteile, deren Container kein Geschoss ist, werden jetzt über ihre
  Höhenlage eingeordnet.
* **Geschosse ohne `Elevation` fallen nicht heraus.** `storeys()` lässt sie aus
  (für einen Plan richtig: eine Schnitthöhe darüber wäre nicht adressierbar),
  für ein Volumen ist das zu streng — am `demo_statik.ifc` hat das einzige
  Geschoss keine Kote, und die Kennwerte kamen zunächst leer zurück. Dann tritt
  die Unterkante der ihm direkt zugeordneten Bauteile ein; `kote_quelle` sagt,
  welche galt.
* **Die Bruttogrundfläche ist das Minimum zweier Schätzungen** (`_bgf()`), die
  beide zu groß sind, aber aus entgegengesetzten Gründen: die Vereinigung der
  Platten-*Bounding-Boxes* zählt bei einem L-förmigen Grundriss die Kerbe mit,
  die Summe der Mengensätze zählt jede Schicht des Deckenaufbaus. Der kleinere
  Wert ist in beiden Fehlerfällen der bessere; `flaeche_quelle` sagt, welcher
  gewonnen hat, und `flaeche_umschrieben_m2` steht zum Vergleich daneben.
* **Das Raumvolumen kommt aus dem Netz**, nicht aus der Bounding Box: Gaußsche
  Integration über die Dreiecke des Raumkörpers, exakt auch bei Dachschrägen
  und L-Grundrissen. Der Hüllquader ist dabei zugleich Prüfmaß — ein
  Netzvolumen größer als er kann nicht stimmen, und bei einer offenen
  Raumbegrenzung gibt die Formel eine beliebige Zahl zurück statt eines
  Fehlers. Danach `GrossVolume`/`NetVolume`, dann Fläche × Höhe, dann der
  Quader; `volumen_quelle` steht je Raum dabei.

**A_N bleibt 0,32 · V_e nach GEG § 20**, auch wenn das Modell Raumflächen
führt. A_N ist eine Rechengröße des GEG und keine gemessene Fläche; wer die
Nettogrundfläche einträgt, rechnet den flächenbezogenen Bedarf systematisch zu
ungünstig. NGF und BGF kommen trotzdem mit heraus — zum Vergleichen.

Räume mit `balkon`, `terrasse`, `garage`, `unbeheizt` &c. im Namen zählen nicht
zum beheizten Volumen (`UNBEHEIZT_MUSTER`). Die Liste ist bewusst kurz: was
nicht darin steht, wird mitgezählt und ist in der Raumliste des Werkzeugs zu
sehen — ein zu Unrecht mitgezählter Raum fällt dort auf, ein stillschweigend
weggelassener nicht.

**Modelle mit Räumen sind die Ausnahme.** Von den Testmodellen im
uploads-Bucket führt nur `Ifc4_SampleHouse.ifc` `IfcSpace` — das Campus-Modell,
GESTAMP und `demo_statik.ifc` haben keine. Der Geschossweg ist deshalb der,
der in der Praxis meistens greift, auch wenn er der schwächere ist.

Das Tiling schließt Räume ohnehin aus (`IFC_EXCLUDE_TYPES`), sie stehen also
auch nicht in `properties.sqlite`; `raumkennwerte()` geht deshalb über das
eigene Raumverzeichnis (`{job}.rooms2.npz`) direkt an die IFC-Datei, am Tiling
vorbei. Die `2` im Namen ist eine Formatversion: seit dem Raumvolumen und der
Einheitenprüfung trägt jeder Eintrag Felder, die die alte Datei nicht hat.

### Klimadaten und Kataloge

Das Referenzklima ist Potsdam (GEG § 22), als Tabelle im Modul: zwölf
Monatsmittel und Strahlungssummen je Himmelsrichtung. Ein fester Standort und
nicht das Wetter am Bauplatz — der Nachweis ist ein *Vergleich* mit dem
Referenzgebäude, und der ist nur aussagekräftig, wenn beide Seiten dasselbe
Klima sehen. Standortwetter gehört in eine Verbrauchsprognose.

Erzeuger, Energieträger, Primärenergie- und CO₂-Faktoren stehen ebenfalls im
Modul und gehen über `GET /energie/katalog` ans Frontend. Dieselben Tabellen
dort noch einmal zu führen hieße, dass eine Korrektur an einem
Primärenergiefaktor an zwei Stellen zu machen ist — und beim zweiten Mal
vergessen wird.

### Prüfen ohne Server

```bash
python3 -m ileen.energie /tmp/geg-probe     # Beispielgebäude, neun Bilder
python3 -m ileen.energie --pruefen          # Auswertung des Modells, ohne IFC
python3 -m tiling.section                   # Mengensatz-Einheiten, BGF, Netzvolumen
```

Die Kontrolle, die dabei zählt, ist die Kreuzprobe des Monatsverlusts:
`(H_T + H_V) · ΔT · t` von Hand gegen den Wert des Moduls — sie muss auf die
letzte Stelle stimmen.

Die beiden Handproben decken das ab, was **still** falsch wird und deshalb
keine Kreuzprobe hat: eine Himmelsrichtung, eine als Dach durchgehende
Bodenplatte, eine Innenwand in der Hülle, das beheizte Volumen aus dem falschen
der beiden Wege — und die Einheitenwahl der Mengensätze, die aus 51,99 m²
0,000052 m² machen kann, ohne dass irgendwo eine Ausnahme fliegt. Für die Route selbst führt der Weg über einen
Wegwerf-Container aus demselben Image, mit `TestClient` gegen das laufende
MinIO; das rührt den laufenden Dienst nicht an.

## Baugrundmodell — Ablage, Bildlesen, GGU-Import *(2026-10-18)*

`api/routes/baugrund.py`, Bucket `baugrund` (legt sich selbst an). Gerechnet wird das Modell im Browser
(`frontend/baugrund-kern.js`) — die Interpolation hängt am Geländemodell des Viewers. Hier liegt, was den
Browser überleben muss, und die zwei Dinge, die dort nicht gehen.

| Methode | Pfad | |
|---|---|---|
| GET | `/baugrund/modelle` | Modelle mit Kopf (Titel, Stand, Zahl der Aufschlüsse/Schichten) |
| GET/PUT/DELETE | `/baugrund/modelle/{name}` | Modell (`format: ileen-baugrund`, ≤ 8 MB — Bilder gehören nicht hinein) |
| GET/PUT/DELETE | `/baugrund/modelle/{name}/bilder/{bild}` | Bild eines Aufschlusses, Rohkörper mit Bildtyp (≤ 40 MB) |
| GET | `/baugrund/lesen` | steht das Bildmodell bereit? (`{bereit, modell, adresse, grund}`) |
| POST | `/baugrund/lesen?hinweis=` | Bild → `{name, art, ansatzhoehe, endteufe, grundwasser, datum, schichten:[{von,bis,kurz,text}], hinweise, dauer_s, roh}` |
| POST | `/baugrund/import/ground` | GGU-CONNECT `.GROUND` → Modell |

**Bildlesen** (`ileen/baugrund_lesen.py`): Ollama mit `gemma4:latest` (`ILEEN_BILDMODELL`), gesucht unter
`OLLAMA_URL`, dann `host.docker.internal:11434`, dann `127.0.0.1:11434` — aus dem Container läuft es auf der
GPU des Macs, nichts verlässt den Rechner. Eine Lesung zur Zeit (`asyncio.Semaphore(1)`), 25–31 s je Profil.
Strukturierte Ausgabe über `format` (JSON-Schema). **Alle Zahlen als Text, wie gedruckt** („0,40"): als Zahl
verlangt rundete Gemma auf ganze Meter und erfand eine Schicht „Unbekannt"; als Text abgeschrieben war
dasselbe Profil samt Ansatzhöhe richtig. Trotzdem liest es Ziffern nicht verlässlich (die Zahl am
Grundwasser-Dreieck als Schichtgrenze) — die Tiefen misst deshalb der Browser am Bild, die Lesung liefert
Kurzzeichen und Text. `aufbereiten()` macht aus der Antwort eine lückenlose, sortierte Folge und sagt in
`hinweise`, was es geändert hat (Sortierung, Dicke null, Lücke, unplausible Ansatzhöhe).

**GGU-CONNECT** (`ileen/baugrund_ground.py`): ZIP aus `fachmodell_baugrund.xml` und CSV-Tabellen (drei
Kopfzeilen, UTF-8 mit BOM). Aufschlüsse mit Rechts-/Hochwert (EPSG der Datei, pyproj → WGS84; kleine Werte
hängen am `projectOrigin`), Ansatzhöhe NHN, Schichten (Petrographie als Kurzzeichen, GGUs Fels „^fe"),
**jede `GroundModel` als Gliederung** (Baugrundschichten, Homogenbereiche der Erdarbeiten). Fallen:
die Zuordnung Schicht → Modellschicht (`GROUNDLAYER_BOREHOLELAYERS`) ist eine **Folge von GUIDs ohne Trenner**
mit führenden Kommas — per Regex lesen; die Nummern im Namen („1 - Auffüllung", „2 - Mutterboden") sagen
nichts über die Abfolge (die ordnet der Browser aus den Bohrungen); Kennwerte stehen als `(min,wert,max)`
mit Einheit aus der Definitionstabelle und werden **nicht umgerechnet** (das Demoprojekt führt einen
Steifemodul von 11 550 bei der Einheit MN/m²). Das DGM steht nicht im ZIP.

Prüfstein: `python3 tests/test_baugrund.py` (31: eine `.GROUND` aus dem Test selbst gebaut — GUID-Folge,
Kleinschreibung, zwei Gliederungen, Kennwerte, Ruhewasser, Schnitte, lokale Koordinaten —, pyproj-Lage,
Aufbereitung beider Antwortformen; das Kierspe-Demoprojekt, wenn es auf der Platte liegt).

Eingespielt am 2026-10-18 per `docker cp` + `docker restart cesium-api` (`ileen/baugrund_ground.py`,
`ileen/baugrund_lesen.py`, `api/routes/baugrund.py`, `api/main.py`) — beim nächsten
`docker compose build api` fest im Image.

## Bauplaner-Tragwerk — Aufträge an die Tragwerksplanung und zurück *(2026-10-05)*

`api/routes/bauplaner.py`, Bucket `bauplaner` (legt sich beim ersten Zugriff selbst an).
Gerechnet wird hier nichts — dasselbe Muster wie beim Einsturz: Der Bauplaner im
Frontend (`bauplaner-tragwerk.js`) legt seinen Entwurf als Auftrag ab, der twp-Skill
(`~/.claude/skills/twp/werkzeuge/bauplaner_tragwerk.py`) holt ihn, rechnet, bemisst je
Gruppe und legt Ergebnis und Bericht daneben; der Bauplaner fragt danach.

| Methode | Pfad | |
|---|---|---|
| GET | `/bauplaner/auftraege` | alle Pläne mit Kopf (Nummer, Titel, Bauweise, Bauteile, Ergebnisstand) |
| PUT | `/bauplaner/auftraege/{plan}` | Auftrag (`format: ileen-bauplaner-tragwerk`), bekommt `nummer` und `eingang` |
| GET | `/bauplaner/auftraege/{plan}` | Auftrag lesen |
| PUT/GET | `/bauplaner/auftraege/{plan}/ergebnis` | Ergebnis (`ileen-bauplaner-tragwerk-ergebnis`), GET 404 solange keins da ist |
| PUT/GET | `/bauplaner/auftraege/{plan}/bericht` | Bericht als Markdown |
| DELETE | `/bauplaner/auftraege/{plan}` | alles zu einem Plan |

**Die Nummer je Plan** ist der Grund für den Kopf (`kopf.json`): Schickt jemand einen
geänderten Entwurf, während twp noch am alten rechnet, nennt das Ergebnis die Nummer,
zu der es gerechnet wurde (`auftrag_nummer`), und der Bauplaner übernimmt es nicht
stillschweigend als das neue.

**Eingespielt am 2026-10-05 per `docker cp` + `docker restart cesium-api`** (Route und
`main.py`) — das überlebt Neustarts, aber kein Neuerstellen des Containers. Beim
nächsten `docker compose build api` ist sie aus dem Repo fest im Image.

## Einsturz — Rechnungen von außen an ein Modell andocken

Das Gegenstück zur Statik, nur umgekehrt: dort rechnet das Backend, hier nimmt
es eine Rechnung entgegen, die anderswo entstanden ist. Eine Einsturzsimulation
(Starrkörper-Feder-Modell mit Bruch, Stunden auf der GPU) gehört nicht in einen
Web-Dienst mit einem Worker; sie läuft in der Studie und kommt als **Paket im
Format „ileen-einsturz"** zurück. Der Viewer spielt es ab (`frontend/einsturz.js`).

```
GET    /einsturz                              Modelle mit Einsturzpaketen
GET    /einsturz/{job}                        Pakete zu einem Modell (Kopfdaten)
GET    /einsturz/{job}/{paket}/{datei}        einsturz.json, geometrie.bin.gz, <szenario>.bin.gz
PUT    /einsturz/{job}/{paket}/{datei}        eine Datei ablegen (Rohkörper)
POST   /einsturz/{job}/{paket}/andocken       Bezug zum Tileset aus den Ankern rechnen
DELETE /einsturz/{job}/{paket}
```

```bash
python3 scripts/einsturz_hochladen.py ~/Projekte/Statik-LUX/kollaps/stb/ileen/ist --modell "Lux Pavillon"
```

### Das Format

| Datei | Inhalt |
|---|---|
| `einsturz.json` | Titel, Verfahren, Grenzen, Bauteile (Name, GlobalId, Geschoss, Annahme), Stützen mit ihren Zellen, Szenarien (Zeitreihen t, λ, abgesackt, E_kin, Phasen, Chronik, Kennzahlen), **Anker**, **Bezug** |
| `geometrie.bin.gz` | fertige Dreiecke: `pos`, `nor` (int8), `uvw`, `info` (Werkstoff, Profil, Flächenart, Seite), `koerper`, `nb` (4 Nachbarn), `ed` (4 Kantenabstände); je Körper `x0`, `bauteil`, `mat`, `prof`, `kd`; je Glasscheibe `glas` |
| `<szenario>.bin.gz` | Bewegung (`lo`/`hi`), `schaden` (t Riss, Druck, Fließen, Reißen je Körper), `entfernt` (Ausfallzeit je Körper), `bruch` (je Scheibe t, u0, v0) |

Blob = gzip(uint32 Kopflänge + JSON-Kopf + auf 8 Byte ausgerichtete Arrays).
Bewegung als int16 mit Wurzelkodierung (u bis 40 m, Drehvektor bis π), entlang
der Bilder differenziert, Bytes nach Ebenen getrennt — ruhende Körper packt gzip
fast auf null. Der **Referenz-Schreiber** steht in `ileen/einsturz.py`
(`blob`, `bewegung`); die Studien schreiben ihre Pakete selbst, damit sie
unabhängig bleiben, aber gegen diese Fassung wird der Viewer geprüft
(`frontend/tests/einsturz/`). Weicht ein Exporter ab, liegt er falsch.

**iLEEN baut keine Geometrie.** Das Paket enthält fertige Dreiecke je
Starrkörper; wie eine Voronoi-Zelle, ein TT-Querschnitt oder ein
Mauerwerksblock trianguliert wird, weiß nur die Studie. Damit spielt derselbe
Viewer jede Studie ab, deren Exporter das Format schreibt.

**Was iLEEN wohl kennt, ist der Wortschatz der Codes** — `WERKSTOFFE`,
`PROFILE`, `FLAECHEN` in `ileen/einsturz.py`. Nach Werkstoff und Profil wählt
der Shader Farbe und Oberfläche (Sichtbeton, Linoleum, Kies, Maserung,
Walzprofil …). Eine neue Oberfläche bekommt eine **neue Nummer**, nie eine
zweite Bedeutung einer alten: OPL und LUX schrieben beide 9/10 für
Fußboden und Dach, meinten aber Linoleum/Kies bzw. Teppich/Bitumen — die OPL
hat deshalb 17–19.

**Schadensarten gehören ins Paket.** Die vier Spalten von `schaden` heißen
bei Stahlbeton Riss, Bewehrung fließt, Beton zerdrückt, Bewehrung gerissen;
bei einem Stabwerk Verbindung gelöst, Stahl fließt, —, Stab gebrochen. Das
Paket nennt sie in `schadensarten` (`null` = kommt nicht vor), das Panel
beschriftet Legende und Auswahl danach; ohne Angabe gilt Stahlbeton. Ein
Chronik-Eintrag darf seinen Körper nennen (`koerper`) — dann fliegt der Viewer
dorthin, statt einen Ort aus dem Text zu lesen.

| Studie | Exporter | Pakete | Modell |
|---|---|---|---|
| LUX-Pavillon | `Statik-LUX/kollaps/stb/export_ileen.py` | `ist`, `scan` | 43fe32ef |
| OPL (StB-Bürobau) | `Statik-OPL/kollaps/stb/export_ileen.py` (Kopie des LUX) | `ist`, `mw` | a7ae4004 |
| EFH Weihgold (Holz) | `Statik-Weihgold/kollaps/export_ileen.py` | `ist`, `soll` | 8eabd300 |
| Kranhalle FTW (Stahl) | `Statik-Kranhalle/kollaps/export_ileen.py` | `soll`, `ist` | 3e7a36ef |
| Versagensarten (sechs Tragwerke) | `Versagensarten/sim/export_ileen.py` (Anker: `anker_halle.py`) | `versagensarten` | 3356f8d2 (Campus BA 2+1) |

Die beiden Stabwerke teilen einen Exporter, dessen Vorlage im twp-Skill liegt
(`~/.claude/skills/twp/kollaps/export_ileen.py`, `fe/twp.sh` ruft ihn samt
Hochladen auf). Er zeichnet je Stababschnitt den wirklichen Querschnitt
(Vollholz, BSH, I-Profil mit Voute, Rundstahl, Kran), nimmt die Anker aus dem
IFC selbst und dreht ein gedrehtes Rechensystem (Weihgold: 33°) vorher
zurück — angedockt wird nur über eine Verschiebung.

### Der Bezug wird gemessen, nicht gerechnet

Die Rechnung liegt im System der Studie (beim LUX „IFC minus Gebäudemitte"),
die Kacheln im tile-lokalen System des IFC-Tilings. Die Zentrierung des Tilers
nachzurechnen geht still schief: seine Wurzeltranslation wird verworfen (siehe
„Gaussian Splats → LOD-Aufbau" und die Speicher-Notiz zur IFC-Platzierung), und
das Elementverzeichnis zentriert über eine andere Bauteilmenge — beim LUX
weichen beide Ausdehnungen um sechs Meter voneinander ab.

Deshalb bringt das Paket **Anker** mit: die Hüllbox jedes IFC-Bauteils, aus dem
es gebaut ist, im System der Rechnung, samt GlobalId. `andocken` liest sämtliche
Kacheln (`tileset_boxen()`: B3DM-Batch-Table, glTF-Knotenmatrix, Achsdrehung,
`RTC_CENTER`, Kindtransformationen), bildet je GlobalId die Box im
tile-lokalen System und nimmt den Median der Differenzen. Beim LUX: 408 von 408
Bauteilen, Streuung 0,01 mm.

Zwei Dinge, die dabei schiefgehen können und abgefangen werden:

* **Anders zugeschnittene Bauteile** (in der Studie gekappte Durchdringungen,
  verlängerte Stützen) haben unten und oben verschiedene Differenzen und zählen
  nicht mit — aber nur, solange die stimmigen die Mehrheit sind.
* **Ein gedrehtes System** ließe gerade die drehsymmetrischen Boxen stimmig
  (eine quadratische Stütze) und ergäbe eine falsche Verschiebung ohne
  Streuung. Deshalb die Mehrheitsregel; sonst entscheidet die Streuung über
  alle, und über 5 mm wird abgelehnt statt schief angedockt.

Der Bezug merkt sich die **Wurzelbox** des Tilesets; ändert sie sich (neues
Tiling), meldet der Viewer einen veralteten Bezug.

### Eigener Bucket, nicht `tiles/<job>/`

Ein erneutes Tiling leert den Tile-Präfix des Jobs, und eine Rechnung von
Stunden verschwände mit. Dafür muss der Bucket beim Löschen des Assets eigens
abgeräumt werden (`einsturz.purge()`, siehe Hinweis 18d).

Die Dateien gehen mit `ETag` und `Cache-Control: no-cache` hinaus, aber **ohne
`Content-Encoding`**: der Viewer entpackt selbst (`DecompressionStream`), und
ein vom Browser vorab entpackter Körper wäre nicht mehr das, was im Paket steht.

Prüfstein: `python3 tests/test_einsturz.py` — echte Kacheln aus den Encodern des
Tilings, Kindtranslation und Achsdrehung, gedrehtes System, fremdes Modell.

## Themen (BCF-Issues) — Notizen, Messungen und Kollisionen an einer Stelle

Alles, was im Viewer getaggt, notiert oder gemessen wird, ist dasselbe Ding: ein
**Thema**. Bis September 2026 lagen diese Themen im `localStorage` des Browsers
— eine Person, ein Rechner, kein Verlauf, kein Import. Jetzt liegen sie hier.

```
POST   /issues                        anlegen (der Viewer schickt seine Notiz)
GET    /issues                        Liste, filterbar (status, typ, ifc_guid, suche …)
GET    /issues/zahlen                 Überblick für die Oberfläche
GET    /issues/bcf                    alles (oder gefiltert) als .bcfzip
POST   /issues/bcf                    ein .bcfzip einlesen
GET    /issues/bericht                HTML-Bericht, druckbar, Bilder eingebettet
GET    /issues/{guid}                 ein Thema samt Verlauf
PATCH  /issues/{guid}                 ändern → neue Version
DELETE /issues/{guid}                 weich löschen (?endgueltig=true räumt)
POST   /issues/{guid}/kommentare
GET    /issues/{guid}/versionen[/{n}]
POST   /issues/{guid}/zuruecksetzen/{n}
POST   /issues/{guid}/ansichten       Kamera + Bauteile + Schnappschuss
GET    /issues/{guid}/ansichten/{a}/bild
GET    /issues/{guid}/bcf             ein einzelnes Thema als Paket
```

| Modul | Aufgabe |
|---|---|
| `ileen/bcf.py` | BCF 2.1 **lesen und schreiben**, ohne Server, ohne Datenbank |
| `ileen/issues_db.py` | SQLite mit Verlauf; elf Funktionen, kein SQL nach außen |
| `ileen/issues_bericht.py` | der HTML-Bericht |
| `api/routes/issues.py` | die Anbindung, sonst nichts |

**Die Ablage ist ausdrücklich vorläufig.** Die Datenhaltung soll später in gaeco
liegen, angebunden über Kafka. Deshalb ist die Schnittstelle von `issues_db.py`
schmal und frei von SQL (`anlegen`, `liste`, `holen`, `aendern`, `loeschen`,
`kommentieren`, `ansicht_anlegen`, `zuruecksetzen`, `als_themen`, `aus_themen`,
`zahlen`): wer diese elf gegen einen Kafka-Erzeuger und eine gaeco-Abfrage
tauscht, hat die Umstellung hinter sich, ohne einen Aufrufer anzufassen.

### Der Verlauf ist ein Abbild, keine Differenz

Jede Schreibhandlung legt eine Version an, und zwar als **vollständiges
Abbild**. Das kostet ein paar Kilobyte je Änderung und kauft die Eigenschaft,
die einen Verlauf erst brauchbar macht: jeder Stand ist für sich lesbar, ohne
die Kette davor abzuspielen. Die Differenz zum Vorgänger wird trotzdem
mitgeschrieben — „was hat sich geändert" ist die Frage, die man in der
Oberfläche stellt.

**Zurücksetzen löscht nichts**: der alte Inhalt kommt als *neue* Version
obendrauf. Ein Verlauf, aus dem man Stände entfernen kann, ist als Nachweis
wertlos — und genau als Nachweis wird er in einem Bauvorhaben gebraucht.

**Eine Änderung, die keine ist, erzeugt keine Version.** Sonst füllte jeder
Klick auf „Speichern" den Verlauf mit Ständen, die nichts erzählen, und die
eine Änderung, die zählt, wäre darin nicht mehr zu finden.

### Vier Dinge, an denen ein BCF-Austausch sonst scheitert

* **Ein Namensraum, den BCF nicht kennt.** Manche Werkzeuge schreiben trotzdem
  einen; `ElementTree` sucht dann nach `{…}Topic` statt `Topic`, und jedes
  `find()` liefe ins Leere — aus einem Revit-Export käme schlicht nichts an.
  `bcf._ohne_namensraum()` entfernt die Deklaration vor dem Parsen.
* **Ein kaputtes Thema darf die übrigen hundert nicht mitnehmen.** Ein Ordner
  ohne Markup oder ein `.bcfv` mit unerwartetem Aufbau wird übersprungen und
  nicht geraten.
* **Bekannte GUIDs werden geändert, nicht verdoppelt.** Ein zweiter Import
  desselben Pakets ist ein Abgleich und keine zweite Themenliste.
* **Koordinaten werden nicht umgerechnet.** BCF-Kameras stehen im Projektsystem
  der BIM-Software; wer hier eine Kamera hineingibt, hat sie bereits umgerechnet
  (das tut der Viewer über `root.computedTransform` des ersten Modells). Eine
  stillschweigende Umrechnung an dieser Stelle wäre der sicherste Weg, aus einem
  Paket, das in Solibri passt, eines zu machen, das um den Erdradius daneben
  liegt.

Der Ort der Notiz geht als Zeile in die Beschreibung mit (`[iLEEN] Ort: …°N,
…°E, H … m`) — ohne ihn ist ein Thema in fremder Software nur Text.

### Ablage und Volume

`ILEEN_ISSUES_DB` (Standard `/data/issues/issues.db`), Volume
`./data/issues:/data/issues`. Das ist das einzige Volume mit Daten, die
nirgendwo sonst stehen: Tiles lassen sich neu rechnen, ein Bautagebuch nicht.
Bewusst nicht in MinIO — SQLite springt in der Datei umher, über S3 ginge das
nur mit Range-Requests je Seite.

Eine Verbindung je Aufruf, WAL eingeschaltet: FastAPI führt synchrone Endpunkte
im Threadpool aus, und eine geteilte Verbindung müsste `check_same_thread=False`
tragen — eine Verabredung, die niemand einhält.

### Prüfen ohne Server

```bash
python3 tests/test_issues.py    # Verlauf, Versionen, BCF hin und zurück, Bericht
```

Läuft gegen eine Wegwerf-Datenbank in `/tmp` (`ILEEN_ISSUES_DB` wird vor dem
Import gesetzt) und rührt keinen Betrieb an. Der Rundlauf ist die wichtigste
Prüfung darin: was hier herauskommt, muss hier auch wieder hereinkommen — mit
derselben GUID, denselben Kommentaren und denselben Bauteilen.

## Nutzungsprotokoll und Ansichtsvorlagen *(2026-10-19)*

Philipp will auswerten können, **welche Modelle er lädt und was er in iLEEN tut**
— „daraus kannst du lernen, wie ich mit iLEEN umgehe". Der Viewer schickt ein
schmales Ereignisprotokoll (`frontend/nutzung.js`), die Vorlagen
(`frontend/vorlagen.js`) liegen daneben.

```
POST /nutzung/ereignisse      Paket {sitzung, fassung, ereignisse:[{art, zeit, daten}]} anhängen
GET  /nutzung/ereignisse      ?tage=7&art=taste — rohe Zeilen
GET  /nutzung/auswertung      ?tage=30 — Modelle, Tasten, Bereiche, Gruppen, Werkzeuge,
                              IFC-Typen, Vorlagen, Stunden, Wochentage, je Tag, Fehler
GET  /nutzung/zuletzt         ?n=20 — zuletzt geladene Modelle (für die Modellliste)
GET  /nutzung/vorlagen        {stand, vorlagen}
PUT  /nutzung/vorlagen        ganze Liste ersetzen (vorige bleibt als vorlagen.vorher.json)
```

| Modul | Aufgabe |
|---|---|
| `ileen/nutzung.py` | Ablage, Grenzen, Auswertung, Vorlagen — ohne FastAPI prüfbar |
| `api/routes/nutzung.py` | Router, kennt keine Pfade |

**JSON Lines, eine Datei je Monat** (`nutzung-2026-10.jsonl`): nur angehängt,
zeilenweise ausgewertet, mit `grep` lesbar; keine Datenbank, die gesperrt oder
migriert werden müsste. `t` ist die Serverzeit, `tc` die des Browsers.
Schiefe Einträge werden übergangen, nicht das ganze Paket verworfen; je
Ereignis höchstens 2000 Zeichen Daten (sonst `_gekuerzt`), je Paket 500
Ereignisse, Rumpf 2 MB.

**`POST /ereignisse` liest den Rumpf selbst** (`request.body()`): beim Verlassen
der Seite schickt der Viewer per `sendBeacon`, und das kann keinen
CORS-Preflight — also `text/plain`. Als JSON-Modell deklariert, lehnte FastAPI
genau die letzten Ereignisse einer Sitzung ab.

**Kein Inhalt.** Namen von Modellen, Menüs, Werkzeugen und Tasten; keine
Koordinaten, Szenen, Feldinhalte oder Bauteileigenschaften (der Browser-
Prüfstein prüft das). Die Vorlagen tragen dagegen Szene und Kamera — sie sind
Daten des Nutzers, keine Telemetrie.

**Wo die Dateien liegen — und warum vorerst im Themen-Volume.** Vorgesehen ist
`./data/nutzung:/data/nutzung` (docker-compose.yml). Der laufende Container hatte
dieses Volume nicht, und ihn neu zu erzeugen hätte die per `docker cp`
eingespielten Stände anderer Module verworfen. `ablage()` nimmt deshalb
`ILEEN_NUTZUNG_DIR`, sonst `/data/nutzung` wenn vorhanden, sonst
`/data/issues/nutzung` (Bind-Mount, überlebt Neustarts; auf dem Host
`backend/data/issues/nutzung/`). Sobald `/data/nutzung` da ist (nächstes
`docker compose up --build api`), zieht `_umziehen()` einmal um: Monatsdateien
werden **angehängt**, nicht überschrieben. Ohne Docker: `backend/data/nutzung/`.

Eingespielt am 2026-10-19 per `docker cp` (`ileen/nutzung.py`,
`api/routes/nutzung.py`, `api/main.py`) + `docker restart cesium-api`.

**Auswerten, um zu lernen, wie gearbeitet wird:**

```bash
curl -s 'localhost:8100/nutzung/auswertung?tage=30' | python3 -m json.tool
curl -s 'localhost:8100/nutzung/ereignisse?tage=7&art=modell_geladen'
```

Lesehilfe: `modelle` (welche Modelle wie oft, mittlere Ladezeit — lange
Ladezeiten bei oft geladenen Modellen sind Kandidaten für Vorlagen oder
Vorladen), `tasten` und `bereiche` (welche Werkzeuge über Tasten statt Menü),
`gruppen` (welche Untergruppen aufgeschlagen werden — was oft gesucht wird,
gehört weiter nach oben), `werkzeuge` (an/aus), `auswahl_ifc_typen`,
`vorlagen`, `stunden`/`wochentage`, `fehler`.

Prüfstein: `python3 tests/test_nutzung.py` (Schreiben, schiefe und übergroße
Einträge, Grenzen, Zeitraum, zuletzt geladen ohne Fehlschläge, Auswertung,
Vorlagen samt vorheriger Fassung, Umzug hängt an).

## Raumsensorik — Sensoren an den IfcSpace *(2026-10-25)*

Philipp: „Das Plugin zwischen Sensordaten, die wir irgendwo erzeugen, und der Verknüpfung mit den Räumen — das
irgendwie geil anzeigen" — in gaeco **und** im 3D-Viewer. Beschrieben im Zusammenhang in `/GAECO-INTEGRATION.md`,
Abschnitt 17; hier steht, was am Code zählt.

| Datei | Aufgabe |
|---|---|
| `scripts/raumklima.py` | **Register aus der Raumliste** (`register_aus_raeumen`, Profil aus dem Raumnamen) und das **Messmodell** `RaumModell` (zustandslos in Seed, Raum, Zeit; Ortszeit Europe/Berlin) |
| `scripts/raumklima_register.py` | holt `GET /assets/{job}/rooms` und schreibt `data/sensoren_raeume.csv` + `sensoren_raeume.meta.json` (Modell-Kennung) |
| `scripts/sensor_demo.py` | `--raeume` / `--nur-raeume` nehmen das Register dazu, `--post [URL]` schickt direkt an `POST /sensoren/messwerte` (überlebt einen Backend-Neustart: Zeilen bleiben im Puffer) |
| `scripts/sensor_dienst.sh` | launchd-Agent für den Echtzeitstrom (`install · status · log · remove · luecke`) — **nicht eingerichtet, nur vorbereitet** |
| `ileen/zeitreihe.py` | `raum_register()`, `alle_sensoren()`, `raeume_stand()`, `raeume_matrix()`; `aufnehmen()` und `am_bauteil()` kennen beide Register |
| `api/routes/sensoren.py` | `GET /sensoren/raeume[?zeit=][&kompakt=true]`, `GET /sensoren/raeume/matrix?groesse=&schritt=&stunden=` |

**Festlegungen, an denen es hängt**

* **Der Anker ist die GlobalId des IfcSpace**, die IRI `uuid5(DNS, GlobalId)` wie bei jedem Bauteil. Deshalb
  findet `GET /sensoren/bauteil/{iri}` die Raumsensoren, SPIDER zeigt ihre Live-Werte von selbst, und die gaeco-Instanz
  des Raums (Betriebsprofil enthält Räume) trägt dieselbe Kennung.
* **Raumsensoren stehen nicht im Zonenregister.** `register()`/`stand()`/`/sensoren` bleiben bei 24 Sensoren —
  `sensor-store.js` und die Geschossfärbung erwarten genau das (und 1 205 Zeilen mehr würden jedes Bild kosten).
* **`raeume_stand`** liefert je Sensor den jüngsten Wert bis zur Bezugszeit innerhalb von zwei Stunden; `alt` heißt:
  älter als drei Meldeintervalle gegenüber der Bezugszeit. **`raeume_matrix`** rastert auf ganze Schritte
  (`…:00`, `…:30`), nicht auf die Sekunde der Abfrage; je Schritt der letzte Wert, bei `praesenz` der größte.
* **Das Raster der Messwerte ist 300 s** (`INTERVALL_S`), die Messgrößen heißen `raumtemperatur`, `co2`,
  `luftfeuchte`, `praesenz` (Brick: `Air_Temperature_Sensor`, `CO2_Level_Sensor`, `Relative_Humidity_Sensor`,
  `Occupancy_Sensor`).
* **Vier absichtliche Störungen** (je ein Raum, deterministisch aus dem Seed): Zuluft defekt, Wärmestau im
  Technikraum, Fenster dauerhaft gekippt, Temperatursensor mit Ausreißern — damit eine Anzeige etwas zu melden hat.

**Einspielen und Betrieb**

```bash
python3 scripts/raumklima_register.py                                  # Register (Campus-IFC bf9da2a7…; --job, --raeume rooms.json)
python3 scripts/sensor_demo.py --nur-raeume --verlauf 5d --ende 2026-10-25T20:50:00Z --post   # Rückblick, idempotent
python3 scripts/sensor_demo.py --nur-raeume --live --post              # Echtzeit; oder scripts/sensor_dienst.sh install
docker cp ileen/zeitreihe.py cesium-api:/app/ileen/zeitreihe.py        # + api/routes/sensoren.py, data/sensoren_raeume.csv (+ .meta.json) nach /app/data/
docker restart cesium-api                                              # ein Neustart bricht einen laufenden Rückblick ab (Broken pipe) — wiederholen
```

Gemessen (M4 Pro): 1 205 Sensoren × 5 Tage = 1,73 Mio. Werte erzeugen ≈ 15 s, über HTTP einspielen ≈ 4 min;
`/sensoren/raeume` 0,16 s, `/sensoren/raeume/matrix` je Messgröße ≈ 1 s. Die Zeitreihe-Datenbank hält damit rund
1,9 Mio. Zeilen; SQLite ist weiter die vorläufige Ablage (siehe `ileen/zeitreihe.py`).

Prüfstein: `python3 tests/test_raumklima.py` (Register je Profil, Modell zustandslos, Belegung folgt dem Wochentag,
CO₂ steigt mit Belegung, die vier Störungen, die Brücke, Zeitreihe samt `am_bauteil`, Matrix, Alter).

## gaeco: ein Modell als Instanzgraph übertragen

```
POST /gaeco/export/{job_id}   {use_case_id}  + Authorization: Bearer <gaeco-Token>
GET  /gaeco/export/{job_id}   Stand: wartet · laeuft · fertig · fehler (+ knoten, kanten, hinweise)
GET  /gaeco/stand             Broker, Anmeldeweg, Guideline-Index, alle Exporte
GET  /gaeco/id/{global_id}    uuid5(NAMESPACE_DNS, GlobalId)
GET  /gaeco/detail/{job_id}   Detailgraph des Modells in Gruppen (für SPIDER, geht nicht nach gaeco; ?max_gruppe=60)
```

Aufgerufen vom gaeco-Modul (`gaeco/modul/`, Knopf „Nach gaeco übertragen"). Vollständig
beschrieben in `/GAECO-INTEGRATION.md`, Abschnitte 8–10; hier, was beim Arbeiten am Code
zählt.

**Der Detailgraph** (`ileen/gaeco_detail.py`, reine Rechnung wie `gaeco_export`): jedes Bauteil, gegliedert
in Gruppen (Klasse → Typ → Stück, mehrstufig, höchstens `MAX_GRUPPE` Kinder je Knoten), Teile unter ihrem
Elternbauteil. Antwort `{knoten, kanten, zahlen, hinweise}`; Kantenarten `aggregates`/`containsElement`
(gaecos Ontologie), `gruppe`, `teil`. Gruppenkennungen deterministisch. Ergebnis liegt im Speicher, bis
sich die Quelldatei ändert; die Route nimmt dieselbe Sperre wie der Export (Öffnen eines großen IFC kostet
GB). Prüfstein: `python3 tests/test_gaeco_detail.py`. Ohne Anmeldung, weil nur lesend und ohne Zugang zu gaeco.

**Warum Kafka und nicht REST.** gaecos InstanceService vergibt über REST die Kennung selbst
und verwirft freie Attribute; über den Kafka-Import übernimmt er eine vorgegebene `Id`. Damit
ist `Id = uuid5(NAMESPACE_DNS, GlobalId)` und die Zuordnung rein rechnerisch — dieselbe Regel
wie in `gaeco/modul/assets/kennung.js` und `api/routes/sensoren.py`. Topic:
`ekkodale.gaeco.instance.public.<useCaseId>.gaecoImport`, Broker wie beim Sensorstrom
(`ILEEN_KAFKA_BROKER`, im Netz `gaeco-broker:29092`).

**`ileen/gaeco_export.py` ist reine Rechnung** (`graph_aus_ifc()`, `nachrichten()`), nur
`senden()` kennt den Broker. Knoten: Projekt bis Raum und — je nach `profil` — nur die
Betriebselemente (`betrieb`, **Standard**: `IfcDistributionElement`, `IfcTransportElement`, ohne
Leitungs- und Formstücke; `zusaetzlich` nennt weitere Klassen) oder jedes `IfcElement` außer
Aussparung, virtuellem Element, Anmerkung, Raster (`voll`). gaeco ist die Verknüpfungsschicht,
nicht die Ablage des Modells: Campus BA2 21 561 → 209 Knoten, HLS-Modell 5 491 → 644. Kanten: `aggregates`, `containsElement`,
`hasFillingElement` (gaecos `ifc4x3-gaeco-relations.ttl`). Eine Nachricht ist **ein**
GraphDataModel, einzeilig; bis 40 MB eine Nachricht, darüber geteilt (Kante zum späteren
Knoten).

**Der Guideline-Index** (`/data/gaeco/ifc_guideline_index.json`, Volume `./data/gaeco`)
übersetzt Property-Kennungen in gaecos Klarnamen: `IsExternal` → „Is External". Erraten geht
nicht — die Guideline macht aus `FunctionalUnitReference` „Function Al Unit Reference". Ohne
Index gehen nur die sechs Attribute mit festem Namen hinaus. Er ist aus gaecos Datei
abgeleitet und deshalb nicht in Git; erzeugt von `gaeco/einrichten.py` oder
`scripts/gaeco_guideline_index.py`. Kennt die Guideline einen Typ nicht (IFC2x3
`IfcWallStandardCase`), gilt der nächste Obertyp aus dem IFC-Schema.

**Die Route ist eine Tür und fragt gaeco.** gaecos Import-Verbraucher prüft keine Anmeldung.
Die Route verlangt deshalb das gaeco-Token des Moduls und stellt mit ihm
`GET {usecase-server}/api/UseCases`; nur wenn der Ziel-UseCase darin steht, geht der Export
hinaus (401/403 sonst). Signatur und Ablauf prüft gaeco, eine JWT-Bibliothek braucht es nicht.
iLEEN hat keine eigene Anmeldung — ohne diese Prüfung könnte jeder, der das Backend erreicht,
in gaecos Graphen schreiben. `ILEEN_GAECO_OHNE_ANMELDUNG=1` nur für rein lokale Rechner.

**Gesendet ist nicht übernommen.** `GET /gaeco/export/{job}` meldet nach `zustand: fertig` im
Feld `gaeco`, ob gaecos Verbrauchergruppe (`instance-service-group`) die Nachricht bestätigt
hat — `gaeco_export.lesestand()` fragt dafür den Broker (Offset und Zuteilung), nicht gaeco,
das ein Token bräuchte. `nicht_abonniert` erkennt die Fallgrube unten von selbst. Gemessen:
gaeco legt ≈ 74 Instanzen und ≈ 32 Beziehungen je Sekunde an; Campus_BA2_Raumplanung
(22 901 / 11 543) brauchte 11 Minuten.

**172.67.68.102 im Log ist der eigene Rechner** — Docker Desktops Adresse für Verbindungen von
`localhost`, kein Tunnel.

**gaecos Verbraucher abonniert nur beim Start** die dann vorhandenen Import-Topics. Für einen
neuen UseCase: Topic anlegen, `instance-server` neu starten (macht `gaeco/einrichten.py`).
Sonst liegen die Nachrichten ungelesen im Broker, und nichts meldet einen Fehler.

Prüfen ohne gaeco und ohne Broker:

```bash
python3 tests/test_gaeco_export.py   # Kennung, Graph, Nachricht, Teilung — 45 Prüfungen
python3 tests/test_gaeco_route.py    # 401/403/Export/Übernahmestand mit Attrappen — 18 Prüfungen
```

Gemessen: `Ifc4_SampleHouse` 69 Knoten / 49 Kanten / 44 kB; Campus BA1-2 (554 MB) 36 191
Knoten / 14 628 Kanten / 13 MB in einer Nachricht, 35 s.

## Atlas — World Labs: aus Tiefe und Kamera ein Foto *(2026-10-21)*

`api/routes/atlas.py` + `ileen/atlas.py`, Bucket `atlas` (legt sich selbst an). Der Viewer (Reiter 🎨,
`frontend/atlas*.js`) nimmt je Ansicht Tiefe, Kamera und Szenenbild auf; hier wird daraus ein Auftrag an
World Labs' **Atlas** (Marble 2, Beta) mit der Aufgabe `atlasChisel`, und die Bilder kommen zurück.

| Methode | Pfad | |
|---|---|---|
| GET | `/atlas/status[?frisch=true]` | Schlüssel da? Nimmt World Labs ihn an (`GET /api/v2/assets?pageSize=1`, 2 min gemerkt) |
| GET/POST | `/atlas/laeufe` | Läufe (Kopf, neueste zuerst) / anlegen: `{prompt, optionen, bezug, ansichten:[{name, kamera, pose}]}` |
| PUT | `/atlas/laeufe/{id}/tiefe/{i}` | float32 1280×720, Zeile 0 oben, 0 = Himmel → `tiefe_i.exr` + Vorschau `tiefe_i.png` |
| PUT | `/atlas/laeufe/{id}/bild/{i}` | Szenenbild (PNG) → `szene_i.png` (Vergleich; mit `farbvorgabe` als `sourceFrames`) |
| POST | `/atlas/laeufe/{id}/starten` | hochladen → einreichen → warten → `ergebnis_i.png` (Hintergrund) |
| GET/DELETE | `/atlas/laeufe/{id}` | Stand (setzt eine unterbrochene Operation fort) / löschen |
| GET | `/atlas/laeufe/{id}/datei/{name}` | `ergebnis_i.*`, `szene_i.png`, `tiefe_i.{png,exr}`, `anfrage.json`, `operation.json` |
| POST | `/atlas/mesh/{splat_job}` | Mesh aus einem Splat-Asset: `{qualitaet, ansicht: aufnahme·auto·aussen, zuschnitt}` |
| GET | `/atlas/mesh/{splat_job}` · `/atlas/mesh` | Stand (setzt ein unterbrochenes Warten fort) · alle |
| POST | `/atlas/mesh/{splat_job}/neu-aufbauen` | das gespeicherte GLB (`atlas.glb`) **ohne neuen Auftrag** neu verorten und kacheln — neues Asset, das alte unter `vorige_meshes` |

**Ein Client für beide Seiten:** `splatwerk/worldlabs.py` (Schlüssel, HTTP mit Wiederholung, Assets,
Operationen, EXR schreiben und lesen) — der Worker auf dem Mac braucht ihn für `images2PosedRGBD`, und das Paket
`ileen` zieht beim Import JAX herein. `ileen/atlas.py` reicht die Namen nur weiter. Der EXR-Leser kann ohne
Zusatzpaket unkomprimiert, RLE, ZIPS und ZIP (halb und voll), PIZ/PXR24/B44 über OpenCV (auf dem Mac da) —
gegen OpenCV-geschriebene Dateien geprüft.

**Der Schlüssel.** Die World-Labs-CLI (`npm i -g @worldlabsai/cli`, `worldlabs auth login` im eigenen
Terminal) legt ihn als Klartext ab: `~/.config/worldlabs/credentials/<sha256(API-Adresse)>.key`, Modus 600.
Das Verzeichnis hängt **nur lesend** unter `/run/worldlabs` im Container; `atlas.schluessel()` liest die Datei
bei jedem Aufruf — eine Anmeldung wirkt ohne Neustart. `WLT_API_KEY` (Umgebung) ginge vor, wie bei der CLI.
Der Browser sieht den Schlüssel nie; er spricht nur `/atlas/*`. Kopfzeile an World Labs: `WLT-Api-Key`.

**Die API** (`https://api.atlas-beta.worldlabs.ai/api/v2`, OpenAPI öffentlich unter `…/api/v2/openapi.json`):
Aufgaben sind lange laufende Operationen (`POST /tasks:<name>` mit `Idempotency-Key` → `POST
/operations/{id}:wait` blockiert bis 30 s). Assets bis 10 MiB gehen inline als `data:`-URL
(`POST /assets {asset:{displayName, base64}}`, sofort `READY`), größere über `:createUploadUrl` → PUT →
`:completeUpload`. Ergebnis-URLs verfallen; dann `:createReadUrl`. Bezahlt wird je Auftrag
(Credits, 402 = Guthaben/Limit); **jeder Startversuch hat seinen Idempotenzschlüssel**
(`ileen-atlas-<lauf>-<versuch>`), Wiederholungen bei 429/5xx schicken denselben — kein zweiter Auftrag.

**Das EXR.** `exr_schreiben()` schreibt ohne Zusatzpaket ein unkomprimiertes, einkanaliges float32-OpenEXR,
`INCREASING_Y` (erster Block = oberste Zeile, die Ordnung der Intrinsik). **Der Kanal heißt `Y`**: der
Three.js-`EXRLoader`, den World Labs in der Doku zum Lesen der eigenen Tiefen nimmt, kennt einkanalig nur
`Y` — mit `R` wirft er „unsupported data channels". Gegengeprüft mit `three@0.180` (Abweichung 7·10⁻⁷,
Zeilenlage stimmt). Lineare **z-Tiefe** entlang der Blickrichtung in Metern, nicht Strahllänge. Himmel bekommt
`ATLAS_HIMMEL_M` (10 000 m) — fern, aber endlich.

**Kamerakonvention** (vom Viewer gerechnet): Pose Kamera → Welt, Quaternion XYZW, `coordinateSystem: rub`,
Welt = ENU am Ursprung des Laufs mit **x Ost, y Oben, z Süd** (Marble will Y oben), Meter. Der Ursprung
(ECEF) steht in `lauf.bezug.ursprung_ecef`; damit lassen sich zurückgegebene Kameras und Tiefen wieder
verorten. `chisel_koerper()` prüft die Grenzen der API vorab: 1–32 Ziele, je Ziel genau eine Tiefe oder
keine, `2·Ziele + Farbvorgaben ≤ 64`, `returnDepth` nur mit Basislinie.

**Lauf neu gestartet?** Der Status liegt im Lauf (`zustand`: entwurf → hochladen → eingereicht → fertig /
fehler). Ein `GET` auf einen Lauf in `eingereicht` ohne laufende Aufgabe (Container neu gestartet) setzt das
Warten auf dieselbe Operation fort; ein in `hochladen` unterbrochener Lauf wird `fehler` und lässt sich neu
starten (↻ im Reiter). Löschen eines laufenden Laufs beendet nur das Warten — der Auftrag bei World Labs läuft
weiter und kostet.

**Mesh aus einem Splat** (`ileen/atlas_mesh.py`): Quell-PLY (`splat_export._quelle`) → um die Mitte der
1–99-%-Box verschoben, Z oben → Y oben (Three.js, wie `splats2Mesh` es meint), als SPZ (`tiling/spz.encode`,
±2048 m) → `splats2Mesh` mit `image_texture`, Zuschnitt auf die Kernbox der deckenden Splats (+15 %),
Qualität `schnell`/`standard`/`hoch` = Gitter 512/1024/2048, 0,3/0,8/2 Mio. Dreiecke, Atlas 4096/4096/8192 →
GLB zurück. **Welche Lage gilt, wird gemessen** (`lage_messen`: Median-Abstand der Mesh-Punkte zum nächsten
deckenden Splat für die vier 180°-Drehungen; die Aufbereitung merkt sich dafür 12 000 Kernpunkte, ältere werden
beim Neuaufbau aus derselben PLY nachgeholt). **Am ersten echten Lauf (2026-10-21) war es `um_x_gekippt`** —
14 mm gegen 190 mm für „wie SPZ"; die frühere Wahl über die Überdeckung der Hüllboxen (`lage_waehlen`, jetzt nur
Rückfall) hatte bei der fast symmetrischen Szene mit 0,81 die falsche genommen, das Mesh stand verdreht im Viewer.
Nicht eindeutig (bester Abstand > 2 % der Ausdehnung oder zweitbester < 2 × bester) → `hinweis` im Bericht.
**Das Material von World Labs trägt die Textur zusätzlich als Emission** (Faktor 1); Cesium rendert das Mesh ohne
Normalen unbeleuchtet und addiert sie — die Emission wird beim Rückweg entfernt (`emission_entfernt`), sonst
liefen die Farben ins Weiß, und die Textur stünde zweimal in der Kachel. Das Tileset trägt
`extras.ileen_quelle: "photogrammetrie"`: der Viewer nimmt solche Modelle aus dem Neutralfarben-Shader
(`frontend/farben.js`), der sonst Eigenfarben grau macht. Gemessen: splats2Mesh `schnell` für 858 000 Splats
(SPZ 12,9 MB über den Upload-Weg > 10 MiB) in ~60 s, 300 000 Dreiecke, Textur 4120 × 4096. Abgelegt wird ein **eigenes Mesh-Asset** (neue Kennung,
`meta.json` → `aus_splat`), gekachelt über `tiling/formats/mesh.tile_mesh_objekt` (gibt den Zentrierversatz
zurück), mit **der Platzierung des Splats und dem Versatz als `base_transform`** — dann gelten für Mesh und
Splat dieselben Regeln (Verschieben, Höhenbezug, Geländeabgleich im Viewer), auch wenn jemand den Splat
später verschiebt und das Mesh neu rechnen lässt. Stand je Splat in `atlas/mesh/<splat_job>.json`,
Ergebnis-GLB von World Labs unter `atlas/mesh/<splat_job>/atlas.glb`. Beim Löschen eines Assets räumt
`atlas.purge()` den Stand ab (als Splat) bzw. löst den Verweis (als Mesh).

Prüfstein: `python3 tests/test_atlas.py [--exr <datei>]` (39: EXR-Aufbau und Rundlauf, Zeilenlage, Himmel/NaN,
Kameraprüfung, Anfragekörper samt Grenzen, Dateiname des Schlüssels wie in der CLI, Umgebung geht vor,
Fehlermeldungen 402/404). Ohne Netz und ohne Schlüssel.

Eingespielt am 2026-10-21 per `docker compose build api && up -d api` (neue Route, neues Volume
`/run/worldlabs`); dabei kam auch `./data/nutzung` erstmals an den Container. Vorher geprüft: der laufende
Container stimmte bis auf `main.py` mit dem Repo überein, es ging nichts per `docker cp` Eingespieltes verloren.

## Deployment auf dem Server

```bash
# Auf dem Server
git pull
docker compose up -d --build

# MinIO von außen erreichbar (optional, hinter Apache Proxy):
# ProxyPass /tiles-api/ http://localhost:8100/
```

## Wichtige Hinweise für Claude Code

1. **Nie** `semantic-pipeline/` anfassen — das ist ein eigenständiges Projekt.
   Das Backend steht unter **AGPL-3.0** (`backend/LICENSE`); Code aus Projekten mit
   unverträglicher Lizenz wird nicht übernommen.
2. Tiling-Ergebnisse landen immer in MinIO, nie direkt auf dem Dateisystem
3. PLY-Erkennung (Splat vs. Punktwolke) läuft über Header-Bytes, nicht über Dateiname
4. `TILES_PUBLIC_URL` bestimmt nur, welche URL `/assets/` ausgibt — lokal der
   API-Proxy (`:8100/tiles`), in Produktion der öffentliche MinIO-Bucket
5. **Kreuzberg läuft als Python-Bibliothek in-process**, nicht als Server.
   `kreuzberg serve` benötigt das separate Rust-CLI-Binary aus den GitHub-Releases,
   das im PyPI-Paket nicht enthalten ist. Kreuzberg kennt zudem weder IFC noch OBJ —
   IFC-Semantik kommt deshalb direkt aus IfcOpenShell (Typ, Name, Geschoss, Psets).
6. Neue Tiling-Handler müssen `georef.build_tileset()` + `georef.make_tile()`
   verwenden, sonst fehlt der `root.transform` und das Modell landet im
   Erdmittelpunkt — und `georef.write_placement()` aufrufen, sonst lässt sich
   das Ergebnis später nicht über das UI verorten
7. B3DM immer über `tiling/b3dm.py` schreiben — CesiumJS verweigert Tiles ohne
   `BATCH_LENGTH` in der Feature Table
8. GLB für IFC und Splats über `tiling/gltf.py` schreiben (Batch-IDs, Normalen,
   Splat-Extensions), für trimesh-Meshes über `tiling/glb.mesh_to_glb()` — nie
   direkt `mesh.export(file_type="glb")`, sonst fehlt das Material und Cesium
   rendert das Modell vollmetallisch, also weiß
8b. Ein Mesh-Tile ohne `NORMAL` schaltet CesiumJS auf `LightingModel.UNLIT` —
   das Modell erscheint dann als flache Farbfläche ohne Plastizität
9. Höhen im `root.transform` sind **immer** ellipsoidisch. Eingaben laufen über
   `elevation.to_ellipsoid()` — wer `placement["height"]` direkt in eine Matrix
   schreibt, versenkt das Modell um Gelände- plus Geoidhöhe
10. Der Job-Status liegt im Prozessspeicher, daher `--workers 1`. Für mehrere Worker
    bräuchte es einen geteilten Store (Redis)
11. `IfcOpeningElement` und `IfcSpace` sind Negativ- bzw. Raumvolumen und dürfen
    nicht getilet werden (`IFC_EXCLUDE_TYPES`) — die Wand hat ihr Loch schon,
    der Negativkörper steckt sonst als massiver Quader darin
12. Elementeigenschaften aus dem Iterator nie über `shape.product` lesen: diese
    `entity_instance` kennt ihre Datei nicht, `get_psets()` scheitert daran
    stumm. Richtig ist `ifc_file.by_id(shape.id)`
13. Beim Löschen eines Assets alle vier Stellen mitnehmen (siehe
    `api/routes/assets.delete_asset()`): `tiles/`- und `uploads/`-Präfix in
    MinIO, `properties.sqlite`-Cache (`elements.purge_cache()`) und
    LanceDB-Zeilen (`extractor.delete_job()`) — sonst bleiben Karteileichen
    liegen, die bei Job-ID-Kollisionen (praktisch nie, aber) falsche Treffer
    lieferten
14. Objekte unter `_terrain/` im tiles-Bucket sind kein Job — `assets.py`
    überspringt Präfixe, die mit `_` beginnen. Ein neues Präfix-Schema dort
    (z.B. `_irgendwas/`) muss denselben Schutz respektieren
15. Die lokale Geländereferenz ersetzt **nur** den DEM-Aufruf in
    `elevation.ground_msl()` — sie hat keinen Einfluss auf `root.transform`
    fertiger Tilesets. Wird sie neu gesetzt oder entfernt, ändern sich davon
    bereits gespeicherte Platzierungen nicht automatisch; nur ein erneutes
    Speichern der Platzierung rechnet mit dem neuen Bezug nach
16. Bauzeichnungen (`tiling/section.py`) schließen `IfcSpace` **immer** aus der
    gezeichneten Geometrie aus, unabhängig von `IFC_EXCLUDE_TYPES`: das
    Raumvolumen ist ein massiver Quader, der die Schnittebene voll trifft und
    jede Wand darunter zudeckt. Wer die Liste `_NEVER_DRAWN` anfasst, sollte das
    im Blick behalten. Als *Beschriftung* kommen die Räume trotzdem heraus —
    über `with_rooms=true` im Feld `rooms`, mit eigenem Cache und eigenem
    Iteratorlauf
17. Beim Löschen eines Assets kommt zu den vier Stellen aus Hinweis 13 eine
    fünfte: `plan.purge_cache()` für die lokale IFC-Kopie (`SOURCE_CACHE`), das
    Elementverzeichnis (`SECTION_CACHE`) und die Raumsemantik (`raumsem*.json`). Die IFC-Kopie ist die größte
    davon — sie liegt in Originalgröße auf der Platte
18. Und eine sechste: `fem.purge()` für die Statikrechnungen im `fem`-Bucket.
    Sie liegen bewusst außerhalb von `tiles/{job}/`, damit ein Re-Tiling nach
    einer Texturänderung sie nicht mitnimmt — dafür müssen sie beim Löschen
    des Assets eigens abgeräumt werden
18b. Eine Wand ergibt **ein** Linienlager auf ihrer Achse
    (`tragwerksmodell.wandachse()`), eine Stütze ein Punktlager auf ihrem
    Schwerpunkt (`schwerpunkt()`). `auflagerlinien()` ist seither nur noch
    die Vorstufe der Achse und darf nicht wieder direkt als Auflager
    verwendet werden — das wären zwei Lager je Wand und eine
    Einspannwirkung, die es nicht gibt
18c. Ein Eingriff am System zeigt **immer** auf eine GlobalId, nie auf eine
    Lagerkennung (`A7`): Lagerkennungen werden bei jedem Lauf neu vergeben,
    ein Eingriff darauf wanderte still auf ein anderes Bauteil
18d. Und eine siebte: `einsturz.purge()` für die Einsturzpakete im Bucket
    `einsturz`. Sie liegen aus demselben Grund wie die Statik außerhalb von
    `tiles/{job}/`: ein Re-Tiling nähme eine Rechnung von Stunden mit
18e. Themen (`/issues`) liegen in einer SQLite-Datei auf einem eigenen Volume
    und sind die einzigen Daten im Stack, die sich **nicht** neu rechnen
    lassen. Wer die Ablage austauscht (gaeco über Kafka), tauscht
    `ileen/issues_db.py` — der Router kennt weder SQL noch Dateipfade, und
    das soll so bleiben
18f. Der Weg nach gaeco führt **nur** über `api/routes/gaeco.py` und dessen Anmeldeprüfung —
    kein zweiter Endpunkt, der `gaeco_export.senden()` ruft. gaecos Kafka-Import prüft
    selbst nichts; jede Abkürzung wäre ein offener Schreibzugang in fremde Daten. Die
    Kennung bleibt `uuid5(NAMESPACE_DNS, GlobalId)` — geändert wird sie nur zusammen mit
    `gaeco/modul/assets/kennung.js` und den festen Paaren in beiden Prüfsteinen
19. In `ileen/` wird nur angeordnet und gezeichnet (`rechnung.py`). Alles
    Rechnerische gehört in `plate.py`, `scheibe.py`, `unterzug.py`, `beton.py`
    oder `loeser.py` und wird im Notebook geprüft — dieselben Dateien liegen in
    `~/Projekte/JaxFEM/ileen/`, und eine Änderung nur auf einer Seite lässt
    beide auseinanderlaufen
19a. Neunte Stelle beim Löschen: `atlas.purge()` — Mesh-Stand eines Splats im Bucket `atlas`; ein gelöschtes
    Mesh-Asset löst den Verweis im Stand seines Splats. Das Mesh selbst ist ein eigenes Asset und bleibt,
    wenn sein Splat gelöscht wird
19b. Beim Löschen eines Assets kommt als achte Stelle `splat_export.purge()` für die SOG-Exporte
    im Bucket `exports` dazu. Die Arbeitsdateien eines Foto-Trainings liegen in `data/training/<id>/`
    und gehören dem Auftrag, nicht dem Asset — „Entfernen“ im Panel löscht den Auftrag, „Löschen“ in
    der Assetliste das Asset; beide sind unabhängig
19c. Ein Asset mit `quelloffset` in den Splat-Extras lässt sich aus Quellkoordinaten verorten
    (`splatwerk/uebernahme.ankerpunkt`). Wer `tile_splat()` ändert und `recenter()` oder den
    Wurzelursprung anders wählt, ändert damit die Verortung aller Foto- und Scan-Splats — und
    `tests/test_splatwerk.py` Teil 2 schlägt an
20. `matplotlib.use("Agg")` muss vor dem ersten Pyplot-Import stehen (steht in
    `rechnung.py`): ohne Backend sucht matplotlib eine Anzeige und scheitert im
    Container an `$DISPLAY`. Jede Figur wird geschrieben und sofort geschlossen
    — matplotlib hält offene Figuren sonst bis zum Prozessende im Speicher, und
    eine Decke bringt über zwanzig davon mit
