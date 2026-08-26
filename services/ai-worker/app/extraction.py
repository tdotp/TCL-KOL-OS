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

import calendar
import json
import logging
import re
import time
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

from . import brief_schema
from .ai import provider, registro
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

#: Cómo se le explica al modelo la forma que admite cada campo.
#:
#: El esquema no acepta texto en todos lados, y callarlo no lo vuelve tolerante:
#: solo mueve el rechazo a más adelante, cuando alguien ensamble el brief y ya
#: no se sepa de dónde salió el valor.
_FORMA_EN_PALABRAS = {
    "lista": 'una lista JSON de textos, p. ej. ["uno", "dos"] — no un texto con comas',
    "lista_objetos": (
        'una lista JSON de objetos {"categoria": ..., "descripcion": ...}, donde categoria '
        "es uno de: mensaje, producto, identidad, legal, canales, timing, negocio"
    ),
    "fecha": (
        "copie la fecha TAL COMO la escribe la fuente. Si es un día exacto, "
        'formato AAAA-MM-DD. Si la fuente solo da un mes o un rango '
        '("septiembre 2026", "octubre-noviembre 2026"), copie ese texto tal '
        "cual — NO invente un día. La precisión exacta o imprecisa se decide "
        "después, a partir de lo que usted haya copiado literalmente (DEC-026)"
    ),
}


class ExtraccionInvalida(RuntimeError):
    """El modelo devolvió algo que no cumple el contrato. No se persiste (E5-3)."""


@dataclass(frozen=True)
class FragmentoDeEntrada:
    id: str
    source_id: str
    filename: str
    texto: str
    page: int | None = None
    slide: int | None = None
    section: str | None = None
    linea: int | None = None

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
class ProductoDeEntrada:
    """Un producto válido de la campaña (DEC-016). El worker nunca inventa uno."""

    id: str
    nombre_producto: str


@dataclass(frozen=True)
class EvidenciaExtraida:
    fragment_id: str
    source_id: str
    quote: str
    relation: str  # soporta | contradice | contexto


@dataclass
class CampoExtraido:
    key: str
    #: Texto, lista de textos, fecha con precisión (DEC-026) o lista de objetos.
    value: Any
    status: str
    criticidad: str
    confidence: float | None = None
    evidence: list[EvidenciaExtraida] = field(default_factory=list)
    #: Por qué el campo terminó como terminó, cuando no es obvio.
    nota: str | None = None
    #: A qué producto de la campaña pertenece (DEC-016/DEC-023). `None` para
    #: campos de campaña o compartidos. Nunca lo inventa el worker: siempre es
    #: uno de los ids que llegaron en `productos`.
    producto_id: str | None = None


@dataclass
class ResultadoExtraccion:
    campos: list[CampoExtraido]
    descartes: list[str]
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
    generation_id: str | None = None

    def por_estado(self) -> dict[str, int]:
        conteo: dict[str, int] = {}
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


