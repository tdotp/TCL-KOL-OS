"""El texto de los fragmentos del Sheet de influencers V1 NO lleva columnas financieras (P0 · F8).

`fee`, `canje` y `condiciones` (y cualquier columna que no esté en la lista blanca:
teléfono, dirección, cédula…) no pueden llegar al texto que leen el consultor, el
analista, el agente, la extracción del Brief y TCL (DEC-014 / DEC-049). Sus valores
siguen en la rejilla del snapshot (`Hoja.filas`), que estas pruebas no tocan.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.parsers import csv_parser
from app.parsers.tabular import (
    Celda,
    Hoja,
    construir_resultado,
    es_hoja_influencers_v1,
    fragmentar_hoja,
)

MARCADOR = "TCL_KOL_OS_INFLUENCERS_V1"
CABECERAS = [
    "clave_influencer",
    "nombre",
    "plataforma",
    "handle",
    "producto",
    "fee",
    "canje",
    "condiciones",
    "telefono",
    "kpi_objetivo",
]
FILA = [
    "INF-001",
    "Valentina Rios",
    "instagram",
    "val.rios",
    "P80",
    "9876543",
    "lavadora-secreta",
    "exclusividad-12-meses",
    "+57-300-5551234",
    "Alcanzar 50.000 vistas",
]
PROHIBIDOS = ["9876543", "lavadora-secreta", "exclusividad-12-meses", "+57-300-5551234"]
ETIQUETAS_PROHIBIDAS = ["fee", "canje", "condiciones", "telefono"]


def hoja_v1(
    cabeceras: list[str] = CABECERAS,
    filas: list[list[str]] | None = None,
    marcador: str = MARCADOR,
    fila1_extra: dict[int, str] | None = None,
) -> Hoja:
    hoja = Hoja(nombre="Influencers", indice=1)
    fila1 = {1: Celda(marcador)}
    for col, texto in (fila1_extra or {}).items():
        fila1[col] = Celda(texto)
    hoja.filas[1] = fila1
    hoja.filas[2] = {i: Celda(c) for i, c in enumerate(cabeceras, start=1)}
    for n, valores in enumerate(filas if filas is not None else [FILA], start=3):
        hoja.filas[n] = {i: Celda(v) for i, v in enumerate(valores, start=1) if v}
    return hoja


def texto_de(hoja: Hoja) -> str:
    fragmentos, _ = fragmentar_hoja(hoja, 0)
    return "\n".join(f.text for f in fragmentos)


class TestListaBlanca:
    def test_excluye_fee_canje_condiciones_y_columna_desconocida(self) -> None:
        texto = texto_de(hoja_v1())
        for valor in PROHIBIDOS:
            assert valor not in texto
        for etiqueta in ETIQUETAS_PROHIBIDAS:
            assert f"{etiqueta}:" not in texto

    def test_conserva_identidad_producto_kpi_y_rango(self) -> None:
        hoja = hoja_v1()
        fragmentos, manifiesto = fragmentar_hoja(hoja, 0)
        assert len(fragmentos) == 1
        texto = fragmentos[0].text
        for esperado in [
            "clave_influencer: INF-001",
            "nombre: Valentina Rios",
            "plataforma: instagram",
            "handle: val.rios",
            "producto: P80",
            "kpi_objetivo: Alcanzar 50.000 vistas",
            MARCADOR,
        ]:
            assert esperado in texto
        # La procedencia no cambia: el rango cubre TODAS las columnas reales de la fila.
        loc = fragmentos[0].locator
        assert loc["range"] == "A1:J3" and loc["rowStart"] == 1 and loc["rowEnd"] == 3
        assert loc["colEnd"] == len(CABECERAS)
        assert fragmentos[0].metadata["filas"] == [1, 3]
        assert manifiesto["headerRow"] == 2

    def test_los_valores_siguen_en_la_rejilla_del_snapshot(self) -> None:
        hoja = hoja_v1()
        fragmentar_hoja(hoja, 0)
        valores = {c.texto for c in hoja.filas[3].values()}
        assert set(PROHIBIDOS) <= valores  # la rejilla no se toca

    def test_el_manifiesto_declara_las_columnas_retenidas(self) -> None:
        _, manifiesto = fragmentar_hoja(hoja_v1(), 0)
        lista = manifiesto["fragmentTextAllowlist"]
        assert lista["columnsWithheld"] == 4  # fee, canje, condiciones, telefono
        assert "fee" not in lista["columns"] and "canje" not in lista["columns"]
        assert "nombre" in lista["columns"]

    @pytest.mark.parametrize(
        "cabecera",
        ["Fee", "FEE", " fee ", "Fee ", "canje", "Condiciones", "condiciones extra", "fee (2)", "monto"],
    )
    def test_variantes_de_cabecera_financiera_no_pasan(self, cabecera: str) -> None:
        hoja = hoja_v1(["clave_influencer", "nombre", cabecera], [["INF-9", "Ana Gil", "5550000"]])
        texto = texto_de(hoja)
        assert "5550000" not in texto
        assert "nombre: Ana Gil" in texto

    def test_cabeceras_con_formato_del_esquema_se_normalizan(self) -> None:
        hoja = hoja_v1(
            ["Clave Influencer", "Nombre", "Kpi-Objetivo", "Fee"],
            [["INF-2", "Luis Mora", "Mil vistas", "7777777"]],
        )
        texto = texto_de(hoja)
        assert "Luis Mora" in texto and "Mil vistas" in texto
        assert "7777777" not in texto

    def test_duplicada_de_cabecera_no_filtra_por_la_copia(self) -> None:
        hoja = hoja_v1(
            ["clave_influencer", "nombre", "fee", "fee"],
            [["INF-3", "Eva Paz", "111111", "222222"]],
        )
        texto = texto_de(hoja)
        assert "111111" not in texto and "222222" not in texto

    def test_columna_sin_cabecera_no_entra(self) -> None:
        # Una celda de datos sin cabecera (COLUMN_WITHOUT_HEADER) es desconocida: fuera.
        hoja = hoja_v1(["clave_influencer", "nombre"], [["INF-4", "Ana Gil", "dato-sin-cabecera"]])
        assert "dato-sin-cabecera" not in texto_de(hoja)

    def test_celdas_extra_de_la_fila_marcador_no_entran(self) -> None:
        hoja = hoja_v1(fila1_extra={2: "nota-privada-cedula-123"})
        assert "nota-privada-cedula-123" not in texto_de(hoja)

    def test_marcador_con_otras_mayusculas_o_version_futura_tambien_filtra(self) -> None:
        for marcador in ("tcl_kol_os_influencers_v1", "TCL_KOL_OS_INFLUENCERS_V2"):
            assert es_hoja_influencers_v1(hoja_v1(marcador=marcador))
            texto = texto_de(hoja_v1(marcador=marcador))
            assert "9876543" not in texto and "nombre: Valentina Rios" in texto

    def test_sin_fila_de_cabeceras_no_se_vuelca_ningun_dato(self) -> None:
        hoja = Hoja(nombre="Influencers", indice=1)
        hoja.filas[1] = {1: Celda(MARCADOR)}
        hoja.filas[3] = {1: Celda("INF-1"), 2: Celda("Ana Gil"), 3: Celda("9876543")}
        texto = texto_de(hoja)
        assert "9876543" not in texto and "Ana Gil" not in texto

    def test_muchas_filas_varios_fragmentos_sin_fuga(self) -> None:
        filas = [
            [f"INF-{i}", f"Persona {i}", "tiktok", f"h{i}", "P80", f"{i}0000009", "c", "d", "t", "k"]
            for i in range(40)
        ]
        hoja = hoja_v1(filas=filas)
        fragmentos, _ = fragmentar_hoja(hoja, 0)
        assert len(fragmentos) > 1
        todo = "\n".join(f.text for f in fragmentos)
        assert "0000009" not in todo
        assert "Persona 39" in todo

    @pytest.mark.parametrize(
        ("valor", "entra"),
        [("mixto", True), ("Fee", True), ("canje", True), ("fee de 5.000.000", False), ("5000000", False)],
    )
    def test_tipo_acuerdo_solo_si_no_revela_montos(self, valor: str, entra: bool) -> None:
        hoja = hoja_v1(["clave_influencer", "nombre", "tipo_acuerdo"], [["INF-5", "Ana Gil", valor]])
        assert (f"tipo_acuerdo: {valor}" in texto_de(hoja)) is entra
        assert "5.000.000" not in texto_de(hoja)

    def test_fechas_y_entregables_si_entran(self) -> None:
        hoja = hoja_v1(
            ["clave_influencer", "nombre", "entregables", "fecha_inicio", "fecha_fin"],
            [["INF-6", "Ana Gil", "1 reel + 3 stories", "2026-11-01", "2026-12-01"]],
        )
        texto = texto_de(hoja)
        for esperado in ("1 reel + 3 stories", "2026-11-01", "2026-12-01"):
            assert esperado in texto


class TestNoCambiaLoQueNoEsV1:
    def test_hoja_generica_conserva_todas_las_columnas(self) -> None:
        hoja = Hoja(nombre="Datos", indice=1)
        hoja.filas[1] = {1: Celda("nombre"), 2: Celda("fee"), 3: Celda("telefono")}
        hoja.filas[2] = {1: Celda("Ana"), 2: Celda("123456"), 3: Celda("555")}
        fragmentos, manifiesto = fragmentar_hoja(hoja, 0)
        assert "fee: 123456" in fragmentos[0].text and "telefono: 555" in fragmentos[0].text
        assert "fragmentTextAllowlist" not in manifiesto

    def test_marcador_que_no_esta_en_a1_no_activa_el_filtro(self) -> None:
        hoja = Hoja(nombre="Datos", indice=1)
        hoja.filas[1] = {1: Celda("otra cosa"), 2: Celda(MARCADOR)}
        hoja.filas[2] = {1: Celda("a"), 2: Celda("fee")}
        hoja.filas[3] = {1: Celda("x"), 2: Celda("999")}
        assert not es_hoja_influencers_v1(hoja)
        assert "999" in texto_de(hoja)


class TestExtremoAExtremo:
    def test_csv_del_esquema_filtra_en_el_resultado_del_parser(self, tmp_path: Path) -> None:
        raiz = Path(__file__).resolve().parents[3] / "fixtures" / "influencer-sheet" / "valido-completo.csv"
        resultado = csv_parser.parse_completo(str(raiz))
        todo = "\n".join(f.text for f in resultado.fragmentos)
        for prohibido in ("1500000", "Equipo P80", "Sin exclusividad", "TV de prueba", "Devolver el equipo"):
            assert prohibido not in todo
        assert "Valentina Rojas" in todo and "P80 Pro" in todo and "juanperez" in todo

    def test_construir_resultado_google_sheets_filtra(self) -> None:
        fragmentos, manifiesto = construir_resultado("google_sheets", [hoja_v1()])
        assert all(v not in f.text for f in fragmentos for v in PROHIBIDOS)
        assert manifiesto["sheets"][0]["fragmentCount"] == len(fragmentos)
