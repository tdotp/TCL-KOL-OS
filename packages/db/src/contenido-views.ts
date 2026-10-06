/**
 * Lecturas de PRESENTACIÓN del contenido (entregables y guiones) para la interfaz (V2 · Fase 7).
 *
 * Solo componen los casos de uso existentes (`deliverables`, `script-versions`, `script-review`,
 * `content-analysis`, `script-approval`, `campaign-influencers`, `chat-views`): aquí no hay reglas de
 * dominio nuevas ni escrituras. Son SOLO de la UI (no son tools del agente: clasificadas `ui-only` en el
 * manifiesto).
 *
 * Reglas de acceso (dentro de la consulta, no en la página):
 *  · Cuenta (admin, director, consultor: `script:read`) recibe el DTO COMPLETO.
 *  · Operativo (`deliverable:read` SIN `script:read`) recibe un DTO REDUCIDO: solo el estado de cada pieza
 *    (última `{numero, estado}` y aprobada vigente `{numero, fecha, archivo}`). Sin versiones intermedias,
 *    hallazgos, comentarios, ids de fuente, ids de versión, evaluación ni propuestas.
 *  · Cliente, otra organización, o un rol sin la capacidad ⇒ `RESOURCE_NOT_FOUND` (no se distingue).
 *
 * Separación de orígenes: un HALLAZGO del Brief (`origen: 'brief'`, derivado por la IA, sin autor) y un
 * COMENTARIO de SmartPR (`origen: 'smartpr'`, escrito por una persona, con autor) son tipos distintos y
 * viajan en listas distintas: nunca se mezclan ni uno puede pasar por el otro.
 *
 * Lo que sale NUNCA incluye rutas de almacenamiento, hashes de archivo ni URLs externas. Los textos que
 * provienen de documentos o del modelo (descripciones de hallazgos, citas, valores del Brief, nombres) se
 * entregan TAL CUAL y son NO CONFIABLES: la interfaz los pinta como texto (React los escapa); jamás HTML.
 */

import {
  type CampaignInfluencerDetail,
  type Criticality,
  type DeliverableStatus,
  type ResumenDeEntregable,
  type Result,
  type ScriptVersionStatus,
  type User,
  campoDelCatalogo,
  describirLocalizador,
  err,
  isOpenScriptVersion,
  ok,
  roleCan,
  validarLocalizador,
} from '@tcl-kol-os/domain';
import { getPool } from './client.ts';
import {
  type EntregableDeCuenta,
  type EntregableDeEstado,
  NO_ENCONTRADO_DE_CONTENIDO,
  esUuid,
  listarEntregablesDeCampana,
  obtenerEntregable,
} from './deliverables.ts';
import { listarInfluencersDeCampanaConConteo, obtenerCampaignInfluencer } from './campaign-influencers.ts';
import {
  type HallazgoDeContenido,
  type ProntitudDeVersion,
  type RevisionVigente,
  type SeveridadesDeHallazgos,
  type TipoDeRevision,
  type VigenciaDeRevision,
  listarHallazgos,
  evaluarProntitudDeAnalisis,
  huellaDeBriefRector,
  obtenerBriefRector,
  obtenerRevisionVigente,
  resumenesDeContenidoDeVersiones,
} from './content-analysis.ts';
import {
  type EstadoDeAdjunto,
  type VistaDeAccionPropuesta,
  estadoDeAdjuntos,
  obtenerAccionDeChat,
} from './chat-views.ts';
import { type ComentarioDeRevision, listarComentariosDeRevision } from './script-review.ts';
import { obtenerEvaluacionDeAprobacion } from './script-approval.ts';
import { listarVersionesDeEntregable, obtenerVersionDeGuion } from './script-versions.ts';

// ─────────────────────────── Tipos: lista ──────────────────────────────────────

/** Estado de la revisión de la ÚLTIMA versión de una pieza (solo Cuenta). */
export interface ResumenDeRevisionEnLista {
  readonly vigencia: VigenciaDeRevision;
  readonly tipo: TipoDeRevision | null;
  /** Número del Brief contra el que se hizo la revisión elegida (`null` si no hay). */
  readonly briefNumero: number | null;
  readonly hallazgos: SeveridadesDeHallazgos;
  readonly totalDeHallazgos: number;
  readonly cambiosSolicitados: number;
  readonly propuestaDeAprobacionPendiente: boolean;
}

export interface VistaDeEntregableEnLista {
  readonly id: string;
  /** Etiqueta del entregable (texto de una persona). */
  readonly nombre: string;
  readonly plataforma: string | undefined;
  readonly estado: DeliverableStatus;
  /** Estado derivado de sus versiones (sin_guion, en_curso, cambios_solicitados, aprobado…). */
  readonly resumen: ResumenDeEntregable;
  /** Número de versiones (solo Cuenta). */
  readonly versiones: number | undefined;
  readonly ultimaVersion:
    | { readonly numero: number; readonly estado: ScriptVersionStatus; readonly fecha: string | undefined }
    | undefined;
  readonly aprobadaVigente:
    { readonly numero: number; readonly fecha: string; readonly archivo: string } | undefined;
  /** Solo Cuenta. */
  readonly revision: ResumenDeRevisionEnLista | undefined;
}

