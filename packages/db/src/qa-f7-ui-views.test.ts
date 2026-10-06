/**
 * V2 · Fase 7 — QA adversarial de la capa web (U6): la lógica de acceso DENTRO de `contenido-views.ts`.
 *
 * Ataca las consultas de presentación (no la página): el DTO del Operativo no debe llevar nada de Cuenta; los
 * roles sin capacidad y otra organización reciben «no existe»; el cerco por campaña y participación se
 * aplica en la consulta; `versionNumber` extremo no revienta; las propuestas de otra campaña no se mezclan;
 * y los límites (200 entregables, 200 versiones, 200 comentarios) no truncan EN SILENCIO.
 *
 * Lo ROTO queda como `it.fails(...)` («QA-F7-UI-xx abierto»): la suite sigue verde y, cuando se corrija,
 * la prueba pasará a fallar y habrá que quitarle `.fails`. Datos sintéticos; base `_test` (candado de
 * `vitest.setup.ts`).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getPool, query } from './client.ts';
import { crearComentarioDeRevision } from './script-review.ts';
import { crearEntregable } from './deliverables.ts';
import { listarContenidoDeCampana, obtenerDeliverableConVersiones } from './contenido-views.ts';
import { proponerAccion } from './proposed-actions.ts';
import { registrarVersionDeGuion } from './script-versions.ts';
import {
  type EscenarioDeAprobacion,
  aprobarDirecto,
  crearEscenarioDeAprobacion,
  entregableNuevo,
  revisarComoHumano,
  valor,
  versionNueva,
} from './script-approval-test-support.ts';
import {
  asegurarUsuarioDePrueba,
  crearFuenteDeGuionConTexto,
  limpiarEscenarioDeContenido,
} from './test-utils.ts';

let a: EscenarioDeAprobacion;
/** Pieza con V1 (aprobada, reemplazada), V2 (aprobada vigente) y V3 (recibida) + un comentario en V3. */
let pieza: { deliverableId: string; v1: string; v2: string; v3: string };

beforeAll(async () => {
  a = await crearEscenarioDeAprobacion('F7 QA UI views');
  const { e } = a;
  const deliverableId = await entregableNuevo(e, 'Historial');
  const v1 = await versionNueva(e, deliverableId);
  await revisarComoHumano(v1, e.consultor);
  expect((await aprobarDirecto(e.director, v1)).ok).toBe(true);
  const v2 = await versionNueva(e, deliverableId);
  await revisarComoHumano(v2, e.consultor);
  expect((await aprobarDirecto(e.director, v2)).ok).toBe(true);
  const v3 = await versionNueva(e, deliverableId);
  valor(
    await crearComentarioDeRevision(
      e.consultor,
      v3,
      { kind: 'editorial', body: 'COMENTARIO-INTERNO-QA' },
      { origin: 'ui' },
      { campaignId: e.campanaId },
    ),
  );
  pieza = { deliverableId, v1, v2, v3 };
});

afterAll(async () => {
  await limpiarEscenarioDeContenido(a.e);
  await closePool();
});

const alcance = () => ({ campaignId: a.e.campanaId });
const participacion = () => a.e.participaciones.diego;
const codigoDe = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? undefined : r.error?.code);

// ─────────────────────────── Operativo: DTO reducido ───────────────────────────

