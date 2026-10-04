"""Genera los libros sintéticos de las pruebas de ingestión de hojas de cálculo (V2 · Fase 4).

    services/ai-worker/.venv/bin/python fixtures/spreadsheets/generar_fixtures.py

Datos ficticios (ningún influencer ni acuerdo real). Se versionan los `.xlsx`
generados para que las pruebas no dependan de tener `xlsxwriter` instalado.
"""

from __future__ import annotations

import datetime as dt
from pathlib import Path

import xlsxwriter

AQUI = Path(__file__).resolve().parent

NOMBRES = [
    "Camila Torres", "Mateo Díaz", "Sofía Herrera", "Julián Pardo", "Laura Gómez", "Andrés Mora",
    "Daniela Ruiz", "Felipe Castro", "Paula Vargas", "Santiago León", "Isabela Ríos", "Tomás Prieto",
]


def campana_influencers() -> None:
    wb = xlsxwriter.Workbook(str(AQUI / "campana-influencers.xlsx"))
    negrita = wb.add_format({"bold": True})
    fecha = wb.add_format({"num_format": "yyyy-mm-dd"})

    ws = wb.add_worksheet("Influencers")
    ws.write_row("A1", ["Nombre", "Instagram", "Plataforma", "Producto", "Entregable", "Publicación", "Activo"], negrita)
    fila = 2
    for n, nombre in enumerate(NOMBRES, start=1):
        ws.write_row(fila - 1, 0, [nombre, f"@{nombre.split()[0].lower()}{n}", "Instagram", "C7K", "Reel"])
        ws.write_datetime(fila - 1, 5, dt.datetime(2026, 10, 1 + n), fecha)
        ws.write_boolean(fila - 1, 6, n % 2 == 0)
        fila += 1
    # La fila 14 es la de Valentina Rojas (la 13.ª persona: filas 2–13 son las anteriores).
    ws.write_row(13, 0, ["Valentina Rojas", "@valentina", "Instagram", "C7K", "Reel principal"])
    ws.write_datetime(13, 5, dt.datetime(2026, 10, 20), fecha)
    ws.write_boolean(13, 6, True)

    prod = wb.add_worksheet("Producto")
    prod.write_row("A1", ["Ficha técnica de producto"])
    prod.write_row("A6", ["Modelo", "Atributo", "Valor", "Unidad"], negrita)
    prod.write_row("A7", ["C7K", "Brillo", 1300, "nits"])
    prod.write_row("A8", ["C7K", "Tasa de refresco", 144, "Hz"])
    prod.write_row("A9", ["C7K", "Almacenamiento", 512, "GB"])
    prod.write_formula("C10", "=C7+C8", None, 1444)
    wb.close()


if __name__ == "__main__":
    campana_influencers()
    print("generado:", AQUI / "campana-influencers.xlsx")
