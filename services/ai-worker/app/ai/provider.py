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

from . import fake_provider, openrouter
from .openrouter import Respuesta, Uso  # re-exportados por conveniencia


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
