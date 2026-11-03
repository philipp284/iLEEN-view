"""
Einmaliger Offline-Download der PBR-Materialtexturen für das IFC-Tiling.

Lädt für jede in `tiling/textures.py` deklarierte Kategorie ein CC0-2K-Set und
legt zwei Ergebnisse ab:

    frontend/3D Models/TEX/<category>/     volles 2K-Set, unverkleinert
                                           (allgemeine Materialbibliothek)
    tiling/textures/library/<category>/    512px-Set, wird ins B3DM eingebettet

Läuft nicht im Tiling-Container — der hat zur Laufzeit keinen garantierten
Internetzugriff. Die verkleinerten Bilder werden committet und über
`COPY tiling/ ./tiling/` im Dockerfile mit ausgeliefert; der TEX-Ordner bleibt
lokal (rund 1 GB, in `.gitignore`).

Zwei Quellen, beide CC0:

* **Poly Haven** — REST-API mit direkten JPG-URLs je Map. Gute Auswahl an
  Bau- und Außenmaterialien, aber fast nur verwitterte Metalle.
* **ambientCG** — liefert je Material ein ZIP mit allen Maps. Hier nur für die
  sauberen Grundmetalle (Stahl, Aluminium, Kupfer) und Dämmung verwendet.

Die drei Zielbilder je Kategorie:

    basecolor.jpg   Albedo (Diffuse)
    normal.jpg      Normal-Map, OpenGL-Konvention
    orm.jpg         R = Ambient Occlusion, G = Roughness, B = Metallic

`orm.jpg` wird aus den Einzelmaps der Quelle zusammengesetzt. Fehlt bei einer
Quelle die Roughness-Map, entfällt die Datei — das Tiling fällt dann auf die
konstanten Faktoren aus `CATEGORIES` zurück.

Aufruf:
    python3 scripts/fetch_textures.py                 # nur fehlende Kategorien
    python3 scripts/fetch_textures.py --force         # alles neu laden
    python3 scripts/fetch_textures.py concrete metal  # nur diese Kategorien
"""

import argparse
import io
import shutil
import sys
import zipfile
from pathlib import Path

import httpx
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tiling.textures import AMBIENTCG, CATEGORIES, POLYHAVEN, CategoryTexture  # noqa: E402

RESOLUTION = 512  # px — Kantenlänge der ins B3DM eingebetteten Textur
JPEG_QUALITY = 82

PH_INFO = "https://api.polyhaven.com/info/{slug}"
PH_FILES = "https://api.polyhaven.com/files/{slug}"
ACG_ZIP = "https://ambientcg.com/get?file={slug}_2K-JPG.zip"
ACG_PAGE = "https://ambientcg.com/view?id={slug}"

REPO_ROOT = Path(__file__).resolve().parent.parent
LIBRARY_DIR = REPO_ROOT / "tiling" / "textures" / "library"
TEX_DIR = REPO_ROOT.parent / "frontend" / "3D Models" / "TEX"

# Rollen, die ein fertiges Set ausmachen. Die Werte sind die Dateinamen im
# 2K-Ordner; welche Quelldatei darauf abgebildet wird, entscheiden die
# `_collect_*`-Funktionen.
COLOR, NORMAL, ROUGH, AO, METAL = "color", "normal", "rough", "ao", "metal"


# ── Bildverarbeitung ─────────────────────────────────────────────────────────


def _to_jpeg(img: Image.Image, size: int | None = None, resample=Image.LANCZOS) -> bytes:
    if size is not None and img.size != (size, size):
        img = img.resize((size, size), resample)
    out = io.BytesIO()
    img.convert("RGB").save(out, format="JPEG", quality=JPEG_QUALITY, optimize=True)
    return out.getvalue()


def _open(data: bytes) -> Image.Image:
    return Image.open(io.BytesIO(data))


def _build_orm(maps: dict[str, bytes], size: int) -> bytes | None:
    """
    Setzt AO/Roughness/Metallic zu einer glTF-konformen ORM-Textur zusammen.

    glTF liest Roughness aus dem Grün- und Metallic aus dem Blaukanal der
    `metallicRoughnessTexture`; der Rotkanal ist dort frei und wird per
    Konvention für Ambient Occlusion genutzt, sodass dieselbe Textur auch als
    `occlusionTexture` dienen kann. Ohne Roughness-Map ist die Textur wertlos —
    dann gelten die konstanten Faktoren aus `CATEGORIES`.
    """
    if ROUGH not in maps:
        return None

    rough = _open(maps[ROUGH]).convert("L").resize((size, size), Image.LANCZOS)
    ao = (
        _open(maps[AO]).convert("L").resize((size, size), Image.LANCZOS)
        if AO in maps
        else Image.new("L", (size, size), 255)
    )
    metal = (
        _open(maps[METAL]).convert("L").resize((size, size), Image.LANCZOS)
        if METAL in maps
        else Image.new("L", (size, size), 0)
    )

    out = io.BytesIO()
    # `subsampling=0` (4:4:4) ist hier nicht optional: JPEG unterabtastet die
    # Farbkanäle standardmäßig 4:2:0 und mittelt sie über 2x2-Blöcke. Bei einem
    # Farbbild fällt das nicht auf, in einer ORM-Map führt es dazu, dass
    # Roughness (G) und Metallic (B) ineinander laufen — eine raue Kante würde
    # dann teilmetallisch glänzen.
    Image.merge("RGB", (ao, rough, metal)).save(
        out, format="JPEG", quality=JPEG_QUALITY, optimize=True, subsampling=0
    )
    return out.getvalue()


