"""
SPZ-Encoder (Niantic Gaussian-Splat-Container, Legacy-Version 2).

**Warum überhaupt SPZ.** CesiumJS rendert Gaussian Splats nur über die
glTF-Extensions `KHR_gaussian_splatting` + `KHR_gaussian_splatting_compression_spz_2`.
Die unkomprimierte Variante ist zwar spezifiziert, aber in CesiumJS 1.141 nicht
benutzbar: `GltfLoader` legt Vertexattribute nur dann als *typed array* ab, wenn
ein Nachbearbeitungsschritt sie anfordert — und den setzt ausschließlich der
SPZ-Zweig (`PrimitiveLoadPlan.needsGaussianSplats`). `GaussianSplat3DTileContent`
greift danach hart auf `attribute.typedArray` zu. Ohne SPZ ist das Feld leer und
das Tile stirbt beim ersten Frame. Der Container ist damit nicht optional.

**Format (Version 2, alles Little Endian, das Ganze gzip-komprimiert):**

```
Header, 16 Byte:  magic uint32 = 0x5053474E ("NGSP")
                  version uint32 = 2
                  numPoints uint32
                  shDegree uint8, fractionalBits uint8, flags uint8, reserved uint8
Daten:            positions  numPoints * 3 * 3 Byte   (24-bit Festkomma)
                  alphas     numPoints * 1 Byte
                  colors     numPoints * 3 Byte
                  scales     numPoints * 3 Byte
                  rotations  numPoints * 3 Byte       (x,y,z; w wird rekonstruiert)
                  sh         numPoints * shDim * 3    (je Punkt Koeffizient für
                                                       Koeffizient, darin R, G, B)
```

Die Quantisierung ist nicht frei wählbar — die Konstanten müssen exakt denen des
Decoders entsprechen, sonst stimmen Farbe und Größe der Splats nicht:

| Feld     | gepackt                                  | Decoder liefert          |
|----------|------------------------------------------|--------------------------|
| Position | `round(p * 2^12)` als int24              | `wert / 2^12`            |
| Skalen   | `(log σ + 10) * 16`                      | `exp(byte/16 - 10)`      |
| Rotation | `q.xyz * 127.5 + 127.5`, w ≥ 0           | `w = √(1 - |xyz|²)`      |
| Alpha    | `sigmoid(opacity) * 255`                 | Alpha direkt             |
| Farbe    | `f_dc * 0.15 * 255 + 127.5`              | `f_dc * 0.282 + 0.5`     |

Die Farbkonstante 0.15 begrenzt |f_dc| auf ±3,33; darüber hinaus wird geklemmt.
Das entspricht ungefähr dem Kontrastumfang, den 3DGS-Trainings tatsächlich
erzeugen, und ist Teil des Formats — nicht verhandelbar.

**Höhere SH-Ordnungen** (seit #8, abschaltbar über `SPLAT_SH_GRAD`): je
Koeffizient `round(x·128) + 128`, danach auf ein Raster gerundet — 5 Bit für
Grad 1, 4 Bit für Grad 2 und 3 (`quantizeSH` mit `sh1Bits`/`shRestBits` der
Niantic-Referenz). Der Decoder braucht die Bitzahl nicht, er liest die Bytes
als `(b − 128)/128`; das Raster macht die Daten nur gzip-freundlicher.

Keine Koordinatenumrechnung, weder hier noch bei den Positionen: CesiumJS
entpackt mit `coordinateSystem: "UNSPECIFIED"` (GltfSpzLoader.js), liest also
zurück, was geschrieben wurde. Der Draft der Extension (KHR PR #2531) verlangt
beim Packen LUF — das passt zu CesiumJS 1.145 nicht zusammen und bleibt
deshalb außen vor, solange der Viewer richtig herum zeigt.
"""

import gzip
import logging
import struct

import numpy as np

logger = logging.getLogger(__name__)

MAGIC = 0x5053474E
VERSION = 2
FRACTIONAL_BITS = 12
COLOR_SCALE = 0.15

_INT24_MIN = -(1 << 23)
_INT24_MAX = (1 << 23) - 1

# Bei 12 Nachkommabits reicht der Wertebereich für ±2048 m um den Tile-Ursprung.
# Darüber hinaus würde die Festkommazahl überlaufen und Punkte an die
# gegenüberliegende Ecke klappen — deshalb wird gewarnt statt still geklemmt.
POSITION_LIMIT_M = (1 << 23) / (1 << FRACTIONAL_BITS)


def _to_uint8(values: np.ndarray) -> np.ndarray:
    """`toUint8` aus spz: erst runden, dann auf 0…255 klemmen."""
    return np.clip(np.round(values), 0.0, 255.0).astype(np.uint8)


