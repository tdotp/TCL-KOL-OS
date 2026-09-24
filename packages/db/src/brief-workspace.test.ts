/**
 * Sprint 6, Fase B — `obtenerBriefWorkspace`.
 *
 * Campañas propias y desechables en cada corrida (INC-001A) — nunca P80, nunca
 * el seed compartido. Reutiliza los mismos usuarios sembrados que
 * `client-review.test.ts` (`gerardo@smartpr.co`, `director@smartpr.co`,
 * `consultor@smartpr.co`, `marena@tcl.com`) y el mismo patrón de helper
 * (`completarHastaInternalReview`) para no reinventar cómo se llega a cada
 * estado — la máquina de estados real es la única fuente de verdad.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { User } from '@tcl-kol-os/domain';
import { catalogoDelBrief } from '@tcl-kol-os/domain';
import { closePool, query } from './client.ts';
import { findUserByEmail } from './users.ts';
import { eliminarCampanaDePrueba } from './test-utils.ts';
import { crearBriefManual } from './manual.ts';
import { corregirCampo } from './brief-fields.ts';
import {
  descartarPregunta,
  generarPreguntas,
  listarPreguntas,
  responderPregunta,
} from './local-questions.ts';
import { crearComentario, resolverComentario } from './comments.ts';
import { transicionarBrief } from './transitions.ts';
import { aprobarComoCliente, aprobarInternamente } from './client-review.ts';
import { obtenerBriefWorkspace } from './brief-workspace.ts';

let admin: User;
let director: User;
let consultor: User;
let cliente: User;
let ajeno: User;
const campanasCreadas: string[] = [];

async function nuevaCampanaPropia(etiqueta: string): Promise<string> {
  const campana = await query<{ id: string }>(
    `INSERT INTO campaigns (organization_id, name, owner_id, created_by)
     VALUES ($1, $2, $3, $3) RETURNING id`,
    [admin.organizationId, `Workspace · ${etiqueta} · ${Date.now()}`, admin.id],
  );
  const id = campana[0]!.id;
  campanasCreadas.push(id);
  return id;
}

async function agregarProductos(campaignId: string, cantidad: number): Promise<void> {
  const productos = await query<{ id: string }>(`SELECT id FROM products LIMIT $1`, [cantidad]);
  for (const [i, p] of productos.entries()) {
    await query(
      `INSERT INTO campaign_products (campaign_id, product_id, rol, prioridad) VALUES ($1, $2, $3, $4)`,
      [campaignId, p.id, i === 0 ? 'flagship' : 'secundario', i + 1],
    );
  }
}

/** Mismo patrón que `client-review.test.ts`: responde lo crítico, descarta el resto, llega a `internal_review`. */
async function completarHastaInternalReview(versionId: string, campaignId: string): Promise<void> {
  await generarPreguntas(admin, versionId);
  const preguntas = await listarPreguntas(admin, campaignId, { status: 'pendiente' });
  if (!preguntas.ok) return;
  for (const p of preguntas.value) {
    if (p.criticidad === 'critico') {
      let valor: unknown = `Respuesta de prueba para ${p.key}`;
      if (p.key.includes('fecha'))
        valor = { tipo: 'exacta', fecha: '2026-09-04', textoOriginal: '2026-09-04' };
      else if (p.key === 'objetivo.tipo') valor = 'awareness';
      else if (p.key === 'mandatorios')
        valor = [{ categoria: 'mensaje', descripcion: 'Mencionar el hashtag oficial de la campaña.' }];
      else if (p.key === 'practico.restricciones')
        valor = ['Único canal de venta autorizado: el que declare el cliente.'];
      const resultado = await responderPregunta(admin, p.id, { answerValue: valor });
      if (!resultado.ok) await descartarPregunta(admin, p.id, 'No se pudo responder automáticamente.');
    } else {
      await descartarPregunta(admin, p.id, 'No aplica: sin evidencia real disponible en esta prueba.');
    }
  }
  const resultado = await transicionarBrief(admin, versionId, 'internal_review');
  if (!resultado.ok) throw new Error(`No se pudo llegar a internal_review: ${resultado.error.message}`);
}

beforeAll(async () => {
  admin = (await findUserByEmail('gerardo@smartpr.co'))!;
  director = (await findUserByEmail('director@smartpr.co'))!;
  consultor = (await findUserByEmail('consultor@smartpr.co'))!;
  cliente = (await findUserByEmail('marena@tcl.com'))!;
  ajeno = (await findUserByEmail('ajeno@otraagencia.co'))!;
});

