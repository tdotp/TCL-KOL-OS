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
    FragmentoDeEntrada(
        id="frag-c",
        source_id="src-1",
        filename="Brief P80.md",
        texto=(
            "FECHA | Lanzamiento: Septiembre-Octubre 2026 · Sostenimiento: "
            "Octubre-Noviembre 2026. IFA Berlín: 4 de septiembre 2026."
        ),
        section="Hitos clave",
        linea=5,
    ),
]


def _respuesta(campos: list[dict]) -> str:
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


# ═══════════════ Campos de lista cerrada (el fallo de contexto.situacion) ═════


def test_un_valor_fuera_del_enum_no_se_persiste() -> None:
    """`objetivo.tipo` solo admite cinco valores. Lo demás no es aproximado: es inválido.

    Aceptarlo trasladaría el fallo al esquema, más tarde y más lejos de su
    causa: el campo pasaría la extracción y reventaría al validar el brief.
    """
    campos, descartes = validar_y_anclar(
        _respuesta(
            [
                {
                    "key": "objetivo.tipo",
                    "value": "vender muchos teléfonos",
                    "status": "found",
                    "evidence": [],
                }
            ]
        ),
        FRAGMENTOS,
    )
    campo = _buscar(campos, "objetivo.tipo")
    assert campo.status == "not_found"
    assert campo.value is None
    assert any("no está entre los valores permitidos" in d for d in descartes)


def test_el_enum_se_normaliza_en_vez_de_perderse_por_mayusculas() -> None:
    """«Awareness» y «awareness» son el mismo valor. Perder uno por la caja sería absurdo."""
    campos, _ = validar_y_anclar(
        _respuesta(
            [
                {
                    "key": "objetivo.tipo",
                    "value": "Awareness",
                    "status": "found",
                    "evidence": [
                        {"fragment_id": "frag-a", "quote": "El Reto", "relation": "soporta"}
                    ],
                }
            ]
        ),
        FRAGMENTOS,
    )
    campo = _buscar(campos, "objetivo.tipo")
    assert campo.status == "found"
    assert campo.value == "awareness"


def test_el_prompt_nombra_los_valores_permitidos() -> None:
    """Sin la lista, el campo es inadivinable — fue la causa real del not_found."""
    prompt = extraction._instrucciones(brief_schema.campos_extraibles())
    assert "Valores permitidos (use exactamente uno): awareness, consideration" in prompt


def test_el_prompt_lleva_la_descripcion_de_cada_campo() -> None:
    """Una clave con puntos no dice qué se busca.

    `contexto.situacion` a secas hizo que el modelo archivara «El Reto» bajo
    `practico.restricciones`, que desde el nombre es una lectura razonable.
    """
    campos = brief_schema.campos_extraibles()
    assert all(c.descripcion for c in campos), "Hay campos que llegan al prompt sin descripción"

    prompt = extraction._instrucciones(campos)
    assert "Situación de mercado y reto que enfrenta la marca" in prompt
    # Y la que separa los dos campos que se confundían:
    assert "NO confundir con la situación de mercado" in prompt


def test_una_respuesta_vacia_no_se_confunde_con_una_truncada() -> None:
    """Dos fallos distintos con remedios opuestos: reintentar vs. subir max_tokens.

    Un mensaje que culpa al tope de tokens cuando el proveedor devolvió nada
    manda a quien lo lea a agrandar un presupuesto que no era el problema.
    """
    with pytest.raises(ExtraccionInvalida, match="vacía o casi vacía"):
        validar_y_anclar('{"', FRAGMENTOS)

    with pytest.raises(ExtraccionInvalida, match="cortada a mitad"):
        validar_y_anclar('{"campos": [{"key": "contexto.situacion", "value": "algo sin cerrar', FRAGMENTOS)


# ═════════════ La forma del valor: 15 de 41 campos no son texto ═══════════════


