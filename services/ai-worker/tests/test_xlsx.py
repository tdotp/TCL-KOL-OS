"""XLSX y CSV (V2 · Fase 4): estructura, localizadores, valores y seguridad.

La propiedad que se prueba: de una hoja de cálculo se obtienen fragmentos que
(a) conservan la relación cabecera → valor, (b) saben su hoja y su rango exactos
y (c) nunca ejecutan nada. Los libros de prueba se generan con `xlsxwriter` (que
puede escribir fórmulas con un valor calculado guardado) o con un constructor
mínimo para los casos hostiles que ninguna herramienta legítima produce.
"""

from __future__ import annotations

import datetime as dt
import re
import zipfile
from pathlib import Path
from typing import Any

import pytest

from app import parsers
from app.parsers import xlsx_parser
from app.parsers.base import ParseError
from app.parsers.tabular import col_letras

xlsxwriter = pytest.importorskip("xlsxwriter")

XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
A1 = re.compile(r"^([A-Z]+)(\d+):([A-Z]+)(\d+)$")


def libro(ruta: Path, hojas: dict[str, list[list[Any]]], **opciones: Any) -> Path:
    """Crea un libro con `hojas` = {nombre: filas}. `None` deja la celda vacía."""
    wb = xlsxwriter.Workbook(str(ruta), opciones)
    fecha = wb.add_format({"num_format": "yyyy-mm-dd"})
    fecha_hora = wb.add_format({"num_format": "yyyy-mm-dd hh:mm:ss"})
    for nombre, filas in hojas.items():
        ws = wb.add_worksheet(nombre)
        for r, fila in enumerate(filas):
            for c, valor in enumerate(fila):
                if valor is None:
                    continue
                if isinstance(valor, dt.datetime):
                    ws.write_datetime(r, c, valor, fecha_hora)
                elif isinstance(valor, dt.date):
                    ws.write_datetime(r, c, dt.datetime(valor.year, valor.month, valor.day), fecha)
                else:
                    ws.write(r, c, valor)
    wb.close()
    return ruta


def parsear(ruta: Path):  # type: ignore[no-untyped-def]
    return parsers.parse_completo(str(ruta), XLSX)


def texto_total(resultado) -> str:  # type: ignore[no-untyped-def]
    return "\n".join(f.text for f in resultado.fragmentos)


# ─────────────────────────── Estructura y cabeceras ───────────────────────────


def test_detecta_las_hojas_y_conserva_encabezados(tmp_path: Path) -> None:
    ruta = libro(
        tmp_path / "campana.xlsx",
        {
            "Influencers": [
                ["Nombre", "Instagram", "Producto", "Fee"],
                ["Valentina Rojas", "@valentina", "C7K", 1500000],
                ["Mateo Díaz", "@mateo", "X955", 900000],
            ],
            "Producto": [["Modelo", "Brillo"], ["C7K", "1300 nits"]],
        },
    )
    r = parsear(ruta)

    assert r.formato == "xlsx"
    assert r.estructura is not None
    nombres = [h["name"] for h in r.estructura["sheets"]]
    assert nombres == ["Influencers", "Producto"]
    infl = r.estructura["sheets"][0]
    assert infl["headerRow"] == 1
    assert [h["name"] for h in infl["headers"]] == ["Nombre", "Instagram", "Producto", "Fee"]
    assert infl["rowCount"] == 3 and infl["dimension"] == "A1:D3"

    # Cabecera → valor, no «valor | valor | valor».
    texto = texto_total(r)
    assert "Nombre: Valentina Rojas" in texto
    assert "Instagram: @valentina" in texto
    assert "Producto: C7K" in texto
    assert "Fee: 1500000" in texto
    assert "Valentina Rojas | @valentina" not in texto


def test_cada_fragmento_sabe_su_hoja_y_su_rango_exactos(tmp_path: Path) -> None:
    filas: list[list[Any]] = [["Nombre", "Handle"]] + [[f"Persona {n}", f"@p{n}"] for n in range(1, 41)]
    ruta = libro(tmp_path / "grande.xlsx", {"Influencers": filas})
    r = parsear(ruta)

    for f in r.fragmentos:
        loc = f.locator
        assert loc is not None and loc["kind"] == "range" and loc["sheet"] == "Influencers"
        assert A1.match(loc["range"]), loc
        # La cadena A1 es exactamente la de sus límites numéricos (no puede divergir).
        esperado = (
            f"{col_letras(loc['colStart'])}{loc['rowStart']}:{col_letras(loc['colEnd'])}{loc['rowEnd']}"
        )
        assert loc["range"] == esperado
        assert loc["rowStart"] <= loc["rowEnd"] and loc["colStart"] == 1 and loc["colEnd"] == 2
        assert f.section == "Influencers"  # legible para quien lea solo las columnas legacy
        # El texto del fragmento incluye exactamente las filas que declara su rango.
        filas_del_texto = [int(n) for n in re.findall(r"^Fila (\d+)$", f.text, flags=re.MULTILINE)]
        assert filas_del_texto == list(range(loc["rowStart"], loc["rowEnd"] + 1))
        assert f.metadata["filas"] == filas_del_texto


