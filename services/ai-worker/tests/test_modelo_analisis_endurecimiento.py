# ruff: noqa: E501, C408 — tablas de casos largas; datos sintéticos
"""Endurecimiento de `POST /modelo/analisis` (V2 · Fase 7): regresión adversarial y piezas internas.

Complementa `test_modelo_analisis.py` (contrato, modos del fake, fixtures compartidos). Aquí: el
parseo tolerante, la forma sin contenido en los errores, el seguimiento por plazo, el parser de
sobres del fake, la no regresión del fake de extracción/turno y que nada de contenido llegue a logs.
"""

from __future__ import annotations

import ast
import asyncio
import json
import logging
import time
from pathlib import Path
from typing import Any

import pytest

from app import modelo_analisis as ma
from app import modelo_turno
from app.ai import fake_analisis, fake_provider, provider
from app.ai.openrouter import AIError, Respuesta, Uso
from app.main import app

SECRETO = "SECRETO-ENDURECIMIENTO-9021"


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


def _resp(contenido: str, costo: Any = 0.001) -> Respuesta:
    return Respuesta(
        contenido=contenido,
        modelo="m/real",
        uso=Uso(prompt_tokens=10, completion_tokens=5, total_tokens=15, costo_usd=costo),
        latencia_ms=5,
        generacion_id="g",
        metadata={"finish_reason": "stop"},
    )


def _llamar(cuerpo: dict[str, Any], transporte: Any) -> tuple[int, dict[str, str], Any]:
    app.dependency_overrides[ma.transporte_por_defecto] = lambda: transporte
    crudo = json.dumps(cuerpo).encode("utf-8")

    async def _correr() -> tuple[int, dict[str, str], Any]:
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
                (b"content-length", str(len(crudo)).encode()),
            ],
            "client": ("test", 1),
            "server": ("test", 80),
        }
        entregado = False

        async def receive() -> dict[str, Any]:
            nonlocal entregado
            if not entregado:
                entregado = True
                return {"type": "http.request", "body": crudo, "more_body": False}
            await asyncio.sleep(3600)
            return {"type": "http.disconnect"}

        salida: list[dict[str, Any]] = []

        async def send(msg: dict[str, Any]) -> None:
            salida.append(msg)

        await app(scope, receive, send)  # type: ignore[arg-type]
        inicio = next(m for m in salida if m["type"] == "http.response.start")
        cuerpo_resp = b"".join(m.get("body", b"") for m in salida if m["type"] == "http.response.body")
        return (
            inicio["status"],
            {k.decode().lower(): v.decode() for k, v in inicio["headers"]},
            json.loads(cuerpo_resp),
        )

    return asyncio.run(_correr())


def _pet(**extra: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "task": "analizar_guion",
        "messages": [
            {"role": "system", "content": "TAREA: analizar_guion · prueba"},
            {"role": "user", "content": "usuario"},
        ],
        "output_schema_version": "analisis-guion-salida-1",
        "timeout_s": 30,
    }
    base.update(extra)
    return base


def _sobre_de_guion(texto: str, ref: str = "F1") -> str:
    nonce = "34" * 16
    return f"<<<NC:{nonce} kind=script_fragment ref={ref}>>>\n│ {texto}\n<<<FIN:{nonce}>>>"


# --- Taxonomía de errores -----------------------------------------------------------------------


def test_los_errores_del_analisis_son_los_del_turno_mas_la_salida_invalida() -> None:
    assert set(ma.ERRORES_ANALISIS) == set(modelo_turno.ERRORES) | {"MODEL_OUTPUT_INVALID"}
    assert ma.ERRORES_ANALISIS["MODEL_OUTPUT_INVALID"].status == 422
    assert ma.ERRORES_ANALISIS["MODEL_OUTPUT_INVALID"].retryable is False
    for code, tipo in modelo_turno.ERRORES.items():
        assert ma.ERRORES_ANALISIS[code] == tipo
    # `/modelo/turno` no cambió: su taxonomía pública no conoce la salida inválida del análisis.
    assert "MODEL_OUTPUT_INVALID" not in modelo_turno.ERRORES


