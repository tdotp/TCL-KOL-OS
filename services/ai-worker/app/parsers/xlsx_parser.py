"""Parser de XLSX (V2 · Fase 4), sin dependencias externas.

Un `.xlsx` es un ZIP de XML (OOXML). Se lee con `zipfile` + `xml.etree` en vez de
una librería de hojas de cálculo por tres razones: cero dependencias nuevas que
fijar y revisar (§27), control total de los límites, y la garantía de que **solo
se lee** lo que el archivo guarda: nunca se evalúa una fórmula ni se ejecuta una
macro, porque no hay nada que las interprete.

Seguridad (documentada en docs/product/INGESTION_SPREADSHEETS_V2.md)
------------------------------------------------------------------
  · Se lee SOLO un conjunto fijo de partes (`workbook.xml`, sus relaciones,
    `sharedStrings.xml`, `styles.xml` y cada hoja). Nada se extrae al disco, así
    que una entrada con `..` o ruta absoluta no tiene dónde hacer daño; aun así
    se rechaza.
  · ZIP bomb: se comprueban el tamaño descomprimido total, la razón de
    compresión y el número de entradas ANTES de leer, y cada lectura real tiene
    un tope (`_Limitado`), porque el tamaño declarado en el ZIP puede mentir.
  · XML hostil: se rechaza cualquier parte con `<!DOCTYPE` o `<!ENTITY` (las
    entidades son el vector de «billion laughs» y de XXE).
  · Macros: un libro con `vbaProject.bin` o con hojas de macros se rechaza.
  · Fórmulas: se guarda el último valor calculado (`<v>`); si no lo hay, la
    celda se omite y se cuenta en el manifiesto.
  · Límites de hojas, filas y celdas (`tabular.py`): lo que los excede se rechaza
    entero, no se trunca en silencio, porque una evidencia incompleta que parece
    completa es peor que ninguna.
"""

from __future__ import annotations

import posixpath
import re
import zipfile
from collections.abc import Iterator
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import IO
from xml.etree import ElementTree as ET  # noqa: S405 — se rechazan DOCTYPE/ENTITY antes de parsear

from .base import Fragment, ParseError, Resultado
from .tabular import (
    BOOLEANO,
    ERROR,
    FECHA,
    MAX_CARACTERES_CELDA,
    MAX_CELDAS_TOTAL,
    MAX_COLUMNAS,
    MAX_FILAS_POR_HOJA,
    MAX_HOJAS,
    NUMERO,
    TEXTO,
    Celda,
    Hoja,
    construir_resultado,
    limpiar,
)

GENERADOR = "ai-worker/xlsx-ooxml@1"

#: Espejo de `XLSX_*` en packages/domain/src/file-validation.ts.
MAX_BYTES_DESCOMPRIMIDOS = 150 * 1024 * 1024
MAX_ENTRADAS = 5_000
MAX_RATIO_COMPRESION = 200
#: Tope de lectura de una parte XML (hojas grandes incluidas).
MAX_BYTES_PARTE = 100 * 1024 * 1024
MAX_CADENAS_COMPARTIDAS = 2_000_000
#: Celdas `<c>` recorridas por libro, con o sin valor (las vacías con solo estilo también cuestan).
MAX_CELDAS_RECORRIDAS = 2_000_000

_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
_NS_REL_DOC = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_NS_REL_PKG = "http://schemas.openxmlformats.org/package/2006/relationships"

_REF = re.compile(r"^([A-Z]{1,3})([0-9]+)$")
_ENTERO = re.compile(r"^[+-]?\d+$")

#: Formatos de número integrados que son fechas/horas (ECMA-376 §18.8.30).
_FORMATOS_FECHA_INTEGRADOS = frozenset(
    {14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36}
    | set(range(45, 48))
    | set(range(50, 59))
)


def _invalido(mensaje: str) -> ParseError:
    """Libro peligroso o fuera de límites: determinista, no se reintenta."""
    return ParseError(mensaje, codigo="INVALID_SPREADSHEET", reintentable=False)


def _ilegible(mensaje: str) -> ParseError:
    return ParseError(mensaje, codigo="SPREADSHEET_PARSE_FAILED", reintentable=False)


