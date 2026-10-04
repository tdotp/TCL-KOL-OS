"""Integración con Google Sheets (V2 · Fase 5): frontera de red, auth y valores.

La suite normal NO depende de una cuenta real de Google ni de red: el proveedor
se prueba con un transporte controlado. Lo que se comprueba:

  · la petición solo puede ir a la API de Sheets y se construye desde un id
    validado (nunca desde la URL pegada);
  · cada código de error HTTP se traduce a un fallo sanitizado, reintentable o
    determinista, según corresponda;
  · las credenciales son de solo lectura y no aparecen en errores ni logs;
  · los valores efectivos se convierten con el contrato tabular de la Fase 4;
  · el hash de contenido es determinista y solo depende del contenido.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

import pytest

from app import google_sheets
from app.google_sheets import (
    ALCANCE_SOLO_LECTURA,
    GoogleSheetsError,
    ProveedorGoogleSheets,
    RespuestaHttp,
    TransporteDeFixtures,
    TransporteGoogle,
    cargar_cuenta_de_servicio,
    crear_proveedor,
    hash_de_contenido,
    validar_url_de_api,
)
from app.parsers.tabular import construir_resultado

LIBRO_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"  # forma real de un id (≥ 20 caracteres)
SECRETO = "SECRETO-NO-DEBE-APARECER-EN-NINGUN-LADO"  # noqa: S105


# ─────────────────────────── Ayudas ───────────────────────────────────────────


def valor_cadena(texto: str) -> dict[str, Any]:
    return {"effectiveValue": {"stringValue": texto}}


def valor_numero(n: float, formato: str | None = None) -> dict[str, Any]:
    celda: dict[str, Any] = {"effectiveValue": {"numberValue": n}}
    if formato:
        celda["effectiveFormat"] = {"numberFormat": {"type": formato}}
    return celda


def pestana(
    nombre: str,
    sheet_id: int,
    filas: list[list[dict[str, Any]]],
    *,
    indice: int = 0,
    oculta: bool = False,
    tipo: str = "GRID",
) -> dict[str, Any]:
    props: dict[str, Any] = {"sheetId": sheet_id, "title": nombre, "index": indice, "sheetType": tipo}
    if oculta:
        props["hidden"] = True
    return {
        "properties": props,
        "data": [{"startRow": 0, "startColumn": 0, "rowData": [{"values": f} for f in filas]}],
    }


def libro_api(*pestanas: dict[str, Any], titulo: str = "Influencers TCL") -> dict[str, Any]:
    return {"spreadsheetId": LIBRO_ID, "properties": {"title": titulo}, "sheets": list(pestanas)}


class TransporteFalso:
    """Devuelve una respuesta fija y registra las peticiones."""

    def __init__(self, respuesta: RespuestaHttp | Exception) -> None:
        self.respuesta = respuesta
        self.llamadas: list[tuple[str, dict[str, str]]] = []

    def get(
        self,
        url: str,
        params: Any,
        *,
        timeout: tuple[float, float],
        max_bytes: int,
    ) -> RespuestaHttp:
        self.llamadas.append((url, dict(params)))
        assert timeout[0] > 0 and timeout[1] > 0, "toda petición lleva tiempo máximo"
        assert max_bytes > 0
        if isinstance(self.respuesta, Exception):
            raise self.respuesta
        return self.respuesta


def respuesta(status: int, cuerpo: Any = None, headers: dict[str, str] | None = None) -> RespuestaHttp:
    datos = b"" if cuerpo is None else json.dumps(cuerpo).encode("utf-8")
    return RespuestaHttp(status, headers or {}, datos)


def proveedor(resp: RespuestaHttp | Exception, email: str | None = "svc@proyecto.iam.gserviceaccount.com"):
    transporte = TransporteFalso(resp)
    return ProveedorGoogleSheets(transporte, email_cuenta=email), transporte


def libro_valido() -> dict[str, Any]:
    return libro_api(
        pestana(
            "Influencers",
            111,
            [
                [valor_cadena("TCL_KOL_OS_INFLUENCERS_V1")],
                [valor_cadena("clave_influencer"), valor_cadena("nombre"), valor_cadena("fee")],
                [valor_cadena("INF-001"), valor_cadena("Valentina  Rojas"), valor_numero(0.1 + 0.2)],
            ],
        )
    )


# ─────────────────────────── Valores ──────────────────────────────────────────


class TestValores:
    def test_hoja_con_los_tipos_del_contrato_tabular(self) -> None:
        libro = libro_api(
            pestana(
                "Datos",
                7,
                [
                    [valor_cadena("Nombre"), valor_cadena("Fecha"), valor_cadena("Vistas")],
                    [
                        valor_cadena("  Ana   Ruiz "),
                        valor_numero(46000, "DATE"),
                        valor_numero(61420),
                    ],
                    [
                        {"effectiveValue": {"boolValue": True}},
                        valor_numero(46000.5, "DATE_TIME"),
                        {"effectiveValue": {"errorValue": {"type": "DIVIDE_BY_ZERO"}}},
                    ],
                ],
            )
        )
        prov, _ = proveedor(respuesta(200, libro))
        leido = prov.leer_libro(LIBRO_ID)
        hoja = leido.hojas[0]
        assert hoja.nombre == "Datos"
        assert leido.gids == {"Datos": 7}
        # texto con espacios colapsados, igual que en XLSX
        assert hoja.filas[2][1].texto == "Ana Ruiz"
        assert hoja.filas[2][2].tipo == "fecha" and hoja.filas[2][2].texto == "2025-12-09"
        assert hoja.filas[2][3].texto == "61420" and hoja.filas[2][3].tipo == "numero"
        assert hoja.filas[3][1].texto == "TRUE" and hoja.filas[3][1].tipo == "booleano"
        assert hoja.filas[3][2].texto == "2025-12-09T12:00:00"
        assert hoja.filas[3][3].texto == "#DIV/0!" and hoja.filas[3][3].tipo == "error"

    def test_decimales_sin_ruido_binario(self) -> None:
        prov, _ = proveedor(respuesta(200, libro_valido()))
        hoja = prov.leer_libro(LIBRO_ID).hojas[0]
        assert hoja.filas[3][3].texto == "0.3"  # 0.1 + 0.2 → 0.30000000000000004

    def test_formula_se_lee_por_su_valor_y_se_cuenta_sin_guardar_su_texto(self) -> None:
        celda = {
            "userEnteredValue": {"formulaValue": "=SUM(A1:A2)"},
            "effectiveValue": {"numberValue": 7},
        }
        sin_valor = {"userEnteredValue": {"formulaValue": "=IMPORTRANGE(\"x\";\"y\")"}}
        libro = libro_api(pestana("H", 1, [[valor_cadena("a"), valor_cadena("b")], [celda, sin_valor]]))
        prov, _ = proveedor(respuesta(200, libro))
        hoja = prov.leer_libro(LIBRO_ID).hojas[0]
        assert hoja.filas[2][1].texto == "7"
        assert 2 not in hoja.filas[2]  # sin valor guardado: la celda se omite
        assert hoja.formulas == 2 and hoja.formulas_sin_valor == 1
        # La fórmula nunca llega al texto ni al hash.
        assert "SUM" not in json.dumps({n: {c: x.texto for c, x in f.items()} for n, f in hoja.filas.items()})

    def test_pestana_oculta_y_pestana_sin_rejilla_se_declaran(self) -> None:
        libro = libro_api(
            pestana("Visible", 1, [[valor_cadena("a"), valor_cadena("b")]]),
            pestana("Oculta", 2, [[valor_cadena("c"), valor_cadena("d")]], indice=1, oculta=True),
            pestana("Grafico", 3, [], indice=2, tipo="OBJECT"),
        )
        prov, _ = proveedor(respuesta(200, libro))
        leido = prov.leer_libro(LIBRO_ID)
        assert [h.estado for h in leido.hojas] == ["visible", "hidden"]
        assert leido.pestanas_sin_rejilla == ["Grafico"]
        assert leido.gids["Grafico"] == 3

    def test_celdas_vacias_y_filas_vacias_se_omiten(self) -> None:
        libro = libro_api(
            pestana(
                "H",
                1,
                [
                    [valor_cadena("a"), {}, valor_cadena("c")],
                    [{}, {}],
                    [valor_cadena("x"), valor_cadena("y")],
                ],
            )
        )
        prov, _ = proveedor(respuesta(200, libro))
        hoja = prov.leer_libro(LIBRO_ID).hojas[0]
        assert sorted(hoja.filas) == [1, 3]
        assert sorted(hoja.filas[1]) == [1, 3]

    def test_mismo_contrato_de_fragmentos_que_xlsx(self) -> None:
        prov, _ = proveedor(respuesta(200, libro_valido()))
        leido = prov.leer_libro(LIBRO_ID)
        fragmentos, manifiesto = construir_resultado("google_sheets", leido.hojas)
        assert manifiesto["sheets"][0]["name"] == "Influencers"
        f = fragmentos[0]
        assert f.locator is not None and f.locator["kind"] == "range"
        assert f.locator["sheet"] == "Influencers" and f.locator["range"].startswith("A")
        assert "clave_influencer: INF-001" in f.text

    def test_gid_del_enlace_ausente_en_el_libro(self) -> None:
        prov, _ = proveedor(respuesta(200, libro_valido()))
        assert prov.leer_libro(LIBRO_ID, gid="111").gids == {"Influencers": 111}
        with pytest.raises(GoogleSheetsError) as exc:
            prov.leer_libro(LIBRO_ID, gid="999")
        assert exc.value.codigo == "GOOGLE_SHEET_TAB_NOT_FOUND" and not exc.value.reintentable


# ─────────────────────────── Límites ──────────────────────────────────────────


class TestLimites:
    def test_demasiadas_pestanas_se_rechazan_enteras(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(google_sheets, "MAX_HOJAS", 1)
        libro = libro_api(
            pestana("A", 1, [[valor_cadena("a"), valor_cadena("b")]]),
            pestana("B", 2, [[valor_cadena("a"), valor_cadena("b")]], indice=1),
        )
        prov, _ = proveedor(respuesta(200, libro))
        with pytest.raises(GoogleSheetsError) as exc:
            prov.leer_libro(LIBRO_ID)
        assert exc.value.codigo == "INVALID_SPREADSHEET" and not exc.value.reintentable

    def test_demasiadas_filas_o_celdas_se_rechazan_enteras(self, monkeypatch: pytest.MonkeyPatch) -> None:
        filas = [[valor_cadena("a"), valor_cadena("b")] for _ in range(5)]
        prov, _ = proveedor(respuesta(200, libro_api(pestana("H", 1, filas))))
        monkeypatch.setattr(google_sheets, "MAX_FILAS_POR_HOJA", 3)
        with pytest.raises(GoogleSheetsError) as exc:
            prov.leer_libro(LIBRO_ID)
        assert exc.value.codigo == "INVALID_SPREADSHEET"
        monkeypatch.setattr(google_sheets, "MAX_FILAS_POR_HOJA", 100)
        monkeypatch.setattr(google_sheets, "MAX_CELDAS_TOTAL", 4)
        with pytest.raises(GoogleSheetsError) as exc2:
            prov.leer_libro(LIBRO_ID)
        assert exc2.value.codigo == "INVALID_SPREADSHEET"

    def test_celda_larga_se_recorta_y_se_cuenta(self) -> None:
        libro = libro_api(pestana("H", 1, [[valor_cadena("x" * 6000), valor_cadena("y")]]))
        prov, _ = proveedor(respuesta(200, libro))
        hoja = prov.leer_libro(LIBRO_ID).hojas[0]
        assert len(hoja.filas[1][1].texto) == 5000 and hoja.celdas_recortadas == 1


# ─────────────────────────── Errores de la API ────────────────────────────────


class TestErrores:
    @pytest.mark.parametrize(
        ("status", "codigo", "reintentable"),
        [
            (401, "GOOGLE_AUTH_FAILED", False),
            (403, "GOOGLE_FORBIDDEN", False),
            (404, "GOOGLE_NOT_FOUND", False),
            (429, "GOOGLE_RATE_LIMITED", True),
            (500, "GOOGLE_UNAVAILABLE", True),
            (503, "GOOGLE_UNAVAILABLE", True),
            (400, "GOOGLE_REQUEST_FAILED", False),
        ],
    )
    def test_cada_status_tiene_su_tratamiento(self, status: int, codigo: str, reintentable: bool) -> None:
        cuerpo = {"error": {"message": f"detalle interno {SECRETO}", "status": "X"}}
        prov, _ = proveedor(respuesta(status, cuerpo))
        with pytest.raises(GoogleSheetsError) as exc:
            prov.leer_libro(LIBRO_ID)
        assert exc.value.codigo == codigo
        assert exc.value.reintentable is reintentable
        # El cuerpo de error de Google jamás llega al mensaje.
        assert SECRETO not in str(exc.value)

    def test_403_indica_con_quien_compartir_el_sheet(self) -> None:
        prov, _ = proveedor(respuesta(403, {"error": {"status": "PERMISSION_DENIED"}}))
        with pytest.raises(GoogleSheetsError) as exc:
            prov.leer_libro(LIBRO_ID)
        assert "svc@proyecto.iam.gserviceaccount.com" in str(exc.value)

    def test_403_por_cuota_es_transitorio(self) -> None:
        cuerpo = {"error": {"status": "RESOURCE_EXHAUSTED", "errors": [{"reason": "rateLimitExceeded"}]}}
        prov, _ = proveedor(respuesta(403, cuerpo))
        with pytest.raises(GoogleSheetsError) as exc:
            prov.leer_libro(LIBRO_ID)
        assert exc.value.codigo == "GOOGLE_RATE_LIMITED" and exc.value.reintentable

    def test_429_respeta_retry_after_con_techo(self) -> None:
        prov, _ = proveedor(respuesta(429, {"error": {}}, {"retry-after": "120"}))
        with pytest.raises(GoogleSheetsError) as exc:
            prov.leer_libro(LIBRO_ID)
        assert exc.value.espera_s == 120
        prov2, _ = proveedor(respuesta(429, {"error": {}}, {"retry-after": "99999"}))
        with pytest.raises(GoogleSheetsError) as exc2:
            prov2.leer_libro(LIBRO_ID)
        assert exc2.value.espera_s == 900

    @pytest.mark.parametrize("falla", ["GOOGLE_TIMEOUT", "GOOGLE_UNAVAILABLE"])
    def test_fallos_de_transporte_se_propagan_como_transitorios(self, falla: str) -> None:
        prov, _ = proveedor(GoogleSheetsError(falla, "x", reintentable=True))
        with pytest.raises(GoogleSheetsError) as exc:
            prov.leer_libro(LIBRO_ID)
        assert exc.value.codigo == falla and exc.value.reintentable

    @pytest.mark.parametrize("cuerpo", [b"no es json", b"[]", b'{"sheets": "x"}'])
    def test_respuesta_200_con_forma_inesperada(self, cuerpo: bytes) -> None:
        prov, _ = proveedor(RespuestaHttp(200, {}, cuerpo))
        with pytest.raises(GoogleSheetsError) as exc:
            prov.leer_libro(LIBRO_ID)
        assert exc.value.codigo == "GOOGLE_INVALID_RESPONSE" and not exc.value.reintentable

    def test_pestana_sin_identificador_es_respuesta_invalida(self) -> None:
        libro = {"sheets": [{"properties": {"title": "H"}}]}
        prov, _ = proveedor(respuesta(200, libro))
        with pytest.raises(GoogleSheetsError) as exc:
            prov.leer_libro(LIBRO_ID)
        assert exc.value.codigo == "GOOGLE_INVALID_RESPONSE"


# ─────────────────────────── Frontera de red ──────────────────────────────────


class TestFronteraDeRed:
    @pytest.mark.parametrize(
        "malo",
        [
            "https://evil.example.com/x",
            "https://docs.google.com/spreadsheets/d/" + LIBRO_ID,
            "../etc/passwd",
            LIBRO_ID + "/../../otro",
            LIBRO_ID + "?x=1",
            LIBRO_ID + "@evil.com",
            LIBRO_ID + ".evil.com",
            "corto",
            "",
            "a" * 129,
            "https://sheets.googleapis.com/v4/spreadsheets/" + LIBRO_ID,
        ],
    )
    def test_un_id_hostil_no_genera_ninguna_peticion(self, malo: str) -> None:
        prov, transporte = proveedor(respuesta(200, libro_valido()))
        with pytest.raises(GoogleSheetsError) as exc:
            prov.leer_libro(malo)
        assert exc.value.codigo == "INVALID_SOURCE_URL"
        assert transporte.llamadas == []

    def test_la_peticion_valida_va_solo_a_la_api_de_sheets(self) -> None:
        prov, transporte = proveedor(respuesta(200, libro_valido()))
        prov.leer_libro(LIBRO_ID)
        (url, params), = transporte.llamadas
        assert url == f"https://sheets.googleapis.com/v4/spreadsheets/{LIBRO_ID}"
        assert params["includeGridData"] == "true"
        # La máscara pide valores efectivos; nunca el texto completo de las fórmulas.
        assert "effectiveValue" in params["fields"]

    @pytest.mark.parametrize(
        "url",
        [
            "http://sheets.googleapis.com/v4/spreadsheets/x",
            "https://evil.com/v4/spreadsheets/x",
            "https://sheets.googleapis.com.evil.com/v4/spreadsheets/x",
            "https://sheets.googleapis.com:8443/v4/spreadsheets/x",
            "https://user:pw@sheets.googleapis.com/v4/spreadsheets/x",
            "https://sheets.googleapis.com/v4/otra-cosa",
            "https://169.254.169.254/v4/spreadsheets/x",
            "https://localhost/v4/spreadsheets/x",
        ],
    )
    def test_validar_url_rechaza_cualquier_otro_destino(self, url: str) -> None:
        with pytest.raises(GoogleSheetsError) as exc:
            validar_url_de_api(url)
        assert exc.value.codigo == "GOOGLE_HOST_NOT_ALLOWED"

    def test_el_transporte_real_valida_el_destino_antes_de_llamar(self) -> None:
        class Sesion:
            llamadas = 0

            def get(self, *args: Any, **kwargs: Any) -> Any:
                Sesion.llamadas += 1

        transporte = TransporteGoogle(credenciales=None, sesion=Sesion())
        with pytest.raises(GoogleSheetsError):
            transporte.get("https://evil.com/v4/spreadsheets/x", {}, timeout=(1, 1), max_bytes=10)
        assert Sesion.llamadas == 0

    def test_el_transporte_real_no_sigue_redirecciones_y_acota_el_tamano(self) -> None:
        capturado: dict[str, Any] = {}

        class Resp:
            status_code = 200
            headers = {"ETag": "x"}

            def __init__(self, trozos: list[bytes]) -> None:
                self._trozos = trozos

            def iter_content(self, chunk_size: int) -> Any:
                yield from self._trozos

            def close(self) -> None:
                capturado["cerrada"] = True

        class Sesion:
            def __init__(self, trozos: list[bytes]) -> None:
                self.trozos = trozos

            def get(self, url: str, **kwargs: Any) -> Resp:
                capturado.update(kwargs)
                return Resp(self.trozos)

        url = f"https://sheets.googleapis.com/v4/spreadsheets/{LIBRO_ID}"
        ok = TransporteGoogle(None, Sesion([b"{}"])).get(url, {"a": "b"}, timeout=(1, 2), max_bytes=100)
        assert ok.status == 200 and ok.cuerpo == b"{}" and ok.headers == {"etag": "x"}
        assert capturado["allow_redirects"] is False
        assert capturado["stream"] is True
        assert capturado["timeout"] == (1, 2)

        with pytest.raises(GoogleSheetsError) as exc:
            TransporteGoogle(None, Sesion([b"x" * 60, b"x" * 60])).get(
                url, {}, timeout=(1, 2), max_bytes=100
            )
        assert exc.value.codigo == "GOOGLE_RESPONSE_TOO_LARGE" and not exc.value.reintentable
        assert capturado["cerrada"] is True


# ─────────────────────────── Credenciales ─────────────────────────────────────


def clave_de_servicio(ruta: Path, **cambios: Any) -> Path:
    """Escribe una clave de cuenta de servicio con una RSA generada al vuelo."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    privada = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = privada.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()
    info: dict[str, Any] = {
        "type": "service_account",
        "project_id": "p",
        "private_key_id": "kid",
        "private_key": pem,
        "client_email": "svc@proyecto.iam.gserviceaccount.com",
        "client_id": "1",
        "token_uri": "https://oauth2.googleapis.com/token",
    }
    info.update(cambios)
    ruta.write_text(json.dumps(info), encoding="utf-8")
    return ruta


