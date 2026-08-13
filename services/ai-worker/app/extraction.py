"""Extracción estructurada de campos del brief (E5-3, E5-4, E5-5, E5-6).

Qué hace
--------
Toma los fragmentos de las fuentes de una campaña y produce campos del brief con
tres desenlaces posibles, y solo tres (§9.4):

    found      el dato está en las fuentes, y se dice dónde
    not_found  el dato no está — y **no** se completa con conocimiento general
    conflict   dos fuentes dicen cosas distintas, y se muestran las dos

La regla que sostiene todo lo demás
-----------------------------------
Un modelo puede citar un `fragmentId` que existe y **inventarse la cita**. Es el
fallo más difícil de detectar a ojo, porque el resultado se ve perfectamente
bien: hay una fuente, hay un número de diapositiva, hay comillas.

Por eso aquí ninguna evidencia se cree por declararse: **la cita se busca
literalmente en el texto del fragmento**, y la que no aparece se descarta. Si un
campo se queda sin evidencia válida y la necesitaba, el campo entero baja a
`not_found`. Es preferible un hueco declarado a un respaldo que nadie verificó.

Lo que este módulo no hace
--------------------------
No aprueba nada (ADR-002), no decide permisos (ADR-008) y no persiste una
versión aprobable: entrega campos en estado `draft` para que una persona los
confirme (§9.2, columna Control).
"""

from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence

from . import brief_schema
from .ai import openrouter, registro
from .ai.router import resolver

logger = logging.getLogger("ai-worker.extraccion")

#: Versión del prompt. Cambia con cada ajuste de instrucciones, para poder
#: atribuir una regresión del gold set a un cambio concreto.
VERSION_PROMPT = "extraccion-1"

TAREA = "extraer_campos"

#: Tope de fragmentos por llamada. Con más, el modelo empieza a perder
#: fragmentos del medio y las citas se degradan antes que la exactitud.
MAX_FRAGMENTOS = 60

#: Recorte por fragmento. Los fragmentos largos se truncan por el final; el
#: encabezado y las primeras líneas son lo que identifica de qué habla.
MAX_CARACTERES_FRAGMENTO = 2000

_ESTADOS = {"found", "not_found", "conflict"}


class ExtraccionInvalida(RuntimeError):
    """El modelo devolvió algo que no cumple el contrato. No se persiste (E5-3)."""


@dataclass(frozen=True)
class FragmentoDeEntrada:
    id: str
    source_id: str
    filename: str
    texto: str
    page: Optional[int] = None
    slide: Optional[int] = None
    section: Optional[str] = None
    linea: Optional[int] = None

    def localizador(self) -> str:
        """El localizador que corresponda al formato (DEC-018)."""
        if self.slide is not None:
            return f"diapositiva {self.slide}"
        if self.section:
            return f"sección «{self.section}»" + (f", línea {self.linea}" if self.linea else "")
        if self.page is not None:
            return f"página {self.page}"
        return "sin localizador"


@dataclass(frozen=True)
class EvidenciaExtraida:
    fragment_id: str
    source_id: str
    quote: str
    relation: str  # soporta | contradice | contexto


@dataclass
class CampoExtraido:
    key: str
    value: Optional[str]
    status: str
    criticidad: str
    confidence: Optional[float] = None
    evidence: List[EvidenciaExtraida] = field(default_factory=list)
    #: Por qué el campo terminó como terminó, cuando no es obvio.
    nota: Optional[str] = None


@dataclass
class ResultadoExtraccion:
    campos: List[CampoExtraido]
    descartes: List[str]
    modelo: str
    nivel: str
    costo_usd: float
    latencia_ms: int
    #: Metadatos de la ejecución. Viajan con el resultado para que quien sí
    #: conoce la organización —la capa de dominio— pueda dejar el `AIRun` con
    #: su costo real. El worker no puede: no sabe de quién es la campaña.
    input_hash: str = ""
    prompt_tokens: int = 0
    completion_tokens: int = 0
    generation_id: Optional[str] = None

    def por_estado(self) -> Dict[str, int]:
        conteo: Dict[str, int] = {}
        for c in self.campos:
            conteo[c.status] = conteo.get(c.status, 0) + 1
        return conteo


# ───────────────────────────── Normalización ──────────────────────────────────


def _normalizar(texto: str) -> str:
    """Deja el texto comparable sin volverlo permisivo.

    Se unifican espacios y comillas —un modelo reescribe «"» como «"» sin
    querer— y se baja a minúsculas. Lo que **no** se toca son las palabras: una
    cita que cambia una palabra deja de ser una cita.
    """
    t = texto.replace("“", '"').replace("”", '"')
    t = t.replace("‘", "'").replace("’", "'")
    t = t.replace("–", "-").replace("—", "-").replace(" ", " ")
    return re.sub(r"\s+", " ", t).strip().lower()