def _instrucciones(
    campos: Sequence[brief_schema.CampoDelBrief],
    productos: Sequence[ProductoDeEntrada] = (),
) -> str:
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
        "6. 'mandatorios' y 'practico.restricciones' NO son lo mismo aunque hablen de "
        "límites (DEC-025). 'mandatorios' son cosas que la campaña DEBE incluir o "
        "ejecutar (logo, hashtag, mención obligatoria, demostración de producto). "
        "'practico.restricciones' son límites, prohibiciones o condiciones operativas "
        "o legales — lo que NO se puede hacer, o una condición del canal. Ejemplo: "
        "«único canal de venta: Alkosto» es una restricción, no un mandatorio.",
        "",
    ]

    if len(productos) > 0:
        lineas += [
            "PRODUCTOS DE ESTA CAMPAÑA (use exactamente estos ids, nunca invente uno "
            "ni mezcle datos de un producto en la entrada de otro — DEC-016):",
            "",
        ]
        for p in productos:
            lineas.append(f"  [{p.id}] {p.nombre_producto}")
        lineas += [
            "",
            "Para los campos marcados [POR PRODUCTO] más abajo, devuelva UNA ENTRADA "
            "POR CADA PRODUCTO de la lista de arriba, con \"producto_id\" igual a uno "
            "de esos ids exactos. No devuelva una sola entrada compartida para todos.",
            "",
        ]

    lineas.append("CAMPOS A EXTRAER (usa la clave exacta):")
    for c in campos:
        marca = {"critico": " [CRÍTICO]", "claim": " [CLAIM — exige evidencia]"}.get(
            c.criticidad, ""
        )
        if c.por_producto and len(productos) > 0:
            marca += " [POR PRODUCTO]"
        lineas.append(f"  {c.key}{marca}")
        if c.descripcion:
            lineas.append(f"      {c.descripcion}")
        if c.valores:
            # Sin esto el campo es inadivinable: el modelo no puede acertar una
            # lista cerrada que nunca vio.
            lineas.append(f"      Valores permitidos (use exactamente uno): {', '.join(c.valores)}")
        forma = _FORMA_EN_PALABRAS.get(c.forma)
        if forma:
            lineas.append(f"      Formato de value: {forma}")

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
    if len(productos) > 0:
        lineas.append(
            'Para un campo marcado [POR PRODUCTO], cada entrada de "campos" lleva '
            'además "producto_id" con uno de los ids de PRODUCTOS. Para los demás '
            'campos, omita "producto_id" o déjelo en null.'
        )
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


#: Por debajo de esto no hay una extracción posible, ni siquiera vacía.
_MINIMO_RAZONABLE = 12


