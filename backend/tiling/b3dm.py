"""
B3DM-Encoder (3D Tiles 1.0, Batched 3D Model).

Der Container ist ein 28-Byte-Header, gefolgt von Feature Table (JSON+Binary),
Batch Table (JSON+Binary) und dem eingebetteten GLB.

Drei Details, an denen die Validierung sonst scheitert:
  * Die Feature Table **muss** `BATCH_LENGTH` definieren — ein leeres `{}`
    quittiert Cesium mit "Feature table global property: BATCH_LENGTH must be defined".
  * Der GLB-Abschnitt muss auf einer 8-Byte-Grenze beginnen.
  * Auch die **Gesamtlänge** des Tiles muss durch 8 teilbar sein. Da GLB-Chunks
    immer 4-Byte-aligned sind, fehlen dafür entweder 0 oder 4 Bytes; sie werden
    in den letzten GLB-Chunk gepaddet (spec-konform: 0x00 im BIN-Chunk,
    Leerzeichen im JSON-Chunk).
"""

import json
import struct

_HEADER_SIZE = 28
_GLB_HEADER_SIZE = 12
_CHUNK_TYPE_JSON = 0x4E4F534A


def _pad_json(data: bytes, offset: int) -> bytes:
    """Padded JSON mit Leerzeichen auf 8-Byte-Grenze (bezogen auf `offset`)."""
    pad = (8 - (offset + len(data)) % 8) % 8
    return data + b" " * pad


def _pad_glb(glb: bytes) -> bytes:
    """
    Füllt ein GLB auf ein Vielfaches von 8 Bytes auf.

    Gepaddet wird der JSON-Chunk mit Leerzeichen — glTF sieht das ausdrücklich
    vor. Padding im BIN-Chunk wäre zwar ebenfalls zulässig, der Cesium-Validator
    meldet dafür aber "extra padding byte(s)". Die bufferView-Offsets sind
    relativ zum BIN-Chunk und bleiben dadurch unberührt.
    """
    pad = (8 - len(glb) % 8) % 8
    if pad == 0:
        return glb

    json_length, chunk_type = struct.unpack("<II", glb[_GLB_HEADER_SIZE : _GLB_HEADER_SIZE + 8])
    if chunk_type != _CHUNK_TYPE_JSON:
        raise ValueError("Unerwartetes GLB-Layout: erster Chunk ist kein JSON-Chunk.")

    json_end = _GLB_HEADER_SIZE + 8 + json_length
    out = bytearray(glb[:json_end])
    out.extend(b" " * pad)                                        # JSON-Chunk auffüllen
    out.extend(glb[json_end:])
    struct.pack_into("<I", out, _GLB_HEADER_SIZE, json_length + pad)  # Chunk-Länge
    struct.pack_into("<I", out, 8, len(glb) + pad)                    # GLB-Gesamtlänge
    return bytes(out)


def glb_to_b3dm(
    glb: bytes, batch_length: int = 0, batch_table: dict | None = None
) -> bytes:
    """
    Verpackt ein GLB in ein B3DM-Tile.

    `batch_table` hält je Batch-Index die Eigenschaften des zugehörigen
    Bauteils — als Dictionary von Spaltennamen auf Listen der Länge
    `batch_length`. CesiumJS macht daraus `Cesium3DTileFeature`-Objekte, deren
    `getProperty()` genau diese Namen kennt. Ohne Batch Table ist ein Tile eine
    einzige anonyme Geometrie und nichts darin anklickbar.
    """
    glb = _pad_glb(glb)
    ft_json = _pad_json(
        json.dumps({"BATCH_LENGTH": batch_length}).encode("utf-8"), _HEADER_SIZE
    )
    ft_bin = b""
    bt_bin = b""

    if batch_table:
        for name, values in batch_table.items():
            if len(values) != batch_length:
                raise ValueError(
                    f"Batch-Table-Spalte '{name}' hat {len(values)} Werte, "
                    f"erwartet sind {batch_length}."
                )
        # Auch die Batch Table zählt beim 8-Byte-Alignment des GLB mit — der
        # Offset ist deshalb Header + Feature Table, nicht nur der Header.
        bt_json = _pad_json(
            json.dumps(batch_table, ensure_ascii=False).encode("utf-8"),
            _HEADER_SIZE + len(ft_json) + len(ft_bin),
        )
    else:
        bt_json = b""

    total = _HEADER_SIZE + len(ft_json) + len(ft_bin) + len(bt_json) + len(bt_bin) + len(glb)

    header = (
        b"b3dm"
        + struct.pack("<I", 1)            # version
        + struct.pack("<I", total)        # byteLength
        + struct.pack("<I", len(ft_json))
        + struct.pack("<I", len(ft_bin))
        + struct.pack("<I", len(bt_json))
        + struct.pack("<I", len(bt_bin))
    )
    return header + ft_json + ft_bin + bt_json + bt_bin + glb
