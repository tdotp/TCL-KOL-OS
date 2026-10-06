/**
 * V2 · Fase 7 — permisos de contenido por rol, contra PostgreSQL real.
 *
 * Matriz rol × operación para los 7 roles (más otra agencia):
 *   admin · director · consultor   todo (la aprobación es de admin y director: `script-approval`, W3a)
 *   operativo                      SOLO el estado de las piezas (proyección sin contenido)
 *   analista · legal               nada (FORBIDDEN_ROLE)
 *   cliente · otra agencia         nada, y ni siquiera existe (RESOURCE_NOT_FOUND)
 * Más la paridad de roles entre la base (`contenido_exigir_rol`) y el dominio (`roleCan`).
 */

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Result, type Role, type User, roleCan } from '@tcl-kol-os/domain';
import { closePool, getPool, query, transaction } from './client.ts';
import {
  actualizarEntregable,
  archivarEntregable,
  crearEntregable,
  listarEntregablesDeCampana,
  obtenerEntregable,
  reactivarEntregable,
} from './deliverables.ts';
import {
  iniciarRevisionDeVersion,
  listarVersionesDeEntregable,
  obtenerUltimaVersion,
  obtenerVersionDeGuion,
  obtenerVersionVigente,
  registrarVersionDeGuion,
} from './script-versions.ts';
import {
  type EscenarioDeContenido,
  crearEscenarioDeContenido,
  crearFuenteDeGuionDePrueba,
  limpiarEscenarioDeContenido,
} from './test-utils.ts';

let e: EscenarioDeContenido;

const valor = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
};
const codigo = <T>(r: Result<T>): string => (r.ok ? 'OK' : r.error.code);

async function conBypass(fn: (c: pg.PoolClient) => Promise<void>): Promise<void> {
  await transaction(async (c) => {
    await c.query(`SET LOCAL tclkolos.permitir_borrado_historico = 'on'`);
    await fn(c);
  });
}

let n = 0;
/** Entregable desechable de Diego con una versión recibida. */
async function recurso(): Promise<{ deliverableId: string; versionId: string }> {
  const d = valor(
    await crearEntregable(e.consultor, {
      campaignInfluencerId: e.participaciones.diego,
      label: `Permisos ${++n}`,
    }),
  );
  const r = valor(
    await registrarVersionDeGuion(e.consultor, {
      campaignId: e.campanaId,
      sourceId: await crearFuenteDeGuionDePrueba(e.campanaId, e.admin, `permisos-${n}`),
      participation: { participationId: e.participaciones.diego },
      deliverable: { id: d.id },
    }),
  );
  if (r.kind !== 'registered') throw new Error('se esperaba una versión nueva');
  return { deliverableId: d.id, versionId: r.version.id };
}

beforeAll(async () => {
  e = await crearEscenarioDeContenido('F7 permisos');
});
afterAll(async () => {
  await limpiarEscenarioDeContenido(e);
  await closePool();
});

type Esperado = 'OK' | 'FORBIDDEN_ROLE' | 'RESOURCE_NOT_FOUND';

interface Operacion {
  readonly nombre: string;
  /** Ejecuta la operación como `actor` sobre un recurso FRESCO y devuelve el código del resultado. */
  readonly ejecutar: (actor: User) => Promise<string>;
}

/** Quien tiene la capacidad: OK; el personal de la agencia sin ella: FORBIDDEN_ROLE; cliente y ajenos: NOT_FOUND. */
function esperado(actor: User, ...capacidades: Parameters<typeof roleCan>[1][]): Esperado {
  if (actor.role === 'cliente' || actor.organizationId !== e.admin.organizationId)
    return 'RESOURCE_NOT_FOUND';
  return capacidades.every((c) => roleCan(actor.role, c)) ? 'OK' : 'FORBIDDEN_ROLE';
}

