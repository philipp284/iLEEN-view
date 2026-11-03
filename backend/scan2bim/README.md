# Scan2BIM — von der Punktwolke zum platzierten Bauwerksmodell

Rohe Punktwolke hinein, georeferenziertes IFC- und GLB-Modell im Backend
heraus, ohne Handgriff dazwischen.

```
LAS/LAZ → Rasterstatistik → Gelände → Baugrube/Verkehr → Objekte
        → Geländenetz → GLB + IFC → als Modelle abgelegt, exakt auf der Quellwolke
```

## Aus dem Viewer starten

Im Asset-Manager (`/ui`) eine Punktwolke wählen, unter **Rekonstruktion zu BIM**
das Netz einstellen, Knopf drücken. Über HTTP ist das:

```http
POST /assets/{job_id}/scan2bim
{
  "netz": "adaptiv",       // oder "fest"
  "toleranz_m": 0.15,      // nur adaptiv
  "maschenweite_m": 1.0,   // nur fest
  "projekt": "Sparkasse Weisenau"
}
→ { "lauf_id": "…", "status": "queued" }

GET /assets/{job_id}/scan2bim/{lauf_id}     Status, Anteil, nach dem Ende der Bericht
```

Die `job_id` ist die der Punktwolke — und damit zugleich die Quelle der
Georeferenz. Das Ergebnis liegt deshalb ohne Nacharbeit deckungsgleich auf der
Wolke, aus der es stammt.

Ein Lauf zur Zeit; die Zellstatistik hält die ganze Wolke im Speicher.

## Von der Kommandozeile

```bash
python3 -m scan2bim.cli --las scan.las --out ./ergebnis \
        --referenz-job 95a481dd-… --netz adaptiv --toleranz 0.10
```

Abhängigkeiten stecken in `backend/requirements.txt`; im API-Container ist
alles vorhanden.

## Das Geländenetz — fest oder adaptiv

Der einzige Parameter, der die Ausgabe grundlegend verändert.

**fest** — regelmäßiges Gitter mit vorgegebener Maschenweite. Vorhersehbar in
Größe und Laufzeit, richtig dort, wo das Ergebnis rasterweise
weiterverarbeitet wird.

**adaptiv** — ein TIN nach *greedy insertion* (Garland/Heckbert 1995): beginne
mit den Ecken, interpoliere, setze einen Stützpunkt an der größten Abweichung,
wiederhole, bis überall die Toleranz eingehalten ist. Die Punktzahl ist damit
Ergebnis, nicht Vorgabe.

`toleranz_m` ist eine **Genauigkeitsangabe**, keine Feinheitsstufe: 0,08 m
heißt „das Netz weicht nirgends mehr als acht Zentimeter vom gerasterten
Gelände ab". Am Sparkassen-Datensatz (241 × 213 m, 20-cm-Raster):

| Einstellung | Stützpunkte | Dreiecke | größte Abweichung |
|---|---|---|---|
| fest, 1,0 m | 51.546 | 35.666 | — |
| fest, 2,5 m | 8.989 | 5.994 | — |
| adaptiv, 0,20 m | 4.250 | 6.133 | 0,200 m |
| adaptiv, 0,08 m | 11.545 | 18.738 | 0,080 m |

Das adaptive Netz braucht bei **zugesicherten acht Zentimetern** rund halb so
viele Dreiecke wie das 1-m-Gitter — und ist dabei genauer, weil es die
Stützpunkte dorthin setzt, wo die Form sie verlangt: an Böschungen,
Grubenkanten und Bordsteine. Ein regelmäßiges Gitter tut das Gegenteil, es
zerlegt eine ebene Asphaltfläche in Tausende gleicher Dreiecke und rundet
zugleich die Grubenkante weg.

Unter etwa 0,05 m Toleranz bildet das Netz die Rasterung nach statt das
Gelände; unter 0,02 m weist die Route die Anfrage ab. `max_stuetzpunkte`
(Vorgabe 60.000) deckelt, bevor eine zu scharfe Toleranz das Modell unbrauchbar
groß macht.

## Was herauskommt

Zwei neue Modelle in der Assetliste, beide platziert:

* **IFC4** — ein Bauteil je Objekt, mit `IfcMapConversion` (EPSG:25832) und
  Psets. Die Tiling-Pipeline legt IFC-Bauteile einzeln ab und schreibt eine
  Batch Table mit GlobalId, Typ und Geschoss; im Viewer bleiben sie anklickbar.
  **Das ist der Träger der Struktur.**
* **GLB** — Gelände mit Orthophoto aus den Punktfarben. Läuft im Backend durch
  `trimesh.load(force="mesh")` und kommt als **ein einziges Mesh** an; die
  Objekttrennung geht dabei verloren. **Das ist der Anblick, nicht die
  Struktur.**

Dazu im Arbeitsordner: `ortho.png`, `kennzahlen.json` (Aushub, Grubenfläche,
Tiefe, Verkehrsfläche), `elemente.json` (alle Objekte mit Maßen),
`bericht.json`.

## Die Stufen

**1. Zellstatistik** (`kern.zellstatistik`). Punkte auf ein 20-cm-Raster, je
Zelle nach Höhe sortiert. Aus einem einzigen `lexsort` fallen alle Perzentile
als Indexzugriff an: das 10. trägt den Boden, das 98. die Oberfläche.

Warum Perzentile statt Minimum und Maximum: Photogrammetrie streut vereinzelte
Punkte weit unter das Gelände, ein Minimum greift genau die. Beim ersten
Versuch ergab das ein Geländemodell mit einem regelmäßigen Gittermuster aus
Rauschpunkten — sichtbar falsch, aber erst im Bild erkennbar. Deshalb: **jedes
Geländemodell einmal als Bild ansehen, bevor darauf gebaut wird.**