class TestCredenciales:
    def test_sin_configuracion(self) -> None:
        with pytest.raises(GoogleSheetsError) as exc:
            cargar_cuenta_de_servicio({})
        assert exc.value.codigo == "GOOGLE_NOT_CONFIGURED" and not exc.value.reintentable

    def test_archivo_inexistente_o_ilegible(self, tmp_path: Path) -> None:
        with pytest.raises(GoogleSheetsError) as exc:
            cargar_cuenta_de_servicio({"GOOGLE_SERVICE_ACCOUNT_KEY_PATH": str(tmp_path / "no.json")})
        assert exc.value.codigo == "GOOGLE_NOT_CONFIGURED"
        # La ruta tampoco se filtra al mensaje.
        assert str(tmp_path) not in str(exc.value)

    def test_json_invalido_no_filtra_contenido(self, tmp_path: Path) -> None:
        malo = tmp_path / "k.json"
        malo.write_text(f'{{"private_key": "{SECRETO}" ', encoding="utf-8")
        with pytest.raises(GoogleSheetsError) as exc:
            cargar_cuenta_de_servicio({"GOOGLE_SERVICE_ACCOUNT_KEY_PATH": str(malo)})
        assert SECRETO not in str(exc.value) and exc.value.__cause__ is None

    @pytest.mark.parametrize(
        "cambio",
        [
            {"type": "authorized_user"},
            {"token_uri": "https://evil.example.com/token"},
            {"private_key": 5},
            {"client_email": None},
        ],
    )
    def test_clave_con_forma_o_destino_invalidos(self, tmp_path: Path, cambio: dict[str, Any]) -> None:
        ruta = clave_de_servicio(tmp_path / "k.json", **cambio)
        with pytest.raises(GoogleSheetsError) as exc:
            cargar_cuenta_de_servicio({"GOOGLE_SERVICE_ACCOUNT_KEY_PATH": str(ruta)})
        assert exc.value.codigo == "GOOGLE_NOT_CONFIGURED"

    def test_clave_con_pem_corrupto_no_filtra_el_secreto(self, tmp_path: Path) -> None:
        ruta = clave_de_servicio(tmp_path / "k.json", private_key=f"-----BEGIN PRIVATE KEY-----\n{SECRETO}\n")
        with pytest.raises(GoogleSheetsError) as exc:
            cargar_cuenta_de_servicio({"GOOGLE_SERVICE_ACCOUNT_KEY_PATH": str(ruta)})
        assert SECRETO not in str(exc.value) and exc.value.__cause__ is None

    def test_clave_valida_solo_pide_alcance_de_lectura(self, tmp_path: Path) -> None:
        ruta = clave_de_servicio(tmp_path / "k.json")
        cuenta = cargar_cuenta_de_servicio({"GOOGLE_SERVICE_ACCOUNT_KEY_PATH": str(ruta)})
        assert cuenta.email == "svc@proyecto.iam.gserviceaccount.com"
        assert list(cuenta.credenciales.scopes) == [ALCANCE_SOLO_LECTURA]
        assert ALCANCE_SOLO_LECTURA.endswith("spreadsheets.readonly")
        # Ningún alcance de escritura en el módulo.
        fuente = Path(google_sheets.__file__).read_text(encoding="utf-8")
        assert "auth/spreadsheets\"" not in fuente and "auth/drive" not in fuente

    def test_la_clave_no_aparece_en_logs_al_construir_ni_al_fallar(
        self, tmp_path: Path, caplog: pytest.LogCaptureFixture
    ) -> None:
        ruta = clave_de_servicio(tmp_path / "k.json")
        privada = json.loads(ruta.read_text())["private_key"]
        with caplog.at_level(logging.DEBUG):
            cuenta = cargar_cuenta_de_servicio({"GOOGLE_SERVICE_ACCOUNT_KEY_PATH": str(ruta)})
            prov, _ = proveedor(respuesta(403, {"error": {}}), cuenta.email)
            with pytest.raises(GoogleSheetsError):
                prov.leer_libro(LIBRO_ID)
        texto = caplog.text
        assert privada not in texto and "BEGIN PRIVATE KEY" not in texto

    def test_crear_proveedor_sin_credenciales_falla_de_forma_controlada(self) -> None:
        with pytest.raises(GoogleSheetsError) as exc:
            crear_proveedor("tclkolos", {})
        assert exc.value.codigo == "GOOGLE_NOT_CONFIGURED"


