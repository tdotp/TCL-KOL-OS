# Fixture de pipeline documental

`documento-de-prueba.pptx` es sintético — nunca material real de un cliente.
Lo usa `packages/db/src/pipeline.test.ts` (Épica E4) para probar el
procesamiento real de un documento (carga → cola → worker → fragmentos con
localizador) sin depender de una ruta de archivo personal de ninguna
máquina de desarrollo, ni de ningún proveedor de IA.

## Contenido

3 diapositivas, cada una con un título y un párrafo de texto distinto y
reconocible ("Diapositiva de prueba uno/dos/tres..."). Suficiente para
verificar que el parser conserva el número de diapositiva por fragmento y
que hay más de una diapositiva — la propiedad que la prueba comprueba.

## Cómo se generó

Con `python-pptx` (ya es una dependencia de `services/ai-worker`), una sola
vez:

```python
from pptx import Presentation

prs = Presentation()
layout = prs.slide_layouts[1]  # título + contenido

contenidos = [
    ("Diapositiva de prueba uno", "Primer fragmento sintético..."),
    ("Diapositiva de prueba dos", "Segundo fragmento sintético..."),
    ("Diapositiva de prueba tres", "Tercer fragmento sintético..."),
]

for titulo, cuerpo in contenidos:
    slide = prs.slides.add_slide(layout)
    slide.shapes.title.text = titulo
    slide.placeholders[1].text = cuerpo

prs.save("fixtures/pipeline/documento-de-prueba.pptx")
```

Si hace falta regenerarlo (por ejemplo, para probar otro formato o más
diapositivas), correr un script equivalente y confirmar con
`services/ai-worker/.venv/bin/python -c "from app import parsers; ..."`
que el parser real produce el número de fragmentos esperado antes de
commitear el archivo nuevo.