def test_cuerpo_de_error_con_y_sin_llamadas() -> None:
    sin = ma.AnalisisError("AI_DISABLED").cuerpo()["error"]
    assert set(sin) == {"code", "message", "retryable", "retry_after_s", "details"}
    llamada = {
        "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5, "cost_usd": 0.5},
        "latency_ms": 1,
        "generation_id": None,
        "outcome": "json_invalido",
    }
    con = ma.AnalisisError("MODEL_OUTPUT_INVALID", llamadas=[llamada, llamada]).cuerpo()["error"]
    assert con["attempts"] == 2 and con["usage"]["total_tokens"] == 10 and con["usage"]["cost_usd"] == 1.0
    assert con["calls"] == [llamada, llamada]


def test_el_constructor_rechaza_codigos_fuera_de_la_taxonomia() -> None:
    with pytest.raises(KeyError):
        ma.AnalisisError("CODIGO_INVENTADO")


# --- Parseo tolerante ------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "texto, problema",
    [
        ("", "vacio"),
        ("   \n\t", "vacio"),
        ("<think>pienso</think>", "vacio"),
        ("<think>sin cerrar {}", "vacio"),
        ("```\n```", "vacio"),
        ("```json", "vacio"),
        ("{", "json_invalido"),
        ("[1, 2,", "json_invalido"),
        ("{'a': 1}", "json_invalido"),
        ("undefined", "json_invalido"),
        ("{} {}", "json_invalido"),
        ('{"a": NaN}', "json_invalido"),
        ('{"a": -Infinity}', "json_invalido"),
        ('{"a": 1e999}', "json_invalido"),
        ("[" * 100_000, "json_invalido"),
        ("texto antes {}", "json_invalido"),
    ],
)
def test_parsear_salida_problemas(texto: str, problema: str) -> None:
    valor, p = ma.parsear_salida(texto)
    assert valor is None and p == problema


@pytest.mark.parametrize(
    "texto, esperado",
    [
        ("{}", {}),
        ("[]", []),
        ("  42  ", 42),
        ('"x"', "x"),
        ('```json\n{"a": 1}\n```', {"a": 1}),
        ('```\n{"a": 1}\n```', {"a": 1}),
        ('```json\n{"a": 1}', {"a": 1}),
        ('<think>x</think>{"a": 1}', {"a": 1}),
        ('<think>x</think>```json\n{"a": 1}\n```\n', {"a": 1}),
        ('{"a": "```"}', {"a": "```"}),
    ],
)
def test_parsear_salida_valores(texto: str, esperado: Any) -> None:
    valor, p = ma.parsear_salida(texto)
    assert p is None and valor == esperado


def test_un_bloque_think_dentro_de_una_cadena_json_tambien_se_descarta() -> None:
    """El razonamiento nunca sobrevive, ni escondido dentro de un valor: se elimina antes de parsear."""
    valor, p = ma.parsear_salida('{"a": "x<think>secreto</think>y"}')
    assert p is None and valor == {"a": "xy"}


def test_el_razonamiento_descartado_no_aparece_en_ninguna_parte() -> None:
    contenido = f"<think>{SECRETO}</think>{json.dumps(_valida())}"
    status, _, cuerpo = _llamar(_pet(), lambda *a, **k: _resp(contenido))
    assert status == 200
    assert SECRETO not in json.dumps(cuerpo)


# --- Forma: issues sin contenido ----------------------------------------------------------------------


def test_los_issues_no_incluyen_el_nombre_de_claves_ni_valores_del_modelo() -> None:
    malo = _valida()
    malo[SECRETO] = SECRETO
    malo["findings"][0][f"clave-{SECRETO}"] = SECRETO
    malo["findings"][0]["category"] = SECRETO
    malo["findings"][0]["script_quotes"] = [{"fragment": SECRETO * 5, "quote": SECRETO, SECRETO: 1}]
    normalizada, issues = ma.validar_forma(malo)
    assert normalizada is None and issues
    assert SECRETO not in json.dumps(issues)
    for i in issues:
        assert set(i) == {"loc", "type"} and len(i["loc"]) <= 120
    assert len(issues) <= 20


def test_validar_forma_acota_los_hallazgos_segun_la_peticion() -> None:
    dos = _valida()
    dos["findings"].append({**dos["findings"][0], "id": "h2"})
    assert ma.validar_forma(dos, 2)[0] is not None
    normalizada, issues = ma.validar_forma(dos, 1)
    assert normalizada is None and issues == [{"loc": "findings", "type": "too_many_findings"}]