# ── Quellen ──────────────────────────────────────────────────────────────────


def _collect_polyhaven(slug: str, client: httpx.Client) -> tuple[dict[str, bytes], str]:
    """Lädt die 2K-JPGs eines Poly-Haven-Assets. Gibt {rolle: bytes} + Titel zurück."""
    info = client.get(PH_INFO.format(slug=slug), timeout=30.0)
    info.raise_for_status()
    title = info.json().get("name", slug)

    files = client.get(PH_FILES.format(slug=slug), timeout=30.0)
    files.raise_for_status()
    files = files.json()

    # Poly Haven benennt dieselbe Rolle je nach Asset unterschiedlich —
    # Diffuse/Albedo/Color, nor_gl/nor_dx, rough/roughness, ao/AO.
    candidates = {
        COLOR: ("Diffuse", "diffuse", "albedo", "Color", "col"),
        NORMAL: ("nor_gl", "Normal", "nor_dx"),
        ROUGH: ("Rough", "rough", "roughness"),
        AO: ("AO", "ao"),
        METAL: ("Metal", "metal", "metalness"),
    }

    out: dict[str, bytes] = {}
    for role, keys in candidates.items():
        entry = next((files[k] for k in keys if k in files), None)
        if entry is None:
            continue
        url = (entry.get("2k") or {}).get("jpg", {}).get("url")
        if not url:
            continue
        response = client.get(url, timeout=120.0, follow_redirects=True)
        response.raise_for_status()
        out[role] = response.content

    if NORMAL in out and "nor_gl" not in files and "nor_dx" in files:
        # DirectX-Normalmap: Grünkanal invertieren, sonst stehen alle
        # Vertiefungen als Erhebungen im Bild (Beleuchtung kippt).
        r, g, b = _open(out[NORMAL]).convert("RGB").split()
        from PIL import ImageChops

        out[NORMAL] = _to_jpeg(Image.merge("RGB", (r, ImageChops.invert(g), b)))

    return out, title


def _collect_ambientcg(slug: str, client: httpx.Client) -> tuple[dict[str, bytes], str]:
    """Lädt das 2K-JPG-ZIP eines ambientCG-Materials und sortiert die Maps zu."""
    response = client.get(ACG_ZIP.format(slug=slug), timeout=300.0, follow_redirects=True)
    response.raise_for_status()

    # Namensschema: <Slug>_2K-JPG_Color.jpg, _NormalGL.jpg, _Roughness.jpg, ...
    suffix_roles = {
        "_color": COLOR,
        "_normalgl": NORMAL,
        "_roughness": ROUGH,
        "_ambientocclusion": AO,
        "_metalness": METAL,
    }

    out: dict[str, bytes] = {}
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        for name in archive.namelist():
            stem = Path(name).stem.lower()
            for suffix, role in suffix_roles.items():
                if stem.endswith(suffix):
                    out[role] = archive.read(name)
                    break

    return out, slug


# ── Ablage ───────────────────────────────────────────────────────────────────


def _write_source_md(directory: Path, category: str, spec: CategoryTexture, title: str, has_orm: bool):
    url = (
        f"https://polyhaven.com/a/{spec.slug}"
        if spec.source == POLYHAVEN
        else ACG_PAGE.format(slug=spec.slug)
    )
    source_name = "Poly Haven" if spec.source == POLYHAVEN else "ambientCG"
    orm_line = (
        "- `orm.jpg`: R = Ambient Occlusion, G = Roughness, B = Metallic (aus den Einzelmaps zusammengesetzt)\n"
        if has_orm
        else "- Keine `orm.jpg` — die Quelle liefert keine Roughness-Map, es gelten die konstanten Faktoren aus `tiling/textures.py`.\n"
    )
    (directory / "SOURCE.md").write_text(
        f"# {category} — {spec.label}\n\n"
        f"- Quelle: [{source_name}]({url}) — Asset `{spec.slug}` (\"{title}\")\n"
        f"- Lizenz: CC0 (public domain-äquivalent, keine Namensnennung erforderlich)\n"
        f"- Original: 2K-JPG, verkleinert auf {RESOLUTION}x{RESOLUTION}px, JPEG-Qualität {JPEG_QUALITY}\n"
        f"{orm_line}"
        f"- Volles 2K-Set liegt unter `frontend/3D Models/TEX/{category}/`\n"
        f"- Heruntergeladen mit `scripts/fetch_textures.py`\n",
        encoding="utf-8",
    )


