/**
 * V2 · Fase 8 — datos personales del KOL (`pii.ts`): cifrado en la aplicación, versiones, aislamiento,
 * `pii:read` explícito, auditoría sin valores, AAD y rotación de claves. Todo sintético.
 */

import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type User } from '@tcl-kol-os/domain';
import { closePool, query } from './client.ts';
import { crearInfluencer } from './influencers.ts';
import {
  cargarAnilloDeClavesPii,
  cifrarCampoPii,
  descifrarCampoPii,
  guardarPii,
  indiceCiegoDeDocumento,
  obtenerPiiResumen,
  revelarPii,
} from './pii.ts';
import {
  type EscenarioDeContenido,
  crearEscenarioDeContenido,
  eliminarInfluencersDePrueba,
  limpiarEscenarioDeContenido,
} from './test-utils.ts';

let e: EscenarioDeContenido;
const extras: string[] = [];
const ajenos: string[] = [];

/** Cédula sintética única por llamada (no choca con corridas anteriores). */
const cedula = (): string =>
  `9${Math.floor(Math.random() * 1e9)
    .toString()
    .padStart(9, '0')}`;
const telefono = (): string =>
  `+57300${Math.floor(Math.random() * 1e7)
    .toString()
    .padStart(7, '0')}`;
const direccion = (etiqueta: string): string => `Calle ${etiqueta} 45 # 12-34 Apto 501 Bogotá`;

async function nuevoInfluencer(dueno: User, lista: string[]): Promise<string> {
  const sufijo = randomBytes(4).toString('hex');
  const r = await crearInfluencer(dueno, {
    displayName: `PII ${sufijo}`,
    cuentas: [{ platform: 'instagram', handle: `pii.${sufijo}` }],
  });
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  lista.push(r.value.influencer.id);
  return r.value.influencer.id;
}

const KEY_PRUEBA = Buffer.alloc(32, 0x11).toString('base64');
const KEY_NUEVA = Buffer.alloc(32, 0x33).toString('base64');
const ENTORNO_ORIGINAL = {
  keys: process.env['PII_ENCRYPTION_KEYS'],
  index: process.env['PII_INDEX_KEY'],
};

function restaurarEntorno(): void {
  for (const [nombre, valor] of [
    ['PII_ENCRYPTION_KEYS', ENTORNO_ORIGINAL.keys],
    ['PII_INDEX_KEY', ENTORNO_ORIGINAL.index],
  ] as const) {
    if (valor === undefined) delete process.env[nombre];
    else process.env[nombre] = valor;
  }
}

beforeAll(async () => {
  e = await crearEscenarioDeContenido('F8 PII');
});

afterEach(restaurarEntorno);

afterAll(async () => {
  restaurarEntorno();
  await limpiarEscenarioDeContenido(e);
  await eliminarInfluencersDePrueba([...extras, ...ajenos]);
  await closePool();
});

function ok<T>(r: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}

describe('configuración (sin valores por defecto)', () => {
  it('sin claves: PII_NOT_CONFIGURED y no se escribe nada', async () => {
    const influencerId = await nuevoInfluencer(e.admin, extras);
    delete process.env['PII_ENCRYPTION_KEYS'];
    const r = await guardarPii(e.admin, { influencerId, phone: telefono() });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('VALIDATION_FAILED');
      expect(r.error.details?.['reason']).toBe('PII_NOT_CONFIGURED');
    }
    const filas = await query(`SELECT 1 FROM influencer_pii_records WHERE influencer_id = $1`, [
      influencerId,
    ]);
    expect(filas).toHaveLength(0);

    delete process.env['PII_INDEX_KEY'];
    expect(() => cargarAnilloDeClavesPii()).toThrow(/no está configurado/u);
  });

  it('rechaza claves mal formadas o de longitud incorrecta', () => {
    expect(() =>
      cargarAnilloDeClavesPii({ PII_ENCRYPTION_KEYS: 'k1:%%%', PII_INDEX_KEY: KEY_PRUEBA }),
    ).toThrow();
    expect(() =>
      cargarAnilloDeClavesPii({
        PII_ENCRYPTION_KEYS: `k1:${Buffer.alloc(16, 1).toString('base64')}`,
        PII_INDEX_KEY: KEY_PRUEBA,
      }),
    ).toThrow(/32 bytes/u);
    expect(() =>
      cargarAnilloDeClavesPii({ PII_ENCRYPTION_KEYS: `k1:${KEY_PRUEBA}`, PII_INDEX_KEY: 'AAAA' }),
    ).toThrow(/PII_INDEX_KEY/u);
  });
});