def _parsear_json(bruto: str) -> Any:
    """Acepta JSON limpio o envuelto en un bloque de código."""
    texto = bruto.strip()

    if len(texto) < _MINIMO_RAZONABLE:
        # Una respuesta de dos caracteres no es un JSON cortado por el tope de
        # tokens: es el proveedor devolviendo nada. Se distingue porque el
        # remedio es opuesto —reintentar, no agrandar el presupuesto—, y un
        # mensaje que culpa a max_tokens manda a quien lo lea al sitio
        # equivocado.
        raise ExtraccionInvalida(
            f"El proveedor devolvió una respuesta vacía o casi vacía "
            f"({len(texto)} caracteres). Suele ser un fallo transitorio: reintente."
        )
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
    productos: Sequence[ProductoDeEntrada] = (),
) -> tuple[list[CampoExtraido], list[str]]:
    """Convierte la respuesta del modelo en campos verificados.

    Devuelve los campos y la lista de descartes, que es lo que hay que mirar
    cuando la calidad baja: dice **qué** se rechazó y por qué.

    Con más de un producto en la campaña, un campo de nivel `producto`
    (`marca_producto[].*`) se identifica por `(key, producto_id)`, no solo por
    `key`: así P80, P80 Pro y P80 Ultra pueden tener cada uno su propia fila
    para `rtbs` en la misma extracción, sin pisarse (DEC-016/DEC-023).
    """
    datos = _parsear_json(bruto)
    if not isinstance(datos, dict) or not isinstance(datos.get("campos"), list):
        raise ExtraccionInvalida("Se esperaba un objeto con la lista 'campos'.")

    por_id = {f.id: f for f in fragmentos}
    normalizados = {f.id: _normalizar(f.texto) for f in fragmentos}
    validas = brief_schema.claves_validas()
    ids_producto_validos = {p.id for p in productos}
    hay_productos = len(productos) > 0

    campos: list[CampoExtraido] = []
    descartes: list[str] = []
    vistas: set[tuple[str, str | None]] = set()

    for cruda in datos["campos"]:
        if not isinstance(cruda, dict):
            descartes.append("Una entrada no era un objeto.")
            continue

        key = str(cruda.get("key", "")).strip()
        if key not in validas:
            descartes.append(f"Clave desconocida, fuera del esquema: «{key}».")
            continue

        spec = brief_schema.campo(key)
        criticidad = spec.criticidad if spec else "informativo"

        producto_id_bruto = cruda.get("producto_id")
        producto_id = str(producto_id_bruto).strip() if producto_id_bruto else None

        if spec is not None and spec.por_producto and hay_productos:
            if producto_id is None:
                descartes.append(f"{key}: es un campo por producto y no trajo producto_id.")
                continue
            if producto_id not in ids_producto_validos:
                # Nunca se acepta un producto que no estaba en la lista dada — el
                # worker no filtra por permisos, pero tampoco inventa productos.
                descartes.append(
                    f"{key}: producto_id «{producto_id}» no está entre los productos "
                    "de la campaña. Se descarta esta entrada."
                )
                continue
        else:
            # Campo de campaña o compartido: nunca lleva producto_id, aunque el
            # modelo lo haya puesto (§DEC-023 — NULL es la marca de "compartido").
            producto_id = None

        clave_vista = (key, producto_id)
        if clave_vista in vistas:
            sufijo = f" para el producto {producto_id}." if producto_id else "."
            descartes.append(f"{key}: entrada repetida{sufijo}")
            continue
        vistas.add(clave_vista)

        status = str(cruda.get("status", "")).strip()
        if status not in _ESTADOS:
            descartes.append(f"{key}: estado inválido «{status}».")
            continue

        valor, motivo = _normalizar_valor(cruda.get("value"), spec)
        if motivo is not None:
            descartes.append(f"{key}: {motivo}")
            status = "not_found"

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
            producto_id=producto_id,
        )

        _aplicar_reglas(campo, descartes)
        campos.append(campo)

    # Huecos explícitos: un campo que el modelo omitió no es un campo
    # encontrado. Para campos de nivel `producto` con más de un producto, el
    # hueco se declara por cada producto que no recibió entrada — así ningún
    # producto queda huérfano en silencio.
    for key in sorted(validas):
        spec = brief_schema.campo(key)
        criticidad = spec.criticidad if spec else "informativo"

        if spec is not None and spec.por_producto and hay_productos:
            for p in productos:
                if (key, p.id) in vistas:
                    continue
                campos.append(
                    CampoExtraido(
                        key=key,
                        value=None,
                        status="not_found",
                        criticidad=criticidad,
                        nota="El modelo no devolvió este campo para este producto; se declara ausente.",
                        producto_id=p.id,
                    )
                )
            continue

        if (key, None) in vistas:
            continue
        campos.append(
            CampoExtraido(
                key=key,
                value=None,
                status="not_found",
                criticidad=criticidad,
                nota="El modelo no devolvió este campo; se declara ausente.",
            )
        )

    return campos, descartes


_FECHA_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}$")

_CATEGORIAS_MANDATORIO = {
    "mensaje",
    "producto",
    "identidad",
    "legal",
    "canales",
    "timing",
    "negocio",
}


