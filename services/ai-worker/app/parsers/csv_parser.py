"""Parser de CSV (V2 · Fase 4): una hoja de cálculo en texto.

Misma serialización y mismos fragmentos que un XLSX (`tabular.py`): cada fila
como pares «cabecera: valor», con localizador de rango. No hay fórmulas ni
macros que considerar: todo es texto, y una celda que empieza por `=` es solo
texto (nunca se evalúa). La hoja se llama «CSV».
"""

from __future__ import annotations

import csv
import io

from .base import ParseError, Resultado
from .tabular import (
    MAX_CARACTERES_CELDA,
    MAX_CELDAS_TOTAL,
    MAX_COLUMNAS,
    MAX_FILAS_POR_HOJA,
    NUMERO,
    TEXTO,
    Celda,
    Hoja,
    construir_resultado,
    limpiar,
    parece_numero,
)

GENERADOR = "ai-worker/csv@1"
NOMBRE_HOJA = "CSV"
_DELIMITADORES = ",;\t|"


def _invalido(mensaje: str) -> ParseError:
    return ParseError(mensaje, codigo="INVALID_SPREADSHEET", reintentable=False)


def _detectar_delimitador(contenido: str) -> str:
    """El delimitador más consistente entre las primeras líneas (`,` si no hay ninguno).

    Se cuenta cuántas líneas tienen EL MISMO número (> 0) de cada candidato: una
    fila suelta que no encaja (un comentario, un título) no cambia el resultado,
    cosa que `csv.Sniffer` no garantiza.
    """
    lineas = [ln for ln in contenido.splitlines()[:50] if ln.strip()]
    mejor, mejor_puntaje = ",", (0, 0)
    for candidato in _DELIMITADORES:
        conteos = [ln.count(candidato) for ln in lineas]
        positivos = [c for c in conteos if c > 0]
        if not positivos:
            continue
        moda = max(set(positivos), key=positivos.count)
        puntaje = (positivos.count(moda), moda)
        if puntaje > mejor_puntaje:
            mejor, mejor_puntaje = candidato, puntaje
    return mejor


def parse_completo(path: str) -> Resultado:
    try:
        with open(path, encoding="utf-8-sig", newline="") as f:
            contenido = f.read()
    except UnicodeDecodeError as exc:
        raise ParseError(
            "El CSV no es texto UTF-8 válido. Expórtelo de nuevo como «CSV UTF-8».",
            codigo="SPREADSHEET_PARSE_FAILED",
            reintentable=False,
        ) from exc
    except OSError as exc:
        raise ParseError("No se pudo leer el archivo.") from exc

    delimitador = _detectar_delimitador(contenido)

    hoja = Hoja(nombre=NOMBRE_HOJA, indice=1)
    celdas_totales = 0
    try:
        for numero, fila in enumerate(
            csv.reader(io.StringIO(contenido, newline=""), delimiter=delimitador), start=1
        ):
            if len(fila) > MAX_COLUMNAS:
                raise _invalido("El CSV tiene demasiadas columnas.")
            celdas = {}
            for col, crudo in enumerate(fila, start=1):
                texto = limpiar(crudo)
                if not texto:
                    continue
                recortada = len(texto) > MAX_CARACTERES_CELDA
                if recortada:
                    texto = texto[: MAX_CARACTERES_CELDA - 1] + "…"
                    hoja.celdas_recortadas += 1
                celdas[col] = Celda(texto, NUMERO if parece_numero(texto) else TEXTO)
            if celdas:
                hoja.filas[numero] = celdas
                celdas_totales += len(celdas)
            if len(hoja.filas) > MAX_FILAS_POR_HOJA:
                raise _invalido(
                    f"El CSV tiene más de {MAX_FILAS_POR_HOJA:,} filas con datos. Divida el archivo."
                )
            if celdas_totales > MAX_CELDAS_TOTAL:
                raise _invalido(f"El CSV supera el límite de {MAX_CELDAS_TOTAL:,} celdas con datos.")
    except csv.Error as exc:
        raise ParseError(
            "El CSV está mal formado (una celda excede el límite o hay comillas sin cerrar).",
            codigo="SPREADSHEET_PARSE_FAILED",
            reintentable=False,
        ) from exc

    fragmentos, manifiesto = construir_resultado("csv", [hoja], {"delimiter": delimitador})
    if not fragmentos:
        raise ParseError(
            "El CSV no contiene datos extraíbles.", codigo="SPREADSHEET_PARSE_FAILED", reintentable=False
        )
    return Resultado(fragmentos=fragmentos, estructura=manifiesto, generador=GENERADOR, formato="csv")


def parse(path: str):  # type: ignore[no-untyped-def]
    return parse_completo(path).fragmentos