def _tag(nombre: str) -> str:
    return f"{{{_NS}}}{nombre}"


# ─────────────────────────── Lectura segura ───────────────────────────────────


class _Limitado:
    """Envuelve una lectura y falla si se pasa del tope: el tamaño declarado en
    el ZIP puede mentir, el real es el que se descomprime."""

    def __init__(self, f: IO[bytes], tope: int) -> None:
        self._f = f
        self._tope = tope
        self._leido = 0

    def read(self, n: int = -1) -> bytes:
        datos = self._f.read(n)
        self._leido += len(datos)
        if self._leido > self._tope:
            raise _invalido("Una parte del libro es demasiado grande al descomprimirse.")
        return datos


def _abrir_xml(zf: zipfile.ZipFile, nombre: str) -> _Limitado:
    try:
        info = zf.getinfo(nombre)
    except KeyError as exc:
        raise _ilegible("El libro está incompleto: falta una parte necesaria.") from exc
    if info.file_size > MAX_BYTES_PARTE:
        raise _invalido("Una parte del libro es demasiado grande.")
    f = zf.open(info)
    cabecera = f.peek(4096)[:4096].lower()  # type: ignore[attr-defined]
    if b"<!doctype" in cabecera or b"<!entity" in cabecera:
        raise _invalido("El libro contiene definiciones XML no permitidas.")
    return _Limitado(f, MAX_BYTES_PARTE)


def validar_libro(zf: zipfile.ZipFile) -> list[str]:
    """Comprobaciones previas a leer nada. Devuelve los nombres de las entradas."""
    infos = zf.infolist()
    nombres = [i.filename for i in infos]
    if len(infos) > MAX_ENTRADAS:
        raise _invalido(f"El libro tiene demasiadas partes internas ({len(infos)}).")
    if "[Content_Types].xml" not in nombres or "xl/workbook.xml" not in nombres:
        raise _invalido("El archivo no es un libro de Excel (.xlsx) válido.")
    if any(n.endswith("vbaProject.bin") or n.startswith("xl/macrosheets/") for n in nombres):
        raise _invalido("Los libros con macros no se aceptan.")
    if any(".." in n or n.startswith("/") or "\\" in n for n in nombres):
        raise _invalido("El libro contiene rutas internas no válidas.")
    descomprimido = sum(i.file_size for i in infos)
    if descomprimido > MAX_BYTES_DESCOMPRIMIDOS:
        raise _invalido("El libro es demasiado grande al descomprimirse.")
    comprimido = max(sum(i.compress_size for i in infos), 1)
    if descomprimido / comprimido > MAX_RATIO_COMPRESION:
        raise _invalido("El libro tiene una razón de compresión sospechosa y se rechaza por seguridad.")
    return nombres


def _parsear(zf: zipfile.ZipFile, nombre: str) -> ET.Element:
    try:
        return ET.parse(_abrir_xml(zf, nombre)).getroot()  # noqa: S314 — DOCTYPE/ENTITY rechazados arriba
    except ET.ParseError as exc:
        raise _ilegible("El libro está dañado: no se pudo leer una de sus partes.") from exc


# ─────────────────────────── Partes del libro ─────────────────────────────────