def _normalizar_valor(
    bruto: Any, spec: brief_schema.CampoDelBrief | None
) -> tuple[Any, str | None]:
    """Ajusta el valor a la forma que admite el esquema, o lo rechaza.

    Devuelve `(valor, motivo_de_rechazo)`. Un motivo no nulo significa que el
    campo baja a `not_found`: un valor con la forma equivocada no es un valor
    aproximado que ya se arreglará, es uno que el esquema va a rechazar más
    adelante, cuando nadie recuerde de dónde salió.
    """
    if bruto is None:
        return None, None

    forma = spec.forma if spec else "texto"

    if forma == "lista":
        if isinstance(bruto, list):
            elementos = [str(x).strip() for x in bruto if str(x).strip()]
            return (elementos or None), None
        # Un texto suelto donde va una lista es recuperable: es una lista de uno.
        texto = str(bruto).strip()
        return ([texto] if texto else None), None

    if forma == "lista_objetos":
        if not isinstance(bruto, list):
            return None, "se esperaba una lista de objetos y llegó texto suelto."
        limpios = []
        for item in bruto:
            if not isinstance(item, dict):
                continue
            categoria = str(item.get("categoria", "")).strip().lower()
            descripcion = str(item.get("descripcion", "")).strip()
            if not descripcion:
                continue
            if categoria not in _CATEGORIAS_MANDATORIO:
                categoria = "negocio"  # cajón declarado del esquema, no inventado
            limpios.append({"categoria": categoria, "descripcion": descripcion})
        if not limpios:
            return None, "ningún elemento tenía la forma {categoria, descripcion}."
        return limpios, None

    if forma == "fecha":
        texto = str(bruto).strip()
        precisada = _precisar_fecha(texto)
        if precisada is None:
            return None, (
                f"«{texto[:40]}» no se reconoce como fecha exacta, mes o rango (DEC-026)."
            )
        return precisada, None

    if forma == "enum" and spec is not None:
        texto = str(bruto).strip().lower()
        if texto in spec.valores:
            return texto, None
        equivalente = next((v for v in spec.valores if v in texto or texto in v), None)
        if equivalente is not None:
            return equivalente, None
        return None, (
            f"«{texto[:40]}» no está entre los valores permitidos "
            f"({', '.join(spec.valores)})."
        )

    texto = str(bruto).strip()
    return (texto or None), None


_MESES = {
    1: ("enero", "ene"), 2: ("febrero", "feb"), 3: ("marzo", "mar"),
    4: ("abril", "abr"), 5: ("mayo", "may"), 6: ("junio", "jun"),
    7: ("julio", "jul"), 8: ("agosto", "ago"), 9: ("septiembre", "sep", "setiembre"),
    10: ("octubre", "oct"), 11: ("noviembre", "nov"), 12: ("diciembre", "dic"),
}


def _mes_por_nombre(nombre: str) -> int | None:
    nombre = nombre.strip().lower()
    for mes, nombres in _MESES.items():
        if nombre in nombres:
            return mes
    return None


def _precisar_fecha(texto: str) -> dict[str, Any] | None:
    """Reconoce la precisión real de una fecha copiada tal como llegó (DEC-026).

    No inventa un día cuando la fuente solo da un mes o un rango — al
    contrario del comportamiento anterior, tampoco descarta el campo por
    eso: lo representa con la precisión que sí tiene. Esta función solo
    reconoce la forma; que el texto reconocido esté respaldado por una cita
    real lo comprueba `_aplicar_reglas`, después de verificar las citas.
    """
    limpio = texto.strip()
    if not limpio:
        return None

    if _FECHA_ISO.match(limpio):
        return {"tipo": "exacta", "fecha": limpio, "textoOriginal": limpio}

    normalizado = _normalizar(limpio)

    for mes_i, nombres_i in _MESES.items():
        if not re.search(rf"\b(?:{'|'.join(nombres_i)})\b", normalizado):
            continue

        # Rango: «octubre-noviembre 2026», «octubre a noviembre de 2026».
        m_rango = re.search(
            rf"\b(?:{'|'.join(nombres_i)})\b\s*(?:-|a|hasta)\s*([a-záéíóú]+)\D{{0,10}}(\d{{4}})",
            normalizado,
        )
        if m_rango:
            mes_f = _mes_por_nombre(m_rango.group(1))
            anio = int(m_rango.group(2))
            if mes_f:
                ultimo_dia = calendar.monthrange(anio, mes_f)[1]
                return {
                    "tipo": "rango",
                    "inicio": f"{anio:04d}-{mes_i:02d}-01",
                    "fin": f"{anio:04d}-{mes_f:02d}-{ultimo_dia:02d}",
                    "textoOriginal": limpio,
                }

        # Mes suelto: «septiembre 2026», «sep. 2026».
        m_mes = re.search(rf"\b(?:{'|'.join(nombres_i)})\b\D{{0,4}}(\d{{4}})", normalizado)
        if m_mes:
            return {
                "tipo": "mes",
                "fecha": f"{int(m_mes.group(1)):04d}-{mes_i:02d}",
                "textoOriginal": limpio,
            }

    return None