def test_una_hoja_grande_no_es_un_solo_texto_ni_una_fila_por_fragmento(tmp_path: Path) -> None:
    filas: list[list[Any]] = [["Nombre", "Handle", "Producto"]] + [
        [f"Persona {n}", f"@persona{n}", "C7K"] for n in range(1, 201)
    ]
    r = parsear(libro(tmp_path / "doscientas.xlsx", {"Hoja": filas}))

    assert 1 < len(r.fragmentos) < 200
    assert all(len(f.metadata["filas"]) <= 8 for f in r.fragmentos)
    cubiertas = sorted(n for f in r.fragmentos for n in f.metadata["filas"])
    assert cubiertas == list(range(2, 202))  # todas las filas de datos, una sola vez
    assert [f.ordinal for f in r.fragmentos] == list(range(len(r.fragmentos)))


def test_conserva_los_numeros_de_fila_reales_con_huecos_y_desfase(tmp_path: Path) -> None:
    filas: list[list[Any]] = [
        [None, None],
        ["Reporte de campaña", None],  # una sola celda: no es cabecera
        [None, None],
        ["Nombre", "Producto"],
        ["Valentina", "C7K"],
        [None, None],
        [None, None],
        ["Mateo", "X955"],
    ]
    r = parsear(libro(tmp_path / "huecos.xlsx", {"Hoja": filas}))
    hoja = r.estructura["sheets"][0]  # type: ignore[index]

    assert hoja["headerRow"] == 4
    assert hoja["firstRow"] == 2 and hoja["lastRow"] == 8
    texto = texto_total(r)
    assert "Fila 5\nNombre: Valentina" in texto
    assert "Fila 8\nNombre: Mateo" in texto
    # La fila de título anterior a la cabecera se conserva, con la letra de columna.
    assert "Fila 2\nA: Reporte de campaña" in texto


def test_un_hueco_entre_filas_corta_el_fragmento_y_el_rango_es_siempre_contiguo(tmp_path: Path) -> None:
    filas: list[list[Any]] = [
        ["Nombre", "Producto"],
        ["A", "1"],
        ["B", "2"],
        [None, None],
        [None, None],
        ["C", "3"],
    ]
    r = parsear(libro(tmp_path / "gap.xlsx", {"Hoja": filas}))
    rangos = [(f.locator["rowStart"], f.locator["rowEnd"]) for f in r.fragmentos]  # type: ignore[index]
    assert rangos == [(2, 3), (6, 6)]  # las filas 4–5 vacías separan los fragmentos


def test_la_fila_de_cabecera_no_es_un_hueco(tmp_path: Path) -> None:
    filas: list[list[Any]] = [["Título solo"], [None], [None], [None], ["Nombre", "Producto"], ["A", "1"]]
    r = parsear(libro(tmp_path / "cab.xlsx", {"Hoja": filas}))
    assert [f.locator["range"] for f in r.fragmentos] == ["A1:A1", "A6:B6"]  # type: ignore[index]


def test_cabeceras_duplicadas_o_vacias_se_desambiguan(tmp_path: Path) -> None:
    r = parsear(
        libro(tmp_path / "dup.xlsx", {"H": [["Fecha", "Fecha", None, "Total"], ["a", "b", "c", "d"]]})
    )
    nombres = [h["name"] for h in r.estructura["sheets"][0]["headers"]]  # type: ignore[index]
    assert nombres == ["Fecha", "Fecha (2)", "Total"]
    assert "C: c" in texto_total(r)  # la columna sin cabecera usa su letra


def test_una_hoja_sin_cabecera_de_texto_usa_letras_de_columna(tmp_path: Path) -> None:
    r = parsear(libro(tmp_path / "num.xlsx", {"H": [[1, 2], [3, 4]]}))
    hoja = r.estructura["sheets"][0]  # type: ignore[index]
    assert hoja["headerRow"] is None
    assert "A: 1" in texto_total(r) and "B: 4" in texto_total(r)


