"""Parser de PDF con localización de página (E4-6).

Es el formato de las fichas técnicas, que son la fuente de verdad para
especificaciones citables.
"""

from __future__ import annotations

from typing import List

from .base import Fragment, ParseError, normalizar


def parse(path: str) -> List[Fragment]:
    try:
        from pypdf import PdfReader
    except ImportError as exc:  # pragma: no cover
        raise ParseError("Falta la librería de PDF en el worker.") from exc

    try:
        lector = PdfReader(path)
    except Exception as exc:
        raise ParseError("No se pudo abrir el PDF. Puede estar dañado.") from exc

    if lector.is_encrypted:
        # Intento con contraseña vacía: muchos PDF están "cifrados" solo para
        # impedir la edición, no la lectura.
        try:
            lector.decrypt("")
        except Exception as exc:
            raise ParseError(
                "El PDF está protegido con contraseña y no se puede procesar."
            ) from exc

    fragmentos: List[Fragment] = []
    ordinal = 0
    paginas_sin_texto = 0

    for numero, pagina in enumerate(lector.pages, start=1):
        try:
            texto = pagina.extract_text() or ""
        except Exception:
            # Una página ilegible no invalida el documento entero: se cuenta y
            # se sigue. Bloquear todo por una página rompería el trabajo.
            paginas_sin_texto += 1
            continue

        if not texto.strip():
            paginas_sin_texto += 1
            continue

        fragmentos.append(
            Fragment(
                ordinal=ordinal,
                text=normalizar(texto),
                page=numero,
                metadata={"origen": "pagina"},
            )
        )
        ordinal += 1

    total = len(lector.pages)

    if not fragmentos:
        raise ParseError(
            f"El PDF tiene {total} página(s) y ninguna contiene texto extraíble. "
            "Probablemente es un documento escaneado: requiere OCR."
        )

    # Se informa la cobertura para que el consultor sepa si le falta contenido.
    for fragmento in fragmentos:
        fragmento.metadata["paginas_totales"] = total
        fragmento.metadata["paginas_sin_texto"] = paginas_sin_texto

    return fragmentos
