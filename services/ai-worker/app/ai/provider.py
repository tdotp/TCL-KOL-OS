"""Selección de proveedor de IA (Sprint 4, cierre — corrección 6).

Un único punto de entrada para `completar`/`embeddings`, que decide entre el
proveedor real (OpenRouter) y el determinístico de pruebas
(`fake_provider`) según `AI_PROVIDER`. El resto del worker —`extraction.py`,
`embeddings.py`— importa de aquí, nunca de `openrouter` directamente, así que
ningún módulo de negocio necesita saber que el proveedor falso existe.

`AI_PROVIDER=fake` es exclusivamente para pruebas automatizadas y CI. Nunca
para producción ni para las demos, que usan OpenRouter real configurado
localmente.
"""

from __future__ import annotations

import os
from typing import Any

from . import fake_provider, openrouter
from .openrouter import (  # re-exportados por conveniencia
    LlamadaHerramienta,
    Respuesta,
    RespuestaHerramientas,
    Uso,
)

__all__ = [
    "LlamadaHerramienta",
    "Respuesta",
    "RespuestaHerramientas",
    "Uso",
    "completar",
    "completar_con_herramientas",
    "disponible",
    "embeddings",
    "nombre_proveedor",
]


def _usando_proveedor_falso() -> bool:
    return os.environ.get("AI_PROVIDER", "").strip().lower() == "fake"


def completar(
    modelo: str,
    mensajes: list[dict[str, str]],
    *,
    temperatura: float = 0.0,
    max_tokens: int | None = None,
    formato_json: bool = False,
    timeout: int = 120,
) -> Respuesta:
    if _usando_proveedor_falso():
        return fake_provider.completar(
            modelo,
            mensajes,
            temperatura=temperatura,
            max_tokens=max_tokens,
            formato_json=formato_json,
            timeout=timeout,
        )
    return openrouter.completar(
        modelo,
        mensajes,
        temperatura=temperatura,
        max_tokens=max_tokens,
        formato_json=formato_json,
        timeout=timeout,
    )


def nombre_proveedor() -> str:
    """Etiqueta honesta del adaptador activo (`fake` solo en pruebas/CI)."""
    return "fake" if _usando_proveedor_falso() else "openrouter"


def completar_con_herramientas(
    modelo: str,
    mensajes: list[dict[str, Any]],
    herramientas: list[dict[str, Any]],
    *,
    tool_choice: str = "auto",
    temperatura: float = 0.2,
    max_tokens: int | None = None,
    timeout: int = 45,
) -> RespuestaHerramientas:
    """Una llamada con tool calling. Es el transporte por defecto de `/modelo/turno`."""
    if _usando_proveedor_falso():
        return fake_provider.completar_con_herramientas(
            modelo,
            mensajes,
            herramientas,
            tool_choice=tool_choice,
            temperatura=temperatura,
            max_tokens=max_tokens,
            timeout=timeout,
        )
    return openrouter.completar_con_herramientas(
        modelo,
        mensajes,
        herramientas,
        tool_choice=tool_choice,
        temperatura=temperatura,
        max_tokens=max_tokens,
        timeout=timeout,
    )


def embeddings(
    modelo: str, textos: list[str], *, timeout: int = 120
) -> tuple[list[list[float]], Uso]:
    if _usando_proveedor_falso():
        return fake_provider.embeddings(modelo, textos, timeout=timeout)
    return openrouter.embeddings(modelo, textos, timeout=timeout)


def disponible() -> bool:
    if _usando_proveedor_falso():
        return fake_provider.disponible()
    return openrouter.disponible()
