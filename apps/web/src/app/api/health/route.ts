/**
 * Épica E12-4 — sonda de vitalidad.
 *
 * `/health` responde si el proceso está vivo. No comprueba dependencias:
 * para eso está `/ready`.
 */

export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json({ status: 'ok', service: 'web' });
}
