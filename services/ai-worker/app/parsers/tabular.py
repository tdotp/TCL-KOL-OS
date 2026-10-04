"""Hojas de cálculo → fragmentos (V2 · Fase 4). Lo comparten XLSX y CSV.

Una hoja es una rejilla de celdas con coordenadas. Convertirla en un único texto
plano perdería las coordenadas y la relación de cada valor con su columna; un
fragmento por celda sería ilegible. El contrato aquí:

  · Cada fila se serializa como pares «cabecera: valor», no como
    «valor | valor | valor». Sin cabecera, la columna se nombra por su letra.
  · Las filas consecutivas se empaquetan en un fragmento hasta un tamaño
    razonable (pocas filas, pocos caracteres), de modo que ni una hoja de miles
    de filas es un solo string ni cada fila es un fragmento minúsculo.
  · Cada fragmento lleva su localizador de rango (`{"kind": "range", "sheet",
    "range": "A12:H16", ...}`), así que se vuelve al punto exacto del original.

La detección de cabecera es una heurística declarada (la primera fila cuyas
celdas no vacías son todas texto, con al menos dos): el resultado queda en el
manifiesto (`headerRow`, `headers`) para que quien lo consuma pueda
contradecirla. Una hoja con varias tablas usa la cabecera de la primera.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from .base import Fragment

#: Un fragmento reúne filas hasta este tamaño o este número de filas.
OBJETIVO_CARACTERES = 1200
MAX_FILAS_POR_FRAGMENTO = 8
#: Una celda con más texto que esto se recorta (y se declara en los metadatos).
MAX_CARACTERES_CELDA = 5000
MAX_CARACTERES_CABECERA = 100

#: Límites de una hoja (espejo documentado en docs/product/INGESTION_SPREADSHEETS_V2.md).
MAX_HOJAS = 30
MAX_FILAS_POR_HOJA = 20_000
MAX_CELDAS_TOTAL = 500_000
MAX_COLUMNAS = 16_384  # XFD, el máximo de Excel

TEXTO = "texto"
NUMERO = "numero"
FECHA = "fecha"
BOOLEANO = "booleano"
ERROR = "error"


@dataclass(frozen=True)
class Celda:
    texto: str
    tipo: str = TEXTO


@dataclass
class Hoja:
    nombre: str
    indice: int
    estado: str = "visible"
    #: fila (1-based) → {columna (1-based): celda con valor}. Solo filas con datos.
    filas: dict[int, dict[int, Celda]] = field(default_factory=dict)
    formulas: int = 0
    formulas_sin_valor: int = 0
    celdas_recortadas: int = 0


def col_letras(col: int) -> str:
    """Columna 1-based → letras (1 → A, 27 → AA)."""
    if col < 1:
        raise ValueError("La columna debe ser ≥ 1.")
    letras = ""
    n = col
    while n > 0:
        n, resto = divmod(n - 1, 26)
        letras = chr(65 + resto) + letras
    return letras


def rango_a1(fila_ini: int, col_ini: int, fila_fin: int, col_fin: int) -> str:
    return f"{col_letras(col_ini)}{fila_ini}:{col_letras(col_fin)}{fila_fin}"


def limpiar(texto: str) -> str:
    """Colapsa cualquier espacio en blanco (incluidos saltos de línea) a uno."""
    return " ".join(texto.split())


# ─────────────────────────── Cabeceras ────────────────────────────────────────


def detectar_cabecera(hoja: Hoja) -> int | None:
    """Fila de cabecera: la primera con ≥ 2 celdas, todas de texto, y datos debajo."""
    filas = sorted(hoja.filas)
    for posicion, numero in enumerate(filas):
        celdas = hoja.filas[numero]
        if len(celdas) >= 2 and all(c.tipo == TEXTO for c in celdas.values()):
            if posicion + 1 < len(filas):
                return numero
            return None
    return None


def nombres_de_cabecera(hoja: Hoja, fila_cabecera: int | None) -> dict[int, str]:
    """columna → nombre. Los duplicados se desambiguan («Nombre», «Nombre (2)»)."""
    if fila_cabecera is None:
        return {}
    usados: dict[str, int] = {}
    nombres: dict[int, str] = {}
    for col, celda in sorted(hoja.filas[fila_cabecera].items()):
        base = limpiar(celda.texto)[:MAX_CARACTERES_CABECERA] or col_letras(col)
        usados[base] = usados.get(base, 0) + 1
        nombres[col] = base if usados[base] == 1 else f"{base} ({usados[base]})"
    return nombres


# ─────────────────────────── Fragmentos ───────────────────────────────────────


def _texto_de_fila(
    numero: int, celdas: dict[int, Celda], nombres: dict[int, str], fila_cabecera: int | None
) -> str:
    # Las cabeceras describen las filas que están DEBAJO de ellas; una fila
    # anterior (p. ej. un título) se nombra por letra de columna, no por cabecera.
    aplica = fila_cabecera is not None and numero > fila_cabecera
    lineas = [f"Fila {numero}"]
    for col in sorted(celdas):
        etiqueta = (nombres.get(col) if aplica else None) or col_letras(col)
        lineas.append(f"{etiqueta}: {celdas[col].texto}")
    return "\n".join(lineas)


def fragmentar_hoja(hoja: Hoja, ordinal_inicial: int) -> tuple[list[Fragment], dict[str, Any]]:
    """Fragmentos de una hoja y su entrada del manifiesto."""
    cabecera = detectar_cabecera(hoja)
    nombres = nombres_de_cabecera(hoja, cabecera)
    filas = [n for n in sorted(hoja.filas) if n != cabecera]

    fragmentos: list[Fragment] = []
    ordinal = ordinal_inicial

    grupo: list[int] = []
    tamano = 0

    def volcar() -> None:
        nonlocal ordinal, grupo, tamano
        if not grupo:
            return
        columnas = [c for n in grupo for c in hoja.filas[n]]
        col_ini, col_fin = min(columnas), max(columnas)
        fila_ini, fila_fin = grupo[0], grupo[-1]
        etiqueta_filas = f"fila {fila_ini}" if fila_ini == fila_fin else f"filas {fila_ini}–{fila_fin}"
        cuerpo = "\n".join(_texto_de_fila(n, hoja.filas[n], nombres, cabecera) for n in grupo)
        fragmentos.append(
            Fragment(
                ordinal=ordinal,
                text=f"Hoja «{hoja.nombre}» · {etiqueta_filas}\n{cuerpo}",
                # `section` conserva algo legible para quien aún lea solo las
                # columnas legacy; el localizador real es `locator`.
                section=hoja.nombre,
                locator={
                    "kind": "range",
                    "sheet": hoja.nombre,
                    "range": rango_a1(fila_ini, col_ini, fila_fin, col_fin),
                    "rowStart": fila_ini,
                    "rowEnd": fila_fin,
                    "colStart": col_ini,
                    "colEnd": col_fin,
                },
                metadata={
                    "origen": "hoja_de_calculo",
                    "hoja": hoja.nombre,
                    "indiceHoja": hoja.indice,
                    "filas": list(grupo),
                    "filaCabecera": cabecera,
                    "oculta": hoja.estado != "visible",
                },
            )
        )
        ordinal += 1
        grupo = []
        tamano = 0

    for numero in filas:
        texto = _texto_de_fila(numero, hoja.filas[numero], nombres, cabecera)
        # Un hueco entre filas corta el fragmento: su rango debe ser contiguo, para
        # que declarar «filas 7–10» signifique que están TODAS ahí. La fila de
        # cabecera no cuenta como hueco (no es una fila de datos, vive en `headers`).
        esperada = grupo[-1] + 1 if grupo else numero
        if cabecera is not None and esperada == cabecera:
            esperada += 1
        hueco = bool(grupo) and numero != esperada
        lleno = len(grupo) >= MAX_FILAS_POR_FRAGMENTO or tamano + len(texto) > OBJETIVO_CARACTERES
        if grupo and (hueco or lleno):
            volcar()
        grupo.append(numero)
        tamano += len(texto)
    volcar()

    todas = sorted(hoja.filas)
    columnas_usadas = [c for celdas in hoja.filas.values() for c in celdas]
    entrada: dict[str, Any] = {
        "name": hoja.nombre,
        "index": hoja.indice,
        "state": hoja.estado,
        "dimension": (
            rango_a1(todas[0], min(columnas_usadas), todas[-1], max(columnas_usadas)) if todas else None
        ),
        "headerRow": cabecera,
        "headers": [{"column": col_letras(c), "col": c, "name": n} for c, n in nombres.items()],
        "firstRow": todas[0] if todas else None,
        "lastRow": todas[-1] if todas else None,
        "rowCount": len(todas),
        "cellCount": sum(len(c) for c in hoja.filas.values()),
        "formulaCount": hoja.formulas,
        "formulasWithoutCachedValue": hoja.formulas_sin_valor,
        "truncatedCells": hoja.celdas_recortadas,
        "fragmentCount": len(fragmentos),
    }
    return fragmentos, entrada


def construir_resultado(
    formato: str,
    hojas: list[Hoja],
    extra: dict[str, Any] | None = None,
) -> tuple[list[Fragment], dict[str, Any]]:
    """Fragmentos de todo el libro y su manifiesto normalizado."""
    fragmentos: list[Fragment] = []
    entradas: list[dict[str, Any]] = []
    for hoja in hojas:
        nuevos, entrada = fragmentar_hoja(hoja, len(fragmentos))
        fragmentos.extend(nuevos)
        entradas.append(entrada)

    manifiesto: dict[str, Any] = {
        "format": formato,
        "sheetCount": len(hojas),
        "sheets": entradas,
        "totals": {
            "rows": sum(e["rowCount"] for e in entradas),
            "cells": sum(e["cellCount"] for e in entradas),
            "fragments": len(fragmentos),
        },
        "limits": {
            "maxSheets": MAX_HOJAS,
            "maxRowsPerSheet": MAX_FILAS_POR_HOJA,
            "maxCells": MAX_CELDAS_TOTAL,
        },
        # Lo que el procesamiento NO hace, para que nadie lo asuma.
        "notes": [
            "Las fórmulas no se evalúan: se lee el último valor calculado guardado en el archivo.",
            "No se leen comentarios, imágenes, gráficos ni formato visual (solo valores).",
        ],
    }
    if extra:
        manifiesto.update(extra)
    return fragmentos, manifiesto


_NUMERICO = re.compile(r"^[+-]?\d+(?:[.,]\d+)?$")


def parece_numero(texto: str) -> bool:
    """Para CSV, donde todo llega como texto: ¿esta celda es un número?"""
    return bool(_NUMERICO.match(texto.strip()))
