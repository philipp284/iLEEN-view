# Fremdsoftware, Daten und Dienste in iLEEN-view

iLEEN-view selbst steht unter der **PolyForm Noncommercial License 1.0.0**
(`LICENSE.md`, © 2026 Philipp Schäfer). Die folgenden Bestandteile stammen von
Dritten und stehen unter ihren eigenen Lizenzen. Diese Lizenzen gelten für die
jeweiligen Bestandteile weiter; die PolyForm-Lizenz erstreckt sich nicht auf sie.

## Frontend

| Bestandteil | Verwendung | Lizenz | Rechteinhaber |
|---|---|---|---|
| **CesiumJS** | 3D-Globus, 3D Tiles, Rendering (`index.html`, npm `cesium`) | Apache License 2.0 | Cesium GS, Inc. und Beitragende |
| vite-plugin-cesium | Einbindung von CesiumJS in den Vite-Build | MIT | nshen |
| Vite | Entwicklungsserver und Build | MIT | VoidZero Inc. und Vite-Beitragende |
| Chart.js | Diagramme (CDN) | MIT | Chart.js-Beitragende |
| JSZip | BCF- und ZIP-Ausgabe (CDN) | MIT (Doppellizenz MIT/GPL-3.0, genutzt unter MIT) | Stuart Knightley u. a. |
| puppeteer-core | nur Browser-Prüfsteine unter `frontend/tests/`, nicht ausgeliefert | Apache License 2.0 | Google LLC |

Der Text der Apache License 2.0 steht unter
<https://www.apache.org/licenses/LICENSE-2.0>. CesiumJS wird unverändert
eingebunden (CDN bzw. npm-Paket); dessen `LICENSE.md` und `ThirdParty.json`
liegen dem Paket bei (`frontend/node_modules/cesium/`).

## Daten

| Datensatz | Datei | Lizenz / Nutzungsbedingung |
|---|---|---|
| EGM96-Geoid (NGA), 15′-Raster über PROJ-data (`us_nga_egm96_15.tif`), auf 1° abgegriffen | `frontend/data/egm96-1deg.json` | gemeinfrei (U.S. Government Work) |

## Zur Laufzeit abgerufene Dienste

Nicht Teil des Repositoriums; es gelten die Nutzungsbedingungen der Anbieter:
Cesium ion (Weltgelände, Luftbild, OSM Buildings, eigene Assets),
Bing Maps über Cesium ion, Google Photorealistic 3D Tiles über Cesium ion,
OpenStreetMap-Kacheln (© OpenStreetMap-Mitwirkende, ODbL),
Sentinel-2 über Cesium ion,
basemap.de Vektorkacheln (© GeoBasis-DE / BKG, dl-de/by-2-0).

## Nicht enthalten

Die Auswerte- und Nachweiswerkzeuge der Vollfassung sind nicht Teil dieses
Repositoriums; die Fremdsoftware, die nur sie brauchen (geotiff.js für die
Verschattung, die Python-Pakete des Backends), steht deshalb hier nicht.
