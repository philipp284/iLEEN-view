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

Vier Dateien gehen auseinander. Sie sind der einzige Grund, warum ein
Übernehmen nicht `cp -R` sein kann:

| Datei | Unterschied |
|---|---|
| `index.html` | 61 Einbindungen weniger |
| `ui.js` | ohne `getClashContent()` und `getRoomConceptContent()`; `SECTION_ALIASES.rooms/clash` zeigen aufs Bauteile-Panel statt auf eine Gruppe, die es nicht gibt |
| `aufmass-panel.js` | ohne den Abschnitt „Graph" (Turtle-Ausgabe, Fokus-Regler) |
| `vite.config.js` | **Port 5190** statt 5181 |
| `config.js` | nicht im Repo; `config.example.js` ist die Vorlage |

**Der Port ist keine Kleinigkeit.** Beide Fassungen führen `strictPort: true`.
Läuft die Vollfassung auf 5181 und hier stünde ebenfalls 5181, startet dieser
Server gar nicht — und der Browser-Prüfstein bekommt HTTP 200 von der
*anderen* Anwendung und meldet Module als vorhanden, die es hier nicht gibt.
Genau das ist beim Aufsetzen zweimal passiert (einmal die Vollfassung, einmal
eine fremde React-App auf 5182). `tests/start/test-start.mjs` prüft deshalb als
Erstes den Seitentitel.

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
for f in tests/*/test-*.js; do node "$f"; done

npx vite --port 5190 &
npm i --no-save puppeteer-core
node tests/start/test-start.mjs
```

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

## Sprache

Kommunikation und Quelltextkommentare auf Deutsch. `t('schluessel')` im
JavaScript, `data-i18n="schluessel"` im Markup; Standard ist Deutsch, Englisch
vollständig gepflegt. Ein fehlender Schlüssel gibt sich selbst aus — der
Start-Prüfstein sucht danach im fertigen Markup beider Sprachen.
