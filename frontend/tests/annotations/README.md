# Prüfung der Annotationen

`annotations.js` hängt an Cesium und am DOM, seine Logik aber nur an wenigen
Stellen: Markdown, Panel-Markup, gespeicherter Zustand und die Zeichenschleife.
Für die Schleife genügt ein Ersatz aus ein paar Vektorfunktionen und Knoten,
die festhalten, was geschrieben wurde — deshalb läuft die Prüfung unter Node.

## Ausführen

```sh
node tests/annotations/test-annotations.js
```

Rückgabewert 0 = alles bestanden.

## Was geprüft wird

| Teil | prüft |
|---|---|
| Markdown | Maskierung fremden Textes, Fettung, Code, Aufzählung, Häkchen |
| Panel | Markup ist ausgeglichen, hängt an `getTagsContent` an, vier Sichtweiten |
| Zustand | Ein/Aus, Filter und Sichtweite überleben als `localStorage`-Eintrag; eine ungültige Sichtweite zerstört den Wert nicht |
| Layout | einzelne und vollständige Rücknahme verschobener Beschriftungen |
| Schleife | Anker projiziert, Statusklasse gesetzt, Entzerrung klappt die fernere Beschriftung zusammen, zweiter Durchlauf legt nichts doppelt an |

## Was er *nicht* prüft

Farben, Größen und die tatsächliche Projektion — dafür braucht es den Browser.
Der Ersatz für `SceneTransforms.worldToWindowCoordinates` reicht die
Weltkoordinate durch, statt sie zu projizieren; geprüft wird also die
Verarbeitung des Ergebnisses, nicht Cesiums Rechnung.
