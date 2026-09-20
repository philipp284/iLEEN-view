# 02 · Der künstliche Sensorstream

**Datendefinition, kein Code.** Was hier steht, ist der Vertrag, gegen den
Arbeitspaket „Teststream" gebaut und geprüft wird. Der Generator selbst ist
Sache des Coders.

Bezugsmodell ist der Hochschulcampus:
`ifc_hsmainz_campus_ba2+ba1.ifc`, Job-ID `3356f8d2-40c8-4adf-bab8-b37ef081e41a`,
34.376 semantisch erfasste Bauteile.

---

## 1 · Woran die Sensoren hängen — und warum nicht an Räumen

Am Modell nachgesehen (`properties.sqlite` des Jobs):

| gesucht | gefunden |
|---|---|
| `IfcSpace` | **keine** — `GET /assets/<job>/rooms` liefert `[]` |
| `IfcBuilding`, `IfcBuildingStorey` | **keine** in der Property-Datenbank |
| `IfcSite` | **genau eine**: `20FpTZCqJy2vhVJYtjuIce`, Name „Gelände" |
| Geschosse | nur als Textfeld `storey` an den Bauteilen: `UG`, `EG`, `OG-1`, `OG-2`, `OG-3`, `Dach` |

Es gibt in diesem Modell also **keine Raum-IDs**, an die sich etwas hängen
ließe. Damit trotzdem alles an einer echten, im Tileset anklickbaren GlobalId
hängt — und nichts erfunden wird — gilt:

**Eine Zone ist eine benannte Bezugseinheit mit einem Ankerbauteil.** Das
Ankerbauteil ist ein real vorhandenes Bauteil des Geschosses, seine GlobalId
steht in der Batch Table jedes B3DM und ist damit im Viewer auswählbar. Die
Zone erbt ihre IRI vom Anker.

Sobald ein Modell echte `IfcSpace` mitbringt, tritt deren GlobalId an die
Stelle des Ankers — an Format und Rechenregel ändert sich nichts.

### Die sieben Zonen (`zonen.csv`)

| zone_id | Bezeichnung | anker_guid | anker_typ |
|---|---|---|---|
| `Z-SITE` | Umgebung, Gesamtgebäude, Rohbau | `20FpTZCqJy2vhVJYtjuIce` | IfcSite |
| `Z-UG` | Untergeschoss | `0w1cPvZL1eFfo96rM6Bmzv` | IfcSlab |
| `Z-EG` | Erdgeschoss | `3SUH1CDZmsK5eBrASO8UdL` | IfcSlab |
| `Z-OG1` | 1. Obergeschoss | `3H8801XPtoG8UOlEqgfs46` | IfcSlab |
| `Z-OG2` | 2. Obergeschoss | `0vu6Lt4in9eO17$wEx_xc4` | IfcRoof |
| `Z-OG3` | 3. Obergeschoss | `10p3$jA$NcoJGUmmxUHSMt` | IfcSlab |
| `Z-DACH` | Dachfläche (PV) | `0xGtk$Xo5FKhcFT3k0GTWG` | IfcRoof |

Alle GUIDs sind am Modell abgefragt, nicht ausgedacht. **IFC-GlobalIds
enthalten `$` und `_`** — die CSV ist deshalb mit Anführungszeichen zu lesen
und zu schreiben, und in Shell-Beispielen gehören sie in einfache
Anführungszeichen.

`Z-SITE` ist nach Philipps Vorgabe der Bezug für Umgebung, Gesamtgebäude und
Rohbau.

---

## 2 · Die IRI — der einzige Join-Key

Zwei Rechenregeln, beide ohne Tabelle:

```
Zone/Bauteil:  uuid5(NAMESPACE_DNS, <GlobalId>)
Sensor:        uuid5(NAMESPACE_URL, "https://ileen.hs-mainz.de/sensor/" + <sensor_id>)
```

Die erste ist **dieselbe**, die der gaeco-Export benutzt
(`GAECO-INTEGRATION.md` §3, am Stack verifiziert) — nur so treffen Sensorwert
und Graphknoten denselben Schlüssel. Die zweite ist neu, weil Sensoren keine
IFC-Objekte sind; sie ist ebenso rechenbar und braucht keine Registrierung.

