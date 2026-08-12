"""Parser de DOCX (E4-6).

Es el formato de los briefs que entrega el cliente.

Sobre la "página" en DOCX (DEC-018)
-----------------------------------
Un DOCX **no tiene páginas** hasta que se renderiza: la paginación depende de la
fuente, los márgenes y el motor que lo abra. Word las calcula al mostrar el
documento, no las guarda.

Por eso este parser **no numera páginas**. Localiza por **sección**: la ruta de
encabezados más cercana. Es exacta, estable y verificable — no cambia si alguien
toca el interlineado. Cuando hay saltos de página explícitos se registran como
metadato informativo, no como el localizador.

Formato preferido: si el brief vive en Google Docs, conviene exportarlo como
**Markdown** en lugar de Word. Google Docs lo hace de forma nativa, y así la
ubicación es ruta de encabezados más número de línea, sin ambigüedad alguna.
"""

from __future__ import annotations

from typing import Any, List, Optional

from .base import Fragment, ParseError, normalizar

# Marca de salto de página en el XML de Word.
_SALTO_DE_PAGINA = '<w:br w:type="page"'


def _tiene_salto_de_pagina(parrafo: Any) -> bool:
    try:
        return _SALTO_DE_PAGINA in parrafo._element.xml
    except Exception:
        return False


def _es_encabezado(parrafo: Any) -> bool:
    estilo = getattr(parrafo.style, "name", "") or ""
    return estilo.startswith("Heading") or estilo.startswith("Título")


def _texto_de_tabla(tabla: Any) -> str:
    filas = []
    for fila in tabla.rows:
        celdas = [" ".join(celda.text.split()) for celda in fila.cells]
        if any(celdas):
            filas.append(" | ".join(celdas))
    return "\n".join(filas)


def parse(path: str) -> List[Fragment]:
    try:
        import docx
    except ImportError as exc:  # pragma: no cover
        raise ParseError("Falta la librería de Word en el worker.") from exc

    try:
        documento = docx.Document(path)
    except Exception as exc:
        raise ParseError("No se pudo abrir el documento de Word. Puede estar dañado.") from exc

    fragmentos: List[Fragment] = []
    ordinal = 0
    saltos = 0
    seccion: Optional[str] = None
    acumulado: List[str] = []

    def volcar() -> None:
        nonlocal ordinal, acumulado
        texto = "\n".join(acumulado).strip()
        if texto:
            fragmentos.append(
                Fragment(
                    ordinal=ordinal,
                    text=normalizar(texto),
                    # Sin página: en DOCX no existe hasta renderizar (DEC-018).
                    section=seccion or "(sin encabezado)",
                    metadata={
                        "origen": "parrafos",
                        "localizador": "seccion",
                        "tras_saltos_de_pagina": saltos,
                    },
                )
            )
            ordinal += 1
        acumulado = []

    for parrafo in documento.paragraphs:
        if _tiene_salto_de_pagina(parrafo):
            volcar()
            saltos += 1

        texto = parrafo.text.strip()
        if not texto:
            continue

        # Un encabezado abre una sección nueva: se cierra el fragmento anterior
        # para que cada bloque quede atribuido a su título.
        if _es_encabezado(parrafo):
            volcar()
            seccion = " ".join(texto.split())

        acumulado.append(texto)

    volcar()

    # Las tablas van aparte: en los briefs suelen contener la ficha técnica y
    # los datos comparativos, que son justamente lo que hay que poder citar.
    for indice, tabla in enumerate(documento.tables, start=1):
        texto = _texto_de_tabla(tabla)
        if not texto.strip():
            continue
        fragmentos.append(
            Fragment(
                ordinal=ordinal,
                text=normalizar(texto),
                section=f"Tabla {indice}",
                metadata={"origen": "tabla", "localizador": "seccion"},
            )
        )
        ordinal += 1

    if not fragmentos:
        raise ParseError("El documento no contiene texto extraíble.")

    return fragmentos
