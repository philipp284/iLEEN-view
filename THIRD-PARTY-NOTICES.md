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

Nicht Teil des Repositoriums; es gelten die Nutzungsbedingungen der Anbieter.
Die Vermerke zeigt der Viewer je Kachel bzw. Ebene an.

| Dienst | Verwendung | Bedingung / Vermerk |
|---|---|---|
| basemap.de 3D Gelände (DGM5) und 3D Gebäude (LoD2), BKG | Gelände und Gebäude in Deutschland (`gelaende.js`, `kartenquellen.js`) | Lizenz „basemap.de 3D-Beta": zu Testzwecken, nur über den Dienst, Speichern nur zur Laufzeit; „© GeoBasis-DE/BKG <Jahr>" mit Veränderungshinweis (Höhen auf das Ellipsoid umgerechnet) |
| basemap.de Web Raster, BKG | Karte | CC BY 4.0, „© basemap.de / BKG \| Datenquellen: © GeoBasis-DE" |
| Terrain Tiles (Mapzen/Tilezen, AWS Open Data) | Gelände außerhalb Deutschlands | Quellen SRTM, EU-DEM (Copernicus), GMTED2010, ETOPO1 u. a. — Vermerk je Kachel |
| DOP20 Rheinland-Pfalz (LVermGeo) | Luftbild | dl-de/by-2-0, „©GeoBasis-DE / LVermGeoRP <Jahr>, dl-de/by-2-0, www.lvermgeo.rlp.de" |
| DOP Hessen (HVBG) | Luftbild | Nutzung ohne Bedingung (§ 24 HVGG) |
| DOP Nordrhein-Westfalen (Geobasis NRW) | Luftbild | dl-de/zero-2-0 |
| DOP20 Bayern (Bayerische Vermessungsverwaltung) | Luftbild | CC BY 4.0 |
| DOP Saarland (LVGL) | Luftbild | ohne Einschränkung |
| Sentinel-2 cloudless 2024 (EOX IT Services) | Luftbild außerhalb der Länderdienste | CC BY-NC-SA 4.0 — nicht kommerziell (wie das Frontend); „Contains modified Copernicus Sentinel data 2024" |
| OpenStreetMap-Kacheln | Karte | © OpenStreetMap-Mitwirkende, ODbL; Tile Usage Policy |
| Nominatim (OpenStreetMap) | Ortssuche | Usage Policy: keine Abfrage je Tastendruck, höchstens eine je Sekunde |
| Google Maps Platform: Map Tiles API (2D, Photorealistic 3D), Geocoding API | nur mit eigenem Schlüssel (`googleMapsKey`) | Google-Bedingungen; 3D Tiles nur mit Googles Suche; Logo lokal unter `frontend/Assets/google-attribution.png` |
| Cesium ion | nur noch Modelle aus dem eigenen Konto | Cesium-ion-Bedingungen |
| OpenSky Network | Flugverkehr, nur über die Backend-Route `/flug` | Bedingungen des Anbieters |

## Backend (Python)

| Paket | Lizenz |
|---|---|
| FastAPI | MIT |
| Uvicorn | BSD-3-Clause |
| python-multipart | Apache-2.0 |
| MinIO Python SDK | Apache-2.0 |
| LanceDB | Apache-2.0 |
| sentence-transformers | Apache-2.0 |
| HTTPX | BSD-3-Clause |
| Kreuzberg | MIT |
| IfcOpenShell | LGPL-3.0-or-later |
| py3dtiles | Apache-2.0 |
| trimesh | MIT |
| NumPy | BSD-3-Clause |
| Shapely | BSD-3-Clause |
| Pillow | MIT-CMU (HPND) |
| scikit-image | BSD-3-Clause |
| SciPy | BSD-3-Clause |
| JAX | Apache-2.0 |
| FEniCS Basix | MIT |
| meshio | MIT |
| pyfiglet | MIT |
| Matplotlib | Matplotlib License (PSF-basiert) |
| python-dotenv | BSD-3-Clause |
| Pydantic | MIT |
| aiofiles | Apache-2.0 |
| PyArrow | Apache-2.0 |
| **plyfile** | **GPL-3.0** — siehe Hinweis |
| **PyMuPDF** | **AGPL-3.0** (oder kommerzielle Lizenz von Artifex) — siehe Hinweis |
| **jax-fem** | **GPL-3.0** — siehe Hinweis |
| **gmsh** | **GPL-2.0-or-later** — siehe Hinweis |

### Hinweis zu Copyleft-Bibliotheken

`plyfile`, `PyMuPDF`, `jax-fem` und `gmsh` stehen unter GPL bzw. AGPL. Ihre
Bedingungen sind mit einer nichtkommerziellen Lizenz für ein Gesamtwerk, das sie
einbindet, nicht vereinbar, sobald dieses Gesamtwerk weitergegeben oder (AGPL)
über ein Netzwerk angeboten wird. Sie sind deshalb nicht Teil der unter
PolyForm Noncommercial lizenzierten Software: das Backend, das sie einbindet,
steht unter der GNU Affero General Public License 3.0 (`backend/LICENSE`).
Frontend und Backend sind getrennte Programme, die nur über HTTP miteinander
sprechen (siehe `README.md`, Abschnitt Lizenz).
