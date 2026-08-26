"""Parser de Markdown (DEC-018).

Es el **formato preferido** para los briefs que produce SmartPR.

Por qué Markdown y no DOCX
--------------------------
Los briefs viven en Google Docs, que exporta a Markdown directamente. Eso evita
el problema de fondo del DOCX: un documento de texto no tiene páginas hasta que
se renderiza, así que citar "página 3" es inventar una precisión que no existe.

En Markdown la ubicación es la **ruta de encabezados** —"El Reto › Audiencia"—
más el número de línea. Ambos son exactos y estables: no cambian si alguien
modifica la fuente, los márgenes o el interlineado.

Un beneficio que llega gratis: al ser texto plano, las versiones del brief se
pueden comparar línea a línea (Épica E8, comparador de versiones).
"""

from __future__ import annotations

import re

from .base import Fragment, ParseError, normalizar

_ENCABEZADO = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")
_CERCA_CODIGO = re.compile(r"^\s*(```|~~~)")
_SEPARADOR = " › "


def _ruta(pila: list[tuple[int, str]]) -> str | None:
    """Ruta jerárquica de encabezados: 'El Reto › Audiencia › Primaria'."""
    if not pila:
        return None
    return _SEPARADOR.join(titulo for _, titulo in pila)


def parse(path: str) -> list[Fragment]:
    try:
        with open(path, encoding="utf-8") as f:
            contenido = f.read()
    except UnicodeDecodeError as exc:
        raise ParseError(
            "El archivo no es texto UTF-8 válido. Si viene de Google Docs, "
            "expórtelo de nuevo como Markdown."
        ) from exc
    except OSError as exc:
        raise ParseError("No se pudo leer el archivo.") from exc

    fragmentos: list[Fragment] = []
    ordinal = 0

    pila: list[tuple[int, str]] = []
    bloque: list[str] = []
    linea_inicio = 1
    en_codigo = False

    def volcar(linea_actual: int) -> None:
        nonlocal ordinal, bloque
        texto = "\n".join(bloque).strip()
        if texto:
            fragmentos.append(
                Fragment(
                    ordinal=ordinal,
                    text=normalizar(texto),
                    section=_ruta(pila) or "(sin sección)",
                    linea=linea_inicio,
                    metadata={
                        "origen": "markdown",
                        "nivel": pila[-1][0] if pila else 0,
                        "linea_fin": max(linea_actual - 1, linea_inicio),
                    },
                )
            )
            ordinal += 1
        bloque = []

    for numero, linea in enumerate(contenido.splitlines(), start=1):
        # Dentro de un bloque de código, `#` es contenido, no encabezado.
        if _CERCA_CODIGO.match(linea):
            en_codigo = not en_codigo
            bloque.append(linea)
            continue

        if en_codigo:
            bloque.append(linea)
            continue

        m = _ENCABEZADO.match(linea)
        if m is not None:
            volcar(numero)

            nivel = len(m.group(1))
            titulo = " ".join(m.group(2).split())

            # Se cierran las secciones de nivel igual o más profundo.
            while pila and pila[-1][0] >= nivel:
                pila.pop()
            pila.append((nivel, titulo))

            linea_inicio = numero
            continue

        if not bloque and linea.strip():
            linea_inicio = numero

        bloque.append(linea)

    volcar(len(contenido.splitlines()) + 1)

    if not fragmentos:
        raise ParseError("El archivo no contiene texto.")

    return fragmentos
