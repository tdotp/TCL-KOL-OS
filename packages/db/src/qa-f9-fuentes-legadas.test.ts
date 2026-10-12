/**
 * QA adversarial F9 — lectores LEGADOS de fuentes (`source:read_shared`, capacidad que el cliente tenía y se RETIRÓ en el ciclo de corrección: los lectores legados ahora deniegan): ¿qué
 * obtiene el cliente por `listSources` / `getSource` / `getFragments` / `obtenerRepresentacionNormalizada` /
 * `buscar*` cuando SmartPR marca por error el Sheet de influencers como visible para TCL? La proyección TCL lo excluye
 * de «Documentos» aun así; estos lectores no. Aserciones = comportamiento seguro esperado.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, query } from './client.ts';
import { crearSheetDePrueba, SENTINELA_FEE } from './kpi-test-support.ts';
import { buscarTextoEnFuentes } from './search.ts';
import { getFragments, getSource, listSources, obtenerRepresentacionNormalizada } from './sources.ts';
import { obtenerDocumentosParaTcl } from './tcl-projection.ts';
import {
  type EscenarioDeOperacion,
  crearEscenarioDeOperacion,
  limpiarEscenarioDeOperacion,
} from './test-utils.ts';

let op: EscenarioDeOperacion;
let sheetId = '';

beforeAll(async () => {
  op = await crearEscenarioDeOperacion('QA F9 fuentes', { conAcuerdoAjeno: false });
  await query(`UPDATE campaigns SET visibility = 'tcl' WHERE id = $1`, [op.campanaId]);
  const sheet = await crearSheetDePrueba(op.admin, {
    campaignId: op.campanaId,
    campaignInfluencerId: op.participaciones.valentinaRios,
    kpiOrigen: 'a',
    kpiVigente: 'b',
  });
  sheetId = sheet.sourceId;
  await query(`UPDATE source_documents SET visibility = 'tcl' WHERE id = $1`, [sheetId]);
  // fragmento del snapshot vigente SIN lista blanca → ilegible por fragment-scope; uno CON lista blanca → legible
}, 120_000);
afterAll(async () => {
  await limpiarEscenarioDeOperacion(op);
  await closePool();
});

describe('QA F9 · el Sheet de influencers compartido por error', () => {
  it('control: la proyección TCL NO lo lista como documento', async () => {
    const r = await obtenerDocumentosParaTcl(op.cliente, op.campanaId);
    expect(r.ok && r.value.map((d) => d.sourceId)).not.toContain(sheetId);
  });
  it('listSources(cliente) no lo devuelve (el cliente ya no tiene `source:read_shared`: denegado)', async () => {
    const r = await listSources(op.cliente, op.campanaId);
    expect(r.ok).toBe(false);
    expect(r.ok && r.value.map((s) => s.id), 'listSources expone el Sheet de influencers').not.toContain(
      sheetId,
    );
    if (!r.ok) expect(r.error.code).toBe('FORBIDDEN_ROLE');
  });
  it('getSource(cliente) no lo devuelve (ni su external_url de Google)', async () => {
    const r = await getSource(op.cliente, sheetId);
    expect(r.ok, `getSource → ${JSON.stringify(r.ok ? r.value : r.error).slice(0, 400)}`).toBe(false);
  });
  it('obtenerRepresentacionNormalizada(cliente) no devuelve estructura/snapshot del Sheet', async () => {
    const r = await obtenerRepresentacionNormalizada(op.cliente, sheetId);
    expect(r.ok, `representación → ${JSON.stringify(r.ok ? r.value : r.error).slice(0, 600)}`).toBe(false);
  });
  it('getFragments(cliente) no devuelve fragmentos del Sheet', async () => {
    const r = await getFragments(op.cliente, sheetId);
    expect(r.ok && r.value.length, 'fragmentos del Sheet').toBeFalsy();
  });
  it('búsqueda textual: ningún acceso del cliente al texto con la sentinela de fee', async () => {
    const r = await (buscarTextoEnFuentes as unknown as (...a: unknown[]) => Promise<unknown>)(
      op.cliente,
      op.campanaId,
      SENTINELA_FEE,
    ).catch((e: unknown) => ({ ok: false, e }));
    expect(JSON.stringify(r)).not.toContain(SENTINELA_FEE);
  });
  it('hash y URL externa no salen: ni por los lectores legados (denegados) ni por la proyección de documentos', async () => {
    const r = await listSources(op.cliente, op.campanaId);
    expect(r.ok).toBe(false);
    const d = await obtenerDocumentosParaTcl(op.cliente, op.campanaId);
    expect(d.ok).toBe(true);
    const texto = JSON.stringify(d.ok ? d.value : []).toLowerCase();
    for (const t of ['hash', 'external', 'url', 'docs.google']) expect(texto, t).not.toContain(t);
  });
});
