"""Registro de parsers por tipo de contenido.

Formatos soportados en MVP 1 (DEC-010): PPTX, PDF, DOCX, PNG y JPG.
Las imágenes requieren OCR y se atienden en E4-7.
"""

from __future__ import annotations

from typing import Callable, Dict, List

from .base import Fragment, ParseError, normalizar
from . import docx_parser, markdown_parser, pdf_parser, pptx_parser

PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
PDF = "application/pdf"
#: Formato preferido para los briefs de SmartPR (DEC-018).
MARKDOWN = "text/markdown"

_REGISTRO: Dict[str, Callable[[str], List[Fragment]]] = {
    PPTX: pptx_parser.parse,
    PDF: pdf_parser.parse,
    DOCX: docx_parser.parse,
    MARKDOWN: markdown_parser.parse,
}


def parse(path: str, mime_type: str) -> List[Fragment]:
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
