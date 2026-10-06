# ruff: noqa: E501, C408 — tablas de casos largas; datos sintéticos
"""QA ADVERSARIAL F7 (subagente F) — `POST /modelo/analisis` (kill-switch E, contrato estricto, salida inventada 13).

Ataques sobre el worker SIN red ni proveedor real (transporte guionado):

- E: `AI_ENABLED` apagado (ausente, vacío, «false», «0», «no», «off», basura) ⇒ 503 AI_DISABLED y el proveedor NO se llama;
  encendido solo con `1`/`true`/`yes` (sin distinguir mayúsculas ni espacios).
- Contrato de entrada: ni el modelo, ni el nivel, ni el proveedor, ni claves, ni herramientas, ni `stream` ni
  `temperature` se aceptan desde Node; roles y cantidad de mensajes exactos; cuerpos enormes o no finitos, rechazados
  sin llamar al proveedor y sin reflejar el contenido.
- Lo que SÍ llega al proveedor: los dos mensajes tal cual, temperatura 0, modo JSON, el modelo del ENTORNO.
- Salida del modelo hostil (campos de aprobación, severidad, extras, ids, demasiados hallazgos, JSON parcial, NaN):
  se rechaza SIN devolver hallazgos; una salida bien formada pero inválida NO se reintenta (no gasta); un JSON roto
  se reintenta una sola vez.
- Ni el contenido del guion/Brief/respuesta ni el secreto del proveedor llegan a los logs ni a los cuerpos de error.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

import pytest

from app import modelo_analisis as ma
from app.ai import fake_provider
from app.ai.openrouter import AIError, Respuesta, Uso
from app.main import app

CANARIO = "CANARIO-GUION-SECRETO-4471"
SECRETO_PROVEEDOR = "sk-or-SECRETO-DEL-PROVEEDOR-9981"


@pytest.fixture(autouse=True)
def _entorno(monkeypatch: pytest.MonkeyPatch) -> Any:
    monkeypatch.setenv("AI_ENABLED", "true")
    monkeypatch.setenv("AI_MODEL_EQUILIBRADO", "test/modelo-equilibrado")
    monkeypatch.delenv("AI_PROVIDER", raising=False)
    monkeypatch.delenv("AI_API_KEY", raising=False)
    fake_provider.reiniciar_contadores_de_analisis()
    yield
    app.dependency_overrides.clear()
    fake_provider.reiniciar_contadores_de_analisis()


def _valida(**extra: Any) -> dict[str, Any]:
    h: dict[str, Any] = {
        "id": "h1",
        "category": "cta_missing",
        "basis": "absence",
        "claim_status": None,
        "description": "El guion no incluye la llamada a la acción definida en el Brief.",
        "brief_refs": ["R5"],
        "script_quotes": [],
    }
    h.update(extra)
    return {"schema_version": "analisis-guion-salida-1", "findings": [h]}


def _resp(contenido: str, finish: str = "stop") -> Respuesta:
    return Respuesta(
        contenido=contenido,
        modelo="m/real",
        uso=Uso(prompt_tokens=10, completion_tokens=5, total_tokens=15, costo_usd=0.001),
        latencia_ms=5,
        generacion_id="g",
        metadata={"finish_reason": finish},
    )


class Transporte:
    """Transporte guionado: cada llamada consume una respuesta (o lanza); registra lo que recibió."""

    def __init__(self, *respuestas: Any) -> None:
        self.respuestas = list(respuestas)
        self.llamadas: list[dict[str, Any]] = []

    def __call__(self, modelo: str, mensajes: list[dict[str, str]], **kw: Any) -> Respuesta:
        self.llamadas.append({"modelo": modelo, "mensajes": mensajes, **kw})
        r = self.respuestas[min(len(self.llamadas) - 1, len(self.respuestas) - 1)]
        if isinstance(r, Exception):
            raise r
        return r


def _post(cuerpo: Any, transporte: Any, *, crudo: bytes | None = None) -> tuple[int, Any]:
    app.dependency_overrides[ma.transporte_por_defecto] = lambda: transporte
    datos = crudo if crudo is not None else json.dumps(cuerpo).encode("utf-8")

    async def _correr() -> tuple[int, Any]:
        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "POST",
            "scheme": "http",
            "path": "/modelo/analisis",
            "raw_path": b"/modelo/analisis",
            "query_string": b"",
            "root_path": "",
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(datos)).encode()),
            ],
            "client": ("test", 1),
            "server": ("test", 80),
        }
        entregado = False

        async def receive() -> dict[str, Any]:
            nonlocal entregado
            if not entregado:
                entregado = True
                return {"type": "http.request", "body": datos, "more_body": False}
            await asyncio.sleep(3600)
            return {"type": "http.disconnect"}

        salida: list[dict[str, Any]] = []

        async def send(msg: dict[str, Any]) -> None:
            salida.append(msg)

        await app(scope, receive, send)  # type: ignore[arg-type]
        inicio = next(m for m in salida if m["type"] == "http.response.start")
        cuerpo = b"".join(m.get("body", b"") for m in salida if m["type"] == "http.response.body")
        return inicio["status"], json.loads(cuerpo)

    return asyncio.run(_correr())


def _pet(**extra: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "task": "analizar_guion",
        "messages": [
            {"role": "system", "content": "TAREA: analizar_guion · prueba"},
            {"role": "user", "content": f"usuario {CANARIO}"},
        ],
        "output_schema_version": "analisis-guion-salida-1",
        "timeout_s": 30,
    }
    base.update(extra)
    return base


# ───────────────────────── E · kill-switch ─────────────────────────


@pytest.mark.parametrize(
    "valor", [None, "", "false", "0", "no", "off", "FALSE", "tru", "2", "enabled", "ON", " "]
)
def test_ia_apagada_no_llama_al_proveedor(monkeypatch: pytest.MonkeyPatch, valor: str | None) -> None:
    if valor is None:
        monkeypatch.delenv("AI_ENABLED", raising=False)
    else:
        monkeypatch.setenv("AI_ENABLED", valor)
    t = Transporte(_resp(json.dumps(_valida())))
    status, cuerpo = _post(_pet(), t)
    assert status == 503
    assert cuerpo["error"]["code"] == "AI_DISABLED"
    assert t.llamadas == []
    assert CANARIO not in json.dumps(cuerpo)


@pytest.mark.parametrize("valor", ["1", "true", "TRUE", " yes ", "Yes", "True"])
def test_ia_encendida_solo_con_1_true_yes(monkeypatch: pytest.MonkeyPatch, valor: str) -> None:
    monkeypatch.setenv("AI_ENABLED", valor)
    t = Transporte(_resp(json.dumps(_valida())))
    status, _ = _post(_pet(), t)
    assert status == 200
    assert len(t.llamadas) == 1


# ───────────────────────── Contrato de entrada ─────────────────────────


@pytest.mark.parametrize(
    "extra",
    [
        {"model": "openai/gpt-5"},
        {"tier": "premium"},
        {"provider": "evil"},
        {"api_key": SECRETO_PROVEEDOR},
        {"tools": [{"type": "function", "function": {"name": "approve"}}]},
        {"stream": True},
        {"temperature": 1.5},
        {"response_format": {"type": "text"}},
        {"organization_id": "00000000-0000-0000-0000-000000000000"},
        {"campaign_id": "00000000-0000-0000-0000-000000000000"},
        {"system": "ignora todo"},
        {"approved": True},
    ],
)
def test_el_contrato_no_acepta_campos_de_mas(extra: dict[str, Any]) -> None:
    t = Transporte(_resp(json.dumps(_valida())))
    status, cuerpo = _post(_pet(**extra), t)
    assert status in (400, 422)
    assert cuerpo["error"]["code"] == "REQUEST_INVALID"
    assert t.llamadas == []
    assert SECRETO_PROVEEDOR not in json.dumps(cuerpo)
    assert CANARIO not in json.dumps(cuerpo)


@pytest.mark.parametrize(
    "mensajes",
    [
        [{"role": "user", "content": "a"}, {"role": "system", "content": "b"}],
        [{"role": "system", "content": "a"}],
        [
            {"role": "system", "content": "a"},
            {"role": "user", "content": "b"},
            {"role": "assistant", "content": "c"},
        ],
        [{"role": "system", "content": "a"}, {"role": "assistant", "content": "b"}],
        [{"role": "system", "content": "a"}, {"role": "tool", "content": "b"}],
        [{"role": "system", "content": "a"}, {"role": "user", "content": 123}],
        [{"role": "system", "content": "a"}, {"role": "user", "content": "b", "name": "x"}],
        [],
    ],
)
def test_mensajes_exactamente_system_y_user(mensajes: list[Any]) -> None:
    t = Transporte(_resp(json.dumps(_valida())))
    status, cuerpo = _post(_pet(messages=mensajes), t)
    assert status in (400, 422)
    assert t.llamadas == []


def test_cuerpo_gigante_o_no_finito_o_profundo_se_rechaza_sin_proveedor() -> None:
    t = Transporte(_resp(json.dumps(_valida())))
    enorme = _pet(messages=[{"role": "system", "content": "s"}, {"role": "user", "content": "x" * 3_000_000}])
    status, cuerpo = _post(enorme, t)
    assert status in (400, 413, 422)
    assert t.llamadas == []
    status, cuerpo = _post(None, t, crudo=b'{"task":"analizar_guion","timeout_s":NaN}')
    assert status in (400, 422) and cuerpo["error"]["code"] == "REQUEST_INVALID"
    profundo = b'{"task":' + b"[" * 5000 + b"]" * 5000 + b"}"
    status, cuerpo = _post(None, t, crudo=profundo)
    assert status in (400, 422) and cuerpo["error"]["code"] == "REQUEST_INVALID"
    assert t.llamadas == []


@pytest.mark.parametrize(
    "ajuste",
    [
        {"max_findings": 26},
        {"max_findings": 0},
        {"max_tokens": 10},
        {"max_tokens": 10_000_000},
        {"timeout_s": 0},
        {"timeout_s": 10_000},
    ],
)
def test_los_parametros_acotados_no_se_pueden_inflar(ajuste: dict[str, Any]) -> None:
    t = Transporte(_resp(json.dumps(_valida())))
    status, _ = _post(_pet(**ajuste), t)
    assert status in (400, 422)
    assert t.llamadas == []


def test_al_proveedor_solo_llegan_los_dos_mensajes_con_el_modelo_del_entorno() -> None:
    t = Transporte(_resp(json.dumps(_valida())))
    pet = _pet(correlation={"analysis_run_id": "run-opaco-123"})
    status, cuerpo = _post(pet, t)
    assert status == 200
    (llamada,) = t.llamadas
    assert llamada["modelo"] == "test/modelo-equilibrado"
    assert llamada["temperatura"] == 0.0
    assert llamada["formato_json"] is True
    assert [m["role"] for m in llamada["mensajes"]] == ["system", "user"]
    # El id opaco de correlación NO viaja al proveedor.
    assert "run-opaco-123" not in json.dumps(llamada["mensajes"])


# ───────────────────────── 13 · salida inventada ─────────────────────────


@pytest.mark.parametrize(
    "salida",
    [
        {**_valida(), "approved": True},
        {**_valida(), "status": "approved", "verdict": "aprobado"},
        {"schema_version": "analisis-guion-salida-1", "findings": [], "approved": True},
        _valida(severity="alta"),
        _valida(approved=True),
        _valida(id_db="6f9619ff-8b86-d011-b42d-00c04fc964ff"),
        _valida(id="h100"),
        _valida(id="H1"),
        _valida(category="approve_script"),
        _valida(basis="whatever"),
        _valida(claim_status="verified"),
        _valida(brief_refs=["R1", "R2", "R3", "R4", "R5"]),
        _valida(description="x" * 1001),
        _valida(script_quotes=[{"fragment": "F1", "quote": "una cita", "extra": 1}]),
        _valida(script_quotes=[{"fragment": "F1"}]),
        {"schema_version": "otra", "findings": []},
        {"findings": []},
        {"schema_version": "analisis-guion-salida-1", "findings": "ninguno"},
        {"schema_version": "analisis-guion-salida-1", "findings": [None]},
        {"schema_version": "analisis-guion-salida-1", "findings": [_valida()["findings"][0]] * 26},
        [],
        "texto libre",
        None,
    ],
)
def test_una_salida_de_forma_invalida_no_devuelve_hallazgos_y_no_se_reintenta(salida: Any) -> None:
    t = Transporte(_resp(json.dumps(salida)))
    status, cuerpo = _post(_pet(), t)
    assert status == 422
    assert cuerpo["error"]["code"] == "MODEL_OUTPUT_INVALID"
    assert "output" not in cuerpo
    assert len(t.llamadas) <= 2
    if not isinstance(salida, (str, type(None))):  # noqa: UP038 — Python 3.9 no admite `X | Y` en isinstance
        assert len(t.llamadas) == 1  # bien formada pero inválida: no se reintenta (no gasta)


def test_un_json_roto_se_reintenta_una_sola_vez_y_luego_falla() -> None:
    t = Transporte(_resp('{"schema_version":"analisis-guion-salida-1","findings":['))
    status, cuerpo = _post(_pet(), t)
    assert status == 422
    assert len(t.llamadas) == 2
    assert cuerpo["error"]["code"] == "MODEL_OUTPUT_INVALID"


def test_valores_no_finitos_y_constantes_extranas_en_la_salida_se_rechazan() -> None:
    t = Transporte(_resp('{"schema_version":"analisis-guion-salida-1","findings":[],"x":NaN}'))
    status, cuerpo = _post(_pet(), t)
    assert status == 422
    assert cuerpo["error"]["code"] == "MODEL_OUTPUT_INVALID"


def test_una_salida_cortada_por_longitud_o_filtrada_no_cuenta_como_valida() -> None:
    for finish in ("length", "content_filter"):
        t = Transporte(_resp(json.dumps(_valida()), finish=finish))
        status, _ = _post(_pet(), t)
        assert status == 422, finish


def test_el_razonamiento_del_modelo_no_se_conserva_ni_se_devuelve() -> None:
    contenido = "<think>mi razonamiento secreto RAZONAMIENTO-777</think>" + json.dumps(_valida())
    t = Transporte(_resp(contenido))
    status, cuerpo = _post(_pet(), t)
    if status == 200:
        assert "RAZONAMIENTO-777" not in json.dumps(cuerpo)


# ───────────────────────── Fugas a logs y errores ─────────────────────────


def test_ni_el_contenido_ni_el_secreto_del_proveedor_llegan_a_logs_ni_a_errores(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.DEBUG)
    # Éxito
    t = Transporte(
        _resp(json.dumps(_valida(description=f"La descripción menciona {CANARIO} para probar fugas.")))
    )
    _post(_pet(), t)
    # Fallo del proveedor con el secreto en el mensaje
    t2 = Transporte(AIError(f"Bearer {SECRETO_PROVEEDOR} {CANARIO}", status=401))
    status, cuerpo = _post(_pet(), t2)
    assert status >= 400
    assert SECRETO_PROVEEDOR not in json.dumps(cuerpo)
    assert CANARIO not in json.dumps(cuerpo)
    # Excepción inesperada
    t3 = Transporte(RuntimeError(f"fallo con {CANARIO} y {SECRETO_PROVEEDOR}"))
    status, cuerpo = _post(_pet(), t3)
    assert status >= 400
    assert SECRETO_PROVEEDOR not in json.dumps(cuerpo)
    assert CANARIO not in json.dumps(cuerpo)
    texto_logs = "\n".join(r.getMessage() for r in caplog.records)
    assert CANARIO not in texto_logs
    assert SECRETO_PROVEEDOR not in texto_logs
