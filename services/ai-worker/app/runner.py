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

Dos tipos de job (V2 · Fase 5)
------------------------------
  · `source_ingest_file`: un archivo subido, como siempre (reemplazo idempotente).
  · `google_sheet_sync`: la sincronización de un Google Sheet registrado, mediante
    la integración explícita de `google_sheets.py`. NO reemplaza nada: cada
    lectura distinta crea un SNAPSHOT inmutable nuevo (fila, celdas y fragmentos
    propios) y solo entonces lo vuelve el vigente, en la misma transacción. Una
    lectura idéntica no crea snapshot; una fallida no toca el vigente.
"""

from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import embeddings, google_sheets, parsers
from .parsers.base import Fragment, ParseError, Resultado
from .parsers.tabular import construir_resultado

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
    organization_id: str = ""
    #: `source_ingest_file` | `google_sheet_sync` (columna `processing_jobs.kind`).
    kind: str = "source_ingest_file"
    #: Solo `google_sheet_sync`: de dónde leer. Nunca una URL: el id del libro y,
    #: si el enlace apuntaba a una pestaña, su `gid`.
    external_id: str = ""
    gid: str = ""


def _backoff(intentos: int) -> int:
    indice = min(intentos, len(BACKOFF_SEGUNDOS) - 1)
    return BACKOFF_SEGUNDOS[indice]


def tomar_job(conn: Any) -> Job | None:
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
                      s.file_id, s.mime_type, s.filename, s.organization_id,
                      j.kind, s.external_id, s.external_metadata
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
    metadata = fila[10] if isinstance(fila[10], dict) else {}
    return Job(
        id=str(fila[0]),
        source_id=str(fila[1]),
        intentos=int(fila[2]),
        max_intentos=int(fila[3]),
        # Un enlace no tiene archivo local: file_id y mime_type son NULL.
        file_path=str(fila[4]) if fila[4] is not None else "",
        mime_type=str(fila[5]) if fila[5] is not None else "",
        filename=str(fila[6]),
        organization_id=str(fila[7]),
        kind=str(fila[8]),
        external_id=str(fila[9]) if fila[9] is not None else "",
        gid=str(metadata.get("gid", "")),
    )


def _guardar_fragmentos(conn: Any, source_id: str, fragmentos: list[Fragment]) -> None:
    with conn.cursor() as cur:
        # Idempotencia: se parte de cero para este documento. Solo los fragmentos
        # de archivo (sin snapshot): los de un snapshot no se borran jamás.
        cur.execute(
            "DELETE FROM source_fragments WHERE source_id = %s AND snapshot_id IS NULL", (source_id,)
        )

        for f in fragmentos:
            cur.execute(
                """
                INSERT INTO source_fragments
                       (source_id, ordinal, page, slide, section, linea, locator, text, metadata)
                VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s::jsonb)
                """,
                (
                    source_id,
                    f.ordinal,
                    f.page,
                    f.slide,
                    f.section,
                    f.linea,
                    # NULL = la base lo deriva de page/slide/section/linea (formatos legacy).
                    _json(f.locator) if f.locator is not None else None,
                    f.text,
                    _json(f.metadata),
                ),
            )


def _json(valor: Any) -> str:
    import json

    return json.dumps(valor, ensure_ascii=False)


def _guardar_estructura(conn: Any, source_id: str, resultado: Resultado) -> None:
    """Estructura normalizada del documento (p. ej. el manifiesto de un libro).

    Reemplaza la anterior: reprocesar no acumula (idempotencia). Va en la misma
    transacción que los fragmentos.
    """
    with conn.cursor() as cur:
        cur.execute(
            "DELETE FROM source_representations WHERE source_id = %s AND kind = 'structure'",
            (source_id,),
        )
        if resultado.estructura is not None:
            cur.execute(
                """
                INSERT INTO source_representations (source_id, kind, format, content, generator)
                VALUES (%s, 'structure', %s, %s::jsonb, %s)
                """,
                (
                    source_id,
                    resultado.formato or "desconocido",
                    _json(resultado.estructura),
                    resultado.generador or "ai-worker",
                ),
            )


def _auditar(conn: Any, job: Job, accion: str, metadata: dict[str, Any]) -> None:
    """Evento de auditoría de la ingestión (origen `system`, sin actor humano)."""
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO audit_events
                   (organization_id, actor_id, action, entity_type, entity_id, metadata, origin)
            VALUES (%s, NULL, %s, 'source_document', %s, %s::jsonb, 'system')
            """,
            (job.organization_id, accion, job.source_id, _json(metadata)),
        )