def _fecha_respaldada_por_citas(
    valor: dict[str, Any], evidencias: Sequence[EvidenciaExtraida]
) -> tuple[bool, str]:
    """¿La precisión declarada de la fecha se desprende de una cita real?

    Cierra el mismo hueco que ya cerraba `_dia_esta_respaldado`, generalizado:
    comprobar que la cita existe no comprueba que el valor se desprenda de
    ella. Para `exacta`, el día concreto debe estar escrito. Para `mes` o
    `rango`, el texto reconocido debe aparecer literalmente en alguna cita —
    el mismo principio que cualquier otra cita de este módulo.
    """
    citas = _normalizar(" ".join(e.quote for e in evidencias))
    if not citas:
        return False, "no hay evidencia verificable para esta fecha."

    if valor.get("tipo") == "exacta":
        if _dia_esta_respaldado(str(valor.get("fecha", "")), evidencias):
            return True, ""
        return False, (
            f"la fecha {valor.get('fecha')} no está escrita en ninguna cita "
            "— el día exacto lo fija una persona."
        )

    texto_original = str(valor.get("textoOriginal", ""))
    if texto_original and _normalizar(texto_original) in citas:
        return True, ""
    return False, f"«{texto_original[:40]}» no aparece en ninguna cita verificada."


def _dia_esta_respaldado(fecha: str, evidencias: Sequence[EvidenciaExtraida]) -> bool:
    """¿El día concreto de esta fecha aparece en alguna cita?

    Cierra el hueco que dejaba la verificación de citas: comprobar que la cita
    existe no comprueba que el valor **se desprenda** de ella. Un modelo puede
    citar «Sostenimiento: Octubre-Noviembre 2026» —literal y verificable— y
    devolver `2026-11-30`, inventando un día que nadie escribió. La cita pasa;
    el dato es falso.

    Para texto libre esto no se puede decidir sin un juicio. Para una fecha sí:
    o el día está escrito en alguna cita, o se lo sacó de la manga.
    """
    try:
        anio, mes, dia = (int(x) for x in fecha.split("-"))
    except ValueError:
        return False

    citas = _normalizar(" ".join(e.quote for e in evidencias))
    if not citas:
        return False

    if _normalizar(fecha) in citas:
        return True

    # «4 de septiembre 2026», «20 sep 2026», «04/09/2026»…
    nombres = _MESES.get(mes, ())
    patrones = [
        rf"\b{dia}\b\D{{0,12}}(?:{'|'.join(nombres)})" if nombres else "",
        rf"(?:{'|'.join(nombres)})\D{{0,12}}\b{dia}\b" if nombres else "",
        rf"\b{dia:02d}[/-]{mes:02d}[/-]{anio}\b",
        rf"\b{dia}[/-]{mes}[/-]{anio}\b",
    ]
    return any(p and re.search(p, citas) for p in patrones)


def _confianza(valor: Any) -> float | None:
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
    por_id: dict[str, FragmentoDeEntrada],
    normalizados: dict[str, str],
) -> tuple[list[EvidenciaExtraida], list[str]]:
    """Conserva solo las evidencias cuya cita aparece de verdad en su fragmento."""
    buenas: list[EvidenciaExtraida] = []
    descartes: list[str] = []

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


def _aplicar_reglas(campo: CampoExtraido, descartes: list[str]) -> None:
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

    if spec is not None and spec.forma == "fecha" and isinstance(campo.value, dict):
        respaldada, motivo_fecha = _fecha_respaldada_por_citas(campo.value, campo.evidence)
        if not respaldada:
            descartes.append(f"{campo.key}: {motivo_fecha}")
            campo.status = "not_found"
            campo.value = None
            campo.confidence = None
            campo.nota = motivo_fecha
            return
        if campo.value.get("tipo") != "exacta":
            # DEC-026: found con precisión real, no un rechazo. La nota queda
            # para que la capa de preguntas locales sepa pedir el día exacto.
            campo.nota = f"Fecha con precisión «{campo.value.get('tipo')}», no exacta."

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


