/**
 * Reglas de importación de influencers desde un Sheet (V2 · Fase 5).
 *
 * Puro: recibe el registro del Sheet y los HECHOS ya consultados (quién es dueño
 * de cada cuenta, qué binding existe, qué participaciones hay…) y devuelve una
 * decisión. No toca la base ni la red. Quien persiste (`packages/db`) consulta
 * los hechos y ejecuta la decisión con los casos de uso de la Fase 3.
 *
 * Matching: ÚNICAMENTE determinístico.
 *
 *   1. binding previo de la fuente (`sourceKey` → influencer)         gana siempre
 *   2. coincidencia EXACTA de cuenta: plataforma + handle normalizado
 *   3. si nada coincide y el registro es válido → crear
 *   4. si hay duda → decisión humana (nunca se resuelve en silencio)
 *
 * NO hay fuzzy matching, ni similitud de nombres (Levenshtein, tokens…), ni
 * embeddings, ni IA: `displayName` NUNCA es clave, ni siquiera de desempate. Dos
 * personas con el mismo nombre son dos personas.
 */

import type { SheetRecord } from './influencer-sheet';
import { isRecordValid, normalizeProductRef } from './influencer-sheet';
import type { SocialPlatform } from './influencers';

// ─────────────────────────── Identidad ─────────────────────────────────────────

export type IdentityOutcome =
  /** El binding previo de la fuente apunta a una persona: se mantiene. */
  | 'matched_binding'
  /** Exactamente un Influencer existente es dueño de la(s) cuenta(s). */
  | 'matched_existing'
  /** Ninguna cuenta existe y el registro es válido: se crea la persona. */
  | 'create_new'
  /** Las cuentas del registro apuntan a Influencers DISTINTOS. Decide un humano. */
  | 'ambiguous'
  /** Una cuenta ya es de otra persona incompatible con el binding / con otra clave. */
  | 'conflict'
  /** Falta una decisión humana (p. ej. cambio de cuenta en la misma plataforma). */
  | 'needs_resolution'
  /** El registro no cumple el esquema. */
  | 'invalid'
  /** Estaba en el Sheet anterior (y vinculado) y ya no aparece. Nunca retira nada. */
  | 'missing_from_source';

export type IdentityReason =
  | 'record_invalid'
  | 'accounts_match_different_influencers'
  | 'account_owned_by_other_influencer'
  | 'influencer_bound_to_other_key'
  | 'account_change'
  | 'participation_retired';

export type ParticipationOutcome = 'associate' | 'exists' | 'retired';

/** Cuenta que se añadiría a un Influencer existente (aditivo y sin conflicto). */
export interface AdditiveAccount {
  readonly platform: SocialPlatform;
  readonly handle: string;
  readonly normalizedHandle: string;
  readonly row: number;
}

export interface IdentityFacts {
  /** Binding previo de esta clave en esta fuente. */
  readonly binding?: { readonly influencerId: string; readonly campaignInfluencerId: string } | undefined;
  /** Dueño actual de cada cuenta del registro (`plataforma:handle normalizado` → influencerId). */
  readonly accountOwners: ReadonlyMap<string, string>;
  /** Influencers ya vinculados en ESTA fuente a OTRA clave (influencerId → clave). */
  readonly boundToOtherKey: ReadonlyMap<string, string>;
  /** Plataformas en las que cada Influencer candidato ya tiene alguna cuenta (influencerId → plataforma → handles). */
  readonly accountsByInfluencer: ReadonlyMap<string, ReadonlyMap<SocialPlatform, ReadonlySet<string>>>;
  /** Participación de cada candidato en ESTA campaña (influencerId → estado). */
  readonly participations: ReadonlyMap<
    string,
    { readonly id: string; readonly status: 'activo' | 'retirado' }
  >;
  /** Nombre actual de los Influencers (solo para INFORMAR una diferencia; nunca decide). */
  readonly displayNames: ReadonlyMap<string, string>;
}

export interface IdentityDecision {
  readonly outcome: IdentityOutcome;
  readonly influencerId?: string | undefined;
  readonly campaignInfluencerId?: string | undefined;
  /** Influencers en juego cuando hay ambigüedad o conflicto. */
  readonly candidates: readonly string[];
  readonly reasons: readonly IdentityReason[];
  readonly additiveAccounts: readonly AdditiveAccount[];
  /** Cuentas que exigen decisión humana (cambio de cuenta en una plataforma ya ocupada). */
  readonly accountChanges: readonly AdditiveAccount[];
  readonly participation: ParticipationOutcome | undefined;
  /** El nombre del Sheet difiere del actual: se informa; NO se sobrescribe. */
  readonly nameDiffers: { readonly sheet: string; readonly existing: string } | undefined;
}

export function accountKey(platform: SocialPlatform, normalizedHandle: string): string {
  return `${platform}:${normalizedHandle}`;
}

function participacionDe(
  influencerId: string,
  facts: IdentityFacts,
): { participation: ParticipationOutcome; campaignInfluencerId: string | undefined } {
  const existente = facts.participations.get(influencerId);
  if (existente === undefined) return { participation: 'associate', campaignInfluencerId: undefined };
  return {
    participation: existente.status === 'activo' ? 'exists' : 'retired',
    campaignInfluencerId: existente.id,
  };
}

