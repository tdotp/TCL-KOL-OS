/**
 * Épica E12-4 — sonda de disponibilidad.
 *
 * Reporta el estado de cada dependencia para poder identificar cuándo Drive,
 * el storage o la IA no están disponibles (§12.4).
 *
 * No expone URLs con credenciales ni rutas internas (§11.6).
 */

export const dynamic = 'force-dynamic';

type DependencyState = 'configurada' | 'no_configurada';

function stateOf(variable: string | undefined): DependencyState {
  return variable !== undefined && variable.trim() !== '' ? 'configurada' : 'no_configurada';
}

export function GET(): Response {
  const dependencies = {
    database: stateOf(process.env['DATABASE_URL']),
    redis: stateOf(process.env['REDIS_URL']),
    worker: stateOf(process.env['WORKER_URL']),
  };

  const aiEnabled = process.env['AI_ENABLED']?.toLowerCase() === 'true';

  return Response.json({
    status: 'ready',
    service: 'web',
    environment: process.env['NODE_ENV'] ?? 'development',
    // El flag de IA apagado es un estado válido, no una degradación:
    // el brief se completa igual (§5, principio 9).
    aiEnabled,
    dependencies,
  });
}
