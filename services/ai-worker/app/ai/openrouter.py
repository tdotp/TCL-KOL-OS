"""Adaptador de OpenRouter (Épicas E11-1, E11-2).

Por qué OpenRouter
------------------
Una sola clave da acceso a modelos de varios proveedores con una API compatible
con OpenAI. Eso encaja con el router de §9.2: elegir el nivel de modelo por
tarea sin cambiar de integración.

Además cubre embeddings en el mismo endpoint, así que el RAG de §9.3 no necesita
un segundo proveedor.

Qué NO hace este módulo
-----------------------
No decide nada de negocio. Recibe una tarea ya autorizada, llama al modelo del
nivel correspondiente y devuelve el resultado con su costo. Validar la salida
contra el esquema y decidir si se persiste es responsabilidad de la capa de
dominio (ADR-008).

Privacidad (DEC-008, DEC-019)
-----------------------------
Cada petición declara `data_collection: "deny"`, que impide enrutar a
proveedores que entrenan con los datos enviados. Es una decisión por petición,
no solo una casilla en la cuenta: así queda en el código y no depende de que
nadie la desmarque por error.
"""

from __future__ import annotations

import json
import logging
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

logger = logging.getLogger("ai-worker.openrouter")

BASE_URL = "https://openrouter.ai/api/v1"


class AIError(RuntimeError):
    """Fallo al llamar al modelo.

    El mensaje llega a la interfaz, así que describe qué pasó sin exponer la
    clave, el prompt ni trazas internas (§11.6).
    """


@dataclass(frozen=True)
class Uso:
    """Consumo real de una llamada. OpenRouter lo devuelve por petición."""

    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    #: Costo real en USD según OpenRouter. No una estimación nuestra.
    costo_usd: Optional[float] = None


@dataclass(frozen=True)
class Respuesta:
    contenido: str
    modelo: str
    uso: Uso
    latencia_ms: int
    #: Identificador de OpenRouter, consultable después para auditoría.
    generacion_id: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)


def _clave() -> str:
    import os

    valor = os.environ.get("AI_API_KEY", "").strip()
    if not valor:
        raise AIError(
            "Falta la clave de OpenRouter. Defina AI_API_KEY en el archivo .env "
            "(nunca en el repositorio)."
        )
    return valor


def _cabeceras() -> Dict[str, str]:
    import os

    return {
        "Authorization": f"Bearer {_clave()}",
        "Content-Type": "application/json",
        # OpenRouter usa estas cabeceras para atribuir el tráfico.
        "HTTP-Referer": os.environ.get("AI_APP_URL", "https://smartpr.co"),
        "X-Title": "TCL KOL OS",
    }


def _politica_de_proveedor() -> Dict[str, Any]:
    """Preferencias de enrutamiento aplicadas a cada petición.

    `data_collection: deny` excluye a los proveedores que entrenan con los datos
    enviados. Se declara aquí, en el código, para que no dependa de un ajuste de
    cuenta que alguien pueda cambiar sin darse cuenta.
    """
    return {"data_collection": "deny", "allow_fallbacks": True}


def _post(ruta: str, cuerpo: Dict[str, Any], timeout: int) -> Dict[str, Any]:
    datos = json.dumps(cuerpo).encode("utf-8")
    peticion = urllib.request.Request(
        f"{BASE_URL}{ruta}", data=datos, headers=_cabeceras(), method="POST"
    )

    try:
        with urllib.request.urlopen(peticion, timeout=timeout) as respuesta:
            cuerpo_json: Dict[str, Any] = json.loads(respuesta.read().decode("utf-8"))
            return cuerpo_json

    except urllib.error.HTTPError as exc:
        detalle = ""
        try:
            detalle = json.loads(exc.read().decode("utf-8")).get("error", {}).get("message", "")
        except Exception:
            pass

        if exc.code == 401:
            raise AIError("La clave de OpenRouter no es válida o expiró.") from exc
        if exc.code == 402:
            raise AIError("La cuenta de OpenRouter no tiene saldo suficiente.") from exc
        if exc.code == 429:
            raise AIError("OpenRouter está limitando las peticiones. Se reintentará.") from exc
        if exc.code >= 500:
            raise AIError("OpenRouter no está disponible en este momento.") from exc

        # El detalle del proveedor puede ser útil y no contiene secretos.
        raise AIError(f"OpenRouter rechazó la petición ({exc.code}): {detalle[:200]}") from exc

    except urllib.error.URLError as exc:
        raise AIError("No hay conexión con OpenRouter.") from exc

    except TimeoutError as exc:
        raise AIError(f"OpenRouter no respondió en {timeout} s.") from exc