export interface VistaDeParticipacionConContenido {
  readonly participacionId: string;
  readonly influencerNombre: string;
  /** Cuentas del influencer, «plataforma @handle» (presentación). */
  readonly cuentas: readonly string[];
  readonly estadoDeParticipacion: 'activo' | 'retirado';
  readonly productos: readonly string[];
  readonly entregables: readonly VistaDeEntregableEnLista[];
}

export interface VistaDeContenidoDeCampana {
  readonly proyeccion: 'cuenta' | 'estado';
  readonly participaciones: readonly VistaDeParticipacionConContenido[];
  readonly totales: {
    readonly entregablesActivos: number;
    readonly entregablesArchivados: number;
    readonly participacionesActivas: number;
    readonly participacionesRetiradas: number;
  };
  /** Solo Cuenta. `null` = todavía no existe un Brief aprobado (no hay documento rector). */
  readonly briefRector: { readonly versionId: string; readonly numero: number } | null | undefined;
}

// ─────────────────────────── Tipos: detalle ────────────────────────────────────

export interface VistaDeVersionEnHistorial {
  readonly id: string;
  readonly numero: number;
  readonly estado: ScriptVersionStatus;
  readonly fecha: string;
  readonly archivo: string;
  readonly esUltima: boolean;
  /** La ÚNICA con estado `approved`: la aprobada vigente. */
  readonly esAprobadaVigente: boolean;
  /** Fue aprobada alguna vez (vigente o ya reemplazada). */
  readonly aprobadaAlgunaVez: boolean;
  readonly aprobadaEn: string | undefined;
  /** Número de la versión que la reemplazó (sea cual sea su estado anterior). */
  readonly reemplazadaPor: number | undefined;
}

export interface VistaDeArchivoDeVersion {
  /** Para enlazar a `/campanas/{id}/fuentes/{sourceId}` (la descarga del original queda fuera de F7). */
  readonly sourceId: string;
  readonly nombre: string;
  readonly estado: EstadoDeAdjunto;
  readonly etiquetaDeEstado: string;
  /** El estado ya no va a cambiar solo. */
  readonly terminal: boolean;
}

export interface VistaDeRevisionDeVersion {
  readonly vigencia: VigenciaDeRevision;
  readonly tipo: TipoDeRevision | null;
  /** La revisión elegida (CURRENT o, si no hay, la `succeeded` más reciente). */
  readonly fecha: string | undefined;
  /** Brief contra el que se hizo la revisión elegida. */
  readonly briefAnalizado: { readonly versionId: string; readonly numero: number } | null;
  /** Brief rector hoy (puede ser otro: entonces la revisión está STALE). */
  readonly briefVigente: { readonly versionId: string; readonly numero: number } | null;
  /** Persona que registró la revisión humana (solo `tipo === 'human'`). */
  readonly autor: string | undefined;
  /** Nota de la revisión humana (texto de una persona). */
  readonly nota: string | undefined;
  readonly totalDeHallazgos: number;
  readonly hallazgosPorSeveridad: SeveridadesDeHallazgos;
  /** Último intento fallido o en curso que NO desplazó a la revisión elegida (reanálisis). */
  readonly ultimoIntento:
    | {
        readonly estado: 'failed' | 'running' | 'queued' | 'succeeded';
        readonly codigoDeFallo: string | undefined;
        readonly fecha: string;
      }
    | undefined;
  /** ¿Se puede pedir un análisis asistido ahora? (IA activa, Brief rector, fuente lista, tamaño). */
  readonly prontitud: ProntitudDeVersion['prontitud'] | undefined;
  /**
   * Huella del Brief rector que ve la persona: la devuelve al registrar su revisión humana
   * (`huellaVista`) para que no se registre contra un Brief que cambió. `undefined` sin Brief rector.
   */
  readonly huellaDelBrief: string | undefined;
}

export interface VistaDeRequisitoDelBrief {
  readonly claveDelCampo: string;
  /** Etiqueta en español del catálogo (o la clave si no está). */
  readonly etiquetaDelCampo: string;
  readonly elemento: number | undefined;
  readonly criticidad: Criticality;
  /** Valor del Brief que se le mandó al modelo (texto no confiable). */
  readonly valor: string;
  readonly evidencias: readonly {
    readonly cita: string;
    readonly relacion: string;
    readonly archivo: string;
    readonly sourceId: string;
    readonly localizador: string | undefined;
  }[];
}

export interface VistaDeCitaDelGuion {
  readonly sourceId: string;
  readonly fragmento: number;
  /** Ubicación legible («página 2», «sección …»); puede incrustar texto del documento. */
  readonly localizador: string | undefined;
  /** Cita literal del guion (texto no confiable). */
  readonly cita: string;
}

/**
 * Hallazgo DERIVADO DEL BRIEF: observación del análisis asistido. No tiene autor humano y no es un
 * comentario: `origen: 'brief'` lo distingue de los comentarios de SmartPR.
 */
