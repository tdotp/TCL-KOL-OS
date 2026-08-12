#!/usr/bin/env python3
"""Proceso consumidor de la cola de procesamiento documental.

    python worker.py            # bucle continuo
    python worker.py --once     # procesa lo pendiente y termina

Resiliencia (casos R-02 y R-04 del plan de pruebas)
---------------------------------------------------
Si la base de datos desaparece —un `docker compose down`, un reinicio, una red
que se cae— el worker **no muere ni se queda colgado**: cierra la conexión rota,
espera y vuelve a conectar. Un worker que sobrevive al arranque pero deja de
consumir en silencio es peor que uno que se cae, porque nadie se entera.
"""

from __future__ import annotations

import argparse
import logging
import sys
import time

import psycopg

from app.config import ConfigError, Settings, load_settings
from app.runner import ciclo

logger = logging.getLogger("ai-worker")

#: Espera antes de reintentar la conexión, con techo.
RECONEXION_SEGUNDOS = [1, 2, 5, 10, 30]


def _espera(intentos: int) -> int:
    return RECONEXION_SEGUNDOS[min(intentos, len(RECONEXION_SEGUNDOS) - 1)]


def bucle_resiliente(settings: Settings, intervalo: float) -> None:
    """Consume la cola, reconectando cuando la base no está disponible."""
    fallos = 0

    while True:
        try:
            with psycopg.connect(settings.database_url, connect_timeout=10) as conn:
                if fallos > 0:
                    logger.info("Conexión restablecida tras %d intento(s).", fallos)
                fallos = 0
                ciclo(conn, intervalo=intervalo)

        except psycopg.OperationalError as exc:
            fallos += 1
            espera = _espera(fallos - 1)
            logger.warning(
                "Sin conexión a la base de datos (intento %d): %s. Reintento en %ds.",
                fallos,
                str(exc).splitlines()[0],
                espera,
            )
            time.sleep(espera)

        except KeyboardInterrupt:
            logger.info("Worker detenido por el usuario.")
            return


def main() -> int:
    parser = argparse.ArgumentParser(description="Worker documental de TCL KOL OS")
    parser.add_argument("--once", action="store_true", help="procesa lo pendiente y termina")
    parser.add_argument("--intervalo", type=float, default=2.0, help="segundos entre sondeos")
    args = parser.parse_args()

    try:
        settings = load_settings()
    except ConfigError as exc:
        print(f"Configuración inválida: {exc}", file=sys.stderr)
        return 1

    logging.basicConfig(
        level=settings.log_level,
        format="%(asctime)s %(levelname)s %(name)s · %(message)s",
    )
    logger.info("Worker documental iniciado: %s", settings.redacted())

    if args.once:
        try:
            with psycopg.connect(settings.database_url, connect_timeout=10) as conn:
                procesados = ciclo(conn, max_jobs=1000)
            logger.info("Procesados %d documento(s). Fin.", procesados)
        except psycopg.OperationalError as exc:
            logger.error("No se pudo conectar a la base de datos: %s", str(exc).splitlines()[0])
            return 1
        return 0

    bucle_resiliente(settings, args.intervalo)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