def _hojas_del_libro(zf: zipfile.ZipFile, nombres: set[str]) -> tuple[list[tuple[str, str, str]], bool]:
    """[(nombre, ruta_en_el_zip, estado)] en orden, y si el libro usa el calendario 1904."""
    libro = _parsear(zf, "xl/workbook.xml")
    pr = libro.find(_tag("workbookPr"))
    date1904 = pr is not None and pr.get("date1904", "0") in {"1", "true"}

    relaciones: dict[str, tuple[str, str]] = {}
    if "xl/_rels/workbook.xml.rels" in nombres:
        raiz = _parsear(zf, "xl/_rels/workbook.xml.rels")
        for rel in raiz.iter(f"{{{_NS_REL_PKG}}}Relationship"):
            relaciones[rel.get("Id", "")] = (rel.get("Type", ""), rel.get("Target", ""))

    hojas: list[tuple[str, str, str]] = []
    contenedor = libro.find(_tag("sheets"))
    if contenedor is None:
        raise _ilegible("El libro no declara ninguna hoja.")
    for hoja in contenedor.findall(_tag("sheet")):
        nombre = hoja.get("name") or ""
        rid = hoja.get(f"{{{_NS_REL_DOC}}}id", "")
        tipo, destino = relaciones.get(rid, ("", ""))
        # Hojas de gráfico o de diálogo no tienen celdas: se ignoran.
        if not tipo.endswith("/worksheet") or not destino:
            continue
        ruta = (
            destino.lstrip("/")
            if destino.startswith("/")
            else posixpath.normpath(posixpath.join("xl", destino))
        )
        if not ruta.startswith("xl/") or ruta not in nombres:
            raise _ilegible(f"El libro apunta a una hoja que no existe («{nombre[:40]}»).")
        hojas.append((nombre, ruta, hoja.get("state", "visible")))
    if not hojas:
        raise _ilegible("El libro no contiene hojas con datos.")
    if len(hojas) > MAX_HOJAS:
        raise _invalido(f"El libro tiene {len(hojas)} hojas y el límite es {MAX_HOJAS}.")
    return hojas, date1904


def _cadenas_compartidas(zf: zipfile.ZipFile, nombres: set[str]) -> list[str]:
    if "xl/sharedStrings.xml" not in nombres:
        return []
    cadenas: list[str] = []
    for _evento, el in ET.iterparse(_abrir_xml(zf, "xl/sharedStrings.xml"), events=("end",)):  # noqa: S314
        if el.tag != _tag("si"):
            continue
        partes: list[str] = []
        for hijo in el:
            if hijo.tag == _tag("t"):
                partes.append(hijo.text or "")
            elif hijo.tag == _tag("r"):  # texto enriquecido: solo los `t` directos de cada run
                partes.extend((t.text or "") for t in hijo.findall(_tag("t")))
            # `rPh` (fonética) se omite a propósito.
        cadenas.append("".join(partes))
        if len(cadenas) > MAX_CADENAS_COMPARTIDAS:
            raise _invalido("El libro tiene demasiadas cadenas de texto.")
        el.clear()
    return cadenas


def _es_formato_fecha(codigo: str) -> bool:
    """¿Este formato personalizado representa una fecha/hora? Ignora literales y colores."""
    limpio = re.sub(r'"[^"]*"|\\.|\[[^\]]*\]|_.|\*.', "", codigo)
    return bool(re.search(r"[dmyhs]", limpio, flags=re.IGNORECASE)) and "General" not in limpio


def _estilos_de_fecha(zf: zipfile.ZipFile, nombres: set[str]) -> set[int]:
    """Índices de estilo (`s`) cuyo formato de número es una fecha/hora."""
    if "xl/styles.xml" not in nombres:
        return set()
    raiz = _parsear(zf, "xl/styles.xml")
    personalizados: dict[int, str] = {}
    formatos = raiz.find(_tag("numFmts"))
    if formatos is not None:
        for nf in formatos.findall(_tag("numFmt")):
            try:
                personalizados[int(nf.get("numFmtId", "-1"))] = nf.get("formatCode", "")
            except ValueError:
                continue
    fechas: set[int] = set()
    xfs = raiz.find(_tag("cellXfs"))
    if xfs is None:
        return fechas
    for indice, xf in enumerate(xfs.findall(_tag("xf"))):
        try:
            fid = int(xf.get("numFmtId", "0"))
        except ValueError:
            continue
        if fid in _FORMATOS_FECHA_INTEGRADOS or (
            fid in personalizados and _es_formato_fecha(personalizados[fid])
        ):
            fechas.add(indice)
    return fechas


# ─────────────────────────── Valores ──────────────────────────────────────────


def _numero_a_texto(crudo: str) -> str:
    """Número estable: enteros tal cual; decimales a 15 cifras significativas."""
    crudo = crudo.strip()
    if _ENTERO.match(crudo):
        return str(int(crudo))
    try:
        valor = float(crudo)
    except ValueError:
        return crudo
    if valor != valor or valor in (float("inf"), float("-inf")):  # NaN / ±inf
        return crudo
    texto = f"{valor:.15g}"
    if "e" in texto or "E" in texto:
        try:
            texto = format(Decimal(texto), "f")
        except InvalidOperation:
            return texto
    if "." in texto:
        texto = texto.rstrip("0").rstrip(".")
    return texto or "0"


