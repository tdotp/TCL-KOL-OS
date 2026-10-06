/**
 * Apoyo de las pruebas del análisis de contenido (V2 · Fase 7). Solo para pruebas: sintético, nunca P80 real.
 *
 *  · `inspeccionarPeticion`: lee los sobres del mensaje de usuario que se le mandó al «modelo» y devuelve los
 *    alias R#/F# con su clave de Brief y su texto, para que un cliente guionado pueda citar alias REALES.
 *  · `salidaDeAnalisis`: arma la salida cruda del modelo (JSON) a partir de especificaciones por clave.
 *  · `crearEscenarioDeAnalisis`: escenario de contenido + Brief aprobado + una versión de guion registrada
 *    con texto real (dos fragmentos).
 */

import type { PeticionDeAnalisis, User } from '@tcl-kol-os/domain';
import { ClienteDeAnalisisGuionado, respuestaGuionada } from './content-analysis-client.ts';
import { registrarVersionDeGuion } from './script-versions.ts';
import {
  type BriefDePrueba,
  type EscenarioDeContenido,
  crearBriefAprobadoDePrueba,
  crearEscenarioDeContenido,
  crearFuenteDeGuionConTexto,
} from './test-utils.ts';

export interface RequisitoInspeccionado {
  readonly alias: string;
  readonly key: string;
  readonly producto: string | undefined;
  readonly item: number | undefined;
  readonly noEvaluable: boolean;
  readonly texto: string;
}

export interface PeticionInspeccionada {
  readonly requisitos: readonly RequisitoInspeccionado[];
  readonly fragmentos: readonly { readonly alias: string; readonly texto: string }[];
  readonly nonce: string;
}

const APERTURA = /^<<<NC:([0-9a-f]+) kind=([a-z_]+)(?: ref=([A-Z]{1,2}[0-9]{1,5}))?>>>$/u;

export function inspeccionarPeticion(p: PeticionDeAnalisis): PeticionInspeccionada {
  const requisitos: RequisitoInspeccionado[] = [];
  const fragmentos: { alias: string; texto: string }[] = [];
  let nonce = '';
  let actual: { kind: string; ref: string; meta: Record<string, unknown>; lineas: string[] } | undefined;
  for (const linea of p.messages[1].content.split('\n')) {
    if (actual === undefined) {
      const m = APERTURA.exec(linea);
      if (m !== null) {
        nonce = m[1]!;
        actual = { kind: m[2]!, ref: m[3] ?? '', meta: {}, lineas: [] };
      }
      continue;
    }
    if (linea.startsWith('<<<FIN:')) {
      const texto = actual.lineas.join('\n');
      if (actual.kind === 'brief_requirement') {
        requisitos.push({
          alias: actual.ref,
          key: String(actual.meta['key'] ?? ''),
          producto: actual.meta['producto'] === undefined ? undefined : String(actual.meta['producto']),
          item: typeof actual.meta['item'] === 'number' ? actual.meta['item'] : undefined,
          noEvaluable: actual.meta['no_evaluable'] === true,
          texto,
        });
      } else if (actual.kind === 'script_fragment') {
        fragmentos.push({ alias: actual.ref, texto });
      }
      actual = undefined;
    } else if (linea.startsWith('meta: ') && actual.lineas.length === 0) {
      actual.meta = JSON.parse(linea.slice('meta: '.length)) as Record<string, unknown>;
    } else if (linea === '│') {
      actual.lineas.push('');
    } else if (linea.startsWith('│ ')) {
      actual.lineas.push(linea.slice(2));
    }
  }
  return { requisitos, fragmentos, nonce };
}

export interface HallazgoDePrueba {
  readonly category:
    | 'cta_missing'
    | 'key_message_incomplete'
    | 'requirement_not_covered'
    | 'claim_unsupported'
    | 'claim_contradicted'
    | 'restriction_violated'
    | 'brief_contradiction';
  /** Claves del Brief (`accion_kpis.accion_esperada`) o alias directos (`R4`); con `#2` = ítem 2 de la lista. */
  readonly refs: readonly string[];
  /** Cita literal de un fragmento por alias (`F1`) y TEXTO; si falta `quote`, se toma el inicio del fragmento. */
  readonly quotes?: readonly { readonly fragment: string; readonly quote?: string }[];
  readonly description?: string;
}

const BASE_POR_CATEGORIA: Record<HallazgoDePrueba['category'], [string, string | null]> = {
  cta_missing: ['absence', null],
  key_message_incomplete: ['partial', null],
  requirement_not_covered: ['absence', null],
  claim_unsupported: ['absence', 'unsupported'],
  claim_contradicted: ['conflict', 'contradicted'],
  restriction_violated: ['conflict', null],
  brief_contradiction: ['conflict', null],
};

/** Texto literal ≥12 caracteres y ≥2 palabras del inicio de un fragmento. */
export function citaDelFragmento(texto: string, maximo = 60): string {
  const limpio = texto.replace(/\s+/gu, ' ').trim();
  const corte = limpio.slice(0, maximo);
  return limpio.length > maximo && corte.includes(' ') ? corte.slice(0, corte.lastIndexOf(' ')) : corte;
}

