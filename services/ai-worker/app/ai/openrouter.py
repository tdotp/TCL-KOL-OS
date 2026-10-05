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

import contextlib
import json
import logging
import re
import socket
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger("ai-worker.openrouter")

BASE_URL = "https://openrouter.ai/api/v1"


#: Categorías estables de fallo del proveedor. Las usa `/modelo/turno` para
#: traducirlas a su taxonomía tipificada; la extracción las ignora.
CAT_NO_CONFIGURADO = "no_configurado"
CAT_AUTENTICACION = "autenticacion"
CAT_TIMEOUT = "timeout"
CAT_LIMITE = "limite_de_tasa"
CAT_CONTEXTO = "contexto_excedido"
CAT_RESPUESTA = "respuesta_invalida"
CAT_UPSTREAM = "upstream"

#: Fragmentos del detalle de un 400 que indican contexto excedido.
_PATRON_CONTEXTO = re.compile(
    r"context[ _-]?(length|window)|maximum context|too many tokens|prompt is too long|"
    r"exceeds? the (maximum|max)|input is too long|reduce the length",
    re.IGNORECASE,
)


class AIError(RuntimeError):
    """Fallo al llamar al modelo.

    El mensaje llega a la interfaz, así que describe qué pasó sin exponer la
    clave, el prompt ni trazas internas (§11.6).

    Los atributos son aditivos y opcionales: `AIError("texto")` sigue siendo
    válido. Permiten clasificar el fallo sin parsear el mensaje.
    """

    def __init__(
        self,
        mensaje: str,
        *,
        categoria: str = CAT_UPSTREAM,
        status: int | None = None,
        retryable: bool = False,
        retry_after_s: int | None = None,
    ) -> None:
        super().__init__(mensaje)
        self.categoria = categoria
        self.status = status
        self.retryable = retryable
        self.retry_after_s = retry_after_s


@dataclass(frozen=True)
class Uso:
    """Consumo real de una llamada. OpenRouter lo devuelve por petición."""

    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    #: Costo real en USD según OpenRouter. No una estimación nuestra.
    costo_usd: float | None = None


@dataclass(frozen=True)
class Respuesta:
    contenido: str
    modelo: str
    uso: Uso
    latencia_ms: int
    #: Identificador de OpenRouter, consultable después para auditoría.
    generacion_id: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class LlamadaHerramienta:
    """Una tool call tal como la devolvió el proveedor, SIN validar.

    `argumentos` es el texto JSON crudo: que sea JSON válido y un objeto lo
    comprueba `app/modelo_turno.py`, no el adaptador.
    """

    id: str
    nombre: str
    argumentos: str


@dataclass(frozen=True)
class RespuestaHerramientas:
    """Salida de una llamada con tool calling. Sin campos de razonamiento."""

    contenido: str | None
    llamadas: list[LlamadaHerramienta]
    finish_reason: str | None
    modelo: str
    uso: Uso
    latencia_ms: int
    generacion_id: str | None = None


def _clave() -> str:
    import os

    valor = os.environ.get("AI_API_KEY", "").strip()
    if not valor:
        raise AIError(
            "Falta la clave de OpenRouter. Defina AI_API_KEY en el archivo .env "
            "(nunca en el repositorio).",
            categoria=CAT_NO_CONFIGURADO,
        )
    return valor


def _cabeceras() -> dict[str, str]:
    import os

    return {
        "Authorization": f"Bearer {_clave()}",
        "Content-Type": "application/json",
        # OpenRouter usa estas cabeceras para atribuir el tráfico.
        "HTTP-Referer": os.environ.get("AI_APP_URL", "https://smartpr.co"),
        "X-Title": "TCL KOL OS",
    }


def _politica_de_proveedor() -> dict[str, Any]:
    """Preferencias de enrutamiento aplicadas a cada petición.

    `data_collection: deny` excluye a los proveedores que entrenan con los datos
    enviados. Se declara aquí, en el código, para que no dependa de un ajuste de
    cuenta que alguien pueda cambiar sin darse cuenta.
    """
    return {"data_collection": "deny", "allow_fallbacks": True}


def _post(ruta: str, cuerpo: dict[str, Any], timeout: int) -> dict[str, Any]:
    datos = json.dumps(cuerpo).encode("utf-8")
    # `ruta` es siempre un literal interno (nunca entrada de usuario) sobre
    # BASE_URL, un https:// fijo — no hay esquema arbitrario que auditar.
    # Se usa urllib de la librería estándar a propósito, para no sumar una
    # dependencia (`requests`) solo por esta llamada.
    peticion = urllib.request.Request(  # noqa: S310
        f"{BASE_URL}{ruta}", data=datos, headers=_cabeceras(), method="POST"
    )

    try:
        with urllib.request.urlopen(peticion, timeout=timeout) as respuesta:  # noqa: S310
            cuerpo_json: dict[str, Any] = json.loads(respuesta.read().decode("utf-8"))
            return cuerpo_json

    except urllib.error.HTTPError as exc:
        detalle = ""
        # El detalle es una mejora del mensaje de error, no algo de lo que
        # dependa la lógica: si el cuerpo del error no es el JSON esperado,
        # se sigue con el mensaje genérico de abajo en vez de fallar aquí.
        with contextlib.suppress(Exception):
            detalle = json.loads(exc.read().decode("utf-8")).get("error", {}).get("message", "")

        if exc.code == 401:
            raise AIError(
                "La clave de OpenRouter no es válida o expiró.",
                categoria=CAT_AUTENTICACION,
                status=401,
            ) from exc
        if exc.code == 402:
            raise AIError(
                "La cuenta de OpenRouter no tiene saldo suficiente.", status=402
            ) from exc
        if exc.code == 429:
            raise AIError(
                "OpenRouter está limitando las peticiones. Se reintentará.",
                categoria=CAT_LIMITE,
                status=429,
                retryable=True,
                retry_after_s=_retry_after(exc),
            ) from exc
        if exc.code >= 500:
            raise AIError(
                "OpenRouter no está disponible en este momento.",
                status=exc.code,
                retryable=True,
            ) from exc

        if exc.code == 413 or (exc.code == 400 and _PATRON_CONTEXTO.search(detalle)):
            raise AIError(
                "La entrada supera el contexto máximo del modelo.",
                categoria=CAT_CONTEXTO,
                status=exc.code,
            ) from exc

        # El detalle del proveedor puede ser útil y no contiene secretos.
        raise AIError(
            f"OpenRouter rechazó la petición ({exc.code}): {detalle[:200]}", status=exc.code
        ) from exc

    except urllib.error.URLError as exc:
        # Un timeout de conexión llega envuelto en URLError.
        if isinstance(exc.reason, (TimeoutError, socket.timeout)):  # noqa: UP038, UP041
            raise AIError(
                f"OpenRouter no respondió en {timeout} s.", categoria=CAT_TIMEOUT, retryable=True
            ) from exc
        raise AIError("No hay conexión con OpenRouter.", retryable=True) from exc

    # En Python < 3.10 `socket.timeout` no es `TimeoutError`; el contenedor usa
    # 3.11, pero las pruebas locales corren en 3.9.
    except (TimeoutError, socket.timeout) as exc:  # noqa: UP041
        raise AIError(
            f"OpenRouter no respondió en {timeout} s.", categoria=CAT_TIMEOUT, retryable=True
        ) from exc