afterAll(async () => {
  await eliminarCampanaDePrueba(campanasCreadas);
  await closePool();
});

describe('obtenerBriefWorkspace', () => {
  it('campaña sin brief: version undefined, listas vacías, progreso en cero (caso 1)', async () => {
    const campaignId = await nuevaCampanaPropia('sin-brief');
    const resultado = await obtenerBriefWorkspace(admin, campaignId);
    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.value.version).toBeUndefined();
    expect(resultado.value.sections).toHaveLength(0);
    expect(resultado.value.tasks).toHaveLength(0);
    expect(resultado.value.progress).toEqual({
      percentage: 0,
      total: 0,
      ready: 0,
      decisionsPending: 0,
      criticalPending: 0,
      evidencePending: 0,
      commentsOpen: 0,
    });
    expect(resultado.value.allowedActions).toHaveLength(0);
  });

  it('extracción parcial: progreso refleja campos con dato frente al total (caso 2)', async () => {
    const campaignId = await nuevaCampanaPropia('parcial');
    const creado = await crearBriefManual(admin, campaignId);
    if (!creado.ok) throw new Error(creado.error.message);

    const campos = await query<{ id: string; revision: number }>(
      `SELECT id, revision FROM brief_fields WHERE brief_version_id = $1 AND campaign_product_id IS NULL LIMIT 2`,
      [creado.value.versionId],
    );
    for (const c of campos) {
      const r = await corregirCampo(admin, creado.value.versionId, c.id, {
        value: 'valor de prueba',
        revisionEsperada: c.revision,
      });
      expect(r.ok).toBe(true);
    }

    const totalEnBase = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM brief_fields WHERE brief_version_id = $1`,
      [creado.value.versionId],
    );

    const resultado = await obtenerBriefWorkspace(admin, campaignId);
    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.value.version?.status).toBe('draft');
    expect(resultado.value.version?.editable).toBe(true);
    // Sin productos en esta campaña, los campos de nivel `producto` del
    // catálogo no se insertan (`crearBriefManual` itera `campaign_products`)
    // — el total real es menor que `catalogoDelBrief().length`, y el
    // workspace debe coincidir exactamente con lo que hay en la base, no con
    // el catálogo completo.
    expect(resultado.value.progress.total).toBe(Number(totalEnBase[0]!.n));
    expect(resultado.value.progress.total).toBeLessThan(catalogoDelBrief().length);
    expect(resultado.value.progress.ready).toBeGreaterThanOrEqual(2);
    expect(resultado.value.progress.percentage).toBe(
      Math.round((resultado.value.progress.ready / resultado.value.progress.total) * 100),
    );
  });

  it('multiproducto: products refleja los productos y las secciones anclan cada fila al suyo (caso 3, 4)', async () => {
    const campaignId = await nuevaCampanaPropia('multiproducto');
    await agregarProductos(campaignId, 2);
    const creado = await crearBriefManual(admin, campaignId);
    if (!creado.ok) throw new Error(creado.error.message);

    const resultado = await obtenerBriefWorkspace(admin, campaignId);
    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.value.products).toHaveLength(2);

    const campoDeProducto = catalogoDelBrief().find((c) => c.nivel === 'producto')!;
    const seccion = resultado.value.sections.find((s) =>
      s.fields.some((f) => f.key === campoDeProducto.key),
    )!;
    const filasDelCampo = seccion.fields.filter((f) => f.key === campoDeProducto.key);
    // Un campo de nivel `producto` tiene una fila por producto, cada una anclada.
    expect(filasDelCampo).toHaveLength(2);
    for (const fila of filasDelCampo) expect(fila.campaignProductId).toBeDefined();
  });

  it('preguntas críticas pendientes cuentan en criticalPending y decisionsPending, y arman tasks (caso 5)', async () => {
    const campaignId = await nuevaCampanaPropia('criticos-pendientes');
    const creado = await crearBriefManual(admin, campaignId);
    if (!creado.ok) throw new Error(creado.error.message);
    const generadas = await generarPreguntas(admin, creado.value.versionId);
    expect(generadas.ok).toBe(true);

    const resultado = await obtenerBriefWorkspace(admin, campaignId);
    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.value.progress.criticalPending).toBeGreaterThan(0);
    expect(resultado.value.progress.decisionsPending).toBe(resultado.value.tasks.length);
    expect(resultado.value.tasks.length).toBeGreaterThan(0);
    const tarea = resultado.value.tasks[0]!;
    expect(tarea.valueType).toBeDefined();
    expect(typeof tarea.requiereEvidencia).toBe('boolean');
  });

  it('un claim con valor pero sin evidencia cuenta en evidencePending (caso 6)', async () => {
    const campaignId = await nuevaCampanaPropia('claim-sin-evidencia');
    // El claim del catálogo es de nivel `producto` — sin al menos un
    // producto en la campaña, `crearBriefManual` no inserta esa fila.
    await agregarProductos(campaignId, 1);
    const creado = await crearBriefManual(admin, campaignId);
    if (!creado.ok) throw new Error(creado.error.message);

    const claim = catalogoDelBrief().find((c) => c.criticidad === 'claim')!;
    const [fila] = await query<{ id: string; revision: number }>(
      `SELECT id, revision FROM brief_fields WHERE brief_version_id = $1 AND key = $2 LIMIT 1`,
      [creado.value.versionId, claim.key],
    );
    // `corregirCampo` siempre deja `provenance_type = 'manual_local'`, pero un
    // claim exige evidencia SIN excepción (§3.3) — nunca deja de contar solo
    // porque la respuesta vino de una persona.
    const corregido = await corregirCampo(admin, creado.value.versionId, fila!.id, {
      value: 'Afirmación de prueba sin respaldo documental',
      revisionEsperada: fila!.revision,
    });
    expect(corregido.ok).toBe(true);

    const resultado = await obtenerBriefWorkspace(admin, campaignId);
    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.value.progress.evidencePending).toBeGreaterThanOrEqual(1);
  });

  it('responder una pregunta la saca de tasks (caso 7)', async () => {
    const campaignId = await nuevaCampanaPropia('pregunta-respondida');
    const creado = await crearBriefManual(admin, campaignId);
    if (!creado.ok) throw new Error(creado.error.message);
    await generarPreguntas(admin, creado.value.versionId);

    const antes = await obtenerBriefWorkspace(admin, campaignId);
    expect(antes.ok).toBe(true);
    if (!antes.ok) return;
    const tarea = antes.value.tasks.find((t) => t.key === 'objetivo.tipo');
    expect(tarea).toBeDefined();

    const respuesta = await responderPregunta(admin, tarea!.questionId, { answerValue: 'awareness' });
    expect(respuesta.ok).toBe(true);

    const despues = await obtenerBriefWorkspace(admin, campaignId);
    expect(despues.ok).toBe(true);
    if (!despues.ok) return;
    expect(despues.value.tasks.some((t) => t.questionId === tarea!.questionId)).toBe(false);
    expect(despues.value.progress.decisionsPending).toBe(antes.value.progress.decisionsPending - 1);
  });

  it('descartar una pregunta también la saca de tasks (caso 8)', async () => {
    const campaignId = await nuevaCampanaPropia('pregunta-descartada');
    const creado = await crearBriefManual(admin, campaignId);
    if (!creado.ok) throw new Error(creado.error.message);
    await generarPreguntas(admin, creado.value.versionId);

    const antes = await obtenerBriefWorkspace(admin, campaignId);
    if (!antes.ok) throw new Error('setup falló');
    const tarea = antes.value.tasks[0]!;

    const descarte = await descartarPregunta(admin, tarea.questionId, 'No aplica para esta prueba.');
    expect(descarte.ok).toBe(true);

    const despues = await obtenerBriefWorkspace(admin, campaignId);
    if (!despues.ok) throw new Error('lectura falló');
    expect(despues.value.tasks.some((t) => t.questionId === tarea.questionId)).toBe(false);
  });

  it('un comentario abierto sube commentsOpen; resolverlo lo vuelve a bajar (caso 9)', async () => {
    const campaignId = await nuevaCampanaPropia('comentarios');
    const creado = await crearBriefManual(admin, campaignId);
    if (!creado.ok) throw new Error(creado.error.message);
    const [campo] = await query<{ key: string }>(
      `SELECT key FROM brief_fields WHERE brief_version_id = $1 AND campaign_product_id IS NULL LIMIT 1`,
      [creado.value.versionId],
    );

    const comentario = await crearComentario(admin, creado.value.versionId, {
      fieldKey: campo!.key,
      content: 'Falta precisar esto antes de avanzar.',
    });
    expect(comentario.ok).toBe(true);
    if (!comentario.ok) return;

    const conAbierto = await obtenerBriefWorkspace(admin, campaignId);
    if (!conAbierto.ok) throw new Error('lectura falló');
    expect(conAbierto.value.progress.commentsOpen).toBeGreaterThanOrEqual(1);

    const resuelto = await resolverComentario(admin, creado.value.versionId, comentario.value.id);
    expect(resuelto.ok).toBe(true);

    const conResuelto = await obtenerBriefWorkspace(admin, campaignId);
    if (!conResuelto.ok) throw new Error('lectura falló');
    expect(conResuelto.value.progress.commentsOpen).toBe(0);
  });

  it('consultor no ve la transición que exige Dirección; director sí (casos 10, 11)', async () => {
    const campaignId = await nuevaCampanaPropia('permisos-transicion');
    const creado = await crearBriefManual(admin, campaignId);
    if (!creado.ok) throw new Error(creado.error.message);
    await completarHastaInternalReview(creado.value.versionId, campaignId);

    const comoConsultor = await obtenerBriefWorkspace(consultor, campaignId);
    expect(comoConsultor.ok).toBe(true);
    if (!comoConsultor.ok) return;
    expect(comoConsultor.value.version?.status).toBe('internal_review');
    expect(comoConsultor.value.allowedActions.some((a) => a.to === 'client_review')).toBe(false);
    expect(comoConsultor.value.nextResponsibleRole).toBe('director');

    const comoDirector = await obtenerBriefWorkspace(director, campaignId);
    expect(comoDirector.ok).toBe(true);
    if (!comoDirector.ok) return;
    expect(comoDirector.value.allowedActions.some((a) => a.to === 'client_review')).toBe(true);
  });

  it('el cliente nunca recibe eventos de comentarios internos en activity (caso 12)', async () => {
    const campaignId = await nuevaCampanaPropia('cliente-sin-comentarios');
    const creado = await crearBriefManual(admin, campaignId);
    if (!creado.ok) throw new Error(creado.error.message);
    const [campo] = await query<{ key: string }>(
      `SELECT key FROM brief_fields WHERE brief_version_id = $1 AND campaign_product_id IS NULL LIMIT 1`,
      [creado.value.versionId],
    );
    const comentario = await crearComentario(admin, creado.value.versionId, {
      fieldKey: campo!.key,
      content: 'Comentario interno — nunca debe llegar al cliente.',
    });
    expect(comentario.ok).toBe(true);

    await completarHastaInternalReview(creado.value.versionId, campaignId);
    const aprobado = await aprobarInternamente(director, creado.value.versionId);
    expect(aprobado.ok).toBe(true);

    const resultado = await obtenerBriefWorkspace(cliente, campaignId);
    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.value.version?.status).toBe('client_review');
    expect(resultado.value.activity.some((a) => a.entityType === 'field_comment')).toBe(false);
    expect(resultado.value.nextResponsibleRole).toBe('cliente');
  });

  it('aislamiento: un actor de otra organización recibe RESOURCE_NOT_FOUND (caso 13)', async () => {
    const campaignId = await nuevaCampanaPropia('aislamiento');
    const resultado = await obtenerBriefWorkspace(ajeno, campaignId);
    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.error.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('una versión aprobada no es editable (caso 14)', async () => {
    const campaignId = await nuevaCampanaPropia('aprobado-inmutable');
    const creado = await crearBriefManual(admin, campaignId);
    if (!creado.ok) throw new Error(creado.error.message);
    await completarHastaInternalReview(creado.value.versionId, campaignId);
    const internamente = await aprobarInternamente(director, creado.value.versionId);
    expect(internamente.ok).toBe(true);
    const clienteAprueba = await aprobarComoCliente(cliente, creado.value.versionId);
    expect(clienteAprueba.ok).toBe(true);

    const resultado = await obtenerBriefWorkspace(admin, campaignId);
    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(resultado.value.version?.status).toBe('approved');
    expect(resultado.value.version?.editable).toBe(false);
    expect(resultado.value.allowedActions.some((a) => a.to === 'internal_review')).toBe(false);
  });
});