const OPERACIONES: Array<Operacion & { capacidades: Parameters<typeof roleCan>[1][] }> = [
  {
    nombre: 'crearEntregable',
    capacidades: ['deliverable:manage'],
    ejecutar: async (a) =>
      codigo(
        await crearEntregable(a, {
          campaignInfluencerId: e.participaciones.diego,
          label: `Matriz ${a.role} ${++n}`,
        }),
      ),
  },
  {
    nombre: 'actualizarEntregable',
    capacidades: ['deliverable:manage'],
    ejecutar: async (a) => {
      const { deliverableId } = await recurso();
      return codigo(await actualizarEntregable(a, deliverableId, { label: `Renombrado ${a.role} ${++n}` }));
    },
  },
  {
    nombre: 'archivarEntregable',
    capacidades: ['deliverable:manage'],
    ejecutar: async (a) => codigo(await archivarEntregable(a, (await recurso()).deliverableId)),
  },
  {
    nombre: 'reactivarEntregable',
    capacidades: ['deliverable:manage'],
    ejecutar: async (a) => {
      const { deliverableId } = await recurso();
      valor(await archivarEntregable(e.consultor, deliverableId));
      return codigo(await reactivarEntregable(a, deliverableId));
    },
  },
  {
    nombre: 'registrarVersionDeGuion',
    capacidades: ['script:manage', 'source:read'],
    ejecutar: async (a) => {
      const { deliverableId } = await recurso();
      return codigo(
        await registrarVersionDeGuion(a, {
          campaignId: e.campanaId,
          sourceId: await crearFuenteDeGuionDePrueba(e.campanaId, e.admin, `matriz-${a.role}-${++n}`),
          participation: { participationId: e.participaciones.diego },
          deliverable: { id: deliverableId },
        }),
      );
    },
  },
  {
    nombre: 'iniciarRevisionDeVersion',
    capacidades: ['script:manage'],
    ejecutar: async (a) => codigo(await iniciarRevisionDeVersion(a, (await recurso()).versionId)),
  },
  {
    nombre: 'listarVersionesDeEntregable',
    capacidades: ['script:read'],
    ejecutar: async (a) => codigo(await listarVersionesDeEntregable(a, (await recurso()).deliverableId)),
  },
  {
    nombre: 'obtenerVersionDeGuion',
    capacidades: ['script:read'],
    ejecutar: async (a) => codigo(await obtenerVersionDeGuion(a, (await recurso()).versionId)),
  },
  {
    nombre: 'obtenerVersionVigente',
    capacidades: ['script:read'],
    ejecutar: async (a) => codigo(await obtenerVersionVigente(a, (await recurso()).deliverableId)),
  },
  {
    nombre: 'obtenerUltimaVersion',
    capacidades: ['script:read'],
    ejecutar: async (a) => codigo(await obtenerUltimaVersion(a, (await recurso()).deliverableId)),
  },
  {
    nombre: 'obtenerEntregable',
    capacidades: ['deliverable:read'],
    ejecutar: async (a) => codigo(await obtenerEntregable(a, (await recurso()).deliverableId)),
  },
  {
    nombre: 'listarEntregablesDeCampana',
    capacidades: ['deliverable:read'],
    ejecutar: async (a) => codigo(await listarEntregablesDeCampana(a, e.campanaId)),
  },
];