def marcar_exito(conn: Any, job: Job, total: int, extra: dict[str, Any] | None = None) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE processing_jobs SET status='completado', finished_at=now(), error=NULL WHERE id=%s",
            (job.id,),
        )
        cur.execute("UPDATE source_documents SET status='procesado' WHERE id=%s", (job.source_id,))
    _auditar(
        conn,
        job,
        "source.ingest_completed",
        {"mimeType": job.mime_type, "fragmentos": total, **(extra or {})},
    )
    conn.commit()
    logger.info("Documento %s procesado: %d fragmentos", job.filename, total)


def marcar_fallo(
    conn: Any,
    job: Job,
    mensaje: str,
    *,
    definitivo: bool = False,
    codigo: str | None = None,
) -> None:
    """Reencola con backoff, o marca fallido definitivo al agotar los intentos.

    `definitivo=True` (un fallo determinista, p. ej. un libro con macros o fuera
    de límites) lo deja `fallido` de inmediato: reintentarlo daría lo mismo.
    """
    agotado = definitivo or job.intentos >= job.max_intentos

    with conn.cursor() as cur:
        if agotado:
            cur.execute(
                "UPDATE processing_jobs SET status='fallido', finished_at=now(), error=%s WHERE id=%s",
                (mensaje, job.id),
            )
            cur.execute("UPDATE source_documents SET status='fallido' WHERE id=%s", (job.source_id,))
            _auditar(
                conn,
                job,
                "source.ingest_failed",
                {"mimeType": job.mime_type, "intentos": job.intentos, "codigo": codigo, "motivo": mensaje},
            )
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


def procesar(conn: Any, job: Job, proveedor: google_sheets.ProveedorGoogleSheets | None = None) -> bool:
    """Procesa un job. Devuelve True si tuvo éxito."""
    if job.kind == "google_sheet_sync":
        return sincronizar_google_sheet(conn, job, proveedor)

    # `job.file_path` es la referencia relativa que guarda la base (§10.3,
    # regla 5). El prefijo lo pone cada proceso desde su configuración.
    ruta = ruta_de_almacenamiento() / job.file_path

    try:
        parseado = parsers.parse_completo(str(ruta), job.mime_type)
        fragmentos = parseado.fragmentos
    except ParseError as exc:
        # Error esperado y legible: llega tal cual a la interfaz (E4-8).
        marcar_fallo(conn, job, str(exc), definitivo=not exc.reintentable, codigo=exc.codigo)
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
        _guardar_estructura(conn, job.source_id, parseado)
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

    extra: dict[str, Any] = {}
    if parseado.estructura is not None:
        totales = parseado.estructura.get("totals", {})
        extra = {
            "hojas": parseado.estructura.get("sheetCount"),
            "filas": totales.get("rows"),
            "celdas": totales.get("cells"),
        }
    marcar_exito(conn, job, len(fragmentos), extra)
    return True


# ─────────────────────────── Sincronización de Google Sheets ──────────────────


def _auditar_sync(
    conn: Any, job: Job, accion: str, metadata: dict[str, Any], iniciado_por: str | None
) -> None:
    """Auditoría técnica de una sincronización (origen `system`: el worker lee, no decide)."""
    _auditar(conn, job, accion, {**metadata, "initiatedBy": iniciado_por})


