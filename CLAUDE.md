---
title: "iLEEN-view — BIM/GIS-Viewer"
type: project
scope: development
status: active
technology: [CesiumJS, JavaScript, Vite, 3D-Tiles, IFC]
license: "PolyForm-Noncommercial-1.0.0"
related:
  - path: /Users/philippschafer/Projekte/iLEEN/frontend/CLAUDE.md
    label: iLEEN Vollfassung (Viewer + Auswertungen), Entwicklung auf GitLab
---

# iLEEN-view — Projektkontext

**Der Viewer, ohne die Auswertungen.** Dieses Repo ist der Auslieferungsstand
für GitHub; entwickelt wird in der Vollfassung `~/Projekte/iLEEN` (GitLab).
Was hier steht, ist eine **Teilmenge** davon — keine Abzweigung.

## Welches Repo? Die Entscheidung vorab

Zwei Repos, und die Verwechslung ist der teuerste Fehler, den man hier machen
kann. Die Frage ist immer dieselbe: **steht das Werkzeug links oder rechts?**

| | links in der Leiste | rechts in der roleBar |
|---|---|---|
| **Was** | Viewer: laden, ansehen, messen, markieren | Auswertung: rechnen, nachweisen, berichten |
| **Repo** | `~/Projekte/iLEEN-view` → GitHub | `~/Projekte/iLEEN` → GitLab |
| **Anmeldung** | `BimViewerUI.bereichAnmelden()` / `.gruppeAnmelden()` | `RightPanel.reiterAnmelden()` |

Daraus folgt für jede Aufgabe:

* **Ein Viewer-Werkzeug ändern** (Messen, Punktwolke, Bildebenen, Rundgang,
  Schnitt, Explosion, Navigation, Sensoren, Präsentation, Handbuch) → in
  `~/Projekte/iLEEN` ändern, dann hierher übernehmen. Die Datei ist in beiden
  Fassungen dieselbe.
* **Ein Analysewerkzeug ändern oder neu bauen** (Tragwerk, GEG, Bericht,
  StaLite, Solar, Kollision, Bauplaner, Bauzeitsimulation, Flugverkehr,
  Raumkonzept, Volumen, Einsturz, Issue-Manager) → **nur** `~/Projekte/iLEEN`.
  Es kommt nie hierher.
* **Am Panelgerüst selbst arbeiten** (`ui.js`, `right-panel.js`) → in der
  Vollfassung, dann übernehmen. Diese beiden Dateien sind byte-identisch, und
  das ist Absicht: sie kennen kein einziges Werkzeug.

Im Zweifel entscheidet nicht das Thema, sondern die Seite. „Aufmaß" ist links
und damit Viewer; „Mengen und CO₂ aus dem Aufmaß" ist eine Auswertung und
bleibt in der Vollfassung.

## Die Regel, die alles andere bestimmt

**Geändert wird in der Vollfassung, übernommen wird hierher.** Wer hier eine
Datei ändert, die es dort auch gibt, erzeugt zwei Stände desselben Moduls, und
beim nächsten Übernehmen gewinnt einer von beiden stillschweigend. Ausnahmen,
in denen die Fassungen wirklich auseinandergehen, stehen unten namentlich.

Was hier **nicht** liegt, und zwar mit Absicht:

| Bereich | Module |
|---|---|
| Tragwerk | `tragwerk-*.js`, `fe-browser.js`, `volumen-*.js` |
| Plan und Bewehrung | `plan-*.js` (14 Dateien) |
| Energie | `geg-tool.js`, `geg-huelle.js` |
| Bauablauf | `konzept-*.js`, `sim4d-*.js`, `ifc-4d*.js`, `sequencing.js` |
| Entwurf | `bauplaner-*.js`, `room-concept.js` |
| Weiteres | `solar.js`, `stalite-tool.js`, `bericht.js`, `ifclash.js`, `flight-tracker.js` |
| Rechts seit September | `einsturz.js`, `einsturz-panel.js` (💥), `issue-manager.js` (ISS) |
| Aufmaß-Anhänge | `aufmass-rdf.js` (Turtle-Graph), `aufmass-mengen.js` (Mengen, CO₂) |