def test_hoja_oculta_se_procesa_y_se_marca(tmp_path: Path) -> None:
    ruta = tmp_path / "oculta.xlsx"
    wb = xlsxwriter.Workbook(str(ruta))
    wb.add_worksheet("Visible").write_row("A1", ["Nombre", "Dato"])
    wb.get_worksheet_by_name("Visible").write_row("A2", ["x", "1"])  # type: ignore[union-attr]
    oculta = wb.add_worksheet("Interna")
    oculta.write_row("A1", ["Campo", "Valor"])
    oculta.write_row("A2", ["costo", 10])
    oculta.hide()
    wb.close()
    r = parsear(ruta)
    assert r.estructura["hiddenSheets"] == ["Interna"]  # type: ignore[index]
    interna = [f for f in r.fragmentos if f.metadata["hoja"] == "Interna"]
    assert interna and all(f.metadata["oculta"] for f in interna)


# ─────────────────────────── Tipos de celda ───────────────────────────────────


def test_fechas_numeros_booleanos_y_vacios_se_serializan_de_forma_consistente(tmp_path: Path) -> None:
    filas: list[list[Any]] = [
        ["Fecha", "Hora", "Entero", "Decimal", "Grande", "Activo", "Vacío", "Texto"],
        [
            dt.date(2026, 10, 3),
            dt.datetime(2026, 10, 3, 14, 30, 0),
            61420,
            0.047,
            573001234567,
            True,
            None,
            "  dos   líneas\nreales ",
        ],
    ]
    r = parsear(libro(tmp_path / "tipos.xlsx", {"H": filas}))
    texto = texto_total(r)

    assert "Fecha: 2026-10-03" in texto
    assert "Hora: 2026-10-03T14:30:00" in texto
    assert "Entero: 61420" in texto
    assert "Decimal: 0.047" in texto  # el valor guardado, no el formato visual
    assert "Grande: 573001234567" in texto  # un ID largo no se pasa a notación científica
    assert "Activo: TRUE" in texto
    assert "Vacío" not in texto  # una celda vacía no aparece
    assert "Texto: dos líneas reales" in texto  # espacios y saltos colapsados


def test_un_decimal_con_ruido_binario_se_estabiliza(tmp_path: Path) -> None:
    r = parsear(libro(tmp_path / "ruido.xlsx", {"H": [["Valor", "Otro"], [0.1 + 0.2, 2.50]]}))
    texto = texto_total(r)
    assert "Valor: 0.3" in texto and "Otro: 2.5" in texto


def test_calendario_1904(tmp_path: Path) -> None:
    ruta = construir(
        tmp_path / "mac.xlsx",
        {"Hoja": hoja_xml([("A1", "n", "0", 1)])},
        calendario_1904=True,
        estilos_fecha=True,
    )
    assert "A: 1904-01-01" in texto_total(parsear(ruta))


# ─────────────────────────── Fórmulas: nunca se ejecutan ──────────────────────


def test_una_formula_no_se_ejecuta_se_lee_el_valor_guardado(tmp_path: Path) -> None:
    ruta = tmp_path / "formula.xlsx"
    wb = xlsxwriter.Workbook(str(ruta))
    ws = wb.add_worksheet("H")
    ws.write_row("A1", ["Concepto", "Total"])
    ws.write("A2", "suma")
    # La fórmula dice 1+1 pero el valor guardado es 99: si algo la evaluara saldría 2.
    ws.write_formula("B2", "=1+1", None, 99)
    wb.close()
    r = parsear(ruta)
    assert "Total: 99" in texto_total(r)
    assert r.estructura["sheets"][0]["formulaCount"] == 1  # type: ignore[index]


def test_una_formula_sin_valor_guardado_se_omite_y_se_cuenta(tmp_path: Path) -> None:
    ruta = construir(
        tmp_path / "sinvalor.xlsx",
        {
            "Hoja": hoja_xml(
                [("A1", "inlineStr", "Concepto", None), ("B1", "inlineStr", "Total", None)],
                filas_extra=(
                    '<row r="2"><c r="A2" t="inlineStr"><is><t>suma</t></is></c>'
                    '<c r="B2"><f>1+1</f></c></row>'
                ),
            )
        },
    )
    r = parsear(ruta)
    hoja = r.estructura["sheets"][0]  # type: ignore[index]
    assert hoja["formulaCount"] == 1 and hoja["formulasWithoutCachedValue"] == 1
    assert "Total:" not in texto_total(r).split("Fila 2")[1]


# ─────────────────────────── Seguridad ────────────────────────────────────────


