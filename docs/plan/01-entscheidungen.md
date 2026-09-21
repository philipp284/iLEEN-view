# 01 · Entscheidungen

**Stand: 2026-09-20.** Beschlüsse von Philipp zu den Fragen aus
[`00-analyse.md`](00-analyse.md) §5. Sie gelten, bis er sie ändert; jede Review
misst daran.

---

## Beschlossen

**E1 · Arbeitsteilung der Repos — bestätigt wie vorgeschlagen.**
Frontend-Arbeit findet in der **Vollfassung** `~/Projekte/iLEEN` (GitLab) statt;
`iLEEN-view` bekommt anschließend den Übernahme-Commit. Backend-Arbeit findet
ohnehin nur in `~/Projekte/iLEEN` statt — dort liegt `backend/`.
**Die Issues laufen trotzdem hier** (`philipp284/iLEEN-view`), weil hier die
Labels liegen. Jedes Issue nennt im Abschnitt *Kontext* das Repo, in dem
gearbeitet wird, und der Coder postet den Branchnamen als Kommentar.

**E2/E3 · Zeitreihen und Kafka — pragmatisch beginnen.**
Zeitreihen zunächst als **SQLite** nach dem Muster von
`backend/semantic/properties.py`; Kafka-Client wird **`aiokafka`**. Beides sind
neue Abhängigkeiten in `backend/requirements.txt`, beide sind hiermit
freigegeben. Ein späterer Wechsel auf eine echte TSDB bleibt offen und ist
genau deshalb hinter einem eigenen Modul zu kapseln: kein Route-Code spricht
SQL direkt.

**E4 · Sensordaten kommen aus einem künstlichen Stream.**
Ein Generator erzeugt Demodaten für `ifc_hsmainz_campus_ba2+ba1.ifc`, eine CSV
hält die statischen Angaben (das Sensorregister). Messgrößen: Raumtemperaturen,
Stromverbrauch, Photovoltaik. Die vollständige Datendefinition steht in
[`02-teststream.md`](02-teststream.md).

**E5 · Die Bedienung sitzt links.**
Sensorik wird als Viewer-Bereich über `BimViewerUI.bereichAnmelden()`
angemeldet, nicht als rechter Reiter. `tests/start/test-start.mjs:218-221`
bleibt damit grün und die Trennung unangetastet.

**Veröffentlichung.** `plan/analyse` wird nach GitHub gepusht; Philipp stellt
das Profil auf privat.

**Git-Identität.** Erledigt: Die **globale** Konfiguration trug zwei
`user.email`-Werte, der zweite war der verunglückte String
`philipp.schaefer@hs-mainz.de\ngit config --global user.name Schäfer,`.
Das betraf jeden Commit in jedem Repo. Bereinigt mit
`git config --global --unset-all user.email` und Neusetzen; die alte
`~/.gitconfig` liegt als Sicherung im Sitzungsverzeichnis.
`git var GIT_AUTHOR_IDENT` liefert jetzt
`Schäfer, Philipp <philipp.schaefer@hs-mainz.de>`.

---

## Nachgetragen am 2026-09-20

**E6 · Auth kommt von gaeco.** Keycloak ist die Instanz, iLEEN baut keine eigene
Anmeldung. Folgen, die in den Paketen auftauchen werden:

* Der `/sensoren`-Zweig bleibt vorerst offen (Paket 3 hat „keine
  Authentifizierung" ausdrücklich in der Abgrenzung). Die Absicherung kommt als
  eigenes Paket, wenn der Stack läuft — nicht verstreut in jede Route.
* Das Frontend hat heute keine Anmeldung und kann auch keine bekommen, ohne
  Keycloak einzubinden. Der Weg, der in `GAECO-INTEGRATION.md` §6 schon skizziert
  ist: iLEEN als dünner React-Remote im Plugin Host, der den Viewer im `<iframe>`
  hostet, das Token per `postMessage` hineinreicht und Auswahl-Events herausgibt.
* **Für die Pakete 3–7 ändert das nichts.** Sie laufen gegen das eigene Backend
  auf `:8100`, und dort ist niemand anzumelden.

**E7 · Sensoren werden mit Brick beschrieben, nicht mit einer eigenen Guideline.**
Begründung:

1. Brick liegt in gaeco **fertig** als Guideline und Ontologie
   (`demodata/Brick/Brick+patches.guideline`, 63.970 Zeilen TTL) und bringt
   `sosa:` samt der vollen `brick:*_Sensor`-Hierarchie mit. Was es gibt, wird
   nicht nachgebaut.
2. Das Sensorregister aus #2 trägt bereits Brick-Klassennamen in der Spalte
   `brick_klasse` — die Entscheidung ist dort vorweggenommen und kostet jetzt
   nichts.
3. Eine eigene iLEEN-Guideline müsste dieselben Begriffe zweite Male einführen
   und würde die Frage „welcher Sensortyp ist das" doppelt beantworten.

Was **zusätzlich** gebraucht wird, ist nur die Verbindung zwischen Brick-Sensor
und IFC-Bauteil. gaeco koppelt Ontologien nicht über gemeinsame IDs, sondern über
eine Link-Ontologie (`demodata/gaeco/gaeco.ttl`, 14 Zeilen). Für iLEEN also eine
ebenso schmale `ileen-links.ttl`, die genau zwei Relationen erlaubt:

```turtle
sosa:hasFeatureOfInterest a owl:ObjectProperty ;
    rdfs:domain brick:Sensor ;
    rdfs:range  ifc:IfcProduct .

sosa:observes a owl:ObjectProperty ;
    rdfs:domain brick:Sensor ;
    rdfs:range  sosa:ObservableProperty .
```

Damit ist der Grundsatz „nur statische SOSA/SSN-Verknüpfungen ins RDF" wörtlich
erfüllt: **welcher** Sensor **woran** hängt und **was** er misst steht im Graphen,
**was er gemessen hat** steht in der Zeitreihe und kommt dort nie hin.

> Beides bleibt eine Annahme, bis der Stack läuft: ob die Brick-Guideline geladen
> ist, unter welchen Klassifikations-URIs sie ihre Klassen führt, und ob der
> InstanceService die beiden Relationen annimmt. Das ist der Inhalt von
> Arbeitspaket 1 — jetzt nicht mehr blockiert, sondern nur noch unerledigt.

## Reihenfolge geändert: früher etwas sehen

Die ursprüngliche Kette 3 → 4 → 5 → 6 führt dazu, dass im Viewer **drei Pakete
lang nichts zu sehen** ist. Deshalb rückt die Darstellung vor:

| neu | Paket | warum |
|---|---|---|
| 1. | 3 · Zeitreihe (#3) | liefert die Werte über HTTP |
| 2. | 5 · Frontend-Store | **Quelle austauschbar**: erst HTTP-Abruf, später WebSocket |
| 3. | 6 · Darstellung über `Cesium3DTileStyle` | **ab hier ist es im Viewer sichtbar** |
| 4. | 4 · WebSocket | wird in den Store eingesteckt, ohne ihn umzubauen |
| 5. | 7 · Bedienbereich links | Sensorliste, Schwellwerte, Alarm |
| 6. | 1 · gaeco-Stack, 2 · Exporter | sobald der Stack läuft |

Der Preis dafür ist eine Anforderung an Paket 5: **der Store bekommt die Werte
über eine Quelle, die er nicht kennt** — eine Funktion, die Werte hereinreicht.
Ob dahinter ein `fetch`-Aufruf alle zehn Sekunden steht oder ein WebSocket, darf
der Store nicht merken. Ohne diese Trennung wäre der Vorzug ein Umbau später.

---

## E8 · Der Sensorstrom läuft über gaecos Kafka (2026-09-21)

**Beschlossen von Philipp.** Die Messwerte kommen nicht mehr per HTTP ins Backend,
sondern über den Kafka-Broker, den gaeco bereitstellt. iLEEN hört zu und legt ab.

### Zwei Ströme, nicht einer

Das ist die einzige Stelle, an der ich Einspruch anmelde, und zwar einen kleinen:
**Messwerte gehen nicht durch den `gaecoImport`-Weg.** Das `GraphDataModel`-Schema
beschreibt Instanzen eines Graphen; ein Minutenwert ist keine Instanz. Ginge er
diesen Weg, wüchse der ArcadeDB-Graph um 34.000 Knoten pro Tag und Sensor, und der
Grundsatz „nur statische SOSA/SSN-Verknüpfungen ins RDF" wäre aufgegeben.

Kafka bleibt trotzdem der Transport — gaeco stellt ihn bereit, iLEEN benutzt ihn.
Nur eben mit zwei getrennten Strömen auf demselben Broker:

| Strom | Topic | Inhalt | Ziel | wann |
|---|---|---|---|---|
| **statisch** | `ekkodale.gaeco.instance.public.<useCaseId>.gaecoImport` | Sensor als Brick-Instanz, `sosa:hasFeatureOfInterest` auf das IFC-Bauteil | gaeco-Graph | einmalig je Sensor |
| **dynamisch** | `ileen.sensor.messwerte` | die Messwerte selbst, eine Zeile JSON je Wert | iLEENs Zeitreihe | fortlaufend |

Der erste Strom ist Arbeitspaket 2 und bleibt, wo er war. Der zweite ist neu und
ersetzt den HTTP-Weg als **Regelbetrieb**; `POST /sensoren/messwerte` bleibt für
Einspeisungen aus Dateien und für die Prüfsteine.

### Am laufenden Broker erprobt (2026-09-21)

Nicht aus der Doku geschlossen — durchgespielt:

```
docker compose up -d gaeco-broker          # der einzige Dienst, den es dafür braucht
kafka-topics.sh --create --topic ileen.sensor.messwerte --partitions 1 --replication-factor 1
echo '{"sensor":"PROBE",…}' | kafka-console-producer.sh --topic ileen.sensor.messwerte
kafka-console-consumer.sh --topic ileen.sensor.messwerte --from-beginning --max-messages 1
  → Processed a total of 1 messages
```

Befunde dabei:

* **Der Broker genügt allein.** Keycloak, InstanceService und die übrigen Dienste
  müssen dafür nicht laufen — und tun es gerade auch nicht (`Exited (255)`,
  Keycloak in einer Neustartschleife). Für den Messwertstrom ist das gleichgültig;
  für Arbeitspaket 2 nicht.
* **Adressen:** von außen `localhost:9092`, im Netz `gaeco-broker:29092`.
* **Die Netze sind getrennt.** `cesium-api` hängt in `ileen_default`, der Broker in
  `gaeco-local`. Der Container erreicht ihn erst, wenn iLEENs Compose das Netz als
  `external` dazunimmt — oder ersatzweise über `host.docker.internal:9092`.
* Kafka warnt bei Topics, die Punkt **und** Unterstrich mischen. `ileen.sensor.messwerte`
  hat nur Punkte.

### Was sich an der Reihenfolge ändert

Der WebSocket (Paket 4) wird dadurch **wertvoller, nicht überflüssig**: Kafka bringt
die Werte ins Backend, der WebSocket bringt sie von dort in den Browser. Erst beide
zusammen ergeben einen durchgehenden Strom von der Quelle bis ins Bild.

Neu eingeschoben wird Paket **3b · Kafka-Anbindung** — Ausgang im Generator, Eingang
im Backend. Es steht vor Paket 4, weil ein WebSocket ohne fließende Quelle nichts zu
verteilen hat.
