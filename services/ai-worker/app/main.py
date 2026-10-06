"""Worker documental e IA de TCL KOL OS.

Responsabilidad: parsing, OCR, extracción, RAG, traducción y exportación.

Lo que este servicio NO hace (ADR-008 y D0-09 §3.1):
  - no decide estados ni permisos;
  - no aprueba nada;
  - recibe trabajo ya autorizado y devuelve un resultado que la capa de dominio
    valida antes de persistir.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any, Dict, Optional  # noqa: UP035 — Pydantic evalúa las anotaciones en 3.9

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from . import embeddings, extraction, modelo_analisis, modelo_turno, parsers
from .ai.router import RouterError
from .config import ConfigError, Settings, load_settings


class ConsultaEntrada(BaseModel):
    """Texto a vectorizar. Nada más: sin scope, sin identidad, sin permisos."""

    texto: str = Field(min_length=1, max_length=8000)


class FragmentoEntrada(BaseModel):
    """Un fragmento ya autorizado por la capa que sabe quién pregunta.

    Los campos opcionales usan `Optional[X]` de `typing`, no `X | None`: a
    diferencia de una anotación de función normal, Pydantic v2 evalúa las
    anotaciones de un `BaseModel` en el momento de definir la clase para
    construir su esquema de validación — `from __future__ import annotations`
    no lo protege. `X | None` sin eso revienta en el Python 3.9 declarado
    como mínimo (`requires-python = ">=3.9"` en pyproject.toml); `Optional[X]`
    es la única forma segura aquí. Ver HANDOFF.md §8 para el incidente real
    que dejó esta nota — un `ruff check --fix` mecánico lo rompió una vez.
    """

    id: str
    source_id: str
    filename: str
    texto: str
    page: Optional[int] = None  # noqa: UP007 — ver docstring de la clase
    slide: Optional[int] = None  # noqa: UP007
    section: Optional[str] = None  # noqa: UP007
    linea: Optional[int] = None  # noqa: UP007
    locator: Optional[Dict[str, Any]] = None  # noqa: UP006, UP007, UP035 — SourceLocator (V2 · Fase 4)


class ProductoEntrada(BaseModel):
    """Un producto válido de la campaña (DEC-016). Nunca lo busca el worker."""

    id: str
    nombre_producto: str


class ExtraccionEntrada(BaseModel):
    fragmentos: list[FragmentoEntrada] = Field(min_length=1, max_length=200)
    #: Vacío para campañas de un solo producto sin catálogo declarado. Con más
    #: de un producto, ancla cada campo `marca_producto[].*` al que corresponde
    #: (DEC-016/DEC-023, corrección 3.2 del cierre de Sprint 4).
    productos: list[ProductoEntrada] = Field(default_factory=list)

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
    except embeddings.EmbeddingsDesactivadosError as exc:
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
            locator=f.locator,
        )
        for f in peticion.fragmentos
    ]
    productos = [
        extraction.ProductoDeEntrada(id=p.id, nombre_producto=p.nombre_producto)
        for p in peticion.productos
    ]

    try:
        resultado = extraction.extraer(fragmentos, productos=productos)
    except extraction.ExtraccionInvalidaError as exc:
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
                "productoId": c.producto_id,
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


@app.post("/modelo/turno", response_model=None)
async def modelo_de_turno(
    request: Request,
    transporte: modelo_turno.Transporte = Depends(modelo_turno.transporte_por_defecto),  # noqa: B008
) -> JSONResponse:
    """UNA llamada de modelo con tool calling (Fase 6, arquitectura D1/D8/D16).

    Sin estado y sin autoridad: no ejecuta tools, no conoce actor/organización/
    campaña, no guarda nada y no registra contenido. Recibe mensajes y tools ya
    ensamblados por el runtime (Node) y devuelve texto final o tool calls
    validadas. Errores tipificados con `retryable`; ver `app/modelo_turno.py`.

    Se lee el cuerpo crudo (no un modelo Pydantic en la firma) para que los
    errores de validación nunca reflejen el contenido recibido.
    """
    inicio = time.monotonic()
    req: modelo_turno.TurnoEntrada | None = None
    try:
        if not modelo_turno.ia_activa():
            raise modelo_turno.TurnoError("AI_DISABLED")
        declarado = request.headers.get("content-length")
        if declarado is not None and declarado.isdigit() and int(declarado) > modelo_turno.MAX_BYTES_CUERPO:
            raise modelo_turno.TurnoError(
                "REQUEST_INVALID",
                status=413,
                details={"limit_bytes": modelo_turno.MAX_BYTES_CUERPO},
                message="El cuerpo de la petición excede el tamaño máximo.",
            )
        req = modelo_turno.parsear_entrada(await _leer_cuerpo_acotado(request))
        # El proveedor se llama en un hilo (urllib es bloqueante); el plazo total
        # se acota aquí aunque el socket gotee datos sin llegar a su timeout.
        salida = await asyncio.wait_for(
            run_in_threadpool(modelo_turno.ejecutar_turno, req, transporte),
            timeout=req.timeout_s + modelo_turno.MARGEN_DEADLINE_S,
        )
        # Serializar aquí (dentro del try) para que un valor no serializable sea un error tipificado.
        respuesta = JSONResponse(salida)
    except asyncio.TimeoutError:  # noqa: UP041
        return _error_de_turno(req, modelo_turno.TurnoError("MODEL_TIMEOUT"), inicio)
    except modelo_turno.TurnoError as error:
        return _error_de_turno(req, error, inicio)
    except ValueError:
        return _error_de_turno(
            req,
            modelo_turno.TurnoError(
                "MODEL_BAD_RESPONSE", details={"reason": "respuesta no serializable"}
            ),
            inicio,
        )
    except Exception as exc:  # noqa: BLE001
        logger.error("modelo_turno error inesperado tipo=%s", type(exc).__name__)
        return _error_de_turno(req, modelo_turno.TurnoError("INTERNAL_ERROR"), inicio)

    modelo_turno.registrar_metadatos(
        req, resultado="ok", salida=salida, duracion_ms=int((time.monotonic() - inicio) * 1000)
    )
    return respuesta


async def _leer_cuerpo_acotado(request: Request) -> bytes:
    """Lee el cuerpo por flujo y corta al superar el tope (no acumula 40 MB antes de rechazar)."""
    tope = modelo_turno.MAX_BYTES_CUERPO
    partes: list[bytes] = []
    total = 0
    async for trozo in request.stream():
        total += len(trozo)
        if total > tope:
            raise modelo_turno.TurnoError(
                "REQUEST_INVALID",
                status=413,
                details={"limit_bytes": tope},
                message="El cuerpo de la petición excede el tamaño máximo.",
            )
        partes.append(trozo)
    return b"".join(partes)


def _error_de_turno(
    req: modelo_turno.TurnoEntrada | None, error: modelo_turno.TurnoError, inicio: float
) -> JSONResponse:
    modelo_turno.registrar_metadatos(
        req, resultado=error.code, duracion_ms=int((time.monotonic() - inicio) * 1000)
    )
    cabeceras = {"Retry-After": str(error.retry_after_s)} if error.retry_after_s is not None else None
    return JSONResponse(error.cuerpo(), status_code=error.status, headers=cabeceras)


@app.post("/modelo/analisis", response_model=None)
async def modelo_de_analisis(
    request: Request,
    transporte: modelo_analisis.Transporte = Depends(modelo_analisis.transporte_por_defecto),  # noqa: B008
) -> JSONResponse:
    """Análisis de UN guion contra el Brief aprobado (Fase 7, REPORTE B §2).

    Sin estado y sin autoridad: Node arma los mensajes (sobres no confiables) y
    valida/persiste; aquí solo hay kill-switch, contrato estricto, una llamada JSON
    al proveedor (más UN reintento por JSON roto) y validación de FORMA. No guarda
    nada y no registra contenido. Ver `app/modelo_analisis.py`.
    """
    inicio = time.monotonic()
    req: modelo_analisis.AnalisisEntrada | None = None
    seguimiento = modelo_analisis.Seguimiento()
    try:
        if not modelo_turno.ia_activa():
            raise modelo_analisis.AnalisisError("AI_DISABLED")
        declarado = request.headers.get("content-length")
        if declarado is not None and declarado.isdigit() and int(declarado) > modelo_turno.MAX_BYTES_CUERPO:
            raise modelo_analisis.AnalisisError(
                "REQUEST_INVALID",
                status=413,
                details={"limit_bytes": modelo_turno.MAX_BYTES_CUERPO},
                message="El cuerpo de la petición excede el tamaño máximo.",
            )
        try:
            cuerpo = await _leer_cuerpo_acotado(request)
        except modelo_turno.TurnoError as e:
            raise modelo_analisis.AnalisisError(
                e.code, status=e.status, details=e.details, message=e.message
            ) from None
        req = modelo_analisis.parsear_entrada(cuerpo)
        salida = await asyncio.wait_for(
            run_in_threadpool(modelo_analisis.ejecutar_analisis, req, transporte, seguimiento),
            timeout=req.timeout_s + modelo_turno.MARGEN_DEADLINE_S,
        )
        respuesta = JSONResponse(salida)
    except asyncio.TimeoutError:  # noqa: UP041
        return _error_de_analisis(
            req,
            modelo_analisis.AnalisisError("MODEL_TIMEOUT", llamadas=seguimiento.llamadas_para_error()),
            inicio,
        )
    except modelo_analisis.AnalisisError as error:
        return _error_de_analisis(req, error, inicio)
    except ValueError:
        return _error_de_analisis(
            req,
            modelo_analisis.AnalisisError(
                "MODEL_BAD_RESPONSE",
                details={"reason": "respuesta no serializable"},
                llamadas=seguimiento.llamadas_para_error(),
            ),
            inicio,
        )
    except Exception as exc:  # noqa: BLE001
        logger.error("modelo_analisis error inesperado tipo=%s", type(exc).__name__)
        return _error_de_analisis(
            req,
            modelo_analisis.AnalisisError("INTERNAL_ERROR", llamadas=seguimiento.llamadas_para_error()),
            inicio,
        )

    modelo_analisis.registrar_metadatos(
        req, resultado="ok", salida=salida, duracion_ms=int((time.monotonic() - inicio) * 1000)
    )
    return respuesta


def _error_de_analisis(
    req: modelo_analisis.AnalisisEntrada | None, error: modelo_analisis.AnalisisError, inicio: float
) -> JSONResponse:
    modelo_analisis.registrar_metadatos(
        req, resultado=error.code, error=error, duracion_ms=int((time.monotonic() - inicio) * 1000)
    )
    cabeceras = {"Retry-After": str(error.retry_after_s)} if error.retry_after_s is not None else None
    return JSONResponse(error.cuerpo(), status_code=error.status, headers=cabeceras)


@app.get("/ready")
async def ready() -> dict[str, object]:
    """Listo para recibir trabajo, con estado de cada dependencia."""
    settings = get_settings()
    return {
        "status": "ready",
        "environment": settings.environment,
        "ai_enabled": settings.ai_enabled,
        # Nunca la clave: solo qué adaptador está activo. Lo necesita
        # `extraction.test.ts` para no confundir el proveedor falso (solo de
        # pruebas) con uno real al decidir si corre su prueba de costo real.
        "ai_provider": settings.ai_provider,
        "supported_formats": sorted(parsers.tipos_soportados()),
        "max_upload_mb": settings.max_upload_mb,
    }
