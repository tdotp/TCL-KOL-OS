# ruff: noqa: UP006, UP007, UP035 — Pydantic evalúa las anotaciones en 3.9: `Optional`/`List`/`Dict`.
"""`POST /modelo/analisis` — análisis de un guion contra el Brief aprobado (V2 · Fase 7).

Qué es
------
Un adaptador fino y SIN ESTADO entre el caso de uso de análisis (Node) y el
proveedor de IA. Node arma los mensajes (sobres no confiables, prompt versionado
en TS), llama aquí, y Node valida la SEMÁNTICA y persiste. Este módulo solo:

1. valida el cuerpo de la petición (contrato estricto, `extra=forbid`);
2. comprueba el kill-switch (`AI_ENABLED`) y que haya modelo para la tarea;
3. hace UNA llamada al proveedor en modo JSON, `temperatura=0`
   (más UN reintento si, y solo si, el JSON viene roto, vacío o truncado);
4. valida la FORMA de la salida (objeto con `schema_version` y `findings`,
   tipos exactos, enums cerrados, sin campos extra, tamaños acotados);
5. devuelve la salida normalizada junto con uso/costo/modelo/intentos.

Qué NO es (invariantes)
-----------------------
- No contiene lógica de dominio: no resuelve alias, no verifica citas contra el
  guion, no deriva severidades, no decide ni aprueba nada. Todo eso es de Node.
- No conoce actor, organización ni campaña; el único id que acepta es opaco y
  solo correlaciona un log de metadatos.
- No escribe en base de datos y no registra contenido (ni del guion, ni del
  Brief, ni de la respuesta del modelo). No guarda ni devuelve razonamiento
  (`<think>` se descarta).
- Todo contenido de los mensajes es dato no confiable: aquí no se interpreta.
- Una salida de forma inválida NO se reintenta (solo un JSON roto): reintentar
  una respuesta «bien formada pero mala» solo gastaría dinero.

Contrato (resumen; ver `AnalisisEntrada` y `SalidaAnalisis`)
------------------------------------------------------------
Éxito 200::

    {"task": "analizar_guion", "tier": "equilibrado", "provider": "openrouter" | "fake",
     "model": "...", "finish_reason": "stop" | "length" | "content_filter" | "other",
     "output": {"schema_version": "analisis-guion-salida-1", "findings": [...]},
     "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0, "cost_usd": 0.0 | null},
     "attempts": 1 | 2,
     "calls": [{"usage": {...} | null, "latency_ms": 0, "generation_id": "..." | null,
                "outcome": "ok" | "json_invalido" | "forma_invalida" | "error"}],
     "latency_ms": 0, "generation_id": "..." | null, "correlation": {...} | null}

Error (HTTP según la tabla de `ERRORES_ANALISIS`)::

    {"error": {"code": "...", "message": "...", "retryable": true | false,
               "retry_after_s": 5 | null, "details": {...} | null,
               # solo si hubo al menos una llamada al proveedor:
               "usage": {...}, "calls": [...], "attempts": 1 | 2}}
"""

from __future__ import annotations

import json
import logging
import math
import re
import time
from typing import Annotated, Any, Dict, List, Literal, Optional, Protocol, Tuple  # noqa: UP035

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    ValidationError,
    model_validator,
)

from .ai import provider, router
from .ai.openrouter import AIError, Respuesta
from .modelo_turno import (
    _FINISH,
    _RE_ID_OPACO,
    _RE_PENSAMIENTO,
    ERRORES,
    MAX_BYTES_CUERPO,
    MAX_CARACTERES_ENTRADA,
    MAX_CARACTERES_POR_MENSAJE,
    TurnoError,
    _rechazar_constante,
    _Tipo,
    _todo_finito,
    _traducir_fallo_de_proveedor,
    ia_activa,
    sanear_para_log,
)

logger = logging.getLogger("ai-worker.analisis")