Die beiden letzten hängen am Bauteilverzeichnis des Backends. `aufmass.js`
selbst ist unverändert übernommen — es fragt beide über `window.X &&` ab und
kommt ohne sie aus.

## Was hier anders ist als in der Vollfassung

Drei Dateien gehen auseinander. Sie sind der einzige Grund, warum ein
Übernehmen nicht `cp -R` sein kann:

| Datei | Unterschied |
|---|---|
| `index.html` | die Einbindungen der Auswertungen fehlen |
| `aufmass-panel.js` | ohne den Abschnitt „Graph" (Turtle-Ausgabe, Fokus-Regler) |
| `vite.config.js` | **Port 5190** statt 5181 |
| `config.js` | nicht im Repo; `config.example.js` ist die Vorlage |

**`ui.js` und `right-panel.js` gehörten bis zur Trennung in diese Liste.** Sie
gehen jetzt nicht mehr auseinander, weil die Auswertungen aus ihnen heraus in
eigene Anmelde-Dateien gewandert sind — `getClashContent()` nach
`ifclash-panel.js`, `getRoomConceptContent()` nach `room-concept-panel.js`, die
Reiter Solar und BIM-LP nach `solar-panel.js` und `bimlp-panel.js`. Alle vier
liegen ausschließlich in der Vollfassung. Wer sie hierher kopiert, hebt die
Trennung auf; `tests/trennung/test-trennung.mjs` schlägt dann an.

**Notizen liegen seit September 2026 im Backend, nicht nur im Browser.**
`issues-store.js` ist mitgekommen (es hängt an `tags.js`, und das ist links,
also Viewer): geschrieben wird zuerst lokal, danach an `/issues`; was nicht
durchgeht, wird vorgemerkt und nachgeholt. Läuft kein Backend oder kennt es die
Route nicht, bleibt alles beim Alten — der `localStorage` trägt dann allein.
**Der Issue-Manager** (Reiter ISS, Verlauf, BCF, Bericht) ist eine Auswertung
und steht ausschließlich in der Vollfassung; er hierher zu kopieren hebt die
Trennung auf.

**Der Port ist keine Kleinigkeit.** Beide Fassungen führen `strictPort: true`.
Läuft die Vollfassung auf 5181 und hier stünde ebenfalls 5181, startet dieser
Server gar nicht — und der Browser-Prüfstein bekommt HTTP 200 von der
*anderen* Anwendung und meldet Module als vorhanden, die es hier nicht gibt.
Genau das ist beim Aufsetzen zweimal passiert (einmal die Vollfassung, einmal
eine fremde React-App auf 5182). `tests/start/test-start.mjs` prüft deshalb als
Erstes den Seitentitel.

## Wie ein Werkzeug dazukommt

Beide Seiten sind Steckplätze. Kein Panelgerüst kennt ein Werkzeug; jedes
Werkzeug meldet sich selbst an. Die Ladereihenfolge ist dabei gleichgültig —
wer sich spät anmeldet, löst einen Neuaufbau aus und erscheint trotzdem.

### Links: ein Viewer-Bereich

```js
BimViewerUI.bereichAnmelden({
  id: 'rundgang', symbol: '📷', ordnung: 60,
  titel: () => t('panel.rundgang'),      // Funktion, damit der Sprachwechsel greift
  inhalt: () => Rundgang.markup(),       // String oder Funktion
  beimOeffnen: () => Rundgang.laden(),   // optional, bei jedem Öffnen
});
```

Eine Untergruppe in einem bestehenden Bereich:

```js
BimViewerUI.gruppeAnmelden('models', {
  key: 'panotour', ordnung: 40,
  label: '360°-Rundgang',
  inhalt: panelHtml,
});
```

`ordnung` bestimmt die Reihenfolge, **nicht** der Zeitpunkt der Anmeldung —
sonst hinge die Anordnung der Symbole an der Reihenfolge der `<script>`-Zeilen
in `index.html`. Die Viewer-Bereiche liegen auf 10…90.

`titel`, `label`, `inhalt` und `angeheftet` dürfen Funktionen sein und sollten
es sein, wo `t()` im Spiel ist: der Sprachwechsel baut die Leiste neu auf und
wertet sie dabei erneut aus. Als fester String eingetragen, bliebe die
Beschriftung in der Sprache des Anmeldezeitpunkts stehen.

### Rechts: ein Analysereiter