# ─────────────────────────── Fixtures de prueba ───────────────────────────────


class TestFixtures:
    def test_solo_en_base_de_pruebas(self, tmp_path: Path) -> None:
        (tmp_path / f"{LIBRO_ID}.json").write_text(json.dumps({"status": 200, "body": libro_valido()}))
        env = {"GOOGLE_SHEETS_FIXTURE_DIR": str(tmp_path)}
        # Base de pruebas: lee del archivo, sin red ni credenciales.
        prov = crear_proveedor("tclkolos_test", env)
        assert prov.leer_libro(LIBRO_ID).hojas[0].nombre == "Influencers"
        # Cualquier otra base ignora la variable: intenta el camino real (sin credenciales).
        for base in ("tclkolos", "tclkolos_test_x", "produccion"):
            with pytest.raises(GoogleSheetsError) as exc:
                crear_proveedor(base, env)
            assert exc.value.codigo == "GOOGLE_NOT_CONFIGURED"
        # En producción tampoco, aunque la base se llame `_test`.
        with pytest.raises(GoogleSheetsError):
            crear_proveedor("x_test", {**env, "ENVIRONMENT": "production"})

    def test_fixture_inexistente_es_404_y_hostil_se_rechaza(self, tmp_path: Path) -> None:
        t = TransporteDeFixtures(str(tmp_path))
        url = f"https://sheets.googleapis.com/v4/spreadsheets/{LIBRO_ID}"
        assert t.get(url, {}, timeout=(1, 1), max_bytes=10).status == 404
        with pytest.raises(GoogleSheetsError):
            t.get("https://evil.com/v4/spreadsheets/x", {}, timeout=(1, 1), max_bytes=10)

    def test_fixture_simula_fallos_de_red(self, tmp_path: Path) -> None:
        (tmp_path / f"{LIBRO_ID}.json").write_text(json.dumps({"raise": "timeout"}))
        prov = ProveedorGoogleSheets(TransporteDeFixtures(str(tmp_path)))
        with pytest.raises(GoogleSheetsError) as exc:
            prov.leer_libro(LIBRO_ID)
        assert exc.value.codigo == "GOOGLE_TIMEOUT" and exc.value.reintentable


