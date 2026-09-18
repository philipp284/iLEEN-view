# iLEEN-view

Ein BIM/GIS-Viewer für das Web. Er lädt IFC-Modelle, Punktwolken und Gaussian
Splats als 3D Tiles, stellt sie georeferenziert auf das Gelände und gibt die
Werkzeuge dazu, die man am Modell braucht: messen, ausschneiden, beschriften,
auseinanderziehen.

Gebaut auf [CesiumJS](https://cesium.com/platform/cesiumjs/). Ohne Framework,
ohne Anmeldung, ohne Konto — ein Ordner statischer Dateien und ein Browser.

> **Was hier nicht drin ist.** iLEEN-view ist der Viewer. Die Auswerte- und
> Nachweiswerkzeuge der Vollfassung — Tragwerksberechnung, Lastabtrag,
> GEG-Energiebilanz, Bauablaufsimulation, Bewehrungsplanung, Verschattung —
> sind nicht Teil dieses Repos. Sie kommen als Module dazu, wenn sie so weit
> sind.

---

## Was er kann

| | |
|---|---|
| **Modelle** | 3D Tiles aus Cesium ion oder einem eigenen Backend: IFC (B3DM mit Bauteileigenschaften), Punktwolken (PNTS), Gaussian Splats. Mehrere gleichzeitig, jedes einzeln ausrichtbar in Lage, Höhe und Drehung. |
| **Untergrund** | Die Kamera darf unter das Gelände. Nullebene mit metrischem Raster, Erddecke von unten, Durchblick auf Modelle, die im Boden stecken. |
| **Navigation** | Gehen und Fliegen mit WASD, stufenlose Geschwindigkeitsrampe, Fadenkreuz mit gefangenem Zeiger, Kompass mit Höhe über NHN und über Grund. |
| **Messen** | Ein Modus für alles: ein Klick gibt eine Koordinate, zwei eine Strecke, drei und mehr Fläche, Umfang und Volumen. Fang auf Ecke, Kante, Silhouette und Raster. Wählbar, worauf gemessen wird — Modell, Splat oder Gelände. |
| **Topografisches Aufmaß** | Volumen unter einem Polygon aus den Punkten selbst, dazu eine Höhenschichtenkarte mit Schummerung. |
| **Schneiden** | Schnittbox um ein angeklicktes Bauteil, sechs Flächengriffe, wahlweise Inhalt freistellen oder ausstanzen. |
| **Bauteile** | Filter über die IFC-Klassen, Eigenschaften nach Fachrolle sortiert, Einzelne ausblenden und isolieren. |
| **Notizen** | Notizen an Bauteil, Splat oder freiem Punkt, im Modell verankert beschriftet, Export als BCF 2.1. |
| **Ansicht** | Geschosse auseinanderziehen und flach drücken, Geschossgrundrisse als Bild in den Stapel, Bild oder PDF ins Modell legen und auf die Bauteile projizieren. |
| **Rundgang** | 360°-Panoramen als begehbare Tour. |
| **Karten** | Luftbild, OpenStreetMap, Sentinel-2, Vektorkacheln von basemap.de, Weltgelände, OSM Buildings, Google Photorealistic 3D Tiles. |

Oberfläche und Hilfetexte gibt es auf Deutsch und Englisch.

---

## Loslegen

```bash
git clone <dieses-repo> iLEEN-view
cd iLEEN-view/frontend
npm install
cp config.example.js config.js     # ion-Token und Backend-Adresse eintragen
npm run dev                        # → http://localhost:5190
```

`config.js` ist bewusst nicht im Repo: dort steht der ion-Zugriffsschlüssel,
und ein Token im Verlauf einer Versionsverwaltung ist auch nach dem Widerrufen
noch dort. Beide Werte lassen sich außerdem zur Laufzeit in der Oberfläche
setzen (Einstellungen → Cesium ion, Modelle → Modell-Browser).

**Ohne ion-Token** startet der Viewer auf dem Ellipsoid mit OpenStreetMap.
Weltgelände, Luftbild und ion-Assets fehlen dann; Modelle aus einem eigenen
Backend laden trotzdem.

**Bauen:** `npm run build` legt einen statischen Ordner unter `frontend/dist/`
ab. Er braucht keinen Server außer einem, der Dateien ausliefert.

---

## Woher die Modelle kommen

Zwei Wege, beide unabhängig voneinander:

**Cesium ion** — Asset-ID im Panel *Asset Browser* eintragen. Die Assets des
hinterlegten Kontos stehen als Vorschlagsliste bereit.

**Eigenes Backend** — ein Dienst, der 3D Tiles ausliefert und unter
`GET /assets/` eine Liste davon führt. Erwartet werden je Modell `job_id`,
`name`, `content_type` (`ifc` · `pointcloud` · `splat` · `mesh`) und
`tileset_url`. Der Viewer nutzt darüber hinaus optional
`GET /assets/{job}/elements/{guid}` für die vollständigen Property-Sets eines
Bauteils, `…/storeys` für das Geschossverzeichnis und `POST /assets/{job}/section`
für Geschossgrundrisse — fehlt eines davon, entfällt genau dieses Werkzeug und
sonst nichts. Die Adresse steht in `config.js` unter `backendUrl`.

Der Viewer parst **kein IFC**. Alles, was er über ein Bauteil weiß, steht in
der Batch Table des Tiles (`GlobalId`, `IfcType`, `Name`, `Geschoss`) oder
kommt aus dem Backend.

---

## Wie er gebaut ist

Klassische Skripte, kein Modulbündel, kein Framework. Jede Datei legt ihren
eigenen globalen Namen an oder hängt sich an `BimViewer`; `index.html` bindet
sie in einer Reihenfolge ein, die den Abhängigkeiten folgt.

```
i18n.js            Sprachumschaltung (muss zuerst laden)
core.js            Viewer, Modellverwaltung, das BimViewer-Objekt
shader-verbund.js  mehrere Werkzeuge an EINEM customShader
features.js        IFC-Filter, Auswahl, Eigenschaften
pointcloud.js      Detailstufe, Punktgröße, Eye-Dome-Lighting, Farbmodus
splat-pick.js      Anklicken von Gaussian Splats (die schreiben keine Tiefe)
aufmass*.js        Messen samt Fang
volume-topo.js     topografisches Aufmaß
section-box.js     Schnittbox
explosion.js       Geschosse auseinanderziehen
tags.js            Notizen · annotations.js zeichnet sie
layerManager.js    Karten, Gelände, 3D-Ebenen
ui.js              die Oberfläche
```

Zwei Regeln, an denen im Zweifel alles hängt:

* **`tileset.customShader` wird nie direkt gesetzt.** Vier Werkzeuge wollen
  denselben einen Steckplatz; `shader-verbund.js` setzt sie als Bausteine
  zusammen.
* **Bauteileigenschaften kommen über `feature.getProperty()`**, nie aus einem
  eigenen IFC-Parser, und werden nie exakt verglichen: dieselbe Angabe heißt
  je nach Autorensoftware und Sprache anders.

---

## Prüfsteine

```bash
cd frontend
for f in tests/*/test-*.js; do node "$f"; done   # ohne Browser

npx vite --port 5190 &                            # für die Browser-Prüfsteine
npm i --no-save puppeteer-core
node tests/start/test-start.mjs                   # startet die App wirklich?
```

`tests/start/test-start.mjs` ist der wichtigste davon. Alle anderen laden ein
Modul in eine `vm` und prüfen seine Rechnung — das sagt viel, aber nicht, ob
die fünfzig Skripte zusammen hochkommen. Genau dort entstehen die Fehler, die
keine Fehlermeldung erzeugen, sondern ein Werkzeug, das stillschweigend nichts
tut.

---

## Lizenz

© 2026 Philipp Schäfer — [PolyForm Noncommercial 1.0.0](LICENSE.md).
Nutzung, Änderung und Weitergabe für nichtkommerzielle Zwecke frei; für eine
kommerzielle Nutzung wird eine gesonderte Vereinbarung gebraucht.

Fremdsoftware und ihre Lizenzen stehen in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). CesiumJS steht unter
Apache-2.0 und ist davon nicht berührt.
