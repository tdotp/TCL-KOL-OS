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
    """La comprobación que impide que el catálogo único y D0-05 se separen.

    Desde el cierre de Sprint 4, la criticidad y el nivel ya no viven en una
    tabla de Python: viven en `docs/product/brief-schema/brief-catalog.json`,
    la misma fuente que lee `packages/domain/src/brief-catalog.ts`. Un campo
    ahí que apunte a una clave inexistente en el esquema real no da error:
    simplemente deja de aplicarse, y el campo real baja a informativo sin
    aviso — exactamente lo que esta prueba convierte en un fallo visible.
    """
    reales = {c.key for c in brief_schema.catalogo()}
    declaradas = set(brief_schema._cargar_catalogo())  # noqa: SLF001 — es la prueba de esta invariante.

    huerfanas = declaradas - reales
    assert not huerfanas, (
        f"Estas claves tienen criticidad asignada pero no existen en el esquema: "
        f"{sorted(huerfanas)}. Si se renombró un campo en D0-05, actualice "
        f"docs/product/brief-schema/brief-catalog.json."
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


def test_el_nivel_respeta_la_regla_de_tres_niveles_de_dec_016() -> None:
    """DEC-016: siempre-de-campaña / siempre-por-producto / compartido-con-excepción.

    Ya no es una heurística de texto sobre la clave (`"marca_producto" in
    ruta`) — sale estructuralmente del catálogo único. Esta prueba fija los
    tres casos representativos de la tabla de DEC-016.
    """
    siempre_campana = ["contexto.situacion", "objetivo.tipo", "practico.fecha_inicio"]
    siempre_producto = ["marca_producto[].nombre_producto", "marca_producto[].rtbs"]
    compartido_con_excepcion = [
        "target_audiencia.descripcion",
        "problema_insight.problema",
        "mensaje_principal.one_line",
        "mandatorios",
    ]

    for clave in siempre_campana:
        campo = brief_schema.campo(clave)
        assert campo is not None, clave
        assert campo.nivel == "campana", clave
        assert campo.por_producto is False, clave

    for clave in siempre_producto:
        campo = brief_schema.campo(clave)
        assert campo is not None, clave
        assert campo.nivel == "producto", clave
        assert campo.por_producto is True, clave

    for clave in compartido_con_excepcion:
        campo = brief_schema.campo(clave)
        assert campo is not None, clave
        assert campo.nivel == "compartido_con_excepcion", clave
        assert campo.por_producto is False, clave