def _fecha_a_texto(crudo: str, date1904: bool) -> str | None:
    """Serie de fecha de Excel → ISO 8601. `None` si no es un número razonable."""
    try:
        serie = float(crudo)
    except ValueError:
        return None
    if serie < 0 or serie >= 2_958_466:  # 9999-12-31
        return None
    if date1904:
        base = datetime(1904, 1, 1)
    else:
        # El sistema 1900 trata (por error histórico) 1900 como bisiesto: las
        # series < 61 se desplazan un día. La serie 60 (29-feb-1900) no existe.
        if 60 <= serie < 61:
            return None
        base = datetime(1899, 12, 31) if serie < 60 else datetime(1899, 12, 30)

    # Se redondea al segundo más cercano: la serie es un flotante y 14:30:00 no
    # se guarda exacto (si no, saldría 14:29:59).
    dias = int(serie)
    segundos = round((serie - dias) * 86400)
    if segundos >= 86400:
        dias, segundos = dias + 1, 0
    momento = base + timedelta(days=dias, seconds=segundos)

    # Entre 0 y 1 (sin ser 0) es una hora sin fecha; el 0 es el origen del calendario.
    if 0 < serie < 1:
        return momento.strftime("%H:%M:%S")
    if serie == 0 and not date1904:
        return "00:00:00"
    if segundos == 0:
        return momento.strftime("%Y-%m-%d")
    return momento.strftime("%Y-%m-%dT%H:%M:%S")


def _celda(
    el: ET.Element,
    cadenas: list[str],
    estilos_fecha: set[int],
    date1904: bool,
) -> tuple[Celda | None, bool]:
    """(celda con valor | None, tiene_formula). Nunca evalúa una fórmula."""
    tipo = el.get("t", "n")
    tiene_formula = el.find(_tag("f")) is not None
    v = el.find(_tag("v"))
    crudo = v.text if v is not None and v.text is not None else None

    if tipo == "inlineStr":
        inline = el.find(_tag("is"))
        if inline is None:
            return None, tiene_formula
        texto = "".join((t.text or "") for t in inline.iter(_tag("t")))
        texto = limpiar(texto)
        return (Celda(texto, TEXTO) if texto else None), tiene_formula

    if crudo is None:
        return None, tiene_formula

    if tipo == "s":
        try:
            texto = limpiar(cadenas[int(crudo)])
        except (ValueError, IndexError) as exc:
            raise _ilegible("El libro está dañado: referencia a un texto que no existe.") from exc
        return (Celda(texto, TEXTO) if texto else None), tiene_formula
    if tipo == "str":
        texto = limpiar(crudo)
        return (Celda(texto, TEXTO) if texto else None), tiene_formula
    if tipo == "b":
        return Celda("TRUE" if crudo.strip() in {"1", "true"} else "FALSE", BOOLEANO), tiene_formula
    if tipo == "e":
        texto = limpiar(crudo)
        return (Celda(texto, ERROR) if texto else None), tiene_formula
    if tipo == "d":
        texto = limpiar(crudo)
        return (Celda(texto, FECHA) if texto else None), tiene_formula

    # Numérico (`n` o sin tipo): ¿es una fecha según su formato?
    try:
        estilo = int(el.get("s", "0"))
    except ValueError:
        estilo = 0
    if estilo in estilos_fecha:
        iso = _fecha_a_texto(crudo, date1904)
        if iso is not None:
            return Celda(iso, FECHA), tiene_formula
    return Celda(_numero_a_texto(crudo), NUMERO), tiene_formula