# ────────────────────────────────── Prompt ────────────────────────────────────


def _instrucciones(campos: Sequence[brief_schema.CampoDelBrief]) -> str:
    lineas = [
        "Eres un asistente que extrae campos de un brief publicitario a partir de "
        "documentos de campaña. No redactas el brief: solo localizas datos.",
        "",
        "REGLAS ABSOLUTAS:",
        "1. Solo puedes usar lo que está en los FRAGMENTOS. Nada de conocimiento previo.",
        "2. Si un dato no aparece, devuelve status \"not_found\" y value null. "
        "NUNCA lo completes con lo que suele ser cierto.",
        "3. Si dos fragmentos se contradicen, devuelve status \"conflict\", value null, "
        "y una evidencia por cada fragmento en desacuerdo.",
        "4. Cada evidencia debe llevar una cita LITERAL, copiada carácter por carácter "
        "del fragmento. Las citas se verifican contra el texto original: una cita "
        "reescrita o resumida se descarta y el campo se pierde.",
        "5. No inventes fragment_id. Usa exactamente los que aparecen abajo.",
        "",
        "CAMPOS A EXTRAER (usa la clave exacta):",
    ]
    for c in campos:
        marca = {"critico": " [CRÍTICO]", "claim": " [CLAIM — exige evidencia]"}.get(
            c.criticidad, ""
        )
        desc = f" — {c.descripcion}" if c.descripcion else ""
        lineas.append(f"  {c.key}{marca}{desc}")

    lineas += [
        "",
        "FORMATO DE SALIDA — JSON, sin texto alrededor, sin bloques de código:",
        json.dumps(
            {
                "campos": [
                    {
                        "key": "objetivo.negocio",
                        "value": "Aumentar la participación en el segmento medio-alto",
                        "status": "found",
                        "confidence": 0.9,
                        "evidence": [
                            {
                                "fragment_id": "<uno de los de arriba>",
                                "quote": "cita literal tomada del fragmento",
                                "relation": "soporta",
                            }
                        ],
                    },
                    {
                        "key": "contexto.situacion",
                        "value": None,
                        "status": "conflict",
                        "confidence": None,
                        "evidence": [
                            {
                                "fragment_id": "<fragmento 1>",
                                "quote": "cita literal de la primera fuente",
                                "relation": "soporta",
                            },
                            {
                                "fragment_id": "<fragmento 2>",
                                "quote": "cita literal de la fuente que la contradice",
                                "relation": "contradice",
                            },
                        ],
                    },
                ]
            },
            ensure_ascii=False,
        ),
        "",
        "Devuelve SOLO los campos que encuentres en los fragmentos, o los que estén "
        "en conflicto. Los que no incluyas se toman como no encontrados, que es "
        "el resultado correcto cuando el dato no está. No hace falta que los "
        "listes uno por uno.",
    ]
    return "\n".join(lineas)


def _bloque_de_fragmentos(fragmentos: Sequence[FragmentoDeEntrada]) -> str:
    partes = ["FRAGMENTOS:", ""]
    for f in fragmentos:
        texto = f.texto[:MAX_CARACTERES_FRAGMENTO]
        if len(f.texto) > MAX_CARACTERES_FRAGMENTO:
            texto += " […]"
        partes.append(f"[{f.id}] {f.filename} · {f.localizador()}")
        partes.append(texto)
        partes.append("")
    return "\n".join(partes)


# ──────────────────────────── Validación de salida ────────────────────────────


def _parsear_json(bruto: str) -> Any:
    """Acepta JSON limpio o envuelto en un bloque de código."""
    texto = bruto.strip()
    if texto.startswith("```"):
        texto = re.sub(r"^```[a-zA-Z]*\s*", "", texto)
        texto = re.sub(r"\s*```$", "", texto)
    try:
        return json.loads(texto)
    except json.JSONDecodeError as exc:
        # Último recurso: el objeto más externo dentro de la respuesta.
        inicio, fin = texto.find("{"), texto.rfind("}")
        if inicio >= 0 and fin > inicio:
            try:
                return json.loads(texto[inicio : fin + 1])
            except json.JSONDecodeError:
                pass
        if "Unterminated" in str(exc) or "Expecting" in str(exc):
            raise ExtraccionInvalida(
                "La respuesta quedó cortada a mitad de camino "
                f"({len(texto)} caracteres). Suele ser el tope de max_tokens: {exc}"
            ) from exc
        raise ExtraccionInvalida(f"La respuesta no es JSON válido: {exc}") from exc


