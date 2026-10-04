"""Validación de archivos por contenido real (E4-1, casos S-05 y S-06).

La prueba que más importa es la del ejecutable renombrado: si el sistema
confiara en la extensión, cualquiera podría subir lo que quisiera.
"""

from __future__ import annotations

import zipfile
from pathlib import Path

import pytest

from app.validation import PDF, PNG, PPTX, XLSX, detectar_tipo, validar

MAX = 50 * 1024 * 1024


def escribir(tmp_path: Path, nombre: str, contenido: bytes) -> Path:
    ruta = tmp_path / nombre
    ruta.write_bytes(contenido)
    return ruta


# ─────────────────────────── Detección por contenido ──────────────────────────


def test_detecta_pdf_por_cabecera(tmp_path: Path) -> None:
    ruta = escribir(tmp_path, "ficha.pdf", b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    assert detectar_tipo(str(ruta)) == PDF


def test_detecta_png_por_cabecera(tmp_path: Path) -> None:
    ruta = escribir(tmp_path, "logo.png", b"\x89PNG\r\n\x1a\n" + b"\x00" * 32)
    assert detectar_tipo(str(ruta)) == PNG


def test_detecta_pptx_por_su_contenido_interno(tmp_path: Path) -> None:
    ruta = tmp_path / "campana.pptx"
    with zipfile.ZipFile(ruta, "w") as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        z.writestr("ppt/presentation.xml", "<p:presentation/>")
    assert detectar_tipo(str(ruta)) == PPTX


def test_distingue_xlsx_de_pptx_aunque_ambos_sean_zip(tmp_path: Path) -> None:
    ruta = tmp_path / "perfiles.xlsx"
    with zipfile.ZipFile(ruta, "w") as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        z.writestr("xl/workbook.xml", "<workbook/>")
    assert detectar_tipo(str(ruta)) == XLSX


# ─────────────────────────── Caso S-05 ────────────────────────────────────────


def test_rechaza_ejecutable_renombrado_como_pdf(tmp_path: Path) -> None:
    """El archivo dice .pdf y declara ser PDF, pero su contenido es un binario."""
    ruta = escribir(tmp_path, "ficha_tecnica.pdf", b"\x7fELF\x02\x01\x01\x00" + b"\x00" * 64)
    resultado = validar(str(ruta), ruta.stat().st_size, MAX, declarado=PDF)

    assert resultado.valido is False
    assert resultado.motivo is not None
    assert "no se reconoce" in resultado.motivo.lower()


def test_rechaza_script_renombrado_como_pptx(tmp_path: Path) -> None:
    ruta = escribir(tmp_path, "campana.pptx", b"#!/bin/sh\nrm -rf /\n")
    resultado = validar(str(ruta), ruta.stat().st_size, MAX, declarado=PPTX)
    assert resultado.valido is False


def test_rechaza_zip_que_no_es_ooxml(tmp_path: Path) -> None:
    ruta = tmp_path / "archivo.pptx"
    with zipfile.ZipFile(ruta, "w") as z:
        z.writestr("cualquier_cosa.txt", "contenido")
    resultado = validar(str(ruta), ruta.stat().st_size, MAX)
    assert resultado.valido is False


def test_acepta_pdf_legitimo_y_reporta_discrepancia_del_declarado(tmp_path: Path) -> None:
    ruta = escribir(tmp_path, "documento.bin", b"%PDF-1.4\n" + b"x" * 100)
    resultado = validar(str(ruta), ruta.stat().st_size, MAX, declarado="application/octet-stream")

    assert resultado.valido is True
    assert resultado.mime_type == PDF
    assert resultado.motivo is not None  # se informa, no se bloquea


# ─────────────────────────── Caso S-06 ────────────────────────────────────────


def test_rechaza_archivo_por_encima_del_limite(tmp_path: Path) -> None:
    ruta = escribir(tmp_path, "enorme.pdf", b"%PDF-1.4\n")
    resultado = validar(str(ruta), 80 * 1024 * 1024, MAX)

    assert resultado.valido is False
    assert resultado.motivo is not None
    assert "80.0 MB" in resultado.motivo and "50 MB" in resultado.motivo


def test_rechaza_archivo_vacio(tmp_path: Path) -> None:
    ruta = escribir(tmp_path, "vacio.pdf", b"")
    resultado = validar(str(ruta), 0, MAX)
    assert resultado.valido is False


def test_un_zip_con_solo_xl_workbook_no_es_un_libro_valido(tmp_path: Path) -> None:
    """Regla reemplazada en la Fase 4 de V2: antes TODO `.xlsx` se rechazaba («excepción
    manual», DEC-010); ahora el Excel es un formato soportado, pero un ZIP que solo
    imita la estructura mínima sigue sin ser un libro válido."""
    ruta = tmp_path / "listado.xlsx"
    with zipfile.ZipFile(ruta, "w") as z:
        z.writestr("xl/workbook.xml", "<workbook/>")
    resultado = validar(str(ruta), ruta.stat().st_size, MAX)

    assert resultado.valido is False
    assert resultado.motivo is not None
    assert "libro de Excel" in resultado.motivo


def test_un_xlsx_valido_se_acepta(tmp_path: Path) -> None:
    xlsxwriter = pytest.importorskip("xlsxwriter")
    ruta = tmp_path / "libro.xlsx"
    libro = xlsxwriter.Workbook(str(ruta))
    libro.add_worksheet().write("A1", "hola")
    libro.close()
    resultado = validar(str(ruta), ruta.stat().st_size, MAX)
    assert resultado.valido is True
    assert resultado.mime_type == XLSX


def test_un_libro_con_macros_se_rechaza(tmp_path: Path) -> None:
    ruta = tmp_path / "macros.xlsx"
    with zipfile.ZipFile(ruta, "w") as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        z.writestr("xl/workbook.xml", "<workbook/>")
        z.writestr("xl/vbaProject.bin", b"\x00" * 20)
    resultado = validar(str(ruta), ruta.stat().st_size, MAX)
    assert resultado.valido is False
    assert "macros" in (resultado.motivo or "")


def test_un_xls_binario_antiguo_se_rechaza_con_un_mensaje_claro(tmp_path: Path) -> None:
    ruta = escribir(tmp_path, "viejo.xls", b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\x00" * 200)
    resultado = validar(str(ruta), ruta.stat().st_size, MAX)
    assert resultado.valido is False
    assert ".xlsx" in (resultado.motivo or "")


def test_un_csv_se_reconoce_por_contenido_y_extension(tmp_path: Path) -> None:
    ruta = escribir(tmp_path, "datos.csv", b"nombre,producto\nValentina,C7K\n")
    assert validar(str(ruta), ruta.stat().st_size, MAX).mime_type == "text/csv"
    # Sin la extensión, un texto plano no se acepta (el contenido solo restringe).
    sin_extension = escribir(tmp_path, "datos", b"nombre,producto\nValentina,C7K\n")
    assert validar(str(sin_extension), sin_extension.stat().st_size, MAX).valido is False


@pytest.mark.parametrize("tipo_esperado", [PDF, PNG])
def test_formatos_de_dec_010_son_aceptados(tmp_path: Path, tipo_esperado: str) -> None:
    contenidos = {PDF: b"%PDF-1.4\n" + b"x" * 50, PNG: b"\x89PNG\r\n\x1a\n" + b"\x00" * 50}
    ruta = escribir(tmp_path, "archivo", contenidos[tipo_esperado])
    resultado = validar(str(ruta), ruta.stat().st_size, MAX)

    assert resultado.valido is True
    assert resultado.mime_type == tipo_esperado
