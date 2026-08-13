"""Pruebas de la extracción estructurada (E5-3, E5-4, E5-5, E5-6).

Casi todas atacan el mismo punto: **qué pasa cuando el modelo se equivoca de
forma convincente**. Un modelo que devuelve basura evidente no es un problema —
salta a la vista. El caso peligroso es el que devuelve algo bien formado, con su
fuente y su cita entre comillas, y resulta que la cita no está en ninguna parte.

Ninguna de estas pruebas llama al proveedor: se le da la respuesta ya escrita y
se verifica qué hace el worker con ella. Lo que se mide aquí es el contrato, no
la calidad del modelo —eso se mide contra el gold set (D0-13).
"""

from __future__ import annotations

import json
from typing import List

import pytest

from app import brief_schema, extraction
from app.extraction import ExtraccionInvalida, FragmentoDeEntrada, validar_y_anclar

TEXTO_A = (
    "El Reto | Posicionar la línea TCL P80 como la decisión inteligente del "
    "segmento medio-alto en Colombia. Presupuesto KOL: USD 55,000."
)
TEXTO_B = "Audiencia | Adultos de 25 a 40 años en Bogotá, Medellín y Cali."

FRAGMENTOS = [
    FragmentoDeEntrada(
        id="frag-a",
        source_id="src-1",
        filename="Brief P80.md",
        texto=TEXTO_A,
        section="El Reto",
        linea=12,
    ),
    FragmentoDeEntrada(
        id="frag-b",
        source_id="src-1",
        filename="Brief P80.md",
        texto=TEXTO_B,
        section="Audiencia",
        linea=23,
    ),
]


def _respuesta(campos: List[dict]) -> str:
    return json.dumps({"campos": campos}, ensure_ascii=False)


def _buscar(campos, key: str):
    return next(c for c in campos if c.key == key)


# ═══════════════════ E5-6 · La cita se verifica, no se cree ═══════════════════


def test_descarta_la_cita_que_no_esta_en_el_fragmento() -> None:
    """El fallo central: fuente real, cita inventada.

    Todo se ve bien —el fragment_id existe, hay comillas, hay un valor— y aun
    así la frase nunca se escribió. Si esto pasara, el brief tendría un claim
    con respaldo falso y nadie lo notaría hasta que el cliente lo leyera.
    """
    campos, descartes = validar_y_anclar(
        _respuesta(
            [
                {
                    "key": "mensaje_principal.beneficio_diferencial",
                    "value": "El televisor más vendido de Colombia",
                    "status": "found",
                    "evidence": [
                        {
                            "fragment_id": "frag-a",
                            "quote": "el televisor más vendido de Colombia",
                            "relation": "soporta",
                        }
                    ],
                }
            ]
        ),
        FRAGMENTOS,
    )

    campo = _buscar(campos, "mensaje_principal.beneficio_diferencial")
    assert campo.status == "not_found"
    assert campo.value is None
    assert campo.evidence == []
    assert any("no aparece en el fragmento" in d for d in descartes)


def test_acepta_la_cita_literal_aunque_cambien_espacios_y_comillas() -> None:
    """Un modelo reformatea espacios sin querer; eso no invalida la cita.

    Lo que sí la invalida es cambiar palabras. La normalización toca formato,
    nunca contenido.
    """
    campos, descartes = validar_y_anclar(
        _respuesta(
            [
                {
                    "key": "target_audiencia.descripcion",
                    "value": "Adultos de 25 a 40 años",
                    "status": "found",
                    "evidence": [
                        {
                            "fragment_id": "frag-b",
                            "quote": "Adultos  de 25 a 40 años   en Bogotá",
                            "relation": "soporta",
                        }
                    ],
                }
            ]
        ),
        FRAGMENTOS,
    )

    campo = _buscar(campos, "target_audiencia.descripcion")
    assert campo.status == "found"
    assert len(campo.evidence) == 1
    assert not [d for d in descartes if "target_audiencia.descripcion" in d]