export interface VistaDeHallazgoDelBrief {
  readonly id: string;
  readonly origen: 'brief';
  readonly orden: number;
  readonly categoria: string;
  readonly base: string;
  readonly severidad: 'alta' | 'media' | 'baja';
  readonly estadoDeLaAfirmacion: string | undefined;
  /** Texto del MODELO: dato no confiable. */
  readonly descripcion: string;
  readonly requisitosDelBrief: readonly VistaDeRequisitoDelBrief[];
  readonly citasDelGuion: readonly VistaDeCitaDelGuion[];
}

/** Comentario HUMANO de SmartPR (editorial o cambio solicitado). Siempre tiene autor visible. */
export interface VistaDeComentarioSmartPR {
  readonly id: string;
  readonly origen: 'smartpr';
  readonly tipo: 'editorial' | 'change_request';
  readonly autor: string;
  readonly esMio: boolean;
  readonly fecha: string;
  /** Canal por el que se escribió: la interfaz o el chat (en cuyo caso `mensajeDeChatId` lo ubica). */
  readonly canal: 'ui' | 'chat';
  readonly mensajeDeChatId: string | undefined;
  /** Texto de una persona. */
  readonly texto: string;
  readonly localizador: string | undefined;
}

export interface VistaDeEvaluacionDeAprobacion {
  readonly elegible: boolean;
  readonly bloqueos: readonly {
    readonly codigo: string;
    readonly mensaje: string;
    readonly razon: string | undefined;
  }[];
  /** La huella que la persona debe devolver al aprobar (`huellaVista`). */
  readonly huella: string;
  /** Brief gobernante (el rector contra el que se revisó). */
  readonly briefGobernante: { readonly versionId: string; readonly numero: number } | null;
  readonly revision: {
    readonly tipo: TipoDeRevision;
    readonly fecha: string | null;
  } | null;
  readonly hallazgosAbiertos: SeveridadesDeHallazgos & { readonly total: number };
  readonly comentarios: number;
  /** La versión aprobada vigente que esta aprobación reemplazaría. */
  readonly reemplaza: { readonly numero: number } | null;
  /** Número de la versión más reciente si es mayor que la evaluada (advertencia). */
  readonly versionMasReciente: number | null;
  /** Avisos que la persona lee ANTES de aprobar (no bloquean). */
  readonly advertencias: readonly string[];
}

export interface VistaDeVersionElegida {
  readonly id: string;
  readonly numero: number;
  readonly estado: ScriptVersionStatus;
  readonly fecha: string;
  readonly creadaPor: string;
  readonly esUltima: boolean;
  readonly esAprobadaVigente: boolean;
  readonly aprobadaAlgunaVez: boolean;
  readonly aprobadaEn: string | undefined;
  readonly aprobadaPor: string | undefined;
  readonly reemplazadaPor: number | undefined;
  /** Recibida o en revisión: admite comentarios y cambios solicitados. */
  readonly abierta: boolean;
  readonly archivo: VistaDeArchivoDeVersion | undefined;
  readonly revision: VistaDeRevisionDeVersion;
  /** Hallazgos del Brief de la revisión elegida (vacío si es humana o no hay). */
  readonly hallazgosDelBrief: readonly VistaDeHallazgoDelBrief[];
  /** Comentarios editoriales de SmartPR. */
  readonly comentarios: readonly VistaDeComentarioSmartPR[];
  /** Cambios solicitados por SmartPR (cada uno es un comentario `change_request`). */
  readonly cambiosSolicitados: readonly VistaDeComentarioSmartPR[];
  /** `null` si la versión ya no admite aprobarse (aprobada, reemplazada o con cambios solicitados). */
  readonly evaluacion: VistaDeEvaluacionDeAprobacion | null;
  /** Propuesta `script_version.approve` abierta para ESTA versión (informativa: se confirma en el chat). */
  readonly propuestaDeAprobacion:
    { readonly hay: true; readonly vista: VistaDeAccionPropuesta | undefined } | { readonly hay: false };
}

/** DTO COMPLETO (Cuenta). */
export interface VistaDeDeliverableDeCuenta {
  readonly proyeccion: 'cuenta';
  readonly id: string;
  readonly nombre: string;
  readonly plataforma: string | undefined;
  readonly estado: DeliverableStatus;
  readonly resumen: ResumenDeEntregable;
  readonly producto: string | undefined;
  readonly participacion: {
    readonly id: string;
    readonly influencerNombre: string;
    readonly estado: 'activo' | 'retirado';
    readonly productos: readonly string[];
  };
  /** Más nueva primero. */
  readonly versiones: readonly VistaDeVersionEnHistorial[];
  /** `null` si todavía no hay versiones. */
  readonly version: VistaDeVersionElegida | null;
  /** Brief rector hoy (`null` = todavía no existe un Brief aprobado). */
  readonly briefVigente: { readonly versionId: string; readonly numero: number } | null;
  /** Qué puede hacer su rol (presentación; el servidor lo vuelve a decidir al ejecutar). */
  readonly permisos: { readonly gestionar: boolean; readonly aprobar: boolean };
}

