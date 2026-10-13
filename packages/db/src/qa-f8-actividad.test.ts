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
 * CORREGIDO (FIX-B): el Inicio y Campañas pintan la actividad solo con `audit:read`, y `listAudit` excluye por
 * defecto las acciones operativas/PII para quien no tiene `finance:read` (`incluirOperativas`).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { roleCan } from '@tcl-kol-os/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reportarPago } from './billing-payment.ts';
import { PREFIJOS_OPERATIVOS, actividadReciente, listAudit } from './audit.ts';
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

    // El rastro SÍ las trae para quien tiene `finance:read` (la opción explícita); por omisión se excluyen.
    const eventos = await listAudit(getPool(), e.operativo.organizationId, 200, { incluirOperativas: true });
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

describe('listAudit excluye por defecto las acciones operativas y de PII (sin `finance:read`)', () => {
  it('por omisión no devuelve pii.*, payment.*, billing.*, agreement.*, shipment.*, ops_evidence.* ni operational_event.*; con incluirOperativas sí', async () => {
    const e = op.e;
    const { ci, influencerId } = await nuevaParticipacion(op, 'ActividadFiltro');
    const a = await crearAcuerdoPorSql(op, { ci, mode: 'fee' });
    expect(
      (
        await reportarPago(e.operativo, {
          paymentObligationId: a.obligationId,
          expectedSeq: 1,
          idempotencyKey: unico('filtro'),
          paidOn: dia(0),
          externalReference: 'REF-FILTRO-QA8',
        })
      ).ok,
    ).toBe(true);
    const g = await guardarPii(e.operativo, { influencerId, phone: '3001112233' });
    expect(g.ok).toBe(true);
    // Una acción NO operativa (p. ej. de KPI) sí se mantiene en el listado por omisión.
    await query(
      `INSERT INTO audit_events (organization_id, actor_id, action, entity_type, metadata)
       VALUES ($1, $2, 'kpi_target.registered', 'kpi_target', '{}'::jsonb)`,
      [e.operativo.organizationId, e.operativo.id],
    );

    const sin = await listAudit(getPool(), e.operativo.organizationId, 500);
    const con = await listAudit(getPool(), e.operativo.organizationId, 500, { incluirOperativas: true });
    const operativa = (x: string): boolean => PREFIJOS_OPERATIVOS.some((p) => x.startsWith(p));
    expect(sin.filter((x) => operativa(x.action))).toEqual([]);
    expect(sin.some((x) => x.action === 'kpi_target.registered')).toBe(true);
    expect(con.some((x) => x.action === 'payment.reported')).toBe(true);
    expect(con.some((x) => x.action === 'pii.save')).toBe(true);
  });
});

describe('actividadReciente(actor): la compuerta vive en el caso de uso, no en las páginas', () => {
  it('sin `audit:read` (cliente, consultor, operativo) devuelve vacío; con él, solo la organización del actor', async () => {
    const e = op.e;
    for (const u of [e.cliente, e.consultor, e.operativo]) {
      expect(roleCan(u.role, 'audit:read')).toBe(false);
      expect(await actividadReciente(u)).toEqual([]);
    }
    const propios = await actividadReciente(e.admin, 50);
    expect(propios.length).toBeGreaterThan(0);
    const ajenos = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_events WHERE organization_id <> $1 AND id = ANY($2::uuid[])`,
      [e.admin.organizationId, propios.map((x) => x.id)],
    );
    expect(ajenos[0]?.n).toBe('0');
  });

  it('las acciones operativas/PII solo salen para quien tiene `finance:read`', async () => {
    const e = op.e;
    for (const u of [e.admin, e.director]) {
      const eventos = await actividadReciente(u, 500);
      const operativas = eventos.filter((x) => PREFIJOS_OPERATIVOS.some((p) => x.action.startsWith(p)));
      if (!roleCan(u.role, 'finance:read')) expect(operativas).toEqual([]);
    }
  });

  it('las páginas ya no copian la compuerta: llaman al caso de uso', () => {
    for (const ruta of ['page.tsx', 'campanas/page.tsx']) {
      const fuente = pagina(ruta);
      expect(fuente).toMatch(/actividadReciente\(/);
      expect(fuente).not.toMatch(/listAudit\(/);
    }
  });
});