describe('guardar: cifrado, versiones y duplicados', () => {
  it('el texto cifrado en la base no contiene el texto plano; versiones append-only; se conserva lo no enviado', async () => {
    const influencerId = await nuevoInfluencer(e.admin, extras);
    const doc = cedula();
    const tel = telefono();
    const dir = direccion('Sentinela');

    const v1 = ok(await guardarPii(e.admin, { influencerId, documentId: doc, phone: tel, address: dir }));
    expect(v1.replayed).toBe(false);
    expect(v1.record).toMatchObject({ version: 1, hasDocumentId: true, hasPhone: true, hasAddress: true });

    const [fila] = await query<{
      document_id_enc: Buffer;
      phone_enc: Buffer;
      address_enc: Buffer;
      key_id: string;
      blind_index: Buffer;
    }>(`SELECT * FROM influencer_pii_records WHERE id = $1`, [v1.record.recordId]);
    for (const [campo, plano] of [
      [fila!.document_id_enc, doc],
      [fila!.phone_enc, tel],
      [fila!.address_enc, dir],
    ] as const) {
      expect(campo[0]).toBe(1);
      expect(campo.length).toBeGreaterThanOrEqual(29);
      expect(campo.includes(Buffer.from(plano, 'utf8'))).toBe(false);
      expect(campo.toString('latin1')).not.toContain(plano);
    }
    expect(fila!.blind_index).toHaveLength(32);
    expect(fila!.blind_index.includes(Buffer.from(doc))).toBe(false);

    // Solo el teléfono cambia: nueva versión, y cédula y dirección se conservan (re-cifradas bajo el id nuevo).
    const nuevoTel = telefono();
    const v2 = ok(await guardarPii(e.admin, { influencerId, phone: nuevoTel }));
    expect(v2.replayed).toBe(false);
    expect(v2.record.version).toBe(2);
    expect(v2.record.recordId).not.toBe(v1.record.recordId);
    expect(v2.record).toMatchObject({ hasDocumentId: true, hasPhone: true, hasAddress: true });
    const revelado = ok(await revelarPii(e.admin, v2.record.recordId, ['document_id', 'phone', 'address']));
    expect(revelado.values).toEqual({ document_id: doc, phone: nuevoTel, address: dir });
    // La versión 1 sigue ahí, intacta.
    const antigua = ok(await revelarPii(e.admin, v1.record.recordId, ['phone']));
    expect(antigua.values).toEqual({ phone: tel });
    const [n] = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM influencer_pii_records WHERE influencer_id = $1`,
      [influencerId],
    );
    expect(n!.n).toBe('2');
  });

  it('repetir el mismo contenido es idempotente (no crea versión)', async () => {
    const influencerId = await nuevoInfluencer(e.admin, extras);
    const doc = cedula();
    const primera = ok(
      await guardarPii(e.admin, { influencerId, documentId: doc, idempotencyKey: 'reintento-1' }),
    );
    // Mismo documento escrito con separadores: se normaliza al mismo valor.
    const formateada = `${doc.slice(0, 1)}.${doc.slice(1, 4)}.${doc.slice(4)}`;
    const repetida = ok(
      await guardarPii(e.admin, { influencerId, documentId: formateada, idempotencyKey: 'reintento-1' }),
    );
    expect(repetida.replayed).toBe(true);
    expect(repetida.record.recordId).toBe(primera.record.recordId);
    expect(repetida.record.version).toBe(1);
  });

  it('valida la entrada y la clave de idempotencia', async () => {
    const influencerId = await nuevoInfluencer(e.admin, extras);
    const vacio = await guardarPii(e.admin, { influencerId });
    expect(vacio.ok).toBe(false);
    if (!vacio.ok) expect(vacio.error.code).toBe('VALIDATION_FAILED');
    const malDoc = await guardarPii(e.admin, { influencerId, documentId: '12' });
    expect(malDoc.ok).toBe(false);
    const malClave = await guardarPii(e.admin, { influencerId, phone: telefono(), idempotencyKey: ' ' });
    expect(malClave.ok).toBe(false);
  });

  it('cédula duplicada en la organización ⇒ RESOURCE_CONFLICT, sin crear registro ni filtrar al otro influencer', async () => {
    const a = await nuevoInfluencer(e.admin, extras);
    const b = await nuevoInfluencer(e.admin, extras);
    const doc = cedula();
    ok(await guardarPii(e.admin, { influencerId: a, documentId: doc }));
    const r = await guardarPii(e.admin, {
      influencerId: b,
      documentId: `${doc.slice(0, 3)}-${doc.slice(3)}`,
      phone: telefono(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('RESOURCE_CONFLICT');
      expect(r.error.details?.['reason']).toBe('duplicate_document');
      expect(JSON.stringify(r.error)).not.toContain(a);
      expect(JSON.stringify(r.error)).not.toContain(doc);
    }
    const filas = await query(`SELECT 1 FROM influencer_pii_records WHERE influencer_id = $1`, [b]);
    expect(filas).toHaveLength(0);
    // El mismo influencer sí puede volver a guardar su propia cédula junto con otro dato.
    const propio = ok(await guardarPii(e.admin, { influencerId: a, documentId: doc, phone: telefono() }));
    expect(propio.record.version).toBe(2);
    // Una cédula de OTRA organización no choca.
    const ajeno = await nuevoInfluencer(e.ajeno, ajenos);
    ok(await guardarPii(e.ajeno, { influencerId: ajeno, documentId: doc }));
  });

  it('el trigger de la base también rechaza la cédula duplicada (respaldo)', async () => {
    const a = await nuevoInfluencer(e.admin, extras);
    const b = await nuevoInfluencer(e.admin, extras);
    const doc = cedula();
    ok(await guardarPii(e.admin, { influencerId: a, documentId: doc }));
    const anillo = cargarAnilloDeClavesPii();
    const id = '00000000-0000-4000-8000-0000000000aa';
    const sobre = cifrarCampoPii(anillo, { recordId: id, field: 'document_id', plaintext: doc });
    await expect(
      query(
        `INSERT INTO influencer_pii_records (id, organization_id, influencer_id, document_id_enc, key_id, blind_index, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          id,
          e.admin.organizationId,
          b,
          sobre.envoltorio,
          sobre.keyId,
          indiceCiegoDeDocumento(anillo, doc),
          e.admin.id,
        ],
      ),
    ).rejects.toThrow(/cédula ya está registrada/u);
  });
});

