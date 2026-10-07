# ruff: noqa: UP006, UP007, UP035 — Pydantic evalúa las anotaciones en 3.9: `Optional`/`List`/`Dict`.
"""`POST /modelo/turno` — UNA llamada de modelo con tool calling (V2 · Fase 6).

Qué es
------
Un adaptador fino y SIN ESTADO entre el runtime del agente (Node) y el
proveedor de IA. Node ensambla los mensajes, declara las tools, ejecuta las
tools que el modelo pida y vuelve a llamar. Este módulo solo traduce una
petición normalizada en una llamada al proveedor y devuelve una respuesta
normalizada: texto final, o tool calls estructuradas.

Qué NO es (invariantes, arquitectura F6 D1/D8)
----------------------------------------------
- No ejecuta ninguna tool: solo devuelve lo que el modelo pidió.
- No conoce actor, organización ni campaña. Los únicos ids que acepta son
  opacos y solo se usan para correlacionar un log de metadatos.
- No decide ni autoriza nada; no escribe en base de datos.
- No guarda, devuelve ni registra razonamiento del proveedor (`reasoning`,
  bloques `<think>`). No registra contenido de mensajes ni de resultados de tools.
- No reintenta: un fallo es un error tipificado y Node decide.
- Todo contenido de mensajes (incluidos resultados de tools y documentos) es
  dato no confiable: aquí no se interpreta ni se obedece.

Contrato (resumen; ver `TurnoEntrada` y `TurnoSalida`)
------------------------------------------------------
Éxito 200::

    {"kind": "final" | "tool_calls", "task": "conversar", "tier": "equilibrado",
     "provider": "openrouter" | "fake", "model": "...",
     "finish_reason": "stop" | "tool_calls" | "length" | "content_filter" | "other",
     "message": {"role": "assistant", "content": "..." | null,
                 "tool_calls": [{"id": "...", "name": "...", "arguments": {...}}]},
     "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0,
               "cost_usd": 0.0 | null},
     "latency_ms": 0, "generation_id": "..." | null, "correlation": {...} | null}

Error (HTTP según la tabla de `ERRORES`)::

    {"error": {"code": "...", "message": "...", "retryable": true | false,
               "retry_after_s": 5 | null, "details": {...} | null}}
"""

from __future__ import annotations

import json
import logging
import math
import re
from dataclasses import dataclass
from typing import Any, Dict, List, Literal, Optional, Protocol  # noqa: UP035

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from .ai import provider, router
from .ai.openrouter import (
    CAT_AUTENTICACION,
    CAT_CONTEXTO,
    CAT_LIMITE,
    CAT_NO_CONFIGURADO,
    CAT_RESPUESTA,
    CAT_TIMEOUT,
    AIError,
    LlamadaHerramienta,
    RespuestaHerramientas,
)

logger = logging.getLogger("ai-worker.turno")

TAREA = "conversar"

# --- Límites (constantes de código: cambiarlos es una decisión, no un ajuste) ----
MAX_MENSAJES = 300
MAX_TOOLS = 64
MAX_TOOL_CALLS_POR_MENSAJE = 8
MAX_CARACTERES_POR_MENSAJE = 120_000
#: Suma de caracteres de mensajes + tool calls previas + definiciones de tools.
#: Por encima: MODEL_CONTEXT_TOO_LARGE sin llamar al proveedor.
MAX_CARACTERES_ENTRADA = 400_000
MAX_BYTES_CUERPO = 3_000_000
MAX_CARACTERES_ESQUEMA_TOOL = 20_000
MAX_PROFUNDIDAD_ESQUEMA = 12
MAX_CARACTERES_ARGUMENTOS = 64_000
TEMPERATURA = 0.2
#: Holgura sobre `timeout_s` antes de abandonar la espera del hilo del proveedor.
MARGEN_DEADLINE_S = 0.5

_RE_NOMBRE_TOOL = r"^[A-Za-z][A-Za-z0-9_]{0,63}$"
_RE_ID_OPACO = r"^[A-Za-z0-9_.:\-]{1,64}$"
_RE_ID_LLAMADA = re.compile(r"^[A-Za-z0-9_.:\-]{1,128}$")
#: Bloque cerrado, o abierto sin cerrar (se descarta hasta el final del texto).
_RE_PENSAMIENTO = re.compile(r"<think>.*?(?:</think>|\Z)", re.DOTALL | re.IGNORECASE)
_RE_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f\u2028\u2029]")