describe('matriz rol × operación', () => {
  const roles = (): Array<[string, User]> => [
    ['admin', e.admin],
    ['director', e.director],
    ['consultor', e.consultor],
    ['operativo', e.operativo],
    ['analista', e.analista],
    ['legal', e.legal],
    ['cliente', e.cliente],
    ['otra agencia (admin)', e.ajeno],
  ];

  for (const op of OPERACIONES) {
    it(`${op.nombre}: el resultado de cada rol es el que dicta roleCan (y cliente/otra agencia no ven nada)`, async () => {
      for (const [nombre, actor] of roles()) {
        expect(await op.ejecutar(actor), `${op.nombre} como ${nombre}`).toBe(
          esperado(actor, ...op.capacidades),
        );
      }
    });
  }

  it('las expectativas explícitas (no derivadas de roleCan): la tabla que el negocio fijó', async () => {
    const tabla: Record<string, Record<string, string>> = {
      crearEntregable: {
        admin: 'OK',
        director: 'OK',
        consultor: 'OK',
        operativo: 'FORBIDDEN_ROLE',
        analista: 'FORBIDDEN_ROLE',
        legal: 'FORBIDDEN_ROLE',
        cliente: 'RESOURCE_NOT_FOUND',
        ajeno: 'RESOURCE_NOT_FOUND',
      },
      registrarVersionDeGuion: {
        admin: 'OK',
        director: 'OK',
        consultor: 'OK',
        operativo: 'FORBIDDEN_ROLE',
        analista: 'FORBIDDEN_ROLE',
        legal: 'FORBIDDEN_ROLE',
        cliente: 'RESOURCE_NOT_FOUND',
        ajeno: 'RESOURCE_NOT_FOUND',
      },
      obtenerVersionDeGuion: {
        admin: 'OK',
        director: 'OK',
        consultor: 'OK',
        // el Operativo NO lee versiones: solo el estado agregado
        operativo: 'FORBIDDEN_ROLE',
        analista: 'FORBIDDEN_ROLE',
        legal: 'FORBIDDEN_ROLE',
        cliente: 'RESOURCE_NOT_FOUND',
        ajeno: 'RESOURCE_NOT_FOUND',
      },
      obtenerEntregable: {
        admin: 'OK',
        director: 'OK',
        consultor: 'OK',
        operativo: 'OK',
        analista: 'FORBIDDEN_ROLE',
        legal: 'FORBIDDEN_ROLE',
        cliente: 'RESOURCE_NOT_FOUND',
        ajeno: 'RESOURCE_NOT_FOUND',
      },
    };
    const porNombre: Record<string, User> = {
      admin: e.admin,
      director: e.director,
      consultor: e.consultor,
      operativo: e.operativo,
      analista: e.analista,
      legal: e.legal,
      cliente: e.cliente,
      ajeno: e.ajeno,
    };
    for (const [operacion, filas] of Object.entries(tabla)) {
      const op = OPERACIONES.find((o) => o.nombre === operacion)!;
      for (const [rol, esperadoRol] of Object.entries(filas)) {
        expect(await op.ejecutar(porNombre[rol]!), `${operacion} · ${rol}`).toBe(esperadoRol);
      }
    }
  });

  it('un rechazo no deja efecto: ni entregables ni versiones ni auditoría de quien no podía', async () => {
    const antes = Number(
      (
        await query<{ n: string }>(`SELECT count(*)::text AS n FROM deliverables WHERE campaign_id = $1`, [
          e.campanaId,
        ])
      )[0]!.n,
    );
    const intrusos = [e.operativo.id, e.analista.id, e.legal.id, e.cliente.id, e.ajeno.id];
    const auditoriaDeIntrusos = async () =>
      (
        await query<{ n: string }>(
          `SELECT count(*)::text AS n FROM audit_events WHERE action = 'deliverable.create' AND actor_id = ANY($1::uuid[])`,
          [intrusos],
        )
      )[0]!.n;
    const eventosAntes = await auditoriaDeIntrusos();
    for (const intruso of [e.operativo, e.analista, e.legal, e.cliente, e.ajeno]) {
      await crearEntregable(intruso, {
        campaignInfluencerId: e.participaciones.diego,
        label: `Intruso ${intruso.role}`,
      });
    }
    const despues = Number(
      (
        await query<{ n: string }>(`SELECT count(*)::text AS n FROM deliverables WHERE campaign_id = $1`, [
          e.campanaId,
        ])
      )[0]!.n,
    );
    expect(despues).toBe(antes);
    // delta, no absoluto: otras pruebas pueden usar los usuarios compartidos (p.ej. `ajeno`)
    expect(await auditoriaDeIntrusos()).toBe(eventosAntes);
  });

  it('un actor «system» no muta (solo personas)', async () => {
    const { versionId } = await recurso();
    expect(codigo(await iniciarRevisionDeVersion('system' as never, versionId))).toBe('FORBIDDEN_ROLE');
    expect(
      codigo(
        await registrarVersionDeGuion('system' as never, {
          campaignId: e.campanaId,
          sourceId: e.fuentes.procesada,
          participation: {},
        }),
      ),
    ).toBe('FORBIDDEN_ROLE');
  });

  it('un usuario inactivo no accede a nada', async () => {
    const [u] = await query<{ id: string }>(
      `INSERT INTO users (email, name, organization_id, role, status)
       VALUES ($1, 'Inactivo F7', $2, 'consultor', 'inactivo') RETURNING id`,
      [`inactivo-f7-${e.sufijo}@smartpr.co`, e.admin.organizationId],
    );
    const inactivo: User = { ...e.consultor, id: u!.id, status: 'inactivo' };
    expect(codigo(await listarEntregablesDeCampana(inactivo, e.campanaId))).toBe('RESOURCE_NOT_FOUND');
    expect(
      codigo(
        await crearEntregable(inactivo, { campaignInfluencerId: e.participaciones.diego, label: 'Inactivo' }),
      ),
    ).toBe('RESOURCE_NOT_FOUND');
  });
});

