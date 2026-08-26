"""DEC-025 · `mandatorios` y `practico.restricciones` no son lo mismo.

No es una prueba de que el modelo clasifique bien —eso se mide contra el gold
set—, sino de que el prompt distingue las dos instrucciones (regresión
dirigida al caso real: «único canal de venta: Alkosto» se archivó en
`mandatorios` antes de esta corrección, cuando es una restricción operativa).
Esta prueba fija que la instrucción exista y sea explícita.
"""

from __future__ import annotations

from app import brief_schema
from app.extraction import _instrucciones


def test_el_prompt_distingue_mandatorios_de_restricciones() -> None:
    prompt = _instrucciones(brief_schema.campos_extraibles())
    assert "mandatorios" in prompt and "practico.restricciones" in prompt
    # La instrucción debe nombrar el caso real que motivó DEC-025, no solo
    # mencionar los dos campos por separado.
    assert "Alkosto" in prompt
    assert "DEC-025" in prompt