def test_una_lista_no_se_guarda_como_texto_con_comas() -> None:
    """`marca_producto[].rtbs` es una lista en el esquema.

    Guardar «uno, dos, tres» como cadena pasa la extracción y revienta al
    ensamblar el brief, lejos de aquí y sin rastro de su causa.
    """
    campos, _ = validar_y_anclar(
        _respuesta(
            [
                {
                    "key": "marca_producto[].rtbs",
                    "value": ["Pantalla AMOLED 1.5K", "Batería de 5000 mAh"],
                    "status": "found",
                    "evidence": [
                        {"fragment_id": "frag-a", "quote": "El Reto", "relation": "soporta"}
                    ],
                }
            ]
        ),
        FRAGMENTOS,
    )
    campo = _buscar(campos, "marca_producto[].rtbs")
    assert campo.value == ["Pantalla AMOLED 1.5K", "Batería de 5000 mAh"]


def test_un_texto_donde_va_una_lista_se_recupera_como_lista_de_uno() -> None:
    """Es un desliz de forma, no de contenido: no vale la pena perder el dato."""
    campos, _ = validar_y_anclar(
        _respuesta(
            [
                {
                    "key": "accion_kpis.kpis",
                    "value": "Cobertura en medios Tier 1",
                    "status": "found",
                    "evidence": [],
                }
            ]
        ),
        FRAGMENTOS,
    )
    assert _buscar(campos, "accion_kpis.kpis").value == ["Cobertura en medios Tier 1"]


def test_un_mes_sin_respaldo_en_cita_sigue_rechazado() -> None:
    """«Septiembre 2026» no aparece en la cita («El Reto»): sigue sin aceptarse.

    DEC-026 deja de forzar `not_found` para una fecha imprecisa, pero eso no
    afloja la verificación: la precisión que se acepte tiene que desprenderse
    de una cita real, igual que cualquier otro valor.
    """
    campos, descartes = validar_y_anclar(
        _respuesta(
            [
                {
                    "key": "practico.fecha_inicio",
                    "value": "Septiembre 2026",
                    "status": "found",
                    "evidence": [
                        {"fragment_id": "frag-a", "quote": "El Reto", "relation": "soporta"}
                    ],
                }
            ]
        ),
        FRAGMENTOS,
    )
    campo = _buscar(campos, "practico.fecha_inicio")
    assert campo.status == "not_found"
    assert campo.value is None
    assert any("no aparece en ninguna cita" in d for d in descartes)


def test_un_mes_respaldado_por_cita_queda_found_con_precision_mes() -> None:
    """DEC-026: una fecha imprecisa respaldada por su cita es un valor válido.

    «Septiembre 2026», citado literalmente, ya no baja a `not_found`: queda
    `found` con `tipo: 'mes'` — la precisión real que sí tiene la fuente,
    conservando el texto original.
    """
    fragmento_mes = FragmentoDeEntrada(
        id="frag-mes",
        source_id="src-1",
        filename="Brief P80.md",
        texto="Arranca la campaña: Septiembre 2026, sin fecha exacta todavía.",
        section="Hitos clave",
        linea=6,
    )
    campos, _ = validar_y_anclar(
        _respuesta(
            [
                {
                    "key": "practico.fecha_inicio",
                    "value": "Septiembre 2026",
                    "status": "found",
                    "evidence": [
                        {
                            "fragment_id": "frag-mes",
                            "quote": "Septiembre 2026",
                            "relation": "soporta",
                        }
                    ],
                }
            ]
        ),
        [*FRAGMENTOS, fragmento_mes],
    )
    campo = _buscar(campos, "practico.fecha_inicio")
    assert campo.status == "found"
    assert campo.value == {"tipo": "mes", "fecha": "2026-09", "textoOriginal": "Septiembre 2026"}


def test_un_rango_respaldado_por_cita_queda_found_con_precision_rango() -> None:
    """DEC-026: «Octubre-Noviembre 2026» conserva el rango, no un día inventado."""
    campos, _ = validar_y_anclar(
        _respuesta(
            [
                {
                    "key": "practico.fecha_fin",
                    "value": "Octubre-Noviembre 2026",
                    "status": "found",
                    "evidence": [
                        {
                            "fragment_id": "frag-c",
                            "quote": "Sostenimiento: Octubre-Noviembre 2026",
                            "relation": "soporta",
                        }
                    ],
                }
            ]
        ),
        FRAGMENTOS,
    )
    campo = _buscar(campos, "practico.fecha_fin")
    assert campo.status == "found"
    assert campo.value == {
        "tipo": "rango",
        "inicio": "2026-10-01",
        "fin": "2026-11-30",
        "textoOriginal": "Octubre-Noviembre 2026",
    }


