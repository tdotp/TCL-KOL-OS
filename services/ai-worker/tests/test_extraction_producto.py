"""Anclaje de producto en la extracción (DEC-016/DEC-023, cierre de Sprint 4).

Antes de este cierre, `marca_producto[].*` era una clave genérica: en una
campaña de varios productos como P80 (P80, P80 Pro, P80 Ultra) no había forma
de saber a cuál pertenecía cada especificación. Estas pruebas verifican el
anclaje estructural — `producto_id` exacto, nunca inventado, nunca mezclado —
que reemplaza esa ambigüedad (prueba 20 del cierre, mitad worker / mitad
repositorio).
"""

from __future__ import annotations

import json

from app.extraction import FragmentoDeEntrada, ProductoDeEntrada, validar_y_anclar

P80 = ProductoDeEntrada(id="prd-p80", nombre_producto="TCL P80")
P80_PRO = ProductoDeEntrada(id="prd-p80-pro", nombre_producto="TCL P80 Pro")
P80_ULTRA = ProductoDeEntrada(id="prd-p80-ultra", nombre_producto="TCL P80 Ultra")
PRODUCTOS = [P80, P80_PRO, P80_ULTRA]

FRAGMENTO = FragmentoDeEntrada(
    id="frag-ficha",
    source_id="src-ficha",
    filename="Ficha técnica P80.md",
    texto=(
        "P80: pantalla 6.6 pulgadas, 90Hz. "
        "P80 Pro: pantalla 6.7 pulgadas, 120Hz, cámara 108MP. "
        "P80 Ultra: pantalla 6.8 pulgadas, 144Hz nativos, carga 66W."
    ),
    section="Ficha técnica y precios",
    linea=1,
)


def _respuesta(campos: list[dict]) -> str:
    return json.dumps({"campos": campos}, ensure_ascii=False)


def _buscar(campos, key: str, producto_id: str):
    return next(c for c in campos if c.key == key and c.producto_id == producto_id)


def test_cada_producto_recibe_su_propia_fila_sin_mezclar_especificaciones() -> None:
    """Las tres especificaciones de RTBS quedan ancladas al producto correcto."""
    campos, descartes = validar_y_anclar(
        _respuesta(
            [
                {
                    "key": "marca_producto[].rtbs",
                    "producto_id": "prd-p80",
                    "value": ["Pantalla 6.6 pulgadas, 90Hz"],
                    "status": "found",
                    "evidence": [
                        {
                            "fragment_id": "frag-ficha",
                            "quote": "P80: pantalla 6.6 pulgadas, 90Hz",
                            "relation": "soporta",
                        }
                    ],
                },
                {
                    "key": "marca_producto[].rtbs",
                    "producto_id": "prd-p80-pro",
                    "value": ["Pantalla 6.7 pulgadas, 120Hz, cámara 108MP"],
                    "status": "found",
                    "evidence": [
                        {
                            "fragment_id": "frag-ficha",
                            "quote": "P80 Pro: pantalla 6.7 pulgadas, 120Hz, cámara 108MP",
                            "relation": "soporta",
                        }
                    ],
                },
                {
                    "key": "marca_producto[].rtbs",
                    "producto_id": "prd-p80-ultra",
                    "value": ["Pantalla 6.8 pulgadas, 144Hz nativos, carga 66W"],
                    "status": "found",
                    "evidence": [
                        {
                            "fragment_id": "frag-ficha",
                            "quote": "P80 Ultra: pantalla 6.8 pulgadas, 144Hz nativos, carga 66W",
                            "relation": "soporta",
                        }
                    ],
                },
            ]
        ),
        [FRAGMENTO],
        PRODUCTOS,
    )

    p80 = _buscar(campos, "marca_producto[].rtbs", "prd-p80")
    pro = _buscar(campos, "marca_producto[].rtbs", "prd-p80-pro")
    ultra = _buscar(campos, "marca_producto[].rtbs", "prd-p80-ultra")

    assert p80.status == "found"
    assert pro.status == "found"
    assert ultra.status == "found"

    # Ninguno se contamina con el valor de otro (el fallo real que corrige DEC-023).
    valores = {p80.value[0], pro.value[0], ultra.value[0]}
    assert len(valores) == 3
    assert "144Hz" in ultra.value[0] and "144Hz" not in p80.value[0] and "144Hz" not in pro.value[0]
    assert not descartes


def test_un_producto_inventado_se_descarta_sin_contaminar_los_demas() -> None:
    """Un producto_id fuera de la lista se rechaza — no se acepta ni se inventa."""
    campos, descartes = validar_y_anclar(
        _respuesta(
            [
                {
                    "key": "marca_producto[].rtbs",
                    "producto_id": "prd-inventado",
                    "value": ["Algo que nadie pidió"],
                    "status": "found",
                    "evidence": [],
                },
                {
                    "key": "marca_producto[].rtbs",
                    "producto_id": "prd-p80",
                    "value": ["Pantalla 6.6 pulgadas, 90Hz"],
                    "status": "found",
                    "evidence": [
                        {
                            "fragment_id": "frag-ficha",
                            "quote": "P80: pantalla 6.6 pulgadas, 90Hz",
                            "relation": "soporta",
                        }
                    ],
                },
            ]
        ),
        [FRAGMENTO],
        PRODUCTOS,
    )

    assert any("prd-inventado" in d and "no está entre los productos" in d for d in descartes)
    assert not any(c.producto_id == "prd-inventado" for c in campos)
    assert _buscar(campos, "marca_producto[].rtbs", "prd-p80").status == "found"


def test_un_campo_por_producto_omitido_se_declara_ausente_por_cada_producto() -> None:
    """Si el modelo no devuelve nada para un campo por producto, el hueco es por producto."""
    campos, _ = validar_y_anclar(_respuesta([]), [FRAGMENTO], PRODUCTOS)

    for producto in PRODUCTOS:
        campo = _buscar(campos, "marca_producto[].nombre_producto", producto.id)
        assert campo.status == "not_found"
        assert campo.value is None


def test_un_campo_de_campana_no_admite_producto_id_aunque_el_modelo_lo_ponga() -> None:
    """`contexto.situacion` es de nivel campaña: producto_id se ignora (DEC-023)."""
    campos, _ = validar_y_anclar(
        _respuesta(
            [
                {
                    "key": "contexto.situacion",
                    "producto_id": "prd-p80",
                    "value": "Lanzamiento de línea",
                    "status": "found",
                    "evidence": [
                        {
                            "fragment_id": "frag-ficha",
                            "quote": "P80: pantalla 6.6 pulgadas, 90Hz",
                            "relation": "contexto",
                        }
                    ],
                }
            ]
        ),
        [FRAGMENTO],
        PRODUCTOS,
    )
    campo = next(c for c in campos if c.key == "contexto.situacion")
    assert campo.producto_id is None