def validar_y_anclar(
    bruto: str,
    fragmentos: Sequence[FragmentoDeEntrada],
) -> tuple[List[CampoExtraido], List[str]]:
    """Convierte la respuesta del modelo en campos verificados.

    Devuelve los campos y la lista de descartes, que es lo que hay que mirar
    cuando la calidad baja: dice **qué** se rechazó y por qué.
    """
    datos = _parsear_json(bruto)
    if not isinstance(datos, dict) or not isinstance(datos.get("campos"), list):
        raise ExtraccionInvalida("Se esperaba un objeto con la lista 'campos'.")

    por_id = {f.id: f for f in fragmentos}
    normalizados = {f.id: _normalizar(f.texto) for f in fragmentos}
    validas = brief_schema.claves_validas()

    campos: List[CampoExtraido] = []
    descartes: List[str] = []
    vistas: set[str] = set()

    for cruda in datos["campos"]:
        if not isinstance(cruda, dict):
            descartes.append("Una entrada no era un objeto.")
            continue

        key = str(cruda.get("key", "")).strip()
        if key not in validas:
            descartes.append(f"Clave desconocida, fuera del esquema: «{key}».")
            continue
        if key in vistas:
            descartes.append(f"Clave repetida: «{key}».")
            continue
        vistas.add(key)

        status = str(cruda.get("status", "")).strip()
        if status not in _ESTADOS:
            descartes.append(f"{key}: estado inválido «{status}».")
            continue

        spec = brief_schema.campo(key)
        criticidad = spec.criticidad if spec else "informativo"
        valor = cruda.get("value")
        valor = None if valor is None else str(valor).strip() or None

        evidencias, rechazadas = _verificar_citas(
            key, cruda.get("evidence", []), por_id, normalizados
        )
        descartes.extend(rechazadas)

        campo = CampoExtraido(
            key=key,
            value=valor,
            status=status,
            criticidad=criticidad,
            confidence=_confianza(cruda.get("confidence")),
            evidence=evidencias,
        )

        _aplicar_reglas(campo, descartes)
        campos.append(campo)

    faltantes = validas - vistas
    for key in sorted(faltantes):
        # Un campo que el modelo omitió no es un campo encontrado. Se declara
        # ausente explícitamente: el hueco tiene que ser visible.
        spec = brief_schema.campo(key)
        campos.append(
            CampoExtraido(
                key=key,
                value=None,
                status="not_found",
                criticidad=spec.criticidad if spec else "informativo",
                nota="El modelo no devolvió este campo; se declara ausente.",
            )
        )

    return campos, descartes


def _confianza(valor: Any) -> Optional[float]:
    if valor is None:
        return None
    try:
        n = float(valor)
    except (TypeError, ValueError):
        return None
    return min(max(n, 0.0), 1.0)


def _verificar_citas(
    key: str,
    crudas: Any,
    por_id: Dict[str, FragmentoDeEntrada],
    normalizados: Dict[str, str],
) -> tuple[List[EvidenciaExtraida], List[str]]:
    """Conserva solo las evidencias cuya cita aparece de verdad en su fragmento."""
    buenas: List[EvidenciaExtraida] = []
    descartes: List[str] = []

    if not isinstance(crudas, list):
        return buenas, [f"{key}: el campo 'evidence' no era una lista."]

    for cruda in crudas:
        if not isinstance(cruda, dict):
            descartes.append(f"{key}: una evidencia no era un objeto.")
            continue

        fid = str(cruda.get("fragment_id", "")).strip()
        cita = str(cruda.get("quote", "")).strip()
        relacion = str(cruda.get("relation", "soporta")).strip() or "soporta"

        if fid not in por_id:
            descartes.append(f"{key}: fragment_id inexistente «{fid[:40]}».")
            continue
        if not cita:
            descartes.append(f"{key}: evidencia sin cita.")
            continue
        if relacion not in {"soporta", "contradice", "contexto"}:
            relacion = "soporta"

        if _normalizar(cita) not in normalizados[fid]:
            # El fallo que esta función existe para atrapar.
            descartes.append(
                f"{key}: la cita no aparece en el fragmento citado — «{cita[:60]}…»."
            )
            continue

        buenas.append(
            EvidenciaExtraida(
                fragment_id=fid,
                source_id=por_id[fid].source_id,
                quote=cita,
                relation=relacion,
            )
        )

    return buenas, descartes