def sanear_para_log(valor: Any, maximo: int = 120) -> str:
    """Neutraliza saltos de línea y controles de un valor externo antes de loguearlo."""
    return _RE_CONTROL.sub("?", str(valor))[:maximo]


def _rechazar_constante(nombre: str) -> Any:
    raise ValueError(f"constante JSON no válida: {nombre}")


def _todo_finito(valor: Any) -> bool:
    """False si hay algún float NaN/inf. Iterativo: inmune a la recursión."""
    pila = [valor]
    while pila:
        v = pila.pop()
        if isinstance(v, float):
            if not math.isfinite(v):
                return False
        elif isinstance(v, dict):
            pila.extend(v.values())
        elif isinstance(v, list):
            pila.extend(v)
    return True


# --- Errores tipificados ----------------------------------------------------------


@dataclass(frozen=True)
class _Tipo:
    status: int
    retryable: bool
    mensaje: str


#: Taxonomía estable. `code` es lo que consume Node; el mensaje es solo para humanos
#: y NUNCA incluye contenido de mensajes ni detalle del proveedor.
ERRORES: Dict[str, _Tipo] = {
    "AI_DISABLED": _Tipo(503, False, "La IA está desactivada (AI_ENABLED=false)."),
    "MODEL_TIMEOUT": _Tipo(504, True, "El modelo no respondió dentro del tiempo límite."),
    "MODEL_RATE_LIMITED": _Tipo(429, True, "El proveedor está limitando las peticiones."),
    "MODEL_UPSTREAM_ERROR": _Tipo(502, True, "El proveedor del modelo falló o no está disponible."),
    "MODEL_BAD_RESPONSE": _Tipo(502, True, "El modelo devolvió una respuesta inválida."),
    "MODEL_CONTEXT_TOO_LARGE": _Tipo(413, False, "La entrada supera el contexto máximo permitido."),
    "MODEL_NOT_CONFIGURED": _Tipo(503, False, "El modelo no está configurado en el worker."),
    "REQUEST_INVALID": _Tipo(422, False, "La petición no cumple el contrato."),
    # No pertenece a la taxonomía pública: bug del worker. Node la trata como no reintentable.
    "INTERNAL_ERROR": _Tipo(500, False, "Error interno del worker."),
}


class TurnoError(Exception):
    """Error tipificado de `/modelo/turno`."""

    def __init__(
        self,
        code: str,
        *,
        retryable: Optional[bool] = None,
        retry_after_s: Optional[int] = None,
        details: Optional[Dict[str, Any]] = None,
        status: Optional[int] = None,
        message: Optional[str] = None,
    ) -> None:
        tipo = ERRORES[code]
        super().__init__(code)
        self.code = code
        self.status = status if status is not None else tipo.status
        self.retryable = tipo.retryable if retryable is None else retryable
        self.retry_after_s = retry_after_s
        self.details = details
        self.message = message or tipo.mensaje

    def cuerpo(self) -> Dict[str, Any]:
        return {
            "error": {
                "code": self.code,
                "message": self.message,
                "retryable": self.retryable,
                "retry_after_s": self.retry_after_s,
                "details": self.details,
            }
        }


# --- Entrada ------------------------------------------------------------------------