def test_el_limite_de_hallazgos_de_la_peticion_se_aplica_por_el_endpoint() -> None:
    dos = _valida()
    dos["findings"].append({**dos["findings"][0], "id": "h2"})
    status, _, cuerpo = _llamar(_pet(max_findings=1), lambda *a, **k: _resp(json.dumps(dos)))
    assert status == 422 and cuerpo["error"]["details"]["issues"] == [
        {"loc": "findings", "type": "too_many_findings"}
    ]


def test_la_salida_se_normaliza_a_un_conjunto_fijo_de_claves() -> None:
    minimo = {
        "schema_version": "analisis-guion-salida-1",
        "findings": [
            {
                "id": "h1",
                "category": "cta_missing",
                "basis": "absence",
                "description": "d" * 12,
                "brief_refs": [],
            }
        ],
    }
    normalizada, issues = ma.validar_forma(minimo)
    assert issues == [] and normalizada is not None
    assert set(normalizada) == {"schema_version", "findings"}
    assert set(normalizada["findings"][0]) == {
        "id",
        "category",
        "basis",
        "claim_status",
        "description",
        "brief_refs",
        "script_quotes",
    }


@pytest.mark.parametrize(
    "campo, malo",
    [
        ("id", 1),
        ("id", None),
        ("id", True),
        ("category", 1),
        ("category", None),
        ("category", ["cta_missing"]),
        ("basis", 1),
        ("basis", None),
        ("description", 1),
        ("description", None),
        ("description", ["x"]),
        ("brief_refs", "R5"),
        ("brief_refs", None),
        ("brief_refs", [5]),
        ("brief_refs", [None]),
        ("brief_refs", {"a": 1}),
        ("script_quotes", None),
        ("script_quotes", "x"),
        ("script_quotes", {"fragment": "F1", "quote": "q"}),
        ("script_quotes", [None]),
        ("claim_status", 1),
        ("claim_status", True),
        ("claim_status", ["unsupported"]),
    ],
)
def test_no_hay_coercion_de_tipos_en_la_forma(campo: str, malo: Any) -> None:
    salida = _valida()
    salida["findings"][0][campo] = malo
    assert ma.validar_forma(salida)[0] is None


def test_el_id_solo_admite_h_y_uno_o_dos_digitos_ascii() -> None:
    for bueno in ("h1", "h9", "h10", "h99", "h01"):
        assert ma.validar_forma(_valida(id=bueno))[0] is not None, bueno
    for malo in ("H1", "h", "h100", "h-1", "h1\n", " h1", "h١", "x1", "", "h１"):
        assert ma.validar_forma(_valida(id=malo))[0] is None, repr(malo)


def test_los_limites_de_forma_cuentan_puntos_de_codigo() -> None:
    assert ma.validar_forma(_valida(description="\U0001f600" * 1000))[0] is not None
    assert ma.validar_forma(_valida(description="\U0001f600" * 1001))[0] is None
    assert ma.validar_forma(_valida(brief_refs=["R" * 32]))[0] is not None
    assert ma.validar_forma(_valida(brief_refs=["R" * 33]))[0] is None
    assert ma.validar_forma(_valida(brief_refs=["R1", "R2", "R3", "R4"]))[0] is not None
    assert ma.validar_forma(_valida(brief_refs=["R1", "R2", "R3", "R4", "R5"]))[0] is None
    cita = {"fragment": "F1", "quote": "q" * 2000}
    assert ma.validar_forma(_valida(script_quotes=[cita] * 3))[0] is not None
    assert ma.validar_forma(_valida(script_quotes=[cita] * 4))[0] is None
    assert ma.validar_forma(_valida(script_quotes=[{"fragment": "F1", "quote": "q" * 2001}]))[0] is None


# --- Plazo total y seguimiento ---------------------------------------------------------------------------


def test_el_plazo_total_abandona_la_espera_y_aun_asi_informa_la_llamada_en_curso() -> None:
    def colgado(*a: Any, **k: Any) -> Respuesta:
        time.sleep(2.2)
        return _resp(json.dumps(_valida()))

    inicio = time.monotonic()
    status, _, cuerpo = _llamar(_pet(timeout_s=1.0), colgado)
    assert time.monotonic() - inicio < 2.0, "no espera al proveedor más allá del plazo + margen"
    assert status == 504 and cuerpo["error"]["code"] == "MODEL_TIMEOUT"
    assert cuerpo["error"]["retryable"] is True
    assert cuerpo["error"]["attempts"] == 1
    assert cuerpo["error"]["calls"][0]["outcome"] == "error" and cuerpo["error"]["calls"][0]["usage"] is None
    time.sleep(1.4)  # deja terminar el hilo del proveedor para no contaminar otras pruebas