function aliasDe(p: PeticionInspeccionada, ref: string): string {
  if (/^R[0-9]+$/u.test(ref)) return ref;
  const [clave, item] = ref.split('#');
  const r = p.requisitos.find((x) => x.key === clave && (item === undefined || x.item === Number(item)));
  if (r === undefined) throw new Error(`salidaDeAnalisis: no hay requisito ${ref} en la petición`);
  return r.alias;
}

/** Salida cruda del modelo (objeto) a partir de hallazgos por clave. Los ids son h1…hn. */
export function salidaDeAnalisis(
  peticion: PeticionDeAnalisis,
  hallazgos: readonly HallazgoDePrueba[],
): Record<string, unknown> {
  const p = inspeccionarPeticion(peticion);
  return {
    schema_version: 'analisis-guion-salida-1',
    findings: hallazgos.map((h, i) => {
      const [basis, claim] = BASE_POR_CATEGORIA[h.category];
      return {
        id: `h${i + 1}`,
        category: h.category,
        basis,
        claim_status: claim,
        description: h.description ?? `Observación de prueba ${i + 1} sobre el cumplimiento del Brief.`,
        brief_refs: h.refs.map((r) => aliasDe(p, r)),
        script_quotes: (h.quotes ?? []).map((q) => {
          const f = p.fragmentos.find((x) => x.alias === q.fragment);
          if (f === undefined) throw new Error(`salidaDeAnalisis: no hay fragmento ${q.fragment}`);
          return { fragment: q.fragment, quote: q.quote ?? citaDelFragmento(f.texto) };
        }),
      };
    }),
  };
}

/** Cliente guionado que responde con los hallazgos dados (calculados con alias reales de cada petición). */
export function clienteQueResponde(
  hallazgos: readonly HallazgoDePrueba[],
  demora?: () => Promise<void>,
): ClienteDeAnalisisGuionado {
  return new ClienteDeAnalisisGuionado(
    (peticion) => respuestaGuionada(salidaDeAnalisis(peticion, hallazgos)),
    demora,
  );
}

export const TEXTO_DE_GUION_DE_PRUEBA: readonly string[] = [
  'Hola a todos, hoy les muestro el nuevo P80 Pro con su increíble cámara de 200 MP para fotos de día y de noche.',
  'Es perfecto para fotografía profesional y la batería dura todo el día, no se pierdan esta oferta increíble.',
];

export interface EscenarioDeAnalisis {
  readonly e: EscenarioDeContenido;
  readonly brief: BriefDePrueba;
  /** Versión V1 del entregable `reelRios` (estado `received`). */
  readonly versionId: string;
  readonly fuenteId: string;
  readonly deliverableId: string;
}

let secuencia = 0;

/** Contenido + Brief aprobado (productos P80 y P80 Pro) + una versión de guion con texto real. */
export async function crearEscenarioDeAnalisis(nombre: string): Promise<EscenarioDeAnalisis> {
  const e = await crearEscenarioDeContenido(nombre);
  const brief = await crearBriefAprobadoDePrueba(e.campanaId, e.admin, {
    productos: [e.productos.p80, e.productos.pro],
    noEncontrados: ['objetivo.comportamiento_esperado'],
  });
  const { versionId, fuenteId } = await registrarGuionDePrueba(
    e,
    e.entregables.reelRios,
    e.participaciones.valentinaRios,
    e.consultor,
  );
  return { e, brief, versionId, fuenteId, deliverableId: e.entregables.reelRios };
}

/** Registra una versión NUEVA de guion (texto dado o el de prueba) en un entregable. */
export async function registrarGuionDePrueba(
  e: EscenarioDeContenido,
  deliverableId: string,
  participationId: string,
  actor: User,
  fragmentos: readonly string[] = TEXTO_DE_GUION_DE_PRUEBA,
): Promise<{ versionId: string; fuenteId: string }> {
  secuencia += 1;
  const fuenteId = await crearFuenteDeGuionConTexto(
    e.campanaId,
    e.admin,
    `guion-analisis-${secuencia}`,
    fragmentos,
  );
  const r = await registrarVersionDeGuion(actor, {
    campaignId: e.campanaId,
    sourceId: fuenteId,
    participation: { participationId },
    deliverable: { id: deliverableId },
  });
  if (!r.ok || r.value.kind !== 'registered')
    throw new Error('registrarGuionDePrueba: no se registró la versión');
  return { versionId: r.value.version.id, fuenteId };
}

/** Variables de entorno de un proceso con la IA encendida (el nonce usa el secreto de desarrollo). */
export const ENV_CON_IA = (n: string): string | undefined =>
  n === 'AI_ENABLED' ? 'true' : n === 'AI_PROVIDER' ? 'fake' : undefined;
export const ENV_SIN_IA = (n: string): string | undefined => (n === 'AI_ENABLED' ? 'false' : undefined);

let claves = 0;
/** Clave de idempotencia única para una prueba. */
export function claveNueva(prefijo = 'k'): string {
  claves += 1;
  return `${prefijo}-${Date.now().toString(36)}-${claves}`;
}
