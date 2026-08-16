"""Catálogo de campos del brief y su criticidad (apoya E5-3 y E5-4).

De dónde sale cada cosa
-----------------------
La **forma** —qué campos existen y cómo se llaman— sale del JSON Schema de
D0-05, que es la fuente de verdad. Este módulo la lee del archivo; no la copia.

La **criticidad** no está en el esquema, y no es un descuido: es un valor por
instancia, porque el mismo campo puede ser crítico en una campaña e informativo
en otra. Pero la extracción necesita un valor por defecto *antes* de que exista
la instancia, y ahí el esquema no ayuda.

El valor por defecto que se usa aquí es el del ejemplo validado
`brief.example.es.json`, que se aprobó junto con D0-05 en el gate de MVP 0. No
es una invención de este módulo: es la asignación que ya se revisó.

Esa asignación quedó confirmada en DEC-021, que cierra el pendiente de D0-05
§8 —*"¿qué campos exactos son obligatorios para aprobar?"*—.

Nota de un error que costó entender: esos dos campos salieron `not_found` en la
campaña P80 y se leyó como «el cliente no mandó el dato». Era falso. El brief
sí lo traía, y la extracción lo archivaba en otro campo porque este módulo
perdía las descripciones del esquema (DEC-022). **Un `not_found` no prueba que
el dato no exista mientras nadie haya mirado la fuente.**

Sigue siendo un **valor por defecto**, no una constante: `criticidad` es una
columna por campo en `brief_fields`, y una campaña puede subir o bajar la
exigencia de un campo concreto. Lo que esta tabla fija es con qué empieza.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Dict, List, Optional

_RELATIVA = Path("docs") / "product" / "brief-schema" / "brief.schema.json"


def ruta_esquema() -> Path:
    """Dónde está el esquema del brief.

    El worker corre en dos sitios con árboles distintos: en el monorepo, donde
    `docs/` está unos niveles más arriba, y dentro del contenedor, donde solo
    existe `/app` y el esquema llega montado. Por eso la ruta no se calcula
    contando directorios —eso se rompió en cuanto tocó Docker— sino que se
    declara por entorno y, si no, se busca hacia arriba.

    Nunca se copia el archivo al worker: D0-05 es la fuente de verdad, y una
    segunda copia se desactualiza sin que nadie se entere.
    """
    declarada = os.environ.get("BRIEF_SCHEMA_PATH", "").strip()
    if declarada:
        return Path(declarada)

    aqui = Path(__file__).resolve()
    for base in aqui.parents:
        candidata = base / _RELATIVA
        if candidata.is_file():
            return candidata

    raise FileNotFoundError(
        "No se encontró brief.schema.json. Defina BRIEF_SCHEMA_PATH o monte "
        f"{_RELATIVA} en el contenedor."
    )

#: Marcas que identifican a un campo hoja dentro del esquema.
_CLAVES_DE_HOJA = {"value", "status", "provenanceType", "criticidad", "evidence"}

#: Criticidad por defecto (DEC-021). Origen: `brief.example.es.json`, D0-05.
#:
#: `critico`  → sin él el brief no se puede aprobar; su ausencia genera pregunta.
#: `claim`    → afirmación sobre el producto; exige evidencia siempre (§15).
#: `informativo` → todo lo demás (valor implícito, no se lista).
CRITICIDAD_POR_DEFECTO: Dict[str, str] = {
    "contexto.situacion": "critico",
    "objetivo.tipo": "critico",
    "objetivo.negocio": "critico",
    "target_audiencia.descripcion": "critico",
    "marca_producto[].nombre_producto": "critico",
    "mandatorios": "critico",
    "mensaje_principal.one_line": "critico",
    "accion_kpis.accion_esperada": "critico",
    "practico.fecha_inicio": "critico",
    "practico.fecha_fin": "critico",
    "practico.restricciones": "critico",
    "marca_producto[].beneficio_principal": "claim",
    "marca_producto[].diferenciales": "claim",
    "marca_producto[].rtbs": "claim",
    "marca_producto[].especificaciones": "claim",
    "mensaje_principal.beneficio_diferencial": "claim",
}


def _forma_de(nodo: dict) -> str:
    """Qué tipo de valor admite el campo.

    El esquema no acepta texto en todos lados: hay listas, fechas ISO y un enum.
    Un contrato de extracción que solo produce cadenas las mete igual, y el
    problema no aparece hasta que alguien ensambla el brief y el esquema lo
    rechaza — lejos, tarde y sin rastro de dónde vino.
    """
    valor = nodo.get("properties", {}).get("value", {})
    alternativas = valor.get("oneOf", []) or valor.get("anyOf", [])

    for alt in alternativas:
        if not isinstance(alt, dict) or alt.get("type") == "null":
            continue
        if "enum" in alt:
            return "enum"
        if alt.get("type") == "array":
            return "lista_objetos" if alt.get("items", {}).get("type") == "object" else "lista"
        if alt.get("format") == "date":
            return "fecha"

    if valor.get("type") == "array":
        return "lista"
    return "texto"


def _valores_permitidos(nodo: dict) -> tuple[str, ...]:
    """Enum del campo, si lo tiene.

    Un campo con valores cerrados y un prompt que no los nombra es una trampa:
    el modelo no puede acertar una lista que nunca vio, y lo que devuelva —texto
    libre razonable— pasaría la extracción para reventar después contra el
    esquema. Los valores viajan al prompt y se validan a la vuelta.
    """
    valor = nodo.get("properties", {}).get("value", {})
    if isinstance(valor.get("enum"), list):
        return tuple(str(v) for v in valor["enum"])
    for alternativa in valor.get("oneOf", []) + valor.get("anyOf", []):
        if isinstance(alternativa, dict) and isinstance(alternativa.get("enum"), list):
            return tuple(str(v) for v in alternativa["enum"])
    return ()


@dataclass(frozen=True)
class CampoDelBrief:
    """Un campo hoja: lo que la extracción puede intentar llenar."""

    key: str
    criticidad: str
    descripcion: str
    #: Valores cerrados, si el campo es un enum. Vacío si admite texto libre.
    valores: tuple[str, ...]
    #: texto | lista | lista_objetos | fecha | enum. Lo que el esquema admite.
    forma: str
    #: True si el campo se ancla a un producto concreto (DEC-016).
    por_producto: bool

    @property
    def exige_evidencia(self) -> bool:
        """§15: crítico o claim con valor encontrado necesita respaldo."""
        return self.criticidad in {"critico", "claim"}


@lru_cache(maxsize=1)
def catalogo() -> List[CampoDelBrief]:
    """Campos hoja del esquema, con su criticidad por defecto."""
    esquema = json.loads(ruta_esquema().read_text(encoding="utf-8"))
    defs = esquema.get("$defs", {})
    campos: List[CampoDelBrief] = []

    def resolver(nodo: dict) -> dict:
        visto = 0
        while "$ref" in nodo and visto < 10:
            nodo = defs[nodo["$ref"].split("/")[-1]]
            visto += 1
        return nodo

    def recorrer(nodo: dict, ruta: str) -> None:
        # La descripción se lee ANTES de resolver el `$ref`. En JSON Schema vive
        # como hermana del `$ref`, en la propiedad concreta —`contexto.situacion`
        # describe la situación, no describe «campoTexto»—, así que resolver
        # primero la pierde y deja el prompt con la clave pelada. Fue exactamente
        # lo que hizo que el modelo archivara «El Reto» bajo otro campo.
        descripcion = str(nodo.get("description", "") or "")
        nodo = resolver(nodo)

        if _CLAVES_DE_HOJA.issubset(set(nodo.get("required", []))):
            campos.append(
                CampoDelBrief(
                    key=ruta,
                    criticidad=CRITICIDAD_POR_DEFECTO.get(ruta, "informativo"),
                    descripcion=descripcion or str(nodo.get("description", "") or ""),
                    valores=_valores_permitidos(nodo),
                    forma=_forma_de(nodo),
                    por_producto="marca_producto" in ruta or ruta.startswith("overrides"),
                )
            )
            return

        if "items" in nodo:
            recorrer(nodo["items"], ruta + "[]")
            return

        for clave, sub in nodo.get("properties", {}).items():
            recorrer(sub, f"{ruta}.{clave}" if ruta else clave)

        for alternativa in nodo.get("oneOf", []) + nodo.get("anyOf", []):
            if isinstance(alternativa, dict) and alternativa.get("type") != "null":
                recorrer(alternativa, ruta)

    recorrer(esquema, "")
    return campos


def campos_extraibles() -> List[CampoDelBrief]:
    """Campos que se le piden al modelo.

    Los `overrides` quedan fuera a propósito: una excepción por producto es una
    decisión editorial —*"para la barra de sonido el mensaje cambia"*—, no un
    dato que esté escrito en la fuente. Se captura a mano, no se extrae.
    """
    return [c for c in catalogo() if not c.key.startswith("overrides")]


def campo(key: str) -> Optional[CampoDelBrief]:
    for c in catalogo():
        if c.key == key:
            return c
    return None


def claves_validas() -> frozenset[str]:
    return frozenset(c.key for c in campos_extraibles())