**2. Gelände** (`kern.gelaende`). Progressiver morphologischer Filter (Zhang
2003): Öffnen mit wachsendem Fenster (1 → 28 m), die Höhenschwelle wächst mit.
Nacheinander verschwinden Zäune, Fahrzeuge, Container, Hallen; ein geneigtes
Gelände bleibt stehen. Ein Öffnen tastet Vertiefungen nie an — die Baugrube
bleibt vollständig erhalten. Das ist der Grund, warum das Verfahren für
Baustellen taugt.

**3. Baugrube und Verkehr** (`kern.flaechen`). Ein Schließen mit großem Fenster
überbrückt die Grube; die Differenz ist der Aushub. Daraus fällt die Kubatur
an — die Zahl, wegen der man einen Baustellenscan überhaupt fliegt.

**4. Objekte** (`kern.objekte`). Zusammenhängende Bereiche über 0,55 m,
klassifiziert an Messbarem: Grundfläche, Schlankheit der ausgerichteten Box,
Höhe, Farbe. Bäume werden zusätzlich vereinzelt — lokale Maxima der geglätteten
Kronenhöhe sind Wipfel, die Vegetationsfläche wird per Distanztransformation
auf sie aufgeteilt. Aus einer verschmolzenen Baumgruppe von 900 m² werden so
Einzelbäume mit Höhe und Kronenradius.

Fassaden jenseits der Hauptstraße sind aus der Luft nur streifenweise erfasst;
sie werden über ein Schließen zu Baukörpern zusammengefasst, und was darunter
zu dünn belegt bleibt, wird **verworfen statt geraten**.

**5. Netz** (`netz.py`), **6. Ausgabe** (`ausgabe_glb.py`, `ausgabe_ifc.py`).

## Platzierung — der Kern der Sache

Ein rekonstruiertes Modell muss **auf** der Wolke liegen, aus der es stammt.
Eine Handeinpassung erreicht das nie ganz. Der genaue Weg führt über das
Tileset der Quellwolke:

```
tiles/<job_id>/tileset.json  →  root.transform  (4×4, column-major)
```

Diese Matrix bildet das lokale System der Wolke nach ECEF ab. Ihre Translation
ist der Ankerpunkt, ihre Rotation die Ausrichtung. Damit wird jede lokale
Koordinate exakt in Länge, Breite und Höhe umgerechnet — statt geschätzt.

Beim Sparkassen-Datensatz lieferte die Rückrechnung des lokalen Nullpunkts

```
lon 8.2866930   lat 49.9776370   h 172,600 m   Heading 330,0000°
```

und damit **auf sieben Nachkommastellen** dieselben Werte, die im Backend als
Platzierung der Punktwolke stehen. Die Ableitung ist nicht nur plausibel,
sondern nachweislich dieselbe Transformation.

Zwei Fallen dabei:

* **Der Anker ist die Mitte der Bounding Box**, in X, Y **und Z** — nicht der
  Nullpunkt und nicht die Unterkante. Beim Sparkassen-Scan stand das sogar im
  LAS-Header: dessen Offset `(-5,580 | 5,326 | 7,897)` ist genau diese Mitte.
* **Das Backend zentriert Modelle beim Ablegen erneut**, aber anders:
  `recenter()` legt XY auf die Mitte und **Z auf die Unterkante**. Die
  Platzierung wird deshalb für genau diesen Punkt gerechnet
  (`lauf.platzierung`), nicht für den Modellursprung.

## Blender

`blender_bau.py` baut dieselbe Szene in Blender und legt eine `.blend` an — für
das Nacharbeiten von Hand. Für die Ausgabe braucht es Blender nicht mehr:
`ausgabe_glb.py` schreibt das GLB über trimesh, in einem Zehntel der Zeit und
ohne eine 3D-Suite im Container.

```bash
blender -b --python blender_bau.py -- ./ergebnis
```

Beim Export ist `export_yup=False` zwingend: die Mesh-Pipeline erwartet Z-up
und dreht selbst nach Y-up. Blenders Vorgabe ist Y-up — damit käme das Modell
um 90° gekippt an.

## Was das Verfahren nicht kann

* **Verdeckte Bereiche.** Was die Kamera nicht gesehen hat, entsteht nicht. Am
  Sparkassen-Scan gab die südliche Häuserzeile nur zwei Baukörper her.
* **Innenräume.** Ein Luftbildscan liefert Hüllen, keine Grundrisse. Die
  Baukörper sind LOD1 und im Pset auch so bezeichnet.
* **Bewegliches.** Fahrzeuge und Baumaschinen sind der Zustand eines
  Augenblicks. Sie stehen im Modell, weil sie in der Wolke stehen — für einen
  Bauzustandsvergleich sind sie Rauschen.

## Ergebnis am Sparkassen-Datensatz

101,7 Mio. Punkte, 241,8 × 213,0 × 15,8 m, RealityCapture-Photogrammetrie.

| | |
|---|---|
| Baugrube | 7.569 m², bis 4,94 m tief, mittlere Tiefe 2,25 m |
| Aushub | rund 17.000 m³ |
| Verkehrsfläche | 5.419 m² |
| Bäume | 36, Höhen 3,4 – 15,6 m (Median 7,8 m) |
| Bauzaun | 53 Felder auf 186 m Achse |
| Baukörper | 6 (LOD1) |
| Fahrzeuge, Container, Ausstattung, Maschinen | 47 |
| Ergebnis | 392 Objekte im GLB, 144 IFC-Bauteile |
