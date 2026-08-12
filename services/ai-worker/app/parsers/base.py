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
from typing import Any, Dict, List, Optional, Protocol


@dataclass(frozen=True)
class Fragment:
    """Porción de un documento, con su ubicación exacta."""

    ordinal: int
    text: str
    page: Optional[int] = None
    slide: Optional[int] = None
    section: Optional[str] = None
    linea: Optional[int] = None
    metadata: Dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        tiene_seccion = self.section is not None and self.section.strip() != ""
        if self.page is None and self.slide is None and not tiene_seccion:
            raise ValueError(
                f"El fragmento {self.ordinal} no tiene página, diapositiva ni sección. "
                "Un fragmento sin ubicación no puede citarse como evidencia (§9.4)."
            )
        if not self.text.strip():
            raise ValueError(f"El fragmento {self.ordinal} está vacío.")


class ParseError(RuntimeError):
    """El documento no se pudo procesar.

    El mensaje llega a la interfaz, así que describe qué pasó en términos
    accionables para el consultor, no la traza interna (§11.6).
    """


class Parser(Protocol):
    """Todo parser recibe una ruta y devuelve fragmentos localizados."""

    def parse(self, path: str) -> List[Fragment]: ...


def normalizar(texto: str) -> str:
    """Colapsa espacios en blanco conservando los saltos de párrafo."""
    lineas = [" ".join(linea.split()) for linea in texto.splitlines()]
    return "\n".join(linea for linea in lineas if linea)