class _Estricto(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class LlamadaPrevia(_Estricto):
    """Tool call que el asistente emitió en un paso anterior (se reenvía al modelo)."""

    id: str = Field(pattern=_RE_ID_LLAMADA.pattern)
    name: str = Field(pattern=_RE_NOMBRE_TOOL)
    arguments: Dict[str, Any]


class Mensaje(_Estricto):
    role: Literal["system", "user", "assistant", "tool"]
    content: Optional[str] = Field(default=None, max_length=MAX_CARACTERES_POR_MENSAJE)
    tool_calls: Optional[List[LlamadaPrevia]] = Field(default=None, max_length=MAX_TOOL_CALLS_POR_MENSAJE)
    tool_call_id: Optional[str] = Field(default=None, pattern=_RE_ID_LLAMADA.pattern)

    @model_validator(mode="after")
    def _coherente(self) -> Mensaje:
        tiene_texto = bool(self.content and self.content.strip())
        if self.role in ("system", "user"):
            if not tiene_texto:
                raise ValueError(f"un mensaje {self.role} requiere content no vacío")
            if self.tool_calls is not None or self.tool_call_id is not None:
                raise ValueError(f"un mensaje {self.role} no admite tool_calls ni tool_call_id")
        elif self.role == "assistant":
            if self.tool_call_id is not None:
                raise ValueError("un mensaje assistant no admite tool_call_id")
            if not tiene_texto and not self.tool_calls:
                raise ValueError("un mensaje assistant requiere content o tool_calls")
        else:  # tool
            if self.tool_call_id is None or not tiene_texto:
                raise ValueError("un mensaje tool requiere tool_call_id y content no vacío")
            if self.tool_calls is not None:
                raise ValueError("un mensaje tool no admite tool_calls")
        return self


class DefinicionTool(_Estricto):
    name: str = Field(pattern=_RE_NOMBRE_TOOL)
    description: str = Field(min_length=1, max_length=2000)
    #: JSON Schema del argumento; debe ser un objeto. Node lo valida otra vez al ejecutar.
    parameters: Dict[str, Any]

    @field_validator("parameters")
    @classmethod
    def _esquema_acotado(cls, v: Dict[str, Any]) -> Dict[str, Any]:
        if v.get("type") != "object":
            raise ValueError("parameters debe ser un JSON Schema con type=object")
        if _profundidad(v) > MAX_PROFUNDIDAD_ESQUEMA:
            raise ValueError("parameters excede la profundidad máxima")
        if len(json.dumps(v, ensure_ascii=False)) > MAX_CARACTERES_ESQUEMA_TOOL:
            raise ValueError("parameters excede el tamaño máximo")
        return v


class Correlacion(_Estricto):
    """Ids OPACOS solo para correlacionar logs. No son identidad ni autoridad."""

    conversation_id: Optional[str] = Field(default=None, pattern=_RE_ID_OPACO)
    agent_run_id: Optional[str] = Field(default=None, pattern=_RE_ID_OPACO)
    step_index: Optional[int] = Field(default=None, ge=0, le=100)


class TurnoEntrada(_Estricto):
    task: Literal["conversar"]
    messages: List[Mensaje] = Field(min_length=1, max_length=MAX_MENSAJES)
    tools: List[DefinicionTool] = Field(default_factory=list, max_length=MAX_TOOLS)
    tool_choice: Literal["auto", "none", "required"] = "auto"
    max_tokens: int = Field(default=1024, ge=16, le=16_000)
    timeout_s: float = Field(default=45.0, ge=1.0, le=120.0)
    max_tool_calls: int = Field(default=4, ge=1, le=MAX_TOOL_CALLS_POR_MENSAJE)
    correlation: Optional[Correlacion] = None

    @model_validator(mode="after")
    def _estructura(self) -> TurnoEntrada:
        msgs = self.messages
        if msgs[0].role != "system":
            raise ValueError("el primer mensaje debe ser system")
        if any(m.role == "system" for m in msgs[1:]):
            raise ValueError("solo se admite un mensaje system, en primera posición")
        if msgs[-1].role not in ("user", "tool"):
            raise ValueError("el último mensaje debe ser user o tool")

        nombres = [t.name for t in self.tools]
        if len(set(nombres)) != len(nombres):
            raise ValueError("nombres de tool duplicados")
        if self.tool_choice == "required" and not self.tools:
            raise ValueError("tool_choice=required requiere tools")

        # Cada resultado de tool debe responder a una llamada previa del asistente.
        pendientes: Dict[str, str] = {}
        for i, m in enumerate(msgs):
            if m.role == "assistant" and m.tool_calls:
                for c in m.tool_calls:
                    if c.id in pendientes:
                        raise ValueError(f"messages[{i}]: id de tool call repetido")
                    pendientes[c.id] = c.name
            elif m.role == "tool" and m.tool_call_id not in pendientes:
                raise ValueError(f"messages[{i}]: tool_call_id sin llamada previa del assistant")
        return self


def _profundidad(valor: Any, nivel: int = 1) -> int:
    if nivel > MAX_PROFUNDIDAD_ESQUEMA + 1:
        return nivel
    if isinstance(valor, dict):
        return max([nivel] + [_profundidad(v, nivel + 1) for v in valor.values()])
    if isinstance(valor, list):
        return max([nivel] + [_profundidad(v, nivel + 1) for v in valor])
    return nivel


def _caracteres_de_entrada(req: TurnoEntrada) -> int:
    total = 0
    for m in req.messages:
        total += len(m.content or "")
        for c in m.tool_calls or []:
            total += len(c.name) + len(json.dumps(c.arguments, ensure_ascii=False))
    for t in req.tools:
        total += len(t.name) + len(t.description) + len(json.dumps(t.parameters, ensure_ascii=False))
    return total


def parsear_entrada(cuerpo: bytes) -> TurnoEntrada:
    """Valida el cuerpo crudo. Los errores NO reflejan el contenido recibido."""
    if len(cuerpo) > MAX_BYTES_CUERPO:
        raise TurnoError(
            "REQUEST_INVALID",
            status=413,
            details={"limit_bytes": MAX_BYTES_CUERPO},
            message="El cuerpo de la petición excede el tamaño máximo.",
        )
    try:
        crudo = json.loads(cuerpo, parse_constant=_rechazar_constante)
    except (ValueError, RecursionError) as exc:
        raise TurnoError("REQUEST_INVALID", message="El cuerpo no es JSON válido.") from exc
    if not isinstance(crudo, dict):
        raise TurnoError("REQUEST_INVALID", message="El cuerpo debe ser un objeto JSON.")
    if not _todo_finito(crudo):
        raise TurnoError("REQUEST_INVALID", message="El cuerpo contiene números no finitos.")
    try:
        return TurnoEntrada.model_validate(crudo)
    except RecursionError:
        raise TurnoError("REQUEST_INVALID", message="El cuerpo excede la profundidad permitida.") from None
    except ValidationError as exc:
        # Solo ubicación, tipo y mensaje: nunca `input`, que contendría el contenido.
        issues = [
            {"loc": ".".join(str(p) for p in e["loc"]), "type": e["type"], "msg": e["msg"]}
            for e in exc.errors()[:20]
        ]
        raise TurnoError("REQUEST_INVALID", details={"issues": issues}) from None


# --- Transporte inyectable -----------------------------------------------------------


class Transporte(Protocol):
    """Una llamada al proveedor. En producción: `provider.completar_con_herramientas`."""

    def __call__(
        self,
        modelo: str,
        mensajes: List[Dict[str, Any]],
        herramientas: List[Dict[str, Any]],
        *,
        tool_choice: str,
        temperatura: float,
        max_tokens: Optional[int],
        timeout: int,
    ) -> RespuestaHerramientas: ...


def transporte_por_defecto() -> Transporte:
    return provider.completar_con_herramientas


def _mensajes_a_proveedor(req: TurnoEntrada) -> List[Dict[str, Any]]:
    salida: List[Dict[str, Any]] = []
    for m in req.messages:
        if m.role == "assistant" and m.tool_calls:
            salida.append(
                {
                    "role": "assistant",
                    "content": m.content or None,
                    "tool_calls": [
                        {
                            "id": c.id,
                            "type": "function",
                            "function": {"name": c.name, "arguments": json.dumps(c.arguments)},
                        }
                        for c in m.tool_calls
                    ],
                }
            )
        elif m.role == "tool":
            salida.append({"role": "tool", "tool_call_id": m.tool_call_id, "content": m.content})
        else:
            salida.append({"role": m.role, "content": m.content})
    return salida


def _herramientas_a_proveedor(req: TurnoEntrada) -> List[Dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {"name": t.name, "description": t.description, "parameters": t.parameters},
        }
        for t in req.tools
    ]


