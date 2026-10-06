/**
 * V2 · Fase 7 — lecturas de presentación del contenido (`contenido-views.ts`), contra PostgreSQL real.
 *
 * Cubre lo que la interfaz necesita y las reglas de acceso DENTRO de la consulta:
 *   · Cuenta recibe el DTO completo; el Operativo, el reducido (sin versiones intermedias, hallazgos,
 *     comentarios, archivo, ids de fuente ni propuesta); cliente, otra agencia y roles sin la capacidad,
 *     `RESOURCE_NOT_FOUND`.
 *   · Banderas `esUltima` / `esAprobadaVigente` y «reemplazada por Vn» con V1, V2 y V3 aprobadas y V4 última.
 *   · Hallazgos del Brief y comentarios de SmartPR en listas distintas, con `origen` distinto.
 *   · Vigencia STALE al aprobar un Brief nuevo; evaluación de aprobación; propuesta pendiente.
 * Todo sobre campañas, influencers y fuentes sintéticos y desechables (INC-001A).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { User } from '@tcl-kol-os/domain';
import { closePool } from './client.ts';
import { registrarRevisionHumana } from './content-analysis.ts';
import { crearComentarioDeRevision, solicitarCambiosDeScript } from './script-review.ts';
import {
  type EscenarioDeAprobacion,
  aprobarDirecto,
  crearEscenarioDeAprobacion,
  entregableNuevo,
  otraVersionRevisada,
  proponerAprobacion,
  revisarComoHumano,
  revisarConIA,
  valor,
  versionNueva,
  versionRevisada,
} from './script-approval-test-support.ts';
import {
  type VistaDeDeliverable,
  type VistaDeDeliverableDeCuenta,
  type VistaDeDeliverableDeEstado,
  listarContenidoDeCampana,
  obtenerDeliverableConVersiones,
} from './contenido-views.ts';
import {
  crearBriefHijoDePrueba,
  crearEscenarioDeContenido,
  limpiarEscenarioDeContenido,
} from './test-utils.ts';
import type { EscenarioDeContenido } from './test-utils.ts';

let a: EscenarioDeAprobacion;
/** Escenario aparte: su Brief rector cambia (vigencia STALE). */
let b: EscenarioDeAprobacion;
/** Escenario sin Brief aprobado. */
let sinBrief: EscenarioDeContenido;

beforeAll(async () => {
  a = await crearEscenarioDeAprobacion('F7 vistas');
  b = await crearEscenarioDeAprobacion('F7 vistas brief');
  sinBrief = await crearEscenarioDeContenido('F7 vistas sin brief');
});

afterAll(async () => {
  await limpiarEscenarioDeContenido(a.e);
  await limpiarEscenarioDeContenido(b.e);
  await limpiarEscenarioDeContenido(sinBrief);
  await closePool();
});

const detalle = async (
  e: EscenarioDeContenido,
  actor: User,
  deliverableId: string,
  versionNumber?: number,
): Promise<VistaDeDeliverable> =>
  valor(
    await obtenerDeliverableConVersiones(actor, deliverableId, {
      alcance: { campaignId: e.campanaId },
      versionNumber,
    }),
  );

const cuenta = async (
  e: EscenarioDeContenido,
  actor: User,
  deliverableId: string,
  versionNumber?: number,
): Promise<VistaDeDeliverableDeCuenta> => {
  const v = await detalle(e, actor, deliverableId, versionNumber);
  if (v.proyeccion !== 'cuenta') throw new Error('se esperaba la proyección de Cuenta');
  return v;
};

/** Entregable con V1, V2 y V3 aprobadas en cadena (cada una reemplaza a la anterior) y V4 en revisión. */
async function entregableConCuatroVersiones(e: EscenarioDeContenido) {
  const deliverableId = await entregableNuevo(e, 'Cadena');
  const v1 = await versionNueva(e, deliverableId);
  await revisarComoHumano(v1, e.consultor);
  valor(await aprobarDirecto(e.director, v1));
  const v2 = (await otraVersionRevisada(e, deliverableId)).versionId;
  valor(await aprobarDirecto(e.director, v2));
  const v3 = (await otraVersionRevisada(e, deliverableId)).versionId;
  valor(await aprobarDirecto(e.admin, v3));
  const v4 = (await otraVersionRevisada(e, deliverableId)).versionId;
  return { deliverableId, v1, v2, v3, v4 };
}

