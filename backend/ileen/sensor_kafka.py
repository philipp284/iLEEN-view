"""
Der Eingang für Messwerte: gaecos Kafka-Broker.

Zwei Ströme, ein Broker
=======================
gaeco führt einen Broker, und iLEEN benutzt ihn mit — aber für einen **eigenen**
Strom:

    statisch    Sensor-Instanzen, SOSA-Verknüpfungen
                → ekkodale.gaeco.instance.public.<useCaseId>.gaecoImport
                → der gaeco-Graph

    dynamisch   Messwerte, eine Zeile JSON je Wert
                → ileen.sensor.messwerte
                → diese Datei → zeitreihe.py

**Messwerte gehen nicht durch `gaecoImport`.** Das GraphDataModel-Schema
beschreibt Instanzen; ein Minutenwert ist keine. Der Graph wüchse täglich um
Zehntausende Knoten, und der Grundsatz „nur statische SOSA/SSN-Verknüpfungen
ins RDF" wäre aufgegeben. **Kafka ist hier Transport, nicht Ablage.**

Ein fehlender Broker ist kein Fehler
====================================
Der Broker läuft nicht immer — gaeco wird hochgefahren, wenn man es braucht.
Das Backend muss davon unberührt bleiben: es startet, `/health` antwortet, der
HTTP-Weg zum Einspeisen funktioniert weiter. Der Zuhörer versucht es im
Hintergrund erneut und **meldet sich dabei genau einmal**, nicht bei jedem
Versuch. Eine Fehlermeldung alle fünf Sekunden ist keine Information, sondern
Lärm, in dem die echte untergeht.

Ohne `ILEEN_KAFKA_BROKER` wird gar nicht erst verbunden. Das ist der
Regelbetrieb für jeden, der iLEEN ohne gaeco fährt.

Diese Datei ist die einzige, die Kafka kennt — so wie `zeitreihe.py` die
einzige ist, die SQL kennt.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os

from ileen import zeitreihe

logger = logging.getLogger(__name__)

# Von außen `localhost:9092`, im Container `gaeco-broker:29092` — je nachdem,
# in welchem Netz der Prozess hängt. Leer heißt: kein Kafka.
BROKER = os.environ.get("ILEEN_KAFKA_BROKER", "")
TOPIC = os.environ.get("ILEEN_KAFKA_TOPIC", "ileen.sensor.messwerte")

# Eine feste Gruppe, damit ein Neustart dort weitermacht, wo er aufgehört hat.
GRUPPE = os.environ.get("ILEEN_KAFKA_GRUPPE", "ileen-zeitreihe")

# `latest`, nicht `earliest`: die Werte des Verlaufs liegen schon in der
# Zeitreihe. Ein Neustart soll nicht den ganzen Topic-Inhalt noch einmal
# einspielen, nur um auf denselben Stand zu kommen.
OFFSET = os.environ.get("ILEEN_KAFKA_OFFSET", "latest")

# Gesammelt statt einzeln geschrieben: ein Commit je Messwert wäre bei 24
# Sensoren im Minutentakt Verschwendung.
STAPEL = int(os.environ.get("ILEEN_KAFKA_STAPEL", "200"))
STAPEL_MS = int(os.environ.get("ILEEN_KAFKA_STAPEL_MS", "1000"))

# Wiederholversuche mit wachsendem Abstand, gedeckelt: ein abwesender Broker
# soll nicht im Sekundentakt angeklopft werden.
WARTE_MIN_S, WARTE_MAX_S = 5, 60


class Zuhoerer:
    """Hört am Topic und legt ab, was ankommt."""

    def __init__(self, broker: str | None = None, topic: str | None = None):
        self.broker = broker if broker is not None else BROKER
        self.topic = topic or TOPIC
        self.aufgabe: asyncio.Task | None = None
        self.laeuft = False
        self.gemeldet = False
        self.empfangen = 0
        self.abgelegt = 0
        self.verbunden = False

    async def start(self) -> None:
        if not self.broker:
            logger.info("Sensor-Kafka: kein Broker eingerichtet (ILEEN_KAFKA_BROKER) — "
                        "Messwerte kommen weiter nur über HTTP")
            return
        self.laeuft = True
        self.aufgabe = asyncio.create_task(self._schleife(), name="sensor-kafka")

    async def stop(self) -> None:
        self.laeuft = False
        if self.aufgabe is not None:
            self.aufgabe.cancel()
            try:
                await self.aufgabe
            except (asyncio.CancelledError, Exception):  # noqa: B014
                pass
            self.aufgabe = None

    async def _schleife(self) -> None:
        warte = WARTE_MIN_S
        while self.laeuft:
            try:
                await self._lesen()
                warte = WARTE_MIN_S
            except asyncio.CancelledError:
                raise
            except Exception as fehler:            # noqa: BLE001
                self._melden(fehler)
                await asyncio.sleep(warte)
                warte = min(warte * 2, WARTE_MAX_S)

    async def _lesen(self) -> None:
        # Der Import steht hier und nicht oben: fehlt `aiokafka`, soll das
        # Backend trotzdem starten und alles andere können.
        from aiokafka import AIOKafkaConsumer

        leser = AIOKafkaConsumer(
            self.topic,
            bootstrap_servers=self.broker,
            group_id=GRUPPE,
            auto_offset_reset=OFFSET,
            enable_auto_commit=True,
        )
        await leser.start()
        self.verbunden = True
        self.gemeldet = False
        logger.info("Sensor-Kafka: verbunden mit %s, Topic %s", self.broker, self.topic)
        try:
            while self.laeuft:
                # Gesammelt abholen statt Nachricht für Nachricht: das ist
                # zugleich der Stapel für `aufnehmen()`.
                haufen = await leser.getmany(timeout_ms=STAPEL_MS, max_records=STAPEL)
                werte = []
                for nachrichten in haufen.values():
                    for n in nachrichten:
                        wert = self._lesen_wert(n.value)
                        if wert is not None:
                            werte.append(wert)
                if werte:
                    self.empfangen += len(werte)
                    # SQLite blockiert; in einem Thread stört es die
                    # Ereignisschleife des Servers nicht.
                    self.abgelegt += await asyncio.to_thread(zeitreihe.aufnehmen, werte)
        finally:
            self.verbunden = False
            await leser.stop()

    @staticmethod
    def _lesen_wert(rohdaten) -> dict | None:
        try:
            return json.loads(rohdaten.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            # Eine unlesbare Nachricht darf den Strom nicht anhalten.
            logger.warning("Sensor-Kafka: Nachricht ist kein JSON — übersprungen")
            return None

    def _melden(self, fehler: Exception) -> None:
        if self.gemeldet:
            return
        self.gemeldet = True
        logger.warning("Sensor-Kafka: kein Broker unter %s (%s) — es wird weiter versucht, "
                       "weitere Fehlversuche werden nicht mehr gemeldet", self.broker, fehler)

    def zahlen(self) -> dict:
        return {"broker": self.broker or None, "topic": self.topic,
                "verbunden": self.verbunden, "empfangen": self.empfangen,
                "abgelegt": self.abgelegt}


# Ein Zuhörer je Prozess, von `api/main.py` gestartet und beendet.
zuhoerer = Zuhoerer()


# ── Die Gegenrichtung: schreiben ──────────────────────────────────────────

async def senden(messwerte, broker: str | None = None, topic: str | None = None) -> int:
    """
    Schreibt Messwerte ins Topic — eine Nachricht je Wert.

    Der Inhalt ist unverändert dieselbe JSON-Zeile, die der Generator sonst
    nach stdout schreibt. Kein Avro, kein Protobuf, keine Schema-Registry: wer
    mitlesen will, braucht nichts als einen Konsolen-Leser.
    """
    from aiokafka import AIOKafkaProducer

    schreiber = AIOKafkaProducer(bootstrap_servers=broker or BROKER or "localhost:9092")
    await schreiber.start()
    anzahl = 0
    try:
        for m in messwerte:
            zeile = m if isinstance(m, str) else json.dumps(m, ensure_ascii=False)
            # Der Sensor als Schlüssel: bei mehreren Partitionen landen damit
            # alle Werte eines Sensors in derselben und bleiben in Reihenfolge.
            schluessel = None
            try:
                schluessel = (json.loads(zeile)["sensor"]).encode("utf-8")
            except (KeyError, json.JSONDecodeError, AttributeError):
                pass
            await schreiber.send_and_wait(topic or TOPIC, zeile.encode("utf-8"),
                                          key=schluessel)
            anzahl += 1
    finally:
        await schreiber.stop()
    return anzahl
