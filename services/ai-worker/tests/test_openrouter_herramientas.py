# ruff: noqa: E501 — tablas de casos largas
"""Adaptador OpenRouter: tool calling y clasificación de fallos (V2 · Fase 6).

Sin red: se sustituye `urllib.request.urlopen`. Verifica que la extensión es
aditiva (la extracción actual no cambia) y que el razonamiento del proveedor no
se lee ni se propaga.
"""

from __future__ import annotations

import email.message
import io
import json
import socket
import urllib.error
from typing import Any

import pytest

from app.ai import openrouter
from app.ai.openrouter import AIError

TOOLS = [
    {
        "type": "function",
        "function": {"name": "campaign_get", "description": "d", "parameters": {"type": "object"}},
    }
]


class _Resp:
    def __init__(self, payload: Any) -> None:
        self._b = payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8")

    def __enter__(self) -> _Resp:
        return self

    def __exit__(self, *_a: Any) -> None:
        return None

    def read(self) -> bytes:
        return self._b


@pytest.fixture(autouse=True)
def _clave(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_API_KEY", "clave-de-prueba-no-real")


def _instalar(monkeypatch: pytest.MonkeyPatch, resultado: Any) -> list[dict[str, Any]]:
    visto: list[dict[str, Any]] = []

    def falso(peticion: Any, timeout: float) -> Any:
        visto.append({"cuerpo": json.loads(peticion.data), "timeout": timeout, "url": peticion.full_url})
        if isinstance(resultado, BaseException):
            raise resultado
        return _Resp(resultado)

    monkeypatch.setattr(openrouter.urllib.request, "urlopen", falso)
    return visto


def _http_error(codigo: int, cuerpo: Any = None, cabeceras: dict[str, str] | None = None) -> urllib.error.HTTPError:
    hdrs = email.message.Message()
    for k, v in (cabeceras or {}).items():
        hdrs[k] = v
    datos = json.dumps(cuerpo if cuerpo is not None else {"error": {"message": "x"}}).encode("utf-8")
    return urllib.error.HTTPError("https://openrouter.ai/api/v1/chat/completions", codigo, "x", hdrs, io.BytesIO(datos))


def _payload(message: dict[str, Any], finish: str = "stop") -> dict[str, Any]:
    return {
        "id": "gen-abc",
        "model": "proveedor/modelo",
        "choices": [{"finish_reason": finish, "message": message}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 4, "total_tokens": 14, "cost": 0.0003},
    }


def _llamar(**kw: Any) -> openrouter.RespuestaHerramientas:
    return openrouter.completar_con_herramientas(
        "m", [{"role": "user", "content": "hola"}], TOOLS, **kw
    )


def test_cuerpo_enviado_con_tools_y_privacidad(monkeypatch: pytest.MonkeyPatch) -> None:
    visto = _instalar(monkeypatch, _payload({"content": "ok"}))
    _llamar(tool_choice="required", max_tokens=300, timeout=20)

    cuerpo = visto[0]["cuerpo"]
    assert visto[0]["timeout"] == 20
    assert cuerpo["tools"] == TOOLS
    assert cuerpo["tool_choice"] == "required"
    assert cuerpo["parallel_tool_calls"] is False
    assert cuerpo["max_tokens"] == 300
    assert cuerpo["provider"]["data_collection"] == "deny"  # DEC-019 se conserva
    assert cuerpo["provider"]["require_parameters"] is True
    assert cuerpo["usage"] == {"include": True}
    assert "response_format" not in cuerpo


def test_sin_tools_no_se_envia_tool_choice(monkeypatch: pytest.MonkeyPatch) -> None:
    visto = _instalar(monkeypatch, _payload({"content": "ok"}))
    openrouter.completar_con_herramientas("m", [{"role": "user", "content": "x"}], [])
    assert "tools" not in visto[0]["cuerpo"]
    assert "tool_choice" not in visto[0]["cuerpo"]
    assert "parallel_tool_calls" not in visto[0]["cuerpo"]


def test_parsea_tool_calls_con_content_nulo(monkeypatch: pytest.MonkeyPatch) -> None:
    _instalar(
        monkeypatch,
        _payload(
            {
                "content": None,
                "tool_calls": [
                    {"id": "c1", "type": "function", "function": {"name": "campaign_get", "arguments": "{}"}},
                    {"id": "c2", "type": "function", "function": {"name": "x", "arguments": {"a": 1}}},
                ],
            },
            "tool_calls",
        ),
    )
    r = _llamar()
    assert r.contenido is None
    assert [(c.id, c.nombre, c.argumentos) for c in r.llamadas] == [
        ("c1", "campaign_get", "{}"),
        ("c2", "x", '{"a": 1}'),
    ]
    assert r.finish_reason == "tool_calls"
    assert r.uso.costo_usd == 0.0003
    assert r.generacion_id == "gen-abc"


def test_no_lee_ni_propaga_el_razonamiento_del_proveedor(monkeypatch: pytest.MonkeyPatch) -> None:
    _instalar(
        monkeypatch,
        _payload(
            {
                "content": "respuesta",
                "reasoning": "RAZONAMIENTO-SECRETO",
                "reasoning_details": [{"type": "reasoning.text", "text": "RAZONAMIENTO-SECRETO"}],
            }
        ),
    )
    r = _llamar()
    assert r.contenido == "respuesta"
    assert "RAZONAMIENTO-SECRETO" not in repr(r)


def test_estructura_inesperada_es_error_tipificado(monkeypatch: pytest.MonkeyPatch) -> None:
    for message in (
        {"tool_calls": ["no-es-objeto"]},
        {"tool_calls": 5},
    ):
        _instalar(monkeypatch, _payload(message))
        with pytest.raises(AIError) as e:
            _llamar()
        assert e.value.categoria == openrouter.CAT_RESPUESTA


def test_sin_choices_y_cuerpo_no_json(monkeypatch: pytest.MonkeyPatch) -> None:
    _instalar(monkeypatch, {"choices": []})
    with pytest.raises(AIError) as e1:
        _llamar()
    assert e1.value.categoria == openrouter.CAT_RESPUESTA

    _instalar(monkeypatch, b"<html>502</html>")
    with pytest.raises(AIError) as e2:
        _llamar()
    assert e2.value.categoria == openrouter.CAT_RESPUESTA


@pytest.mark.parametrize(
    ("error", "categoria", "status", "retryable", "retry_after"),
    [
        (_http_error(429, cabeceras={"Retry-After": "12"}), openrouter.CAT_LIMITE, 429, True, 12),
        (_http_error(429, cabeceras={"Retry-After": "no-es-numero"}), openrouter.CAT_LIMITE, 429, True, None),
        (_http_error(429, cabeceras={"Retry-After": "99999"}), openrouter.CAT_LIMITE, 429, True, 300),
        (_http_error(429), openrouter.CAT_LIMITE, 429, True, None),
        (_http_error(503), openrouter.CAT_UPSTREAM, 503, True, None),
        (_http_error(500), openrouter.CAT_UPSTREAM, 500, True, None),
        (_http_error(401), openrouter.CAT_AUTENTICACION, 401, False, None),
        (_http_error(402), openrouter.CAT_UPSTREAM, 402, False, None),
        (_http_error(400, {"error": {"message": "bad param"}}), openrouter.CAT_UPSTREAM, 400, False, None),
        (
            _http_error(400, {"error": {"message": "This model's maximum context length is 8192 tokens"}}),
            openrouter.CAT_CONTEXTO,
            400,
            False,
            None,
        ),
        (_http_error(413), openrouter.CAT_CONTEXTO, 413, False, None),
        (TimeoutError(), openrouter.CAT_TIMEOUT, None, True, None),
        (socket.timeout(), openrouter.CAT_TIMEOUT, None, True, None),  # noqa: UP041 — alias en 3.9
        (urllib.error.URLError(socket.timeout()), openrouter.CAT_TIMEOUT, None, True, None),  # noqa: UP041
        (urllib.error.URLError("dns"), openrouter.CAT_UPSTREAM, None, True, None),
    ],
)
def test_clasificacion_de_fallos_http(
    monkeypatch: pytest.MonkeyPatch,
    error: Exception,
    categoria: str,
    status: int | None,
    retryable: bool,
    retry_after: int | None,
) -> None:
    _instalar(monkeypatch, error)
    with pytest.raises(AIError) as e:
        _llamar()
    assert e.value.categoria == categoria
    assert e.value.status == status
    assert e.value.retryable is retryable
    assert e.value.retry_after_s == retry_after


def test_sin_clave_es_no_configurado(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("AI_API_KEY", raising=False)
    with pytest.raises(AIError) as e:
        _llamar()
    assert e.value.categoria == openrouter.CAT_NO_CONFIGURADO


def test_aierror_sigue_construyendose_con_solo_mensaje() -> None:
    """Compatibilidad: la extracción y sus pruebas crean/capturan `AIError("texto")`."""
    e = AIError("texto")
    assert str(e) == "texto"
    assert e.categoria == openrouter.CAT_UPSTREAM
    assert e.status is None and e.retryable is False and e.retry_after_s is None


def test_completar_de_extraccion_no_cambia(monkeypatch: pytest.MonkeyPatch) -> None:
    visto = _instalar(monkeypatch, _payload({"content": '{"campos": []}'}))
    r = openrouter.completar("m", [{"role": "user", "content": "x"}], formato_json=True)
    assert r.contenido == '{"campos": []}'
    cuerpo = visto[0]["cuerpo"]
    assert cuerpo["response_format"] == {"type": "json_object"}
    assert "tools" not in cuerpo
    assert cuerpo["provider"] == {"data_collection": "deny", "allow_fallbacks": True}