> **Offene Annahme:** ob `https://ileen.hs-mainz.de/sensor/` mit dem
> Basis-Namensraum verträglich ist, den der InstanceService vergibt, ist erst
> am laufenden gaeco-Stack prüfbar (E7). Der Namensraum steht deshalb als
> **eine** Konstante im Modul und nirgends sonst.

---

## 3 · Das Sensorregister (`sensoren.csv`)

Die statische Seite — genau das, was später als SOSA/SSN-Tripel ins RDF geht
und **nie** in die Zeitreihe.

Spalten:

```
sensor_id, bezeichnung, messgroesse, einheit, intervall_s, zone_id,
anker_guid, brick_klasse, bereich_min, bereich_max, einbau, hersteller, modell
```

`einbau` ist das **Einbaudatum** als ISO-Datum (der Einbauort steckt in
`zone_id`). Hersteller- und Modellnamen sind frei erfunden und bewusst
generisch, damit niemand echte Produktdaten unterstellt.

24 Zeilen:

| Gruppe | Anzahl | Messgröße | Einheit | Intervall | Zonen | Brick-Klasse |
|---|---|---|---|---|---|---|
| Raumtemperatur | 12 | `raumtemperatur` | `°C` | 60 s | je 2 (Nord/Süd) in UG…OG-3, Dach | `brick:Air_Temperature_Sensor` |
| Elektrische Leistung | 6 | `wirkleistung` | `kW` | 300 s | je 1 in UG…OG-3, Dach | `brick:Active_Power_Sensor` |
| Zählerstand gesamt | 1 | `arbeit` | `kWh` | 300 s | `Z-SITE` | `brick:Building_Electrical_Meter` |
| PV-Leistung | 1 | `pv_leistung` | `kW` | 60 s | `Z-DACH` | `brick:Photovoltaic_Array_Power_Sensor` |
| PV-Tagesertrag | 1 | `pv_ertrag_tag` | `kWh` | 60 s | `Z-DACH` | `brick:Energy_Sensor` |
| Modultemperatur | 1 | `modultemperatur` | `°C` | 60 s | `Z-DACH` | `brick:Temperature_Sensor` |
| Globalstrahlung | 1 | `globalstrahlung` | `W/m²` | 60 s | `Z-SITE` | `brick:Solar_Radiance_Sensor` |
| Außentemperatur | 1 | `aussentemperatur` | `°C` | 60 s | `Z-SITE` | `brick:Outside_Air_Temperature_Sensor` |

Sensor-IDs nach dem Muster `TMP-EG-N`, `TMP-EG-S`, `PWR-OG1`, `PV-P`, `PV-E`,
`PV-TMOD`, `MET-GHI`, `MET-TA`, `ELT-GESAMT`.

> **Offene Annahme:** Die Brick-Klassennamen stammen aus
> `gaeco/demodata/Brick/Brick+patches.ttl`. Ob die geladene Guideline sie unter
> genau diesen URIs führt, ist erst am laufenden Stack prüfbar (E7). Sie stehen
> deshalb in der CSV und nicht im Code.

---

## 4 · Die Messwerte

Jede Messung ist eine Zeile JSON (JSON Lines):

```json
{"sensor":"TMP-EG-S","iri":"<uuid5 des Sensors>","zone":"Z-EG",
 "anker":"3SUH1CDZmsK5eBrASO8UdL","zeit":"2026-09-20T13:05:00Z",
 "wert":22.4,"einheit":"°C","status":"ok"}
```

`status` ist eines von `ok`, `veraltet`, `ausreisser`. Die vierte Vokabel
`ausfall` kommt in den Daten **nicht** vor: ein ausgefallener Sensor sendet
laut §4 gar keine Zeile, es gibt also nichts zu kennzeichnen. Sie bleibt für
die Frontend-Seite, die aus dem Ausbleiben von Zeilen selbst auf Ausfall
schließen muss.

**Ein Wert mit `status: "ok"` liegt immer innerhalb von `bereich_min` und
`bereich_max` seines Sensors.** Sonst wäre die Unterscheidung zwischen gesundem
Wert und Ausreißer wertlos und ein Schwellwertalarm spräche auf den
Normalbetrieb an. Die Bereiche in `sensoren.csv` sind deshalb Fühlerbereiche,
keine Komfortbereiche — ein Raumfühler misst 5…40 °C.

### Die Tagesgänge

Physikalisch plausibel, nicht physikalisch korrekt — es geht darum, dass die
Anzeige etwas Lebendiges zeigt und Schwellwerte ansprechen.