def test_una_palabra_cambiada_ya_no_es_cita() -> None:
    campos, _ = validar_y_anclar(
        _respuesta(
            [
                {
                    "key": "target_audiencia.descripcion",
                    "value": "Adultos de 25 a 45 años",
                    "status": "found",
                    "evidence": [
                        {
                            "fragment_id": "frag-b",
                            "quote": "Adultos de 25 a 45 años en Bogotá",
                            "relation": "soporta",
                        }
                    ],
                }
            ]
        ),
        FRAGMENTOS,
    )
    assert _buscar(campos, "target_audiencia.descripcion").status == "not_found"


def test_descarta_un_fragment_id_inventado() -> None:
    _campos, descartes = validar_y_anclar(
        _respuesta(
            [
                {
                    "key": "contexto.situacion",
                    "value": "algo",
                    "status": "found",
                    "evidence": [
                        {"fragment_id": "frag-inexistente", "quote": "El Reto", "relation": "soporta"}
                    ],
                }
            ]
        ),
        FRAGMENTOS,
    )
    assert any("fragment_id inexistente" in d for d in descartes)


# ══════════════════════ E5-4 · Ausente es ausente ═════════════════════════════


def test_not_found_nunca_conserva_valor() -> None:
    """§9.4: la alternativa a no saber es decirlo, no rellenarlo."""
    campos, _ = validar_y_anclar(
        _respuesta(
            [
                {
                    "key": "practico.presupuesto",
                    "value": "USD 100,000",
                    "status": "not_found",
                    "confidence": 0.8,
                    "evidence": [],
                }
            ]
        ),
        FRAGMENTOS,
    )
    campo = _buscar(campos, "practico.presupuesto")
    assert campo.value is None
    assert campo.confidence is None


def test_el_campo_que_el_modelo_omite_se_declara_ausente() -> None:
    """Un campo que no vuelve no es un campo sin problema: es un hueco."""
    campos, _ = validar_y_anclar(_respuesta([]), FRAGMENTOS)

    assert len(campos) == len(brief_schema.campos_extraibles())
    assert all(c.status == "not_found" for c in campos)
    assert all(c.nota for c in campos)


def test_un_campo_critico_sin_evidencia_no_pasa_como_encontrado() -> None:
    """§15 exige respaldo. Sin él, el campo baja a not_found en vez de colarse."""
    campos, descartes = validar_y_anclar(
        _respuesta(
            [
                {
                    "key": "objetivo.negocio",
                    "value": "Vender más",
                    "status": "found",
                    "evidence": [],
                }
            ]
        ),
        FRAGMENTOS,
    )
    campo = _buscar(campos, "objetivo.negocio")
    assert campo.criticidad == "critico"
    assert campo.status == "not_found"
    assert any("sin evidencia verificable" in d for d in descartes)


def test_un_campo_informativo_si_puede_ir_sin_evidencia() -> None:
    """No todo exige respaldo: exigirlo en todo vaciaría el brief."""
    campos, _ = validar_y_anclar(
        _respuesta(
            [
                {
                    "key": "target_audiencia.comportamiento",
                    "value": "Compran en línea",
                    "status": "found",
                    "evidence": [],
                }
            ]
        ),
        FRAGMENTOS,
    )
    campo = _buscar(campos, "target_audiencia.comportamiento")
    assert campo.criticidad == "informativo"
    assert campo.status == "found"


# ═══════════════════ E5-5 · Un conflicto necesita dos partes ══════════════════


def test_conflicto_con_dos_evidencias_verificadas_se_conserva() -> None:
    campos, _ = validar_y_anclar(
        _respuesta(
            [
                {
                    "key": "contexto.situacion",
                    "value": None,
                    "status": "conflict",
                    "evidence": [
                        {"fragment_id": "frag-a", "quote": "segmento medio-alto", "relation": "soporta"},
                        {"fragment_id": "frag-b", "quote": "Adultos de 25 a 40 años", "relation": "contradice"},
                    ],
                }
            ]
        ),
        FRAGMENTOS,
    )
    campo = _buscar(campos, "contexto.situacion")
    assert campo.status == "conflict"
    assert campo.value is None
    assert len(campo.evidence) == 2