/**
 * Decide la identidad de UN registro. Determinística: mismas entradas, misma
 * decisión.
 */
export function decidirIdentidad(record: SheetRecord, facts: IdentityFacts): IdentityDecision {
  const base = {
    candidates: [] as string[],
    reasons: [] as IdentityReason[],
    additiveAccounts: [] as AdditiveAccount[],
    accountChanges: [] as AdditiveAccount[],
    participation: undefined,
    nameDiffers: undefined,
  };

  if (!isRecordValid(record)) {
    return { ...base, outcome: 'invalid', reasons: ['record_invalid'] };
  }

  const propietarios = [
    ...new Set(
      record.accounts
        .map((a) => facts.accountOwners.get(accountKey(a.platform, a.normalizedHandle)))
        .filter((id): id is string => id !== undefined),
    ),
  ];
  const sinDueno = record.accounts.filter(
    (a) => !facts.accountOwners.has(accountKey(a.platform, a.normalizedHandle)),
  );

  /** Clasifica las cuentas sin dueño para un Influencer ya identificado. */
  const clasificarNuevas = (influencerId: string) => {
    const existentes = facts.accountsByInfluencer.get(influencerId);
    const aditivas: AdditiveAccount[] = [];
    const cambios: AdditiveAccount[] = [];
    for (const cuenta of sinDueno) {
      // Si la persona ya tiene OTRA cuenta en esa plataforma, no se sabe si es un
      // alta o un reemplazo: lo decide un humano. Nunca se pisa ni se asume.
      const enPlataforma = existentes?.get(cuenta.platform);
      (enPlataforma !== undefined && enPlataforma.size > 0 ? cambios : aditivas).push(cuenta);
    }
    return { aditivas, cambios };
  };

  const nameDiffers = (influencerId: string) => {
    const existente = facts.displayNames.get(influencerId);
    return existente !== undefined && existente.toLowerCase() !== record.displayName.toLowerCase()
      ? { sheet: record.displayName, existing: existente }
      : undefined;
  };

  // CASO A — binding previo: gana siempre sobre re-inferir.
  if (facts.binding !== undefined) {
    const x = facts.binding.influencerId;
    const ajenos = propietarios.filter((id) => id !== x);
    if (ajenos.length > 0) {
      return {
        ...base,
        outcome: 'conflict',
        influencerId: x,
        campaignInfluencerId: facts.binding.campaignInfluencerId,
        candidates: [x, ...ajenos],
        reasons: ['account_owned_by_other_influencer'],
        nameDiffers: nameDiffers(x),
      };
    }
    const { aditivas, cambios } = clasificarNuevas(x);
    const { participation } = participacionDe(x, facts);
    const razones: IdentityReason[] = [];
    if (cambios.length > 0) razones.push('account_change');
    if (participation === 'retired') razones.push('participation_retired');
    return {
      ...base,
      outcome: razones.length > 0 ? 'needs_resolution' : 'matched_binding',
      influencerId: x,
      campaignInfluencerId: facts.binding.campaignInfluencerId,
      reasons: razones,
      additiveAccounts: aditivas,
      accountChanges: cambios,
      participation,
      nameDiffers: nameDiffers(x),
    };
  }

  // CASO C — ninguna cuenta existe: se puede crear.
  if (propietarios.length === 0) {
    return { ...base, outcome: 'create_new', participation: 'associate' };
  }

  // CASO D — las cuentas del mismo registro pertenecen a personas distintas.
  if (propietarios.length > 1) {
    return {
      ...base,
      outcome: 'ambiguous',
      candidates: propietarios,
      reasons: ['accounts_match_different_influencers'],
    };
  }

  // CASO B — exactamente un Influencer.
  const x = propietarios[0]!;
  const vinculadoA = facts.boundToOtherKey.get(x);
  if (vinculadoA !== undefined && vinculadoA !== record.sourceKey) {
    // CASO E — la misma persona ya es OTRA clave de esta fuente.
    return {
      ...base,
      outcome: 'conflict',
      influencerId: x,
      candidates: [x],
      reasons: ['influencer_bound_to_other_key'],
      nameDiffers: nameDiffers(x),
    };
  }
  const { aditivas, cambios } = clasificarNuevas(x);
  const { participation, campaignInfluencerId } = participacionDe(x, facts);
  const razones: IdentityReason[] = [];
  if (cambios.length > 0) razones.push('account_change');
  if (participation === 'retired') razones.push('participation_retired');
  return {
    ...base,
    outcome: razones.length > 0 ? 'needs_resolution' : 'matched_existing',
    influencerId: x,
    campaignInfluencerId,
    reasons: razones,
    additiveAccounts: aditivas,
    accountChanges: cambios,
    participation,
    nameDiffers: nameDiffers(x),
  };
}

// ─────────────────────────── Producto ──────────────────────────────────────────

