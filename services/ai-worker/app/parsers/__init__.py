"""Registro de parsers por tipo de contenido.

Formatos con procesamiento automático (DEC-010, ampliado por DEC-018): Markdown
—el preferido para los briefs de SmartPR—, PPTX, PDF y DOCX. PNG y JPG se
aceptan y se conservan, pero requieren OCR y se atienden en E4-7.
"""

from __future__ import annotations

from collections.abc import Callable

from . import docx_parser, markdown_parser, pdf_parser, pptx_parser
from .base import Fragment, ParseError, normalizar

PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
PDF = "application/pdf"
#: Formato preferido para los briefs de SmartPR (DEC-018).
MARKDOWN = "text/markdown"

_REGISTRO: dict[str, Callable[[str], list[Fragment]]] = {
    PPTX: pptx_parser.parse,
    PDF: pdf_parser.parse,
    DOCX: docx_parser.parse,
    MARKDOWN: markdown_parser.parse,
}


def parse(path: str, mime_type: str) -> list[Fragment]:
    """Procesa un archivo según su tipo real de contenido."""
    parser = _REGISTRO.get(mime_type)
    if parser is None:
        raise ParseError(
            f"El tipo {mime_type} no tiene procesamiento automático. "
            "Se conserva el original, pero no se extrae texto."
        )
    return parser(path)


def soporta(mime_type: str) -> bool:
    return mime_type in _REGISTRO


def tipos_soportados() -> frozenset[str]:
    """Los tipos que de verdad tienen parser.

    Se deriva del registro en vez de mantenerse en una lista aparte: una lista
    paralela se desactualiza en cuanto se añade un formato, y fue justo lo que
    pasó con Markdown al entrar por DEC-018.
    """
    return frozenset(_REGISTRO)


__all__ = [
    "Fragment",
    "ParseError",
    "normalizar",
    "parse",
    "soporta",
    "PPTX",
    "PDF",
    "DOCX",
    "MARKDOWN",
]