def _load_local_maps(category: str) -> dict[str, bytes]:
    """Bereits heruntergeladene 2K-Maps aus dem TEX-Ordner."""
    tex_dir = TEX_DIR / category
    if not tex_dir.is_dir():
        return {}
    return {
        role: (tex_dir / f"{role}.jpg").read_bytes()
        for role in (COLOR, NORMAL, ROUGH, AO, METAL)
        if (tex_dir / f"{role}.jpg").is_file()
    }


def fetch_category(
    category: str,
    spec: CategoryTexture,
    client: httpx.Client,
    force: bool,
    rebuild_only: bool = False,
) -> bool:
    out_dir = LIBRARY_DIR / category
    if (out_dir / "basecolor.jpg").exists() and (out_dir / "normal.jpg").exists() and not force:
        print(f"[{category}] bereits vorhanden, übersprungen (--force zum Neuladen).")
        return True

    if rebuild_only:
        maps, title = _load_local_maps(category), spec.slug
        if not maps:
            print(f"[{category}] kein 2K-Set unter {TEX_DIR / category} — übersprungen.")
            return False
        print(f"[{category}] baue aus lokalem 2K-Set neu ...", flush=True)
    else:
        collect = _collect_polyhaven if spec.source == POLYHAVEN else _collect_ambientcg
        print(f"[{category}] lade {spec.slug} von {spec.source} ...", flush=True)
        maps, title = collect(spec.slug, client)

    if COLOR not in maps:
        print(f"[{category}] FEHLER: keine BaseColor-Map in {spec.slug} — übersprungen.")
        return False
    if NORMAL not in maps:
        print(f"[{category}] WARNUNG: keine Normal-Map in {spec.slug} — flache Oberfläche.")

    # 1. Volles 2K-Set als allgemeine Materialbibliothek
    tex_dir = TEX_DIR / category
    tex_dir.mkdir(parents=True, exist_ok=True)
    if not rebuild_only:
        for role, data in maps.items():
            (tex_dir / f"{role}.jpg").write_bytes(data)

    # 2. Verkleinertes Set fürs Tiling
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "basecolor.jpg").write_bytes(_to_jpeg(_open(maps[COLOR]), RESOLUTION))
    if NORMAL in maps:
        # Bilinear statt Lanczos: Lanczos überschwingt an Kanten und erzeugt in
        # einer Normal-Map Vektoren außerhalb des Einheitskreises.
        (out_dir / "normal.jpg").write_bytes(
            _to_jpeg(_open(maps[NORMAL]), RESOLUTION, resample=Image.BILINEAR)
        )
    else:
        # Flache Normale (128,128,255) — damit jede Kategorie dieselbe
        # Dateistruktur hat und `available()` nicht sonderfallen muss.
        (out_dir / "normal.jpg").write_bytes(
            _to_jpeg(Image.new("RGB", (RESOLUTION, RESOLUTION), (128, 128, 255)))
        )

    orm = _build_orm(maps, RESOLUTION)
    orm_path = out_dir / "orm.jpg"
    if orm:
        orm_path.write_bytes(orm)
    elif orm_path.exists():
        orm_path.unlink()

    _write_source_md(out_dir, category, spec, title, has_orm=bool(orm))
    _write_source_md(tex_dir, category, spec, title, has_orm=bool(orm))

    sizes = " + ".join(f"{r}" for r in sorted(maps))
    print(f"[{category}] ok — {sizes}{' + orm' if orm else ''}")
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("categories", nargs="*", help="nur diese Kategorien (Standard: alle)")
    parser.add_argument("--force", action="store_true", help="vorhandene Sets neu laden")
    parser.add_argument(
        "--prune", action="store_true", help="Bibliotheksordner ohne Registry-Eintrag löschen"
    )
    parser.add_argument(
        "--rebuild-library",
        action="store_true",
        help="512px-Sets aus den vorhandenen 2K-Dateien neu erzeugen, ohne Download",
    )
    args = parser.parse_args()

    selected = args.categories or list(CATEGORIES)
    unknown = [c for c in selected if c not in CATEGORIES]
    if unknown:
        parser.error(f"Unbekannte Kategorie(n): {', '.join(unknown)}")

    if args.prune and LIBRARY_DIR.is_dir():
        for directory in LIBRARY_DIR.iterdir():
            if directory.is_dir() and directory.name not in CATEGORIES:
                print(f"[{directory.name}] nicht mehr in der Registry — entfernt.")
                shutil.rmtree(directory)

    # Neu bauen heißt immer überschreiben, sonst überspringt der Vorhandensein-Check alles.
    force = args.force or args.rebuild_library

    failed = []
    with httpx.Client(headers={"User-Agent": "ileen-texture-fetch/2.0"}) as client:
        for category in selected:
            try:
                if not fetch_category(
                    category, CATEGORIES[category], client, force, args.rebuild_library
                ):
                    failed.append(category)
            except Exception as e:
                print(f"[{category}] FEHLER: {type(e).__name__}: {e}")
                failed.append(category)

    print(f"\n{len(selected) - len(failed)}/{len(selected)} Kategorien bereit.")
    if failed:
        print("Fehlgeschlagen: " + ", ".join(failed))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
