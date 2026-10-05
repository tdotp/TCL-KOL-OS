/**
 * Influencer e identidades por plataforma (V2 · Fase 3).
 *
 * Casos de uso reutilizables (la UI, el Sheet de la Fase 5 y el agente de la
 * Fase 6 los llamarán; ninguno depende de un formulario). Cada operación valida
 * el aislamiento por organización, la capacidad del rol y las invariantes, y
 * audita en la MISMA transacción que la mutación.
 *
 *  · Solo mutan personas (`User`). El actor `'system'` no obtiene mutaciones
 *    nuevas en esta fase: no hay import ni agente todavía.
 *  · No es una aprobación crítica: no pasa por acciones propuestas (HITL).
 *  · Mismo orden de respuesta que el resto del sistema: recurso de otra
 *    organización → `RESOURCE_NOT_FOUND` (no revela que existe); rol sin la
 *    capacidad → `FORBIDDEN_ROLE`.
 */

import type pg from 'pg';
import {
  type Influencer,
  type InfluencerAccount,
  type InfluencerWithAccounts,
  type Result,
  type SocialPlatform,
  type User,
  authorizeInternalResource,
  err,
  normalizeDisplayName,
  normalizeHandle,
  normalizeProfileUrl,
  ok,
} from '@tcl-kol-os/domain';
import { assertCapability } from './authz.ts';
import { recordAudit } from './audit.ts';
import { type ContextoDeAuditoria, auditoriaDe, exigirPersona } from './audit-context.ts';
import { getPool } from './client.ts';
import { Abortar, transaccionConResultado } from './tx-result.ts';

// ─────────────────────────── Compartido con campaign-influencers ───────────────

// `ContextoDeAuditoria`, `exigirPersona` y `auditoriaDe` viven en `audit-context.ts`
// (Fase 6); se reexportan aquí para no romper las importaciones existentes.
export { type ContextoDeAuditoria, auditoriaDe, exigirPersona } from './audit-context.ts';

export const NO_ENCONTRADO = {
  code: 'RESOURCE_NOT_FOUND',
  message: 'El recurso no existe o no está disponible.',
} as const;

// ─────────────────────────── Filas y mapeo ─────────────────────────────────────