#: Un reintento, no más. Si el segundo también sale roto, el problema no es
#: transitorio y conviene enterarse en vez de seguir pagando llamadas.
_REINTENTOS = 1


def _llamar_con_reintento(
    modelo: str,
    prompt: str,
    fragmentos: Sequence[FragmentoDeEntrada],
    productos: Sequence[ProductoDeEntrada],
) -> tuple[Any, list[CampoExtraido], list[str]]:
    """Llama al modelo y valida; reintenta una vez si la respuesta llega rota.

    Medido contra el proveedor real: de una decena de llamadas identicas, dos
    volvieron con el JSON partido o vacio **y `finish_reason: stop`** — no es el
    tope de tokens ni el prompt, es OpenRouter enrutando a un upstream que
    devolvio un payload incompleto. Sin reintento, esa loteria se convierte en
    "la herramienta a veces no funciona", que es la peor forma de fallar.
    """
    ultimo: ExtraccionInvalida | None = None

    for intento in range(_REINTENTOS + 1):
        respuesta = provider.completar(
            modelo,
            [{"role": "user", "content": prompt}],
            temperatura=0,
            max_tokens=16000,
            formato_json=True,
        )
        try:
            campos, descartes = validar_y_anclar(respuesta.contenido, fragmentos, productos)
            return respuesta, campos, descartes
        except ExtraccionInvalida as exc:
            ultimo = exc
            if intento < _REINTENTOS:
                logger.warning(
                    "Respuesta ilegible del proveedor (%s). Reintento %d de %d.",
                    exc,
                    intento + 1,
                    _REINTENTOS,
                )

    assert ultimo is not None
    raise ultimo


def extraer(
    fragmentos: Sequence[FragmentoDeEntrada],
    *,
    productos: Sequence[ProductoDeEntrada] = (),
    conn: Any = None,
    organization_id: str | None = None,
    campaign_id: str | None = None,
    brief_version_id: str | None = None,
) -> ResultadoExtraccion:
    """Extrae los campos del brief a partir de los fragmentos dados.

    `productos` son los productos válidos de la campaña (DEC-016/3.2 del
    cierre de Sprint 4) — el worker nunca los busca por su cuenta, los recibe
    ya resueltos, igual que los fragmentos (ADR-008).

    Si se pasa `conn`, deja el registro de la ejecución en `ai_runs` con su
    costo real. No confirma la transacción.
    """
    if not fragmentos:
        raise ValueError("No hay fragmentos de los que extraer.")

    usados = list(fragmentos[:MAX_FRAGMENTOS])
    campos_pedidos = brief_schema.campos_extraibles()
    destino = resolver(TAREA)

    prompt = _instrucciones(campos_pedidos, productos) + "\n\n" + _bloque_de_fragmentos(usados)
    huella = registro.hash_de_entrada([VERSION_PROMPT, *(f.texto for f in usados)])
    comenzo = time.monotonic()

    try:
        respuesta, campos, descartes = _llamar_con_reintento(destino.modelo, prompt, usados, productos)
    except Exception as exc:  # noqa: BLE001
        # Todo fallo deja fila, incluido el de contrato. Una extracción que
        # agotó sus reintentos consumió llamadas reales: si no se registra, el
        # gasto existe y el rastro no, y el costo del mes deja de cuadrar.
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
                output_status="invalido" if isinstance(exc, ExtraccionInvalida) else "error",
                latency_ms=int((time.monotonic() - comenzo) * 1000),
                error=f"{type(exc).__name__}: {exc}"[:500],
            )
        raise

    latencia = int((time.monotonic() - comenzo) * 1000)

    estado_salida = "ok" if not descartes else "ok_con_descartes"

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