def _ejecucion_de(conn: Any, job: Job) -> tuple[str, str | None]:
    """(id de la ejecución, persona que la pidió) del job de sincronización."""
    with conn.cursor() as cur:
        cur.execute("SELECT id, initiated_by FROM source_sync_runs WHERE job_id = %s", (job.id,))
        fila = cur.fetchone()
    if fila is None:
        raise RuntimeError("El job de sincronización no tiene ejecución asociada.")
    return str(fila[0]), str(fila[1]) if fila[1] is not None else None


def _marcar_ejecucion_en_curso(conn: Any, run_id: str) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """UPDATE source_sync_runs
                  SET status='running', started_at=COALESCE(started_at, now())
                WHERE id=%s""",
            (run_id,),
        )
    conn.commit()


def _fallo_de_sync(
    conn: Any,
    job: Job,
    run_id: str,
    iniciado_por: str | None,
    *,
    codigo: str,
    mensaje: str,
    reintentable: bool,
    espera_s: int | None = None,
) -> None:
    """Reencola con backoff (transitorio) o cierra la ejecución como fallida.

    NUNCA toca el snapshot vigente: una lectura fallida no reemplaza a la última
    válida. Si la fuente jamás tuvo un snapshot, queda `fallido`; si ya tenía uno,
    sigue `procesado` (su contenido vigente sigue siendo válido).
    """
    agotado = (not reintentable) or job.intentos >= job.max_intentos
    with conn.cursor() as cur:
        if agotado:
            cur.execute(
                "UPDATE processing_jobs SET status='fallido', finished_at=now(), error=%s WHERE id=%s",
                (mensaje, job.id),
            )
            cur.execute(
                """UPDATE source_sync_runs
                      SET status='failed', error_code=%s, error_message=%s, finished_at=now()
                    WHERE id=%s""",
                (codigo, mensaje, run_id),
            )
            cur.execute(
                """UPDATE source_documents SET status='fallido'
                    WHERE id=%s AND current_snapshot_id IS NULL""",
                (job.source_id,),
            )
        else:
            espera = max(_backoff(job.intentos), espera_s or 0)
            cur.execute(
                """UPDATE processing_jobs
                      SET status='pendiente', error=%s,
                          disponible_en = now() + make_interval(secs => %s)
                    WHERE id=%s""",
                (mensaje, espera, job.id),
            )
            cur.execute("UPDATE source_sync_runs SET status='queued' WHERE id=%s", (run_id,))
    if agotado:
        _auditar_sync(
            conn,
            job,
            "source.sync_failed",
            {"runId": run_id, "codigo": codigo, "motivo": mensaje, "intentos": job.intentos},
            iniciado_por,
        )
    conn.commit()
    if agotado:
        logger.error("Sincronización de %s falló definitivamente (%s)", job.filename, codigo)
    else:
        logger.warning(
            "Sincronización de %s falló (intento %d/%d, %s); se reintenta",
            job.filename,
            job.intentos,
            job.max_intentos,
            codigo,
        )