```js
RightPanel.reiterAnmelden({
  id: 'geg', kuerzel: 'GEG', symbol: '🌡', titel: 'Gebäudeenergie', breite: 420,
  aufbauen: (behaelter) => { … },   // einmal, baut das Markup
  oeffnen:  () => { … },            // bei jedem Anzeigen
  schliessen: () => { … },          // beim Wegschalten
});
```

`schliessen` ist nicht Zierde: ein Werkzeug, das einen Klickfänger in die Szene
hängt, muss ihn beim Wegschalten abräumen — sonst bedient man längst einen
anderen Reiter und die Klicks gehen weiter ans alte Werkzeug.

Braucht das Werkzeug einen Namen am Gerüst, weil sein Markup ihn als
`onclick`-Attribut ruft (also aus dem globalen Sichtbarkeitsbereich) oder weil
ein anderes Modul ihn erwartet, hängt es ihn selbst an:

```js
RightPanel.brueckeAnmelden({ solarShowLoading, solarShowError });
```

Fehlt das Werkzeug, fehlt der Name — ein Aufruf läuft dann in einen klaren
`TypeError` statt in ein stilles Nichts.

### In dieser Fassung ist rechts nichts angemeldet

`right-panel.js` wird trotzdem ausgeliefert. Es ist die leere Fassung, in die
sich ein Analysewerkzeug einhängen **kann** — wer eines dazunehmen will,
braucht eine Datei und eine `<script>`-Zeile, sonst nichts. Die roleBar zeigt
hier nur die Rollenknöpfe (Explore · Visualize · Measure); die sind Viewer, kein
Werkzeug.

## Architektur

Klassische Skripte, kein Bündel, kein Framework. Jede Datei legt einen globalen
Namen an oder hängt sich an `BimViewer`; `index.html` gibt die Reihenfolge vor.
Die ausführliche Herleitung jedes Moduls steht in der CLAUDE.md der
Vollfassung — hier nur, was ohne sie nicht zu erraten ist:

* **`tileset.customShader` wird nie direkt gesetzt**, immer über
  `BimViewer.ShaderVerbund`. Rückseitenschnitt, Explosion, Schnitt,
  Bildprojektion und das Kunstlicht wollen denselben einen Steckplatz.
* **Licht kommt bei Cesium nur von der Sonne** — `scene.light` ist ein
  einzelner Steckplatz, Schattenkarten gibt es nur für ihn, und innen kommt
  von ihr nichts an. `licht.js` legt deshalb Grundaufhellung und Taschenlampe
  (Taste **L**) im Materialshader nach, über `material.emissive`: `diffuse` ist
  die Albedo und macht eine unbeleuchtete Wand nicht heller. Der Lichtkegel
  rechnet in Augenkoordinaten — dort sitzt die Kamera im Ursprung und blickt
  entlang −Z, weshalb er ohne ein einziges je Bild nachgeführtes Uniform
  auskommt. Herleitung in der CLAUDE.md der Vollfassung.
* **Der Farbstich ist hausgemacht, nicht Cesiums Schuld allein.** `farben.js`
  fasst die drei Ursachen zusammen: die Typfarben aus `IFC_ENTITIES`
  (`IfcCovering` beige, `IfcWindow` hellblau) — dagegen das Farbschema
  `'neutral'` aus `IFC_FARBEN_NEUTRAL`; die dunkelbraune Eigenfarbe der
  IFC-Materialien — dagegen ein **Grundton** im Materialshader, denn ein
  entsättigtes Dunkelbraun ist nur ein dunkles Grau; und Cesiums gedachten
  Erdboden `AVERAGE_EARTH_GROUND_COLOR` = `#717145` in der
  Umgebungsbeleuchtung. **Falle:** `groundColor`, `saturation` und `brightness`
  am `DynamicEnvironmentMapManager` sind Felder ohne Setzer — ohne
  `manager.reset()` bleibt jede Änderung stumm. Herleitung und Messwerte in der
  CLAUDE.md der Vollfassung.
