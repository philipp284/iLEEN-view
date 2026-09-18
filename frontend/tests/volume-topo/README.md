# Topografisches Aufmaß — Prüfsteine

```sh
node test-topo.js          # Rechenteile, ohne Browser
node test-browser.mjs      # die Karte, in Chrome headless
npx vite --port 5193 &     # für den nächsten nötig
node test-kacheln.mjs      # die Kachelauswahl an echten Punktwolken
```

## `test-topo.js`

Geprüft werden die Rechenteile aus `volume-topo.js`, die ohne Szene
auskommen — zugänglich über `TopoVolume._internals`:

* **Punkte einsortieren** (`binPoints`) — Mittel, höchster und tiefster Punkt
  je Masche, und dass Punkte außerhalb des Rechtecks nicht mitzählen.
* **Lücken füllen** (`fillGaps`) — ein Loch zwischen gefüllten Maschen wird
  ergänzt, eine Masche mit nur einem gefüllten Nachbarn nicht. Ohne diese
  Schranke zöge sich ein Randwert Masche für Masche über das ganze Feld.
* **Flächenanteil am Rand** (`coverageGrid`) — innen 1, außen 0, an der
  Diagonalen eines Dreiecks die Hälfte.
* **Prismensumme** (`integrate`) — Auftrag, Abtrag, Netto, und was ein Loch
  bewirkt.
* **Bezugsebene** (`referencePlane`, `fitPlane`) — die vier Wahlmöglichkeiten,
  darunter die geneigte Ausgleichsebene und ihr entarteter Fall.
* **Maschenweite** (`autoCell`, `chooseCell` — einschließlich der Frage, ob
  eine erzwungene Vergröberung gemeldet wird), **runde Schritte** (`niceStep`),
  **Farbverlauf** (`rampColor`, `quantize`) und der **`.pnts`-Leser**
  (`parsePnts`) an einer selbst gebauten Kachel.
* **Bikubische Abtastung** (`sample`, `catmullRom`) — dass sie an den
  Maschenmitten exakt die gemessenen Werte liefert, an Kanten nicht über die
  vier Nachbarn hinausschießt und bei einem Loch in der 4×4-Nachbarschaft auf
  bilinear zurückfällt. Ein Überschwinger wäre eine Höhenlinie, die es nicht
  gibt; ein bikubisch überbrücktes Loch wäre erfundenes Gelände.
* **Kartenauflösung** (`mapScale`) — drei Bildpunkte je Masche, wo beide Deckel
  es zulassen, und je einer der beiden dort, wo er greift.
* **Panel und Modul** — dass jede Element-ID aus `ui.js` im Modul vorkommt
  und umgekehrt, und dass jeder Übersetzungsschlüssel in beiden Sprachen
  steht. Ein Tippfehler darin bricht nichts hörbar: die Einstellung bleibt
  still auf ihrem Vorgabewert oder der Schlüsselname erscheint als
  Beschriftung.

Vier Fälle sind bewusst festgeschrieben, weil sie in der Praxis vorkommen und
still falsch wären:

* **Löcher zählen nicht mit.** Eine Masche ohne Punkte mit der Bezugshöhe
  anzusetzen hieße zu behaupten, dort läge das Gelände genau auf Null. Die
  ausgefallene Fläche wird stattdessen ausgewiesen.
* **Der Flächenanteil geht linear ein.** Eine halb im Polygon liegende Masche
  zählt halb — sonst ist der Rand systematisch um eine halbe Maschenweite
  falsch.
* **Eine doppelt gesetzte Ecke ändert die Fläche nicht.** Der Doppelklick zum
  Abschließen erzeugt sie, wenn die Sperre in `onClick` einmal nicht greift.
* **Gegen eine geneigte Bezugsebene ist ein gleichmäßig geneigtes Gelände
  ausgeglichen.** Waagerecht gerechnet stünde dort die halbe Böschung in der
  Bilanz.

## `test-browser.mjs`

Braucht Chrome und `puppeteer-core` (`npm i --no-save puppeteer-core`), aber
weder Vite noch ein Backend — die Prüfseite `smoke.html` lädt `volume-topo.js`
über `file://` und kommt ohne Cesium aus.

Was hier und **nur** hier zu beantworten ist: ob aus dem Geländemodell eine
Karte wird. `renderMap` rechnet je Bildpunkt auf einer Leinwand — Maske,
Farbstufen, Schummerung und die Höhenlinien, die aus dem Gefälle entstehen
statt aus verfolgten Linienzügen. Ohne Leinwand gibt es davon nichts zu sehen
und nichts zu messen.

Geprüft wird an einem gebauten Gelände — Kegel, Mulde, rechteckiges Loch,
achteckiger Rand — mit bekannten Antworten:

| Frage | Antwort |
|---|---|
| außerhalb des Polygons | Alpha 0 |
| im Loch | Alpha 0 |
| Kuppe gegen Fuß | heller |
| Nordwestflanke gegen Südostflanke | heller (Licht aus Nordwesten) |
| über / unter der Bezugsebene, zweipolig | warm / kalt |

Die Flankenprüfung ist die wichtigste: mit dem Gefälle statt der
Flächennormalen beleuchtet kommt das seitenverkehrte Bild heraus, und das
sieht nicht falsch aus — es sieht aus wie ein Krater statt eines Berges.
Genau dieser Fehler stand hier einmal.

Der Lauf legt zusätzlich `karte.png` ab (nicht in Git), um die vier
Darstellungsarten nebeneinander ansehen zu können.

## `test-kacheln.mjs`

Braucht Chrome, `puppeteer-core`, einen laufenden Vite (Port 5193) **und** das
Backend mit der Punktwolke. Fehlt das Backend, überspringt der Prüfstein sich
selbst statt rot zu werden — er prüft fremde Daten, und deren Fehlen ist kein
Mangel am Code. Andere Wolke über `TILESET=…`.

Die Prüfseite `echt.html` lädt ein Tileset über `Cesium3DTileset.fromUrl`,
legt ein quadratisches Polygon in seine Mitte und fährt damit `buildContext`,
`selectTiles` und `collectPoints` — den echten Weg, ohne Szene. Ausgegeben
werden die gewählten Kacheln, die überlappenden Stufen und ein Belegungsfeld
von 24 × 24, in dem sich ein Loch von gleichmäßiger Dünne unterscheiden lässt.

Geprüft wird, dass unter einem Polygon, das ganz in der Wolke liegt, **überall**
Punkte ankommen (≥ 95 % der Felder belegt), dass eingebettete Kachelbäume
aufgelöst werden, und dass ein Polygon über die Wolke hinaus keine Punkte
verliert.

Zwei Fehler stehen hier fest, weil sie beide still waren und zusammen aus
720 Kacheln null machten:

* **Eine Kachel, deren Kinder alle außerhalb liegen, muss in der Auswahl
  bleiben.** Vorher fiel sie heraus — weder Blatt noch weitergereicht —, und
  mit ihr ihre Punkte. Das riss zusammenhängende Löcher genau dort, wo ein Ast
  am Polygonrand endete.
* **Eingebettete Tilesets müssen aufgelöst werden.** py3dtiles lagert dichte
  Bereiche in eigene `tileset.NN.json` aus; übersprungen fehlen genau die
  Stellen mit den meisten Punkten.