# ─────────────────────────── Hash de contenido ────────────────────────────────


def leer(libro: dict[str, Any]) -> tuple[list[Any], dict[str, int]]:
    prov, _ = proveedor(respuesta(200, libro))
    leido = prov.leer_libro(LIBRO_ID)
    return leido.hojas, leido.gids


class TestHash:
    def test_determinista_y_hexadecimal(self) -> None:
        a = hash_de_contenido(*leer(libro_valido()))
        b = hash_de_contenido(*leer(libro_valido()))
        assert a == b and len(a) == 64 and int(a, 16) >= 0

    def test_no_depende_del_titulo_ni_del_orden_de_pestanas(self) -> None:
        p1 = pestana("A", 1, [[valor_cadena("x"), valor_cadena("y")]])
        p2 = pestana("B", 2, [[valor_cadena("z"), valor_cadena("w")]], indice=1)
        base = hash_de_contenido(*leer(libro_api(p1, p2, titulo="Uno")))
        otro = hash_de_contenido(*leer(libro_api(p2, p1, titulo="Dos")))
        assert base == otro

    @pytest.mark.parametrize(
        "cambio",
        ["celda", "fila_nueva", "gid", "nombre_pestana", "tipo", "oculta"],
    )
    def test_cualquier_cambio_de_contenido_cambia_el_hash(self, cambio: str) -> None:
        def armar(**k: Any) -> dict[str, Any]:
            texto = k.get("texto", "valor")
            filas = [[valor_cadena("a"), valor_cadena(texto)]]
            if k.get("extra"):
                filas.append([valor_cadena("n"), valor_cadena("m")])
            if k.get("numero"):
                filas = [[valor_cadena("a"), valor_numero(5)]]
            return libro_api(
                pestana(k.get("nombre", "H"), k.get("gid", 1), filas, oculta=k.get("oculta", False))
            )

        base = hash_de_contenido(*leer(armar()))
        variantes = {
            "celda": armar(texto="otro"),
            "fila_nueva": armar(extra=True),
            "gid": armar(gid=2),
            "nombre_pestana": armar(nombre="Z"),
            "tipo": armar(numero=True),
            "oculta": armar(oculta=True),
        }
        assert hash_de_contenido(*leer(variantes[cambio])) != base

    def test_formulas_no_alteran_el_hash(self) -> None:
        sin = libro_api(pestana("H", 1, [[valor_cadena("a"), {"effectiveValue": {"numberValue": 3}}]]))
        con = libro_api(
            pestana(
                "H",
                1,
                [
                    [
                        valor_cadena("a"),
                        {
                            "effectiveValue": {"numberValue": 3},
                            "userEnteredValue": {"formulaValue": "=1+2"},
                        },
                    ]
                ],
            )
        )
        assert hash_de_contenido(*leer(sin)) == hash_de_contenido(*leer(con))
