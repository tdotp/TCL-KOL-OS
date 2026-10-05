"""Regresión del endurecimiento de `/modelo/turno` (QA-17..QA-22)."""

from __future__ import annotations

import json

import pytest

from app import modelo_turno as mt


def test_think_sin_cerrar_se_descarta_hasta_el_final() -> None:
    assert mt._RE_PENSAMIENTO.sub("", "Hola <think>secreto sin cerrar").strip() == "Hola"
    assert mt._RE_PENSAMIENTO.sub("", "A <think>x</think> B").strip() == "A  B"


def test_cuerpo_con_nan_o_infinito_se_rechaza() -> None:
    for crudo in (b'{"a": NaN}', b'{"a": Infinity}', b'{"a": 1e999}', b'{"a": [-Infinity]}'):
        with pytest.raises(mt.TurnoError) as e:
            mt.parsear_entrada(crudo)
        assert e.value.code == "REQUEST_INVALID" and e.value.status == 422


def test_bomba_de_anidamiento_es_request_invalid() -> None:
    with pytest.raises(mt.TurnoError) as e:
        mt.parsear_entrada(b"[" * 200_000 + b"]" * 200_000)
    assert e.value.code == "REQUEST_INVALID"


def test_todo_finito_no_recursivo() -> None:
    profundo: object = 1.0
    for _ in range(50_000):
        profundo = [profundo]
    assert mt._todo_finito(profundo) is True
    assert mt._todo_finito({"a": [float("inf")]}) is False


def test_sanear_para_log_elimina_saltos_y_controles() -> None:
    s = mt.sanear_para_log("m\nINFO falso\r\x1b[0m x")
    assert "\n" not in s and "\r" not in s and "\x1b" not in s and " " not in s
    assert len(mt.sanear_para_log("a" * 1000)) == 120


def test_argumentos_de_respuesta_no_finitos_son_bad_response() -> None:
    from app.ai.openrouter import LlamadaHerramienta

    llamada = LlamadaHerramienta(id="c1", nombre="t", argumentos=json.dumps({"x": 1}).replace("1", "1e999"))
    with pytest.raises(mt.TurnoError) as e:
        mt._argumentos(llamada)
    assert e.value.code == "MODEL_BAD_RESPONSE"
