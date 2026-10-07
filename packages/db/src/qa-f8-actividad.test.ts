/**
 * QA ADVERSARIAL F8 · la «Actividad» del Inicio muestra eventos de pago, PII y acuerdos a roles sin esa capacidad
 * (ataque 2, 18).
 *
 * `apps/web/src/app/(app)/page.tsx` y `(app)/campanas/page.tsx` leen `listAudit(getPool(), organizationId, 6)` para
 * TODO rol que no sea `cliente` (consultor, analista, legal, operativo…) y pintan «actor · acción». `listAudit` no
 * filtra por rol. Desde F8 la auditoría trae `payment.reported`, `billing.validated`, `agreement.version_registered`,
 * `pii.reveal`, `pii.save`, `shipment.delivered`…: el consultor, el analista y el legal (sin `finance:read` ni
 * `pii:read`) ven quién reportó un pago o reveló datos personales y cuándo. No hay montos (la allowlist de F8 lo
 * impide): es fuga de ACTIVIDAD financiera y de PII, no de cifras.
 *
 * `it.fails` = «abierto»: al corregir, quitar `.fails`.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reportarPago } from './billing-payment.ts';
import { listAudit } from './audit.ts';
import { closePool, getPool, query } from './client.ts';
import { guardarPii, revelarPii } from './pii.ts';
import {
  type EscenarioDeOperacion,
  crearAcuerdoPorSql,
  crearEscenarioDeOperacion,
  dia,
  limpiarEscenarioDeOperacion,
  nuevaParticipacion,
  unico,
} from './ops-test-support.ts';

let op: EscenarioDeOperacion;
beforeAll(async () => {
  op = await crearEscenarioDeOperacion('QA F8 actividad');
}, 120_000);
afterAll(async () => {
  await limpiarEscenarioDeOperacion(op);
  await closePool();
});

const aqui = dirname(fileURLToPath(import.meta.url));
const pagina = (ruta: string): string =>
  readFileSync(resolve(aqui, '../../../apps/web/src/app/(app)', ruta), 'utf8');

describe('CONTROL: la auditoría de la organización trae eventos de pago y PII (y ningún valor sensible)', () => {
  it('payment.reported, pii.save y pii.reveal aparecen en listAudit, sin referencia ni teléfono en su metadata', async () => {
    const e = op.e;
    const { ci, influencerId } = await nuevaParticipacion(op, 'Actividad');
    const a = await crearAcuerdoPorSql(op, { ci, mode: 'fee' });
    const r = await reportarPago(e.operativo, {
      paymentObligationId: a.obligationId,
      expectedSeq: 1,
      idempotencyKey: unico('act'),
      paidOn: dia(0),
      externalReference: 'REF-ACTIVIDAD-QA8',
    });
    expect(r.ok).toBe(true);
    const g = await guardarPii(e.operativo, { influencerId, phone: '3009998877' });
    expect(g.ok).toBe(true);
    if (g.ok) expect((await revelarPii(e.operativo, g.value.record.recordId, ['phone'])).ok).toBe(true);

    const eventos = await listAudit(getPool(), e.operativo.organizationId, 200);
    const acciones = new Set(eventos.map((x) => x.action));
    expect(acciones.has('payment.reported')).toBe(true);
    expect(acciones.has('pii.save')).toBe(true);
    expect(acciones.has('pii.reveal')).toBe(true);
    const serializado = JSON.stringify(
      eventos.filter((x) => /^(payment|pii)\./.test(x.action)).map((x) => x.metadata),
    );
    expect(serializado).not.toContain('REF-ACTIVIDAD-QA8');
    expect(serializado).not.toContain('3009998877');
    const [n] = await query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_events WHERE action = 'payment.reported'`,
    );
    expect(Number(n!.n)).toBeGreaterThan(0);
  });
});

describe('ABIERTO P2 · el Inicio y el listado de campañas muestran la actividad a todo rol salvo cliente', () => {
  it.fails(
    'Inicio: listAudit solo se llama para roles con audit:read (no consultor/operativo, y sin eventos F8 para analista/legal)',
    () => {
      const fuente = pagina('page.tsx');
      expect(fuente).toMatch(/roleCan\([^)]*['"]audit:read['"]/);
    },
  );

  it.fails('Campañas: listAudit solo se llama para roles con audit:read', () => {
    const fuente = pagina('campanas/page.tsx');
    expect(fuente).toMatch(/roleCan\([^)]*['"]audit:read['"]/);
  });
});