def _insertar_snapshot(
    conn: Any,
    job: Job,
    libro: google_sheets.LibroLeido,
    fragmentos: list[Fragment],
    manifiesto: dict[str, Any],
    contenido: str,
    fetched_at: Any,
) -> tuple[str, int, bool]:
    """Guarda el snapshot completo (o detecta que es idéntico al vigente).

    Todo en UNA transacción, con la fila de la fuente bloqueada: concurrencia
    imposible y, si algo falla, no queda ni snapshot ni cambio de vigente.
    Devuelve (snapshot_id, sequence, es_nuevo).
    """
    with conn.cursor() as cur:
        cur.execute(
            "SELECT current_snapshot_id FROM source_documents WHERE id = %s FOR UPDATE",
            (job.source_id,),
        )
        vigente = cur.fetchone()[0]
        if vigente is not None:
            cur.execute(
                "SELECT content_hash, sequence FROM source_snapshots WHERE id = %s", (vigente,)
            )
            hash_vigente, sequence_vigente = cur.fetchone()
            if hash_vigente == contenido:
                return str(vigente), int(sequence_vigente), False

        cur.execute(
            "SELECT COALESCE(max(sequence), 0) + 1 FROM source_snapshots WHERE source_id = %s",
            (job.source_id,),
        )
        sequence = int(cur.fetchone()[0])
        cur.execute(
            """
            INSERT INTO source_snapshots
                   (source_id, organization_id, sequence, provider, fetched_at, content_hash,
                    hash_version, external_revision, metadata, structure, generator)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s)
            RETURNING id
            """,
            (
                job.source_id,
                job.organization_id,
                sequence,
                google_sheets.PROVEEDOR,
                fetched_at,
                contenido,
                google_sheets.VERSION_HASH,
                libro.revision,
                _json({"title": libro.titulo, "tabs": libro.gids}),
                _json(manifiesto),
                google_sheets.GENERADOR,
            ),
        )
        snapshot_id = str(cur.fetchone()[0])

        for hoja in libro.hojas:
            gid = libro.gids.get(hoja.nombre)
            for numero in sorted(hoja.filas):
                celdas = [
                    {"col": col, "text": celda.texto, "type": celda.tipo}
                    for col, celda in sorted(hoja.filas[numero].items())
                ]
                cur.execute(
                    """INSERT INTO source_snapshot_rows (snapshot_id, sheet, sheet_gid, row_number, cells)
                       VALUES (%s, %s, %s, %s, %s::jsonb)""",
                    (snapshot_id, hoja.nombre, gid, numero, _json(celdas)),
                )

        for f in fragmentos:
            cur.execute(
                """
                INSERT INTO source_fragments
                       (source_id, snapshot_id, ordinal, section, locator, text, metadata)
                VALUES (%s, %s, %s, %s, %s::jsonb, %s, %s::jsonb)
                """,
                (
                    job.source_id,
                    snapshot_id,
                    f.ordinal,
                    f.section,
                    _json(f.locator),
                    f.text,
                    _json(f.metadata),
                ),
            )

        # El vigente cambia SOLO ahora, con filas y fragmentos ya guardados.
        cur.execute(
            "UPDATE source_documents SET current_snapshot_id = %s, status = 'procesado' WHERE id = %s",
            (snapshot_id, job.source_id),
        )
    return snapshot_id, sequence, True