describe('el Operativo solo ve el ESTADO (proyección sin contenido)', () => {
  let deliverableId: string;
  let ids: { v1: string; v2: string; v3: string; fuente1: string; fuente2: string; fuente3: string };

  beforeAll(async () => {
    const d = valor(
      await crearEntregable(e.consultor, {
        campaignInfluencerId: e.participaciones.valentinaGomez,
        label: 'Proyección',
      }),
    );
    deliverableId = d.id;
    const registrar = async (etiqueta: string) => {
      const sourceId = await crearFuenteDeGuionDePrueba(e.campanaId, e.admin, `proyeccion-${etiqueta}`);
      const r = valor(
        await registrarVersionDeGuion(e.consultor, {
          campaignId: e.campanaId,
          sourceId,
          participation: { participationId: e.participaciones.valentinaGomez },
          deliverable: { id: d.id },
        }),
      );
      if (r.kind !== 'registered') throw new Error('se esperaba una versión nueva');
      return { versionId: r.version.id, sourceId };
    };
    const a = await registrar('uno');
    const b = await registrar('dos');
    const c = await registrar('tres');
    ids = {
      v1: a.versionId,
      v2: b.versionId,
      v3: c.versionId,
      fuente1: a.sourceId,
      fuente2: b.sourceId,
      fuente3: c.sourceId,
    };
    // V1 reemplazada (aprobada alguna vez), V2 aprobada vigente, V3 en revisión
    await conBypass(async (cl) => {
      await cl.query(
        `UPDATE script_versions SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`,
        [ids.v1, e.director.id],
      );
      await cl.query(
        `UPDATE script_versions SET status = 'superseded', superseded_by_version_id = $2, superseded_at = now() WHERE id = $1`,
        [ids.v1, ids.v2],
      );
      await cl.query(
        `UPDATE script_versions SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`,
        [ids.v2, e.director.id],
      );
      await cl.query(`UPDATE script_versions SET status = 'in_review' WHERE id = $1`, [ids.v3]);
    });
    // un comentario de revisión (texto que NO debe filtrarse al Operativo)
    await query(
      `INSERT INTO script_review_comments (organization_id, campaign_id, script_version_id, author_id, kind, body, origin)
       VALUES ($1, $2, $3, $4, 'editorial', 'COMENTARIO-SECRETO-DE-REVISION', 'ui')`,
      [e.admin.organizationId, e.campanaId, ids.v3, e.consultor.id],
    );
  });

  it('Operativo: solo estado, última {version,status} y vigente {version,approvedAt,filename}', async () => {
    const d = valor(await obtenerEntregable(e.operativo, deliverableId));
    expect(d.projection).toBe('estado');
    if (d.projection !== 'estado') return;
    expect(Object.keys(d).sort()).toEqual(
      [
        'campaignInfluencerId',
        'currentApproved',
        'deliverableId',
        'label',
        'latest',
        'platform',
        'projection',
        'resumen',
        'status',
      ].sort(),
    );
    expect(d.resumen).toBe('aprobado_con_nueva_en_revision');
    expect(d.latest).toEqual({ version: 3, status: 'in_review' });
    expect(Object.keys(d.currentApproved ?? {}).sort()).toEqual(['approvedAt', 'filename', 'version']);
    expect(d.currentApproved).toMatchObject({ version: 2, filename: 'proyeccion-dos.md' });
  });

  it('nada de ids de versión o de fuente, hashes, autores, versiones intermedias ni comentarios', async () => {
    const d = valor(await obtenerEntregable(e.operativo, deliverableId));
    const lista = valor(await listarEntregablesDeCampana(e.operativo, e.campanaId, { limite: 200 }));
    expect(lista.projection).toBe('estado');
    for (const item of lista.items) expect(item.projection).toBe('estado');
    const texto = JSON.stringify([d, lista]);
    const hashes = (
      await query<{ hash: string }>(`SELECT hash FROM source_documents WHERE id = ANY($1::uuid[])`, [
        [ids.fuente1, ids.fuente2, ids.fuente3],
      ])
    ).map((f) => f.hash);
    for (const prohibido of [
      ids.v1,
      ids.v2,
      ids.v3,
      ids.fuente1,
      ids.fuente2,
      ids.fuente3,
      ...hashes,
      'proyeccion-uno.md', // la V1 intermedia (reemplazada) no existe para el Operativo
      'proyeccion-tres.md', // el nombre del borrador en revisión tampoco
      'COMENTARIO-SECRETO-DE-REVISION',
      e.consultor.id,
      e.director.id,
      'created_by',
      'sourceId',
      'versionId',
    ]) {
      expect(texto, String(prohibido)).not.toContain(prohibido);
    }
  });

  it('Cuenta ve el detalle completo con ids, vigente y última', async () => {
    const d = valor(await obtenerEntregable(e.consultor, deliverableId));
    expect(d.projection).toBe('cuenta');
    if (d.projection !== 'cuenta') return;
    expect(d).toMatchObject({
      resumen: 'aprobado_con_nueva_en_revision',
      versionCount: 3,
      influencerDisplayName: 'Valentina Gómez',
      latest: { id: ids.v3, version: 3, status: 'in_review' },
      currentApproved: { id: ids.v2, version: 2 },
    });
  });
});