def _uso_de(payload: Dict[str, Any]) -> Uso:
    bruto = payload.get("usage") or {}
    return Uso(
        prompt_tokens=int(bruto.get("prompt_tokens", 0)),
        completion_tokens=int(bruto.get("completion_tokens", 0)),
        total_tokens=int(bruto.get("total_tokens", 0)),
        # OpenRouter devuelve el costo real; solo se estima si no viniera.
        costo_usd=bruto.get("cost"),
    )


def completar(
    modelo: str,
    mensajes: List[Dict[str, str]],
    *,
    temperatura: float = 0.0,
    max_tokens: Optional[int] = None,
    formato_json: bool = False,
    timeout: int = 120,
) -> Respuesta:
    """Llamada de chat.

    `temperatura=0` por defecto: en extracción se busca reproducibilidad, no
    variedad. Una extracción que cambia entre ejecuciones no se puede evaluar
    contra un gold set (métrica IA-05).
    """
    cuerpo: Dict[str, Any] = {
        "model": modelo,
        "messages": mensajes,
        "temperature": temperatura,
        "provider": _politica_de_proveedor(),
        # Pide a OpenRouter que incluya el costo real en la respuesta.
        "usage": {"include": True},
    }
    if max_tokens is not None:
        cuerpo["max_tokens"] = max_tokens
    if formato_json:
        cuerpo["response_format"] = {"type": "json_object"}

    inicio = time.monotonic()
    payload = _post("/chat/completions", cuerpo, timeout)
    latencia = int((time.monotonic() - inicio) * 1000)

    opciones = payload.get("choices") or []
    if not opciones:
        raise AIError("OpenRouter devolvió una respuesta sin contenido.")

    contenido = (opciones[0].get("message") or {}).get("content") or ""
    if not contenido.strip():
        raise AIError("El modelo devolvió una respuesta vacía.")

    return Respuesta(
        contenido=contenido,
        modelo=payload.get("model", modelo),
        uso=_uso_de(payload),
        latencia_ms=latencia,
        generacion_id=payload.get("id"),
        metadata={"finish_reason": opciones[0].get("finish_reason")},
    )


def embeddings(modelo: str, textos: List[str], *, timeout: int = 120) -> tuple[List[List[float]], Uso]:
    """Genera embeddings para varios textos en una sola llamada.

    El lote importa: procesar un PPT de 42 fragmentos con 42 peticiones sería
    absurdamente lento y caro comparado con una sola.
    """
    if not textos:
        return [], Uso()

    payload = _post(
        "/embeddings",
        {"model": modelo, "input": textos, "provider": _politica_de_proveedor()},
        timeout,
    )

    datos = payload.get("data") or []
    if len(datos) != len(textos):
        raise AIError(
            f"Se pidieron {len(textos)} embeddings y llegaron {len(datos)}. "
            "No se puede asociar cada vector con su fragmento."
        )

    # El orden no está garantizado: se reordena por `index`.
    ordenados = sorted(datos, key=lambda d: d.get("index", 0))
    return [d["embedding"] for d in ordenados], _uso_de(payload)


def disponible() -> bool:
    """¿Hay clave configurada? No comprueba que sea válida."""
    import os

    return bool(os.environ.get("AI_API_KEY", "").strip())
