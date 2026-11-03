"""
Prüfstein für die Route /gaeco — wer darf übertragen, und kommt es an?

© 2026 Philipp Schäfer — AGPL-3.0 (siehe backend/LICENSE)
SPDX-License-Identifier: AGPL-3.0-or-later

Die Route ist die einzige Tür von außen in gaecos Graphen (gaecos
Kafka-Verbraucher prüft selbst keine Anmeldung). Geprüft wird deshalb zuerst
die Tür:

  · ohne Token                           → 401
  · ein Token, das gaeco abweist         → 401
  · ein Token, das den UseCase nicht sieht → 403
  · ein Token, das ihn sieht             → der Export läuft

Der UseCase-Dienst ist nachgebaut (ein http.server im Test), Quelle und
Broker sind ersetzt: `_local_source` liefert ein Modell, das der Test baut,
`senden` merkt sich die Nachrichten. Kein Netz, kein gaeco, kein MinIO.

Ausführen:  python3 tests/test_gaeco_route.py
"""

import json
import os
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

UC = "4f1c2a8e-0b6d-4c1e-9a77-1e5d0c3b9a01"
FREMDER_UC = "8f922eee-a5b4-456e-b1ea-5cd58de6a327"


class UseCaseDienst(BaseHTTPRequestHandler):
    def do_GET(self):
        token = self.headers.get("Authorization", "")
        if self.path != "/api/UseCases" or token not in ("Bearer gut", "Bearer anders"):
            self.send_response(401)
            self.end_headers()
            return
        liste = [{"id": UC, "name": "iLEEN"}] if token == "Bearer gut" else [{"id": FREMDER_UC, "name": "andere"}]
        roh = json.dumps(liste).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(roh)

    def log_message(self, *a):
        pass


dienst = HTTPServer(("127.0.0.1", 0), UseCaseDienst)
threading.Thread(target=dienst.serve_forever, daemon=True).start()
os.environ["ILEEN_GAECO_USECASE_DIENST"] = f"http://127.0.0.1:{dienst.server_port}"
os.environ["ILEEN_KAFKA_BROKER"] = "attrappe:9092"
os.environ.pop("ILEEN_GAECO_OHNE_ANMELDUNG", None)

import ifcopenshell.api  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from api.routes import gaeco as route  # noqa: E402
from api.routes import plan as planroute  # noqa: E402
from ileen import gaeco_export  # noqa: E402

_gut = True


def pruefe(bedingung, was, ist=None):
    global _gut
    if bedingung:
        print(f"  ok    {was}")
    else:
        _gut = False
        print(f"  FEHLT {was}" + (f"\n        ist {ist!r}" if ist is not None else ""))


# Ein kleines Modell als Quelle
f = ifcopenshell.api.run("project.create_file", version="IFC4")
p = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcProject", name="P")
ifcopenshell.api.run("unit.assign_unit", f)
bau = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcBuilding", name="B")
eg = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcBuildingStorey", name="EG")
wand = ifcopenshell.api.run("root.create_entity", f, ifc_class="IfcWall", name="W")
ifcopenshell.api.run("aggregate.assign_object", f, products=[bau], relating_object=p)
ifcopenshell.api.run("aggregate.assign_object", f, products=[eg], relating_object=bau)
ifcopenshell.api.run("spatial.assign_container", f, products=[wand], relating_structure=eg)
quelle = Path(tempfile.mkdtemp(prefix="ileen-gaeco-")) / "modell.ifc"
f.write(str(quelle))

planroute._local_source = lambda job_id: quelle
gesendet = []


async def senden_attrappe(teile, use_case_id, broker):
    gesendet.append((teile, use_case_id, broker))
    return {"topic": gaeco_export.topic(use_case_id), "bytes": sum(map(len, teile)), "nachrichten": len(teile),
            "offsets": {0: 7}}


gaeco_export.senden = senden_attrappe

# Was der Broker über gaecos Verbrauchergruppe sagt — der Reihe nach.
lagen = [{"abonniert": True, "uebernommen": False}, {"abonniert": True, "uebernommen": True}]


async def lesestand_attrappe(use_case_id, offsets, broker):
    return lagen.pop(0) if len(lagen) > 1 else lagen[0]


gaeco_export.lesestand = lesestand_attrappe

app = FastAPI()
app.include_router(route.router, prefix="/gaeco")