def _retry_after(exc: urllib.error.HTTPError) -> int | None:
    """Segundos de `Retry-After` si vienen como entero; acotado a 0–300."""
    crudo = exc.headers.get("Retry-After") if exc.headers is not None else None
    if crudo is None:
        return None
    try:
        return max(0, min(300, int(str(crudo).strip())))
    except ValueError:
        return None


def _uso_de(payload: dict[str, Any]) -> Uso:
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
    mensajes: list[dict[str, str]],
    *,
    temperatura: float = 0.0,
    max_tokens: int | None = None,
    formato_json: bool = False,
    timeout: int = 120,
) -> Respuesta:
    """Llamada de chat.

    `temperatura=0` por defecto: en extracción se busca reproducibilidad, no
    variedad. Una extracción que cambia entre ejecuciones no se puede evaluar
    contra un gold set (métrica IA-05).
    """
    cuerpo: dict[str, Any] = {
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
    """UNA llamada de chat con tool calling (`/modelo/turno`, Fase 6).

    Aditiva: `completar` de la extracción no cambia. No ejecuta ninguna tool ni
    reintenta: devuelve lo que el modelo pidió y quien orquesta decide.

    `message.reasoning` / `reasoning_details` nunca se leen: el razonamiento del
    proveedor no se propaga, no se devuelve y no se registra.

    `require_parameters: true` pide a OpenRouter enrutar solo a proveedores que
    soportan `tools`; se combina con `data_collection: deny` (DEC-019).
    """
    cuerpo: dict[str, Any] = {
        "model": modelo,
        "messages": mensajes,
        "temperature": temperatura,
        "provider": {**_politica_de_proveedor(), "require_parameters": True},
        "usage": {"include": True},
    }
    if herramientas:
        cuerpo["tools"] = herramientas
        cuerpo["tool_choice"] = tool_choice
        cuerpo["parallel_tool_calls"] = False
    if max_tokens is not None:
        cuerpo["max_tokens"] = max_tokens

    inicio = time.monotonic()
    try:
        payload = _post("/chat/completions", cuerpo, timeout)
    except ValueError as exc:  # JSONDecodeError: cuerpo 200 que no es JSON
        raise AIError(
            "OpenRouter devolvió un cuerpo que no es JSON.", categoria=CAT_RESPUESTA, retryable=True
        ) from exc
    latencia = int((time.monotonic() - inicio) * 1000)

    try:
        opciones = payload.get("choices") or []
        if not opciones:
            raise AIError(
                "OpenRouter devolvió una respuesta sin contenido.",
                categoria=CAT_RESPUESTA,
                retryable=True,
            )
        opcion = opciones[0]
        mensaje = opcion.get("message") or {}
        crudas = mensaje.get("tool_calls") or []
        llamadas = [_llamada_de(c) for c in crudas]
        contenido = mensaje.get("content")
        return RespuestaHerramientas(
            contenido=contenido if isinstance(contenido, str) else None,
            llamadas=llamadas,
            finish_reason=opcion.get("finish_reason"),
            modelo=str(payload.get("model", modelo)),
            uso=_uso_de(payload),
            latencia_ms=latencia,
            generacion_id=payload.get("id"),
        )
    except (AttributeError, TypeError, ValueError) as exc:
        raise AIError(
            "OpenRouter devolvió una respuesta con estructura inesperada.",
            categoria=CAT_RESPUESTA,
            retryable=True,
        ) from exc


def _llamada_de(cruda: Any) -> LlamadaHerramienta:
    """Normaliza una tool call del formato OpenAI sin validar su contenido."""
    funcion = cruda.get("function") or {}
    argumentos = funcion.get("arguments")
    if isinstance(argumentos, (dict, list)):  # noqa: UP038 — algunos proveedores devuelven objeto
        argumentos = json.dumps(argumentos)
    return LlamadaHerramienta(
        id=str(cruda.get("id") or ""),
        nombre=str(funcion.get("name") or ""),
        argumentos="" if argumentos is None else str(argumentos),
    )


def embeddings(modelo: str, textos: list[str], *, timeout: int = 120) -> tuple[list[list[float]], Uso]:
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
