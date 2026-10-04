/**
 * V2 · Fase 3 — Influencer e identidades por plataforma, contra PostgreSQL real.
 *
 * Datos propios y desechables (INC-001A): cada ejecución usa un sufijo único y
 * limpia lo que creó. Nunca campañas reales.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Result, User } from '@tcl-kol-os/domain';
import { closePool, query } from './client.ts';
import { asegurarUsuarioDePrueba, eliminarInfluencersDePrueba } from './test-utils.ts';
import { findUserByEmail } from './users.ts';
import {
  actualizarCuenta,
  actualizarInfluencer,
  agregarCuenta,
  buscarInfluencerPorCuenta,
  crearInfluencer as crearInfluencerSinRegistro,
  listarInfluencers,
  obtenerInfluencer,
} from './influencers.ts';

const sufijo = Date.now().toString(36);
const h = (base: string) => `${base}_${sufijo}`;

let admin: User;
let director: User;
let consultor: User;
let operativo: User;
let analista: User;
let legal: User;
let cliente: User;
let ajeno: User;
const creados: string[] = [];

function valor<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}

type Resultado = { readonly ok: true } | { readonly ok: false; readonly error: { readonly code: string } };

function codigo(r: Resultado): string | undefined {
  return r.ok ? undefined : r.error.code;
}

/** Toda creación se registra para la limpieza, incluso si la prueba esperaba que fallara. */
async function crearInfluencer(...args: Parameters<typeof crearInfluencerSinRegistro>) {
  const r = await crearInfluencerSinRegistro(...args);
  if (r.ok) creados.push(r.value.influencer.id);
  return r;
}

async function nuevo(
  actor: User,
  displayName: string,
  cuentas?: Parameters<typeof crearInfluencerSinRegistro>[1]['cuentas'],
) {
  return crearInfluencer(actor, { displayName, cuentas });
}

async function auditoria(entityId: string) {
  return query<{
    action: string;
    entity_type: string;
    origin: string | null;
    actor_id: string | null;
    metadata: Record<string, unknown>;
    correlation: Record<string, string> | null;
  }>(
    `SELECT action, entity_type, origin, actor_id, metadata, correlation
       FROM audit_events WHERE entity_id = $1 ORDER BY created_at, id`,
    [entityId],
  );
}

beforeAll(async () => {
  admin = (await findUserByEmail('gerardo@smartpr.co'))!;
  director = (await findUserByEmail('director@smartpr.co'))!;
  consultor = (await findUserByEmail('consultor@smartpr.co'))!;
  cliente = (await findUserByEmail('marena@tcl.com'))!;
  ajeno = (await findUserByEmail('ajeno@otraagencia.co'))!;
  operativo = await asegurarUsuarioDePrueba(
    'operativo@smartpr.co',
    'Usuario Operativo',
    'operativo',
    admin.organizationId,
  );
  analista = await asegurarUsuarioDePrueba(
    'analista-f3@smartpr.co',
    'Analista F3',
    'analista',
    admin.organizationId,
  );
  legal = await asegurarUsuarioDePrueba('legal-f3@smartpr.co', 'Legal F3', 'legal', admin.organizationId);
});

afterAll(async () => {
  await eliminarInfluencersDePrueba(creados);
  await closePool();
});

// ─────────────────────────── Influencer ────────────────────────────────────────