describe('paridad de roles entre la base (contenido_exigir_rol) y el dominio (roleCan)', () => {
  async function acepta(usuarioId: string, capacidad: string): Promise<boolean> {
    try {
      await getPool().query(`SELECT contenido_exigir_rol($1, $2)`, [usuarioId, capacidad]);
      return true;
    } catch {
      return false;
    }
  }

  it('«manage» acepta exactamente los roles con script:manage y deliverable:manage; «approve» los de script:approve', async () => {
    const [enAgencia] = await query<{ id: string }>(
      `SELECT id FROM users WHERE email = 'cliente-en-agencia@smartpr.co'`,
    );
    const casos: Array<[Role | string, string]> = [
      ['admin', e.admin.id],
      ['director', e.director.id],
      ['consultor', e.consultor.id],
      ['operativo', e.operativo.id],
      ['analista', e.analista.id],
      ['legal', e.legal.id],
      ['cliente', e.cliente.id],
      ['cliente (de la agencia)', enAgencia!.id],
      ['admin de otra agencia', e.ajeno.id],
    ];
    for (const [rol, id] of casos) {
      const rolReal = rol.startsWith('cliente')
        ? 'cliente'
        : rol.startsWith('admin')
          ? 'admin'
          : (rol as Role);
      const manage =
        roleCan(rolReal as Role, 'script:manage') && roleCan(rolReal as Role, 'deliverable:manage');
      const approve = roleCan(rolReal as Role, 'script:approve');
      expect(await acepta(id, 'manage'), `manage · ${rol}: la base y roleCan divergen`).toBe(manage);
      expect(await acepta(id, 'approve'), `approve · ${rol}: la base y roleCan divergen`).toBe(approve);
    }
  });

  it('la base es de lista cerrada: una capacidad desconocida, un usuario inexistente o inactivo no pasan', async () => {
    expect(await acepta(e.admin.id, 'publish')).toBe(false);
    expect(await acepta(e.admin.id, '')).toBe(false);
    expect(await acepta('88888888-8888-4888-8888-888888888888', 'manage')).toBe(false);
    const [u] = await query<{ id: string }>(
      `INSERT INTO users (email, name, organization_id, role, status)
       VALUES ($1, 'Inactivo paridad', $2, 'admin', 'inactivo') RETURNING id`,
      [`inactivo-paridad-${e.sufijo}@smartpr.co`, e.admin.organizationId],
    );
    expect(await acepta(u!.id, 'manage')).toBe(false);
    expect(await acepta(u!.id, 'approve')).toBe(false);
  });

  it('la base rechaza por SQL directo a quien no es de manage/approve (entregable, versión y comentario)', async () => {
    for (const intruso of [e.operativo, e.analista, e.legal, e.cliente, e.ajeno]) {
      await expect(
        query(
          `INSERT INTO deliverables (organization_id, campaign_id, campaign_influencer_id, label, label_key, created_by)
           VALUES ($1, $2, $3, 'X', 'x', $4)`,
          [e.admin.organizationId, e.campanaId, e.participaciones.diego, intruso.id],
        ),
        intruso.role,
      ).rejects.toThrow();
    }
  });
});