def _aplicar_reglas(campo: CampoExtraido, descartes: List[str]) -> None:
    """Impone §9.4 sobre el campo ya verificado. El modelo propone; esto dispone."""
    spec = brief_schema.campo(campo.key)
    exige = spec.exige_evidencia if spec else False

    if campo.status == "not_found":
        campo.value = None
        campo.confidence = None
        campo.evidence = []
        return

    if campo.status == "conflict":
        campo.value = None
        if len(campo.evidence) < 2:
            # Un conflicto con una sola evidencia no es un conflicto: es una
            # afirmación. Sin las dos partes, no hay nada que comparar.
            descartes.append(
                f"{campo.key}: se declaró conflicto con {len(campo.evidence)} evidencia(s) "
                "verificada(s); hacen falta dos. Baja a not_found."
            )
            campo.status = "not_found"
            campo.evidence = []
            campo.nota = "Conflicto declarado sin las dos fuentes que lo sustentan."
        return

    # status == 'found'
    if campo.value is None:
        campo.status = "not_found"
        campo.nota = "Se declaró encontrado sin valor."
        return

    if exige and not campo.evidence:
        # §15: un claim o un campo crítico sin respaldo verificable no entra.
        descartes.append(
            f"{campo.key}: es {spec.criticidad if spec else 'crítico'} y quedó sin "
            "evidencia verificable. Baja a not_found."
        )
        campo.status = "not_found"
        campo.value = None
        campo.confidence = None
        campo.nota = "Sin evidencia verificable en las fuentes."


# ──────────────────────────────── Ejecución ───────────────────────────────────


def extraer(
    fragmentos: Sequence[FragmentoDeEntrada],
    *,
    conn: Any = None,
    organization_id: Optional[str] = None,
    campaign_id: Optional[str] = None,
    brief_version_id: Optional[str] = None,
) -> ResultadoExtraccion:
    """Extrae los campos del brief a partir de los fragmentos dados.

    Si se pasa `conn`, deja el registro de la ejecución en `ai_runs` con su
    costo real. No confirma la transacción.
    """
    if not fragmentos:
        raise ValueError("No hay fragmentos de los que extraer.")

    usados = list(fragmentos[:MAX_FRAGMENTOS])
    campos_pedidos = brief_schema.campos_extraibles()
    destino = resolver(TAREA)

    prompt = _instrucciones(campos_pedidos) + "\n\n" + _bloque_de_fragmentos(usados)
    huella = registro.hash_de_entrada([VERSION_PROMPT, *(f.texto for f in usados)])
    comenzo = time.monotonic()

    try:
        respuesta = openrouter.completar(
            destino.modelo,
            [{"role": "user", "content": prompt}],
            temperatura=0,
            max_tokens=16000,
            formato_json=True,
        )
    except Exception as exc:  # noqa: BLE001
        if conn is not None and organization_id:
            registro.registrar_ejecucion(
                conn,
                organization_id=organization_id,
                campaign_id=campaign_id,
                brief_version_id=brief_version_id,
                task=TAREA,
                tier=destino.nivel,
                model=destino.modelo,
                prompt_version=VERSION_PROMPT,
                input_hash=huella,
                output_status="error",
                latency_ms=int((time.monotonic() - comenzo) * 1000),
                error=f"{type(exc).__name__}: {exc}"[:500],
            )
        raise

    latencia = int((time.monotonic() - comenzo) * 1000)

    try:
        campos, descartes = validar_y_anclar(respuesta.contenido, usados)
        estado_salida = "ok" if not descartes else "ok_con_descartes"
    except ExtraccionInvalida:
        estado_salida = "invalido"
        if conn is not None and organization_id:
            registro.registrar_ejecucion(
                conn,
                organization_id=organization_id,
                campaign_id=campaign_id,
                brief_version_id=brief_version_id,
                task=TAREA,
                tier=destino.nivel,
                model=destino.modelo,
                prompt_version=VERSION_PROMPT,
                input_hash=huella,
                output_status=estado_salida,
                latency_ms=latencia,
                prompt_tokens=respuesta.uso.prompt_tokens,
                completion_tokens=respuesta.uso.completion_tokens,
                cost_usd=respuesta.uso.costo_usd,
                generation_id=respuesta.generacion_id,
                error="La salida no cumple el contrato de extracción.",
            )
        raise

    if conn is not None and organization_id:
        registro.registrar_ejecucion(
            conn,
            organization_id=organization_id,
            campaign_id=campaign_id,
            brief_version_id=brief_version_id,
            task=TAREA,
            tier=destino.nivel,
            model=destino.modelo,
            prompt_version=VERSION_PROMPT,
            input_hash=huella,
            output_status=estado_salida,
            latency_ms=latencia,
            prompt_tokens=respuesta.uso.prompt_tokens,
            completion_tokens=respuesta.uso.completion_tokens,
            cost_usd=respuesta.uso.costo_usd,
            generation_id=respuesta.generacion_id,
        )

    if descartes:
        logger.info("Extracción con %d descarte(s):", len(descartes))
        for d in descartes[:10]:
            logger.info("  · %s", d)

    return ResultadoExtraccion(
        campos=campos,
        descartes=descartes,
        modelo=destino.modelo,
        nivel=destino.nivel,
        costo_usd=respuesta.uso.costo_usd or 0.0,
        latencia_ms=latencia,
        input_hash=huella,
        prompt_tokens=respuesta.uso.prompt_tokens,
        completion_tokens=respuesta.uso.completion_tokens,
        generation_id=respuesta.generacion_id,
    )
