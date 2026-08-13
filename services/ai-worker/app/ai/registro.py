"""Registro de ejecuciones de modelo (Épica E11-7).

Cada llamada al proveedor deja una fila en `ai_runs` con lo que hace falta para
responder tres preguntas: **cuánto costó**, **qué modelo respondió** y **si el
resultado sirvió**. Con eso se puede auditar el gasto y detectar una regresión
de calidad sin volver a correr nada.

Lo que aquí **no** se guarda, por §11.6
---------------------------------------
Ni el prompt, ni la respuesta, ni el texto de entrada. Un registro de auditoría
que copia el contenido termina siendo una segunda base de datos con el mismo
material sensible y ninguno de sus controles. Del insumo se guarda solo un
hash: sirve para saber si dos ejecuciones vieron lo mismo, y no reconstruye
nada.
"""

from __future__ import annotations

import hashlib
import logging
from typing import Any, Iterable, Optional

logger = logging.getLogger("ai-worker.registro")


def hash_de_entrada(partes: Iterable[str]) -> str:
    """Huella estable del insumo de una ejecución.

    Sirve para comparar ejecuciones entre sí —¿el modelo vio exactamente lo
    mismo que la vez pasada?— sin conservar el contenido.
    """
    h = hashlib.sha256()
    for parte in partes:
        h.update(parte.encode("utf-8"))
        h.update(b"\x00")  # separador: evita que ['ab','c'] y ['a','bc'] colisionen
    return h.hexdigest()


def registrar_ejecucion(
    conn: Any,
    *,
    organization_id: str,
    task: str,
    tier: str,
    model: str,
    prompt_version: str,
    input_hash: str,
    output_status: str,
    campaign_id: Optional[str] = None,
    brief_version_id: Optional[str] = None,
    provider: str = "openrouter",
    latency_ms: Optional[int] = None,
    prompt_tokens: Optional[int] = None,
    completion_tokens: Optional[int] = None,
    cost_usd: Optional[float] = None,
    generation_id: Optional[str] = None,
    error: Optional[str] = None,
) -> str:
    """Inserta una fila en `ai_runs` y devuelve su id.

    No confirma la transacción: quien llama decide con qué se agrupa. Así el
    registro de una extracción y los campos que produjo se guardan juntos o no
    se guarda ninguno.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO ai_runs
                   (organization_id, campaign_id, brief_version_id, task, tier,
                    provider, model, prompt_version, input_hash, output_status,
                    latency_ms, prompt_tokens, completion_tokens, cost_usd,
                    generation_id, error)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id
            """,
            (
                organization_id,
                campaign_id,
                brief_version_id,
                task,
                tier,
                provider,
                model,
                prompt_version,
                input_hash,
                output_status,
                latency_ms,
                prompt_tokens,
                completion_tokens,
                cost_usd,
                generation_id,
                error,
            ),
        )
        return str(cur.fetchone()[0])