TAREA = "analizar_guion"
VERSION_ESQUEMA_SALIDA = "analisis-guion-salida-1"
TEMPERATURA = 0.0
#: Una sola repetición, y solo por JSON roto/vacío/truncado.
MAX_INTENTOS = 2

# --- Límites de FORMA de la salida (idénticos a `LIMITES_DE_SALIDA` en packages/domain) ---
MAX_HALLAZGOS = 25
MAX_REFERENCIAS = 4
MAX_CITAS = 3
MAX_CARACTERES_ALIAS = 32
MAX_CARACTERES_DESCRIPCION_FORMA = 1_000
MAX_CARACTERES_CITA_FORMA = 2_000
#: `[0-9]` y no `\d`: el `\d` del motor de Pydantic (Rust) es Unicode; el de JS, solo ASCII.
RE_ID_HALLAZGO = r"^h[0-9]{1,2}$"

CATEGORIAS = (
    "cta_missing",
    "key_message_incomplete",
    "requirement_not_covered",
    "claim_unsupported",
    "claim_contradicted",
    "restriction_violated",
    "brief_contradiction",
)

# --- Errores tipificados ----------------------------------------------------------------

#: Los de `modelo_turno.ERRORES` más la salida inválida del modelo (no reintentable).
ERRORES_ANALISIS: Dict[str, _Tipo] = {
    **ERRORES,
    "MODEL_OUTPUT_INVALID": _Tipo(
        422, False, "El modelo devolvió una salida que no cumple el contrato del análisis."
    ),
}


class AnalisisError(Exception):
    """Error tipificado de `/modelo/analisis`. Lleva uso/llamadas si hubo llamada al proveedor."""

    def __init__(
        self,
        code: str,
        *,
        retryable: Optional[bool] = None,
        retry_after_s: Optional[int] = None,
        details: Optional[Dict[str, Any]] = None,
        status: Optional[int] = None,
        message: Optional[str] = None,
        llamadas: Optional[List[Dict[str, Any]]] = None,
    ) -> None:
        tipo = ERRORES_ANALISIS[code]
        super().__init__(code)
        self.code = code
        self.status = status if status is not None else tipo.status
        self.retryable = tipo.retryable if retryable is None else retryable
        self.retry_after_s = retry_after_s
        self.details = details
        self.message = message or tipo.mensaje
        self.llamadas: List[Dict[str, Any]] = list(llamadas or [])

    def cuerpo(self) -> Dict[str, Any]:
        error: Dict[str, Any] = {
            "code": self.code,
            "message": self.message,
            "retryable": self.retryable,
            "retry_after_s": self.retry_after_s,
            "details": self.details,
        }
        if self.llamadas:
            error["usage"] = _sumar_uso(self.llamadas)
            error["calls"] = self.llamadas
            error["attempts"] = len(self.llamadas)
        return {"error": error}


def _desde_turno(error: TurnoError, llamadas: List[Dict[str, Any]]) -> AnalisisError:
    """Reempaqueta un error de proveedor (ya tipificado, sin contenido) con las llamadas hechas."""
    return AnalisisError(
        error.code,
        retryable=error.retryable,
        retry_after_s=error.retry_after_s,
        details=error.details,
        status=error.status,
        message=error.message,
        llamadas=llamadas,
    )


# --- Entrada ------------------------------------------------------------------------------


