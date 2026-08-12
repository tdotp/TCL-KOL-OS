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

from fastapi import FastAPI

from .config import ConfigError, Settings, load_settings

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


@app.get("/ready")
async def ready() -> dict[str, object]:
    """Listo para recibir trabajo, con estado de cada dependencia."""
    settings = get_settings()
    return {
        "status": "ready",
        "environment": settings.environment,
        "ai_enabled": settings.ai_enabled,
        "supported_formats": sorted(settings.supported_mime_types),
        "max_upload_mb": settings.max_upload_mb,
    }
