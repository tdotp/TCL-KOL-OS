"""Validación de archivos por su contenido real (E4-1, caso S-05).

Un archivo NO se valida por su extensión ni por el `Content-Type` que declara el
navegador: ambos los controla quien sube el archivo. Se valida leyendo los
primeros bytes, que son los que determinan qué es el archivo de verdad.

Un ejecutable renombrado a `.pdf` se rechaza aquí.
"""

from __future__ import annotations

import zipfile
from dataclasses import dataclass

PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
PDF = "application/pdf"
PNG = "image/png"
JPEG = "image/jpeg"
MARKDOWN = "text/markdown"
CSV = "text/csv"

#: Formatos aceptados: los de MVP 1 (DEC-010) más las hojas de cálculo `.xlsx`
#: y `.csv` (V2 · Fase 4). El `.xls` binario y los libros con macros NO.
PERMITIDOS = frozenset({PPTX, DOCX, XLSX, CSV, PDF, PNG, JPEG, MARKDOWN})


@dataclass(frozen=True)
class ResultadoValidacion:
    valido: bool
    mime_type: str | None = None
    motivo: str | None = None


def _tipo_ooxml(path: str) -> str | None:
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


def _es_texto_utf8(muestra: bytes) -> bool:
    """El texto plano no tiene firma: se reconoce por lo que NO contiene.

    Un binario casi siempre trae bytes nulos; el texto, nunca. Y si además
    decodifica como UTF-8, es texto.
    """
    if b"\x00" in muestra:
        return False
    try:
        muestra.decode("utf-8")
    except UnicodeDecodeError:
        # Puede ser un carácter multibyte cortado al final de la muestra.
        try:
            muestra[:-4].decode("utf-8")
        except UnicodeDecodeError:
            return False
    return True


#: Extensiones que declaran texto. Ver `detectar_tipo` para por qué importan.
_EXTENSIONES_TEXTO = (".md", ".markdown", ".txt")
_EXTENSIONES_CSV = (".csv",)
#: Firma de los contenedores OLE antiguos (`.xls`, `.doc`, `.ppt`) y de los OOXML cifrados.
_FIRMA_OLE = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"


def detectar_tipo(path: str, nombre: str | None = None) -> str | None:
    """Tipo real del archivo según su contenido.

    Los formatos binarios se reconocen por su firma, y esa firma manda sobre
    cualquier cosa que declare quien sube el archivo.

    El texto plano no tiene firma: no hay forma de distinguir por contenido un
    Markdown de un script de shell, porque ambos son texto. Ahí el contenido solo
    puede decir "esto es texto", y hace falta la extensión para desempatar.

    El principio se mantiene: **el contenido solo puede restringir, nunca
    ampliar**. Un archivo con firma de PDF es PDF aunque se llame `.md`; y un
    texto sin firma solo se acepta si además dice llamarse `.md`. Por eso un
    script renombrado a `.pptx` sigue rechazándose (caso S-05).
    """
    with open(path, "rb") as f:
        muestra = f.read(8192)

    if muestra.startswith(b"%PDF-"):
        return PDF
    if muestra.startswith(b"\x89PNG\r\n\x1a\n"):
        return PNG
    if muestra.startswith(b"\xff\xd8\xff"):
        return JPEG
    if muestra.startswith(b"PK\x03\x04"):
        return _tipo_ooxml(path)

    referencia = (nombre or path).lower()
    if referencia.endswith(_EXTENSIONES_CSV) and muestra and _es_texto_utf8(muestra):
        return CSV
    if referencia.endswith(_EXTENSIONES_TEXTO) and muestra and _es_texto_utf8(muestra):
        return MARKDOWN

    return None


def validar(
    path: str,
    tamano_bytes: int,
    max_bytes: int,
    declarado: str | None = None,
    nombre: str | None = None,
) -> ResultadoValidacion:
    """Valida tamaño y tipo real. `declarado` es informativo salvo en texto plano."""
    if tamano_bytes <= 0:
        return ResultadoValidacion(False, motivo="El archivo está vacío.")

    if tamano_bytes > max_bytes:
        mb = round(tamano_bytes / 1024 / 1024, 1)
        limite = round(max_bytes / 1024 / 1024)
        return ResultadoValidacion(
            False, motivo=f"El archivo pesa {mb} MB y el límite es {limite} MB."
        )

    real = detectar_tipo(path, nombre)

    if real is None:
        with open(path, "rb") as f:
            if f.read(8) == _FIRMA_OLE:
                return ResultadoValidacion(
                    False,
                    motivo=(
                        "Los archivos de Office antiguos (.xls, .doc, .ppt) y los protegidos con "
                        "contraseña no son compatibles. Guárdelo como .xlsx, .docx o .pptx sin contraseña."
                    ),
                )
        return ResultadoValidacion(
            False,
            motivo=(
                "No se reconoce el tipo de archivo. "
                "Formatos aceptados: Markdown, PDF, PPTX, DOCX, XLSX, CSV, PNG y JPG."
            ),
        )

    if real not in PERMITIDOS:
        return ResultadoValidacion(False, real, f"El tipo {real} no está permitido.")

    if real == XLSX:
        # Mismas comprobaciones que al subir (TypeScript): estructura, macros y
        # señales de ZIP bomb. Segunda línea de defensa en otro runtime.
        from .parsers.base import ParseError
        from .parsers.xlsx_parser import validar_libro

        try:
            with zipfile.ZipFile(path) as zf:
                validar_libro(zf)
        except (ParseError, zipfile.BadZipFile) as exc:
            return ResultadoValidacion(False, real, str(exc))

    # La discrepancia entre lo declarado y lo real no bloquea —los navegadores
    # se equivocan a menudo— pero se registra: un ejecutable disfrazado de PDF
    # ya fue rechazado arriba, porque su contenido real no es reconocible.
    if declarado is not None and declarado != real:
        return ResultadoValidacion(True, real, f"El tipo declarado ({declarado}) no coincide con el real.")

    return ResultadoValidacion(True, real)