describe('crear influencer', () => {
  it('crea una identidad válida de la organización del actor, sin datos de campaña', async () => {
    const creado = valor(await nuevo(admin, `  Valentina   Rojas ${sufijo} `));
    expect(creado.influencer.displayName).toBe(`Valentina Rojas ${sufijo}`);
    expect(creado.influencer.organizationId).toBe(admin.organizationId);
    expect(creado.influencer.createdBy).toBe(admin.id);
    expect(creado.accounts).toEqual([]);

    // La identidad no tiene columnas de campaña, fee, producto ni KPIs.
    const columnas = await query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'influencers'`,
    );
    expect(columnas.map((c) => c.column_name).sort()).toEqual([
      'created_at',
      'created_by',
      'display_name',
      'id',
      'organization_id',
      'updated_at',
    ]);
  });

  it('un nombre vacío o inválido se rechaza y no persiste nada', async () => {
    for (const nombre of ['', '   ', 'x'.repeat(201)]) {
      expect(codigo(await crearInfluencer(admin, { displayName: nombre })), nombre).toBe('VALIDATION_FAILED');
    }
    const antes = await query<{ n: string }>(`SELECT count(*) AS n FROM influencers WHERE display_name = ''`);
    expect(antes[0]!.n).toBe('0');
  });

  it('el nombre no es identidad: dos personas pueden llamarse igual', async () => {
    const a = valor(await nuevo(admin, `Homónimo ${sufijo}`));
    const b = valor(await nuevo(consultor, `Homónimo ${sufijo}`));
    expect(a.influencer.id).not.toBe(b.influencer.id);
  });

  it('la base rechaza un nombre sin recortar o vacío aunque se salte la aplicación', async () => {
    for (const nombre of ['', ' x', 'x ']) {
      await expect(
        query(`INSERT INTO influencers (organization_id, display_name, created_by) VALUES ($1, $2, $3)`, [
          admin.organizationId,
          nombre,
          admin.id,
        ]),
      ).rejects.toThrow();
    }
  });
});

describe('leer y actualizar', () => {
  it('lo leen Cuenta y Operativo de la organización', async () => {
    const creado = valor(await nuevo(admin, `Legible ${sufijo}`));
    for (const actor of [admin, director, consultor, operativo]) {
      const leido = await obtenerInfluencer(actor, creado.influencer.id);
      expect(leido.ok, actor.role).toBe(true);
    }
    const lista = valor(await listarInfluencers(operativo));
    expect(lista.some((i) => i.influencer.id === creado.influencer.id)).toBe(true);
  });

  it('actualizar el nombre audita el cambio; repetir el mismo valor no hace nada', async () => {
    const creado = valor(await nuevo(admin, `Antes ${sufijo}`));
    const id = creado.influencer.id;
    const nuevoNombre = valor(
      await actualizarInfluencer(consultor, id, { displayName: ` Después ${sufijo}` }),
    );
    expect(nuevoNombre.displayName).toBe(`Después ${sufijo}`);
    valor(await actualizarInfluencer(consultor, id, { displayName: `Después ${sufijo}` }));

    const eventos = (await auditoria(id)).filter((e) => e.action === 'influencer.update');
    expect(eventos).toHaveLength(1);
    expect(eventos[0]!.metadata).toMatchObject({
      displayNameAnterior: `Antes ${sufijo}`,
      displayNameNuevo: `Después ${sufijo}`,
    });
    expect(eventos[0]!.origin).toBe('ui');
    expect(eventos[0]!.actor_id).toBe(consultor.id);
  });

  it('un nombre inválido en la actualización se rechaza', async () => {
    const creado = valor(await nuevo(admin, `Valido ${sufijo}`));
    expect(codigo(await actualizarInfluencer(admin, creado.influencer.id, { displayName: '  ' }))).toBe(
      'VALIDATION_FAILED',
    );
  });
});

// ─────────────────────────── Aislamiento entre organizaciones ──────────────────

describe('aislamiento entre organizaciones', () => {
  it('otra agencia no lee, no lista, no actualiza ni agrega cuentas al influencer ajeno', async () => {
    const mio = valor(
      await nuevo(admin, `Privado ${sufijo}`, [{ platform: 'instagram', handle: h('privado') }]),
    );
    const id = mio.influencer.id;
    const cuentaId = mio.accounts[0]!.id;

    expect(codigo(await obtenerInfluencer(ajeno, id))).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await actualizarInfluencer(ajeno, id, { displayName: 'Hackeado' }))).toBe(
      'RESOURCE_NOT_FOUND',
    );
    expect(codigo(await agregarCuenta(ajeno, id, { platform: 'tiktok', handle: h('x') }))).toBe(
      'RESOURCE_NOT_FOUND',
    );
    expect(codigo(await actualizarCuenta(ajeno, cuentaId, { handle: h('robado') }))).toBe(
      'RESOURCE_NOT_FOUND',
    );

    const listaAjena = valor(await listarInfluencers(ajeno));
    expect(listaAjena.some((i) => i.influencer.id === id)).toBe(false);
    const enAdmin = valor(await obtenerInfluencer(admin, id));
    expect(enAdmin.influencer.displayName).toBe(`Privado ${sufijo}`);
  });

  it('la búsqueda por cuenta solo ve la organización del actor', async () => {
    const mio = valor(
      await nuevo(admin, `Buscable ${sufijo}`, [{ platform: 'instagram', handle: h('buscable') }]),
    );
    const propio = valor(await buscarInfluencerPorCuenta(admin, 'instagram', h('buscable')));
    expect(propio?.influencer.id).toBe(mio.influencer.id);
    expect(valor(await buscarInfluencerPorCuenta(ajeno, 'instagram', h('buscable')))).toBeUndefined();
  });

  it('el mismo handle en otra organización es otra identidad y no choca', async () => {
    const delAdmin = valor(
      await nuevo(admin, `Gemelo A ${sufijo}`, [{ platform: 'instagram', handle: h('gemelo') }]),
    );
    const delAjeno = valor(
      await nuevo(ajeno, `Gemelo B ${sufijo}`, [{ platform: 'instagram', handle: h('gemelo') }]),
    );
    expect(delAdmin.influencer.organizationId).not.toBe(delAjeno.influencer.organizationId);
    expect(valor(await buscarInfluencerPorCuenta(ajeno, 'instagram', h('gemelo')))?.influencer.id).toBe(
      delAjeno.influencer.id,
    );
  });

  it('la base impide asociar una cuenta a un influencer de otra organización', async () => {
    const mio = valor(await nuevo(admin, `FK ${sufijo}`));
    await expect(
      query(
        `INSERT INTO influencer_accounts (influencer_id, organization_id, platform, handle, normalized_handle)
         VALUES ($1, $2, 'instagram', $3, $3)`,
        [mio.influencer.id, ajeno.organizationId, h('fk')],
      ),
    ).rejects.toThrow(/influencer_accounts_influencer_fkey/);
  });
});

// ─────────────────────────── Roles ─────────────────────────────────────────────

describe('permisos', () => {
  it('Operativo, analista, legal y cliente no crean ni gestionan identidades', async () => {
    const existente = valor(
      await nuevo(admin, `Gestionable ${sufijo}`, [{ platform: 'instagram', handle: h('gest') }]),
    );
    const cuentaId = existente.accounts[0]!.id;
    for (const actor of [operativo, analista, legal, cliente]) {
      expect(codigo(await crearInfluencer(actor, { displayName: `Intruso ${sufijo}` })), actor.role).toBe(
        'FORBIDDEN_ROLE',
      );
      expect(
        codigo(await actualizarInfluencer(actor, existente.influencer.id, { displayName: 'x' })),
        actor.role,
      ).toMatch(/FORBIDDEN_ROLE|RESOURCE_NOT_FOUND/);
      expect(
        codigo(await agregarCuenta(actor, existente.influencer.id, { platform: 'tiktok', handle: h('z') })),
      ).toMatch(/FORBIDDEN_ROLE|RESOURCE_NOT_FOUND/);
      expect(codigo(await actualizarCuenta(actor, cuentaId, { handle: h('nuevo') }))).toMatch(
        /FORBIDDEN_ROLE|RESOURCE_NOT_FOUND/,
      );
    }
    const intrusos = await query(`SELECT 1 FROM influencers WHERE display_name = $1`, [`Intruso ${sufijo}`]);
    expect(intrusos).toHaveLength(0);
  });

  it('Operativo gana lectura pero no gestión (FORBIDDEN_ROLE explícito)', async () => {
    const existente = valor(await nuevo(admin, `Solo lectura ${sufijo}`));
    expect(codigo(await actualizarInfluencer(operativo, existente.influencer.id, { displayName: 'x' }))).toBe(
      'FORBIDDEN_ROLE',
    );
    expect(codigo(await crearInfluencer(operativo, { displayName: 'x' }))).toBe('FORBIDDEN_ROLE');
  });

  it('analista y legal no leen; el cliente no obtiene acceso interno nuevo', async () => {
    const existente = valor(await nuevo(admin, `Interno ${sufijo}`));
    for (const actor of [analista, legal]) {
      expect(codigo(await listarInfluencers(actor)), actor.role).toBe('FORBIDDEN_ROLE');
      expect(codigo(await obtenerInfluencer(actor, existente.influencer.id)), actor.role).toBe(
        'FORBIDDEN_ROLE',
      );
    }
    expect(codigo(await listarInfluencers(cliente))).toBe('FORBIDDEN_ROLE');
    // Es de otra organización: ni siquiera se revela que el recurso existe.
    expect(codigo(await obtenerInfluencer(cliente, existente.influencer.id))).toBe('RESOURCE_NOT_FOUND');
    expect(codigo(await buscarInfluencerPorCuenta(cliente, 'instagram', 'x'))).toBe('FORBIDDEN_ROLE');
  });

  it('el actor «system» no obtiene mutaciones: solo las ejecuta una persona', async () => {
    const sistema = 'system' as unknown as User;
    const existente = valor(
      await nuevo(admin, `Sin sistema ${sufijo}`, [{ platform: 'instagram', handle: h('sys') }]),
    );
    expect(codigo(await crearInfluencer(sistema, { displayName: 'x' }))).toBe('FORBIDDEN_ROLE');
    expect(codigo(await actualizarInfluencer(sistema, existente.influencer.id, { displayName: 'x' }))).toBe(
      'FORBIDDEN_ROLE',
    );
    expect(
      codigo(await agregarCuenta(sistema, existente.influencer.id, { platform: 'tiktok', handle: 'x' })),
    ).toBe('FORBIDDEN_ROLE');
    expect(codigo(await actualizarCuenta(sistema, existente.accounts[0]!.id, { handle: 'x' }))).toBe(
      'FORBIDDEN_ROLE',
    );
  });

  it('una persona no puede registrarse con origen «system»', async () => {
    const r = await crearInfluencer(admin, { displayName: `Origen ${sufijo}` }, { origin: 'system' });
    expect(codigo(r)).toBe('FORBIDDEN_ROLE');
  });
});

// ─────────────────────────── Cuentas por plataforma ────────────────────────────

describe('cuentas por plataforma', () => {
  it('un influencer tiene varias cuentas en distintas plataformas', async () => {
    const creado = valor(
      await nuevo(admin, `Multiplataforma ${sufijo}`, [
        { platform: 'instagram', handle: `@${h('Valentina')}` },
        { platform: 'tiktok', handle: h('valentina.rojas'), profileUrl: 'https://tiktok.com/@x' },
      ]),
    );
    await agregarCuenta(admin, creado.influencer.id, { platform: 'youtube', handle: h('ValentinaRojas') });

    const leido = valor(await obtenerInfluencer(admin, creado.influencer.id));
    expect(leido.accounts.map((c) => c.platform).sort()).toEqual(['instagram', 'tiktok', 'youtube']);
  });

  it('el handle se normaliza: sin @, sin distinguir mayúsculas; se conserva cómo se escribió', async () => {
    const creado = valor(
      await nuevo(admin, `Normalizada ${sufijo}`, [{ platform: 'instagram', handle: `@${h('MiXtA')}` }]),
    );
    const cuenta = creado.accounts[0]!;
    expect(cuenta.handle).toBe(h('MiXtA'));
    expect(cuenta.normalizedHandle).toBe(h('mixta'));
    const encontrado = valor(await buscarInfluencerPorCuenta(admin, 'instagram', `  @${h('MIXTA')} `));
    expect(encontrado?.influencer.id).toBe(creado.influencer.id);
  });

  it('la misma cuenta (plataforma + handle normalizado) no se registra dos veces en la organización', async () => {
    const primero = valor(
      await nuevo(admin, `Dueña ${sufijo}`, [{ platform: 'instagram', handle: h('unica') }]),
    );
    const otro = valor(await nuevo(admin, `Otra ${sufijo}`));

    const repetida = await agregarCuenta(admin, otro.influencer.id, {
      platform: 'instagram',
      handle: `@${h('UNICA')}`,
    });
    expect(codigo(repetida)).toBe('RESOURCE_CONFLICT');
    if (!repetida.ok) {
      expect(repetida.error.details).toMatchObject({
        reason: 'account_exists',
        influencerId: primero.influencer.id,
      });
    }
    // Tampoco al crear.
    expect(
      codigo(
        await crearInfluencer(consultor, {
          displayName: `Tercera ${sufijo}`,
          cuentas: [{ platform: 'instagram', handle: h('unica') }],
        }),
      ),
    ).toBe('RESOURCE_CONFLICT');
  });

  it('un conflicto al crear no deja un influencer a medias ni auditoría huérfana', async () => {
    const existente = valor(
      await nuevo(admin, `Previa ${sufijo}`, [{ platform: 'tiktok', handle: h('previa') }]),
    );
    expect(existente.accounts).toHaveLength(1);
    const nombre = `Fallida ${sufijo}`;
    const r = await crearInfluencer(admin, {
      displayName: nombre,
      cuentas: [
        { platform: 'instagram', handle: h('nueva-ok') },
        { platform: 'tiktok', handle: h('PREVIA') },
      ],
    });
    expect(codigo(r)).toBe('RESOURCE_CONFLICT');
    expect(await query(`SELECT 1 FROM influencers WHERE display_name = $1`, [nombre])).toHaveLength(0);
    expect(
      await query(`SELECT 1 FROM influencer_accounts WHERE normalized_handle = $1`, [h('nueva-ok')]),
    ).toHaveLength(0);
  });

  it('la misma cuenta repetida dentro de una solicitud se rechaza', async () => {
    const r = await crearInfluencer(admin, {
      displayName: `Repetida ${sufijo}`,
      cuentas: [
        { platform: 'instagram', handle: h('rep') },
        { platform: 'instagram', handle: `@${h('REP')}` },
      ],
    });
    expect(codigo(r)).toBe('RESOURCE_CONFLICT');
  });

  it('el mismo handle en plataformas distintas sí puede existir', async () => {
    const a = valor(await nuevo(admin, `Plat A ${sufijo}`, [{ platform: 'instagram', handle: h('mismo') }]));
    const b = valor(await nuevo(admin, `Plat B ${sufijo}`, [{ platform: 'tiktok', handle: h('mismo') }]));
    expect(a.accounts[0]!.normalizedHandle).toBe(b.accounts[0]!.normalizedHandle);
  });

  it('dos personas con el mismo nombre y sin cuentas pueden coexistir (sin deduplicar por nombre)', async () => {
    const a = valor(await nuevo(admin, `Sin cuentas ${sufijo}`));
    const b = valor(await nuevo(admin, `Sin cuentas ${sufijo}`));
    expect(a.influencer.id).not.toBe(b.influencer.id);
  });

  it('rechaza handles y URLs inválidos', async () => {
    const creado = valor(await nuevo(admin, `Validación ${sufijo}`));
    for (const handle of ['', '@', 'con espacio', 'a/b', 'https://instagram.com/x']) {
      expect(
        codigo(await agregarCuenta(admin, creado.influencer.id, { platform: 'instagram', handle })),
      ).toBe('VALIDATION_FAILED');
    }
    expect(
      codigo(
        await agregarCuenta(admin, creado.influencer.id, {
          platform: 'instagram',
          handle: h('urlmala'),
          profileUrl: 'javascript:alert(1)',
        }),
      ),
    ).toBe('VALIDATION_FAILED');
  });

  it('la base vigila la normalización aunque se salte la aplicación', async () => {
    const creado = valor(await nuevo(admin, `Bypass ${sufijo}`));
    for (const normalizado of ['@x', 'CON_MAYUS', 'con espacio', '']) {
      await expect(
        query(
          `INSERT INTO influencer_accounts (influencer_id, organization_id, platform, handle, normalized_handle)
           VALUES ($1, $2, 'instagram', 'x', $3)`,
          [creado.influencer.id, admin.organizationId, normalizado],
        ),
      ).rejects.toThrow();
    }
  });

  it('actualizar una cuenta cambia el handle, recalcula la clave y audita antes/después', async () => {
    const creado = valor(
      await nuevo(admin, `Cambio ${sufijo}`, [{ platform: 'instagram', handle: h('viejo') }]),
    );
    const cuenta = creado.accounts[0]!;
    const nuevaCuenta = valor(
      await actualizarCuenta(consultor, cuenta.id, {
        handle: `@${h('Nuevo')}`,
        profileUrl: 'https://instagram.com/n',
      }),
    );
    expect(nuevaCuenta.normalizedHandle).toBe(h('nuevo'));
    expect(nuevaCuenta.profileUrl).toBe('https://instagram.com/n');

    const eventos = (await auditoria(cuenta.id)).filter((e) => e.action === 'influencer_account.update');
    expect(eventos).toHaveLength(1);
    expect(eventos[0]!.metadata).toMatchObject({
      influencerId: creado.influencer.id,
      platform: 'instagram',
      handleAnterior: h('viejo'),
      handleNuevo: h('Nuevo'),
      normalizedNuevo: h('nuevo'),
    });
    // El handle viejo queda libre; el nuevo ya no se puede registrar de nuevo.
    expect(valor(await buscarInfluencerPorCuenta(admin, 'instagram', h('viejo')))).toBeUndefined();
    const otro = valor(await nuevo(admin, `Otro ${sufijo}`));
    expect(
      codigo(await agregarCuenta(admin, otro.influencer.id, { platform: 'instagram', handle: h('nuevo') })),
    ).toBe('RESOURCE_CONFLICT');
  });

  it('actualizar una cuenta hacia un handle que ya tiene otra se rechaza; sin cambios no audita', async () => {
    const a = valor(await nuevo(admin, `Cuenta A ${sufijo}`, [{ platform: 'x', handle: h('aa') }]));
    valor(await nuevo(admin, `Cuenta B ${sufijo}`, [{ platform: 'x', handle: h('bb') }]));
    const cuentaA = a.accounts[0]!;
    expect(codigo(await actualizarCuenta(admin, cuentaA.id, { handle: `@${h('BB')}` }))).toBe(
      'RESOURCE_CONFLICT',
    );

    valor(await actualizarCuenta(admin, cuentaA.id, { handle: `@${h('aa')}` })); // mismo valor
    expect(
      (await auditoria(cuentaA.id)).filter((e) => e.action === 'influencer_account.update'),
    ).toHaveLength(0);
    expect(codigo(await actualizarCuenta(admin, cuentaA.id, {}))).toBe('VALIDATION_FAILED');
  });

  it('una cuenta no cambia de influencer ni de plataforma (identidad inmutable en la base)', async () => {
    const a = valor(await nuevo(admin, `Fija A ${sufijo}`, [{ platform: 'instagram', handle: h('fija') }]));
    const b = valor(await nuevo(admin, `Fija B ${sufijo}`));
    await expect(
      query(`UPDATE influencer_accounts SET influencer_id = $2 WHERE id = $1`, [
        a.accounts[0]!.id,
        b.influencer.id,
      ]),
    ).rejects.toThrow(/no se modifican/);
    await expect(
      query(`UPDATE influencer_accounts SET platform = 'tiktok' WHERE id = $1`, [a.accounts[0]!.id]),
    ).rejects.toThrow(/no se modifican/);
  });
});

// ─────────────────────────── Auditoría ─────────────────────────────────────────

describe('auditoría', () => {
  it('crear, y cada cuenta añadida, quedan registrados con origen ui y el actor', async () => {
    const creado = valor(
      await nuevo(consultor, `Auditado ${sufijo}`, [{ platform: 'instagram', handle: h('audit') }]),
    );
    const eventosInfluencer = await auditoria(creado.influencer.id);
    expect(eventosInfluencer.map((e) => e.action)).toEqual(['influencer.create']);
    expect(eventosInfluencer[0]).toMatchObject({
      entity_type: 'influencer',
      origin: 'ui',
      actor_id: consultor.id,
    });

    const eventosCuenta = await auditoria(creado.accounts[0]!.id);
    expect(eventosCuenta.map((e) => e.action)).toEqual(['influencer_account.add']);
    expect(eventosCuenta[0]!.metadata).toMatchObject({
      influencerId: creado.influencer.id,
      platform: 'instagram',
      normalizedHandle: h('audit'),
    });
  });

  it('la correlación futura (conversación, mensaje…) viaja al registro', async () => {
    const r = valor(
      await crearInfluencer(
        admin,
        { displayName: `Correlada ${sufijo}` },
        { correlation: { conversationId: 'conv-1', messageId: 'msg-1' } },
      ),
    );
    const [evento] = await auditoria(r.influencer.id);
    expect(evento!.correlation).toEqual({ conversationId: 'conv-1', messageId: 'msg-1' });
    expect(evento!.origin).toBe('ui');
  });

  it('la auditoría sigue siendo de solo inserción', async () => {
    const creado = valor(await nuevo(admin, `Inmutable ${sufijo}`));
    await expect(
      query(`UPDATE audit_events SET action = 'x' WHERE entity_id = $1`, [creado.influencer.id]),
    ).rejects.toThrow(/solo inserción/);
    await expect(
      query(`DELETE FROM audit_events WHERE entity_id = $1`, [creado.influencer.id]),
    ).rejects.toThrow(/solo inserción/);
  });

  it('una colisión concurrente por la misma cuenta deja un solo ganador y nada a medias', async () => {
    const handle = h('carrera');
    const resultados = await Promise.all(
      [1, 2, 3].map((n) =>
        crearInfluencer(admin, {
          displayName: `Carrera ${n} ${sufijo}`,
          cuentas: [{ platform: 'twitch', handle }],
        }),
      ),
    );
    const ganadores = resultados.filter((r) => r.ok);
    expect(ganadores).toHaveLength(1);
    for (const r of resultados.filter((x) => !x.ok)) expect(codigo(r)).toBe('RESOURCE_CONFLICT');

    // Los perdedores se revirtieron enteros: ni influencer ni cuenta ni auditoría.
    const filas = await query(`SELECT 1 FROM influencers WHERE display_name LIKE $1`, [
      `Carrera % ${sufijo}`,
    ]);
    expect(filas).toHaveLength(1);
    const cuentas = await query(`SELECT 1 FROM influencer_accounts WHERE normalized_handle = $1`, [handle]);
    expect(cuentas).toHaveLength(1);
    const creaciones = await query(
      `SELECT 1 FROM audit_events e JOIN influencers i ON i.id = e.entity_id
        WHERE e.action = 'influencer.create' AND i.display_name LIKE $1`,
      [`Carrera % ${sufijo}`],
    );
    expect(creaciones).toHaveLength(1);
    const huerfanas = await query(
      `SELECT 1 FROM audit_events WHERE action = 'influencer.create' AND metadata->>'displayName' LIKE $1`,
      [`Carrera % ${sufijo}`],
    );
    expect(huerfanas).toHaveLength(1);
  });
});

// ─────────────────────────── Historia ──────────────────────────────────────────

describe('no se borra la historia', () => {
  it('influencers y cuentas no admiten DELETE directo (solo el bypass de bases _test)', async () => {
    const creado = valor(
      await nuevo(admin, `Perenne ${sufijo}`, [{ platform: 'instagram', handle: h('perenne') }]),
    );
    await expect(
      query(`DELETE FROM influencer_accounts WHERE id = $1`, [creado.accounts[0]!.id]),
    ).rejects.toThrow(/no admite DELETE/);
    await expect(query(`DELETE FROM influencers WHERE id = $1`, [creado.influencer.id])).rejects.toThrow(
      /no admite DELETE/,
    );
  });

  it('la organización y el creador de un influencer no se reasignan', async () => {
    const creado = valor(await nuevo(admin, `Anclada ${sufijo}`));
    await expect(
      query(`UPDATE influencers SET organization_id = $2 WHERE id = $1`, [
        creado.influencer.id,
        ajeno.organizationId,
      ]),
    ).rejects.toThrow();
  });
});
