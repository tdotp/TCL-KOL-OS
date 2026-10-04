/**
 * Transacciones que devuelven `Result`.
 *
 * `transaction()` confirma si la función termina y deshace si lanza. Un caso de
 * uso que valida a mitad de camino (después de haber escrito algo) necesita
 * abortar Y devolver un error de dominio: se lanza `Abortar`, la transacción se
 * deshace entera y el error llega al llamador como `Result`, no como excepción.
 *
 * También traduce una violación de UNIQUE concurrente (23505) a
 * `RESOURCE_CONFLICT`: dos solicitudes simultáneas que pasaron la comprobación
 * previa no producen un 500, producen el mismo error que el duplicado serial.
 */

import type pg from 'pg';
import { type DomainErrorPayload, DomainError, type Result, err, ok } from '@tcl-kol-os/domain';
import { transaction } from './client.ts';

export class Abortar extends Error {
  readonly payload: DomainErrorPayload;
  constructor(payload: DomainErrorPayload) {
    super(payload.message);
    this.name = 'Abortar';
    this.payload = payload;
  }
}

function esViolacionUnica(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505';
}

export async function transaccionConResultado<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
  conflictoConcurrente: DomainErrorPayload,
): Promise<Result<T>> {
  try {
    return ok(await transaction(fn));
  } catch (error) {
    if (error instanceof Abortar) return err(error.payload);
    if (error instanceof DomainError) return { ok: false, error };
    if (esViolacionUnica(error)) return err(conflictoConcurrente);
    throw error;
  }
}
