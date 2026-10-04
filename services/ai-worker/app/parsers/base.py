"""Contrato común de los parsers.

Un fragmento sin ubicación no sirve como evidencia (§9.4): la regla del producto
es que un claim debe poder volver al punto exacto de su fuente.

Qué cuenta como ubicación depende de lo que el formato ofrezca **de verdad**
(DEC-018):

  - PPTX  → diapositiva. Discreta y estable.
  - PDF   → página. Está impresa en el archivo.
  - MD    → ruta de encabezados + línea. Exacta y estable.
  - DOCX  → sección. No tiene páginas hasta renderizarse.

`Fragment` exige al menos una. Inventar un número de página donde no existe es
fabricar una precisión falsa, que es peor que no tenerla.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass(frozen=True)
class Fragment:
    """Porción de un documento, con su ubicación exacta.

    La ubicación es `page`/`slide`/`section`/`linea` (formatos con páginas,
    diapositivas o secciones, como hasta ahora) y/o `locator`: el contrato único
    `SourceLocator` (V2 · Fase 4) en forma de dict —`{"kind": "range", "sheet":
    ..., ...}`—, que es lo que usan las hojas de cálculo. Si no se informa
    `locator`, la base lo deriva de las columnas legacy.
    """

    ordinal: int
    text: str
    page: int | None = None
    slide: int | None = None
    section: str | None = None
    linea: int | None = None
    locator: dict[str, Any] | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        tiene_seccion = self.section is not None and self.section.strip() != ""
        if self.page is None and self.slide is None and not tiene_seccion and not self.locator:
            raise ValueError(
                f"El fragmento {self.ordinal} no tiene página, diapositiva, sección ni localizador. "
                "Un fragmento sin ubicación no puede citarse como evidencia (§9.4)."
            )
        if not self.text.strip():
            raise ValueError(f"El fragmento {self.ordinal} está vacío.")


class ParseError(RuntimeError):
    """El documento no se pudo procesar.

    El mensaje llega a la interfaz, así que describe qué pasó en términos
    accionables para el consultor, no la traza interna (§11.6).

    `codigo` es el código semántico del dominio cuando el fallo tiene uno propio
    (p. ej. `INVALID_SPREADSHEET`). `reintentable=False` marca un fallo
    determinista —reintentarlo daría el mismo resultado—: el job queda `fallido`
    sin gastar los reintentos con backoff.
    """

    def __init__(self, mensaje: str, *, codigo: str | None = None, reintentable: bool = True) -> None:
        super().__init__(mensaje)
        self.codigo = codigo
        self.reintentable = reintentable


@dataclass(frozen=True)
class Resultado:
    """Lo que produce un parser: fragmentos y, si el formato lo necesita, la
    estructura normalizada (manifiesto) del documento."""

    fragmentos: list[Fragment]
    estructura: dict[str, Any] | None = None
    #: Identificador del procesador, p. ej. `xlsx-ooxml/1`.
    generador: str | None = None
    formato: str | None = None


class Parser(Protocol):
    """Todo parser recibe una ruta y devuelve fragmentos localizados."""

    def parse(self, path: str) -> list[Fragment]: ...


def normalizar(texto: str) -> str:
    """Colapsa espacios en blanco conservando los saltos de párrafo."""
    lineas = [" ".join(linea.split()) for linea in texto.splitlines()]
    return "\n".join(linea for linea in lineas if linea)