def test_una_fecha_iso_respaldada_por_su_cita_se_acepta() -> None:
    """El día tiene que estar escrito en la cita, no solo el mes."""
    campos, _ = validar_y_anclar(
        _respuesta(
            [
                {
                    "key": "practico.fecha_inicio",
                    "value": "2026-09-04",
                    "status": "found",
                    "evidence": [
                        {"fragment_id": "frag-c", "quote": "4 de septiembre 2026", "relation": "soporta"}
                    ],
                }
            ]
        ),
        FRAGMENTOS,
    )
    campo = _buscar(campos, "practico.fecha_inicio")
    assert campo.status == "found"
    assert campo.value == {"tipo": "exacta", "fecha": "2026-09-04", "textoOriginal": "2026-09-04"}


def test_una_fecha_con_dia_inventado_se_rechaza_aunque_la_cita_sea_real() -> None:
    """El hueco que dejaba verificar solo la cita.

    «Sostenimiento: Octubre-Noviembre 2026» es una cita literal y verificable, y
    aun así `2026-11-30` es un día que nadie escribió. Comprobar que la cita
    existe no comprueba que el valor se desprenda de ella; para una fecha sí se
    puede comprobar, y se comprueba.

    Ocurrió de verdad contra el material de la campaña P80.
    """
    campos, descartes = validar_y_anclar(
        _respuesta(
            [
                {
                    "key": "practico.fecha_fin",
                    "value": "2026-11-30",
                    "status": "found",
                    "evidence": [
                        {
                            "fragment_id": "frag-c",
                            "quote": "Sostenimiento: Octubre-Noviembre 2026",
                            "relation": "soporta",
                        }
                    ],
                }
            ]
        ),
        FRAGMENTOS,
    )
    campo = _buscar(campos, "practico.fecha_fin")
    assert campo.status == "not_found"
    assert campo.value is None
    assert any("no está escrita en ninguna cita" in d for d in descartes)


def test_mandatorios_exige_su_estructura_de_objetos() -> None:
    """El esquema pide {categoria, descripcion}; un texto suelto no sirve."""
    campos, descartes = validar_y_anclar(
        _respuesta(
            [
                {
                    "key": "mandatorios",
                    "value": "Usar el logo oficial",
                    "status": "found",
                    "evidence": [
                        {"fragment_id": "frag-a", "quote": "El Reto", "relation": "soporta"}
                    ],
                }
            ]
        ),
        FRAGMENTOS,
    )
    assert _buscar(campos, "mandatorios").status == "not_found"
    assert any("lista de objetos" in d for d in descartes)


def test_mandatorios_con_la_estructura_correcta_se_acepta() -> None:
    campos, _ = validar_y_anclar(
        _respuesta(
            [
                {
                    "key": "mandatorios",
                    "value": [{"categoria": "identidad", "descripcion": "Usar el logo oficial"}],
                    "status": "found",
                    "evidence": [
                        {"fragment_id": "frag-a", "quote": "El Reto", "relation": "soporta"}
                    ],
                }
            ]
        ),
        FRAGMENTOS,
    )
    campo = _buscar(campos, "mandatorios")
    assert campo.status == "found"
    assert campo.value == [{"categoria": "identidad", "descripcion": "Usar el logo oficial"}]


def test_toda_forma_del_esquema_tiene_traduccion_al_prompt() -> None:
    """Una forma nueva en el esquema no puede quedarse muda en el prompt."""
    formas = {c.forma for c in brief_schema.campos_extraibles()}
    sin_explicar = formas - set(extraction._FORMA_EN_PALABRAS) - {"texto", "enum"}
    assert not sin_explicar, f"Formas sin explicación en el prompt: {sin_explicar}"