/** DTO REDUCIDO (Operativo): solo estado. */
export interface VistaDeDeliverableDeEstado {
  readonly proyeccion: 'estado';
  readonly id: string;
  readonly nombre: string;
  readonly plataforma: string | undefined;
  readonly estado: DeliverableStatus;
  readonly resumen: ResumenDeEntregable;
  readonly participacion: {
    readonly id: string;
    readonly influencerNombre: string;
    readonly estado: 'activo' | 'retirado';
    readonly productos: readonly string[];
  };
  readonly ultima: { readonly numero: number; readonly estado: ScriptVersionStatus } | null;
  readonly aprobadaVigente: {
    readonly numero: number;
    readonly fecha: string;
    readonly archivo: string;
  } | null;
}

export type VistaDeDeliverable = VistaDeDeliverableDeCuenta | VistaDeDeliverableDeEstado;

export interface OpcionesDeDeliverable {
  /** Cerco de campaña (obligatorio en la práctica: una pieza de otra campaña es «no existe»). */
  readonly alcance: { readonly campaignId: string };
  /** Número de la versión a detallar (por defecto la última). */
  readonly versionNumber?: number | undefined;
  /** Si se indica, la pieza debe ser de esa participación (la URL manipulada ⇒ «no existe»). */
  readonly participacionId?: string | undefined;
}

// ─────────────────────────── Utilidades ────────────────────────────────────────

const SIN_HALLAZGOS: SeveridadesDeHallazgos = { alta: 0, media: 0, baja: 0 };

/** Un rechazo de autorización se informa como «no existe»: no se revela si el recurso existe. */
function comoNoEncontrado<T>(r: Result<T>): Result<T> {
  if (r.ok) return r;
  return r.error.code === 'FORBIDDEN_ROLE' ? err(NO_ENCONTRADO_DE_CONTENIDO) : r;
}

async function nombresDePersonas(
  organizationId: string,
  ids: readonly (string | undefined)[],
): Promise<ReadonlyMap<string, string>> {
  const unicos = [...new Set(ids.filter((x): x is string => x !== undefined && esUuid(x)))];
  const nombres = new Map<string, string>();
  if (unicos.length === 0) return nombres;
  const { rows } = await getPool().query<{ id: string; name: string }>(
    `SELECT id, name FROM users WHERE id = ANY($1::uuid[]) AND organization_id = $2`,
    [unicos, organizationId],
  );
  for (const r of rows) nombres.set(r.id, r.name);
  return nombres;
}

function etiquetaDeProducto(p: { readonly brand: string; readonly model: string }): string {
  return `${p.brand} ${p.model}`.trim();
}

function localizadorLegible(localizador: unknown): string | undefined {
  if (localizador === undefined || localizador === null) return undefined;
  const valido = validarLocalizador(localizador);
  return valido.ok ? describirLocalizador(valido.value) : undefined;
}

function comoParticipacion(detalle: CampaignInfluencerDetail) {
  return {
    id: detalle.campaignInfluencer.id,
    influencerNombre: detalle.influencer.displayName,
    estado: detalle.campaignInfluencer.status,
    productos: detalle.products.map(etiquetaDeProducto),
  };
}

// ─────────────────────────── Lista de la campaña ───────────────────────────────

/**
 * Los entregables de la campaña agrupados por participación, con su estado derivado, última versión,
 * aprobada vigente y (solo Cuenta) el estado de revisión de la última versión. Operativo recibe la
 * proyección reducida; cliente, otra organización o un rol sin la capacidad, `RESOURCE_NOT_FOUND`.
 */