def test_seguimiento_marca_la_llamada_en_curso_solo_para_el_error() -> None:
    s = ma.Seguimiento()
    assert s.llamadas_para_error() == []
    s.en_curso = True
    s.inicio_de_llamada = time.monotonic() - 0.2
    (c,) = s.llamadas_para_error()
    assert c["outcome"] == "error" and c["usage"] is None and c["latency_ms"] >= 150
    assert s.llamadas == [], "no se contamina el registro real"


def test_un_error_inesperado_en_el_proveedor_registra_la_llamada_en_curso() -> None:
    def roto(*a: Any, **k: Any) -> Respuesta:
        raise RuntimeError(SECRETO)

    status, _, cuerpo = _llamar(_pet(), roto)
    assert status == 500
    assert cuerpo["error"]["attempts"] == 1
    assert SECRETO not in json.dumps(cuerpo)


# --- Parser de sobres y piezas del fake -------------------------------------------------------------------


def test_el_parser_de_sobres_lee_kind_ref_meta_y_texto() -> None:
    nonce = "ab" * 16
    texto = "\n".join(
        [
            "encabezado de confianza",
            f"<<<NC:{nonce} kind=brief_requirement ref=R3>>>",
            'meta: {"key":"mandatorios","criticidad":"critico","no_evaluable":true}',
            "│ línea uno",
            "│",
            "│ línea tres",
            f"<<<FIN:{nonce}>>>",
            f"<<<NC:{nonce} kind=context_data>>>",
            "│ sin ref",
            f"<<<FIN:{nonce}>>>",
        ]
    )
    sobres = fake_analisis._sobres_de(texto)
    assert [(s["kind"], s["ref"]) for s in sobres] == [("brief_requirement", "R3"), ("context_data", None)]
    assert sobres[0]["meta"]["no_evaluable"] is True
    assert sobres[0]["texto"] == "línea uno\n\nlínea tres"


def test_el_parser_de_sobres_tolera_basura_sobres_sin_cerrar_y_meta_roto() -> None:
    nonce = "cd" * 16
    assert fake_analisis._sobres_de("") == []
    assert fake_analisis._sobres_de(f"<<<NC:{nonce} kind=script_fragment ref=F1>>>\n│ sin cerrar") == []
    s = fake_analisis._sobres_de(
        f"<<<NC:{nonce} kind=script_fragment ref=F1>>>\nmeta: {{roto\n│ x\n<<<FIN:{nonce}>>>"
    )
    assert s[0]["meta"] == {} and s[0]["texto"] == "x"
    s2 = fake_analisis._sobres_de(
        f"<<<NC:{nonce} kind=script_fragment ref=F1>>>\nmeta: [1,2]\n│ y\n<<<FIN:{nonce}>>>"
    )
    assert s2[0]["meta"] == {}


def test_citas_del_fake_son_trozos_literales_sin_marcadores() -> None:
    texto = "[[fake:analisis por_defecto]] Primera frase larga del guion de prueba. Segunda frase que ya no entra."
    cita = fake_analisis._cita_de(texto)
    assert len(cita) <= 90 and cita in texto and "[[fake" not in cita and " " in cita
    assert fake_analisis._cita_de("[[fake:analisis timeout]]") == "texto del guion sin contenido"
    assert fake_analisis._cita_de("") == "texto del guion sin contenido"


def test_el_fake_no_se_rompe_con_un_contexto_degenerado() -> None:
    sistema = {"role": "system", "content": "TAREA: analizar_guion"}
    for usuario in ("", "sin sobres", "<<<NC:xx kind=y>>>"):
        for modo in (
            "por_defecto",
            "cta_ausente",
            "claim_sin_respaldo",
            "contradiccion",
            "requisito_no_evaluable",
            "cita_de_otro_fragmento",
            "alias_fragmento_inexistente",
            "cita_inexistente",
        ):
            guion = _sobre_de_guion(f"[[fake:analisis {modo}]] {usuario}")
            for contenido in (guion, f"{usuario}\n{guion}"):
                r = fake_analisis.analisis_falso([sistema, {"role": "user", "content": contenido}])
                assert isinstance(r.contenido, str) and r.uso.costo_usd and r.uso.costo_usd > 0


