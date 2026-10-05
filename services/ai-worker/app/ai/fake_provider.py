"""Proveedor de IA determinístico, solo para pruebas automatizadas.

Por qué existe (Sprint 4, cierre — corrección 6)
-------------------------------------------------
La prueba de integración completa (`packages/db/src/end-to-end.test.ts`) tiene
que recorrer el contrato HTTP real de `/extraccion` y la persistencia real de
`packages/db` — no un mock a nivel de repositorio — para demostrar algo. Pero
tampoco puede depender de OpenRouter: sin clave, sin saldo, sin red, sin que
el resultado cambie entre corridas. Este módulo resuelve esa tensión: se
activa con `AI_PROVIDER=fake` (nunca en producción ni en las demos, que usan
OpenRouter real) y produce una respuesta válida, estable y **verificable** —
nunca inventa una cita: la toma literalmente del primer fragmento que reciba,
igual que exige `extraction.py` de cualquier proveedor real.

Deliberadamente mínimo: no intenta simular una extracción completa de los 41
campos. Solo entrega uno, para probar que el contrato worker↔repositorio
funciona de punta a punta con una salida conocida. El resto de los campos
críticos se completa en la prueba con `corregirCampo`/`responderPregunta`,
exactamente como lo haría un consultor revisando la extracción real.
"""

from __future__ import annotations

import json
import re
from typing import Any

from .openrouter import LlamadaHerramienta, Respuesta, RespuestaHerramientas, Uso


def _primer_fragmento(prompt: str) -> tuple[str, str] | None:
    """`(fragment_id, texto)` del primer fragmento del bloque FRAGMENTOS del prompt."""
    marca = "FRAGMENTOS:"
    inicio = prompt.find(marca)
    if inicio < 0:
        return None

    resto = prompt[inicio + len(marca):].lstrip("\n")
    bloques = resto.split("\n\n")
    if not bloques or not bloques[0].strip():
        return None

    lineas = bloques[0].split("\n", 1)
    if len(lineas) < 2:
        return None

    encabezado, texto = lineas
    m = re.match(r"^\[([^\]]+)\]", encabezado)
    if not m:
        return None

    return m.group(1), texto.strip()


def completar(
    modelo: str,
    mensajes: list[dict[str, str]],
    *,
    temperatura: float = 0.0,
    max_tokens: int | None = None,
    formato_json: bool = False,
    timeout: int = 120,
) -> Respuesta:
    prompt = mensajes[-1]["content"] if mensajes else ""
    campos: list[dict[str, Any]] = []

    hallazgo = _primer_fragmento(prompt)
    if hallazgo is not None:
        fragment_id, texto = hallazgo
        cita = texto[:80].strip()
        if cita:
            campos.append(
                {
                    "key": "contexto.categoria",
                    "value": cita,
                    "status": "found",
                    "confidence": 0.99,
                    "evidence": [
                        {"fragment_id": fragment_id, "quote": cita, "relation": "soporta"}
                    ],
                }
            )

    return Respuesta(
        contenido=json.dumps({"campos": campos}, ensure_ascii=False),
        modelo="fake/determinista-1",
        uso=Uso(prompt_tokens=0, completion_tokens=0, total_tokens=0, costo_usd=0.0),
        latencia_ms=1,
        generacion_id="fake-generacion",
        metadata={"finish_reason": "stop", "fake": True},
    )


#: Marcador para pedir una tool call al proveedor falso:
#: `[[fake:tool nombre {"arg": 1}]]` en el último mensaje de usuario.
_MARCA_TOOL = re.compile(r"\[\[fake:tool ([A-Za-z0-9_]+)(?: (\{.*?\}))?\]\]", re.DOTALL)


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
    """Determinístico para CI: sin red ni clave.

    Último mensaje `user` con `[[fake:tool nombre {json}]]` -> una tool call
    (solo si `nombre` está declarada y `tool_choice != "none"`). Si el último
    mensaje es un resultado de tool, o no hay marcador, responde texto fijo.
    No refleja el contenido recibido.
    """
    ultimo = mensajes[-1] if mensajes else {}
    llamadas: list[LlamadaHerramienta] = []
    if ultimo.get("role") == "user" and tool_choice != "none":
        declaradas = {h["function"]["name"] for h in herramientas}
        m = _MARCA_TOOL.search(str(ultimo.get("content") or ""))
        if m is not None and m.group(1) in declaradas:
            llamadas.append(
                LlamadaHerramienta(id="fake-call-1", nombre=m.group(1), argumentos=m.group(2) or "{}")
            )
    return RespuestaHerramientas(
        contenido=None if llamadas else "Respuesta determinista del proveedor falso.",
        llamadas=llamadas,
        finish_reason="tool_calls" if llamadas else "stop",
        modelo="fake/determinista-1",
        uso=Uso(prompt_tokens=0, completion_tokens=0, total_tokens=0, costo_usd=0.0),
        latencia_ms=1,
        generacion_id="fake-generacion",
    )


def embeddings(
    modelo: str, textos: list[str], *, timeout: int = 120
) -> tuple[list[list[float]], Uso]:
    vector = [0.0] * 1536
    return [list(vector) for _ in textos], Uso(
        prompt_tokens=0, completion_tokens=0, total_tokens=0, costo_usd=0.0
    )


def disponible() -> bool:
    return True