export async function listarContenidoDeCampana(
  actor: User,
  campaignId: string,
): Promise<Result<VistaDeContenidoDeCampana>> {
  if (!esUuid(campaignId)) return err(NO_ENCONTRADO_DE_CONTENIDO);

  const pagina = await listarEntregablesDeCampana(actor, campaignId, {
    incluirArchivados: true,
    limite: 200,
  });
  if (!pagina.ok) return comoNoEncontrado(pagina);
  const proyeccion = pagina.value.projection;

  const participantes = await listarInfluencersDeCampanaConConteo(actor, campaignId, {
    incluirRetirados: true,
  });
  if (!participantes.ok) return comoNoEncontrado(participantes);

  // Cuenta: estado de revisión de la última versión de cada pieza, en una sola pasada.
  let resumenes: ReadonlyMap<
    string,
    {
      readonly vigencia: VigenciaDeRevision;
      readonly kind: TipoDeRevision | null;
      readonly findingsBySeverity: SeveridadesDeHallazgos;
      readonly findingTotal: number;
      readonly requestedChanges: number;
      readonly pendingApproval: boolean;
    }
  > = new Map();
  let briefNumeroDeRevision: ReadonlyMap<string, number | null> = new Map();
  let briefRector: VistaDeContenidoDeCampana['briefRector'];
  if (proyeccion === 'cuenta') {
    const cuentas = pagina.value.items.filter((i): i is EntregableDeCuenta => i.projection === 'cuenta');
    const idsDeUltimas = cuentas.flatMap((i) => (i.latest === null ? [] : [i.latest.id]));
    const r = await resumenesDeContenidoDeVersiones(actor, campaignId, idsDeUltimas);
    if (r.ok) resumenes = r.value;
    const rector = await obtenerBriefRector(actor, campaignId);
    briefRector = rector.ok ? { versionId: rector.value.versionId, numero: rector.value.number } : null;
    briefNumeroDeRevision = new Map(
      await Promise.all(
        idsDeUltimas.map(async (id): Promise<[string, number | null]> => {
          const v = await obtenerRevisionVigente(actor, id, { campaignId });
          return [id, v.ok ? (v.value.briefVersion?.number ?? null) : null];
        }),
      ),
    );
  }

  const porParticipacion = new Map<string, VistaDeEntregableEnLista[]>();
  for (const item of pagina.value.items) {
    const lista =
      porParticipacion.get(
        item.projection === 'cuenta' ? item.deliverable.campaignInfluencerId : item.campaignInfluencerId,
      ) ?? [];
    lista.push(
      item.projection === 'cuenta'
        ? vistaDeCuentaEnLista(item, resumenes, briefNumeroDeRevision)
        : vistaDeEstadoEnLista(item),
    );
    porParticipacion.set(
      item.projection === 'cuenta' ? item.deliverable.campaignInfluencerId : item.campaignInfluencerId,
      lista,
    );
  }

  return ok({
    proyeccion,
    participaciones: participantes.value.items.map((d) => ({
      participacionId: d.campaignInfluencer.id,
      influencerNombre: d.influencer.displayName,
      cuentas: d.accounts.map((c) => `${c.platform} @${c.handle}`),
      estadoDeParticipacion: d.campaignInfluencer.status,
      productos: d.products.map(etiquetaDeProducto),
      entregables: porParticipacion.get(d.campaignInfluencer.id) ?? [],
    })),
    totales: {
      entregablesActivos: pagina.value.items.filter((i) => estadoDe(i) === 'active').length,
      entregablesArchivados: pagina.value.items.filter((i) => estadoDe(i) === 'archived').length,
      participacionesActivas: participantes.value.activos,
      participacionesRetiradas: participantes.value.retirados,
    },
    briefRector,
  });
}

function estadoDe(i: EntregableDeCuenta | EntregableDeEstado): DeliverableStatus {
  return i.projection === 'cuenta' ? i.deliverable.status : i.status;
}

function vistaDeCuentaEnLista(
  item: EntregableDeCuenta,
  resumenes: ReadonlyMap<
    string,
    {
      readonly vigencia: VigenciaDeRevision;
      readonly kind: TipoDeRevision | null;
      readonly findingsBySeverity: SeveridadesDeHallazgos;
      readonly findingTotal: number;
      readonly requestedChanges: number;
      readonly pendingApproval: boolean;
    }
  >,
  briefNumeros: ReadonlyMap<string, number | null>,
): VistaDeEntregableEnLista {
  const resumen = item.latest === null ? undefined : resumenes.get(item.latest.id);
  return {
    id: item.deliverable.id,
    nombre: item.deliverable.label,
    plataforma: item.deliverable.platform,
    estado: item.deliverable.status,
    resumen: item.resumen,
    versiones: item.versionCount,
    ultimaVersion:
      item.latest === null
        ? undefined
        : { numero: item.latest.version, estado: item.latest.status, fecha: item.latest.createdAt },
    aprobadaVigente:
      item.currentApproved === null
        ? undefined
        : {
            numero: item.currentApproved.version,
            fecha: item.currentApproved.approvedAt,
            archivo: item.currentApproved.filename,
          },
    revision:
      item.latest === null
        ? undefined
        : {
            vigencia: resumen?.vigencia ?? 'none',
            tipo: resumen?.kind ?? null,
            briefNumero: briefNumeros.get(item.latest.id) ?? null,
            hallazgos: resumen?.findingsBySeverity ?? SIN_HALLAZGOS,
            totalDeHallazgos: resumen?.findingTotal ?? 0,
            cambiosSolicitados: resumen?.requestedChanges ?? 0,
            propuestaDeAprobacionPendiente: resumen?.pendingApproval ?? false,
          },
  };
}

function vistaDeEstadoEnLista(item: EntregableDeEstado): VistaDeEntregableEnLista {
  return {
    id: item.deliverableId,
    nombre: item.label,
    plataforma: item.platform,
    estado: item.status,
    resumen: item.resumen,
    versiones: undefined,
    ultimaVersion:
      item.latest === null
        ? undefined
        : { numero: item.latest.version, estado: item.latest.status, fecha: undefined },
    aprobadaVigente:
      item.currentApproved === null
        ? undefined
        : {
            numero: item.currentApproved.version,
            fecha: item.currentApproved.approvedAt,
            archivo: item.currentApproved.filename,
          },
    revision: undefined,
  };
}

// ─────────────────────────── Detalle de un entregable ──────────────────────────

const ADVERTENCIA_HUMANA = 'Revisión humana, no asistida por IA.';