def test_modo_desconocido_o_con_mayusculas_es_limpio() -> None:
    nonce = "ef" * 16
    usuario = f"<<<NC:{nonce} kind=script_fragment ref=F1>>>\n│ [[fake:analisis MODO_RARO]] texto largo del guion\n<<<FIN:{nonce}>>>"
    r = fake_analisis.analisis_falso(
        [{"role": "system", "content": "TAREA: analizar_guion"}, {"role": "user", "content": usuario}]
    )
    assert json.loads(r.contenido)["findings"] == []
    r2 = fake_analisis.analisis_falso(
        [
            {"role": "system", "content": "TAREA: analizar_guion"},
            {"role": "user", "content": usuario.replace("MODO_RARO", "inexistente")},
        ]
    )
    assert json.loads(r2.contenido)["findings"] == []


def test_el_fake_es_determinista_y_su_costo_crece_con_el_prompt() -> None:
    m = [{"role": "system", "content": "TAREA: analizar_guion"}, {"role": "user", "content": "x" * 400}]
    a, b = fake_analisis.analisis_falso(m), fake_analisis.analisis_falso(m)
    assert a == b
    grande = fake_analisis.analisis_falso([m[0], {"role": "user", "content": "x" * 40_000}])
    assert 0 < a.uso.costo_usd < grande.uso.costo_usd  # type: ignore[operator]
    assert a.uso.total_tokens == a.uso.prompt_tokens + a.uso.completion_tokens


def test_el_marcador_de_tarea_va_anclado_al_inicio_de_linea() -> None:
    assert fake_analisis.es_tarea_de_analisis([{"role": "system", "content": "a\nTAREA: analizar_guion · v"}])
    assert not fake_analisis.es_tarea_de_analisis(
        [{"role": "system", "content": "mira: TAREA: analizar_guion"}]
    )
    assert not fake_analisis.es_tarea_de_analisis([{"role": "user", "content": "TAREA: analizar_guion"}])
    assert not fake_analisis.es_tarea_de_analisis([{"role": "system", "content": "TAREA: analizar_guionX"}])
    assert not fake_analisis.es_tarea_de_analisis([])


def test_reintento_ok_cuenta_por_solicitud_no_globalmente() -> None:
    sistema = {"role": "system", "content": "TAREA: analizar_guion"}
    a = [sistema, {"role": "user", "content": _sobre_de_guion("[[fake:analisis reintento_ok]] solicitud A")}]
    b = [sistema, {"role": "user", "content": _sobre_de_guion("[[fake:analisis reintento_ok]] solicitud B")}]
    rota = fake_analisis._JSON_ROTO
    assert fake_analisis.analisis_falso(a).contenido == rota
    assert fake_analisis.analisis_falso(b).contenido == rota, "B arranca su propia cuenta"
    assert json.loads(fake_analisis.analisis_falso(a).contenido)["findings"], "la segunda de A acierta"
    assert json.loads(fake_analisis.analisis_falso(b).contenido)["findings"]
    fake_analisis.reiniciar_contadores_de_analisis()
    assert fake_analisis.analisis_falso(a).contenido == rota


# --- No regresión del fake de extracción, de turno y de las rutas ---------------------------------------------


def test_el_fake_de_extraccion_no_cambio() -> None:
    prompt = "FRAGMENTOS:\n[frag-1] Brief.md · p.1\nLanzamiento de la línea P80 en Colombia.\n\nOtro bloque"
    r = fake_provider.completar("m", [{"role": "user", "content": prompt}], formato_json=True)
    campos = json.loads(r.contenido)["campos"]
    assert campos[0]["key"] == "contexto.categoria" and campos[0]["evidence"][0]["fragment_id"] == "frag-1"
    assert r.modelo == "fake/determinista-1" and r.uso.costo_usd == 0.0


def test_el_fake_de_extraccion_ignora_un_system_con_otra_tarea() -> None:
    r = fake_provider.completar(
        "m",
        [
            {"role": "system", "content": "Eres el extractor"},
            {"role": "user", "content": "TAREA: analizar_guion"},
        ],
        formato_json=True,
    )
    assert json.loads(r.contenido) == {"campos": []}


