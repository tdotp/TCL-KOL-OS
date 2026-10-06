/**
 * Utilidades de las pruebas de CONTENIDO del agente (V2 · Fase 7, BD real `_test`).
 *
 * Vive en `qa/testing/` a propósito: el test estático de import-boundary excluye `/testing/`, así que estos
 * ayudantes pueden importar de `@tcl-kol-os/db`. Datos sintéticos, nunca P80 real.
 *
 * El análisis contra el Brief se prueba con el cliente guionado de db (`ClienteDeAnalisisGuionado`), sin
 * Python ni red: `inspeccionarPeticion` y `salidaDeAnalisis` son una copia reducida de
 * `packages/db/src/content-analysis-test-support.ts` (ese archivo no se exporta del paquete) para que el
 * «modelo» pueda citar alias REALES de cada petición.
 */

import {
  type ClienteDeAnalisis,
  ClienteDeAnalisisGuionado,
  registrarVersionDeGuion,
  respuestaGuionada,
} from '@tcl-kol-os/db';
import {
  type BriefDePrueba,
  type EscenarioDeContenido,
  crearBriefAprobadoDePrueba,
  crearEscenarioDeContenido,
  crearFuenteDeGuionConTexto,
} from '@tcl-kol-os/db/test-utils';
import type { PeticionDeAnalisis, User } from '@tcl-kol-os/domain';

// ─────────────────────────── Escenario ─────────────────────────────────────────

export interface MundoDeContenido {
  readonly e: EscenarioDeContenido;
  readonly brief: BriefDePrueba;
}

/** Escenario de contenido (dos «Valentina», entregables, fuentes) + Brief APROBADO con los dos productos. */
export async function crearMundoDeContenido(nombre: string): Promise<MundoDeContenido> {
  const e = await crearEscenarioDeContenido(nombre);
  const brief = await crearBriefAprobadoDePrueba(e.campanaId, e.admin, {
    productos: [e.productos.p80, e.productos.pro],
  });
  return { e, brief };
}

export const TEXTO_DE_GUION: readonly string[] = [
  'Hola a todos, hoy les muestro el nuevo P80 Pro con su increíble cámara de 200 MP para fotos de día y de noche.',
  'Es perfecto para fotografía profesional y la batería dura todo el día, no se pierdan esta oferta increíble.',
];

let secuencia = 0;

/** Fuente de guion procesada con texto (interna, hash real). */
export async function fuenteDeGuion(
  e: EscenarioDeContenido,
  etiqueta: string,
  fragmentos: readonly string[] = TEXTO_DE_GUION,
): Promise<string> {
  secuencia += 1;
  return crearFuenteDeGuionConTexto(e.campanaId, e.admin, `${etiqueta}-${secuencia}`, fragmentos);
}

/** Registra directamente (como lo haría la UI) una versión NUEVA de un entregable con una fuente nueva. */
export async function registrarVersionDePrueba(
  e: EscenarioDeContenido,
  entregableId: string,
  participacionId: string,
  actor: User = e.consultor,
  fragmentos: readonly string[] = TEXTO_DE_GUION,
): Promise<{ versionId: string; fuenteId: string }> {
  const fuenteId = await fuenteDeGuion(e, 'guion-prueba', fragmentos);
  const r = await registrarVersionDeGuion(actor, {
    campaignId: e.campanaId,
    sourceId: fuenteId,
    participation: { participationId: participacionId },
    deliverable: { id: entregableId },
  });
  if (!r.ok || r.value.kind !== 'registered') throw new Error('registrarVersionDePrueba: no se registró');
  return { versionId: r.value.version.id, fuenteId };
}

// ─────────────────────────── Cliente de análisis guionado ──────────────────────

interface RequisitoInspeccionado {
  readonly alias: string;
  readonly key: string;
  readonly item: number | undefined;
}

interface PeticionInspeccionada {
  readonly requisitos: readonly RequisitoInspeccionado[];
  readonly fragmentos: readonly { readonly alias: string; readonly texto: string }[];
}

const APERTURA = /^<<<NC:([0-9a-f]+) kind=([a-z_]+)(?: ref=([A-Z]{1,2}[0-9]{1,5}))?>>>$/u;

/** Lee los sobres del mensaje de usuario del analizador: alias R#/F# con su clave de Brief y su texto. */
export function inspeccionarPeticion(p: PeticionDeAnalisis): PeticionInspeccionada {
  const requisitos: RequisitoInspeccionado[] = [];
  const fragmentos: { alias: string; texto: string }[] = [];
  let actual: { kind: string; ref: string; meta: Record<string, unknown>; lineas: string[] } | undefined;
  for (const linea of p.messages[1].content.split('\n')) {
    if (actual === undefined) {
      const m = APERTURA.exec(linea);
      if (m !== null) actual = { kind: m[2]!, ref: m[3] ?? '', meta: {}, lineas: [] };
      continue;
    }
    if (linea.startsWith('<<<FIN:')) {
      const texto = actual.lineas.join('\n');
      if (actual.kind === 'brief_requirement') {
        requisitos.push({
          alias: actual.ref,
          key: String(actual.meta['key'] ?? ''),
          item: typeof actual.meta['item'] === 'number' ? actual.meta['item'] : undefined,
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
  return { requisitos, fragmentos };
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
  /** Claves del Brief (`accion_kpis.accion_esperada`). */
  readonly refs: readonly string[];
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

/** Salida cruda del modelo a partir de hallazgos por clave (los ids son h1…hn). */
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
        brief_refs: h.refs.map((r) => {
          const req = p.requisitos.find((x) => x.key === r);
          if (req === undefined) throw new Error(`salidaDeAnalisis: no hay requisito ${r} en la petición`);
          return req.alias;
        }),
        script_quotes: [],
      };
    }),
  };
}

/** Cliente guionado que responde con los hallazgos dados (con alias reales de cada petición). */
export function clienteQueResponde(hallazgos: readonly HallazgoDePrueba[]): ClienteDeAnalisisGuionado {
  return new ClienteDeAnalisisGuionado((peticion) =>
    respuestaGuionada(salidaDeAnalisis(peticion, hallazgos)),
  );
}

/** Estado compartido con el `vi.mock` de `@tcl-kol-os/db` (que inyecta el cliente en `solicitarAnalisisDeGuion`). */
export interface EstadoDeAnalisis {
  cliente: ClienteDeAnalisis | undefined;
  iaActiva: boolean;
}

/** Variables de entorno de un proceso con la IA encendida / apagada (el nonce usa el secreto de desarrollo). */
export const entornoDeAnalisis =
  (iaActiva: boolean) =>
  (n: string): string | undefined =>
    n === 'AI_ENABLED' ? String(iaActiva) : n === 'AI_PROVIDER' ? 'fake' : undefined;
