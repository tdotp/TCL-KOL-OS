"""Indexación vectorial de fragmentos (Épica E5-2).

Convierte los fragmentos de un documento ya parseado en vectores, para que la
búsqueda de evidencia de §9.3 encuentre el pasaje que respalda un campo del
brief en vez de que alguien lo busque a mano.

Qué **no** se indexa (§12.3)
----------------------------
Un documento clasificado como `sensible` no entra al índice. La razón es que el
índice vectorial es, en la práctica, una copia del contenido repartida en
fragmentos recuperables: todo lo que entra ahí puede salir en una búsqueda, y
para el material sensible —documentos de identidad, datos bancarios, contratos
completos— eso es justamente lo que no se quiere. El documento sigue guardado y
consultable por quien tenga permiso; lo que no hace es aparecer solo.

El corte con la búsqueda
------------------------
Este módulo produce vectores. **No** decide quién puede ver qué: el filtro por
organización y campaña vive en la consulta, del lado que conoce al usuario
(ADR-008, y §10.3 regla 7). Aquí no hay a quién preguntarle por permisos.
"""

from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass
from typing import Any, List, Optional, Sequence

from .ai import openrouter, registro
from .ai.router import RouterError, modelo_de_embeddings

logger = logging.getLogger("ai-worker.embeddings")

#: Fragmentos por llamada. El límite real del proveedor es mayor, pero lotes
#: grandes hacen que un fallo cueste más reintentos y tarden más en verse.
TAMANO_LOTE = 64

#: Versión del procedimiento de indexación. Cambia si cambia el modelo o el
#: recorte, para poder distinguir en `ai_runs` qué corrida produjo qué índice.
VERSION_INDEXADO = "emb-1"


class EmbeddingsDesactivados(RuntimeError):
    """`AI_ENABLED` está en falso: no se llama al proveedor."""


@dataclass(frozen=True)
class Resultado:
    """Qué pasó al indexar un documento."""

    indexados: int
    omitidos: int
    motivo: Optional[str] = None

    @property
    def se_indexo(self) -> bool:
        return self.indexados > 0


def _ia_activa() -> bool:
    return os.environ.get("AI_ENABLED", "false").strip().lower() in {"1", "true", "yes"}


def _a_literal_vector(vector: Sequence[float]) -> str:
    """pgvector recibe el vector como texto: '[0.1,0.2,...]'."""
    return "[" + ",".join(repr(float(x)) for x in vector) + "]"


def embeber_consulta(texto: str) -> List[float]:
    """Vector de una consulta de búsqueda.

    Es el único punto donde la búsqueda toca al proveedor de IA. El resto de la
    búsqueda —el filtro y el orden por distancia— es SQL.
    """
    if not _ia_activa():
        raise EmbeddingsDesactivados(
            "AI_ENABLED está en falso: no se puede convertir la consulta en vector."
        )

    limpio = texto.strip()
    if not limpio:
        raise ValueError("La consulta está vacía.")

    vectores, _uso = openrouter.embeddings(modelo_de_embeddings(), [limpio])
    return vectores[0]