export type ProductOutcome =
  /** Un producto de la campaña coincide y puede asignarse. */
  | 'assign'
  /** Ya está asignado. */
  | 'unchanged'
  /** Ningún producto de la campaña coincide. */
  | 'unresolved'
  /** Más de un producto de la campaña coincide. */
  | 'ambiguous'
  /** El influencer ya trabaja OTRO producto y el Sheet no lo incluye: no se reemplaza solo. */
  | 'product_change';

export interface CampaignProductOption {
  readonly campaignProductId: string;
  readonly brand: string;
  readonly model: string;
}

export interface ProductDecision {
  readonly ref: string;
  readonly normalizedRef: string;
  readonly outcome: ProductOutcome;
  readonly campaignProductId?: string | undefined;
  readonly candidates: readonly string[];
}

/**
 * Contrato de resolución de producto: la referencia del Sheet se compara con el
 * `model` de los productos de ESTA campaña, tras normalizar (NFKC, espacios,
 * minúsculas). Sin similitud. Exactamente uno → se puede asignar; ninguno →
 * `unresolved`; varios (misma marca-modelo normalizada en marcas distintas) →
 * `ambiguous`. Un producto de otra campaña no está entre las opciones.
 */
export function decidirProductos(
  record: SheetRecord,
  opciones: readonly CampaignProductOption[],
  asignados: ReadonlySet<string>,
): ProductDecision[] {
  const porModelo = new Map<string, CampaignProductOption[]>();
  for (const o of opciones) {
    const clave = normalizeProductRef(o.model);
    porModelo.set(clave, [...(porModelo.get(clave) ?? []), o]);
  }

  // Productos que el Sheet resuelve sin ambigüedad: el conjunto «declarado».
  const declarados = new Set<string>();
  for (const p of record.products) {
    const c = porModelo.get(p.normalizedRef) ?? [];
    if (c.length === 1) declarados.add(c[0]!.campaignProductId);
  }
  // ¿Trabaja ya algún producto que el Sheet NO declara? Entonces el producto del
  // Sheet no es un alta sino un cambio: lo decide un humano.
  const hayProductoAjeno = [...asignados].some((id) => !declarados.has(id));

  return record.products.map((p): ProductDecision => {
    const coincidencias = porModelo.get(p.normalizedRef) ?? [];
    if (coincidencias.length === 0) {
      return { ref: p.ref, normalizedRef: p.normalizedRef, outcome: 'unresolved', candidates: [] };
    }
    if (coincidencias.length > 1) {
      return {
        ref: p.ref,
        normalizedRef: p.normalizedRef,
        outcome: 'ambiguous',
        candidates: coincidencias.map((c) => c.campaignProductId),
      };
    }
    const id = coincidencias[0]!.campaignProductId;
    if (asignados.has(id)) {
      return {
        ref: p.ref,
        normalizedRef: p.normalizedRef,
        outcome: 'unchanged',
        campaignProductId: id,
        candidates: [id],
      };
    }
    return {
      ref: p.ref,
      normalizedRef: p.normalizedRef,
      outcome: hayProductoAjeno ? 'product_change' : 'assign',
      campaignProductId: id,
      candidates: [id],
    };
  });
}

// ─────────────────────────── Diferencias entre snapshots ───────────────────────

export type RecordChange = 'new' | 'unchanged' | 'changed' | 'missing_from_source';

export interface RecordDiff {
  readonly sourceKey: string;
  readonly change: RecordChange;
  /** Qué cambió (solo en `changed`). */
  readonly fields: readonly ('name' | 'accounts' | 'products' | 'future')[];
}

interface Comparable {
  readonly sourceKey: string;
  readonly fingerprint: Readonly<Record<'name' | 'accounts' | 'products' | 'future', string>>;
}

const PARTES = ['name', 'accounts', 'products', 'future'] as const;

/**
 * Compara dos lecturas del Sheet POR CLAVE ESTABLE (nunca por número de fila:
 * una fila puede moverse entre snapshots). `missing_from_source` NO implica
 * ninguna baja: solo avisa para que un humano revise.
 */
export function compararRegistros(
  anteriores: readonly Comparable[],
  nuevos: readonly Comparable[],
): RecordDiff[] {
  const antes = new Map(anteriores.map((r) => [r.sourceKey, r.fingerprint]));
  const ahora = new Map(nuevos.map((r) => [r.sourceKey, r.fingerprint]));
  const diffs: RecordDiff[] = [];
  for (const [clave, huella] of ahora) {
    const previa = antes.get(clave);
    if (previa === undefined) {
      diffs.push({ sourceKey: clave, change: 'new', fields: [] });
      continue;
    }
    const campos = PARTES.filter((parte) => previa[parte] !== huella[parte]);
    diffs.push(
      campos.length === 0
        ? { sourceKey: clave, change: 'unchanged', fields: [] }
        : { sourceKey: clave, change: 'changed', fields: campos },
    );
  }
  for (const clave of antes.keys()) {
    if (!ahora.has(clave)) diffs.push({ sourceKey: clave, change: 'missing_from_source', fields: [] });
  }
  return diffs;
}