# --- Salida ----------------------------------------------------------------------------

_FINISH = {
    "stop": "stop",
    "end_turn": "stop",
    "tool_calls": "tool_calls",
    "tool_use": "tool_calls",
    "function_call": "tool_calls",
    "length": "length",
    "max_tokens": "length",
    "content_filter": "content_filter",
}


def _argumentos(llamada: LlamadaHerramienta) -> Dict[str, Any]:
    """JSON roto, no-objeto, NaN/Infinity o enorme -> MODEL_BAD_RESPONSE."""
    crudo = llamada.argumentos.strip()
    if not crudo:
        return {}  # tool sin argumentos: algunos modelos emiten "" en vez de "{}"
    if len(crudo) > MAX_CARACTERES_ARGUMENTOS:
        raise _respuesta_invalida("argumentos de tool call demasiado grandes")
    try:
        valor = json.loads(crudo, parse_constant=_rechazar_constante)
    except (ValueError, RecursionError):
        raise _respuesta_invalida("argumentos de tool call no son JSON válido") from None
    if not isinstance(valor, dict):
        raise _respuesta_invalida("los argumentos de una tool call deben ser un objeto JSON")
    if not _todo_finito(valor):
        raise _respuesta_invalida("argumentos de tool call con números no finitos")
    return valor


