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
  Schnittbox, Explosion, Navigation) → in `~/Projekte/iLEEN` ändern, dann
  hierher übernehmen. Die Datei ist in beiden Fassungen dieselbe.
* **Ein Analysewerkzeug ändern oder neu bauen** (Tragwerk, GEG, Bericht,
  StaLite, Solar, Kollision, Bauplaner, Bauzeitsimulation, Flugverkehr,
  Raumkonzept, Volumen) → **nur** `~/Projekte/iLEEN`. Es kommt nie hierher.
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
  `BimViewer.ShaderVerbund`. Rückseitenschnitt, Explosion, Schnittbox und
  Bildprojektion wollen denselben einen Steckplatz.
* **Bauteileigenschaften nur über `feature.getProperty()`**, nie über einen
  eigenen IFC-Parser, und nie exakt verglichen — Revit, Allplan, ArchiCAD und
  Tekla benennen dieselbe Angabe unterschiedlich und in zwei Sprachen.
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
```

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
steht deshalb der blosse Name.

## Sprache

Kommunikation und Quelltextkommentare auf Deutsch. `t('schluessel')` im
JavaScript, `data-i18n="schluessel"` im Markup; Standard ist Deutsch, Englisch
vollständig gepflegt. Ein fehlender Schlüssel gibt sich selbst aus — der
Start-Prüfstein sucht danach im fertigen Markup beider Sprachen.