describe('Historial: banderas de última, aprobada vigente y reemplazo', () => {
  it('V1, V2 y V3 aprobadas y V4 última: solo V3 es la vigente y V1/V2 dicen quién las reemplazó', async () => {
    const e = a.e;
    const { deliverableId, v3, v4 } = await entregableConCuatroVersiones(e);
    const vista = await cuenta(e, e.consultor, deliverableId);

    expect(vista.versiones.map((v) => v.numero)).toEqual([4, 3, 2, 1]);
    const porNumero = new Map(vista.versiones.map((v) => [v.numero, v]));
    expect(vista.versiones.filter((v) => v.esUltima).map((v) => v.numero)).toEqual([4]);
    expect(vista.versiones.filter((v) => v.esAprobadaVigente).map((v) => v.numero)).toEqual([3]);

    // V4: la última, abierta, nunca aprobada.
    expect(porNumero.get(4)).toMatchObject({
      id: v4,
      estado: 'in_review',
      esUltima: true,
      esAprobadaVigente: false,
      aprobadaAlgunaVez: false,
      reemplazadaPor: undefined,
    });
    // V3: la vigente.
    expect(porNumero.get(3)).toMatchObject({
      id: v3,
      estado: 'approved',
      esUltima: false,
      esAprobadaVigente: true,
      aprobadaAlgunaVez: true,
      reemplazadaPor: undefined,
    });
    // V2 y V1: aprobadas en su día, reemplazadas por la siguiente aprobada.
    expect(porNumero.get(2)).toMatchObject({
      estado: 'superseded',
      esAprobadaVigente: false,
      aprobadaAlgunaVez: true,
      reemplazadaPor: 3,
    });
    expect(porNumero.get(1)).toMatchObject({
      estado: 'superseded',
      esAprobadaVigente: false,
      aprobadaAlgunaVez: true,
      reemplazadaPor: 2,
    });
    expect(vista.resumen).toBe('aprobado_con_nueva_en_revision');

    // La versión elegida por defecto es la última; ?v=3 trae el detalle de la vigente.
    expect(vista.version?.numero).toBe(4);
    const v3Detalle = await cuenta(e, e.consultor, deliverableId, 3);
    expect(v3Detalle.version).toMatchObject({
      numero: 3,
      esAprobadaVigente: true,
      esUltima: false,
      aprobadaPor: e.admin.name,
      // Una versión ya aprobada no se vuelve a aprobar: sin evaluación.
      evaluacion: null,
    });
    const v1Detalle = await cuenta(e, e.consultor, deliverableId, 1);
    expect(v1Detalle.version).toMatchObject({
      numero: 1,
      reemplazadaPor: 2,
      abierta: false,
      evaluacion: null,
    });
  });

  it('la evaluación de V4 dice que es elegible, qué Brief la gobierna y que reemplaza a V3', async () => {
    const e = a.e;
    const { deliverableId } = await entregableConCuatroVersiones(e);
    const v4 = (await cuenta(e, e.director, deliverableId)).version!;
    expect(v4.evaluacion).not.toBeNull();
    const ev = v4.evaluacion!;
    expect(ev.elegible).toBe(true);
    expect(ev.bloqueos).toEqual([]);
    expect(ev.huella).toMatch(/^[0-9a-f]{64}$/u);
    expect(ev.briefGobernante?.numero).toBe(a.brief.version);
    expect(ev.revision?.tipo).toBe('human');
    expect(ev.reemplaza).toEqual({ numero: 3 });
    expect(ev.advertencias).toContain('Revisión humana, no asistida por IA.');
    expect(ev.advertencias).toContain('Reemplaza a la versión 3 aprobada.');
    // El Brief vigente de la vista es el mismo contra el que se revisó (CURRENT).
    expect(v4.revision.vigencia).toBe('current');
    expect(v4.revision.briefAnalizado?.numero).toBe(a.brief.version);
    expect(v4.revision.briefVigente?.numero).toBe(a.brief.version);
    // La huella del Brief que verá la persona al registrar su revisión humana.
    expect(v4.revision.huellaDelBrief).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('un guion con una versión posterior avisa que existe una más reciente al evaluar la anterior', async () => {
    const e = a.e;
    const deliverableId = await entregableNuevo(e, 'Con más reciente');
    const v1 = await versionNueva(e, deliverableId);
    await revisarComoHumano(v1, e.consultor);
    await versionNueva(e, deliverableId); // V2 recibida (más reciente)
    const vista = await cuenta(e, e.director, deliverableId, 1);
    expect(vista.version?.evaluacion?.versionMasReciente).toBe(2);
    expect(vista.version?.evaluacion?.advertencias.join(' ')).toContain(
      'Existe una versión más reciente (V2)',
    );
  });
});

describe('Hallazgos del Brief y comentarios de SmartPR: listas y orígenes separados', () => {
  it('un hallazgo de la IA no aparece como comentario humano y viceversa', async () => {
    const e = a.e;
    const deliverableId = await entregableNuevo(e, 'Separación');
    const versionId = await versionNueva(e, deliverableId);
    const textoRaro = '<script>alert("x")</script> Falta la acción esperada hacia la tienda.';
    await revisarConIA(e, versionId, [
      { category: 'cta_missing', refs: ['accion_kpis.accion_esperada'], description: textoRaro },
    ]);
    valor(
      await crearComentarioDeRevision(e.consultor, versionId, {
        kind: 'editorial',
        body: 'Suavicen el tono de la apertura.',
      }),
    );

    const vista = await cuenta(e, e.consultor, deliverableId);
    const v = vista.version!;
    // Hallazgos: todos del Brief, sin autor humano.
    expect(v.hallazgosDelBrief).toHaveLength(1);
    const h = v.hallazgosDelBrief[0]!;
    expect(h.origen).toBe('brief');
    expect(h).not.toHaveProperty('autor');
    expect(h.categoria).toBe('cta_missing');
    expect(h.severidad).toMatch(/^(alta|media|baja)$/u);
    // El texto del modelo llega TAL CUAL (la interfaz lo escapa al pintarlo; aquí no hay HTML ni saneo).
    expect(h.descripcion).toBe(textoRaro);
    expect(h.requisitosDelBrief[0]).toMatchObject({
      claveDelCampo: 'accion_kpis.accion_esperada',
      etiquetaDelCampo: expect.any(String),
    });
    expect(h.requisitosDelBrief[0]!.evidencias.length).toBeGreaterThan(0);
    expect(h.requisitosDelBrief[0]!.evidencias[0]).toMatchObject({ archivo: expect.any(String) });

    // Comentarios: todos de SmartPR, con autor visible y canal; el hallazgo NO está entre ellos.
    expect(v.comentarios).toHaveLength(1);
    const c = v.comentarios[0]!;
    expect(c).toMatchObject({
      origen: 'smartpr',
      tipo: 'editorial',
      autor: e.consultor.name,
      esMio: true,
      canal: 'ui',
      texto: 'Suavicen el tono de la apertura.',
    });
    expect(v.comentarios.map((x) => x.texto)).not.toContain(textoRaro);
    expect(v.cambiosSolicitados).toEqual([]);
    expect(JSON.stringify(v.hallazgosDelBrief)).not.toContain('Suavicen el tono');
    // Cada lista usa su propio origen: ningún elemento puede pasar por el otro.
    expect(new Set(v.hallazgosDelBrief.map((x) => x.origen))).toEqual(new Set(['brief']));
    expect(new Set(v.comentarios.map((x) => x.origen))).toEqual(new Set(['smartpr']));

    // La revisión asistida lleva los hallazgos por severidad; el aviso no los convierte en bloqueo.
    expect(v.revision.tipo).toBe('ai_assisted');
    expect(v.revision.totalDeHallazgos).toBe(1);
    expect(v.evaluacion?.hallazgosAbiertos.total).toBe(1);
    expect(v.evaluacion?.elegible).toBe(true);
    expect(v.evaluacion?.advertencias.join(' ')).toContain('1 hallazgo abierto');
  });

  it('una revisión humana no trae hallazgos: trae autor y nota de la persona', async () => {
    const e = a.e;
    const deliverableId = await entregableNuevo(e, 'Humana');
    const versionId = await versionNueva(e, deliverableId);
    valor(
      await registrarRevisionHumana(e.consultor, versionId, { nota: 'Revisé el guion contra el Brief.' }),
    );
    const v = (await cuenta(e, e.consultor, deliverableId)).version!;
    expect(v.hallazgosDelBrief).toEqual([]);
    expect(v.revision).toMatchObject({
      tipo: 'human',
      vigencia: 'current',
      autor: e.consultor.name,
      nota: 'Revisé el guion contra el Brief.',
      totalDeHallazgos: 0,
    });
  });

  it('los cambios solicitados van aparte de los comentarios editoriales y cierran la versión', async () => {
    const e = a.e;
    const deliverableId = await entregableNuevo(e, 'Cambios');
    const versionId = await versionNueva(e, deliverableId);
    valor(await crearComentarioDeRevision(e.admin, versionId, { kind: 'editorial', body: 'Buen arranque.' }));
    valor(
      await solicitarCambiosDeScript(e.consultor, versionId, {
        items: [
          { body: 'Añadir la mención del hashtag.' },
          { body: 'Cerrar con la invitación a la tienda.' },
        ],
      }),
    );
    const v = (await cuenta(e, e.consultor, deliverableId)).version!;
    expect(v.estado).toBe('changes_requested');
    expect(v.abierta).toBe(false);
    expect(v.comentarios.map((x) => x.texto)).toEqual(['Buen arranque.']);
    expect(v.cambiosSolicitados.map((x) => x.texto)).toEqual([
      'Añadir la mención del hashtag.',
      'Cerrar con la invitación a la tienda.',
    ]);
    expect(v.cambiosSolicitados.every((x) => x.tipo === 'change_request' && x.origen === 'smartpr')).toBe(
      true,
    );
    expect(v.comentarios[0]!.esMio).toBe(false); // lo escribió el admin
    expect(v.evaluacion).toBeNull();
  });
});

describe('Vigencia STALE al aprobar un Brief nuevo', () => {
  it('la revisión contra el Brief anterior queda STALE, sigue legible y deja de habilitar la aprobación', async () => {
    const e = b.e;
    const deliverableId = await entregableNuevo(e, 'Stale');
    const versionId = await versionNueva(e, deliverableId);
    await revisarComoHumano(versionId, e.consultor);

    const antes = (await cuenta(e, e.director, deliverableId)).version!;
    expect(antes.revision.vigencia).toBe('current');
    expect(antes.evaluacion?.elegible).toBe(true);
    const numeroDelBriefAnterior = b.brief.version;

    // Se aprueba un Brief nuevo (hija del rector): pasa a ser el documento rector.
    const hijo = await crearBriefHijoDePrueba(e.admin, b.brief.versionId, {
      cambios: { 'mensaje_principal.one_line': 'Nuevo mensaje central del P80 Pro para esta campaña.' },
    });
    const despues = await cuenta(e, e.director, deliverableId);
    const v = despues.version!;
    expect(v.revision.vigencia).toBe('stale');
    expect(v.revision.briefAnalizado?.numero).toBe(numeroDelBriefAnterior);
    expect(v.revision.briefVigente?.numero).toBe(hijo.version);
    expect(despues.briefVigente?.numero).toBe(hijo.version);
    // La revisión sigue visible (tipo y fecha), pero aprobar exige revisarla de nuevo.
    expect(v.revision.tipo).toBe('human');
    expect(v.evaluacion?.elegible).toBe(false);
    expect(v.evaluacion?.bloqueos.map((x) => `${x.codigo}:${x.razon}`)).toContain(
      'SCRIPT_REVIEW_REQUIRED:stale',
    );

    // En la lista también aparece STALE.
    const lista = valor(await listarContenidoDeCampana(e.director, e.campanaId));
    const entregable = lista.participaciones
      .flatMap((p) => p.entregables)
      .find((x) => x.id === deliverableId);
    expect(entregable?.revision?.vigencia).toBe('stale');
    expect(lista.briefRector?.numero).toBe(hijo.version);
  });
});

describe('Sin Brief aprobado', () => {
  it('no hay Brief vigente y la evaluación de aprobación bloquea con BRIEF_NOT_APPROVED', async () => {
    const e = sinBrief;
    const deliverableId = e.entregables.reelDiego;
    const versionId = await versionNueva(e, deliverableId, { participationId: e.participaciones.diego });
    expect(versionId).toBeTruthy();
    const vista = await cuenta(e, e.consultor, deliverableId);
    expect(vista.briefVigente).toBeNull();
    expect(vista.version?.revision).toMatchObject({ vigencia: 'none', tipo: null, briefVigente: null });
    expect(vista.version?.evaluacion?.elegible).toBe(false);
    expect(vista.version?.evaluacion?.bloqueos.map((x) => x.codigo)).toContain('BRIEF_NOT_APPROVED');
    const lista = valor(await listarContenidoDeCampana(e.consultor, e.campanaId));
    expect(lista.briefRector).toBeNull();
  });

  it('la prontitud del análisis: sin IA o sin Brief no se puede pedir', async () => {
    const e = sinBrief;
    const anterior = process.env['AI_ENABLED'];
    try {
      process.env['AI_ENABLED'] = 'true';
      const conIA = await cuenta(e, e.consultor, e.entregables.reelDiego);
      expect(conIA.version?.revision.prontitud).toBe('no_governing_brief');
      delete process.env['AI_ENABLED'];
      const sinIA = await cuenta(e, e.consultor, e.entregables.reelDiego);
      expect(sinIA.version?.revision.prontitud).toBe('ai_disabled');
    } finally {
      if (anterior === undefined) delete process.env['AI_ENABLED'];
      else process.env['AI_ENABLED'] = anterior;
    }
  });
});

describe('Propuesta de aprobación pendiente (nacida en el chat)', () => {
  it('se informa como pendiente en el detalle y en la lista, sin poder aprobarse desde ahí', async () => {
    const e = a.e;
    const lista0 = await versionRevisada(e, 'Pendiente de decisión');
    const accion = await proponerAprobacion(e, lista0.versionId);
    expect(accion.status).toBe('pending');

    const v = (await cuenta(e, e.consultor, lista0.deliverableId)).version!;
    expect(v.propuestaDeAprobacion.hay).toBe(true);
    expect(v.estado).toBe('in_review'); // la propuesta NO cambia el estado de la versión

    const lista = valor(await listarContenidoDeCampana(e.consultor, e.campanaId));
    const item = lista.participaciones
      .flatMap((p) => p.entregables)
      .find((x) => x.id === lista0.deliverableId);
    expect(item?.revision?.propuestaDeAprobacionPendiente).toBe(true);

    // El Operativo no ve ni que exista una propuesta.
    const op = await detalle(e, e.operativo, lista0.deliverableId);
    expect(JSON.stringify(op)).not.toMatch(/propuestaDeAprobacion|proposed/iu);
  });
});

describe('Acceso por rol dentro de la consulta', () => {
  it('Operativo: DTO reducido, sin versiones intermedias, hallazgos, comentarios, archivo ni ids', async () => {
    const e = a.e;
    const { deliverableId, v1, v2, v3, v4 } = await entregableConCuatroVersiones(e);
    valor(
      await crearComentarioDeRevision(e.consultor, v4, {
        kind: 'editorial',
        body: 'Comentario confidencial de SmartPR.',
      }),
    );
    await revisarConIA(e, v4, [
      {
        category: 'cta_missing',
        refs: ['accion_kpis.accion_esperada'],
        description: 'Hallazgo confidencial.',
      },
    ]);

    const vista = await detalle(e, e.operativo, deliverableId);
    expect(vista.proyeccion).toBe('estado');
    const reducida = vista as VistaDeDeliverableDeEstado;
    expect(reducida.ultima).toEqual({ numero: 4, estado: 'in_review' });
    expect(reducida.aprobadaVigente).toMatchObject({ numero: 3, archivo: expect.any(String) });
    expect(reducida.resumen).toBe('aprobado_con_nueva_en_revision');
    expect(reducida.participacion.influencerNombre).toBe('Diego Peña');

    // Ni ids de versión, ni de fuente, ni textos de revisión, ni claves de las secciones de Cuenta.
    const serializada = JSON.stringify(vista);
    for (const id of [v1, v2, v3, v4]) expect(serializada).not.toContain(id);
    expect(serializada).not.toContain('confidencial');
    for (const clave of [
      'versiones',
      'hallazgosDelBrief',
      'comentarios',
      'cambiosSolicitados',
      'sourceId',
      'evaluacion',
      'huella',
      'archivoOriginal',
    ]) {
      expect(serializada).not.toContain(`"${clave}"`);
    }
    // Aunque pida una versión intermedia, no recibe detalle de versión alguna.
    const intermedia = await detalle(e, e.operativo, deliverableId, 2);
    expect(intermedia.proyeccion).toBe('estado');
    expect(JSON.stringify(intermedia)).not.toContain(v2);

    // La lista también es reducida.
    const lista = valor(await listarContenidoDeCampana(e.operativo, e.campanaId));
    expect(lista.proyeccion).toBe('estado');
    expect(lista.briefRector).toBeUndefined();
    const item = lista.participaciones.flatMap((p) => p.entregables).find((x) => x.id === deliverableId)!;
    expect(item.revision).toBeUndefined();
    expect(item.versiones).toBeUndefined();
    expect(item.ultimaVersion).toEqual({ numero: 4, estado: 'in_review', fecha: undefined });
    expect(JSON.stringify(lista)).not.toContain(v4);
  });

  it('cliente, otra agencia y roles sin la capacidad: RESOURCE_NOT_FOUND en ambas lecturas', async () => {
    const e = a.e;
    const { deliverableId } = await entregableConCuatroVersiones(e);
    for (const intruso of [e.cliente, e.ajeno, e.analista, e.legal]) {
      const lista = await listarContenidoDeCampana(intruso, e.campanaId);
      expect(lista.ok ? 'ok' : lista.error.code).toBe('RESOURCE_NOT_FOUND');
      const d = await obtenerDeliverableConVersiones(intruso, deliverableId, {
        alcance: { campaignId: e.campanaId },
      });
      expect(d.ok ? 'ok' : d.error.code).toBe('RESOURCE_NOT_FOUND');
    }
  });

  it('el cerco de campaña, la participación, los ids mal formados y las versiones inexistentes son «no existe»', async () => {
    const e = a.e;
    const { deliverableId } = await entregableConCuatroVersiones(e);
    const codigoDe = async (p: Promise<{ ok: boolean; error?: { code: string } }>) => {
      const r = await p;
      return r.ok ? 'ok' : r.error?.code;
    };
    // Otra campaña de la misma agencia.
    expect(
      await codigoDe(
        obtenerDeliverableConVersiones(e.consultor, deliverableId, {
          alcance: { campaignId: e.otraCampanaId },
        }),
      ),
    ).toBe('RESOURCE_NOT_FOUND');
    // Participación que no es la de la pieza.
    expect(
      await codigoDe(
        obtenerDeliverableConVersiones(e.consultor, deliverableId, {
          alcance: { campaignId: e.campanaId },
          participacionId: e.participaciones.valentinaRios,
        }),
      ),
    ).toBe('RESOURCE_NOT_FOUND');
    // La participación correcta sí.
    expect(
      await codigoDe(
        obtenerDeliverableConVersiones(e.consultor, deliverableId, {
          alcance: { campaignId: e.campanaId },
          participacionId: e.participaciones.diego,
        }),
      ),
    ).toBe('ok');
    // Ids mal formados y versión inexistente.
    expect(
      await codigoDe(
        obtenerDeliverableConVersiones(e.consultor, 'no-es-uuid', { alcance: { campaignId: e.campanaId } }),
      ),
    ).toBe('RESOURCE_NOT_FOUND');
    expect(await codigoDe(listarContenidoDeCampana(e.consultor, 'no-es-uuid'))).toBe('RESOURCE_NOT_FOUND');
    expect(
      await codigoDe(
        obtenerDeliverableConVersiones(e.consultor, deliverableId, {
          alcance: { campaignId: e.campanaId },
          versionNumber: 99,
        }),
      ),
    ).toBe('RESOURCE_NOT_FOUND');
  });
});

describe('Lista de la campaña', () => {
  it('agrupa por participación con estado derivado, última, aprobada vigente y revisión (Cuenta)', async () => {
    const e = a.e;
    const { deliverableId, v3 } = await entregableConCuatroVersiones(e);
    void v3;
    const lista = valor(await listarContenidoDeCampana(e.consultor, e.campanaId));
    expect(lista.proyeccion).toBe('cuenta');
    expect(lista.briefRector?.numero).toBe(a.brief.version);

    const diego = lista.participaciones.find((p) => p.participacionId === e.participaciones.diego)!;
    expect(diego.influencerNombre).toBe('Diego Peña');
    expect(diego.estadoDeParticipacion).toBe('activo');
    const item = diego.entregables.find((x) => x.id === deliverableId)!;
    expect(item).toMatchObject({
      estado: 'active',
      resumen: 'aprobado_con_nueva_en_revision',
      versiones: 4,
      ultimaVersion: { numero: 4, estado: 'in_review' },
      aprobadaVigente: { numero: 3 },
      revision: { vigencia: 'current', tipo: 'human', briefNumero: a.brief.version },
    });
    // Participantes sin entregables también se listan (para poder crear el primero), con sus productos.
    const rios = lista.participaciones.find((p) => p.participacionId === e.participaciones.valentinaRios)!;
    expect(rios.productos.length).toBe(1);
    expect(rios.entregables.map((x) => x.nombre)).toEqual(expect.arrayContaining(['Reel principal']));
    expect(lista.totales.participacionesActivas).toBe(3);
    expect(lista.totales.entregablesActivos).toBeGreaterThanOrEqual(4);
  });
});
