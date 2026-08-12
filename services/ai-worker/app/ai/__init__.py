"""Capa de IA: adaptador de proveedor y router de niveles (Épica E11)."""

from .openrouter import AIError, Respuesta, Uso, completar, disponible, embeddings
from .router import Destino, RouterError, configuracion_actual, modelo_de_embeddings, resolver

__all__ = [
    "AIError",
    "Respuesta",
    "Uso",
    "completar",
    "disponible",
    "embeddings",
    "Destino",
    "RouterError",
    "configuracion_actual",
    "modelo_de_embeddings",
    "resolver",
]
