"""Contrato común de los parsers.

Un fragmento sin ubicación no sirve como evidencia (§9.4): la regla del producto
es que un claim debe poder abrir su fuente en la página o diapositiva exacta.
Por eso `Fragment` exige al menos una de las dos.
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
    metadata: Dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.page is None and self.slide is None:
            raise ValueError(
                f"El fragmento {self.ordinal} no tiene página ni diapositiva. "
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