* **Der Reiter „Schnitte“ gehört ui.js, sein Inhalt den Modulen.** Seit
  Oktober 2026 setzt `schnitt-karte.js` das Schnittwerkzeug davor (eine Box über
  **alle** Modelle, beliebig viele Scheiben, die Schnittkarte oben rechts),
  `ui-new-features-extension.js` hängt die Google-Freistellung an — beide, indem
  sie `BimViewerUI.getDrawingContent` umschließen. `schnitt.js` hat
  `schnitte-xyz.js` und `section-box.js` abgelöst und führt
  `BimViewer.SectionBox` als alte Schnittstelle weiter. „Als Detail zeichnen"
  und ◫ je Scheibe brauchen den Zeichenmodus (`plan-*.js`) und erscheinen hier
  deshalb nicht — `schnitt-karte.js` fragt beim Aufbau des Reiters nach
  `BimViewer.Plan2D`.
* **Sensoren** (`sensor-store.js`, `sensor-farben.js`, `sensor-panel.js`):
  Messwerte aus `/sensoren/stand` des Backends, Geschosse nach Messwert
  eingefärbt. Der Knopf 📈 nutzt den Steckplatz **`aktion`** der Leiste: er
  schaltet ein Panel über der Szene, statt die Seitenleiste aufzuklappen.
  `sensor-farben.js` setzt keinen eigenen Stil, sondern liefert Bedingungen,
  die `features.js` in den einen Stil des Tilesets einreiht. Ohne Backend
  bleibt die Ablage still (eine Warnung, keine Wiederholung).
* **Präsentation und Zustands-Registry** (`praesentation*.js`, `zustand.js`,
  `zustand-anmelder.js`): Folien aus Kamerapose, Markdown-Text und der Szene,
  Untergruppe im Bereich 📷 Ansicht. Die Anmelder fragen fehlende Werkzeuge
  erst beim Aufruf ab und liefern dann nichts — der Zuschnitt ändert an ihnen
  nichts.
* **Erklärtexte und Handbuch** (`hinweise.js`, `hilfe.js`). Das Handbuch ist in
  beiden Fassungen dieselbe Datei: Einträge mit **`braucht`** erscheinen nur,
  wenn ihr Werkzeug geladen ist, und ein Kapitel ohne Einträge fällt samt
  Navigation weg. Hier fehlen deshalb Plan, Tragwerk, Energie, Konzept und
  Bericht, und der Anfang erklärt die rechte Leiste als Rollen statt als
  Analysepanel. Ein neues Auswertungskapitel in der Vollfassung braucht ein
  `braucht` — sonst steht es hier im Handbuch.
* **📍 Lage ins Backend** (`lage-backend.js`) schreibt Verschiebung und Drehung
  aus dem ✥-Flyout als Platzierung ins Backend — nur für Modelle mit Job-ID
  aus dem eigenen Backend. Sein Prüfstein (`tests/lage-backend/`) bleibt in der
  Vollfassung: er ruft die echte Placement-Route aus `backend/` auf.
* **In der Modellzeile stehen nur 🎯, ✥ und ✕.** Notizen, Baustufen und
  Schnittbox hatten dort einen zweiten Einstieg; seit 2026-09-19 sind sie
  heraus. Baustufen gibt es in dieser Fassung ohnehin nicht (`sequencing.js`
  liegt nur in der Vollfassung) — der Knopf zeigte hier ins Leere.
* **Bauteileigenschaften nur über `feature.getProperty()`**, nie über einen
  eigenen IFC-Parser, und nie exakt verglichen — Revit, Allplan, ArchiCAD und
  Tekla benennen dieselbe Angabe unterschiedlich und in zwei Sprachen.
* **In gaeco läuft dieser Viewer im Rahmen.** `gaeco-bruecke.js` spricht das
  Protokoll `ileen-gaeco/1` mit dem gaeco-Modul (das Modul selbst, der Export
  und die Einrichtung liegen nur in der Vollfassung: `gaeco/`, `backend/`).
  Angenommen wird nur, was vom Elternfenster kommt und von einem Origin aus
  `ILEEN_CONFIG.gaecoOrigins`. Gebaut auf drei Stellen, die jedes Panel nutzen
  kann: die Ereignisse `ileen:auswahl` (features.js) und `ileen:modelle`
  (core.js) und `BimViewer.bauteilAnfliegen()`. Allein geöffnet tut die Brücke
  nichts. In gaeco ist dieser Stand das Modul **„iLEEN-view"** (Route `/ileen-view`),
  und zwar **ohne Vite**: der Container `ileen-view-viewer` (Compose-Projekt
  `ileen-gaeco` in der Vollfassung, `gaeco/compose.yml`) liefert dieses
  `frontend/` unverändert auf http://localhost:5194 aus. Deshalb gilt hier
  weiter: kein Code, der nur unter dem Vite-Server läuft (`import.meta`,
  npm-Importe im Browser) — sonst ist iLEEN-view in gaeco kaputt, ohne dass der
  Dev-Server es zeigt. Prüfen: `VIEWER_URL=http://localhost:5194/ node
  tests/start/test-start.mjs`. Beschreibung: `GAECO-INTEGRATION.md` der Vollfassung.