def test_un_archivo_que_no_es_zip_falla_limpiamente(tmp_path: Path) -> None:
    ruta = tmp_path / "falso.xlsx"
    ruta.write_bytes(b"esto no es un libro" * 10)
    with pytest.raises(ParseError) as exc:
        parsear(ruta)
    assert exc.value.codigo == "SPREADSHEET_PARSE_FAILED" and exc.value.reintentable is False


def test_un_libro_con_macros_se_rechaza(tmp_path: Path) -> None:
    ruta = construir(
        tmp_path / "m.xlsx",
        {"Hoja": hoja_xml([("A1", "n", "1", None)])},
        extras={"xl/vbaProject.bin": b"\x00" * 16},
    )
    with pytest.raises(ParseError) as exc:
        parsear(ruta)
    assert exc.value.codigo == "INVALID_SPREADSHEET" and "macros" in str(exc.value)


def test_un_xml_con_doctype_o_entidades_se_rechaza(tmp_path: Path) -> None:
    bomba = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;">]><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>'
    ruta = construir(tmp_path / "xxe.xlsx", {"Hoja": bomba})
    with pytest.raises(ParseError) as exc:
        parsear(ruta)
    assert exc.value.codigo == "INVALID_SPREADSHEET"


def test_una_zip_bomb_se_rechaza_antes_de_descomprimir(tmp_path: Path) -> None:
    ruta = construir(
        tmp_path / "bomba.xlsx",
        {"Hoja": hoja_xml([("A1", "n", "1", None)])},
        extras={"xl/relleno.bin": b"\x00" * (40 * 1024 * 1024)},
    )
    assert ruta.stat().st_size < 1024 * 1024  # pesa poco comprimido…
    with pytest.raises(ParseError) as exc:
        parsear(ruta)
    assert exc.value.codigo == "INVALID_SPREADSHEET"  # …pero la razón de compresión lo delata


def test_entradas_con_rutas_peligrosas_se_rechazan(tmp_path: Path) -> None:
    ruta = construir(
        tmp_path / "ruta.xlsx", {"Hoja": hoja_xml([("A1", "n", "1", None)])}, extras={"xl/../../evil": b"x"}
    )
    with pytest.raises(ParseError) as exc:
        parsear(ruta)
    assert exc.value.codigo == "INVALID_SPREADSHEET"