describe('autorización y aislamiento', () => {
  it('shipment:manage (director) sin pii:read no guarda, no revela ni lee el resumen', async () => {
    const influencerId = await nuevoInfluencer(e.admin, extras);
    const guardado = ok(await guardarPii(e.admin, { influencerId, address: direccion('Director') }));

    const guardar = await guardarPii(e.director, { influencerId, phone: telefono() });
    expect(guardar.ok).toBe(false);
    if (!guardar.ok) expect(guardar.error.code).toBe('FORBIDDEN_ROLE');

    const revelar = await revelarPii(e.director, guardado.record.recordId, ['address']);
    expect(revelar.ok).toBe(false);
    if (!revelar.ok) expect(revelar.error.code).toBe('FORBIDDEN_ROLE');

    const resumen = await obtenerPiiResumen(e.director, influencerId);
    expect(resumen.ok).toBe(false);
    if (!resumen.ok) expect(resumen.error.code).toBe('FORBIDDEN_ROLE');
  });

  it('consultor: FORBIDDEN_ROLE; cliente y otra organización: RESOURCE_NOT_FOUND', async () => {
    const influencerId = await nuevoInfluencer(e.admin, extras);
    const guardado = ok(await guardarPii(e.admin, { influencerId, phone: telefono() }));
    const recordId = guardado.record.recordId;

    for (const [actor, esperado] of [
      [e.consultor, 'FORBIDDEN_ROLE'],
      [e.cliente, 'RESOURCE_NOT_FOUND'],
      [e.ajeno, 'RESOURCE_NOT_FOUND'],
    ] as const) {
      const g = await guardarPii(actor, { influencerId, phone: telefono() });
      expect(g.ok ? 'ok' : g.error.code).toBe(esperado);
      const r = await revelarPii(actor, recordId, ['phone']);
      expect(r.ok ? 'ok' : r.error.code).toBe(esperado);
      const s = await obtenerPiiResumen(actor, influencerId);
      expect(s.ok ? 'ok' : s.error.code).toBe(esperado);
    }
    // Ids inexistentes o mal formados: nunca revelan más que el rol.
    const inexistente = '00000000-0000-4000-8000-000000000001';
    for (const id of [inexistente, 'no-es-uuid']) {
      const adminR = await revelarPii(e.admin, id, ['phone']);
      expect(adminR.ok ? 'ok' : adminR.error.code).toBe('RESOURCE_NOT_FOUND');
      const consultorR = await revelarPii(e.consultor, id, ['phone']);
      expect(consultorR.ok ? 'ok' : consultorR.error.code).toBe('FORBIDDEN_ROLE');
      const clienteR = await guardarPii(e.cliente, { influencerId: id, phone: telefono() });
      expect(clienteR.ok ? 'ok' : clienteR.error.code).toBe('RESOURCE_NOT_FOUND');
    }
  });

  it('el operativo (pii:read y pii:manage) guarda y revela solo lo pedido; el resumen no trae valores', async () => {
    const influencerId = await nuevoInfluencer(e.admin, extras);
    const doc = cedula();
    const dir = direccion('Operativo');
    const g = ok(
      await guardarPii(e.operativo, { influencerId, documentId: doc, address: dir, phone: telefono() }),
    );

    const soloDireccion = ok(await revelarPii(e.operativo, g.record.recordId, ['address']));
    expect(soloDireccion.values).toEqual({ address: dir });
    expect(Object.keys(soloDireccion.values)).toEqual(['address']);

    const resumen = ok(await obtenerPiiResumen(e.operativo, influencerId));
    expect(resumen).toMatchObject({
      recordId: g.record.recordId,
      version: 1,
      hasDocumentId: true,
      hasPhone: true,
      hasAddress: true,
      erased: false,
    });
    expect(JSON.stringify(resumen)).not.toContain(doc);
    expect(JSON.stringify(resumen)).not.toContain(dir);
    expect(ok(await obtenerPiiResumen(e.admin, await nuevoInfluencer(e.admin, extras)))).toBeNull();

    const sinCampos = await revelarPii(e.operativo, g.record.recordId, []);
    expect(sinCampos.ok).toBe(false);
    const campoRaro = await revelarPii(e.operativo, g.record.recordId, ['email' as never]);
    expect(campoRaro.ok).toBe(false);
  });
});