def _leer_hoja(
    zf: zipfile.ZipFile,
    ruta: str,
    nombre: str,
    indice: int,
    estado: str,
    cadenas: list[str],
    estilos_fecha: set[int],
    date1904: bool,
    celdas_acumuladas: int,
) -> Hoja:
    hoja = Hoja(nombre=nombre, indice=indice, estado=estado)
    fila_actual = 0
    col_anterior = 0
    celdas = celdas_acumuladas
    recorridas = 0

    try:
        for evento, el in ET.iterparse(_abrir_xml(zf, ruta), events=("start", "end")):  # noqa: S314
            if evento == "start":
                if el.tag == _tag("row"):
                    r = el.get("r")
                    fila_actual = int(r) if r and r.isdigit() else fila_actual + 1
                    col_anterior = 0
                continue
            if el.tag == _tag("row"):
                el.clear()  # libera las celdas de la fila ya leída
                continue
            if el.tag != _tag("c"):
                continue
            recorridas += 1
            if recorridas > MAX_CELDAS_RECORRIDAS:
                raise _invalido("El libro tiene demasiadas celdas para procesarse.")

            ref = el.get("r")
            coincide = _REF.match(ref) if ref else None
            if coincide:
                col = 0
                for ch in coincide.group(1):
                    col = col * 26 + (ord(ch) - 64)
                numero_fila = int(coincide.group(2))
            else:
                col, numero_fila = col_anterior + 1, fila_actual
            col_anterior = col
            if col > MAX_COLUMNAS or numero_fila < 1:
                raise _invalido("El libro tiene celdas fuera del rango válido.")

            celda, formula = _celda(el, cadenas, estilos_fecha, date1904)
            if formula:
                hoja.formulas += 1
                if celda is None:
                    hoja.formulas_sin_valor += 1
            el.clear()
            if celda is None:
                continue

            if len(celda.texto) > MAX_CARACTERES_CELDA:
                celda = Celda(celda.texto[: MAX_CARACTERES_CELDA - 1] + "…", celda.tipo)
                hoja.celdas_recortadas += 1
            fila = hoja.filas.setdefault(numero_fila, {})
            fila[col] = celda
            celdas += 1
            if len(hoja.filas) > MAX_FILAS_POR_HOJA:
                raise _invalido(
                    f"La hoja «{nombre[:40]}» tiene más de {MAX_FILAS_POR_HOJA:,} filas con datos. "
                    "Divida el libro."
                )
            if celdas > MAX_CELDAS_TOTAL:
                raise _invalido(f"El libro supera el límite de {MAX_CELDAS_TOTAL:,} celdas con datos.")
    except ET.ParseError as exc:
        raise _ilegible(f"La hoja «{nombre[:40]}» está dañada.") from exc
    return hoja


# ─────────────────────────── API ──────────────────────────────────────────────


def _iterar_hojas(
    zf: zipfile.ZipFile,
    nombres: set[str],
    hojas: list[tuple[str, str, str]],
    date1904: bool,
) -> Iterator[Hoja]:
    cadenas = _cadenas_compartidas(zf, nombres)
    estilos_fecha = _estilos_de_fecha(zf, nombres)
    acumuladas = 0
    for indice, (nombre, ruta, estado) in enumerate(hojas, start=1):
        hoja = _leer_hoja(zf, ruta, nombre, indice, estado, cadenas, estilos_fecha, date1904, acumuladas)
        acumuladas += sum(len(f) for f in hoja.filas.values())
        yield hoja


def parse_completo(path: str) -> Resultado:
    try:
        zf = zipfile.ZipFile(path)
    except (zipfile.BadZipFile, OSError) as exc:
        raise _ilegible("No se pudo abrir el libro de Excel. Puede estar dañado o protegido.") from exc

    with zf:
        nombres = set(validar_libro(zf))
        declaradas, date1904 = _hojas_del_libro(zf, nombres)
        hojas = list(_iterar_hojas(zf, nombres, declaradas, date1904))

    fragmentos, manifiesto = construir_resultado(
        "xlsx",
        hojas,
        {"date1904": date1904, "hiddenSheets": [h.nombre for h in hojas if h.estado != "visible"]},
    )
    if not fragmentos:
        raise ParseError(
            "El libro no contiene datos extraíbles (todas las hojas están vacías).",
            codigo="SPREADSHEET_PARSE_FAILED",
            reintentable=False,
        )
    return Resultado(fragmentos=fragmentos, estructura=manifiesto, generador=GENERADOR, formato="xlsx")


def parse(path: str) -> list[Fragment]:
    return parse_completo(path).fragmentos


__all__ = ["parse", "parse_completo", "validar_libro", "GENERADOR"]