* **Jede neue Datei trägt den Lizenzkopf** (`PolyForm-Noncommercial-1.0.0`).
* **Kein Code aus `~/Projekte/CesiumJS`** — das Repo enthält Code unter fremder
  Lizenz. Die einzige Gemeinsamkeit mit anderen Cesium-Anwendungen ist
  CesiumJS selbst.

## Tilesets: die zwei Fallen

Das Backend kachelt mit **`refine: "ADD"`** — jedes Bauteil kommt im Baum genau
einmal vor, grobe Ebenen tragen die großen Dinge. Zwei Folgen, die man kennen
muss:

1. **`skipLevelOfDetail` und sein Gefolge wirken hier nicht.** Cesium wendet sie
   nur bei REPLACE an (`replace &&` in `updateVisibility`). Sie standen
   jahrelang in den Ladeoptionen und sahen aus wie eine Einstellung.
2. **Ein voller Kachelspeicher lässt Bauteile verschwinden.** Cesium führt
   neben `maximumScreenSpaceError` einen zweiten Wert,
   `memoryAdjustedScreenSpaceError`, und erhöht ihn **je Bild um zwei Prozent**,
   solange `cacheBytes` überschritten ist. Bei ADD blendet ein Tile, dessen
   Fehler darunterfällt, ganz aus — es gibt keine gröbere Fassung, die
   einspränge. Das ist die Ursache von „die Außenbauteile großer Projekte
   verschwinden, obwohl ich nah dran bin": nicht die Entfernung, der Speicher.

`BimViewer.meshLoadOptions()` setzt deshalb `cacheBytes` **in den
Konstruktoroptionen** (ein Nachtrag käme zu spät, die ersten Kacheln laden
vorher), und `_speicherWacheStarten()` zieht ihn nach, wenn der geführte Wert
davonläuft.

Punktwolken haben ihren eigenen Satz: `BimViewer.pointCloudLoadOptions()`.
Der Hebel für die Bildrate ist `maximumScreenSpaceError` (Vorgabe 16, nicht 8),
und die Abschwächung ist die Gegenleistung dafür — gröber geladen, größere
Punkte, im Bild dieselbe Dichte.

## Prüfsteine

```bash
cd frontend

# 1 · Der Zuschnitt — ohne Browser, Sekundenbruchteile.
#     Der letzte Griff vor jedem Commit und nach jedem Übernehmen.
node tests/trennung/test-trennung.mjs

# 2 · Die Rechenkerne
for f in tests/*/test-*.js; do node "$f"; done

# 3 · Der Start im echten Browser
npx vite --port 5190 &
npm i --no-save puppeteer-core
node tests/start/test-start.mjs

# 4 · Das Kunstlicht — braucht denselben Dev-Server
VIEWER_URL=http://localhost:5190/ node tests/licht/test-browser.mjs

# 5 · Präsentation und Szene je Folie — derselbe Dev-Server
node tests/zustand/test-browser.mjs
node tests/praesentation/test-browser.mjs

# 6 · Derselbe Start ohne Vite, wie gaeco ihn ausliefert (Container)
VIEWER_URL=http://localhost:5194/ node tests/start/test-start.mjs

# 7 · Die Brille (vr.html) mit nachgebildeter Quest 3 — braucht Backend + Internet
node tests/vr/test-vr-rechnen.mjs
VIEWER_URL=http://localhost:5194/ node tests/vr/test-vr.mjs
VIEWER_URL=http://localhost:5194/ node tests/vr/test-vr-tablet.mjs   # Tablet, Ebenen, Welt, Karte, Werkzeuge
```