describe('auditoría sin valores', () => {
  it('ningún audit_events.metadata ni ai_runs contiene la cédula, el teléfono ni la dirección', async () => {
    const influencerId = await nuevoInfluencer(e.admin, extras);
    const doc = cedula();
    const tel = telefono();
    const dir = direccion('Centinela Única');
    const g = ok(await guardarPii(e.admin, { influencerId, documentId: doc, phone: tel, address: dir }));
    ok(await revelarPii(e.admin, g.record.recordId, ['document_id', 'address']));
    ok(await revelarPii(e.operativo, g.record.recordId, ['phone']));

    const eventos = await query<{ action: string; metadata: Record<string, unknown>; entity_id: string }>(
      `SELECT action, metadata, entity_id FROM audit_events WHERE entity_id = $1 ORDER BY created_at`,
      [g.record.recordId],
    );
    expect(eventos.map((x) => x.action)).toEqual(['pii.save', 'pii.reveal', 'pii.reveal']);
    expect(eventos[1]!.metadata).toMatchObject({ fields: ['document_id', 'address'], version: 1 });
    expect(eventos[2]!.metadata['fields']).toEqual(['phone']);

    const centinelas = [doc, tel, dir, 'Centinela', doc.slice(0, 1) + '.' + doc.slice(1, 4)];
    for (const centinela of centinelas) {
      const enAuditoria = await query(
        `SELECT 1 FROM audit_events WHERE metadata::text ILIKE '%' || $1 || '%' OR action ILIKE '%' || $1 || '%'`,
        [centinela],
      );
      expect(enAuditoria).toHaveLength(0);
      const enRuns = await query(`SELECT 1 FROM ai_runs r WHERE r::text ILIKE '%' || $1 || '%'`, [centinela]);
      expect(enRuns).toHaveLength(0);
    }
  });

  it('un revelado que falla no deja un rastro de revelado (misma transacción)', async () => {
    const influencerId = await nuevoInfluencer(e.admin, extras);
    const g = ok(await guardarPii(e.admin, { influencerId, phone: telefono() }));
    // Sin la clave con la que se cifró no se revela nada y tampoco se audita un revelado.
    process.env['PII_ENCRYPTION_KEYS'] = `otra:${KEY_NUEVA}`;
    const r = await revelarPii(e.admin, g.record.recordId, ['phone']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.details?.['reason']).toBe('PII_KEY_UNAVAILABLE');
    const rastro = await query(`SELECT 1 FROM audit_events WHERE entity_id = $1 AND action = 'pii.reveal'`, [
      g.record.recordId,
    ]);
    expect(rastro).toHaveLength(0);
  });
});

