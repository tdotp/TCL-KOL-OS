"""El proveedor falso produce una salida determinística y verificable.

Cierre de Sprint 4, corrección 6: la prueba de integración completa
(`packages/db/src/end-to-end.test.ts`) necesita que `AI_PROVIDER=fake` haga
recorrer el contrato HTTP real de `/extraccion` sin depender de OpenRouter.
Estas pruebas fijan esa condición del lado del worker: sin red, sin clave, y
la cita que produce es siempre literal — el mismo principio que se exige al
proveedor real en `extraction.py`.
"""

from __future__ import annotations

from app import brief_schema
from app.ai import fake_provider, provider
from app.extraction import (
    FragmentoDeEntrada,
    _bloque_de_fragmentos,
    _instrucciones,
    validar_y_anclar,
)


def _prompt_con_un_fragmento() -> tuple[str, FragmentoDeEntrada]:
    fragmento = FragmentoDeEntrada(
        id="frag-1",
        source_id="src-1",
        filename="Brief.md",
        texto="Lanzamiento línea P80 en Colombia, segmento medio-alto.",
        section="Contexto",
        linea=1,
    )
    prompt = _instrucciones(brief_schema.campos_extraibles()) + "\n\n" + _bloque_de_fragmentos([fragmento])
    return prompt, fragmento


def test_no_llama_a_ninguna_red_ni_necesita_clave() -> None:
    assert fake_provider.disponible() is True


def test_la_cita_que_produce_es_literal_del_fragmento() -> None:
    prompt, fragmento = _prompt_con_un_fragmento()
    respuesta = fake_provider.completar("modelo-cualquiera", [{"role": "user", "content": prompt}])

    campos, descartes = validar_y_anclar(respuesta.contenido, [fragmento])
    encontrado = next((c for c in campos if c.status == "found"), None)
    assert encontrado is not None, f"el proveedor falso no produjo ningún campo found; descartes: {descartes}"
    assert encontrado.evidence, "el campo found debería traer evidencia verificada"
    assert encontrado.evidence[0].quote in fragmento.texto


def test_es_determinista_entre_dos_llamadas_identicas() -> None:
    prompt, _fragmento = _prompt_con_un_fragmento()
    r1 = fake_provider.completar("m", [{"role": "user", "content": prompt}])
    r2 = fake_provider.completar("m", [{"role": "user", "content": prompt}])
    assert r1.contenido == r2.contenido
    assert r1.uso.costo_usd == 0.0


def test_provider_enruta_a_fake_solo_con_ai_provider_fake(monkeypatch) -> None:
    monkeypatch.setenv("AI_PROVIDER", "fake")
    prompt, _fragmento = _prompt_con_un_fragmento()
    respuesta = provider.completar("m", [{"role": "user", "content": prompt}])
    assert respuesta.metadata.get("fake") is True


def test_provider_no_enruta_a_fake_por_defecto(monkeypatch) -> None:
    monkeypatch.delenv("AI_PROVIDER", raising=False)

    def _fallaria_si_se_llama(*_a: object, **_k: object) -> None:
        raise AssertionError("No debería llamar a OpenRouter en esta prueba.")

    monkeypatch.setattr(provider.openrouter, "completar", _fallaria_si_se_llama)
    monkeypatch.setattr(provider, "_usando_proveedor_falso", lambda: False)
    try:
        provider.completar("m", [{"role": "user", "content": "x"}])
    except AssertionError as exc:
        assert "No debería llamar" in str(exc)
    else:
        raise AssertionError(
            "Se esperaba que intentara llamar al proveedor real y fallara aquí, no en la red."
        )