export interface InfluencerRow {
  readonly id: string;
  readonly organization_id: string;
  readonly display_name: string;
  readonly created_by: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface InfluencerAccountRow {
  readonly id: string;
  readonly influencer_id: string;
  readonly organization_id: string;
  readonly platform: SocialPlatform;
  readonly handle: string;
  readonly normalized_handle: string;
  readonly profile_url: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export const SELECT_INFLUENCER = `
  SELECT id, organization_id, display_name, created_by, created_at, updated_at FROM influencers
`;

export const SELECT_CUENTA = `
  SELECT id, influencer_id, organization_id, platform, handle, normalized_handle, profile_url,
         created_at, updated_at
    FROM influencer_accounts
`;

export function comoInfluencer(row: InfluencerRow): Influencer {
  return {
    id: row.id,
    organizationId: row.organization_id,
    displayName: row.display_name,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function comoCuenta(row: InfluencerAccountRow): InfluencerAccount {
  return {
    id: row.id,
    influencerId: row.influencer_id,
    organizationId: row.organization_id,
    platform: row.platform,
    handle: row.handle,
    normalizedHandle: row.normalized_handle,
    profileUrl: row.profile_url ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

type Consultor = pg.Pool | pg.PoolClient;

/** Cuentas de varios influencers en un solo viaje, agrupadas por influencer. */
export async function cuentasDe(
  db: Consultor,
  influencerIds: readonly string[],
): Promise<Map<string, InfluencerAccount[]>> {
  const porInfluencer = new Map<string, InfluencerAccount[]>();
  if (influencerIds.length === 0) return porInfluencer;
  const { rows } = await db.query<InfluencerAccountRow>(
    `${SELECT_CUENTA} WHERE influencer_id = ANY($1::uuid[]) ORDER BY platform, normalized_handle`,
    [influencerIds],
  );
  for (const row of rows) {
    const lista = porInfluencer.get(row.influencer_id) ?? [];
    lista.push(comoCuenta(row));
    porInfluencer.set(row.influencer_id, lista);
  }
  return porInfluencer;
}

// ─────────────────────────── Entradas ──────────────────────────────────────────

export interface CuentaInput {
  readonly platform: SocialPlatform;
  readonly handle: string;
  readonly profileUrl?: string | undefined;
}

export interface CrearInfluencerInput {
  readonly displayName: string;
  /** Cuentas iniciales (opcional): se crean junto con la persona, atómicamente. */
  readonly cuentas?: readonly CuentaInput[] | undefined;
}

export interface ActualizarInfluencerInput {
  readonly displayName: string;
}

export interface ActualizarCuentaInput {
  readonly handle?: string | undefined;
  /** `null` borra la URL; `undefined` la deja como está. */
  readonly profileUrl?: string | null | undefined;
}

interface CuentaNormalizada {
  readonly platform: SocialPlatform;
  readonly handle: string;
  readonly normalized: string;
  readonly profileUrl: string | undefined;
}

function normalizarCuenta(input: CuentaInput): Result<CuentaNormalizada> {
  const handle = normalizeHandle(input.platform, input.handle);
  if (!handle.ok)
    return err({ code: handle.error.code, message: handle.error.message, details: handle.error.details });
  const url = normalizeProfileUrl(input.profileUrl);
  if (!url.ok) return err({ code: url.error.code, message: url.error.message, details: url.error.details });
  return ok({
    platform: input.platform,
    handle: handle.value.handle,
    normalized: handle.value.normalized,
    profileUrl: url.value,
  });
}

const CONFLICTO_DE_CUENTA = {
  code: 'RESOURCE_CONFLICT',
  message: 'Esa cuenta ya está registrada en la organización.',
} as const;

/** ¿Quién tiene ya esta cuenta en la organización? (identidad fuerte, sin fuzzy). */
async function duenoDeCuenta(
  client: pg.PoolClient,
  organizationId: string,
  platform: SocialPlatform,
  normalized: string,
): Promise<{ accountId: string; influencerId: string } | undefined> {
  const { rows } = await client.query<{ id: string; influencer_id: string }>(
    `SELECT id, influencer_id FROM influencer_accounts
      WHERE organization_id = $1 AND platform = $2 AND normalized_handle = $3`,
    [organizationId, platform, normalized],
  );
  const fila = rows[0];
  return fila === undefined ? undefined : { accountId: fila.id, influencerId: fila.influencer_id };
}

function cuentaDuplicada(platform: SocialPlatform, dueno: { accountId: string; influencerId: string }) {
  return new Abortar({
    ...CONFLICTO_DE_CUENTA,
    details: {
      reason: 'account_exists',
      platform,
      influencerId: dueno.influencerId,
      accountId: dueno.accountId,
    },
  });
}

// ─────────────────────────── Mutaciones ────────────────────────────────────────

export async function crearInfluencer(
  actor: User,
  input: CrearInfluencerInput,
  contexto?: ContextoDeAuditoria,
): Promise<Result<InfluencerWithAccounts>> {
  const persona = exigirPersona(actor, contexto);
  if (!persona.ok) return persona;
  const permitido = assertCapability(actor, 'influencer:manage');
  if (!permitido.ok)
    return err({
      code: permitido.error.code,
      message: permitido.error.message,
      details: permitido.error.details,
    });

  const nombre = normalizeDisplayName(input.displayName);
  if (!nombre.ok) return nombre;

  const cuentas: CuentaNormalizada[] = [];
  const vistas = new Set<string>();
  for (const cuenta of input.cuentas ?? []) {
    const normalizada = normalizarCuenta(cuenta);
    if (!normalizada.ok) return normalizada;
    const clave = `${normalizada.value.platform}:${normalizada.value.normalized}`;
    if (vistas.has(clave)) {
      return err({
        code: 'RESOURCE_CONFLICT',
        message: 'La misma cuenta aparece dos veces en la solicitud.',
        details: { reason: 'account_repeated', platform: normalizada.value.platform },
      });
    }
    vistas.add(clave);
    cuentas.push(normalizada.value);
  }

  return transaccionConResultado(
    async (client) => {
      // Comprobación previa de TODAS las cuentas: nada se escribe si alguna choca.
      for (const cuenta of cuentas) {
        const dueno = await duenoDeCuenta(client, actor.organizationId, cuenta.platform, cuenta.normalized);
        if (dueno !== undefined) throw cuentaDuplicada(cuenta.platform, dueno);
      }

      const { rows } = await client.query<InfluencerRow>(
        `INSERT INTO influencers (organization_id, display_name, created_by)
       VALUES ($1, $2, $3)
       RETURNING id, organization_id, display_name, created_by, created_at, updated_at`,
        [actor.organizationId, nombre.value, actor.id],
      );
      const influencer = comoInfluencer(rows[0]!);
      await recordAudit(
        client,
        auditoriaDe(actor, contexto, {
          action: 'influencer.create',
          entityType: 'influencer',
          entityId: influencer.id,
          metadata: { displayName: influencer.displayName, cuentas: cuentas.length },
        }),
      );

      const creadas: InfluencerAccount[] = [];
      for (const cuenta of cuentas) {
        creadas.push(await insertarCuenta(client, actor, contexto, influencer, cuenta));
      }
      return { influencer, accounts: creadas };
    },
    {
      code: 'RESOURCE_CONFLICT',
      message: 'Una cuenta de la solicitud ya está registrada.',
      details: { reason: 'account_exists' },
    },
  );
}

async function insertarCuenta(
  client: pg.PoolClient,
  actor: User,
  contexto: ContextoDeAuditoria | undefined,
  influencer: Influencer,
  cuenta: CuentaNormalizada,
): Promise<InfluencerAccount> {
  const { rows } = await client.query<InfluencerAccountRow>(
    `INSERT INTO influencer_accounts
       (influencer_id, organization_id, platform, handle, normalized_handle, profile_url)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, influencer_id, organization_id, platform, handle, normalized_handle, profile_url,
               created_at, updated_at`,
    [
      influencer.id,
      influencer.organizationId,
      cuenta.platform,
      cuenta.handle,
      cuenta.normalized,
      cuenta.profileUrl ?? null,
    ],
  );
  const creada = comoCuenta(rows[0]!);
  await recordAudit(
    client,
    auditoriaDe(actor, contexto, {
      action: 'influencer_account.add',
      entityType: 'influencer_account',
      entityId: creada.id,
      metadata: {
        influencerId: influencer.id,
        platform: creada.platform,
        handle: creada.handle,
        normalizedHandle: creada.normalizedHandle,
      },
    }),
  );
  return creada;
}

/** Influencer del actor (bloqueado) o el error que corresponda. */
async function cargarInfluencerParaMutar(
  client: pg.PoolClient,
  actor: User,
  influencerId: string,
): Promise<InfluencerRow> {
  const { rows } = await client.query<InfluencerRow>(`${SELECT_INFLUENCER} WHERE id = $1 FOR UPDATE`, [
    influencerId,
  ]);
  const fila = rows[0];
  if (fila === undefined) throw new Abortar(NO_ENCONTRADO);
  const permitido = authorizeInternalResource(actor, 'influencer:manage', fila.organization_id);
  if (!permitido.ok) throw new Abortar(permitido.error);
  return fila;
}

export async function actualizarInfluencer(
  actor: User,
  influencerId: string,
  input: ActualizarInfluencerInput,
  contexto?: ContextoDeAuditoria,
): Promise<Result<Influencer>> {
  const persona = exigirPersona(actor, contexto);
  if (!persona.ok) return persona;
  const nombre = normalizeDisplayName(input.displayName);

  return transaccionConResultado(
    async (client) => {
      const actual = await cargarInfluencerParaMutar(client, actor, influencerId);
      if (!nombre.ok) throw new Abortar(nombre.error);
      if (nombre.value === actual.display_name) return comoInfluencer(actual);

      const { rows } = await client.query<InfluencerRow>(
        `UPDATE influencers SET display_name = $2 WHERE id = $1
       RETURNING id, organization_id, display_name, created_by, created_at, updated_at`,
        [influencerId, nombre.value],
      );
      await recordAudit(
        client,
        auditoriaDe(actor, contexto, {
          action: 'influencer.update',
          entityType: 'influencer',
          entityId: influencerId,
          metadata: { displayNameAnterior: actual.display_name, displayNameNuevo: nombre.value },
        }),
      );
      return comoInfluencer(rows[0]!);
    },
    { code: 'RESOURCE_CONFLICT', message: 'El influencer cambió mientras se actualizaba.' },
  );
}

export async function agregarCuenta(
  actor: User,
  influencerId: string,
  input: CuentaInput,
  contexto?: ContextoDeAuditoria,
): Promise<Result<InfluencerAccount>> {
  const persona = exigirPersona(actor, contexto);
  if (!persona.ok) return persona;
  const cuenta = normalizarCuenta(input);

  return transaccionConResultado(async (client) => {
    const fila = await cargarInfluencerParaMutar(client, actor, influencerId);
    if (!cuenta.ok) throw new Abortar(cuenta.error);
    const dueno = await duenoDeCuenta(
      client,
      fila.organization_id,
      cuenta.value.platform,
      cuenta.value.normalized,
    );
    if (dueno !== undefined) throw cuentaDuplicada(cuenta.value.platform, dueno);
    return insertarCuenta(client, actor, contexto, comoInfluencer(fila), cuenta.value);
  }, CONFLICTO_DE_CUENTA);
}

export async function actualizarCuenta(
  actor: User,
  accountId: string,
  input: ActualizarCuentaInput,
  contexto?: ContextoDeAuditoria,
): Promise<Result<InfluencerAccount>> {
  const persona = exigirPersona(actor, contexto);
  if (!persona.ok) return persona;

  return transaccionConResultado(async (client) => {
    const { rows } = await client.query<InfluencerAccountRow>(`${SELECT_CUENTA} WHERE id = $1 FOR UPDATE`, [
      accountId,
    ]);
    const actual = rows[0];
    if (actual === undefined) throw new Abortar(NO_ENCONTRADO);
    const permitido = authorizeInternalResource(actor, 'influencer:manage', actual.organization_id);
    if (!permitido.ok) throw new Abortar(permitido.error);

    if (input.handle === undefined && input.profileUrl === undefined) {
      throw new Abortar({
        code: 'VALIDATION_FAILED',
        message: 'No hay nada que actualizar.',
        details: { field: 'handle' },
      });
    }

    let { handle, normalized_handle: normalized } = actual;
    if (input.handle !== undefined) {
      const nuevo = normalizeHandle(actual.platform, input.handle);
      if (!nuevo.ok) throw new Abortar(nuevo.error);
      handle = nuevo.value.handle;
      normalized = nuevo.value.normalized;
    }
    let profileUrl = actual.profile_url;
    if (input.profileUrl !== undefined) {
      const url = normalizeProfileUrl(input.profileUrl);
      if (!url.ok) throw new Abortar(url.error);
      profileUrl = url.value ?? null;
    }

    if (handle === actual.handle && profileUrl === actual.profile_url) return comoCuenta(actual);

    if (normalized !== actual.normalized_handle) {
      const dueno = await duenoDeCuenta(client, actual.organization_id, actual.platform, normalized);
      if (dueno !== undefined) throw cuentaDuplicada(actual.platform, dueno);
    }

    const { rows: actualizadas } = await client.query<InfluencerAccountRow>(
      `UPDATE influencer_accounts SET handle = $2, normalized_handle = $3, profile_url = $4 WHERE id = $1
       RETURNING id, influencer_id, organization_id, platform, handle, normalized_handle, profile_url,
                 created_at, updated_at`,
      [accountId, handle, normalized, profileUrl],
    );
    await recordAudit(
      client,
      auditoriaDe(actor, contexto, {
        action: 'influencer_account.update',
        entityType: 'influencer_account',
        entityId: accountId,
        metadata: {
          influencerId: actual.influencer_id,
          platform: actual.platform,
          handleAnterior: actual.handle,
          handleNuevo: handle,
          normalizedAnterior: actual.normalized_handle,
          normalizedNuevo: normalized,
          urlCambio: profileUrl !== actual.profile_url,
        },
      }),
    );
    return comoCuenta(actualizadas[0]!);
  }, CONFLICTO_DE_CUENTA);
}

// ─────────────────────────── Lecturas ──────────────────────────────────────────

export async function obtenerInfluencer(
  actor: User,
  influencerId: string,
): Promise<Result<InfluencerWithAccounts>> {
  const { rows } = await getPool().query<InfluencerRow>(`${SELECT_INFLUENCER} WHERE id = $1`, [influencerId]);
  const fila = rows[0];
  if (fila === undefined) return err(NO_ENCONTRADO);
  const permitido = authorizeInternalResource(actor, 'influencer:read', fila.organization_id);
  if (!permitido.ok) return permitido;
  const cuentas = await cuentasDe(getPool(), [fila.id]);
  return ok({ influencer: comoInfluencer(fila), accounts: cuentas.get(fila.id) ?? [] });
}

export interface ListarInfluencersOpciones {
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

export async function listarInfluencers(
  actor: User,
  opciones: ListarInfluencersOpciones = {},
): Promise<Result<InfluencerWithAccounts[]>> {
  const permitido = assertCapability(actor, 'influencer:read');
  if (!permitido.ok)
    return err({
      code: permitido.error.code,
      message: permitido.error.message,
      details: permitido.error.details,
    });

  const limit = Math.min(Math.max(Math.trunc(opciones.limit ?? 100), 1), 500);
  const offset = Math.max(Math.trunc(opciones.offset ?? 0), 0);
  const { rows } = await getPool().query<InfluencerRow>(
    `${SELECT_INFLUENCER} WHERE organization_id = $1 ORDER BY display_name, created_at, id LIMIT $2 OFFSET $3`,
    [actor.organizationId, limit, offset],
  );
  const cuentas = await cuentasDe(
    getPool(),
    rows.map((r) => r.id),
  );
  return ok(rows.map((r) => ({ influencer: comoInfluencer(r), accounts: cuentas.get(r.id) ?? [] })));
}

/**
 * Búsqueda exacta por identidad fuerte (plataforma + handle normalizado) dentro
 * de la organización. Es el contrato de coincidencia para el Sheet (Fase 5):
 * determinista, sin nombres parecidos ni heurísticas.
 */
export async function buscarInfluencerPorCuenta(
  actor: User,
  platform: SocialPlatform,
  handle: string,
): Promise<Result<InfluencerWithAccounts | undefined>> {
  const permitido = assertCapability(actor, 'influencer:read');
  if (!permitido.ok)
    return err({
      code: permitido.error.code,
      message: permitido.error.message,
      details: permitido.error.details,
    });
  const normalizado = normalizeHandle(platform, handle);
  if (!normalizado.ok) return normalizado;

  const { rows } = await getPool().query<InfluencerRow>(
    `SELECT i.id, i.organization_id, i.display_name, i.created_by, i.created_at, i.updated_at
       FROM influencers i
       JOIN influencer_accounts a ON a.influencer_id = i.id
      WHERE a.organization_id = $1 AND a.platform = $2 AND a.normalized_handle = $3`,
    [actor.organizationId, platform, normalizado.value.normalized],
  );
  const fila = rows[0];
  if (fila === undefined) return ok(undefined);
  const cuentas = await cuentasDe(getPool(), [fila.id]);
  return ok({ influencer: comoInfluencer(fila), accounts: cuentas.get(fila.id) ?? [] });
}
