"""Pruebas de la indexación vectorial (E5-2).

Cubren las decisiones que no se pueden comprobar mirando la base: qué se
**excluye** del índice y por qué, y qué pasa cuando el proveedor falla.

No llaman al proveedor real. Lo que se verifica aquí es el comportamiento del
worker alrededor de la llamada, no la calidad de los vectores —eso se mide
contra el gold set, no con pruebas unitarias.
"""

from __future__ import annotations

from typing import Any, List, Optional, Sequence

import pytest

from app import embeddings
from app.ai.openrouter import Uso


class CursorFalso:
    """Cursor mínimo que devuelve respuestas preparadas y anota lo ejecutado."""

    def __init__(self, base: "ConexionFalsa") -> None:
        self._base = base
        self._resultado: Any = None

    def __enter__(self) -> "CursorFalso":
        return self

    def __exit__(self, *_: object) -> None:
        return None

    def execute(self, sql: str, params: Sequence[Any] = ()) -> None:
        self._base.ejecutadas.append((" ".join(sql.split()), tuple(params)))
        self._resultado = self._base.responder(sql, params)

    def fetchone(self) -> Any:
        return self._resultado if not isinstance(self._resultado, list) else self._resultado[0]

    def fetchall(self) -> List[Any]:
        return self._resultado if isinstance(self._resultado, list) else []


class ConexionFalsa:
    def __init__(self, documento: Optional[tuple], fragmentos: List[tuple]) -> None:
        self.documento = documento
        self.fragmentos = fragmentos
        self.ejecutadas: List[tuple] = []
        self.commits = 0

    def cursor(self) -> CursorFalso:
        return CursorFalso(self)

    def commit(self) -> None:
        self.commits += 1

    def responder(self, sql: str, _params: Sequence[Any]) -> Any:
        normal = " ".join(sql.split())
        if "FROM source_documents WHERE id" in normal:
            return self.documento
        if "count(*) FROM source_fragments" in normal:
            return (len(self.fragmentos),)
        if "SELECT id, text FROM source_fragments" in normal:
            return list(self.fragmentos)
        if "INSERT INTO ai_runs" in normal:
            return ("00000000-0000-0000-0000-000000000001",)
        return None

    @property
    def sql_ejecutado(self) -> str:
        return " || ".join(s for s, _ in self.ejecutadas)


ORG = "11111111-1111-1111-1111-111111111111"
CAMP = "22222222-2222-2222-2222-222222222222"


def _documento(confidencialidad: str = "interna") -> tuple:
    return (ORG, CAMP, confidencialidad, "Brief de campaña.md")


def _entorno_listo(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_ENABLED", "true")
    monkeypatch.setenv("AI_MODEL_EMBEDDINGS", "openai/text-embedding-3-small")


# ─────────────────────────── §12.3 · Exclusiones ──────────────────────────────


def test_documento_sensible_no_entra_al_indice(monkeypatch: pytest.MonkeyPatch) -> None:
    """Un documento sensible no se indexa aunque la IA esté activa (§12.3).

    El índice vectorial es contenido recuperable: lo que entra puede salir en
    una búsqueda. Para cédulas y datos bancarios, eso es justamente lo que no
    se quiere.
    """
    _entorno_listo(monkeypatch)
    llamado = False

    def _no_deberia(*_a: object, **_k: object) -> None:
        nonlocal llamado
        llamado = True
        raise AssertionError("Se llamó al proveedor con un documento sensible.")

    monkeypatch.setattr(embeddings.openrouter, "embeddings", _no_deberia)

    conn = ConexionFalsa(_documento("sensible"), [("f1", "Cédula 1.023.456.789")])
    resultado = embeddings.indexar_documento(conn, "doc-1")

    assert not llamado
    assert resultado.indexados == 0
    assert resultado.omitidos == 1
    assert "sensible" in (resultado.motivo or "")


def test_sin_ia_el_documento_queda_procesado_pero_sin_vectores(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """AI_ENABLED=false no es un fallo: es el modo manual del principio 9 (§5)."""
    monkeypatch.setenv("AI_ENABLED", "false")

    conn = ConexionFalsa(_documento(), [("f1", "texto")])
    resultado = embeddings.indexar_documento(conn, "doc-1")

    assert resultado.indexados == 0
    assert "AI_ENABLED" in (resultado.motivo or "")


# ──────────────────────────── Camino feliz ────────────────────────────────────


def test_indexa_y_registra_el_costo(monkeypatch: pytest.MonkeyPatch) -> None:
    _entorno_listo(monkeypatch)

    def _falso(modelo: str, textos: List[str], **_k: object) -> tuple:
        return ([[0.1] * 1536 for _ in textos], Uso(10, 0, 10, 0.000002))

    monkeypatch.setattr(embeddings.openrouter, "embeddings", _falso)

    conn = ConexionFalsa(_documento(), [("f1", "uno"), ("f2", "dos")])
    resultado = embeddings.indexar_documento(conn, "doc-1")

    assert resultado.indexados == 2
    assert "UPDATE source_fragments SET embedding" in conn.sql_ejecutado
    assert "INSERT INTO ai_runs" in conn.sql_ejecutado


def test_el_registro_no_guarda_el_texto_enviado(monkeypatch: pytest.MonkeyPatch) -> None:
    """§11.6: del insumo se guarda un hash, nunca el contenido."""
    _entorno_listo(monkeypatch)
    secreto = "El presupuesto reservado es de USD 55,000"

    monkeypatch.setattr(
        embeddings.openrouter,
        "embeddings",
        lambda m, t, **k: ([[0.1] * 1536 for _ in t], Uso(5, 0, 5, 0.0)),
    )

    conn = ConexionFalsa(_documento(), [("f1", secreto)])
    embeddings.indexar_documento(conn, "doc-1")

    for _sql, params in conn.ejecutadas:
        for p in params:
            assert secreto not in str(p), "El texto del fragmento llegó a ai_runs"


# ──────────────────────── Cuando el proveedor falla ───────────────────────────


def test_un_lote_fallido_se_registra_y_no_rompe_el_documento(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Un proveedor caído deja el documento sin índice, no sin procesar."""
    _entorno_listo(monkeypatch)

    def _revienta(*_a: object, **_k: object) -> None:
        raise RuntimeError("502 del proveedor")

    monkeypatch.setattr(embeddings.openrouter, "embeddings", _revienta)

    conn = ConexionFalsa(_documento(), [("f1", "uno")])
    resultado = embeddings.indexar_documento(conn, "doc-1")

    assert resultado.indexados == 0
    assert "INSERT INTO ai_runs" in conn.sql_ejecutado
    registro = [p for s, p in conn.ejecutadas if "INSERT INTO ai_runs" in s][0]
    assert "error" in registro, "El fallo debe quedar registrado con estado de error"


# ──────────────────────────── Consulta de búsqueda ────────────────────────────


def test_la_consulta_vacia_se_rechaza(monkeypatch: pytest.MonkeyPatch) -> None:
    _entorno_listo(monkeypatch)
    with pytest.raises(ValueError):
        embeddings.embeber_consulta("   ")


def test_sin_ia_no_hay_vector_de_consulta(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AI_ENABLED", "false")
    with pytest.raises(embeddings.EmbeddingsDesactivados):
        embeddings.embeber_consulta("público objetivo")


def test_el_literal_de_vector_es_el_que_espera_pgvector() -> None:
    assert embeddings._a_literal_vector([0.5, -0.25, 0.0]) == "[0.5,-0.25,0.0]"
