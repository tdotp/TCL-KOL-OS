"""Worker documental e IA de TCL KOL OS.

Sin este archivo, `mypy app` no puede resolver los imports relativos
(`from . import brief_schema`) — falla con "No parent module" antes de
revisar una sola línea. `app/ai/` y `app/parsers/` ya tenían su propio
`__init__.py`; a la raíz del paquete le faltaba el suyo (hallazgo del
cierre de Sprint 4, al corregir por qué `mypy` nunca corría limpio en CI).
"""