def test_conflicto_con_una_sola_evidencia_no_es_conflicto() -> None:
    """Sin las dos partes no hay nada que comparar: es una afirmación suelta."""
    campos, descartes = validar_y_anclar(
        _respuesta(
            [
                {
                    "key": "contexto.situacion",
                    "value": None,
                    "status": "conflict",
                    "evidence": [
                        {"fragment_id": "frag-a", "quote": "segmento medio-alto", "relation": "soporta"}
                    ],
                }
            ]
        ),
        FRAGMENTOS,
    )
    campo = _buscar(campos, "contexto.situacion")
    assert campo.status == "not_found"
    assert any("hacen falta dos" in d for d in descartes)


def test_conflicto_pierde_una_evidencia_por_cita_falsa_y_deja_de_serlo() -> None:
    """Los dos filtros compuestos: una cita falsa deshace el conflicto."""
    campos, _ = validar_y_anclar(
        _respuesta(
            [
                {
                    "key": "contexto.situacion",
                    "value": None,
                    "status": "conflict",
                    "evidence": [
                        {"fragment_id": "frag-a", "quote": "segmento medio-alto", "relation": "soporta"},
                        {"fragment_id": "frag-b", "quote": "esto nunca se escribió", "relation": "contradice"},
                    ],
                }
            ]
        ),
        FRAGMENTOS,
    )
    assert _buscar(campos, "contexto.situacion").status == "not_found"


# ═══════════════════ E5-3 · La salida inválida no se persiste ═════════════════


def test_una_respuesta_que_no_es_json_se_rechaza() -> None:
    with pytest.raises(ExtraccionInvalida):
        validar_y_anclar("Claro, aquí tienes el brief que me pediste.", FRAGMENTOS)


def test_json_envuelto_en_bloque_de_codigo_se_acepta() -> None:
    """Es la desviación más común, y no vale la pena perder una extracción por ella."""
    envuelto = "```json\n" + _respuesta([]) + "\n```"
    campos, _ = validar_y_anclar(envuelto, FRAGMENTOS)
    assert len(campos) == len(brief_schema.campos_extraibles())


def test_una_clave_fuera_del_esquema_se_descarta() -> None:
    _campos, descartes = validar_y_anclar(
        _respuesta([{"key": "campo.inventado", "value": "x", "status": "found", "evidence": []}]),
        FRAGMENTOS,
    )
    assert any("fuera del esquema" in d for d in descartes)


def test_un_estado_fuera_del_enum_se_descarta() -> None:
    _campos, descartes = validar_y_anclar(
        _respuesta([{"key": "contexto.situacion", "value": "x", "status": "quizas", "evidence": []}]),
        FRAGMENTOS,
    )
    assert any("estado inválido" in d for d in descartes)


def test_sin_fragmentos_no_se_llama_al_modelo() -> None:
    with pytest.raises(ValueError):
        extraction.extraer([])


# ═══════════════════════════ El prompt y su forma ═════════════════════════════


def test_el_prompt_lleva_los_localizadores_de_cada_formato() -> None:
    """DEC-018: el localizador depende de lo que el formato realmente ofrece."""
    bloque = extraction._bloque_de_fragmentos(
        [
            FragmentoDeEntrada("f1", "s", "Deck.pptx", "texto", slide=7),
            FragmentoDeEntrada("f2", "s", "Brief.md", "texto", section="El Reto", linea=12),
            FragmentoDeEntrada("f3", "s", "Ficha.pdf", "texto", page=3),
        ]
    )
    assert "diapositiva 7" in bloque
    assert "sección «El Reto», línea 12" in bloque
    assert "página 3" in bloque


def test_el_prompt_marca_los_campos_que_exigen_evidencia() -> None:
    prompt = extraction._instrucciones(brief_schema.campos_extraibles())
    assert "objetivo.negocio [CRÍTICO]" in prompt
    assert "[CLAIM — exige evidencia]" in prompt
