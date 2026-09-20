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

## Noch offen

**E6 · Auth.** iLEENs Frontend hat keine Anmeldung, gaeco hängt an Keycloak.
Für den Kafka-Weg gleichgültig, für REST-Zugriffe auf `:5024` nicht.
Blockiert Arbeitspaket 1 und 2, nicht die Pakete 3–7.

**E7 · Guideline für Sensoren.** Brick liegt in gaeco als Guideline bereit
(inkl. `sosa:`-Präfix und der vollen `brick:*_Sensor`-Hierarchie); Alternative
wäre eine eigene iLEEN-Guideline plus Link-TTL nach dem Muster
`demodata/gaeco/gaeco.ttl`. Am Code nicht entscheidbar — nur am laufenden
Stack. Blockiert Arbeitspaket 1 und 2.

Weil E6 und E7 offen sind, beginnt die Umsetzung **nicht** mit Paket 1
(gaeco-Stack), sondern mit dem Teststream: er hängt an keiner der beiden
Fragen.