def _respuesta_invalida(motivo: str) -> TurnoError:
    # `motivo` es una cadena fija del worker, nunca contenido del modelo.
    return TurnoError("MODEL_BAD_RESPONSE", details={"reason": motivo})


def _entero(valor: Any) -> int:
    if isinstance(valor, bool) or not isinstance(valor, int) or valor < 0:
        raise _respuesta_invalida("uso de tokens inválido")
    return int(valor)


def validar_respuesta(req: TurnoEntrada, crudo: RespuestaHerramientas) -> Dict[str, Any]:
    """Convierte la salida del proveedor en la respuesta normalizada o falla tipificado.

    Nunca se pasa al llamador una tool call que no se haya podido validar.
    """
    declaradas = {t.name for t in req.tools}
    finish = _FINISH.get(str(crudo.finish_reason or "").lower(), "other")

    llamadas: List[Dict[str, Any]] = []
    if crudo.llamadas:
        if req.tool_choice == "none" or not declaradas:
            raise _respuesta_invalida("el modelo pidió tools con tool_choice=none o sin tools")
        if len(crudo.llamadas) > req.max_tool_calls:
            raise _respuesta_invalida("demasiadas tool calls en un paso")
        if finish == "length":
            raise _respuesta_invalida("respuesta truncada con tool calls")
        vistos = set()
        for c in crudo.llamadas:
            if not _RE_ID_LLAMADA.match(c.id) or c.id in vistos:
                raise _respuesta_invalida("id de tool call ausente, inválido o repetido")
            if c.nombre not in declaradas:
                raise _respuesta_invalida("el modelo pidió una tool no declarada")
            vistos.add(c.id)
            llamadas.append({"id": c.id, "name": c.nombre, "arguments": _argumentos(c)})
        # Con tool calls no se devuelve texto: el razonamiento/preámbulo del modelo se descarta.
        contenido: Optional[str] = None
        kind = "tool_calls"
        finish = "tool_calls"
    else:
        if req.tool_choice == "required":
            raise _respuesta_invalida("tool_choice=required y el modelo no pidió ninguna tool")
        # Se descartan bloques <think>…</think> por si el modelo mete su razonamiento en el texto.
        contenido = _RE_PENSAMIENTO.sub("", crudo.contenido or "").strip()
        if not contenido:
            raise _respuesta_invalida("respuesta vacía")
        kind = "final"

    uso = crudo.uso
    costo = uso.costo_usd
    es_numero = isinstance(costo, (int, float)) and not isinstance(costo, bool)  # noqa: UP038
    if not es_numero or costo is None or costo < 0 or not math.isfinite(costo):
        costo = None
    return {
        "kind": kind,
        "task": TAREA,
        "tier": "",  # lo completa quien conoce el destino
        "provider": provider.nombre_proveedor(),
        "model": crudo.modelo,
        "finish_reason": finish,
        "message": {"role": "assistant", "content": contenido, "tool_calls": llamadas},
        "usage": {
            "prompt_tokens": _entero(uso.prompt_tokens),
            "completion_tokens": _entero(uso.completion_tokens),
            "total_tokens": _entero(uso.total_tokens),
            "cost_usd": None if costo is None else float(costo),
        },
        "latency_ms": _entero(crudo.latencia_ms),
        "generation_id": crudo.generacion_id if isinstance(crudo.generacion_id, str) else None,
        "correlation": None,
    }