print("1 · Die Tür")
with TestClient(app) as c:
    r = c.post("/gaeco/export/job1", json={"use_case_id": UC})
    pruefe(r.status_code == 401, "ohne Token → 401", r.status_code)
    r = c.post("/gaeco/export/job1", json={"use_case_id": UC}, headers={"Authorization": "Bearer falsch"})
    pruefe(r.status_code == 401, "gaeco weist das Token ab → 401", r.status_code)
    r = c.post("/gaeco/export/job1", json={"use_case_id": UC}, headers={"Authorization": "Bearer anders"})
    pruefe(r.status_code == 403, "Token sieht den UseCase nicht → 403", r.status_code)
    r = c.post("/gaeco/export/job1", json={"use_case_id": "kein-uuid"}, headers={"Authorization": "Bearer gut"})
    pruefe(r.status_code == 422, "use_case_id keine UUID → 422", r.status_code)
    r = c.post("/gaeco/export/job1", json={"use_case_id": UC, "profil": "alles"}, headers={"Authorization": "Bearer gut"})
    pruefe(r.status_code == 422, "unbekanntes Profil → 422", r.status_code)
    r = c.post("/gaeco/export/job1", json={"use_case_id": UC, "zusaetzlich": ["x; drop"]}, headers={"Authorization": "Bearer gut"})
    pruefe(r.status_code == 422, "zusaetzlich verlangt IFC-Klassennamen → 422", r.status_code)
    pruefe(not gesendet, "bis hierher ging nichts an den Broker")

    print("\n2 · Der Export")
    r = c.post("/gaeco/export/job1", json={"use_case_id": UC, "profil": "voll"}, headers={"Authorization": "Bearer gut"})
    pruefe(r.status_code == 200 and r.json()["zustand"] in ("wartet", "laeuft"), "mit gültigem Token beginnt er", r.text)
    for _ in range(100):
        stand = c.get("/gaeco/export/job1").json()
        if stand["zustand"] in ("fertig", "fehler"):
            break
        time.sleep(0.1)
    pruefe(stand["zustand"] == "fertig", "Stand wird „fertig“", stand)
    pruefe(stand.get("knoten") == 4 and stand.get("kanten") == 3, "4 Knoten, 3 Kanten (P→B→EG, EG∋W)",
           (stand.get("knoten"), stand.get("kanten")))
    pruefe(len(gesendet) == 1 and gesendet[0][1] == UC and gesendet[0][2] == "attrappe:9092",
           "eine Sendung in den richtigen UseCase über den eingestellten Broker")
    n = json.loads(gesendet[0][0][0])
    pruefe(isinstance(n, dict) and len(n["GraphMetadata"]) == 4, "die Nachricht ist ein GraphDataModel mit 4 Knoten")
    pruefe(stand.get("gaeco") == "in_arbeit", "gesendet, aber gaeco hat noch nicht bestätigt → in_arbeit", stand.get("gaeco"))
    pruefe(not any(k.startswith("_") for k in stand), "interne Felder bleiben draußen", list(stand))
    time.sleep(2.1)   # höchstens alle zwei Sekunden wird der Broker gefragt
    stand = c.get("/gaeco/export/job1").json()
    pruefe(stand.get("gaeco") == "uebernommen", "Verbrauchergruppe hat bestätigt → uebernommen", stand.get("gaeco"))

    lagen[:] = [{"abonniert": False, "uebernommen": False}]
    r = c.post("/gaeco/export/job1", json={"use_case_id": UC}, headers={"Authorization": "Bearer gut"})
    pruefe(r.status_code == 200, "nach dem Ende darf neu übertragen werden", r.status_code)
    for _ in range(100):
        stand = c.get("/gaeco/export/job1").json()
        if stand.get("gaeco") not in (None, "wartet"):
            break
        time.sleep(0.2)
    pruefe(stand.get("gaeco") == "nicht_abonniert" and "neu" in (stand.get("gaeco_hinweis") or ""),
           "Topic nicht abonniert → Hinweis auf den Neustart", stand.get("gaeco_hinweis"))
    pruefe(stand.get("profil") == "betrieb" and stand.get("knoten") == 3 and stand.get("kanten") == 2,
           "ohne Angabe gilt das Betriebsprofil: die Wand bleibt im IFC (3 Knoten, 2 Kanten)",
           (stand.get("profil"), stand.get("knoten"), stand.get("kanten")))
    time.sleep(0.5)

    print("\n3 · Nebenwege")
    s = c.get("/gaeco/stand").json()
    pruefe(s["broker"] == "attrappe:9092" and s["anmeldung"].startswith("über gaeco"), "Stand nennt Broker und Anmeldeweg", s)
    k = c.get("/gaeco/id/2O2Fr$t4X7Zf8NOew3FLOH").json()
    pruefe(k["instanz_id"] == "0691f9ca-8201-51b9-8246-f8040111c37a", "/gaeco/id rechnet dieselbe Kennung")
    pruefe(c.get("/gaeco/export/nie").status_code == 404, "unbekannter Export → 404")

dienst.shutdown()
print()
if _gut:
    print("Alle Prüfungen bestanden.")
    sys.exit(0)
print("Es gab Fehler.")
sys.exit(1)