**`vr.html` ist ein zweiter Einstieg neben `index.html`** — VR in der Brille
(Meta Quest 3), mit three.js und `3d-tiles-renderer` vom CDN, ohne Build. Der
Zuschnitt-Prüfstein zählt deshalb auch, was weitere Seiten laden und was deren
Module relativ importieren (seit 2026-10-21 auch das Tablet mit Ebenen, Welt
und Minikarte: `vr-tablet.js`, `vr-seiten.js`, `vr-ebenen.js`, `vr-welt.js`). Herleitung und Fallen: CLAUDE.md der Vollfassung,
Abschnitt „VR in der Brille". In die Brille ohne Entwicklermodus:
`frontend/tools/quest-wlan.sh` (HTTPS im WLAN, Port 5443). Mit
Entwicklermodus per USB: `frontend/tools/quest.sh` (`ILEEN_PORT=5190` für den
Vite-Server dieser Fassung).

`tests/trennung/test-trennung.mjs` liest nur Dateinamen und `index.html`: liegt
hier eine Datei, die nicht hierhergehört? Bindet `index.html` eine ein? Kennt
`ui.js` eine Auswertung beim Namen? Meldet `right-panel.js` wieder selbst einen
Reiter an? Er braucht weder Chrome noch Dev-Server und ist deshalb der
Prüfstein, den man tatsächlich laufen lässt.

`tests/start/test-start.mjs` ist der wichtigste. Die übrigen laden ein Modul in
eine `vm` und prüfen seine Rechnung; ob die fünfzig Skripte **zusammen**
hochkommen, sagt keiner von ihnen. Genau dort entstehen die Fehler eines
Zuschnitts: ein Modul greift ungeschützt auf ein entferntes zu, der Browser
wirft beim Laden, der Rest der Datei läuft nicht mehr — und das Ergebnis ist
kein Absturz, sondern ein Werkzeug, das stillschweigend nichts tut.

Er prüft deshalb beide Richtungen: dass jedes Viewer-Modul da ist **und** dass
kein Analysewerkzeug übrig geblieben ist. Ohne die zweite Hälfte fiele nicht
auf, wenn eines über eine vergessene Einbindung zurückkommt — und dann läge es
im GitHub-Repo.

Seit der Trennung prüft er zusätzlich die Steckplätze selbst: dass rechts
**kein einziger** Reiter angemeldet ist, dass sich keine Auswertung an die
Brücke gehängt hat, dass links keine Auswertungs-Gruppe steht — und dass beide
Anmeldewege benutzbar sind. Der letzte Punkt ist kein Selbstzweck: eine Fassung,
die sauber, aber nicht mehr erweiterbar ist, hat den Zweck der Trennung
verfehlt.

Eine Feinheit, die zweimal Zeit gekostet hat: `RightPanel` ist ein `const` im
Skript-Bereich und steht **nicht** auf `window`. Eine Prüfung über
`window.RightPanel` ist immer `undefined` und damit immer grün. Im Prüfstein
steht deshalb der blosse Name. Dieselbe Falle saß bis Oktober 2026 in der Liste
der verbotenen Namen: `SolarPanel`, `BimLpPanel`, `IFClashPanel` und
`RoomConceptPanel` sind ebenfalls `const` und wurden über `window[name]`
geprüft — die Prüfung hätte nie angeschlagen. Sie läuft jetzt als
`typeof <Name>` im Seitenkontext.

Seit dem Abgleich vom Oktober 2026 prüft der Start-Prüfstein zusätzlich die
übernommenen Werkzeuge: die Zustands-Registry liest ohne Fehler, der Reiter
„Schnitte" trägt das Schnittwerkzeug **ohne** „Als Detail zeichnen", der
Sensorknopf ist ein Aktionsknopf, die Präsentation hängt unter Ansicht, und das
Handbuch nennt kein Auswertungskapitel.

## Sprache

Kommunikation und Quelltextkommentare auf Deutsch. `t('schluessel')` im
JavaScript, `data-i18n="schluessel"` im Markup; Standard ist Deutsch, Englisch
vollständig gepflegt. Ein fehlender Schlüssel gibt sich selbst aus — der
Start-Prüfstein sucht danach im fertigen Markup beider Sprachen.