def test_el_fake_de_turno_no_cambio() -> None:
    r = fake_provider.completar_con_herramientas(
        "m",
        [{"role": "user", "content": '[[fake:tool campaign_get {"x": 1}]]'}],
        [
            {
                "type": "function",
                "function": {"name": "campaign_get", "description": "d", "parameters": {"type": "object"}},
            }
        ],
    )
    assert r.finish_reason == "tool_calls" and r.llamadas[0].nombre == "campaign_get"
    assert r.uso.costo_usd == 0.0


def test_las_rutas_existentes_siguen_registradas_y_la_nueva_tambien() -> None:
    rutas = {getattr(r, "path", None) for r in app.routes}
    assert {"/modelo/turno", "/modelo/analisis", "/extraccion", "/ready"} <= rutas


def test_el_endpoint_de_turno_sigue_dependiendo_solo_de_su_propio_transporte() -> None:
    assert modelo_turno.transporte_por_defecto() is provider.completar_con_herramientas
    assert ma.transporte_por_defecto() is provider.completar


# --- Logs y estática ------------------------------------------------------------------------------------------------


def test_ningun_modo_del_fake_filtra_contenido_a_los_logs(
    caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("AI_PROVIDER", "fake")
    caplog.set_level(logging.DEBUG)
    nonce = "12" * 16
    guion = f"[[fake:analisis MODO]] {SECRETO} texto del guion con varias palabras para citar"
    for modo in (
        "limpio",
        "por_defecto",
        "eco_inyeccion",
        "json_roto",
        "campo_extra",
        "alias_requisito_inexistente",
        "timeout",
        "rate_limit",
    ):
        usuario = (
            f"<<<NC:{nonce} kind=brief_requirement ref=R1>>>\nmeta: {{\"key\":\"mandatorios\",\"criticidad\":\"critico\"}}\n│ valor {SECRETO}\n<<<FIN:{nonce}>>>\n"
            f"<<<NC:{nonce} kind=script_fragment ref=F1>>>\n│ {guion.replace('MODO', modo)}\n<<<FIN:{nonce}>>>"
        )
        _llamar(
            _pet(
                messages=[
                    {"role": "system", "content": "TAREA: analizar_guion"},
                    {"role": "user", "content": usuario},
                ]
            ),
            provider.completar,
        )
    assert SECRETO not in caplog.text
    assert "modelo_analisis resultado=" in caplog.text


def test_el_modulo_no_importa_acceso_a_datos_ni_imprime() -> None:
    arbol = ast.parse(Path(ma.__file__).read_text(encoding="utf-8"))
    importados: set[str] = set()
    for nodo in ast.walk(arbol):
        if isinstance(nodo, ast.Import):
            importados.update(a.name.split(".")[0] for a in nodo.names)
        elif isinstance(nodo, ast.ImportFrom) and nodo.module:
            importados.add(nodo.module.split(".")[0])
    assert not importados & {"psycopg", "psycopg2", "sqlalchemy", "asyncpg", "sqlite3", "requests", "httpx"}
    llamadas = {
        n.func.id for n in ast.walk(arbol) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
    }
    assert "print" not in llamadas


def test_el_registro_de_metadatos_tolera_peticion_ausente(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.INFO)
    ma.registrar_metadatos(None, resultado="REQUEST_INVALID", duracion_ms=3)
    assert "resultado=REQUEST_INVALID" in caplog.text and "analysis_run_id=None" in caplog.text


def _claves(valor: Any) -> set[str]:
    if isinstance(valor, dict):
        return set(valor) | {k for v in valor.values() for k in _claves(v)}
    if isinstance(valor, list):
        return {k for v in valor for k in _claves(v)}
    return set()


def test_no_hay_campos_de_razonamiento_en_la_respuesta() -> None:
    contenido = "<think>pienso</think>" + json.dumps(_valida())
    status, _, cuerpo = _llamar(_pet(), lambda *a, **k: _resp(contenido))
    assert status == 200
    prohibidas = {"reasoning", "reasoning_content", "thinking", "think", "thought", "chain_of_thought", "cot"}
    assert not _claves(cuerpo) & prohibidas


def test_ai_error_con_mensaje_del_proveedor_no_llega_al_log_ni_a_la_respuesta(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.DEBUG)

    def malo(*a: Any, **k: Any) -> Respuesta:
        raise AIError(f"Bearer {SECRETO}", status=401)

    status, _, cuerpo = _llamar(_pet(), malo)
    assert status == 502
    assert SECRETO not in json.dumps(cuerpo) and SECRETO not in caplog.text
