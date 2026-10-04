# Ejemplos del Sheet de influencers (esquema V1)

Datos sintéticos. Cada `.csv` es una pestaña del esquema `TCL_KOL_OS_INFLUENCERS_V1`
(`A1` = marcador, fila 2 = cabeceras, datos desde la fila 3). Para probarlos en
Google Sheets: **Archivo → Importar → Subir**, y luego compartir el Sheet con la
cuenta de servicio.

| Archivo | Resultado esperado |
|---|---|
| `valido-minimo.csv` | Válido: 2 personas. |
| `valido-completo.csv` | Válido: 4 personas (una con dos cuentas; dos con el mismo nombre y claves distintas = dos personas); las columnas futuras se conservan sin materializarse. |
| `invalido-sin-marcador.csv` | Sheet inválido: falta el marcador en A1. |
| `invalido-version-desconocida.csv` | Sheet inválido: versión de esquema no soportada. |
| `invalido-falta-columna.csv` | Sheet inválido: falta la columna obligatoria `handle`. |
| `invalido-registros.csv` | Sheet válido; INF-001 válido y los demás registros inválidos, cada uno por su motivo. |

Las pruebas (`packages/domain/src/influencer-sheet.fixtures.test.ts`) validan estos
archivos: la documentación no puede divergir del validador.