describe('AAD: el texto cifrado queda atado a su registro, campo y clave', () => {
  it('primitivas: otro registro, otro campo u otra clave no descifran', () => {
    const anillo = cargarAnilloDeClavesPii();
    const id = '11111111-1111-4111-8111-111111111111';
    const otro = '22222222-2222-4222-8222-222222222222';
    const { envoltorio, keyId } = cifrarCampoPii(anillo, {
      recordId: id,
      field: 'phone',
      plaintext: '+573001234567',
    });
    expect(descifrarCampoPii(anillo, { recordId: id, field: 'phone', keyId, envoltorio })).toBe(
      '+573001234567',
    );
    expect(() => descifrarCampoPii(anillo, { recordId: otro, field: 'phone', keyId, envoltorio })).toThrow();
    expect(() => descifrarCampoPii(anillo, { recordId: id, field: 'address', keyId, envoltorio })).toThrow();
    const anilloConOtra = cargarAnilloDeClavesPii({
      PII_ENCRYPTION_KEYS: `${keyId}:${KEY_NUEVA}`,
      PII_INDEX_KEY: KEY_PRUEBA,
    });
    expect(() =>
      descifrarCampoPii(anilloConOtra, { recordId: id, field: 'phone', keyId, envoltorio }),
    ).toThrow();
    // Un byte alterado tampoco autentica.
    const alterado = Buffer.from(envoltorio);
    alterado[alterado.length - 1] = alterado[alterado.length - 1]! ^ 0xff;
    expect(() =>
      descifrarCampoPii(anillo, { recordId: id, field: 'phone', keyId, envoltorio: alterado }),
    ).toThrow();
    // Texto plano (sin envoltorio) se rechaza.
    expect(() =>
      descifrarCampoPii(anillo, {
        recordId: id,
        field: 'phone',
        keyId,
        envoltorio: Buffer.from('+573001234567'),
      }),
    ).toThrow();
  });

  it('en la base: un texto cifrado copiado a otro registro o a otro campo falla al revelar', async () => {
    const origen = await nuevoInfluencer(e.admin, extras);
    const destino = await nuevoInfluencer(e.admin, extras);
    const g = ok(await guardarPii(e.admin, { influencerId: origen, phone: telefono() }));
    const [fila] = await query<{ phone_enc: Buffer; key_id: string }>(
      `SELECT phone_enc, key_id FROM influencer_pii_records WHERE id = $1`,
      [g.record.recordId],
    );
    // Registro de otro influencer con el MISMO texto cifrado, en el mismo campo y en otro campo.
    const [enTelefono] = await query<{ id: string }>(
      `INSERT INTO influencer_pii_records (organization_id, influencer_id, phone_enc, key_id, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [e.admin.organizationId, destino, fila!.phone_enc, fila!.key_id, e.admin.id],
    );
    const r1 = await revelarPii(e.admin, enTelefono!.id, ['phone']);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error.details?.['reason']).toBe('PII_DECRYPT_FAILED');

    const otroDestino = await nuevoInfluencer(e.admin, extras);
    const [enDireccion] = await query<{ id: string }>(
      `INSERT INTO influencer_pii_records (organization_id, influencer_id, address_enc, key_id, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [e.admin.organizationId, otroDestino, fila!.phone_enc, fila!.key_id, e.admin.id],
    );
    const r2 = await revelarPii(e.admin, enDireccion!.id, ['address']);
    expect(r2.ok).toBe(false);
    // El original sigue revelándose.
    expect(ok(await revelarPii(e.admin, g.record.recordId, ['phone'])).values.phone).toBeDefined();
  });

  it('la base rechaza texto plano en un campo cifrado (CHECK del envoltorio)', async () => {
    const influencerId = await nuevoInfluencer(e.admin, extras);
    await expect(
      query(
        `INSERT INTO influencer_pii_records (organization_id, influencer_id, phone_enc, key_id, created_by)
         VALUES ($1, $2, $3, 'prueba-1', $4)`,
        [
          e.admin.organizationId,
          influencerId,
          Buffer.from('+573001234567 texto plano largo, sin envoltorio'),
          e.admin.id,
        ],
      ),
    ).rejects.toThrow(/envoltorio_valido/u);
  });
});

describe('rotación de claves', () => {
  it('un registro cifrado con una clave antigua sigue descifrando mientras esté en el anillo; lo nuevo usa la primera', async () => {
    const influencerId = await nuevoInfluencer(e.admin, extras);
    const tel = telefono();
    const dir = direccion('Rotación');
    // v1 con la clave de prueba (la activa del entorno de pruebas).
    const v1 = ok(await guardarPii(e.admin, { influencerId, phone: tel, address: dir }));
    const [antes] = await query<{ key_id: string }>(
      `SELECT key_id FROM influencer_pii_records WHERE id = $1`,
      [v1.record.recordId],
    );
    expect(antes!.key_id).toBe('prueba-1');

    // Se rota: la clave nueva va primero; la antigua sigue en el anillo solo para descifrar.
    process.env['PII_ENCRYPTION_KEYS'] = `nueva-2:${KEY_NUEVA},prueba-1:${KEY_PRUEBA}`;
    expect(ok(await revelarPii(e.admin, v1.record.recordId, ['phone', 'address'])).values).toEqual({
      phone: tel,
      address: dir,
    });
    // Guardar ahora crea la versión con la clave nueva, conservando lo anterior (descifrado con la vieja).
    const doc = cedula();
    const v2 = ok(await guardarPii(e.admin, { influencerId, documentId: doc }));
    const [despues] = await query<{ key_id: string }>(
      `SELECT key_id FROM influencer_pii_records WHERE id = $1`,
      [v2.record.recordId],
    );
    expect(despues!.key_id).toBe('nueva-2');
    expect(
      ok(await revelarPii(e.admin, v2.record.recordId, ['document_id', 'phone', 'address'])).values,
    ).toEqual({
      document_id: doc,
      phone: tel,
      address: dir,
    });

    // Se retira la clave antigua: la versión 1 deja de poder revelarse; la 2 sigue.
    process.env['PII_ENCRYPTION_KEYS'] = `nueva-2:${KEY_NUEVA}`;
    const vieja = await revelarPii(e.admin, v1.record.recordId, ['phone']);
    expect(vieja.ok).toBe(false);
    if (!vieja.ok) expect(vieja.error.details?.['reason']).toBe('PII_KEY_UNAVAILABLE');
    expect(ok(await revelarPii(e.admin, v2.record.recordId, ['phone'])).values.phone).toBe(tel);
  });
});
