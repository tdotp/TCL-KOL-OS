/**
 * QA adversarial F10 (independiente) — EXTRA: `actividadReciente(actor)` (caso de uso con actor, F10).
 *
 * Roles sin `audit:read` (cliente, operativo, consultor) reciben vacío; roles con `audit:read` pero sin `finance:read`
 * (analista, legal) no ven acciones operativas/PII; ninguna actividad cruza organizaciones; la auditoría no guarda PII,
 * montos ni textos libres; el límite no abre una lectura masiva.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as db from './index.ts';
import { closePool } from './client.ts';
import { C, CENTINELAS_INTERNOS, sembrarSmartPR } from './qa-f10-soporte.ts';
import {
  type EscenarioDeOperacion,
  crearEscenarioDeOperacion,
  limpiarEscenarioDeOperacion,
} from './test-utils.ts';

let op: EscenarioDeOperacion;
const OPERATIVA = /^(shipment|payment|billing|agreement|pii|ops_evidence|operational_event)/u;

beforeAll(async () => {
  op = await crearEscenarioDeOperacion('QA F10 actividad', { conAcuerdoAjeno: true });
  await sembrarSmartPR(op);
}, 240_000);

afterAll(async () => {
  await limpiarEscenarioDeOperacion(op);
  await closePool();
});

describe('QA F10 · actividadReciente(actor)', () => {
  it('sin `audit:read` (cliente, operativo, consultor) devuelve vacío aunque la organización tenga actividad', async () => {
    for (const u of [op.cliente, op.operativo, op.consultor]) {
      expect(await db.actividadReciente(u, 50), u.role).toEqual([]);
    }
    expect((await db.actividadReciente(op.admin, 50)).length).toBeGreaterThan(5);
  });

  it('analista y legal (audit:read sin finance:read) no ven acciones operativas ni de PII; admin y director sí (control)', async () => {
    for (const u of [op.analista, op.legal]) {
      const filas = await db.actividadReciente(u, 500);
      expect(filas.length, u.role).toBeGreaterThan(0);
      expect(
        filas.map((f) => f.action).filter((a) => OPERATIVA.test(a)),
        u.role,
      ).toEqual([]);
    }
    for (const u of [op.admin, op.director]) {
      const filas = await db.actividadReciente(u, 2000);
      expect(
        filas.some((f) => OPERATIVA.test(f.action)),
        `${u.role} debería ver actividad operativa`,
      ).toBe(true);
    }
  });

  it('no mezcla organizaciones: el admin de otra agencia solo ve la suya y ningún centinela de SmartPR', async () => {
    const ajena = await db.actividadReciente(op.ajeno, 2000);
    const texto = JSON.stringify(ajena);
    for (const c of CENTINELAS_INTERNOS) expect(texto, c).not.toContain(c);
    const propia = await db.actividadReciente(op.admin, 2000);
    const idsPropios = new Set(propia.map((f) => f.id));
    expect(ajena.filter((f) => idsPropios.has(f.id))).toEqual([]);
  });

  it('la auditoría nunca guarda PII, montos, condiciones ni texto libre (ni siquiera para quien ve actividad operativa)', async () => {
    const texto = JSON.stringify(await db.actividadReciente(op.admin, 5000));
    for (const c of [
      C.telefono,
      C.documento,
      C.direccion,
      C.feeCifra,
      C.condiciones,
      C.comentario,
      C.mensajeChat,
    ]) {
      expect(texto, c).not.toContain(c);
    }
  });

  // QA-F10-09 (CORREGIDO): `actividadReciente(actor, limite)` aceptaba cualquier límite (1e9 devuelve TODA la auditoría de la
  // organización). Hoy ningún llamador lo controla (las páginas pasan 6), pero el caso de uso nuevo no lo acota por sí mismo.
  it('QA-F10-09 corregido · el límite de actividadReciente está acotado por el propio caso de uso', async () => {
    for (const l of [1e9, 1_000_000]) {
      const r = await db.actividadReciente(op.admin, l);
      expect(r.length, `límite ${l}`).toBeLessThanOrEqual(500);
    }
  });

  it('un límite no válido (0, negativo, NaN) no devuelve filas ni abre una consulta distinta', async () => {
    for (const l of [0, -1, Number.NaN]) {
      const r = await db.actividadReciente(op.admin, l).catch(() => [] as const);
      expect(r.length, `límite ${l}`).toBe(0);
    }
  });

  it('un actor inactivo o con rol manipulado no gana actividad (el rol manda, no la etiqueta)', async () => {
    expect(await db.actividadReciente({ ...op.cliente, role: 'cliente' }, 50)).toEqual([]);
    expect(await db.actividadReciente({ ...op.operativo, role: 'operativo' }, 50)).toEqual([]);
  });
});