class _Estricto(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class MensajeAnalisis(_Estricto):
    role: Literal["system", "user"]
    content: str = Field(max_length=MAX_CARACTERES_POR_MENSAJE)

    @model_validator(mode="after")
    def _con_texto(self) -> MensajeAnalisis:
        if not self.content.strip():
            raise ValueError(f"un mensaje {self.role} requiere content no vacío")
        return self


class CorrelacionAnalisis(_Estricto):
    """Id OPACO solo para correlacionar logs. No es identidad ni autoridad."""

    analysis_run_id: Optional[str] = Field(default=None, pattern=_RE_ID_OPACO)


class AnalisisEntrada(_Estricto):
    task: Literal["analizar_guion"]
    messages: List[MensajeAnalisis] = Field(min_length=2, max_length=2)
    output_schema_version: Literal["analisis-guion-salida-1"]
    max_findings: int = Field(default=MAX_HALLAZGOS, ge=1, le=MAX_HALLAZGOS)
    max_tokens: int = Field(default=6_000, ge=256, le=16_000)
    timeout_s: float = Field(default=90.0, ge=1.0, le=120.0)
    correlation: Optional[CorrelacionAnalisis] = None

    @model_validator(mode="after")
    def _estructura(self) -> AnalisisEntrada:
        if self.messages[0].role != "system" or self.messages[1].role != "user":
            raise ValueError("messages debe ser exactamente [system, user]")
        return self


def _caracteres_de_entrada(req: AnalisisEntrada) -> int:
    return sum(len(m.content) for m in req.messages)


def parsear_entrada(cuerpo: bytes) -> AnalisisEntrada:
    """Valida el cuerpo crudo. Los errores NO reflejan el contenido recibido."""
    if len(cuerpo) > MAX_BYTES_CUERPO:
        raise AnalisisError(
            "REQUEST_INVALID",
            status=413,
            details={"limit_bytes": MAX_BYTES_CUERPO},
            message="El cuerpo de la petición excede el tamaño máximo.",
        )
    try:
        crudo = json.loads(cuerpo, parse_constant=_rechazar_constante)
    except (ValueError, RecursionError) as exc:
        raise AnalisisError("REQUEST_INVALID", message="El cuerpo no es JSON válido.") from exc
    if not isinstance(crudo, dict):
        raise AnalisisError("REQUEST_INVALID", message="El cuerpo debe ser un objeto JSON.")
    if not _todo_finito(crudo):
        raise AnalisisError("REQUEST_INVALID", message="El cuerpo contiene números no finitos.")
    try:
        return AnalisisEntrada.model_validate(crudo)
    except RecursionError:
        raise AnalisisError("REQUEST_INVALID", message="El cuerpo excede la profundidad permitida.") from None
    except ValidationError as exc:
        # Solo ubicación, tipo y mensaje: nunca `input`, que contendría el contenido.
        issues = [
            {"loc": ".".join(str(p) for p in e["loc"]), "type": e["type"], "msg": e["msg"]}
            for e in exc.errors()[:20]
        ]
        raise AnalisisError("REQUEST_INVALID", details={"issues": issues}) from None


# --- Forma de la salida del modelo (espejo de `validarFormaDeSalida` en packages/domain) ----

Alias = Annotated[str, StringConstraints(max_length=MAX_CARACTERES_ALIAS)]


class CitaSalida(_Estricto):
    fragment: str = Field(max_length=MAX_CARACTERES_ALIAS)
    quote: str = Field(max_length=MAX_CARACTERES_CITA_FORMA)


class HallazgoSalida(_Estricto):
    id: str = Field(pattern=RE_ID_HALLAZGO)
    category: Literal[
        "cta_missing",
        "key_message_incomplete",
        "requirement_not_covered",
        "claim_unsupported",
        "claim_contradicted",
        "restriction_violated",
        "brief_contradiction",
    ]
    basis: Literal["absence", "partial", "conflict"]
    #: En v1 el modelo solo emite `unsupported`/`contradicted` (o nada).
    claim_status: Optional[Literal["unsupported", "contradicted"]] = None
    description: str = Field(max_length=MAX_CARACTERES_DESCRIPCION_FORMA)
    brief_refs: List[Alias] = Field(max_length=MAX_REFERENCIAS)
    script_quotes: List[CitaSalida] = Field(default_factory=list, max_length=MAX_CITAS)


class SalidaAnalisis(_Estricto):
    schema_version: Literal["analisis-guion-salida-1"]
    findings: List[HallazgoSalida] = Field(max_length=MAX_HALLAZGOS)


def _issues_de_forma(exc: ValidationError) -> List[Dict[str, str]]:
    """`[{loc, type}]` SIN contenido: de una clave extra se omite el nombre (lo eligió el modelo)."""
    issues: List[Dict[str, str]] = []
    for e in exc.errors()[:20]:
        loc = list(e["loc"])
        if e["type"] == "extra_forbidden" and loc:
            loc = loc[:-1]
        issues.append({"loc": (".".join(str(p) for p in loc) or "$")[:120], "type": str(e["type"])})
    return issues


def validar_forma(
    valor: Any, max_findings: int = MAX_HALLAZGOS
) -> Tuple[Optional[Dict[str, Any]], List[Dict[str, str]]]:
    """`(salida_normalizada, issues)`. Exactamente uno de los dos es significativo."""
    try:
        salida = SalidaAnalisis.model_validate(valor)
    except RecursionError:
        return None, [{"loc": "$", "type": "recursion"}]
    except ValidationError as exc:
        return None, _issues_de_forma(exc)
    if len(salida.findings) > max_findings:
        return None, [{"loc": "findings", "type": "too_many_findings"}]
    return salida.model_dump(), []


# --- Parseo tolerante del JSON ---------------------------------------------------------------

_RE_VALLA_COMPLETA = re.compile(r"^```[A-Za-z0-9_-]*[ \t]*\n?(.*?)\n?```\s*$", re.DOTALL)
_RE_VALLA_ABIERTA = re.compile(r"^```[A-Za-z0-9_-]*[ \t]*\n?")


def parsear_salida(texto: str) -> Tuple[Any, Optional[str]]:
    """`(valor, problema)`. `problema` es `vacio` o `json_invalido`, nunca contenido del modelo.

    Tolera un bloque de código ``` alrededor del JSON y bloques `<think>…</think>` (se descartan:
    no se guarda razonamiento). NaN/Infinity y números fuera de rango (`1e999`) son JSON roto.
    """
    limpio = _RE_PENSAMIENTO.sub("", texto or "").strip()
    if not limpio:
        return None, "vacio"
    m = _RE_VALLA_COMPLETA.match(limpio)
    if m is not None:
        limpio = m.group(1).strip()
    elif limpio.startswith("```"):
        limpio = _RE_VALLA_ABIERTA.sub("", limpio, count=1).strip()
    if not limpio:
        return None, "vacio"
    try:
        valor = json.loads(limpio, parse_constant=_rechazar_constante)
    except (ValueError, RecursionError):
        return None, "json_invalido"
    if not _todo_finito(valor):
        return None, "json_invalido"
    return valor, None


# --- Transporte inyectable ---------------------------------------------------------------------


class Transporte(Protocol):
    """Una llamada al proveedor. En producción: `provider.completar` en modo JSON."""

    def __call__(
        self,
        modelo: str,
        mensajes: List[Dict[str, str]],
        *,
        temperatura: float,
        max_tokens: Optional[int],
        formato_json: bool,
        timeout: int,
    ) -> Respuesta: ...


def transporte_por_defecto() -> Transporte:
    return provider.completar


# --- Uso y llamadas ------------------------------------------------------------------------------


def _entero(valor: Any) -> int:
    if isinstance(valor, bool) or not isinstance(valor, int) or valor < 0:
        raise TurnoError("MODEL_BAD_RESPONSE", details={"reason": "uso de tokens inválido"})
    return int(valor)


def _costo(valor: Any) -> Optional[float]:
    es_numero = isinstance(valor, (int, float)) and not isinstance(valor, bool)  # noqa: UP038
    if not es_numero or valor < 0 or not math.isfinite(valor):
        return None
    return float(valor)


def _sumar_uso(llamadas: List[Dict[str, Any]]) -> Dict[str, Any]:
    prompt = completion = total = 0
    costo: Optional[float] = 0.0
    for c in llamadas:
        u = c.get("usage")
        if u is None:
            continue
        prompt += int(u["prompt_tokens"])
        completion += int(u["completion_tokens"])
        total += int(u["total_tokens"])
        costo = None if (costo is None or u["cost_usd"] is None) else costo + float(u["cost_usd"])
    return {
        "prompt_tokens": prompt,
        "completion_tokens": completion,
        "total_tokens": total,
        "cost_usd": costo,
    }


def _llamada(crudo: Respuesta, latencia_ms: int, outcome: str) -> Dict[str, Any]:
    uso = crudo.uso
    return {
        "usage": {
            "prompt_tokens": _entero(uso.prompt_tokens),
            "completion_tokens": _entero(uso.completion_tokens),
            "total_tokens": _entero(uso.total_tokens),
            "cost_usd": _costo(uso.costo_usd),
        },
        "latency_ms": max(0, int(latencia_ms)),
        "generation_id": crudo.generacion_id if isinstance(crudo.generacion_id, str) else None,
        "outcome": outcome,
    }


def _llamada_sin_respuesta(latencia_ms: int) -> Dict[str, Any]:
    """El proveedor falló antes de devolver uso: la llamada existió (puede costar), sin cifras."""
    return {"usage": None, "latency_ms": max(0, int(latencia_ms)), "generation_id": None, "outcome": "error"}


class Seguimiento:
    """Estado observable de un análisis en curso: lo lee quien lo abandona por plazo (asyncio)."""

    def __init__(self) -> None:
        self.llamadas: List[Dict[str, Any]] = []
        self.en_curso = False
        self.inicio_de_llamada = 0.0

    def llamadas_para_error(self) -> List[Dict[str, Any]]:
        salida = list(self.llamadas)
        if self.en_curso:
            salida.append(_llamada_sin_respuesta(int((time.monotonic() - self.inicio_de_llamada) * 1000)))
        return salida


# --- Orquestación ----------------------------------------------------------------------------------


def ejecutar_analisis(
    req: AnalisisEntrada,
    transporte: Transporte,
    seguimiento: Optional[Seguimiento] = None,
) -> Dict[str, Any]:
    """Una o dos llamadas (la segunda solo por JSON roto/vacío/truncado). Lanza `AnalisisError`."""
    seg = seguimiento if seguimiento is not None else Seguimiento()
    if _caracteres_de_entrada(req) > MAX_CARACTERES_ENTRADA:
        raise AnalisisError(
            "MODEL_CONTEXT_TOO_LARGE",
            details={"limit_chars": MAX_CARACTERES_ENTRADA},
            message="La entrada supera el máximo de caracteres permitido.",
        )
    try:
        destino = router.resolver(req.task)
    except router.RouterError:
        raise AnalisisError("MODEL_NOT_CONFIGURED", details={"reason": "nivel sin modelo"}) from None

    mensajes = [{"role": m.role, "content": m.content} for m in req.messages]
    inicio = time.monotonic()

    for intento in range(1, MAX_INTENTOS + 1):
        restante = req.timeout_s - (time.monotonic() - inicio)
        # El primer intento siempre se hace; el reintento solo si queda al menos 1 s del plazo total.
        if intento > 1 and restante < 1.0:
            raise AnalisisError("MODEL_TIMEOUT", llamadas=seg.llamadas)
        seg.en_curso = True
        seg.inicio_de_llamada = time.monotonic()
        try:
            crudo = transporte(
                destino.modelo,
                mensajes,
                temperatura=TEMPERATURA,
                max_tokens=req.max_tokens,
                formato_json=True,
                timeout=max(1, int(math.ceil(restante))),
            )
        except AIError as exc:
            seg.en_curso = False
            seg.llamadas.append(
                _llamada_sin_respuesta(int((time.monotonic() - seg.inicio_de_llamada) * 1000))
            )
            raise _desde_turno(_traducir_fallo_de_proveedor(exc), seg.llamadas) from None
        except TimeoutError:
            seg.en_curso = False
            seg.llamadas.append(
                _llamada_sin_respuesta(int((time.monotonic() - seg.inicio_de_llamada) * 1000))
            )
            raise AnalisisError("MODEL_TIMEOUT", llamadas=seg.llamadas) from None
        seg.en_curso = False
        latencia = int((time.monotonic() - seg.inicio_de_llamada) * 1000)

        finish = _FINISH.get(str((crudo.metadata or {}).get("finish_reason") or "").lower(), "other")
        contenido = crudo.contenido if isinstance(crudo.contenido, str) else ""

        # Una respuesta cortada por longitud se trata como JSON truncado aunque parezca parseable.
        problema: Optional[str] = "truncado" if finish == "length" else None
        valor: Any = None
        if problema is None:
            valor, problema = parsear_salida(contenido)
        if finish == "content_filter":
            problema = "content_filter"

        if problema is not None:
            try:
                seg.llamadas.append(_llamada(crudo, latencia, "json_invalido"))
            except TurnoError as exc:
                raise _desde_turno(exc, seg.llamadas) from None
            reintentable = problema in ("vacio", "json_invalido", "truncado")
            if reintentable and intento < MAX_INTENTOS:
                continue
            raise AnalisisError(
                "MODEL_OUTPUT_INVALID",
                details={"reason": problema, "attempts": intento},
                llamadas=seg.llamadas,
            )

        salida, issues = validar_forma(valor, req.max_findings)
        try:
            seg.llamadas.append(_llamada(crudo, latencia, "ok" if salida is not None else "forma_invalida"))
        except TurnoError as exc:
            raise _desde_turno(exc, seg.llamadas) from None
        if salida is None:
            raise AnalisisError(
                "MODEL_OUTPUT_INVALID",
                details={"reason": "forma_invalida", "issues": issues, "attempts": intento},
                llamadas=seg.llamadas,
            )
        return {
            "task": TAREA,
            "tier": destino.nivel,
            "provider": provider.nombre_proveedor(),
            "model": crudo.modelo,
            "finish_reason": finish,
            "output": salida,
            "usage": _sumar_uso(seg.llamadas),
            "attempts": len(seg.llamadas),
            "calls": seg.llamadas,
            "latency_ms": sum(int(c["latency_ms"]) for c in seg.llamadas),
            "generation_id": seg.llamadas[-1]["generation_id"],
            "correlation": (
                req.correlation.model_dump(exclude_none=True) if req.correlation is not None else None
            ),
        }
    raise AnalisisError("INTERNAL_ERROR", llamadas=seg.llamadas)  # pragma: no cover


def registrar_metadatos(
    req: Optional[AnalisisEntrada],
    *,
    resultado: str,
    salida: Optional[Dict[str, Any]] = None,
    error: Optional[AnalisisError] = None,
    duracion_ms: int = 0,
) -> None:
    """UNA línea de log con metadatos. Jamás contenido del guion, del Brief ni de la respuesta."""
    corr = req.correlation if req is not None else None
    llamadas = (salida or {}).get("calls") or (error.llamadas if error is not None else [])
    uso = (salida or {}).get("usage") or (_sumar_uso(llamadas) if llamadas else {})
    logger.info(
        "modelo_analisis resultado=%s analysis_run_id=%s mensajes=%s model=%s provider=%s finish=%s "
        "attempts=%s prompt_tokens=%s completion_tokens=%s cost_usd=%s latency_ms=%s wall_ms=%s",
        resultado,
        corr.analysis_run_id if corr else None,
        len(req.messages) if req else None,
        sanear_para_log((salida or {}).get("model")),
        sanear_para_log((salida or {}).get("provider")),
        (salida or {}).get("finish_reason"),
        (salida or {}).get("attempts") if salida else (len(llamadas) or None),
        uso.get("prompt_tokens"),
        uso.get("completion_tokens"),
        uso.get("cost_usd"),
        (salida or {}).get("latency_ms"),
        duracion_ms,
    )


__all__ = [
    "AnalisisEntrada",
    "AnalisisError",
    "ERRORES_ANALISIS",
    "SalidaAnalisis",
    "Seguimiento",
    "TAREA",
    "Transporte",
    "ejecutar_analisis",
    "ia_activa",
    "parsear_entrada",
    "parsear_salida",
    "registrar_metadatos",
    "transporte_por_defecto",
    "validar_forma",
]
