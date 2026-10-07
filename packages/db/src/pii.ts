/**
 * Datos personales del KOL: cédula, teléfono y dirección (V2 · Fase 8, DEC-013/DEC-049).
 *
 * Cifrado a nivel de campo EN LA APLICACIÓN (AES-256-GCM, `node:crypto`): la base nunca ve la clave ni el
 * texto plano (migración 028; sin pgcrypto). La PII es de la PERSONA (influencer), no de la participación,
 * y vive solo en `influencer_pii_records`; el resto del sistema guarda, a lo sumo, un `pii_record_id`.
 *
 *  · Envoltorio de cada campo: `0x01 | IV(12) | etiqueta(16) | texto cifrado`. La base lo verifica con un CHECK
 *    (primer byte 0x01 y longitud ≥ 29), así que un texto plano accidental no cabe.
 *  · AAD = `<recordId>|<campo>|<keyId>`: un texto cifrado movido a otro registro, campo o clave no descifra.
 *  · Claves por entorno, sin valor por defecto: `PII_ENCRYPTION_KEYS` (`keyId:base64,keyId2:base64`, 32 bytes
 *    cada una; la PRIMERA cifra, las demás solo descifran: rotación) y `PII_INDEX_KEY` (base64, ≥ 32 bytes;
 *    HMAC-SHA-256 de la cédula normalizada → `blind_index`, para detectar cédula duplicada SIN descifrar).
 *    Sin configurar: `VALIDATION_FAILED` con `details.reason = 'PII_NOT_CONFIGURED'` (nunca una clave por defecto).
 *  · `guardarPii` (`pii:manage`) crea una VERSIÓN nueva (append-only); `revelarPii` (`pii:read`) descifra solo
 *    los campos pedidos y audita `pii.reveal` con NOMBRES de campo, jamás valores; `obtenerPiiResumen` dice
 *    qué campos existen, sin valores. `shipment:manage` NO implica `pii:read`.
 *  · La auditoría usa solo la allowlist de `audit.ts`; ningún valor ni texto cifrado llega a ella, a un error,
 *    a un log ni al agente.
 *
 * DEUDA declarada (no implementada aquí): cripto-borrado (`erased_at`) y política de retención.
 */

import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';
import {
  PII_BLIND_INDEX_LENGTH,
  PII_ENVELOPE_MIN_LENGTH,
  PII_ENVELOPE_VERSION,
  PII_FIELDS,
  PII_IV_LENGTH,
  PII_TAG_LENGTH,
  type NormalizedPii,
  type PiiField,
  type PiiSummary,
  type Result,
  type User,
  authorizeInternalResource,
  err,
  esKeyIdValido,
  ok,
  roleCan,
  validarCamposARevelar,
  validarEntradaPii,
  DomainError,
} from '@tcl-kol-os/domain';
import { recordAudit } from './audit.ts';
import { type ContextoDeAuditoria, auditoriaDe, exigirPersona } from './audit-context.ts';
import { getPool } from './client.ts';
import { esUuid } from './deliverables.ts';
import { Abortar, transaccionConResultado } from './tx-result.ts';

// ─────────────────────────── Claves ────────────────────────────────────────────

const NO_ENCONTRADO = {
  code: 'RESOURCE_NOT_FOUND',
  message: 'El recurso no existe o no está disponible.',
} as const;

function errorDePii(reason: string, message: string): DomainError {
  return new DomainError({ code: 'VALIDATION_FAILED', message, details: { reason } });
}

export interface AnilloDeClavesPii {
  /** Clave con la que se cifra (la primera del anillo). */
  readonly keyIdActivo: string;
  /** Todas las claves que descifran, por `keyId`. */
  readonly claves: ReadonlyMap<string, Buffer>;
  /** Clave del HMAC del índice ciego. */
  readonly claveDeIndice: Buffer;
}

const LONGITUD_DE_CLAVE = 32;

function decodificarBase64Estricto(valor: string): Buffer | undefined {
  const limpio = valor.trim();
  if (limpio === '' || !/^[A-Za-z0-9+/_-]+={0,2}$/u.test(limpio)) return undefined;
  return Buffer.from(limpio, 'base64');
}