describe('U6 · el Operativo recibe solo estado', () => {
  it('detalle: el DTO no lleva ids de versión ni de fuente, hashes, comentarios, hallazgos, autores ni propuestas', async () => {
    const r = await obtenerDeliverableConVersiones(a.e.operativo, pieza.deliverableId, {
      alcance: alcance(),
      participacionId: participacion(),
      versionNumber: 1,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.proyeccion).toBe('estado');
    const json = JSON.stringify(r.value);
    const fuentes = await query<{
      id: string;
      source_document_id: string;
      source_filename: string;
      source_hash: string;
    }>(
      `SELECT id, source_document_id, source_filename, source_hash FROM script_versions WHERE deliverable_id = $1 ORDER BY version`,
      [pieza.deliverableId],
    );
    for (const f of fuentes) {
      expect(json).not.toContain(f.id);
      expect(json).not.toContain(f.source_document_id);
      expect(json).not.toContain(f.source_hash);
    }
    // Solo el nombre de archivo de la aprobada vigente (V2) es visible; el de V1 y V3 no.
    const [v1, v2, v3] = fuentes.map((f) => f.source_filename);
    expect(json).toContain(v2!);
    if (v1 !== v2) expect(json).not.toContain(v1!);
    if (v3 !== v2) expect(json).not.toContain(v3!);
    for (const prohibido of [
      'COMENTARIO-INTERNO-QA',
      'huella',
      'hallazgos',
      'comentarios',
      'versiones',
      'sourceId',
      'propuesta',
      'evaluacion',
      '"revision"',
      a.e.consultor.name,
      a.e.director.name,
    ]) {
      expect(json, prohibido).not.toContain(prohibido);
    }
    expect(Object.keys(r.value).sort()).toEqual(
      [
        'aprobadaVigente',
        'estado',
        'id',
        'nombre',
        'participacion',
        'plataforma',
        'proyeccion',
        'resumen',
        'ultima',
      ].sort(),
    );
  });

  it('lista: sin versiones intermedias, revisión ni número de versiones', async () => {
    const r = await listarContenidoDeCampana(a.e.operativo, a.e.campanaId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.proyeccion).toBe('estado');
    expect(r.value.briefRector).toBeUndefined();
    for (const p of r.value.participaciones) {
      for (const e of p.entregables) {
        expect(e.revision).toBeUndefined();
        expect(e.versiones).toBeUndefined();
        expect(e.ultimaVersion?.fecha).toBeUndefined();
      }
    }
    expect(JSON.stringify(r.value)).not.toContain('COMENTARIO-INTERNO-QA');
  });
});

// ─────────────────────────── Roles sin capacidad y otra organización ───────────

describe('U6 · «no existe» para quien no debe saber', () => {
  it.each(['analista', 'legal', 'cliente', 'ajeno'] as const)(
    '%s: lista y detalle dan RESOURCE_NOT_FOUND',
    async (rol) => {
      const actor = a.e[rol];
      const lista = await listarContenidoDeCampana(actor, a.e.campanaId);
      expect(codigoDe(lista)).toBe('RESOURCE_NOT_FOUND');
      const det = await obtenerDeliverableConVersiones(actor, pieza.deliverableId, { alcance: alcance() });
      expect(codigoDe(det)).toBe('RESOURCE_NOT_FOUND');
      // El mensaje no distingue «no existe» de «no autorizado»: es el mismo que con un id inexistente.
      const inexistente = await obtenerDeliverableConVersiones(
        actor,
        '00000000-0000-4000-8000-000000000000',
        {
          alcance: alcance(),
        },
      );
      expect(JSON.stringify(det)).toBe(JSON.stringify(inexistente));
    },
  );

  it('un Operativo de OTRA organización no se cuela aunque tenga el rol: su organización no es la de la campaña', async () => {
    const ajenoOperativo = await asegurarUsuarioDePrueba(
      `qa-f7-ui-operativo-ajeno@otraagencia.co`,
      'Operativo ajeno',
      'operativo',
      a.e.ajeno.organizationId,
    );
    const lista = await listarContenidoDeCampana(ajenoOperativo, a.e.campanaId);
    expect(codigoDe(lista)).toBe('RESOURCE_NOT_FOUND');
    const det = await obtenerDeliverableConVersiones(ajenoOperativo, pieza.deliverableId, {
      alcance: alcance(),
    });
    expect(codigoDe(det)).toBe('RESOURCE_NOT_FOUND');
  });

  it('ids mal formados o inexistentes: «no existe», sin excepción de la base', async () => {
    for (const mal of ['', 'x', "' OR 1=1 --", '00000000-0000-0000-0000-000000000000', 'A'.repeat(5000)]) {
      expect(codigoDe(await listarContenidoDeCampana(a.e.consultor, mal))).toBe('RESOURCE_NOT_FOUND');
      expect(codigoDe(await obtenerDeliverableConVersiones(a.e.consultor, mal, { alcance: alcance() }))).toBe(
        'RESOURCE_NOT_FOUND',
      );
      expect(
        codigoDe(
          await obtenerDeliverableConVersiones(a.e.consultor, pieza.deliverableId, {
            alcance: { campaignId: mal },
          }),
        ),
      ).toBe('RESOURCE_NOT_FOUND');
      expect(
        codigoDe(
          await obtenerDeliverableConVersiones(a.e.consultor, pieza.deliverableId, {
            alcance: alcance(),
            participacionId: mal,
          }),
        ),
      ).toBe('RESOURCE_NOT_FOUND');
    }
  });
});

// ─────────────────────────── Alcance cruzado ───────────────────────────────────

describe('U6 · el cerco de campaña y participación se aplica en la consulta', () => {
  it('la pieza con el alcance de OTRA campaña (misma organización) es «no existe»', async () => {
    const r = await obtenerDeliverableConVersiones(a.e.consultor, pieza.deliverableId, {
      alcance: { campaignId: a.e.otraCampanaId },
    });
    expect(codigoDe(r)).toBe('RESOURCE_NOT_FOUND');
  });

  it('la pieza con la participación de OTRO influencer es «no existe»', async () => {
    const r = await obtenerDeliverableConVersiones(a.e.consultor, pieza.deliverableId, {
      alcance: alcance(),
      participacionId: a.e.participaciones.valentinaRios,
    });
    expect(codigoDe(r)).toBe('RESOURCE_NOT_FOUND');
  });

  it('la lista de una campaña no trae entregables de otra', async () => {
    const r = await listarContenidoDeCampana(a.e.consultor, a.e.otraCampanaId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.participaciones.flatMap((p) => p.entregables.map((e) => e.id));
    expect(ids).not.toContain(pieza.deliverableId);
    expect(r.value.totales.entregablesActivos).toBe(0);
  });

  it('el admin de OTRA agencia, con el id de una pieza ajena, no la ve aunque indique SU campaña', async () => {
    const r = await obtenerDeliverableConVersiones(a.e.ajeno, pieza.deliverableId, {
      alcance: { campaignId: a.e.campanaAjenaId },
    });
    expect(codigoDe(r)).toBe('RESOURCE_NOT_FOUND');
  });
});

// ─────────────────────────── versionNumber extremo ─────────────────────────────

describe('U6 · versionNumber extremo', () => {
  it.each([0, -1, 4, 999_999, 2 ** 31, Number.MAX_SAFE_INTEGER, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'versionNumber=%s: «no existe», sin excepción',
    async (n) => {
      const r = await obtenerDeliverableConVersiones(a.e.consultor, pieza.deliverableId, {
        alcance: alcance(),
        versionNumber: n,
      });
      expect(codigoDe(r)).toBe('RESOURCE_NOT_FOUND');
    },
  );

  it('versionNumber válido: devuelve la versión pedida con las insignias correctas (V1 reemplazada, V2 vigente, V3 última)', async () => {
    const leer = async (n: number) => {
      const r = await obtenerDeliverableConVersiones(a.e.consultor, pieza.deliverableId, {
        alcance: alcance(),
        versionNumber: n,
      });
      expect(r.ok).toBe(true);
      if (!r.ok || r.value.proyeccion !== 'cuenta') throw new Error('proyección inesperada');
      return r.value;
    };
    const d1 = await leer(1);
    expect(d1.version).toMatchObject({
      numero: 1,
      esUltima: false,
      esAprobadaVigente: false,
      aprobadaAlgunaVez: true,
      reemplazadaPor: 2,
    });
    const d2 = await leer(2);
    expect(d2.version).toMatchObject({
      numero: 2,
      esUltima: false,
      esAprobadaVigente: true,
      aprobadaAlgunaVez: true,
    });
    const d3 = await leer(3);
    expect(d3.version).toMatchObject({
      numero: 3,
      esUltima: true,
      esAprobadaVigente: false,
      aprobadaAlgunaVez: false,
    });
    // El historial es el mismo sea cual sea la versión elegida y trae UNA sola aprobada vigente.
    expect(d3.versiones.map((v) => v.numero)).toEqual([3, 2, 1]);
    expect(d3.versiones.filter((v) => v.esAprobadaVigente).map((v) => v.numero)).toEqual([2]);
    expect(d3.versiones.filter((v) => v.esUltima).map((v) => v.numero)).toEqual([3]);
  });
});

// ─────────────────────────── Propuestas y autores ──────────────────────────────

describe('U6 · propuestas de aprobación y autores', () => {
  it('la propuesta abierta de UNA versión no aparece en otra versión ni en el DTO de otra campaña', async () => {
    const e = a.e;
    const deliverableId = await entregableNuevo(e, 'Propuesta');
    const versionId = await versionNueva(e, deliverableId);
    await revisarComoHumano(versionId, e.consultor);
    valor(
      await proponerAccion(e.consultor, {
        type: 'script_version.approve',
        resourceId: versionId,
        origin: 'chat',
        campaignId: e.campanaId,
      }),
    );
    const con = await obtenerDeliverableConVersiones(e.consultor, deliverableId, { alcance: alcance() });
    expect(con.ok && con.value.proyeccion === 'cuenta' && con.value.version?.propuestaDeAprobacion.hay).toBe(
      true,
    );
    // Otra pieza (la del historial) sigue sin propuesta.
    const sin = await obtenerDeliverableConVersiones(e.consultor, pieza.deliverableId, {
      alcance: alcance(),
    });
    expect(sin.ok && sin.value.proyeccion === 'cuenta' && sin.value.version?.propuestaDeAprobacion.hay).toBe(
      false,
    );
    // El Operativo no recibe la propuesta (ni siquiera «hay»).
    const op = await obtenerDeliverableConVersiones(e.operativo, deliverableId, { alcance: alcance() });
    expect(JSON.stringify(op)).not.toContain('propuestaDeAprobacion');
    expect(JSON.stringify(op)).not.toContain('script_version.approve');
  });

  it('los autores se resuelven con el filtro de organización (FK compuesta a users(id, organization_id))', async () => {
    const { rows } = await getPool().query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'script_versions'::regclass AND contype = 'f' AND pg_get_constraintdef(oid) LIKE '%users%'`,
    );
    expect(rows.some((r) => /organization_id/.test(r.def))).toBe(true);
    const r = await obtenerDeliverableConVersiones(a.e.consultor, pieza.deliverableId, {
      alcance: alcance(),
    });
    expect(r.ok && r.value.proyeccion === 'cuenta' && r.value.version?.creadaPor).toBe(a.e.consultor.name);
  });
});

// ─────────────────────────── Límites: no truncar en silencio ───────────────────

describe('U6 · límites y abuso de recursos', () => {
  it('muchas versiones y comentarios: el detalle responde en tiempo razonable (sin N+1 por versión)', async () => {
    const e = a.e;
    const deliverableId = await entregableNuevo(e, 'Carga');
    let ultima = '';
    for (let i = 0; i < 40; i += 1) ultima = await versionNueva(e, deliverableId);
    for (let i = 0; i < 40; i += 1) {
      valor(
        await crearComentarioDeRevision(
          e.consultor,
          ultima,
          { kind: 'editorial', body: `Comentario de carga ${i} ${'x'.repeat(200)}` },
          { origin: 'ui' },
          { campaignId: e.campanaId },
        ),
      );
    }
    const t0 = Date.now();
    const r = await obtenerDeliverableConVersiones(e.consultor, deliverableId, { alcance: alcance() });
    const ms = Date.now() - t0;
    expect(r.ok && r.value.proyeccion === 'cuenta' && r.value.versiones.length).toBe(40);
    expect(ms).toBeLessThan(3000);
  }, 120_000);

  it('190 piezas con versión (casi el tope de la lista): la lista responde en tiempo razonable (sin consultas por pieza que escalen mal)', async () => {
    const e = a.e;
    for (let i = 0; i < 150; i += 1) {
      const d = valor(
        await crearEntregable(e.consultor, {
          campaignInfluencerId: e.participaciones.diego,
          label: `Carga lista ${i} ${e.sufijo}`,
        }),
      );
      const fuente = await crearFuenteDeGuionConTexto(e.campanaId, e.admin, `carga-${i}-${e.sufijo}`, [
        `Texto ${i} ${Math.random()}`,
      ]);
      valor(
        await registrarVersionDeGuion(e.consultor, {
          campaignId: e.campanaId,
          sourceId: fuente,
          participation: { participationId: e.participaciones.diego },
          deliverable: { id: d.id },
        }),
      );
    }
    const t0 = Date.now();
    const cuenta = await listarContenidoDeCampana(e.consultor, e.campanaId);
    const msCuenta = Date.now() - t0;
    const t1 = Date.now();
    const operativo = await listarContenidoDeCampana(e.operativo, e.campanaId);
    const msOperativo = Date.now() - t1;
    expect(cuenta.ok && operativo.ok).toBe(true);
    expect(msCuenta).toBeLessThan(3000);
    expect(msOperativo).toBeLessThan(3000);
  }, 180_000);

  it('QA-F7-UI-02 (corregido): con más de 200 entregables la lista NO trunca en silencio (totales y participaciones correctos)', async () => {
    const e = a.e;
    // 205 entregables activos en UNA participación (Valentina Gómez, sin entregables sembrados salvo uno).
    for (let i = 0; i < 205; i += 1) {
      valor(
        await crearEntregable(e.consultor, {
          campaignInfluencerId: e.participaciones.valentinaGomez,
          label: `Pieza masiva ${i} ${e.sufijo}`,
        }),
      );
    }
    const r = await listarContenidoDeCampana(e.consultor, e.campanaId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const real = Number(
      (
        await query<{ n: string }>(
          `SELECT count(*)::text n FROM deliverables WHERE campaign_id = $1 AND status = 'active'`,
          [e.campanaId],
        )
      )[0]!.n,
    );
    expect(real).toBeGreaterThan(200);
    // Se pagina hasta agotar el total: los totales son los reales y cada participación trae sus piezas.
    expect(r.value.totales.entregablesActivos).toBe(real);
    expect(r.value.limiteDeEntregables).toBeUndefined();
    const nuevas = r.value.participaciones
      .flatMap((p) => p.entregables)
      .filter((x) => x.nombre.startsWith('Pieza masiva'));
    expect(nuevas).toHaveLength(205);
    expect(r.value.participaciones.reduce((n, p) => n + p.entregables.length, 0)).toBe(
      real +
        Number(
          (
            await query<{ n: string }>(
              `SELECT count(*)::text n FROM deliverables WHERE campaign_id = $1 AND status <> 'active'`,
              [e.campanaId],
            )
          )[0]!.n,
        ),
    );
    // Por participación: la misma carga, solo de esa influencer.
    const solo = await listarContenidoDeCampana(e.consultor, e.campanaId, {
      participacionId: e.participaciones.valentinaGomez,
    });
    expect(solo.ok && solo.value.participaciones.length).toBe(1);
    expect(solo.ok && solo.value.participaciones[0]!.entregables.length).toBeGreaterThanOrEqual(205);
  }, 180_000);

  it.fails(
    'QA-F7-UI-03 abierto: con más de 200 comentarios el detalle los muestra todos (o avisa que hay más)',
    async () => {
      const e = a.e;
      const deliverableId = await entregableNuevo(e, 'Comentarios masivos');
      const versionId = await versionNueva(e, deliverableId);
      for (let i = 0; i < 205; i += 1) {
        valor(
          await crearComentarioDeRevision(
            e.consultor,
            versionId,
            { kind: 'editorial', body: `Comentario ${i} ${e.sufijo}` },
            { origin: 'ui' },
            { campaignId: e.campanaId },
          ),
        );
      }
      const r = await obtenerDeliverableConVersiones(e.consultor, deliverableId, { alcance: alcance() });
      expect(r.ok && r.value.proyeccion === 'cuenta').toBe(true);
      if (!r.ok || r.value.proyeccion !== 'cuenta' || r.value.version === null) return;
      const mostrados = r.value.version.comentarios.length + r.value.version.cambiosSolicitados.length;
      // La evaluación de aprobación cuenta TODOS; la lista debe ser coherente con esa cifra.
      expect(mostrados).toBe(r.value.version.evaluacion?.comentarios ?? -1);
    },
    180_000,
  );

  it.fails(
    'QA-F7-UI-04 abierto: con más de 200 versiones el historial y ?v= alcanzan las más antiguas',
    async () => {
      const e = a.e;
      const deliverableId = await entregableNuevo(e, 'Versiones masivas');
      for (let i = 0; i < 205; i += 1) {
        const fuente = await crearFuenteDeGuionConTexto(e.campanaId, e.admin, `masiva-${i}-${e.sufijo}`, [
          `Texto ${i} ${Math.random()}`,
        ]);
        valor(
          await registrarVersionDeGuion(e.consultor, {
            campaignId: e.campanaId,
            sourceId: fuente,
            participation: { participationId: e.participaciones.diego },
            deliverable: { id: deliverableId },
          }),
        );
      }
      // La V1 existe: pedirla con ?v=1 debe funcionar.
      const r = await obtenerDeliverableConVersiones(e.consultor, deliverableId, {
        alcance: alcance(),
        versionNumber: 1,
      });
      expect(r.ok).toBe(true);
    },
    300_000,
  );
});
