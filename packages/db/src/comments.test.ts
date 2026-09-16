/**
 * Sprint 5, Fase B — comentarios internos por campo (E7-6, DEC-031).
 *
 * Nunca visibles para el rol `cliente` — ni abiertos ni resueltos, decisión
 * explícita del product owner. Anclados a `(brief_version_id, field_key)`,
 * no a `brief_fields.id`, para que sobrevivan a una versión hija (Fase E).
 *
 * Campaña propia y desechable (INC-001A) — nunca P80 ni el seed compartido.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { User } from '@tcl-kol-os/domain';
import { closePool, query } from './client.ts';
import { eliminarCampanaDePrueba } from './test-utils.ts';
import { crearBriefManual } from './manual.ts';
import {
  contarConversacionesAbiertas,
  crearComentario,
  listarComentarios,
  reabrirComentario,
  resolverComentario,
} from './comments.ts';

let orgId: string;
let userId: string;
let admin: User;
let cliente: User;
let campanaA: string;
let campanaB: string;
let versionA: string;
let versionB: string;
const CLAVE = 'contexto.situacion';

beforeAll(async () => {
  const [filaAdmin] = await query<{ id: string; organization_id: string }>(
    `SELECT id, organization_id FROM users WHERE email = 'gerardo@smartpr.co'`,
  );
  userId = filaAdmin!.id;
  orgId = filaAdmin!.organization_id;
  admin = {
    id: userId,
    email: 'gerardo@smartpr.co',
    name: 'Gerardo',
    organizationId: orgId,
    role: 'admin',
    status: 'activo',
  };

  const [filaCliente] = await query<{ id: string; organization_id: string }>(
    `SELECT id, organization_id FROM users WHERE email = 'marena@tcl.com'`,
  );
  cliente = {
    id: filaCliente!.id,
    email: 'marena@tcl.com',
    name: 'Marena',
    organizationId: filaCliente!.organization_id,
    role: 'cliente',
    status: 'activo',
  };

  const campanaFilaA = await query<{ id: string }>(
    `INSERT INTO campaigns (organization_id, name, owner_id, created_by) VALUES ($1, $2, $3, $3) RETURNING id`,
    [orgId, `Comentarios A · ${Date.now()}`, userId],
  );
  campanaA = campanaFilaA[0]!.id;
  const creadoA = await crearBriefManual(admin, campanaA);
  if (!creadoA.ok) throw new Error('setup A');
  versionA = creadoA.value.versionId;

  const campanaFilaB = await query<{ id: string }>(
    `INSERT INTO campaigns (organization_id, name, owner_id, created_by) VALUES ($1, $2, $3, $3) RETURNING id`,
    [orgId, `Comentarios B · ${Date.now()}`, userId],
  );
  campanaB = campanaFilaB[0]!.id;
  const creadoB = await crearBriefManual(admin, campanaB);
  if (!creadoB.ok) throw new Error('setup B');
  versionB = creadoB.value.versionId;
});

afterAll(async () => {
  await eliminarCampanaDePrueba([campanaA, campanaB]);
  await closePool();
});

describe('crear un comentario', () => {
  it('rechaza contenido vacío', async () => {
    const resultado = await crearComentario(admin, versionA, { fieldKey: CLAVE, content: '   ' });
    expect(resultado.ok).toBe(false);
  });

  it('el cliente no puede crear comentarios internos', async () => {
    const resultado = await crearComentario(cliente, versionA, {
      fieldKey: CLAVE,
      content: 'Intento del cliente',
    });
    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.error.code).toBe('FORBIDDEN_ROLE');
  });

  it('crea el comentario raíz', async () => {
    const resultado = await crearComentario(admin, versionA, {
      fieldKey: CLAVE,
      content: '¿Esto viene confirmado por el cliente?',
    });
    expect(resultado.ok, !resultado.ok ? resultado.error.message : '').toBe(true);

    const lista = await listarComentarios(admin, versionA, CLAVE);
    expect(lista.ok).toBe(true);
    if (!lista.ok) return;
    expect(lista.value).toHaveLength(1);
    expect(lista.value[0]!.status).toBe('abierto');
    expect(lista.value[0]!.authorName).toBe('Gerardo Calambás');
  });
});

describe('responder en el mismo hilo', () => {
  it('la respuesta queda anclada al comentario raíz', async () => {
    const raiz = await crearComentario(admin, versionB, { fieldKey: CLAVE, content: 'Pregunta inicial.' });
    if (!raiz.ok) throw new Error('setup');

    const respuesta = await crearComentario(admin, versionB, {
      fieldKey: CLAVE,
      content: 'Sí, ya está confirmado.',
      parentCommentId: raiz.value.id,
    });
    expect(respuesta.ok, !respuesta.ok ? respuesta.error.message : '').toBe(true);

    const lista = await listarComentarios(admin, versionB, CLAVE);
    if (!lista.ok) throw new Error('setup');
    expect(lista.value).toHaveLength(2);
    const hija = lista.value.find((c) => c.id !== raiz.value.id);
    expect(hija?.parentCommentId).toBe(raiz.value.id);
  });

  it('rechaza responder a un comentario de otro campo', async () => {
    const raiz = await crearComentario(admin, versionB, { fieldKey: CLAVE, content: 'Otro hilo.' });
    if (!raiz.ok) throw new Error('setup');
    const resultado = await crearComentario(admin, versionB, {
      fieldKey: 'objetivo.tipo',
      content: 'Respuesta cruzada, inválida.',
      parentCommentId: raiz.value.id,
    });
    expect(resultado.ok).toBe(false);
  });
});

describe('resolver y reabrir', () => {
  it('resuelve un comentario, registra quién y cuándo', async () => {
    const raiz = await crearComentario(admin, versionA, {
      fieldKey: 'objetivo.tipo',
      content: 'Falta precisar.',
    });
    if (!raiz.ok) throw new Error('setup');

    const resuelto = await resolverComentario(admin, versionA, raiz.value.id);
    expect(resuelto.ok, !resuelto.ok ? resuelto.error.message : '').toBe(true);

    const lista = await listarComentarios(admin, versionA, 'objetivo.tipo');
    if (!lista.ok) throw new Error('setup');
    const fila = lista.value.find((c) => c.id === raiz.value.id);
    expect(fila?.status).toBe('resuelto');
    expect(fila?.resolvedByName).toBe('Gerardo Calambás');
    expect(fila?.resolvedAt).toBeDefined();
  });

  it('reabre un comentario resuelto', async () => {
    const raiz = await crearComentario(admin, versionA, {
      fieldKey: 'accion_kpis.accion_esperada',
      content: 'Revisar de nuevo.',
    });
    if (!raiz.ok) throw new Error('setup');
    await resolverComentario(admin, versionA, raiz.value.id);

    const reabierto = await reabrirComentario(admin, versionA, raiz.value.id);
    expect(reabierto.ok).toBe(true);

    const lista = await listarComentarios(admin, versionA, 'accion_kpis.accion_esperada');
    if (!lista.ok) throw new Error('setup');
    const fila = lista.value.find((c) => c.id === raiz.value.id);
    expect(fila?.status).toBe('abierto');
    expect(fila?.resolvedBy).toBeUndefined();
  });
});

describe('contador de conversaciones abiertas', () => {
  it('cuenta solo hilos raíz abiertos, agrupados por campo', async () => {
    const c1 = await crearComentario(admin, versionB, {
      fieldKey: 'entregable_creativo.alcance',
      content: 'Uno.',
    });
    const c2 = await crearComentario(admin, versionB, {
      fieldKey: 'entregable_creativo.alcance',
      content: 'Dos.',
    });
    const c3 = await crearComentario(admin, versionB, {
      fieldKey: 'entregable_creativo.desafio_creativo',
      content: 'Tres.',
    });
    if (!c1.ok || !c2.ok || !c3.ok) throw new Error('setup');
    await resolverComentario(admin, versionB, c1.value.id);

    const conteo = await contarConversacionesAbiertas(admin, versionB);
    expect(conteo.ok).toBe(true);
    if (!conteo.ok) return;
    expect(conteo.value['entregable_creativo.alcance']).toBe(1); // c2 sigue abierto
    expect(conteo.value['entregable_creativo.desafio_creativo']).toBe(1);
  });
});

describe('el cliente nunca ve comentarios internos', () => {
  it('listarComentarios rechaza al cliente aunque el comentario ya esté resuelto', async () => {
    const raiz = await crearComentario(admin, versionA, {
      fieldKey: 'contexto.contexto_global',
      content: 'Interno.',
    });
    if (!raiz.ok) throw new Error('setup');
    await resolverComentario(admin, versionA, raiz.value.id);

    const resultado = await listarComentarios(cliente, versionA, 'contexto.contexto_global');
    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.error.code).toBe('FORBIDDEN_ROLE');
  });

  it('el cliente no puede resolver ni reabrir', async () => {
    const raiz = await crearComentario(admin, versionA, { fieldKey: 'contexto.categoria', content: 'x' });
    if (!raiz.ok) throw new Error('setup');
    expect((await resolverComentario(cliente, versionA, raiz.value.id)).ok).toBe(false);
    expect((await reabrirComentario(cliente, versionA, raiz.value.id)).ok).toBe(false);
  });
});

describe('aislamiento entre organizaciones', () => {
  it('no se puede comentar una versión de otra organización', async () => {
    const [versionAjena] = await query<{ id: string }>(
      `SELECT id FROM brief_versions WHERE organization_id <> $1 LIMIT 1`,
      [orgId],
    );
    if (!versionAjena) return; // sin material de otra organización, nada que probar
    const resultado = await crearComentario(admin, versionAjena.id, {
      fieldKey: CLAVE,
      content: 'Intento cruzado',
    });
    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.error.code).toBe('RESOURCE_NOT_FOUND');
  });
});
