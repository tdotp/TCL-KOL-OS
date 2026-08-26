"""Pruebas de la configuración del worker.

Cubren dos cosas que importan: que el worker falle al arrancar si le falta
configuración, y que nunca escriba credenciales en los logs (§12.1, control 5).
"""

from __future__ import annotations

import pytest

from app.config import ConfigError, load_settings

BASE_ENV = {
    "DATABASE_URL": "postgresql://user:secret@db:5432/tclkolos",
    "REDIS_URL": "redis://cache:6379/0",
}


def _set_env(monkeypatch: pytest.MonkeyPatch, **overrides: str) -> None:
    for key in ("DATABASE_URL", "REDIS_URL", "AI_ENABLED", "AI_PROVIDER", "MAX_UPLOAD_MB"):
        monkeypatch.delenv(key, raising=False)
    for key, value in {**BASE_ENV, **overrides}.items():
        monkeypatch.setenv(key, value)


def test_carga_configuracion_minima(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_env(monkeypatch)
    settings = load_settings()
    assert settings.database_url == BASE_ENV["DATABASE_URL"]
    assert settings.ai_enabled is False
    assert settings.max_upload_mb == 50


def test_falla_sin_database_url(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_env(monkeypatch)
    monkeypatch.delenv("DATABASE_URL")
    with pytest.raises(ConfigError, match="DATABASE_URL"):
        load_settings()


def test_falla_si_ia_activa_sin_proveedor(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_env(monkeypatch, AI_ENABLED="true")
    with pytest.raises(ConfigError, match="AI_PROVIDER"):
        load_settings()


def test_rechaza_tamano_invalido(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_env(monkeypatch, MAX_UPLOAD_MB="0")
    with pytest.raises(ConfigError, match="mayor que cero"):
        load_settings()


def test_los_logs_no_contienen_credenciales(monkeypatch: pytest.MonkeyPatch) -> None:
    """Caso S-10: ningún log debe contener secretos."""
    _set_env(monkeypatch)
    settings = load_settings()
    redacted = str(settings.redacted())
    assert "secret" not in redacted
    assert "user:" not in redacted
    assert "db:5432" in redacted  # el host sí, para poder diagnosticar


def test_formatos_soportados_son_los_de_dec_010(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_env(monkeypatch)
    settings = load_settings()
    assert "application/pdf" in settings.supported_mime_types
    assert "image/png" in settings.supported_mime_types
    # XLSX no está soportado: entra como excepción manual, no automática.
    xlsx = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    assert xlsx not in settings.supported_mime_types
