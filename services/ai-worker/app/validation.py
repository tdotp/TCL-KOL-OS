"""Validación de archivos por su contenido real (E4-1, caso S-05).

Un archivo NO se valida por su extensión ni por el `Content-Type` que declara el
navegador: ambos los controla quien sube el archivo. Se valida leyendo los
primeros bytes, que son los que determinan qué es el archivo de verdad.

Un ejecutable renombrado a `.pdf` se rechaza aquí.
"""

from __future__ import annotations

import zipfile
from dataclasses import dataclass
from typing import Optional

PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
PDF = "application/pdf"
PNG = "image/png"
JPEG = "image/jpeg"

#: Formatos aceptados en MVP 1 (DEC-010).
PERMITIDOS = frozenset({PPTX, DOCX, PDF, PNG, JPEG})


@dataclass(frozen=True)
class ResultadoValidacion:
    valido: bool
    mime_type: Optional[str] = None
    motivo: Optional[str] = None


def _tipo_ooxml(path: str) -> Optional[str]:
    """Un OOXML es un ZIP; el tipo real está en su contenido interno."""
    try:
        with zipfile.ZipFile(path) as archivo:
            nombres = set(archivo.namelist())
    except zipfile.BadZipFile:
        return None

    if any(n.startswith("ppt/") for n in nombres):
        return PPTX
    if any(n.startswith("word/") for n in nombres):
        return DOCX
    if any(n.startswith("xl/") for n in nombres):
        return XLSX
    return None


def detectar_tipo(path: str) -> Optional[str]:
    """Tipo real del archivo según sus primeros bytes."""
    with open(path, "rb") as f:
        cabecera = f.read(8)

    if cabecera.startswith(b"%PDF-"):
        return PDF
    if cabecera.startswith(b"\x89PNG\r\n\x1a\n"):
        return PNG
    if cabecera.startswith(b"\xff\xd8\xff"):
        return JPEG
    if cabecera.startswith(b"PK\x03\x04"):
        return _tipo_ooxml(path)
    return None


def validar(path: str, tamano_bytes: int, max_bytes: int, declarado: Optional[str] = None) -> ResultadoValidacion:
    """Valida tamaño y tipo real. `declarado` es solo informativo."""
    if tamano_bytes <= 0:
        return ResultadoValidacion(False, motivo="El archivo está vacío.")

    if tamano_bytes > max_bytes:
        mb = round(tamano_bytes / 1024 / 1024, 1)
        limite = round(max_bytes / 1024 / 1024)
        return ResultadoValidacion(
            False, motivo=f"El archivo pesa {mb} MB y el límite es {limite} MB."
        )

    real = detectar_tipo(path)

    if real is None:
        return ResultadoValidacion(
            False,
            motivo="No se reconoce el tipo de archivo. Formatos aceptados: PDF, PPTX, DOCX, PNG y JPG.",
        )

    if real not in PERMITIDOS:
        if real == XLSX:
            return ResultadoValidacion(
                False,
                real,
                "Los archivos de Excel no tienen procesamiento automático en esta fase. "
                "Cárguelo como excepción manual si es necesario.",
            )
        return ResultadoValidacion(False, real, f"El tipo {real} no está permitido.")

    # La discrepancia entre lo declarado y lo real no bloquea —los navegadores
    # se equivocan a menudo— pero se registra: un ejecutable disfrazado de PDF
    # ya fue rechazado arriba, porque su contenido real no es reconocible.
    if declarado is not None and declarado != real:
        return ResultadoValidacion(True, real, f"El tipo declarado ({declarado}) no coincide con el real.")

    return ResultadoValidacion(True, real)
