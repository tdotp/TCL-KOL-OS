"""Pruebas del catálogo de campos del brief (DEC-021).

El riesgo que cubren no es que el catálogo esté mal hoy, sino que se **desvíe**:
la forma del brief se lee del JSON Schema de D0-05, pero la criticidad se
declara aparte en una tabla de Python. Dos fuentes que hay que mantener a la
par, y ese es exactamente el arreglo que se pudre en silencio.

Si alguien renombra un campo en el esquema, la tabla queda apuntando a una
clave que ya no existe: el campo pasaría a `informativo` sin que nadie lo
decidiera, y un claim dejaría de exigir evidencia. Estas pruebas convierten esa
desviación en un fallo visible.
"""

from __future__ import annotations

from app import brief_schema


def test_toda_clave_del_catalogo_existe_en_el_esquema() -> None:
    """La comprobación que impide que la tabla y D0-05 se separen.

    Un `critico` que apunta a una clave inexistente no da error: simplemente
    deja de aplicarse, y el campo real baja a informativo sin aviso.
    """
    reales = {c.key for c in brief_schema.catalogo()}
    declaradas = set(brief_schema.CRITICIDAD_POR_DEFECTO)

    huerfanas = declaradas - reales
    assert not huerfanas, (
        f"Estas claves tienen criticidad asignada pero no existen en el esquema: "
        f"{sorted(huerfanas)}. Si se renombró un campo en D0-05, actualice "
        f"CRITICIDAD_POR_DEFECTO."
    )


def test_el_reparto_aprobado_en_dec_021_se_mantiene() -> None:
    """11 críticos, 5 claims, 25 informativos, sobre 41 campos extraíbles.

    Los números están fijados a propósito. Cambiarlos exige tocar esta prueba,
    y tocarla obliga a preguntarse si la decisión de DEC-021 sigue vigente —que
    es justo lo que se quiere que pase.
    """
    campos = brief_schema.campos_extraibles()
    conteo = {"critico": 0, "claim": 0, "informativo": 0}
    for c in campos:
        conteo[c.criticidad] += 1

    assert len(campos) == 41
    assert conteo == {"critico": 11, "claim": 5, "informativo": 25}


def test_los_dos_criticos_confirmados_siguen_siendo_criticos() -> None:
    """`contexto.situacion` y `objetivo.tipo`, confirmados con material real.

    Salieron `not_found` en la primera extracción de la campaña P80. Se preguntó
    si la exigencia estaba mal calibrada y el product owner confirmó que no: el
    brief del cliente no trae esos datos, y el sistema debe decirlo en vez de
    rellenarlos. Se fija aquí para que un ajuste futuro sea deliberado.
    """
    for clave in ("contexto.situacion", "objetivo.tipo"):
        campo = brief_schema.campo(clave)
        assert campo is not None, f"{clave} desapareció del esquema"
        assert campo.criticidad == "critico"
        assert campo.exige_evidencia


def test_solo_criticos_y_claims_exigen_evidencia() -> None:
    """§15. Exigir respaldo a todo vaciaría el brief; a nada, lo volvería opinión."""
    for c in brief_schema.catalogo():
        esperado = c.criticidad in {"critico", "claim"}
        assert c.exige_evidencia is esperado, c.key


def test_los_overrides_no_se_le_piden_al_modelo() -> None:
    """Una excepción por producto es una decisión editorial, no un dato de la fuente."""
    claves = brief_schema.claves_validas()
    assert not any(k.startswith("overrides") for k in claves)
    assert any(k.startswith("overrides") for k in (c.key for c in brief_schema.catalogo()))
