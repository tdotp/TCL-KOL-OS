"""Router de tareas a modelos (Épica E11-6).

Traduce el nivel que pide una tarea —definido en `packages/domain/ai-tasks.ts`
según §9.2— al modelo concreto que lo atiende.

El nivel es una decisión de producto y vive en el dominio.
El modelo es configuración y vive aquí.

Esa separación es lo que permite cambiar de modelo sin tocar lógica de negocio,
y lo que hace posible **medir** qué modelo merece cada nivel en vez de elegirlo
por intuición (banco de validación: `scripts/validar_niveles.py`).
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Dict, Optional

#: Niveles de §9.2. Deben coincidir con `ModelTier` del dominio.
NIVELES = ("eficiente", "equilibrado", "avanzado")

#: Tarea → nivel. Espejo de `packages/domain/src/ai-tasks.ts`.
#: Si cambia allá, cambia aquí: la fuente de verdad es el dominio.
#: Ajustado por DEC-020 según la intervención real del modelo en cada tarea.
TAREA_A_NIVEL: Dict[str, str] = {
    "extraer_campos": "eficiente",
    "detectar_vacios": "eficiente",      # DEC-020: ~85% determinista
    "traducir": "eficiente",
    "redactar_brief": "eficiente",       # DEC-020: ~75% determinista
    "buscar_evidencia": "eficiente",
    "resolver_ambiguedad": "equilibrado",  # DEC-020: avanzado no aporta hoy
    "generar_embedding": "eficiente",
}


class RouterError(RuntimeError):
    """Falta configuración para atender una tarea."""


@dataclass(frozen=True)
class Destino:
    tarea: str
    nivel: str
    modelo: str


def _variable_de(nivel: str) -> str:
    return f"AI_MODEL_{nivel.upper()}"


def modelo_de_nivel(nivel: str) -> str:
    """Modelo configurado para un nivel.

    No hay valores por defecto a propósito: un modelo que aparece solo porque
    alguien no configuró nada acabaría en producción sin que nadie lo decidiera,
    y su costo y su calidad serían una sorpresa.
    """
    if nivel not in NIVELES:
        raise RouterError(f"Nivel desconocido: {nivel}. Válidos: {', '.join(NIVELES)}.")

    valor = os.environ.get(_variable_de(nivel), "").strip()
    if not valor:
        raise RouterError(
            f"No hay modelo configurado para el nivel '{nivel}'. "
            f"Defina {_variable_de(nivel)} en .env "
            "(ver docs/decisions/decision-log.md, DEC-019)."
        )
    return valor


def modelo_de_embeddings() -> str:
    valor = os.environ.get("AI_MODEL_EMBEDDINGS", "").strip()
    if not valor:
        raise RouterError(
            "No hay modelo de embeddings configurado. Defina AI_MODEL_EMBEDDINGS en .env."
        )
    return valor


def resolver(tarea: str, nivel_forzado: Optional[str] = None) -> Destino:
    """Decide qué modelo atiende una tarea.

    `nivel_forzado` existe para el banco de validación: permite correr la misma
    tarea en distintos niveles y comparar resultados. En operación normal no se
    usa — el nivel lo decide el catálogo, no quien llama.
    """
    if tarea not in TAREA_A_NIVEL:
        raise RouterError(f"Tarea desconocida: {tarea}.")

    nivel = nivel_forzado or TAREA_A_NIVEL[tarea]
    return Destino(tarea=tarea, nivel=nivel, modelo=modelo_de_nivel(nivel))


def configuracion_actual() -> Dict[str, Optional[str]]:
    """Estado de la configuración, para diagnóstico. Nunca incluye la clave."""
    estado: Dict[str, Optional[str]] = {}
    for nivel in NIVELES:
        estado[nivel] = os.environ.get(_variable_de(nivel), "").strip() or None
    estado["embeddings"] = os.environ.get("AI_MODEL_EMBEDDINGS", "").strip() or None
    return estado
