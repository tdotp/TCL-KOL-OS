/**
 * Citas de la respuesta final (D12) y mensaje determinístico del límite de pasos.
 *
 * El modelo cita con alias entre corchetes: `[S1]`, `[F3]`, `[S1, F3]`. El runtime:
 *  · valida cada alias contra el `RegistroDeReferencias` DEL RUN;
 *  · DESCARTA los inventados (decisión: sin llamada de reparación al modelo — cuesta
 *    otra vuelta y el modelo puede reincidir; quitar el marcador deja la afirmación
 *    sin cita, que es lo honesto) y los anota (`descartadas`, y `ok_con_descartes` en
 *    el ledger);
 *  · persiste como `chat_message_references` solo los alias de fuente y fragmento
 *    (las tablas exigen una fuente real); el resto de alias válidos (pregunta,
 *    producto, participación…) quedan como texto.
 * Los ids (UUID) nunca salen del servidor hacia el modelo ni vuelven de él.
 */
import { type ContextReference, type RegistroDeReferencias, CHAT_LIMITS } from '@tcl-kol-os/domain';
import type { CitaDeRespuesta } from './db-ports.ts';
import type { ToolExecution } from '../contracts.ts';

const BLOQUE_DE_CITA = /(\s?)\[\s*([A-Z]{1,2}\d{1,5}(?:\s*[,;]\s*[A-Z]{1,2}\d{1,5})*)\s*\]/g;

export interface CitasProcesadas {
  /** Texto con los marcadores inventados retirados. */
  readonly texto: string;
  readonly referencias: readonly CitaDeRespuesta[];
  /** Alias citados que no existen en el registro del run. */
  readonly descartadas: readonly string[];
}

function citaDe(ref: ContextReference): CitaDeRespuesta | undefined {
  if ((ref.kind !== 'source' && ref.kind !== 'fragment') || ref.sourceId === undefined) return undefined;
  return {
    sourceId: ref.sourceId,
    fragmentId: ref.kind === 'fragment' ? ref.fragmentId : undefined,
    snapshotId: ref.kind === 'fragment' ? ref.snapshotId : undefined,
    locator:
      ref.kind === 'fragment' && ref.locator !== undefined
        ? (ref.locator as unknown as Readonly<Record<string, unknown>>)
        : undefined,
  };
}

export function procesarCitas(texto: string, registro: RegistroDeReferencias): CitasProcesadas {
  // Solo se tratan como citas los alias cuya letra es de un tipo que el registro maneja:
  // «[B2]» en una celda de hoja de cálculo no es una cita si no existe ningún alias B.
  const prefijos = new Set<string>(['S', 'F']);
  for (const r of registro.listar()) prefijos.add(r.alias.replace(/\d+$/, ''));

  const referencias: CitaDeRespuesta[] = [];
  const descartadas: string[] = [];
  const vistas = new Set<string>();

  const salida = texto.replace(BLOQUE_DE_CITA, (completo: string, espacio: string, lista: string) => {
    const alias = lista.split(/\s*[,;]\s*/).map((a) => a.trim());
    if (alias.some((a) => !prefijos.has(a.replace(/\d+$/, '')))) return completo;
    const validos: string[] = [];
    for (const a of alias) {
      const ref = registro.obtener(a);
      if (ref === undefined) {
        if (!descartadas.includes(a)) descartadas.push(a);
        continue;
      }
      validos.push(a);
      if (vistas.has(ref.alias)) continue;
      vistas.add(ref.alias);
      const cita = citaDe(ref);
      if (cita !== undefined) referencias.push(cita);
    }
    return validos.length === 0 ? '' : `${espacio}[${validos.join(', ')}]`;
  });

  return {
    texto: salida,
    referencias: referencias.slice(0, CHAT_LIMITS.referenciasPorMensaje),
    descartadas,
  };
}

/** Citas reducidas a la fuente (sin fragmento ni snapshot): el respaldo si un fragmento ya no existe. */
export function citasSoloDeFuente(refs: readonly CitaDeRespuesta[]): CitaDeRespuesta[] {
  const vistos = new Set<string>();
  const salida: CitaDeRespuesta[] = [];
  for (const r of refs) {
    if (vistos.has(r.sourceId)) continue;
    vistos.add(r.sourceId);
    salida.push({ sourceId: r.sourceId });
  }
  return salida;
}

// ─────────────────────────── Límite de pasos ───────────────────────────────────

export interface EjecucionRegistrada {
  readonly toolName: string;
  readonly execution: Pick<ToolExecution, 'status' | 'riskClass' | 'proposedActionId'>;
}

const NOMBRE_SEGURO = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Mensaje determinístico cuando se agotan los pasos. Se arma SOLO con el estado del
 * runtime (nombres de tools registradas, estados, conteos): sin llamada de modelo y
 * sin texto del modelo, de documentos ni de resultados de tools.
 */
export function mensajeDeLimiteDePasos(maxSteps: number, hechos: readonly EjecucionRegistrada[]): string {
  const validas = hechos.filter((h) => h.execution.riskClass !== 'unregistered');
  const invalidas = hechos.length - validas.length;
  const exitosas = validas.filter((h) => h.execution.status === 'succeeded');
  const fallidas = validas.filter((h) => h.execution.status !== 'succeeded');
  const nombres = (lista: readonly EjecucionRegistrada[]): string =>
    [...new Set(lista.map((h) => h.toolName).filter((n) => NOMBRE_SEGURO.test(n)))].join(', ');

  const partes: string[] = [];
  if (exitosas.length > 0) {
    const lecturas = exitosas.filter((h) => h.execution.riskClass === 'read').length;
    const escrituras = exitosas.filter((h) => h.execution.riskClass === 'write').length;
    const propuestas = exitosas.filter((h) => h.execution.riskClass === 'confirmation_required').length;
    const detalle: string[] = [];
    if (lecturas > 0) detalle.push(`${lecturas} consulta(s)`);
    if (escrituras > 0) detalle.push(`${escrituras} cambio(s)`);
    if (propuestas > 0)
      detalle.push(`${propuestas} propuesta(s) pendiente(s) de tu confirmación en la interfaz`);
    partes.push(`${detalle.join(', ')} (${nombres(exitosas)})`);
  }
  if (fallidas.length > 0) partes.push(`${fallidas.length} llamada(s) que fallaron (${nombres(fallidas)})`);
  if (invalidas > 0) partes.push(`${invalidas} llamada(s) no válidas que no se ejecutaron`);
  const hecho = partes.length === 0 ? 'no alcancé a ejecutar ninguna herramienta' : partes.join('; ');

  return (
    `Alcancé el límite de ${maxSteps} pasos de este turno y me detuve. ` +
    `Hecho: ${hecho}. ` +
    'Pendiente: terminar la solicitud y darte la respuesta completa. ' +
    'Escríbeme «continúa» (o precisa lo que falta) y sigo desde aquí.'
  );
}
