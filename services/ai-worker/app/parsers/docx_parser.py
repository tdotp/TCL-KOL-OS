"""Parser de DOCX (E4-6).

Es el formato de los briefs que entrega el cliente.

Sobre la "página" en DOCX
-------------------------
Un DOCX **no tiene páginas** hasta que se renderiza: la paginación depende de la
fuente, los márgenes y el motor que lo abra. Word calcula las páginas al mostrar
el documento, no las guarda.

Lo que sí existe son los **saltos de página explícitos**. Este parser cuenta esos
saltos y numera en consecuencia, lo que da una ubicación honesta y reproducible.
Cuando el documento no tiene saltos explícitos, todo queda en la página 1 y se
usa la sección (el encabezado más cercano) como ubicación fina.

La alternativa —renderizar el documento para saber la página real— exige
LibreOffice en el worker y produce una paginación que puede no coincidir con la
que ve el consultor en su Word. Se prefiere una aproximación declarada a una
precisión falsa.
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
    pagina = 1
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
                    page=pagina,
                    section=seccion,
                    metadata={"origen": "parrafos", "paginacion": "saltos_explicitos"},
                )
            )
            ordinal += 1
        acumulado = []

    for parrafo in documento.paragraphs:
        if _tiene_salto_de_pagina(parrafo):
            volcar()
            pagina += 1

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
                page=pagina,
                section=f"Tabla {indice}",
                metadata={"origen": "tabla", "paginacion": "saltos_explicitos"},
            )
        )
        ordinal += 1

    if not fragmentos:
        raise ParseError("El documento no contiene texto extraíble.")

    return fragmentos