def _pack_positions(xyz: np.ndarray) -> np.ndarray:
    """Positionen als 24-Bit-Festkomma, 3 Byte je Komponente."""
    if np.abs(xyz).max(initial=0.0) > POSITION_LIMIT_M:
        logger.warning(
            f"Splat-Positionen überschreiten ±{POSITION_LIMIT_M:.0f} m um den "
            "Tile-Ursprung — SPZ-Festkomma läuft über, Tile bitte feiner teilen."
        )
    fixed = np.clip(
        np.round(xyz.astype(np.float64) * (1 << FRACTIONAL_BITS)), _INT24_MIN, _INT24_MAX
    ).astype(np.int32)
    return np.stack(
        [fixed & 0xFF, (fixed >> 8) & 0xFF, (fixed >> 16) & 0xFF], axis=-1
    ).astype(np.uint8)


def _pack_rotations(quat_xyzw: np.ndarray) -> np.ndarray:
    """
    Quaternionen als 3 Byte: normalisiert, Vorzeichen so gedreht, dass w ≥ 0 ist.

    Der Decoder rechnet `w = √(1 - x² - y² - z²)` und kann ein negatives w nicht
    darstellen. Da q und -q dieselbe Rotation beschreiben, ist das Umklappen
    verlustfrei.
    """
    quats = quat_xyzw.astype(np.float64)
    norm = np.linalg.norm(quats, axis=1, keepdims=True)
    # Entartete Quaternionen (kommen in exportierten PLYs vereinzelt vor) auf die
    # Identität setzen, statt durch Null zu teilen.
    degenerate = norm[:, 0] < 1e-12
    quats = np.where(norm > 1e-12, quats / np.maximum(norm, 1e-12), quats)
    quats[degenerate] = (0.0, 0.0, 0.0, 1.0)
    quats *= np.where(quats[:, 3:4] < 0.0, -1.0, 1.0)
    return _to_uint8(quats[:, :3] * 127.5 + 127.5)


SH1_BITS = 5
SH_REST_BITS = 4


def _pack_sh(sh: np.ndarray) -> np.ndarray:
    """
    SH-Koeffizienten (N, K, 3) als Bytes, Grad 1 mit 5 Bit, der Rest mit 4 Bit.

    Entspricht `quantizeSH()` der Referenz: erst auf 8 Bit, dann auf die Mitte
    des Rasterfeldes, wobei die Null immer genau getroffen wird.
    """
    q = np.round(sh.astype(np.float64) * 128.0) + 128.0
    feld = np.full(sh.shape[1], 1 << (8 - SH_REST_BITS), dtype=np.int64)
    feld[:3] = 1 << (8 - SH1_BITS)
    feld = feld[None, :, None]
    q = (q.astype(np.int64) + feld // 2) // feld * feld
    return np.clip(q, 0, 255).astype(np.uint8)


def sh_grad_von(koeffizienten: int) -> int:
    """Grad aus der Zahl der Koeffizienten ohne DC: 0, 3, 8, 15 → 0…3."""
    return {0: 0, 3: 1, 8: 2, 15: 3}[koeffizienten]


def encode(
    xyz: np.ndarray,
    log_scales: np.ndarray,
    quat_xyzw: np.ndarray,
    opacity_logit: np.ndarray,
    sh_dc: np.ndarray,
    antialiased: bool = False,
    sh: np.ndarray | None = None,
) -> bytes:
    """
    Packt einen Splat-Satz in einen SPZ-v2-Container (gzip-komprimiert).

    Alle Arrays kommen roh aus dem 3DGS-PLY, also `scale_*` logarithmisch,
    `opacity` als Logit und `f_dc_*` als SH-DC-Koeffizient — genau die Größen,
    für die die Quantisierung ausgelegt ist.
    """
    count = len(xyz)
    if not (len(log_scales) == len(quat_xyzw) == len(opacity_logit) == len(sh_dc) == count):
        raise ValueError("Splat-Attribute haben unterschiedliche Längen.")

    alphas = _to_uint8(255.0 / (1.0 + np.exp(-opacity_logit.astype(np.float64))))
    colors = _to_uint8(sh_dc.astype(np.float64) * (COLOR_SCALE * 255.0) + 127.5)
    scales = _to_uint8((log_scales.astype(np.float64) + 10.0) * 16.0)
    sh_grad = 0 if sh is None else sh_grad_von(sh.shape[1])

    header = struct.pack(
        "<IIIBBBB",
        MAGIC,
        VERSION,
        count,
        sh_grad,
        FRACTIONAL_BITS,
        0x1 if antialiased else 0x0,
        0,                    # reserved
    )

    payload = b"".join(
        (
            header,
            _pack_positions(xyz).tobytes(),
            alphas.tobytes(),
            colors.tobytes(),
            scales.tobytes(),
            _pack_rotations(quat_xyzw).tobytes(),
            _pack_sh(sh).tobytes() if sh_grad else b"",
        )
    )
    # mtime=0: gleiche Eingabe → gleiche Bytes, damit sich Tiles vergleichen lassen
    return gzip.compress(payload, compresslevel=6, mtime=0)
