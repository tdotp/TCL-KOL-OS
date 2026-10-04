"""Configuración del worker, validada al arranque.

El worker falla ruidosamente si le falta una variable requerida, en lugar de
arrancar y romperse en la primera tarea. Ninguna variable trae valor por defecto
que apunte a un servicio real (§27: ninguna credencial en el repositorio).
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Final

#: Formatos aceptados en MVP 1 (DEC-010).
SUPPORTED_MIME_TYPES: Final[frozenset[str]] = frozenset(
    {
        "application/pdf",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",  # PPTX
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",  # DOCX
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",  # XLSX (V2 · Fase 4)
        "text/csv",  # CSV (V2 · Fase 4)
        "image/png",
        "image/jpeg",
    }
)


class ConfigError(RuntimeError):
    """Falta configuración obligatoria o tiene un valor inválido."""


def _required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ConfigError(
            f"Falta la variable de entorno obligatoria {name}. "
            f"Consulte .env.example en la raíz del repositorio."
        )
    return value


def _int_env(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} debe ser un entero; se recibió {raw!r}.") from exc


# Sin `slots=True`: el Docker del proyecto usa Python 3.11, pero mantener el
# módulo ejecutable en 3.9 permite correr las pruebas sin contenedor.
@dataclass(frozen=True)
class Settings:
    """Configuración efectiva del worker."""

    database_url: str
    redis_url: str
    environment: str
    #: Interruptor de IA (Épica E11-9). Apagado, el worker solo parsea y extrae texto.
    ai_enabled: bool
    ai_provider: str | None
    max_upload_mb: int
    log_level: str
    supported_mime_types: frozenset[str] = field(default=SUPPORTED_MIME_TYPES)

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024

    def redacted(self) -> dict[str, object]:
        """Representación segura para logs: sin credenciales (§12.1, control 5)."""

        def _host_only(url: str) -> str:
            if "@" in url:
                return url.rsplit("@", 1)[-1]
            return url

        return {
            "environment": self.environment,
            "database": _host_only(self.database_url),
            "redis": _host_only(self.redis_url),
            "ai_enabled": self.ai_enabled,
            "ai_provider": self.ai_provider or "(ninguno)",
            "max_upload_mb": self.max_upload_mb,
            "log_level": self.log_level,
        }


def load_settings() -> Settings:
    """Carga y valida la configuración. Lanza ConfigError si algo falta."""
    ai_enabled = os.environ.get("AI_ENABLED", "false").strip().lower() in {"1", "true", "yes"}
    ai_provider = os.environ.get("AI_PROVIDER", "").strip() or None

    if ai_enabled and ai_provider is None:
        raise ConfigError("AI_ENABLED está activo pero no se definió AI_PROVIDER.")

    max_upload_mb = _int_env("MAX_UPLOAD_MB", 50)
    if max_upload_mb <= 0:
        raise ConfigError(f"MAX_UPLOAD_MB debe ser mayor que cero; se recibió {max_upload_mb}.")

    return Settings(
        database_url=_required("DATABASE_URL"),
        redis_url=_required("REDIS_URL"),
        environment=os.environ.get("ENVIRONMENT", "development").strip(),
        ai_enabled=ai_enabled,
        ai_provider=ai_provider,
        max_upload_mb=max_upload_mb,
        log_level=os.environ.get("LOG_LEVEL", "INFO").strip().upper(),
    )