* **Globalstrahlung** — Tagesbogen aus dem Sonnenstand für Mainz (49,99° N,
  8,24° O), Tageslänge aus dem Tag des Jahres. Darüber ein geglätteter
  Wolkenfaktor 0,2…1,0 (Random Walk, Schrittweite klein genug, dass es nach
  Wetter aussieht und nicht nach Rauschen). Nachts 0.
* **Außentemperatur** — Jahresmittel 10,5 °C, Jahresamplitude ±9 K (Minimum
  Mitte Januar), Tagesamplitude ±5 K mit Minimum 05:00 und Maximum 15:00,
  Rauschen σ = 0,3 K.
* **Raumtemperatur** — Sollwert 21 °C, Nachtabsenkung auf 18 °C zwischen 20:00
  und 06:00, Regelabweichung ±0,4 K. Südsensoren koppeln an die
  Globalstrahlung (bis +3 K), Nordsensoren nicht. UG 2 K kühler, Dach 1,5 K
  wärmer.
* **Modultemperatur** — Außentemperatur + 0,03 K je W/m² Globalstrahlung.
* **PV-Leistung** — Anlage 120 kWp: `P = 120 · GHI/1000 · (1 − 0,004 · (T_mod − 25))`,
  auf ≥ 0 begrenzt. **Tagesertrag** ist das laufende Tagesintegral, springt um
  Mitternacht auf 0.
* **Wirkleistung je Geschoss** — Grundlast (UG 12 kW, EG 9, OG-1 8, OG-2 7,
  OG-3 6, Dach 2), werktags 07:00–19:00 Faktor 2,5, Wochenende 1,0, Rauschen
  ±8 %.
* **Zählerstand gesamt** — Integral von `max(0, Verbrauch − PV-Erzeugung)`,
  Startwert frei wählbar. **Monoton steigend, nie fallend.**

  > **Berichtigt am 2026-09-20.** Hier stand zuerst „Integral der Summe aller
  > Wirkleistungen minus PV-Erzeugung" **und** „monoton steigend". Beides
  > zugleich geht nicht: am Wochenende liegt die PV-Leistung (bis 77 kW) über
  > der Grundlast (44 kW), die Differenz wird negativ. Ein **Bezugszähler**
  > läuft physikalisch nicht rückwärts; die Einspeisung gehört auf einen
  > zweiten Zähler. Der Widerspruch stammt aus dieser Definition, nicht aus
  > der Umsetzung — aufgefallen ist er beim Bau (Issue #2, Annahme 4).

### Störungen, absichtlich eingebaut

Ohne sie ist die Zustandsanzeige im Frontend nicht zu erproben:

* `TMP-OG2-N` **friert ein**: liefert ab einem festen Zeitpunkt denselben Wert
  weiter → Status `veraltet`.
* `PWR-OG3` **fällt zeitweise aus**: eine Lücke von 20 Minuten je Tag, in der
  keine Zeile entsteht.
* `TMP-UG-N` liefert etwa alle 200 Messungen einen **Ausreißer** außerhalb
  `bereich_min`/`bereich_max` → Status `ausreisser`.

---

## 5 · Zwei Betriebsarten

```bash
# Rückblick: füllt die Zeitreihe, damit es beim ersten Start etwas zu sehen gibt
python3 scripts/sensor_demo.py --verlauf 7d --schritt 60 --seed 42 > messwerte.jsonl

# Echtzeit: eine Zeile je fälligem Sensor, für den späteren WebSocket
python3 scripts/sensor_demo.py --live --raffer 60
```

`--raffer 60` bedeutet: eine Sekunde Echtzeit entspricht einer Minute
Modellzeit, damit sich ein Tagesgang in zwei Minuten ansehen lässt.

**Der Rückblick endet an der letzten Mitternacht UTC**, nicht „jetzt" — sonst
trügen zwei Läufe kurz nacheinander verschiedene Zeitstempel und die
Reproduzierbarkeit wäre nicht prüfbar. `--ende` setzt einen anderen Bezugspunkt.

**`--seed` macht den Lauf reproduzierbar.** Zweimal derselbe Seed und dieselbe
Zeitspanne müssen Byte für Byte dieselbe Ausgabe liefern — sonst ist kein
Akzeptanzkriterium prüfbar.