function advertenciasDeAprobacion(args: {
  readonly tipo: TipoDeRevision | undefined;
  readonly hallazgos: SeveridadesDeHallazgos & { readonly total: number };
  readonly numero: number;
  readonly versionMasReciente: number | null;
  readonly reemplaza: number | undefined;
}): string[] {
  const avisos: string[] = [];
  const { total, alta, media, baja } = args.hallazgos;
  if (total > 0) {
    avisos.push(
      `${total} hallazgo${total === 1 ? '' : 's'} abierto${total === 1 ? '' : 's'} (${alta} alta, ${media} media, ${baja} baja): no bloquean, decide la persona.`,
    );
  }
  if (args.tipo === 'human') avisos.push(ADVERTENCIA_HUMANA);
  if (args.versionMasReciente !== null) {
    avisos.push(`Existe una versión más reciente (V${args.versionMasReciente}) de este entregable.`);
  }
  if (args.reemplaza !== undefined) avisos.push(`Reemplaza a la versión ${args.reemplaza} aprobada.`);
  return avisos;
}

function comoComentario(c: ComentarioDeRevision): VistaDeComentarioSmartPR {
  return {
    id: c.id,
    origen: 'smartpr',
    tipo: c.kind,
    autor: c.authorDisplayName,
    esMio: c.authorRelation === 'self',
    fecha: c.createdAt,
    canal: c.origin,
    mensajeDeChatId: c.chatMessageId,
    texto: c.body,
    localizador: localizadorLegible(c.locator),
  };
}

function comoHallazgo(h: HallazgoDeContenido): VistaDeHallazgoDelBrief {
  return {
    id: h.id,
    origen: 'brief',
    orden: h.ordinal,
    categoria: h.category,
    base: h.basis,
    severidad: h.severity,
    estadoDeLaAfirmacion: h.claimStatus,
    descripcion: h.description,
    requisitosDelBrief: h.briefRefs.map((r) => ({
      claveDelCampo: r.fieldKey,
      etiquetaDelCampo: campoDelCatalogo(r.fieldKey)?.label ?? r.fieldKey,
      elemento: r.itemIndex,
      criticidad: r.criticidad,
      valor: r.valueSnippet,
      evidencias: r.evidence.map((e) => ({
        cita: e.quote,
        relacion: e.relation,
        archivo: e.filename,
        sourceId: e.sourceId,
        localizador: localizadorLegible(e.locator),
      })),
    })),
    citasDelGuion: h.scriptRefs.map((r) => ({
      sourceId: r.sourceId,
      fragmento: r.fragmentOrdinal,
      localizador: localizadorLegible(r.locator),
      cita: r.quote,
    })),
  };
}