# --- Orquestación de UN turno -----------------------------------------------------------


def _traducir_fallo_de_proveedor(exc: AIError) -> TurnoError:
    """AIError -> código de la taxonomía. El mensaje del proveedor NO se propaga."""
    cat = exc.categoria
    if cat in (CAT_NO_CONFIGURADO, CAT_AUTENTICACION):
        return TurnoError("MODEL_NOT_CONFIGURED", details={"upstream_status": exc.status})
    if cat == CAT_TIMEOUT:
        return TurnoError("MODEL_TIMEOUT")
    if cat == CAT_LIMITE:
        return TurnoError("MODEL_RATE_LIMITED", retry_after_s=exc.retry_after_s)
    if cat == CAT_CONTEXTO:
        return TurnoError("MODEL_CONTEXT_TOO_LARGE", details={"upstream_status": exc.status})
    if cat == CAT_RESPUESTA:
        return TurnoError("MODEL_BAD_RESPONSE", details={"reason": "respuesta del proveedor ilegible"})
    return TurnoError(
        "MODEL_UPSTREAM_ERROR", retryable=exc.retryable, details={"upstream_status": exc.status}
    )


def ia_activa() -> bool:
    """Mismo criterio que `embeddings._ia_activa` y `load_settings` (D8)."""
    import os

    return os.environ.get("AI_ENABLED", "false").strip().lower() in {"1", "true", "yes"}


def ejecutar_turno(req: TurnoEntrada, transporte: Transporte) -> Dict[str, Any]:
    """Una llamada de modelo, sincrónica y sin reintentos. Lanza `TurnoError`."""
    if _caracteres_de_entrada(req) > MAX_CARACTERES_ENTRADA:
        raise TurnoError(
            "MODEL_CONTEXT_TOO_LARGE",
            details={"limit_chars": MAX_CARACTERES_ENTRADA},
            message="La entrada supera el máximo de caracteres permitido.",
        )
    try:
        destino = router.resolver(req.task)
    except router.RouterError:
        raise TurnoError("MODEL_NOT_CONFIGURED", details={"reason": "nivel sin modelo"}) from None

    try:
        crudo = transporte(
            destino.modelo,
            _mensajes_a_proveedor(req),
            _herramientas_a_proveedor(req),
            tool_choice=req.tool_choice,
            temperatura=TEMPERATURA,
            max_tokens=req.max_tokens,
            timeout=int(math.ceil(req.timeout_s)),
        )
    except AIError as exc:
        raise _traducir_fallo_de_proveedor(exc) from None
    except TimeoutError:
        raise TurnoError("MODEL_TIMEOUT") from None

    salida = validar_respuesta(req, crudo)
    salida["tier"] = destino.nivel
    if req.correlation is not None:
        salida["correlation"] = req.correlation.model_dump(exclude_none=True)
    return salida


def registrar_metadatos(
    req: Optional[TurnoEntrada],
    *,
    resultado: str,
    salida: Optional[Dict[str, Any]] = None,
    duracion_ms: int = 0,
) -> None:
    """UNA línea de log con metadatos. Jamás contenido de mensajes ni de resultados de tools."""
    corr = req.correlation if req is not None else None
    uso = (salida or {}).get("usage") or {}
    logger.info(
        "modelo_turno resultado=%s conversation_id=%s agent_run_id=%s step_index=%s "
        "mensajes=%s tools=%s kind=%s model=%s provider=%s finish=%s "
        "prompt_tokens=%s completion_tokens=%s cost_usd=%s latency_ms=%s wall_ms=%s",
        resultado,
        corr.conversation_id if corr else None,
        corr.agent_run_id if corr else None,
        corr.step_index if corr else None,
        len(req.messages) if req else None,
        len(req.tools) if req else None,
        (salida or {}).get("kind"),
        sanear_para_log((salida or {}).get("model")),
        sanear_para_log((salida or {}).get("provider")),
        (salida or {}).get("finish_reason"),
        uso.get("prompt_tokens"),
        uso.get("completion_tokens"),
        uso.get("cost_usd"),
        (salida or {}).get("latency_ms"),
        duracion_ms,
    )
