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

Excepción deliberada: el Sheet de influencers del esquema `TCL_KOL_OS_INFLUENCERS_V1`
(marcador en A1) trae columnas financieras (`fee`, `canje`, `condiciones`) que
JAMÁS deben llegar a TCL, al agente ni a quien no tiene `finance:read` (DEC-014,
DEC-049), y los fragmentos son lo que leen todos ellos. Su texto se arma con una
LISTA BLANCA de columnas no sensibles (ver `COLUMNAS_DE_TEXTO_V1`): lo que no está
en la lista —`fee`, `canje`, `condiciones` y cualquier columna desconocida o
futura— no entra al texto. Los valores siguen íntegros en la rejilla del snapshot
(`source_snapshot_rows`), que es donde los usan la validación y el plan de
importación; el localizador de cada fragmento conserva su rango real.

La detección de cabecera es una heurística declarada (la primera fila cuyas
celdas no vacías son todas texto, con al menos dos): el resultado queda en el
manifiesto (`headerRow`, `headers`) para que quien lo consuma pueda
contradecirla. Una hoja con varias tablas usa la cabecera de la primera.
"""

from __future__ import annotations

import re
import unicodedata
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


# ─────────────────── Esquema de influencers V1 (lista blanca) ─────────────────

#: Prefijo del marcador de A1 (`TCL_KOL_OS_INFLUENCERS_V1`). Se compara cualquier
#: versión: ante una versión futura o desconocida, mejor filtrar que volcar.
PREFIJO_MARCADOR_INFLUENCERS = "TCL_KOL_OS_INFLUENCERS"
FILA_MARCADOR_V1 = 1
FILA_CABECERA_V1 = 2

#: Columnas (cabecera canónica, igual que `normalizeHeader` de
#: packages/domain/src/influencer-sheet.ts) cuyo valor SÍ puede ir al texto de un
#: fragmento. NO es una lista de exclusión: `fee`, `canje`, `condiciones` y
#: cualquier columna que no figure aquí (teléfono, dirección, cédula…) quedan fuera.
COLUMNAS_DE_TEXTO_V1 = frozenset(
    {
        "clave_influencer",
        "nombre",
        "plataforma",
        "handle",
        "producto",
        "entregables",
        "tipo_acuerdo",
        "fecha_inicio",
        "fecha_fin",
        "kpi_objetivo",
    }
)
#: `tipo_acuerdo` solo entra si su valor es una de estas etiquetas (no revela montos).
TIPOS_DE_ACUERDO_V1 = frozenset({"fee", "canje", "mixto"})


def cabecera_canonica(texto: str) -> str:
    """Misma normalización que el dominio: NFKC, recorte, minúsculas, espacios/guiones → `_`."""
    return re.sub(r"[\s-]+", "_", unicodedata.normalize("NFKC", texto).strip().lower())


def es_hoja_influencers_v1(hoja: Hoja) -> bool:
    """¿Lleva la hoja el marcador del esquema de influencers en A1?"""
    marcador = hoja.filas.get(FILA_MARCADOR_V1, {}).get(1)
    if marcador is None:
        return False
    texto = unicodedata.normalize("NFKC", limpiar(marcador.texto)).upper()
    return texto.startswith(PREFIJO_MARCADOR_INFLUENCERS)


def columnas_de_texto_v1(hoja: Hoja, fila_cabecera: int | None) -> dict[int, str]:
    """columna → cabecera canónica, SOLO de las columnas cuyo valor puede ir al texto."""
    if fila_cabecera is None:
        return {}
    permitidas: dict[int, str] = {}
    for col, celda in hoja.filas[fila_cabecera].items():
        canonica = cabecera_canonica(celda.texto)
        if canonica in COLUMNAS_DE_TEXTO_V1:
            permitidas[col] = canonica
    return permitidas


def _celdas_visibles_v1(
    numero: int,
    celdas: dict[int, Celda],
    permitidas: dict[int, str],
    fila_cabecera: int | None,
) -> dict[int, Celda]:
    """Las celdas de una fila que pueden ir al texto del fragmento (lista blanca)."""
    if fila_cabecera is None or numero <= fila_cabecera:
        # Marcador (y cualquier fila previa a las cabeceras): solo A1; el resto de la
        # fila 1 «se ignora» según el esquema y no es contenido de la fuente.
        return {c: v for c, v in celdas.items() if numero == FILA_MARCADOR_V1 and c == 1}
    visibles: dict[int, Celda] = {}
    for col, celda in celdas.items():
        canonica = permitidas.get(col)
        if canonica is None:
            continue
        if canonica == "tipo_acuerdo" and limpiar(celda.texto).lower() not in TIPOS_DE_ACUERDO_V1:
            continue
        visibles[col] = celda
    return visibles


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
    influencers_v1 = es_hoja_influencers_v1(hoja)
    # El esquema V1 fija la cabecera en la fila 2 (no se adivina).
    cabecera = (
        (FILA_CABECERA_V1 if FILA_CABECERA_V1 in hoja.filas else None)
        if influencers_v1
        else detectar_cabecera(hoja)
    )
    nombres = nombres_de_cabecera(hoja, cabecera)
    permitidas = columnas_de_texto_v1(hoja, cabecera) if influencers_v1 else {}
    filas = [n for n in sorted(hoja.filas) if n != cabecera]

    def celdas_de_texto(n: int) -> dict[int, Celda]:
        if not influencers_v1:
            return hoja.filas[n]
        return _celdas_visibles_v1(n, hoja.filas[n], permitidas, cabecera)

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
        cuerpo = "\n".join(_texto_de_fila(n, celdas_de_texto(n), nombres, cabecera) for n in grupo)
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
        texto = _texto_de_fila(numero, celdas_de_texto(numero), nombres, cabecera)
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
    if influencers_v1:
        # Declarado, no silencioso: qué columnas llegan al texto de los fragmentos.
        entrada["fragmentTextAllowlist"] = {
            "schema": PREFIJO_MARCADOR_INFLUENCERS,
            "columns": sorted(set(permitidas.values())),
            "columnsWithheld": sum(
                1 for c in (hoja.filas[cabecera] if cabecera is not None else {}) if c not in permitidas
            ),
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
