"""Catálogo de campos del brief y su criticidad (apoya E5-3 y E5-4).

De dónde sale cada cosa
-----------------------
La **forma** —qué campos existen y cómo se llaman— sale del JSON Schema de
D0-05, que es la fuente de verdad. Este módulo la lee del archivo; no la copia.

La **criticidad** y el **nivel** (campaña / producto / compartido con
excepción, DEC-016) tampoco viven en el esquema JSON, por la misma razón:
son un valor por defecto, no una constante — `criticidad` es una columna por
campo en `brief_fields`, y una campaña puede subir o bajar la exigencia de un
campo concreto. Hasta el cierre de Sprint 4 esa tabla vivía hardcodeada en
este módulo, duplicada sin saberlo por cualquier catálogo que el lado
TypeScript necesitara. Ya no: ambos lados leen **el mismo archivo**,
`docs/product/brief-schema/brief-catalog.json` (ver también
`packages/domain/src/brief-catalog.ts`) — una sola fuente, dos lectores. Un
script de verificación (`scripts/verificar-catalogo.mjs`) compara ambos en CI.

El contenido de ese catálogo es el mismo que ya se había revisado: el valor
por defecto sale del ejemplo validado `brief.example.es.json`, aprobado junto
con D0-05 en el gate de MVP 0, y quedó confirmado en DEC-021, que cierra el
pendiente de D0-05 §8 —*"¿qué campos exactos son obligatorios para
aprobar?"*—.

Nota de un error que costó entender: dos campos salieron `not_found` en la
campaña P80 y se leyó como «el cliente no mandó el dato». Era falso. El brief
sí lo traía, y la extracción lo archivaba en otro campo porque este módulo
perdía las descripciones del esquema (DEC-022). **Un `not_found` no prueba que
el dato no exista mientras nadie haya mirado la fuente.**
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

_RELATIVA = Path("docs") / "product" / "brief-schema" / "brief.schema.json"
_RELATIVA_CATALOGO = Path("docs") / "product" / "brief-schema" / "brief-catalog.json"


def _buscar_hacia_arriba(relativa: Path, variable_entorno: str) -> Path:
    """Mismo problema, misma solución, para cualquier archivo montado bajo `docs/`.

    El worker corre en dos sitios con árboles distintos: en el monorepo, donde
    `docs/` está unos niveles más arriba, y dentro del contenedor, donde solo
    existe `/app` y el archivo llega montado. Por eso la ruta no se calcula
    contando directorios —eso se rompió en cuanto tocó Docker— sino que se
    declara por entorno y, si no, se busca hacia arriba.
    """
    declarada = os.environ.get(variable_entorno, "").strip()
    if declarada:
        return Path(declarada)

    aqui = Path(__file__).resolve()
    for base in aqui.parents:
        candidata = base / relativa
        if candidata.is_file():
            return candidata

    raise FileNotFoundError(
        f"No se encontró {relativa.name}. Defina {variable_entorno} o monte "
        f"{relativa} en el contenedor."
    )


def ruta_esquema() -> Path:
    """Dónde está el esquema del brief (forma y validación, D0-05).

    Nunca se copia el archivo al worker: D0-05 es la fuente de verdad, y una
    segunda copia se desactualiza sin que nadie se entere.
    """
    return _buscar_hacia_arriba(_RELATIVA, "BRIEF_SCHEMA_PATH")


def ruta_catalogo() -> Path:
    """Dónde está el catálogo único de campos (criticidad, nivel, etiqueta).

    Mismo archivo que lee `packages/domain/src/brief-catalog.ts` del lado
    TypeScript — la fuente única de la corrección 4 del cierre de Sprint 4.
    """
    return _buscar_hacia_arriba(_RELATIVA_CATALOGO, "BRIEF_CATALOG_PATH")


#: Marcas que identifican a un campo hoja dentro del esquema.
_CLAVES_DE_HOJA = {"value", "status", "provenanceType", "criticidad", "evidence"}


@lru_cache(maxsize=1)
def _cargar_catalogo() -> dict[str, dict[str, str]]:
    """Catálogo único, indexado por clave. `{criticidad, nivel}` por campo."""
    crudo = json.loads(ruta_catalogo().read_text(encoding="utf-8"))
    return {c["key"]: {"criticidad": c["criticidad"], "nivel": c["nivel"]} for c in crudo}


def _forma_de(nodo: dict[str, Any]) -> str:
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


def _valores_permitidos(nodo: dict[str, Any]) -> tuple[str, ...]:
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
    #: campana | producto | compartido_con_excepcion (DEC-016). Estructural,
    #: ya no una heurística de texto sobre la clave — sale del catálogo único.
    nivel: str

    @property
    def por_producto(self) -> bool:
        """True si el campo se ancla a un producto concreto (nivel == 'producto')."""
        return self.nivel == "producto"

    @property
    def exige_evidencia(self) -> bool:
        """§15: crítico o claim con valor encontrado necesita respaldo."""
        return self.criticidad in {"critico", "claim"}


@lru_cache(maxsize=1)
def catalogo() -> list[CampoDelBrief]:
    """Campos hoja del esquema, con su criticidad y nivel del catálogo único."""
    esquema = json.loads(ruta_esquema().read_text(encoding="utf-8"))
    defs = esquema.get("$defs", {})
    metadatos = _cargar_catalogo()
    campos: list[CampoDelBrief] = []

    def resolver(nodo: dict[str, Any]) -> dict[str, Any]:
        visto = 0
        while "$ref" in nodo and visto < 10:
            nodo = defs[nodo["$ref"].split("/")[-1]]
            visto += 1
        return nodo

    def recorrer(nodo: dict[str, Any], ruta: str) -> None:
        # La descripción se lee ANTES de resolver el `$ref`. En JSON Schema vive
        # como hermana del `$ref`, en la propiedad concreta —`contexto.situacion`
        # describe la situación, no describe «campoTexto»—, así que resolver
        # primero la pierde y deja el prompt con la clave pelada. Fue exactamente
        # lo que hizo que el modelo archivara «El Reto» bajo otro campo.
        descripcion = str(nodo.get("description", "") or "")
        nodo = resolver(nodo)

        if _CLAVES_DE_HOJA.issubset(set(nodo.get("required", []))):
            # `overrides[].*` no está en el catálogo único (DEC-023: sin
            # prefijo `overrides.`, la nulabilidad de `campaign_product_id` ya
            # distingue compartido de específico) — se queda con el valor por
            # defecto de siempre, porque `campos_extraibles()` lo descarta más
            # abajo y nunca llega a pedírsele al modelo.
            meta = metadatos.get(ruta, {"criticidad": "informativo", "nivel": "campana"})
            campos.append(
                CampoDelBrief(
                    key=ruta,
                    criticidad=meta["criticidad"],
                    descripcion=descripcion or str(nodo.get("description", "") or ""),
                    valores=_valores_permitidos(nodo),
                    forma=_forma_de(nodo),
                    nivel=meta["nivel"],
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


def campos_extraibles() -> list[CampoDelBrief]:
    """Campos que se le piden al modelo.

    Los `overrides` quedan fuera a propósito: una excepción por producto es una
    decisión editorial —*"para la barra de sonido el mensaje cambia"*—, no un
    dato que esté escrito en la fuente. Se captura a mano, no se extrae.
    """
    return [c for c in catalogo() if not c.key.startswith("overrides")]


def campo(key: str) -> CampoDelBrief | None:
    for c in catalogo():
        if c.key == key:
            return c
    return None


def claves_validas() -> frozenset[str]:
    return frozenset(c.key for c in campos_extraibles())


def _volcar_catalogo() -> None:
    """Imprime `{key, criticidad, nivel}` de cada campo extraíble, como JSON.

    Lo usa `scripts/verificar-catalogo.mjs` (Sprint 4, corrección 4 del
    cierre) para comparar este lado con `catalogoDelBrief()` de
    `packages/domain/src/brief-catalog.ts` — mismas 41 claves, misma
    criticidad, mismo nivel, sin que ninguno de los dos derive un catálogo
    por su cuenta.
    """
    datos = [
        {"key": c.key, "criticidad": c.criticidad, "nivel": c.nivel}
        for c in campos_extraibles()
    ]
    print(json.dumps(datos, ensure_ascii=False))


if __name__ == "__main__":
    import sys

    if "--volcar-catalogo" in sys.argv:
        _volcar_catalogo()
    else:
        print("Uso: python -m app.brief_schema --volcar-catalogo", file=sys.stderr)
        raise SystemExit(2)
