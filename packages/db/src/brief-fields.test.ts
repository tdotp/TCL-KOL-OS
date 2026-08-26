/**
 * `confirmarCampo` / `corregirCampo` / `resolverConflicto` (§3.1).
 *
 * Regresión de un bug real, encontrado en Demo A (P80, extracción real):
 * corregir un campo que el worker había extraído con `confidence` no nulo
 * rompía `brief_fields_manual_sin_confianza` — la migración 004 exige que un
 * campo `manual_local` nunca lleve una confianza estimada por IA, y el
 * `UPDATE` de `corregirCampo`/`resolverConflicto` cambiaba `provenance_type`
 * a `manual_local` sin poner `confidence = NULL`. Ningún test lo detectó
 * porque `crearBriefManual` nunca siembra un campo con `confidence` — solo
 * un dato realmente extraído lo tiene, y esta suite es la primera en
 * simular exactamente eso.
 *
 * Campaña propia y desechable (INC-001A) — nunca P80 ni el seed compartido.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { User } from '@tcl-kol-os/domain';
import { closePool, query } from './client.ts';
import { crearBriefManual } from './manual.ts';
import { confirmarCampo, corregirCampo, resolverConflicto } from './brief-fields.ts';

let orgId: string;
let userId: string;
let actor: User;
let campanaPropia: string;
let versionId: string;

beforeAll(async () => {
  const [admin] = await query<{ id: string; organization_id: string }>(
    `SELECT id, organization_id FROM users WHERE email = 'gerardo@smartpr.co'`,
  );
  userId = admin!.id;
  orgId = admin!.organization_id;
  actor = {
    id: userId,
    email: 'gerardo@smartpr.co',
    name: 'Gerardo',
    organizationId: orgId,
    role: 'admin',
    status: 'activo',
  };

  const campana = await query<{ id: string }>(
    `INSERT INTO campaigns (organization_id, name, owner_id, created_by)
     VALUES ($1, $2, $3, $3) RETURNING id`,
    [orgId, `Confirmar y corregir · corrida ${Date.now()}`, userId],
  );
  campanaPropia = campana[0]!.id;

  const creado = await crearBriefManual(actor, campanaPropia);
  if (!creado.ok) throw new Error('No se pudo sembrar el brief manual de prueba.');
  versionId = creado.value.versionId;
});

afterAll(async () => {
  await query(`DELETE FROM campaigns WHERE id = $1`, [campanaPropia]);
  await closePool();
});

/**
 * Simula un campo realmente extraído — status/provenance/confidence reales,
 * nunca los de `crearBriefManual`. El propio `UPDATE` incrementa `revision`
 * (trigger de la migración 005): devuelve la revisión real resultante, no
 * la que tendría un campo recién sembrado.
 */
async function simularCampoExtraido(
  key: string,
  value: unknown,
  confidence = 0.8,
): Promise<{ id: string; revision: number }> {
  const [fila] = await query<{ id: string; revision: number }>(
    `UPDATE brief_fields
        SET value = $1::jsonb, status = 'found', provenance_type = 'extracted', confidence = $2
      WHERE brief_version_id = $3 AND key = $4 AND campaign_product_id IS NULL
      RETURNING id, revision`,
    [JSON.stringify(value), confidence, versionId, key],
  );
  return fila!;
}

describe('corregirCampo sobre un campo con confianza real (regresión Demo A)', () => {
  it('corrige un campo extraído con confidence no nulo sin violar brief_fields_manual_sin_confianza', async () => {
    const { id: fieldId, revision } = await simularCampoExtraido('mensaje_principal.tono', 'Directo', 0.8);

    const resultado = await corregirCampo(actor, versionId, fieldId, {
      value: 'Directo y cercano',
      motivo: 'Ajuste de tono',
      revisionEsperada: revision,
    });
    expect(resultado.ok, !resultado.ok ? resultado.error.message : '').toBe(true);

    const [fila] = await query<{
      value: unknown;
      provenance_type: string;
      confidence: string | null;
    }>(
      `SELECT value, provenance_type::text, confidence FROM brief_fields WHERE id = $1`,
      [fieldId],
    );
    expect(fila!.value).toBe('Directo y cercano');
    expect(fila!.provenance_type).toBe('manual_local');
    expect(fila!.confidence).toBeNull();
  });

  it('confirmar NUNCA cambia provenance_type ni confidence (regla del módulo)', async () => {
    const { id: fieldId, revision } = await simularCampoExtraido('mensaje_principal.mensaje_clave', 'Rendimiento real', 0.9);

    const resultado = await confirmarCampo(actor, versionId, fieldId, { revisionEsperada: revision });
    expect(resultado.ok, !resultado.ok ? resultado.error.message : '').toBe(true);

    const [fila] = await query<{
      provenance_type: string;
      confidence: string | null;
      review_status: string;
    }>(
      `SELECT provenance_type::text, confidence, review_status FROM brief_fields WHERE id = $1`,
      [fieldId],
    );
    expect(fila!.provenance_type).toBe('extracted');
    expect(Number(fila!.confidence)).toBeCloseTo(0.9, 5);
    expect(fila!.review_status).toBe('confirmed');
  });

  it('rechaza corregir con una revisión desactualizada (concurrencia optimista)', async () => {
    const { id: fieldId } = await simularCampoExtraido('objetivo.marca_comunicacion', 'Confianza', 0.7);

    const resultado = await corregirCampo(actor, versionId, fieldId, {
      value: 'x',
      revisionEsperada: 999,
    });
    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.error.code).toBe('FIELD_REVISION_CONFLICT');
  });
});

describe('resolverConflicto sobre un campo con confianza real', () => {
  it('resuelve un conflicto extraído con confidence no nulo sin violar brief_fields_manual_sin_confianza', async () => {
    const { id: fieldId } = await simularCampoExtraido('practico.presupuesto', 'USD 40,000', 0.6);
    const [conflicto] = await query<{ revision: number }>(
      `UPDATE brief_fields SET status = 'conflict', value = NULL WHERE id = $1 RETURNING revision`,
      [fieldId],
    );

    const resultado = await resolverConflicto(actor, versionId, fieldId, {
      value: 'USD 55,000',
      keepEvidenceIds: [],
      revisionEsperada: conflicto!.revision,
    });
    expect(resultado.ok, !resultado.ok ? resultado.error.message : '').toBe(true);

    const [fila] = await query<{
      value: unknown;
      status: string;
      provenance_type: string;
      confidence: string | null;
    }>(
      `SELECT value, status::text, provenance_type::text, confidence FROM brief_fields WHERE id = $1`,
      [fieldId],
    );
    expect(fila!.value).toBe('USD 55,000');
    expect(fila!.status).toBe('found');
    expect(fila!.provenance_type).toBe('manual_local');
    expect(fila!.confidence).toBeNull();
  });
});