def test_los_limites_de_hojas_filas_y_celdas_rechazan_en_vez_de_truncar(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    filas = [["Nombre", "Dato"]] + [[f"p{n}", n] for n in range(10)]
    ruta = libro(tmp_path / "limites.xlsx", {"A": filas, "B": filas, "C": filas})

    monkeypatch.setattr(xlsx_parser, "MAX_HOJAS", 2)
    with pytest.raises(ParseError, match="3 hojas"):
        parsear(ruta)
    monkeypatch.setattr(xlsx_parser, "MAX_HOJAS", 30)

    monkeypatch.setattr(xlsx_parser, "MAX_FILAS_POR_HOJA", 5)
    with pytest.raises(ParseError, match="filas con datos") as exc:
        parsear(ruta)
    assert exc.value.reintentable is False
    monkeypatch.setattr(xlsx_parser, "MAX_FILAS_POR_HOJA", 20_000)

    monkeypatch.setattr(xlsx_parser, "MAX_CELDAS_TOTAL", 10)
    with pytest.raises(ParseError, match="celdas"):
        parsear(ruta)


def test_un_libro_sin_datos_se_rechaza(tmp_path: Path) -> None:
    ruta = tmp_path / "vacio.xlsx"
    wb = xlsxwriter.Workbook(str(ruta))
    wb.add_worksheet("Nada")
    wb.close()
    with pytest.raises(ParseError, match="no contiene datos"):
        parsear(ruta)


# ─────────────────────────── CSV ──────────────────────────────────────────────


def test_csv_se_procesa_con_la_misma_forma_que_una_hoja(tmp_path: Path) -> None:
    ruta = tmp_path / "datos.csv"
    ruta.write_text("﻿Nombre;Producto;Fee\nValentina Rojas;C7K;1500000\nMateo;X955;=1+1\n", encoding="utf-8")
    r = parsers.parse_completo(str(ruta), "text/csv")

    assert r.formato == "csv" and r.estructura["format"] == "csv"  # type: ignore[index]
    assert r.estructura["delimiter"] == ";"  # type: ignore[index]
    texto = texto_total(r)
    assert "Nombre: Valentina Rojas" in texto and "Producto: C7K" in texto
    assert "Fee: =1+1" in texto  # una «fórmula» en CSV es solo texto
    assert r.fragmentos[0].locator["sheet"] == "CSV"  # type: ignore[index]
    assert r.fragmentos[0].locator["range"] == "A2:C3"  # type: ignore[index]


@pytest.mark.parametrize(
    ("texto", "delimitador"),
    [
        ("a,b,c\n1,2,3\n", ","),
        ("a;b;c\n1;2;3\n", ";"),
        ("a\tb\tc\n1\t2\t3\n", "\t"),
        ("a|b|c\n1|2|3\n", "|"),
        # Una fila suelta que no encaja no cambia el delimitador.
        ("Nombre;Producto;Fee\nA;C7K;1\nB;X955;2\n<!-- comentario -->\n", ";"),
        ("solo una columna\notra fila\n", ","),
    ],
)
def test_csv_detecta_el_delimitador_de_forma_estable(tmp_path: Path, texto: str, delimitador: str) -> None:
    ruta = tmp_path / "d.csv"
    ruta.write_text(texto, encoding="utf-8")
    r = parsers.parse_completo(str(ruta), "text/csv")
    assert r.estructura["delimiter"] == delimitador  # type: ignore[index]


def test_csv_con_encoding_invalido_o_vacio_falla_limpiamente(tmp_path: Path) -> None:
    malo = tmp_path / "malo.csv"
    malo.write_bytes(b"a,b\n\xff\xfe,2\n")
    with pytest.raises(ParseError, match="UTF-8"):
        parsers.parse_completo(str(malo), "text/csv")
    vacio = tmp_path / "vacio.csv"
    vacio.write_text("\n\n", encoding="utf-8")
    with pytest.raises(ParseError):
        parsers.parse_completo(str(vacio), "text/csv")


# ─────────────────────────── Formatos existentes no se alteran ────────────────


def test_los_formatos_existentes_siguen_sin_estructura_y_con_columnas_legacy(tmp_path: Path) -> None:
    md = tmp_path / "brief.md"
    md.write_text("# El Reto\n\nTexto del reto.\n", encoding="utf-8")
    r = parsers.parse_completo(str(md), "text/markdown")
    assert r.estructura is None
    assert r.fragmentos[0].section == "El Reto" and r.fragmentos[0].locator is None  # la base lo deriva


# ─────────────────────────── Constructor mínimo de libros ─────────────────────

_TIPO_HOJA = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"
_CT = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'


def hoja_xml(celdas: list[tuple[str, str, str, Any]], filas_extra: str = "") -> str:
    """Hoja con celdas (ref, tipo, valor, estilo). `inlineStr` escribe texto en línea."""
    por_fila: dict[str, list[str]] = {}
    for ref, tipo, valor, estilo in celdas:
        fila = re.sub(r"[A-Z]+", "", ref)
        s = f' s="{estilo}"' if estilo is not None else ""
        if tipo == "inlineStr":
            xml = f'<c r="{ref}" t="inlineStr"{s}><is><t>{valor}</t></is></c>'
        else:
            xml = f'<c r="{ref}"{s}><v>{valor}</v></c>'
        por_fila.setdefault(fila, []).append(xml)
    filas = "".join(f'<row r="{n}">{"".join(c)}</row>' for n, c in por_fila.items())
    return (
        '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f"<sheetData>{filas}{filas_extra}</sheetData></worksheet>"
    )


def construir(
    ruta: Path,
    hojas: dict[str, str],
    *,
    calendario_1904: bool = False,
    estilos_fecha: bool = False,
    extras: dict[str, bytes] | None = None,
) -> Path:
    """Libro mínimo escrito a mano: lo que ninguna herramienta legítima produciría."""
    pr = '<workbookPr date1904="1"/>' if calendario_1904 else ""
    hojas_xml = "".join(
        f'<sheet name="{n}" sheetId="{i}" r:id="rId{i}"/>' for i, n in enumerate(hojas, start=1)
    )
    libro_xml = (
        '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        f'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">{pr}<sheets>{hojas_xml}</sheets></workbook>'
    )
    rels = "".join(
        f'<Relationship Id="rId{i}" Type="{_TIPO_HOJA}" ' f'Target="worksheets/sheet{i}.xml"/>'
        for i in range(1, len(hojas) + 1)
    )
    rels_xml = f'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{rels}</Relationships>'
    estilos = (
        '<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        '<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>'
    )
    with zipfile.ZipFile(ruta, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", _CT)
        z.writestr("xl/workbook.xml", libro_xml)
        z.writestr("xl/_rels/workbook.xml.rels", rels_xml)
        if estilos_fecha:
            z.writestr("xl/styles.xml", estilos)
        for i, xml in enumerate(hojas.values(), start=1):
            z.writestr(f"xl/worksheets/sheet{i}.xml", xml)
        for nombre, datos in (extras or {}).items():
            z.writestr(nombre, datos)
    return ruta
