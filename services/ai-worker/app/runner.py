"""Consumidor de la cola de procesamiento (E4-4, E4-9, E4-10).

Por qué la cola vive en PostgreSQL y no en Redis
------------------------------------------------
ADR-007: Redis solo contiene trabajo en tránsito; perderlo no puede perder
información. Un documento cargado y pendiente de procesar **es** información de
negocio: si Redis se reinicia, ese trabajo no puede desaparecer.

`SELECT ... FOR UPDATE SKIP LOCKED` da exclusión mutua entre varios workers sin
necesidad de un broker: cada uno toma un job distinto y nadie espera al otro.

Idempotencia (E4-10)
--------------------
Reprocesar borra los fragmentos previos del documento dentro de la misma
transacción que inserta los nuevos. Un job ejecutado dos veces deja el mismo
resultado que ejecutado una vez.
"""

from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, List, Optional

from . import embeddings, parsers
from .parsers.base import Fragment, ParseError

logger = logging.getLogger("ai-worker.runner")

#: Espera entre reintentos: 1 min, 5 min, 15 min.
BACKOFF_SEGUNDOS = [60, 300, 900]

def _raiz_probable() -> Path:
    """Raíz desde la que resolver rutas relativas.

    En el monorepo son tres niveles hacia arriba; dentro del contenedor el
    código vive en `/app` y esos tres niveles no existen. Contarlos a ciegas
    —y encima al importar el módulo— hacía que el consumidor **ni siquiera
    arrancara** en Docker, con un IndexError que no menciona rutas ni
    almacenamiento.
    """
    aqui = Path(__file__).resolve()
    padres = aqui.parents
    return padres[3] if len(padres) > 3 else padres[len(padres) - 1]


def ruta_de_almacenamiento() -> Path:
    """Directorio de los originales. Debe coincidir con `packages/db/storage.ts`.

    La base de datos guarda una referencia relativa (`file_id`); el prefijo lo
    resuelve cada proceso desde su configuración. Nunca se usa el directorio de
    trabajo: web, worker y scripts arrancan desde sitios distintos.
    """
    configurada = os.environ.get("STORAGE_LOCAL_PATH", "").strip()
    if not configurada:
        return _raiz_probable() / ".storage"
    ruta = Path(configurada)
    return ruta if ruta.is_absolute() else (_raiz_probable() / ruta).resolve()


@dataclass(frozen=True)
class Job:
    id: str
    source_id: str
    intentos: int
    max_intentos: int
    file_path: str
    mime_type: str
    filename: str


def _backoff(intentos: int) -> int:
    indice = min(intentos, len(BACKOFF_SEGUNDOS) - 1)
    return BACKOFF_SEGUNDOS[indice]


def tomar_job(conn: Any) -> Optional[Job]:
    """Toma un job disponible y lo marca como ejecutando, de forma atómica."""
    with conn.cursor() as cur:
        cur.execute(
            """
            WITH tomado AS (
              SELECT j.id
                FROM processing_jobs j
               WHERE j.status = 'pendiente'
                 AND j.disponible_en <= now()
               ORDER BY j.created_at
               FOR UPDATE SKIP LOCKED
               LIMIT 1
            )
            UPDATE processing_jobs j
               SET status = 'ejecutando',
                   intentos = j.intentos + 1,
                   started_at = now()
              FROM tomado, source_documents s
             WHERE j.id = tomado.id
               AND s.id = j.source_id
            RETURNING j.id, j.source_id, j.intentos, j.max_intentos,
                      s.file_id, s.mime_type, s.filename
            """
        )
        fila = cur.fetchone()

    if fila is None:
        # Cerrar la transacción aunque no haya trabajo. Dejarla abierta mantiene
        # la conexión en `idle in transaction`: retiene el snapshot inicial, con
        # lo que el sondeo deja de ver los jobs nuevos, y además bloquea el
        # vacuum. Es exactamente el fallo que hacía que el worker arrancara bien
        # y no consumiera nunca.
        conn.rollback()
        return None

    conn.commit()
    return Job(
        id=str(fila[0]),
        source_id=str(fila[1]),
        intentos=int(fila[2]),
        max_intentos=int(fila[3]),
        file_path=str(fila[4]),
        mime_type=str(fila[5]),
        filename=str(fila[6]),
    )


def _guardar_fragmentos(conn: Any, source_id: str, fragmentos: List[Fragment]) -> None:
    with conn.cursor() as cur:
        # Idempotencia: se parte de cero para este documento.
        cur.execute("DELETE FROM source_fragments WHERE source_id = %s", (source_id,))

        for f in fragmentos:
            cur.execute(
                """
                INSERT INTO source_fragments
                       (source_id, ordinal, page, slide, section, linea, text, metadata)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s::jsonb)
                """,
                (
                    source_id,
                    f.ordinal,
                    f.page,
                    f.slide,
                    f.section,
                    f.linea,
                    f.text,
                    _json(f.metadata),
                ),
            )


