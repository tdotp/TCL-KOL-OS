"""Registro de parsers por tipo de contenido.

Formatos con procesamiento automático (DEC-010, ampliado por DEC-018 y por la
Fase 4 de V2): Markdown —el preferido para los briefs de SmartPR—, PPTX, PDF,
DOCX, XLSX y CSV. PNG y JPG se aceptan y se conservan, pero no tienen extracción
(OCR/visión sigue pendiente): no se inventa texto que no se extrajo.
"""

from __future__ import annotations

from collections.abc import Callable

from . import csv_parser, docx_parser, markdown_parser, pdf_parser, pptx_parser, xlsx_parser
from .base import Fragment, ParseError, Resultado, normalizar

PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
CSV = "text/csv"
PDF = "application/pdf"
#: Formato preferido para los briefs de SmartPR (DEC-018).
MARKDOWN = "text/markdown"

_REGISTRO: dict[str, Callable[[str], list[Fragment]]] = {
    PPTX: pptx_parser.parse,
    PDF: pdf_parser.parse,
    DOCX: docx_parser.parse,
    MARKDOWN: markdown_parser.parse,
    XLSX: xlsx_parser.parse,
    CSV: csv_parser.parse,
}

#: Parsers que, además de fragmentos, producen la estructura normalizada
#: (manifiesto) del documento (V2 · Fase 4). El resto devuelve solo fragmentos.
_REGISTRO_COMPLETO: dict[str, Callable[[str], Resultado]] = {
    XLSX: xlsx_parser.parse_completo,
    CSV: csv_parser.parse_completo,
}


def _sin_procesamiento(mime_type: str) -> ParseError:
    return ParseError(
        f"El tipo {mime_type} no tiene procesamiento automático. "
        "Se conserva el original, pero no se extrae texto."
    )


def parse(path: str, mime_type: str) -> list[Fragment]:
    """Procesa un archivo según su tipo real de contenido."""
    parser = _REGISTRO.get(mime_type)
    if parser is None:
        raise _sin_procesamiento(mime_type)
    return parser(path)


def parse_completo(path: str, mime_type: str) -> Resultado:
    """Como `parse`, pero conserva la estructura normalizada cuando el formato la tiene."""
    completo = _REGISTRO_COMPLETO.get(mime_type)
    if completo is not None:
        return completo(path)
    return Resultado(fragmentos=parse(path, mime_type))


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
    "Resultado",
    "normalizar",
    "parse",
    "parse_completo",
    "soporta",
    "PPTX",
    "XLSX",
    "CSV",
    "PDF",
    "DOCX",
    "MARKDOWN",
]
