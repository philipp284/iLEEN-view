import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from api.routes import (upload, tiles, semantic, assets, placement, geo, elements,
                        materials, plan, fem, energie, tragwerk,
                        tragwerk_eingriffe, flug, volumen, scan2bim, tour, issues,
                        sensoren, einsturz, gaeco, bauplaner, splattraining, splat_export, baugrund, gelaende,
                        nutzung, atlas, hausfunktionen, sortiert)

# Ohne diese Konfiguration hat der Root-Logger keinen Handler: jedes
# `logging.getLogger(__name__).info(...)` im Projekt (Tiling-Fortschritt,
# Ausreißerfilter, Splat-Reduktion) verschwindet spurlos. Uvicorns eigene
# Logger ("uvicorn", "uvicorn.access") sind davon unabhängig konfiguriert,
# deshalb tauchten bisher nur die Request-Zeilen und Tracebacks in
# `docker logs` auf, nie die INFO-Meldungen aus tiling/*.
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

@asynccontextmanager
async def lebenslauf(app: FastAPI):
    """Startet den Kafka-Zuhörer und beendet ihn wieder.

    Ein fehlender Broker darf den Start **nicht** verhindern: gaeco läuft nur,
    wenn man es braucht, und iLEEN muss auch ohne es hochkommen. `start()`
    kehrt deshalb sofort zurück und versucht im Hintergrund weiter.

    Das Beenden ist kein Beiwerk: ohne `stop()` bliebe die Aufgabe hängen und
    `docker compose stop api` bräuchte ein SIGKILL.
    """
    from ileen.sensor_kafka import zuhoerer
    await zuhoerer.start()
    # Nimmt Splats auf, die der Worker auf dem Mac fertig trainiert hat (siehe splattraining.py).
    # Ohne Worker tut die Schleife nichts außer alle drei Sekunden ein Verzeichnis zu lesen.
    uebernahme = asyncio.create_task(splattraining.uebernahme_schleife())
    try:
        yield
    finally:
        uebernahme.cancel()
        await zuhoerer.stop()


app = FastAPI(
    title="CesiumBackend",
    description="Self-hosted Cesium Tiling Pipeline + File Storage + Semantic Extraction",
    version="0.1.0",
    lifespan=lebenslauf,
)


@app.middleware("http")
async def fehler_mit_cors(request, call_next):
    """
    Unbehandelte Fehler als lesbare 500 — **innerhalb** der CORS-Schicht.

    Ohne das erzeugt Starlettes `ServerErrorMiddleware` die 500 ganz außen,
    also nach CORS: die Antwort trägt dann keinen `Access-Control-Allow-Origin`,
    und der Browser meldet dem Aufrufer nicht „500", sondern „Failed to fetch".
    Im FE-Browser stand dadurch bei jedem Backend-Fehler dieselbe nichtssagende
    Zeile, und der eigentliche Grund war nur in `docker logs` zu finden.
    """
    try:
        return await call_next(request)
    except Exception:
        logging.getLogger("api").exception("Unbehandelter Fehler in %s", request.url.path)
        return JSONResponse(status_code=500,
                            content={"detail": "Interner Fehler im Backend — "
                                               "Einzelheiten stehen im Serverprotokoll."})


# **Nach** `fehler_mit_cors` hinzugefügt und damit außen darum: nur so laufen
# auch dessen Fehlerantworten noch durch die CORS-Schicht.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(upload.router,    prefix="/upload",   tags=["Upload"])
app.include_router(tiles.router,     prefix="/tiles",    tags=["Tiles"])
app.include_router(semantic.router,  prefix="/semantic", tags=["Semantic"])
app.include_router(assets.router,    prefix="/assets",   tags=["Assets"])
app.include_router(placement.router, prefix="/assets",   tags=["Placement"])
app.include_router(elements.router,  prefix="/assets",   tags=["Elements"])
app.include_router(materials.router, prefix="/assets",   tags=["Materials"])
app.include_router(materials.library_router, prefix="/materials/library", tags=["Materials"])
app.include_router(plan.router,      prefix="/assets",   tags=["Plan"])
app.include_router(plan.catalog_router, prefix="/plan",  tags=["Plan"])
app.include_router(fem.router,       prefix="/assets",   tags=["FEM"])
# **Vor** `tragwerk.router`: FastAPI sucht die erste passende Route, und
# `/{job}/tragwerk/{lauf_id}` würde `/{job}/tragwerk/eingriffe` schlucken.
app.include_router(tragwerk_eingriffe.router, prefix="/assets", tags=["Tragwerk"])
app.include_router(tragwerk.router,  prefix="/assets",   tags=["Tragwerk"])
app.include_router(volumen.router,   prefix="/assets",   tags=["Volumen"])
app.include_router(scan2bim.router,  prefix="/assets",   tags=["Scan2BIM"])
app.include_router(volumen.bibliothek_router, prefix="/volumen", tags=["Volumen"])
app.include_router(energie.router,   prefix="/assets",   tags=["Energie"])
app.include_router(energie.katalog_router, prefix="/energie", tags=["Energie"])
app.include_router(geo.router,       prefix="/geo",      tags=["Geo"])
app.include_router(gelaende.router,  prefix="/gelaende", tags=["Gelände"])
app.include_router(flug.router,      prefix="/flug",     tags=["Flug"])
app.include_router(tour.router,      prefix="/tour",     tags=["Tour"])
app.include_router(issues.router,    prefix="/issues",   tags=["Issues"])
app.include_router(sensoren.router,  prefix="/sensoren", tags=["Sensoren"])
app.include_router(einsturz.router,  prefix="/einsturz", tags=["Einsturz"])
app.include_router(hausfunktionen.router, prefix="/hausfunktionen", tags=["Hausfunktionen"])
app.include_router(gaeco.router,     prefix="/gaeco",    tags=["gaeco"])
app.include_router(bauplaner.router, prefix="/bauplaner", tags=["Bauplaner"])
app.include_router(baugrund.router,  prefix="/baugrund", tags=["Baugrund"])
app.include_router(splattraining.router, prefix="/splat-training", tags=["Splat-Training"])
app.include_router(splat_export.router, prefix="/assets", tags=["Splat-Export"])
app.include_router(sortiert.router,  prefix="/assets",   tags=["Sortierte Ansicht"])
# Nutzungsprotokoll des Viewers und Ansichtsvorlagen (frontend/nutzung.js, vorlagen.js)
app.include_router(nutzung.router,  prefix="/nutzung",  tags=["Nutzung"])
# World Labs Atlas: aus Tiefe und Kamera einer Ansicht ein Foto (frontend/atlas*.js)
app.include_router(atlas.router,    prefix="/atlas",    tags=["Atlas"])


@app.get("/health")
async def health():
    return {"status": "ok", "service": "CesiumBackend"}


@app.get("/", include_in_schema=False)
async def root():
    return RedirectResponse("/ui/")


# Asset-Manager: Tilesets ansehen, verorten und hochladen
app.mount("/ui", StaticFiles(directory=Path(__file__).parent / "static", html=True), name="ui")