def _json(valor: Any) -> str:
    import json

    return json.dumps(valor, ensure_ascii=False)


def marcar_exito(conn: Any, job: Job, total: int) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE processing_jobs SET status='completado', finished_at=now(), error=NULL WHERE id=%s",
            (job.id,),
        )
        cur.execute("UPDATE source_documents SET status='procesado' WHERE id=%s", (job.source_id,))
    conn.commit()
    logger.info("Documento %s procesado: %d fragmentos", job.filename, total)


def marcar_fallo(conn: Any, job: Job, mensaje: str) -> None:
    """Reencola con backoff, o marca fallido definitivo al agotar los intentos."""
    agotado = job.intentos >= job.max_intentos

    with conn.cursor() as cur:
        if agotado:
            cur.execute(
                "UPDATE processing_jobs SET status='fallido', finished_at=now(), error=%s WHERE id=%s",
                (mensaje, job.id),
            )
            cur.execute("UPDATE source_documents SET status='fallido' WHERE id=%s", (job.source_id,))
        else:
            espera = _backoff(job.intentos)
            cur.execute(
                """UPDATE processing_jobs
                      SET status='pendiente',
                          error=%s,
                          disponible_en = now() + make_interval(secs => %s)
                    WHERE id=%s""",
                (mensaje, espera, job.id),
            )
    conn.commit()

    if agotado:
        logger.error("Documento %s falló definitivamente: %s", job.filename, mensaje)
    else:
        logger.warning(
            "Documento %s falló (intento %d/%d), se reintenta: %s",
            job.filename,
            job.intentos,
            job.max_intentos,
            mensaje,
        )


def procesar(conn: Any, job: Job) -> bool:
    """Procesa un job. Devuelve True si tuvo éxito."""
    # `job.file_path` es la referencia relativa que guarda la base (§10.3,
    # regla 5). El prefijo lo pone cada proceso desde su configuración.
    ruta = ruta_de_almacenamiento() / job.file_path

    try:
        fragmentos = parsers.parse(str(ruta), job.mime_type)
    except ParseError as exc:
        # Error esperado y legible: llega tal cual a la interfaz (E4-8).
        marcar_fallo(conn, job, str(exc))
        return False
    except FileNotFoundError:
        marcar_fallo(conn, job, "El archivo original no está disponible en el almacenamiento.")
        return False
    except Exception as exc:  # noqa: BLE001
        # Error inesperado: se registra el detalle en el log, pero al usuario se
        # le da un mensaje genérico (§11.6: no exponer trazas internas).
        logger.exception("Error inesperado procesando %s", job.filename)
        marcar_fallo(conn, job, f"Error inesperado al procesar el archivo ({type(exc).__name__}).")
        return False

    try:
        _guardar_fragmentos(conn, job.source_id, fragmentos)
        conn.commit()
    except Exception:  # noqa: BLE001 — se reencola abajo
        conn.rollback()
        logger.exception("No se pudieron guardar los fragmentos de %s", job.filename)
        marcar_fallo(conn, job, "No se pudieron guardar los fragmentos extraídos.")
        return False

    # Indexación vectorial (E5-2). Va después del commit de los fragmentos y a
    # propósito no puede fallar el job: el parseo ya quedó bien, y un documento
    # sin índice sigue siendo un documento procesado y consultable. Si el
    # proveedor está caído, se reindexa después sin volver a parsear.
    try:
        resultado = embeddings.indexar_documento(conn, job.source_id)
        if resultado.motivo and not resultado.se_indexo:
            logger.info("%s sin índice vectorial: %s", job.filename, resultado.motivo)
    except Exception:  # noqa: BLE001
        conn.rollback()
        logger.exception("Falló la indexación vectorial de %s; el documento queda procesado", job.filename)

    marcar_exito(conn, job, len(fragmentos))
    return True


def ciclo(conn: Any, intervalo: float = 2.0, max_jobs: Optional[int] = None) -> int:
    """Bucle principal. `max_jobs` acota la ejecución, útil en pruebas."""
    procesados = 0
    while max_jobs is None or procesados < max_jobs:
        job = tomar_job(conn)
        if job is None:
            if max_jobs is not None:
                break
            time.sleep(intervalo)
            continue

        logger.info("Procesando %s (intento %d)", job.filename, job.intentos)
        procesar(conn, job)
        procesados += 1

    return procesados
