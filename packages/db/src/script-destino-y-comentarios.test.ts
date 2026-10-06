/**
 * V2 · Fase 7 — endurecimiento tras el QA de la capa web:
 *   · `comprobarDestinoDeGuion` (QA-F7-UI-06): la comprobación previa y SIN efectos del destino de un guion
 *     (la misma resolución que el registro), para validar antes de guardar los bytes de un archivo;
 *   · comentarios con controles bidi/invisibles (QA-F7-UI-05): se rechazan sin alterar el texto; el unidor
 *     de ancho cero de los emojis y el salto de línea siguen siendo válidos.
 *
 * Datos sintéticos; base `_test` (candado de `vitest.setup.ts`).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, query } from './client.ts';
import { archivarEntregable } from './deliverables.ts';
import { crearComentarioDeRevision } from './script-review.ts';
import { comprobarDestinoDeGuion } from './script-versions.ts';
import {
  type EscenarioDeAprobacion,
  crearEscenarioDeAprobacion,
  entregableNuevo,
  valor,
  versionNueva,
} from './script-approval-test-support.ts';
import { limpiarEscenarioDeContenido } from './test-utils.ts';

let a: EscenarioDeAprobacion;
let versionId: string;

beforeAll(async () => {
  a = await crearEscenarioDeAprobacion('F7 destino y comentarios');
  const deliverableId = await entregableNuevo(a.e, 'Reel principal');
  versionId = await versionNueva(a.e, deliverableId);
});

afterAll(async () => {
  await limpiarEscenarioDeContenido(a.e);
  await closePool();
});

const contarEntregables = async () =>
  Number(
    (
      await query<{ n: string }>(`SELECT count(*)::text n FROM deliverables WHERE campaign_id = $1`, [
        a.e.campanaId,
      ])
    )[0]!.n,
  );

describe('comprobarDestinoDeGuion: la misma resolución del registro, sin efectos', () => {
  const destino = (participationId: string, deliverable: { id: string } | { label: string }) => ({
    campaignId: a.e.campanaId,
    participation: { participationId },
    deliverable,
  });

  it('etiqueta nueva y válida: ok, y NO crea el entregable', async () => {
    const antes = await contarEntregables();
    const r = await comprobarDestinoDeGuion(
      a.e.consultor,
      destino(a.e.participaciones.diego, { label: 'Story de cierre' }),
      { origin: 'ui' },
    );
    expect(r.ok && r.value.kind).toBe('ok');
    expect(await contarEntregables()).toBe(antes);
  });

  it('etiqueta parecida a una existente: needs_choice con candidatos y sin efecto', async () => {
    const antes = await contarEntregables();
    const r = await comprobarDestinoDeGuion(
      a.e.consultor,
      destino(a.e.participaciones.diego, { label: 'Reel principa' }),
      { origin: 'ui' },
    );
    expect(r.ok && r.value.kind).toBe('needs_choice');
    if (r.ok && r.value.kind === 'needs_choice') {
      expect(r.value.reason).toBe('deliverable_ambiguous');
      expect(r.value.candidates.length).toBeGreaterThanOrEqual(1);
    }
    expect(await contarEntregables()).toBe(antes);
  });

  it('etiqueta con controles invisibles: VALIDATION_FAILED', async () => {
    const r = await comprobarDestinoDeGuion(
      a.e.consultor,
      destino(a.e.participaciones.diego, { label: 'Reel‮x' }),
      { origin: 'ui' },
    );
    expect(!r.ok && r.error.code).toBe('VALIDATION_FAILED');
  });

  it('participación de OTRA campaña: RESOURCE_NOT_FOUND', async () => {
    const r = await comprobarDestinoDeGuion(
      a.e.consultor,
      { ...destino(a.e.participaciones.diego, { label: 'nuevo' }), campaignId: a.e.otraCampanaId },
      { origin: 'ui' },
    );
    expect(!r.ok && r.error.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('entregable archivado: RESOURCE_CONFLICT (deliverable_archived)', async () => {
    const id = await entregableNuevo(a.e, 'Para archivar');
    valor(await archivarEntregable(a.e.consultor, id));
    const r = await comprobarDestinoDeGuion(a.e.consultor, destino(a.e.participaciones.diego, { id }), {
      origin: 'ui',
    });
    expect(!r.ok && r.error.code).toBe('RESOURCE_CONFLICT');
  });

  it('roles sin script:manage (operativo, cliente) y otra organización: no pasan', async () => {
    for (const rol of ['operativo', 'cliente', 'ajeno'] as const) {
      const r = await comprobarDestinoDeGuion(a.e[rol], destino(a.e.participaciones.diego, { label: 'x' }), {
        origin: 'ui',
      });
      expect(r.ok, rol).toBe(false);
    }
  });
});

describe('comentarios: controles bidi e invisibles', () => {
  const comentar = (body: string) =>
    crearComentarioDeRevision(
      a.e.consultor,
      versionId,
      { kind: 'editorial', body },
      { origin: 'ui' },
      { campaignId: a.e.campanaId },
    );

  it.each([
    ['RLO U+202E', 'Aprobado‮ dobarpA'],
    ['ZWSP U+200B', 'Apro​bado'],
    ['LRM U+200E', 'nota‎'],
    ['aislamiento U+2066', '⁦nota'],
    ['BOM interior U+FEFF', 'a﻿b'],
    ['NUL', 'a\u0000b'],
  ])('%s: VALIDATION_FAILED y no se guarda nada', async (_nombre, body) => {
    const antes = Number(
      (
        await query<{ n: string }>(
          `SELECT count(*)::text n FROM script_review_comments WHERE script_version_id = $1`,
          [versionId],
        )
      )[0]!.n,
    );
    const r = await comentar(body);
    expect(!r.ok && r.error.code).toBe('VALIDATION_FAILED');
    const despues = Number(
      (
        await query<{ n: string }>(
          `SELECT count(*)::text n FROM script_review_comments WHERE script_version_id = $1`,
          [versionId],
        )
      )[0]!.n,
    );
    expect(despues).toBe(antes);
  });

  it('un emoji compuesto (unidor U+200D), acentos y saltos de línea siguen siendo válidos y se guardan tal cual', async () => {
    const body = 'Buen ritmo 👩‍💻\nRevisar «animación» en la escena 2';
    const r = await comentar(body);
    expect(r.ok).toBe(true);
    const [fila] = await query<{ body: string }>(
      `SELECT body FROM script_review_comments WHERE script_version_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [versionId],
    );
    expect(fila!.body).toBe(body);
  });
});
