"""Worker documental e IA de TCL KOL OS.

Responsabilidad: parsing, OCR, extracción, RAG, traducción y exportación.

Lo que este servicio NO hace (ADR-008 y D0-09 §3.1):
  - no decide estados ni permisos;
  - no aprueba nada;
  - recibe trabajo ya autorizado y devuelve un resultado que la capa de dominio
    valida antes de persistir.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from . import embeddings, extraction, parsers
from .ai.router import RouterError
from .config import ConfigError, Settings, load_settings


class ConsultaEntrada(BaseModel):
    """Texto a vectorizar. Nada más: sin scope, sin identidad, sin permisos."""

    texto: str = Field(min_length=1, max_length=8000)


class FragmentoEntrada(BaseModel):
    """Un fragmento ya autorizado por la capa que sabe quién pregunta."""

    id: str
    source_id: str
    filename: str
    texto: str
    page: int | None = None
    slide: int | None = None
    section: str | None = None
    linea: int | None = None


class ExtraccionEntrada(BaseModel):
    fragmentos: list[FragmentoEntrada] = Field(min_length=1, max_length=200)

logger = logging.getLogger("ai-worker")

_settings: Settings | None = None


def get_settings() -> Settings:
    if _settings is None:
        raise RuntimeError("La configuración no se cargó; ¿se omitió el arranque?")
    return _settings


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    """Valida la configuración antes de aceptar tráfico."""
    global _settings
    try:
        _settings = load_settings()
    except ConfigError as exc:
        logger.error("Configuración inválida: %s", exc)
        raise

    logging.basicConfig(level=_settings.log_level)
    logger.info("Worker iniciado: %s", _settings.redacted())

    if not _settings.ai_enabled:
        logger.warning(
            "AI_ENABLED=false — el worker opera en modo manual. "
            "El brief se puede completar sin asistencia de IA (principio 9, §5)."
        )

    yield

    logger.info("Worker detenido.")


app = FastAPI(
    title="TCL KOL OS — AI Worker",
    version="0.1.0",
    description="Procesamiento documental y tareas de IA.",
    lifespan=lifespan,
)


@app.get("/health")
async def health() -> dict[str, str]:
    """Vivo. No comprueba dependencias (Épica E12-4)."""
    return {"status": "ok"}


@app.post("/embeddings/consulta")
async def embeber_consulta(peticion: ConsultaEntrada) -> dict[str, object]:
    """Convierte el texto de una búsqueda en vector (E5-2).

    Existe porque el proveedor de IA lo llama **solo el worker** (D0-09 §3), y
    la web necesita el vector para buscar. Deliberadamente no busca ni recibe
    organización ni campaña: el filtro por permiso se aplica en la consulta, del
    lado que sabe quién es el usuario (ADR-008). Así este endpoint no tiene nada
    que filtrar mal.
    """
    try:
        vector = embeddings.embeber_consulta(peticion.texto)
    except embeddings.EmbeddingsDesactivados as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RouterError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    return {"vector": vector, "dimensiones": len(vector)}


@app.post("/extraccion")
async def extraccion(peticion: ExtraccionEntrada) -> dict[str, object]:
    """Extrae campos del brief a partir de fragmentos ya autorizados (E5-3).

    Recibe los fragmentos en la petición en vez de leerlos de la base a partir
    de un `campaign_id`. La diferencia importa: así el worker nunca tiene que
    decidir si quien pregunta puede ver esa campaña —no tiene con qué—, y el
    filtro por permiso se queda entero del lado que conoce al usuario (ADR-008).

    Devuelve los campos verificados. **No persiste nada**: el dominio los valida
    antes de que se conviertan en una versión del brief.
    """
    fragmentos = [
        extraction.FragmentoDeEntrada(
            id=f.id,
            source_id=f.source_id,
            filename=f.filename,
            texto=f.texto,
            page=f.page,
            slide=f.slide,
            section=f.section,
            linea=f.linea,
        )
        for f in peticion.fragmentos
    ]

    try:
        resultado = extraction.extraer(fragmentos)
    except extraction.ExtraccionInvalida as exc:
        # E5-3: una salida que no cumple el contrato no se persiste como versión
        # aprobable. Se dice qué pasó, en vez de devolver campos a medias.
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RouterError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    return {
        "modelo": resultado.modelo,
        "nivel": resultado.nivel,
        "prompt_version": extraction.VERSION_PROMPT,
        "input_hash": resultado.input_hash,
        "costo_usd": resultado.costo_usd,
        "latencia_ms": resultado.latencia_ms,
        "prompt_tokens": resultado.prompt_tokens,
        "completion_tokens": resultado.completion_tokens,
        "generation_id": resultado.generation_id,
        "descartes": resultado.descartes,
        "campos": [
            {
                "key": c.key,
                "value": c.value,
                "status": c.status,
                "criticidad": c.criticidad,
                "confidence": c.confidence,
                "nota": c.nota,
                "evidence": [
                    {
                        "fragmentId": e.fragment_id,
                        "sourceId": e.source_id,
                        "quote": e.quote,
                        "relation": e.relation,
                    }
                    for e in c.evidence
                ],
            }
            for c in resultado.campos
        ],
    }


@app.get("/ready")
async def ready() -> dict[str, object]:
    """Listo para recibir trabajo, con estado de cada dependencia."""
    settings = get_settings()
    return {
        "status": "ready",
        "environment": settings.environment,
        "ai_enabled": settings.ai_enabled,
        "supported_formats": sorted(parsers.tipos_soportados()),
        "max_upload_mb": settings.max_upload_mb,
    }