def indexar_documento(conn: Any, source_id: str) -> Resultado:
    """Genera y guarda los embeddings de los fragmentos de un documento.

    Es idempotente por construcción: reprocesar un documento borra sus
    fragmentos antes de insertarlos de nuevo, así que aquí siempre se parte de
    fragmentos sin vector.

    No lanza excepción si la IA está apagada o el documento está excluido: en
    ambos casos el documento queda procesado y buscable por texto, solo que sin
    índice vectorial. Que no haya embeddings no puede invalidar el parseo.
    """
    with conn.cursor() as cur:
        cur.execute(
            """SELECT organization_id, campaign_id, confidentiality_level, filename
                 FROM source_documents WHERE id = %s""",
            (source_id,),
        )
        fila = cur.fetchone()

    if fila is None:
        return Resultado(0, 0, "El documento no existe.")

    organization_id, campaign_id, confidencialidad, filename = (
        str(fila[0]),
        str(fila[1]),
        str(fila[2]),
        str(fila[3]),
    )

    if confidencialidad == "sensible":
        # §12.3. No es un fallo: es la política.
        with conn.cursor() as cur:
            cur.execute(
                "SELECT count(*) FROM source_fragments WHERE source_id = %s", (source_id,)
            )
            total = int(cur.fetchone()[0])
        logger.info(
            "%s está clasificado como sensible: %d fragmentos quedan fuera del índice (§12.3).",
            filename,
            total,
        )
        return Resultado(0, total, "Documento sensible, excluido del índice vectorial (§12.3).")

    if not _ia_activa():
        with conn.cursor() as cur:
            cur.execute(
                "SELECT count(*) FROM source_fragments WHERE source_id = %s", (source_id,)
            )
            total = int(cur.fetchone()[0])
        logger.info("AI_ENABLED está en falso: %s queda sin índice vectorial.", filename)
        return Resultado(0, total, "AI_ENABLED en falso: no se generaron embeddings.")

    try:
        modelo = modelo_de_embeddings()
    except RouterError as exc:
        logger.warning("Sin modelo de embeddings configurado: %s", exc)
        return Resultado(0, 0, str(exc))

    with conn.cursor() as cur:
        cur.execute(
            """SELECT id, text FROM source_fragments
                WHERE source_id = %s AND embedding IS NULL
                ORDER BY ordinal""",
            (source_id,),
        )
        pendientes = [(str(r[0]), str(r[1])) for r in cur.fetchall()]

    if not pendientes:
        return Resultado(0, 0, "No hay fragmentos pendientes de indexar.")

    indexados = 0
    for inicio in range(0, len(pendientes), TAMANO_LOTE):
        lote = pendientes[inicio : inicio + TAMANO_LOTE]
        indexados += _indexar_lote(
            conn,
            lote=lote,
            modelo=modelo,
            organization_id=organization_id,
            campaign_id=campaign_id,
        )

    logger.info("%s indexado: %d fragmentos con vector.", filename, indexados)
    return Resultado(indexados, len(pendientes) - indexados)


def _indexar_lote(
    conn: Any,
    *,
    lote: List[tuple[str, str]],
    modelo: str,
    organization_id: str,
    campaign_id: str,
) -> int:
    """Indexa un lote. Un fallo del proveedor no tumba el documento entero."""
    textos = [texto for _id, texto in lote]
    huella = registro.hash_de_entrada(textos)
    comenzo = time.monotonic()

    try:
        vectores, uso = openrouter.embeddings(modelo, textos)
    except Exception as exc:  # noqa: BLE001
        latencia = int((time.monotonic() - comenzo) * 1000)
        registro.registrar_ejecucion(
            conn,
            organization_id=organization_id,
            campaign_id=campaign_id,
            task="generar_embedding",
            tier="eficiente",
            model=modelo,
            prompt_version=VERSION_INDEXADO,
            input_hash=huella,
            output_status="error",
            latency_ms=latencia,
            error=f"{type(exc).__name__}: {exc}"[:500],
        )
        conn.commit()
        logger.warning("Falló un lote de embeddings (%d fragmentos): %s", len(lote), exc)
        return 0

    latencia = int((time.monotonic() - comenzo) * 1000)

    with conn.cursor() as cur:
        for (fragment_id, _texto), vector in zip(lote, vectores):
            cur.execute(
                "UPDATE source_fragments SET embedding = %s::vector WHERE id = %s",
                (_a_literal_vector(vector), fragment_id),
            )

    registro.registrar_ejecucion(
        conn,
        organization_id=organization_id,
        campaign_id=campaign_id,
        task="generar_embedding",
        tier="eficiente",
        model=modelo,
        prompt_version=VERSION_INDEXADO,
        input_hash=huella,
        output_status="ok",
        latency_ms=latencia,
        prompt_tokens=uso.prompt_tokens,
        completion_tokens=uso.completion_tokens,
        cost_usd=uso.costo_usd,
    )
    conn.commit()
    return len(lote)