/** IDs de las propuestas de aprobación abiertas (no vencidas) de ESA versión, de ESA campaña y organización. */
async function propuestasAbiertasDeAprobacion(
  actor: User,
  campaignId: string,
  versionId: string,
): Promise<readonly string[]> {
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT id FROM proposed_actions
      WHERE organization_id = $1 AND campaign_id = $2 AND resource_id = $3
        AND action_type = 'script_version.approve'
        AND status IN ('pending', 'confirmed') AND expires_at > now()
      ORDER BY created_at DESC LIMIT 3`,
    [actor.organizationId, campaignId, versionId],
  );
  return rows.map((r) => r.id);
}

/**
 * Una pieza con su historial completo (V1…Vn, más nueva primero, con `esUltima`, `esAprobadaVigente` y
 * «reemplazada por Vn») y el detalle de la versión elegida (`versionNumber`, por defecto la última):
 * archivo, revisión vigente, hallazgos del Brief, comentarios y cambios solicitados de SmartPR (por
 * separado), evaluación de aprobación y propuesta pendiente.
 *
 * Cuenta ⇒ DTO completo. Operativo ⇒ DTO reducido (sin versiones intermedias, hallazgos, comentarios,
 * archivo, ids de fuente ni propuesta). Cliente / otra organización / sin rol / pieza de otra campaña o
 * participación ⇒ `RESOURCE_NOT_FOUND`.
 */
export async function obtenerDeliverableConVersiones(
  actor: User,
  deliverableId: string,
  opciones: OpcionesDeDeliverable,
): Promise<Result<VistaDeDeliverable>> {
  const { campaignId } = opciones.alcance;
  if (!esUuid(deliverableId) || !esUuid(campaignId)) return err(NO_ENCONTRADO_DE_CONTENIDO);
  if (opciones.participacionId !== undefined && !esUuid(opciones.participacionId)) {
    return err(NO_ENCONTRADO_DE_CONTENIDO);
  }

  const leida = await obtenerEntregable(actor, deliverableId, { alcance: opciones.alcance });
  if (!leida.ok) return comoNoEncontrado(leida);
  const pieza = leida.value;
  const participacionDeLaPieza =
    pieza.projection === 'cuenta' ? pieza.deliverable.campaignInfluencerId : pieza.campaignInfluencerId;
  if (opciones.participacionId !== undefined && opciones.participacionId !== participacionDeLaPieza) {
    return err(NO_ENCONTRADO_DE_CONTENIDO);
  }

  const detalleParticipacion = await obtenerCampaignInfluencer(actor, participacionDeLaPieza);
  if (!detalleParticipacion.ok) return comoNoEncontrado(detalleParticipacion);
  const participacion = comoParticipacion(detalleParticipacion.value);

  // ── Operativo: DTO reducido ──
  if (pieza.projection === 'estado') {
    return ok({
      proyeccion: 'estado',
      id: pieza.deliverableId,
      nombre: pieza.label,
      plataforma: pieza.platform,
      estado: pieza.status,
      resumen: pieza.resumen,
      participacion,
      ultima: pieza.latest === null ? null : { numero: pieza.latest.version, estado: pieza.latest.status },
      aprobadaVigente:
        pieza.currentApproved === null
          ? null
          : {
              numero: pieza.currentApproved.version,
              fecha: pieza.currentApproved.approvedAt,
              archivo: pieza.currentApproved.filename,
            },
    });
  }

  // ── Cuenta: DTO completo ──
  const organizationId = pieza.deliverable.organizationId;
  const versionesLeidas = await listarVersionesDeEntregable(actor, deliverableId, {
    alcance: opciones.alcance,
    limite: 200,
  });
  if (!versionesLeidas.ok) return comoNoEncontrado(versionesLeidas);
  const versiones = versionesLeidas.value.items; // más nueva primero
  const ultima = pieza.deliverable.lastVersion;
  const numeroPorId = new Map(versiones.map((v) => [v.id, v.version]));

  const rector = await obtenerBriefRector(actor, campaignId);
  const briefVigente = rector.ok ? { versionId: rector.value.versionId, numero: rector.value.number } : null;

  const historial: VistaDeVersionEnHistorial[] = versiones.map((v) => ({
    id: v.id,
    numero: v.version,
    estado: v.status,
    fecha: v.createdAt,
    archivo: v.sourceFilename,
    esUltima: v.version === ultima,
    esAprobadaVigente: v.status === 'approved',
    aprobadaAlgunaVez: v.approvedAt !== undefined,
    aprobadaEn: v.approvedAt,
    reemplazadaPor:
      v.supersededByVersionId === undefined ? undefined : numeroPorId.get(v.supersededByVersionId),
  }));

  const elegida =
    opciones.versionNumber === undefined
      ? versiones[0]
      : versiones.find((v) => v.version === opciones.versionNumber);
  if (opciones.versionNumber !== undefined && elegida === undefined) {
    return err(NO_ENCONTRADO_DE_CONTENIDO);
  }

  const productoDeLaPieza = detalleParticipacion.value.products.find(
    (p) => p.campaignProductId === pieza.deliverable.campaignProductId,
  );
  const base = {
    proyeccion: 'cuenta' as const,
    id: pieza.deliverable.id,
    nombre: pieza.deliverable.label,
    plataforma: pieza.deliverable.platform,
    estado: pieza.deliverable.status,
    resumen: pieza.resumen,
    producto: productoDeLaPieza === undefined ? undefined : etiquetaDeProducto(productoDeLaPieza),
    participacion,
    versiones: historial,
    briefVigente,
    permisos: {
      gestionar: roleCan(actor.role, 'script:manage'),
      aprobar: roleCan(actor.role, 'script:approve'),
    },
  };
  if (elegida === undefined) return ok({ ...base, version: null });

  // ── Detalle de la versión elegida ──
  const versionId = elegida.id;
  const abierta = isOpenScriptVersion(elegida.status);
  const revisable =
    elegida.status === 'received' || elegida.status === 'in_review' || elegida.status === 'approved';
  const evaluable = elegida.status === 'received' || elegida.status === 'in_review';

  const [
    detalle,
    vigente,
    hallazgos,
    comentarios,
    prontitud,
    evaluacion,
    resumenes,
    adjuntos,
    propuestasIds,
    huellaDelBrief,
  ] = await Promise.all([
    obtenerVersionDeGuion(actor, versionId, { alcance: opciones.alcance }),
    obtenerRevisionVigente(actor, versionId, opciones.alcance),
    listarHallazgos(actor, { versionId }, opciones.alcance, { limite: 100 }),
    listarComentariosDeRevision(actor, versionId, { limite: 200 }, opciones.alcance),
    revisable
      ? evaluarProntitudDeAnalisis(actor, versionId, { alcance: opciones.alcance })
      : Promise.resolve(undefined),
    evaluable
      ? obtenerEvaluacionDeAprobacion(actor, versionId, opciones.alcance)
      : Promise.resolve(undefined),
    resumenesDeContenidoDeVersiones(actor, campaignId, [versionId]),
    estadoDeAdjuntos(actor, campaignId, [elegida.sourceDocumentId]),
    propuestasAbiertasDeAprobacion(actor, campaignId, versionId),
    revisable ? huellaDeBriefRector(actor, versionId, opciones.alcance) : Promise.resolve(undefined),
  ]);
  if (!detalle.ok) return comoNoEncontrado(detalle);
  if (!vigente.ok) return comoNoEncontrado(vigente);
  if (!hallazgos.ok) return comoNoEncontrado(hallazgos);
  if (!comentarios.ok) return comoNoEncontrado(comentarios);

  const revision: RevisionVigente = vigente.value;
  const nombresDeLaVersion = await nombresDePersonas(organizationId, [
    elegida.createdBy,
    detalle.value.approvedBy,
    revision.run?.createdBy,
  ]);

  // Propuesta de aprobación abierta: informativa, se confirma en el chat (camino F6).
  let propuesta: VistaDeVersionElegida['propuestaDeAprobacion'] = { hay: false };
  if (propuestasIds.length > 0) {
    const vistas = await Promise.all(propuestasIds.map((id) => obtenerAccionDeChat(actor, campaignId, id)));
    const primera = vistas.find((v) => v.ok);
    propuesta = { hay: true, vista: primera !== undefined && primera.ok ? primera.value : undefined };
  } else if (resumenes.ok && resumenes.value.get(versionId)?.pendingApproval === true) {
    propuesta = { hay: true, vista: undefined };
  }

  const ultimoIntento =
    revision.latestAttempt !== null && revision.latestAttempt.id !== revision.run?.id
      ? {
          estado: revision.latestAttempt.status,
          codigoDeFallo: revision.latestAttempt.failureCode,
          fecha: revision.latestAttempt.finishedAt ?? revision.latestAttempt.createdAt,
        }
      : undefined;

  const run = revision.run;
  const vistaDeRevision: VistaDeRevisionDeVersion = {
    vigencia: revision.vigencia,
    tipo: revision.kind,
    fecha: run === null ? undefined : (run.finishedAt ?? run.createdAt),
    briefAnalizado:
      revision.briefVersion === null
        ? null
        : { versionId: revision.briefVersion.id, numero: revision.briefVersion.number },
    briefVigente:
      revision.currentBriefVersion === null
        ? briefVigente
        : { versionId: revision.currentBriefVersion.id, numero: revision.currentBriefVersion.number },
    autor: run !== null && run.kind === 'human' ? nombresDeLaVersion.get(run.createdBy) : undefined,
    nota: run !== null && run.kind === 'human' ? run.note : undefined,
    totalDeHallazgos: revision.findingTotal,
    hallazgosPorSeveridad: revision.findingsBySeverity,
    ultimoIntento,
    prontitud: prontitud !== undefined && prontitud.ok ? prontitud.value.prontitud : undefined,
    huellaDelBrief:
      huellaDelBrief !== undefined && huellaDelBrief.ok ? huellaDelBrief.value.fingerprint : undefined,
  };

  let vistaDeEvaluacion: VistaDeEvaluacionDeAprobacion | null = null;
  if (evaluacion !== undefined && evaluacion.ok) {
    const ev = evaluacion.value;
    const snap = ev.snapshot;
    const hallazgosAbiertos = { ...snap.findings.openBySeverity, total: snap.findings.total };
    const versionMasReciente =
      ev.etiquetas.headVersion > snap.scriptVersion.number ? ev.etiquetas.headVersion : null;
    vistaDeEvaluacion = {
      elegible: ev.elegible,
      bloqueos: ev.bloqueos.map((b) => ({
        codigo: b.code,
        mensaje: b.message,
        razon: typeof b.details?.['reason'] === 'string' ? b.details['reason'] : undefined,
      })),
      huella: ev.huella,
      briefGobernante:
        snap.brief === null ? null : { versionId: snap.brief.versionId, numero: snap.brief.number },
      revision: snap.review === null ? null : { tipo: snap.review.kind, fecha: ev.etiquetas.reviewedAt },
      hallazgosAbiertos,
      comentarios: snap.comments.total,
      reemplaza: snap.replaces === null ? null : { numero: snap.replaces.number },
      versionMasReciente,
      advertencias: advertenciasDeAprobacion({
        tipo: snap.review?.kind,
        hallazgos: hallazgosAbiertos,
        numero: snap.scriptVersion.number,
        versionMasReciente,
        reemplaza: snap.replaces?.number,
      }),
    };
  }

  const adjunto = adjuntos.ok ? adjuntos.value[0] : undefined;
  const todosLosComentarios = comentarios.value.items.map(comoComentario);

  return ok({
    ...base,
    version: {
      id: elegida.id,
      numero: elegida.version,
      estado: elegida.status,
      fecha: elegida.createdAt,
      creadaPor: nombresDeLaVersion.get(elegida.createdBy) ?? 'Persona de la agencia',
      esUltima: elegida.version === ultima,
      esAprobadaVigente: elegida.status === 'approved',
      aprobadaAlgunaVez: elegida.approvedAt !== undefined,
      aprobadaEn: elegida.approvedAt,
      aprobadaPor:
        detalle.value.approvedBy === undefined ? undefined : nombresDeLaVersion.get(detalle.value.approvedBy),
      reemplazadaPor:
        elegida.supersededByVersionId === undefined
          ? undefined
          : numeroPorId.get(elegida.supersededByVersionId),
      abierta,
      archivo: {
        sourceId: elegida.sourceDocumentId,
        nombre: elegida.sourceFilename,
        estado: adjunto?.estado ?? 'desconocido',
        etiquetaDeEstado: adjunto?.etiquetaDeEstado ?? 'Estado desconocido',
        terminal: adjunto?.terminal ?? false,
      },
      revision: vistaDeRevision,
      hallazgosDelBrief: hallazgos.value.items.map(comoHallazgo),
      comentarios: todosLosComentarios.filter((c) => c.tipo === 'editorial'),
      cambiosSolicitados: todosLosComentarios.filter((c) => c.tipo === 'change_request'),
      evaluacion: vistaDeEvaluacion,
      propuestaDeAprobacion: propuesta,
    },
  });
}
