"""
MinIO S3-Client: Singleton + Upload-Hilfsfunktionen.
"""

import io
import json
import math
import os
from pathlib import Path
from minio import Minio
from minio.deleteobjects import DeleteObject

_client: Minio | None = None


def get_minio() -> Minio:
    global _client
    if _client is None:
        _client = Minio(
            endpoint=os.getenv("MINIO_ENDPOINT", "localhost:9000"),
            access_key=os.getenv("MINIO_ACCESS_KEY", "minioadmin"),
            secret_key=os.getenv("MINIO_SECRET_KEY", "minioadmin"),
            secure=os.getenv("MINIO_SECURE", "false").lower() == "true",
        )
        _ensure_buckets(_client)
    return _client


def _ensure_buckets(client: Minio):
    # `fem` trägt die Statikrechnungen aus dem Zeichenmodus: Eingabemodell,
    # Bericht und Ergebnisbilder. Bewusst neben `tiles` und nicht darin — das
    # Re-Tiling nach einer Texturänderung leert den Tile-Präfix des Jobs, und
    # eine Deckenrechnung hat mit den Texturen nichts zu tun.
    # `tragwerk` trägt den geschossweisen Lastabtrag: Bauteilkonten,
    # Geschossberichte, Ergebnisbilder. Neben `fem` und nicht darin, weil beide
    # verschiedene Lebensdauern haben — eine Decke wird zwanzigmal neu
    # gerechnet, ein Lastabtrag steht einmal für das ganze Haus.
    # `tour` trägt die 360°-Rundgänge: je Tour eine tour.json und ihre
    # Panorama-Bilder. Neben den übrigen, weil ein Rundgang ein eigenes
    # Erzeugnis ist (Fotos + Lage), das keinen Tile-Job und keine Rechnung hat.
    # `einsturz` trägt Einsturzsimulationen (api/routes/einsturz.py). Nicht
    # unter `tiles/<job>/`, obwohl sie zu einem Modell gehören: ein erneutes
    # Tiling leert diesen Präfix, und eine Rechnung von Stunden verschwände mit.
    # `exports` trägt, was sich aus einem Asset ableiten lässt und herausgegeben wird: die
    # Splat-PLY von Assets, die nicht als PLY hochgeladen wurden (Laserscan, Foto-Training),
    # und die SOG-Exporte. Neben `tiles`, weil das Re-Tiling dessen Präfix leert.
    for bucket in ("uploads", "tiles", "semantic", "fem", "tragwerk", "tour", "einsturz", "exports"):
        if not client.bucket_exists(bucket):
            client.make_bucket(bucket)


def ohne_nan(daten):
    """
    NaN und ±Infinity zu `None` — JSON kennt sie nicht.

    Python schreibt sie klaglos als nackte Literale `NaN`/`Infinity`, und der
    eigene Leser nimmt sie auch wieder an; erst FastAPI bricht beim Ausliefern
    ab („Out of range float values are not JSON compliant"). Der Fehler fällt
    damit nicht dort auf, wo der Wert entsteht, sondern Minuten später beim
    Abruf — und im Browser kommt von einem so gescheiterten Antwortkörper nur
    „Failed to fetch" an, weil die 500 an der CORS-Schicht vorbei entsteht.
    Deshalb wird an der Ablage sauber gemacht, in beide Richtungen: `null`
    heißt in JSON dasselbe wie „kein Wert" und ist überall lesbar.
    """
    if isinstance(daten, float):
        return None if not math.isfinite(daten) else daten
    if isinstance(daten, dict):
        return {k: ohne_nan(v) for k, v in daten.items()}
    if isinstance(daten, (list, tuple)):
        return [ohne_nan(v) for v in daten]
    return daten


def _zahl(wert):
    """
    `default` für `json.dumps`: numpy-Skalare zu Zahlen, nicht-endliche zu `None`.

    `float(...)` allein reichte nicht — eine `np.float32('nan')` käme als
    Python-NaN heraus und wäre wieder unschreibbar.
    """
    zahl = float(wert)
    return zahl if math.isfinite(zahl) else None


def json_bytes(daten, indent: int | None = 2) -> bytes:
    """
    Ein Bericht als JSON-Text, der garantiert wieder gelesen werden kann.

    Der Weg für alles, was über `put_bytes` selbst geschrieben wird statt über
    `put_json` — siehe `ohne_nan` dazu, warum das nicht dem Zufall überlassen
    bleiben darf.
    """
    return json.dumps(ohne_nan(daten), ensure_ascii=False, indent=indent,
                      default=_zahl).encode("utf-8")


def get_json(bucket: str, object_name: str) -> dict:
    """Liest ein JSON-Objekt aus MinIO. Wirft S3Error, wenn es nicht existiert."""
    response = get_minio().get_object(bucket, object_name)
    try:
        # `parse_constant` fängt die Altbestände ab: Berichte, die vor dieser
        # Bereinigung geschrieben wurden, tragen das Literal `NaN` im Text.
        return json.loads(response.read(), parse_constant=lambda _: None)
    finally:
        response.close()
        response.release_conn()


def put_json(bucket: str, object_name: str, data: dict):
    """Schreibt ein JSON-Objekt nach MinIO (überschreibt vorhandene)."""
    payload = json.dumps(ohne_nan(data), indent=2).encode("utf-8")
    get_minio().put_object(
        bucket_name=bucket,
        object_name=object_name,
        data=io.BytesIO(payload),
        length=len(payload),
        content_type="application/json",
    )


def get_bytes(bucket: str, object_name: str) -> bytes:
    """Liest ein Objekt roh aus MinIO. Wirft S3Error, wenn es nicht existiert."""
    response = get_minio().get_object(bucket, object_name)
    try:
        return response.read()
    finally:
        response.close()
        response.release_conn()


def put_bytes(bucket: str, object_name: str, data: bytes, content_type: str = "application/octet-stream"):
    """Schreibt rohe Bytes nach MinIO (überschreibt vorhandene)."""
    get_minio().put_object(
        bucket_name=bucket,
        object_name=object_name,
        data=io.BytesIO(data),
        length=len(data),
        content_type=content_type,
    )


def delete_prefix(bucket: str, prefix: str):
    """
    Löscht rekursiv alle Objekte unter einem Präfix — das Gegenstück zu
    `upload_directory()`. Ein leeres Präfix (Bucket-Root) wird bewusst nicht
    abgefangen: dann listet MinIO den ganzen Bucket, was hier nie gewollt ist.
    """
    if not prefix:
        raise ValueError("delete_prefix() ohne Präfix würde den gesamten Bucket leeren.")
    client = get_minio()
    to_delete = (DeleteObject(obj.object_name) for obj in client.list_objects(bucket, prefix=prefix, recursive=True))
    for error in client.remove_objects(bucket, to_delete):
        raise RuntimeError(f"Löschen fehlgeschlagen: {error}")


def upload_directory(local_dir: Path, bucket: str, prefix: str):
    """Lädt alle Dateien eines lokalen Verzeichnisses rekursiv in MinIO hoch."""
    client = get_minio()
    for file in local_dir.rglob("*"):
        if not file.is_file():
            continue
        relative = file.relative_to(local_dir)
        object_name = f"{prefix}/{relative}"
        client.fput_object(
            bucket_name=bucket,
            object_name=object_name,
            file_path=str(file),
        )