def sincronizar_google_sheet(
    conn: Any, job: Job, proveedor: google_sheets.ProveedorGoogleSheets | None = None
) -> bool:
    """Lee el Google Sheet y registra un snapshot nuevo, o un no-op si no cambió.

    La red se usa SOLO a través de `ProveedorGoogleSheets` (hosts y alcance
    fijos); el destino sale de `external_id`, nunca de la URL que pegó el usuario.
    """
    from datetime import datetime, timezone

    try:
        run_id, iniciado_por = _ejecucion_de(conn, job)
    except Exception:  # noqa: BLE001
        conn.rollback()
        logger.exception("Job de sincronización sin ejecución: %s", job.id)
        marcar_fallo(conn, job, "La sincronización no tiene una ejecución asociada.", definitivo=True)
        return False
    _marcar_ejecucion_en_curso(conn, run_id)

    def fallo(codigo: str, mensaje: str, reintentable: bool, espera: int | None = None) -> bool:
        conn.rollback()
        _fallo_de_sync(
            conn, job, run_id, iniciado_por,
            codigo=codigo, mensaje=mensaje, reintentable=reintentable, espera_s=espera,
        )  # fmt: skip
        return False

    try:
        if proveedor is None:
            proveedor = google_sheets.crear_proveedor(conn.info.dbname)
        fetched_at = datetime.now(timezone.utc)  # noqa: UP017 — Python 3.9 en desarrollo
        libro = proveedor.leer_libro(job.external_id, gid=job.gid or None)
        fragmentos, manifiesto = construir_resultado(
            "google_sheets",
            libro.hojas,
            {
                "title": libro.titulo,
                "hiddenSheets": [h.nombre for h in libro.hojas if h.estado != "visible"],
                "nonGridSheets": libro.pestanas_sin_rejilla,
            },
        )
        for entrada in manifiesto["sheets"]:
            entrada["gid"] = libro.gids.get(entrada["name"])
        if not fragmentos:
            return fallo(
                "SPREADSHEET_PARSE_FAILED",
                "El Google Sheet no contiene datos extraíbles (todas las pestañas están vacías).",
                False,
            )
        contenido = google_sheets.hash_de_contenido(libro.hojas, libro.gids)
    except google_sheets.GoogleSheetsError as exc:
        return fallo(exc.codigo, str(exc), exc.reintentable, exc.espera_s)
    except ParseError as exc:
        return fallo(exc.codigo or "SPREADSHEET_PARSE_FAILED", str(exc), exc.reintentable)
    except Exception:  # noqa: BLE001
        logger.exception("Error inesperado leyendo Google Sheets para %s", job.filename)
        return fallo("GOOGLE_UNEXPECTED_ERROR", "Error inesperado al leer el Google Sheet.", False)

    try:
        snapshot_id, sequence, es_nuevo = _insertar_snapshot(
            conn, job, libro, fragmentos, manifiesto, contenido, fetched_at
        )
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE processing_jobs SET status='completado', finished_at=now(), error=NULL WHERE id=%s",
                (job.id,),
            )
            cur.execute(
                """UPDATE source_sync_runs SET status=%s, snapshot_id=%s, finished_at=now() WHERE id=%s""",
                ("completed" if es_nuevo else "unchanged", snapshot_id, run_id),
            )
        _auditar_sync(
            conn,
            job,
            "source.sync_snapshot_created" if es_nuevo else "source.sync_unchanged",
            {
                "runId": run_id,
                "snapshotId": snapshot_id,
                "sequence": sequence,
                "contentHash": contenido,
                "pestanas": manifiesto["sheetCount"],
                "filas": manifiesto["totals"]["rows"],
                "celdas": manifiesto["totals"]["cells"],
                "fragmentos": len(fragmentos),
            },
            iniciado_por,
        )
        conn.commit()
    except Exception:  # noqa: BLE001 — la transacción completa se deshace
        logger.exception("No se pudo guardar el snapshot de %s", job.filename)
        return fallo("SNAPSHOT_SAVE_FAILED", "No se pudo guardar la lectura del Google Sheet.", True)

    if es_nuevo:
        # El índice vectorial va DESPUÉS del commit y no puede fallar el job: el
        # snapshot ya es válido y consultable por texto (igual que con archivos).
        try:
            embeddings.indexar_documento(conn, job.source_id)
        except Exception:  # noqa: BLE001
            conn.rollback()
            logger.exception("Falló la indexación vectorial de %s", job.filename)
    logger.info(
        "Google Sheet %s: %s (snapshot %d)", job.filename, "nuevo" if es_nuevo else "sin cambios", sequence
    )
    return True


def ciclo(conn: Any, intervalo: float = 2.0, max_jobs: int | None = None) -> int:
    """Bucle principal. `max_jobs` acota la ejecución, útil en pruebas."""
    procesados = 0
    while max_jobs is None or procesados < max_jobs:
        job = tomar_job(conn)
        if job is None:
            if max_jobs is not None:
                break
            time.sleep(intervalo)
            continue

        logger.info("Procesando %s [%s] (intento %d)", job.filename, job.kind, job.intentos)
        procesar(conn, job)
        procesados += 1

    return procesados