/**
 * Lee el anillo de claves del entorno (en cada llamada: se puede rotar sin reiniciar). Lanza `DomainError`
 * `VALIDATION_FAILED` / `PII_NOT_CONFIGURED` si falta o está mal formado. Los mensajes no incluyen valores.
 */
export function cargarAnilloDeClavesPii(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AnilloDeClavesPii {
  const crudo = env['PII_ENCRYPTION_KEYS']?.trim();
  const crudoIndice = env['PII_INDEX_KEY']?.trim();
  if (crudo === undefined || crudo === '' || crudoIndice === undefined || crudoIndice === '') {
    throw errorDePii(
      'PII_NOT_CONFIGURED',
      'El cifrado de datos personales no está configurado (PII_ENCRYPTION_KEYS y PII_INDEX_KEY).',
    );
  }
  const claves = new Map<string, Buffer>();
  let keyIdActivo: string | undefined;
  for (const entrada of crudo.split(',')) {
    const posicion = entrada.indexOf(':');
    const keyId = posicion < 0 ? '' : entrada.slice(0, posicion).trim();
    const material = posicion < 0 ? undefined : decodificarBase64Estricto(entrada.slice(posicion + 1));
    if (!esKeyIdValido(keyId) || keyId.includes(':') || material === undefined || claves.has(keyId)) {
      throw errorDePii(
        'PII_NOT_CONFIGURED',
        'PII_ENCRYPTION_KEYS no tiene el formato «keyId:base64,keyId2:base64».',
      );
    }
    if (material.length !== LONGITUD_DE_CLAVE) {
      throw errorDePii('PII_NOT_CONFIGURED', 'Cada clave de PII_ENCRYPTION_KEYS debe tener 32 bytes.');
    }
    claves.set(keyId, material);
    keyIdActivo ??= keyId;
  }
  const claveDeIndice = decodificarBase64Estricto(crudoIndice);
  if (claveDeIndice === undefined || claveDeIndice.length < LONGITUD_DE_CLAVE) {
    throw errorDePii('PII_NOT_CONFIGURED', 'PII_INDEX_KEY debe ser base64 de al menos 32 bytes.');
  }
  if (keyIdActivo === undefined) {
    throw errorDePii('PII_NOT_CONFIGURED', 'PII_ENCRYPTION_KEYS no define ninguna clave.');
  }
  return { keyIdActivo, claves, claveDeIndice };
}

// ─────────────────────────── Cifrado de campo ──────────────────────────────────

function aad(recordId: string, field: PiiField, keyId: string): Buffer {
  return Buffer.from(`${recordId}|${field}|${keyId}`, 'utf8');
}

/** Cifra un valor ya normalizado. Devuelve el envoltorio (`bytea`) y el `keyId` con el que se cifró. */
export function cifrarCampoPii(
  anillo: AnilloDeClavesPii,
  entrada: { readonly recordId: string; readonly field: PiiField; readonly plaintext: string },
): { readonly envoltorio: Buffer; readonly keyId: string } {
  const keyId = anillo.keyIdActivo;
  const clave = anillo.claves.get(keyId)!;
  const iv = randomBytes(PII_IV_LENGTH);
  const cifrador = createCipheriv('aes-256-gcm', clave, iv, { authTagLength: PII_TAG_LENGTH });
  cifrador.setAAD(aad(entrada.recordId, entrada.field, keyId));
  const cifrado = Buffer.concat([cifrador.update(entrada.plaintext, 'utf8'), cifrador.final()]);
  const etiqueta = cifrador.getAuthTag();
  return {
    envoltorio: Buffer.concat([Buffer.from([PII_ENVELOPE_VERSION]), iv, etiqueta, cifrado]),
    keyId,
  };
}

/**
 * Descifra un envoltorio. Falla (sin revelar nada) si la clave no está en el anillo, el formato no es el
 * esperado o la autenticación GCM no cuadra (texto cifrado movido de registro, campo o clave; alterado).
 */
export function descifrarCampoPii(
  anillo: AnilloDeClavesPii,
  entrada: {
    readonly recordId: string;
    readonly field: PiiField;
    readonly keyId: string;
    readonly envoltorio: Uint8Array;
  },
): string {
  const clave = anillo.claves.get(entrada.keyId);
  if (clave === undefined) {
    throw errorDePii('PII_KEY_UNAVAILABLE', 'La clave con la que se cifró este dato ya no está disponible.');
  }
  const bytes = Buffer.from(entrada.envoltorio);
  if (bytes.length < PII_ENVELOPE_MIN_LENGTH || bytes[0] !== PII_ENVELOPE_VERSION) {
    throw errorDePii('PII_DECRYPT_FAILED', 'El dato personal no se pudo descifrar.');
  }
  const iv = bytes.subarray(1, 1 + PII_IV_LENGTH);
  const etiqueta = bytes.subarray(1 + PII_IV_LENGTH, 1 + PII_IV_LENGTH + PII_TAG_LENGTH);
  const cifrado = bytes.subarray(1 + PII_IV_LENGTH + PII_TAG_LENGTH);
  try {
    const descifrador = createDecipheriv('aes-256-gcm', clave, iv, { authTagLength: PII_TAG_LENGTH });
    descifrador.setAAD(aad(entrada.recordId, entrada.field, entrada.keyId));
    descifrador.setAuthTag(etiqueta);
    return Buffer.concat([descifrador.update(cifrado), descifrador.final()]).toString('utf8');
  } catch {
    throw errorDePii('PII_DECRYPT_FAILED', 'El dato personal no se pudo descifrar.');
  }
}

/** Índice ciego: HMAC-SHA-256 (32 bytes) del documento ya normalizado. */
export function indiceCiegoDeDocumento(anillo: AnilloDeClavesPii, documentoNormalizado: string): Buffer {
  const indice = createHmac('sha256', anillo.claveDeIndice).update(documentoNormalizado, 'utf8').digest();
  if (indice.length !== PII_BLIND_INDEX_LENGTH) throw new Error('Índice ciego de longitud inesperada.');
  return indice;
}

// ─────────────────────────── Filas y autorización ──────────────────────────────

interface FilaDeRegistro {
  readonly id: string;
  readonly organization_id: string;
  readonly influencer_id: string;
  readonly version: number;
  readonly key_id: string;
  readonly document_id_enc: Buffer | null;
  readonly phone_enc: Buffer | null;
  readonly address_enc: Buffer | null;
  readonly erased_at: Date | null;
}

const COLUMNA_DE_CAMPO = {
  document_id: 'document_id_enc',
  phone: 'phone_enc',
  address: 'address_enc',
} as const satisfies Record<PiiField, keyof FilaDeRegistro>;

const CAMPO_DE_ENTRADA = {
  document_id: 'documentId',
  phone: 'phone',
  address: 'address',
} as const satisfies Record<PiiField, keyof NormalizedPii>;

const SELECT_REGISTRO = `
  SELECT id, organization_id, influencer_id, version, key_id,
         document_id_enc, phone_enc, address_enc, erased_at
    FROM influencer_pii_records`;

function resumenDeFila(fila: FilaDeRegistro): PiiSummary {
  return {
    recordId: fila.id,
    influencerId: fila.influencer_id,
    version: fila.version,
    hasDocumentId: fila.document_id_enc !== null,
    hasPhone: fila.phone_enc !== null,
    hasAddress: fila.address_enc !== null,
    erased: fila.erased_at !== null,
  };
}

/**
 * Autoriza sobre un recurso de PII. Ajeno, inexistente (para quien tiene la capacidad) o actor `cliente`:
 * `RESOURCE_NOT_FOUND`; rol sin la capacidad: `FORBIDDEN_ROLE` aunque el recurso no exista.
 */
function autorizar(
  actor: User,
  accion: 'pii:read' | 'pii:manage',
  organizacionDelRecurso: string | undefined,
): Result<true> {
  const r = authorizeInternalResource(actor, accion, organizacionDelRecurso ?? actor.organizationId);
  if (!r.ok) return r;
  return organizacionDelRecurso === undefined ? err(NO_ENCONTRADO) : r;
}

// ─────────────────────────── Guardar ───────────────────────────────────────────

export interface GuardarPiiInput {
  readonly influencerId: string;
  readonly documentId?: string | undefined;
  readonly phone?: string | undefined;
  readonly address?: string | undefined;
  /**
   * Reservada: la tabla no guarda la clave. La idempotencia es POR CONTENIDO: repetir un guardado cuyo
   * resultado coincide con la versión vigente devuelve esa versión (`replayed: true`) sin crear otra.
   */
  readonly idempotencyKey?: string | undefined;
}

export interface GuardarPiiResultado {
  /** Resumen de la versión vigente tras guardar (sin valores). */
  readonly record: PiiSummary;
  /** `true` si el contenido ya era el de la versión vigente: no se creó una versión nueva. */
  readonly replayed: boolean;
}

const MAX_CLAVE_IDEMPOTENCIA = 200;

const CEDULA_DUPLICADA = {
  code: 'RESOURCE_CONFLICT',
  message: 'Ese documento de identidad ya está registrado para otro influencer de la organización.',
  details: { reason: 'duplicate_document' },
} as const;

/**
 * Guarda datos personales como una VERSIÓN nueva (append-only). Los campos ausentes se conservan de la
 * versión anterior (se vuelven a cifrar bajo el id del registro nuevo: el AAD los ata a él). Requiere
 * `pii:manage`. Una cédula ya registrada para otro influencer de la organización se rechaza ANTES de
 * descifrar nada (índice ciego); la base lo repite con un trigger.
 */
export async function guardarPii(
  actor: User,
  input: GuardarPiiInput,
  contexto?: ContextoDeAuditoria,
): Promise<Result<GuardarPiiResultado>> {
  const persona = exigirPersona(actor, contexto);
  if (!persona.ok) return persona;
  if (!esUuid(input.influencerId)) return autorizarInexistente(actor, 'pii:manage');

  const influencer = await getPool().query<{ organization_id: string }>(
    `SELECT organization_id FROM influencers WHERE id = $1`,
    [input.influencerId],
  );
  const permitido = autorizar(actor, 'pii:manage', influencer.rows[0]?.organization_id);
  if (!permitido.ok) return permitido;

  if (
    input.idempotencyKey !== undefined &&
    (typeof input.idempotencyKey !== 'string' ||
      input.idempotencyKey.trim() === '' ||
      input.idempotencyKey.length > MAX_CLAVE_IDEMPOTENCIA)
  ) {
    return err({
      code: 'VALIDATION_FAILED',
      message: 'La clave de idempotencia no es válida.',
      details: { field: 'idempotencyKey' },
    });
  }
  const normalizado = validarEntradaPii({
    documentId: input.documentId,
    phone: input.phone,
    address: input.address,
  });
  if (!normalizado.ok) return normalizado;

  let anillo: AnilloDeClavesPii;
  try {
    anillo = cargarAnilloDeClavesPii();
  } catch (error) {
    if (error instanceof DomainError) return { ok: false, error };
    throw error;
  }

  const nuevos = normalizado.value;
  return transaccionConResultado<GuardarPiiResultado>(async (client) => {
    // Serializa las versiones del influencer (el trigger 028 toma el mismo bloqueo).
    const bloqueado = await client.query(
      `SELECT 1 FROM influencers WHERE id = $1 AND organization_id = $2 FOR NO KEY UPDATE`,
      [input.influencerId, actor.organizationId],
    );
    if (bloqueado.rows[0] === undefined) throw new Abortar(NO_ENCONTRADO);

    const { rows: previas } = await client.query<FilaDeRegistro>(
      `${SELECT_REGISTRO} WHERE influencer_id = $1 ORDER BY version DESC LIMIT 1`,
      [input.influencerId],
    );
    const previa = previas[0];

    // Cédula duplicada: con el índice ciego, sin descifrar nada.
    const indiceNuevo =
      nuevos.documentId === undefined ? undefined : indiceCiegoDeDocumento(anillo, nuevos.documentId);
    if (indiceNuevo !== undefined) {
      const { rows: duplicadas } = await client.query(
        `SELECT 1
           FROM influencer_pii_records r
          WHERE r.organization_id = $1 AND r.blind_index = $2 AND r.influencer_id <> $3
            AND r.erased_at IS NULL
            AND r.version = (SELECT max(m.version) FROM influencer_pii_records m WHERE m.influencer_id = r.influencer_id)
          LIMIT 1`,
        [actor.organizationId, indiceNuevo, input.influencerId],
      );
      if (duplicadas[0] !== undefined) throw new Abortar(CEDULA_DUPLICADA);
    }

    // Valores finales: lo recibido, más lo conservado de la versión vigente (no borrada).
    const finales: { [K in PiiField]?: string } = {};
    let sinCambios = previa !== undefined && previa.erased_at === null;
    for (const campo of PII_FIELDS) {
      const recibido = nuevos[CAMPO_DE_ENTRADA[campo]];
      const cifradoPrevio =
        previa === undefined || previa.erased_at !== null ? null : previa[COLUMNA_DE_CAMPO[campo]];
      const anterior =
        cifradoPrevio === null
          ? undefined
          : descifrarCampoPii(anillo, {
              recordId: previa!.id,
              field: campo,
              keyId: previa!.key_id,
              envoltorio: cifradoPrevio,
            });
      if (recibido !== undefined) {
        finales[campo] = recibido;
        if (recibido !== anterior) sinCambios = false;
      } else if (anterior !== undefined) {
        finales[campo] = anterior;
      }
    }
    if (sinCambios && previa !== undefined) return { record: resumenDeFila(previa), replayed: true };

    const id = randomUUID();
    const sobres: { [K in PiiField]?: Buffer } = {};
    for (const campo of PII_FIELDS) {
      const valor = finales[campo];
      if (valor !== undefined)
        sobres[campo] = cifrarCampoPii(anillo, { recordId: id, field: campo, plaintext: valor }).envoltorio;
    }
    const indice =
      finales.document_id === undefined ? null : indiceCiegoDeDocumento(anillo, finales.document_id);
    const { rows } = await client.query<FilaDeRegistro>(
      `INSERT INTO influencer_pii_records
              (id, organization_id, influencer_id, document_id_enc, phone_enc, address_enc, key_id,
               blind_index, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, organization_id, influencer_id, version, key_id,
                 document_id_enc, phone_enc, address_enc, erased_at`,
      [
        id,
        actor.organizationId,
        input.influencerId,
        sobres.document_id ?? null,
        sobres.phone ?? null,
        sobres.address ?? null,
        anillo.keyIdActivo,
        indice,
        actor.id,
      ],
    );
    const creada = rows[0]!;
    const guardados = PII_FIELDS.filter((campo) => nuevos[CAMPO_DE_ENTRADA[campo]] !== undefined);
    await recordAudit(
      client,
      auditoriaDe(actor, contexto, {
        action: 'pii.save',
        entityType: 'influencer_pii_record',
        entityId: creada.id,
        metadata: { influencerId: input.influencerId, version: creada.version, fields: guardados },
      }),
    );
    return { record: resumenDeFila(creada), replayed: false };
  }, CEDULA_DUPLICADA);
}

function autorizarInexistente(actor: User, accion: 'pii:read' | 'pii:manage'): Result<never> {
  const r = autorizar(actor, accion, undefined);
  return r.ok ? err(NO_ENCONTRADO) : r;
}

// ─────────────────────────── Revelar ───────────────────────────────────────────

export interface PiiRevelada {
  readonly recordId: string;
  readonly influencerId: string;
  readonly version: number;
  /** Solo los campos pedidos que existen en el registro. */
  readonly values: { readonly [K in PiiField]?: string };
}

/**
 * Revela (descifra) SOLO los campos pedidos de un registro. Requiere `pii:read` (no lo implica
 * `shipment:manage`). La auditoría `pii.reveal` queda en la misma transacción, con NOMBRES de campo.
 * Un registro ajeno, o un actor `cliente`: `RESOURCE_NOT_FOUND`. Un registro borrado: `RESOURCE_CONFLICT`.
 */
export async function revelarPii(
  actor: User,
  piiRecordId: string,
  campos: readonly PiiField[],
  contexto?: ContextoDeAuditoria,
): Promise<Result<PiiRevelada>> {
  const persona = exigirPersona(actor, contexto);
  if (!persona.ok) return persona;
  if (!esUuid(piiRecordId)) return autorizarInexistente(actor, 'pii:read');

  const cabecera = await getPool().query<{ organization_id: string }>(
    `SELECT organization_id FROM influencer_pii_records WHERE id = $1`,
    [piiRecordId],
  );
  const permitido = autorizar(actor, 'pii:read', cabecera.rows[0]?.organization_id);
  if (!permitido.ok) return permitido;

  const pedidos = validarCamposARevelar(campos);
  if (!pedidos.ok) return pedidos;

  let anillo: AnilloDeClavesPii;
  try {
    anillo = cargarAnilloDeClavesPii();
  } catch (error) {
    if (error instanceof DomainError) return { ok: false, error };
    throw error;
  }

  return transaccionConResultado<PiiRevelada>(async (client) => {
    const { rows } = await client.query<FilaDeRegistro>(`${SELECT_REGISTRO} WHERE id = $1 FOR SHARE`, [
      piiRecordId,
    ]);
    const fila = rows[0];
    if (fila === undefined || fila.organization_id !== actor.organizationId) throw new Abortar(NO_ENCONTRADO);
    if (fila.erased_at !== null) {
      throw new Abortar({
        code: 'RESOURCE_CONFLICT',
        message: 'Los datos personales de este registro fueron borrados.',
        details: { reason: 'pii_erased' },
      });
    }
    const reveladosEnOrden = pedidos.value.filter((campo) => fila[COLUMNA_DE_CAMPO[campo]] !== null);
    // Primero el rastro, en la misma transacción: si falla, no se devuelve nada.
    await recordAudit(
      client,
      auditoriaDe(actor, contexto, {
        action: 'pii.reveal',
        entityType: 'influencer_pii_record',
        entityId: fila.id,
        metadata: { influencerId: fila.influencer_id, version: fila.version, fields: reveladosEnOrden },
      }),
    );
    const values: { [K in PiiField]?: string } = {};
    for (const campo of reveladosEnOrden) {
      values[campo] = descifrarCampoPii(anillo, {
        recordId: fila.id,
        field: campo,
        keyId: fila.key_id,
        envoltorio: fila[COLUMNA_DE_CAMPO[campo]]!,
      });
    }
    return { recordId: fila.id, influencerId: fila.influencer_id, version: fila.version, values };
  }, NO_ENCONTRADO);
}

// ─────────────────────────── Resumen (sin valores) ─────────────────────────────

/**
 * Qué campos de datos personales existen para un influencer y de qué versión, SIN valores. Requiere
 * `pii:read` o `pii:manage`. `null` si aún no hay registro.
 */
export async function obtenerPiiResumen(
  actor: User,
  influencerId: string,
): Promise<Result<PiiSummary | null>> {
  const accion = roleCan(actor.role, 'pii:read') ? 'pii:read' : 'pii:manage';
  if (!esUuid(influencerId)) return autorizarInexistente(actor, accion);
  const influencer = await getPool().query<{ organization_id: string }>(
    `SELECT organization_id FROM influencers WHERE id = $1`,
    [influencerId],
  );
  const permitido = autorizar(actor, accion, influencer.rows[0]?.organization_id);
  if (!permitido.ok) return permitido;

  const { rows } = await getPool().query<{
    id: string;
    influencer_id: string;
    version: number;
    has_document_id: boolean;
    has_phone: boolean;
    has_address: boolean;
    erased: boolean;
  }>(
    `SELECT id, influencer_id, version,
            document_id_enc IS NOT NULL AS has_document_id,
            phone_enc IS NOT NULL AS has_phone,
            address_enc IS NOT NULL AS has_address,
            erased_at IS NOT NULL AS erased
       FROM influencer_pii_records
      WHERE influencer_id = $1 AND organization_id = $2
      ORDER BY version DESC LIMIT 1`,
    [influencerId, actor.organizationId],
  );
  const fila = rows[0];
  if (fila === undefined) return ok(null);
  return ok({
    recordId: fila.id,
    influencerId: fila.influencer_id,
    version: fila.version,
    hasDocumentId: fila.has_document_id,
    hasPhone: fila.has_phone,
    hasAddress: fila.has_address,
    erased: fila.erased,
  });
}
