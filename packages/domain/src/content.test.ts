/**
 * V2 · Fase 7 — reglas puras de contenido: estados y transiciones de la versión de guion,
 * etiqueta normalizada del entregable, resolución inequívoca de la participación y
 * resumen derivado del entregable.
 */

import { describe, expect, it } from 'vitest';
import {
  SCRIPT_VERSION_STATUSES,
  SCRIPT_VERSION_TRANSITIONS,
  type ParticipanteReconocible,
  type ScriptVersionStatus,
  canTransitionScriptVersion,
  candidatosDeParticipacion,
  etiquetasParecidas,
  isOpenScriptVersion,
  normalizarEtiquetaDeEntregable,
  resumenDeEntregable,
} from './content';

describe('SCRIPT_VERSION_TRANSITIONS', () => {
  it('matriz 5×5 exacta: solo estas 7 transiciones existen', () => {
    const validas: Array<[ScriptVersionStatus, ScriptVersionStatus]> = [
      ['received', 'in_review'],
      ['received', 'changes_requested'],
      ['in_review', 'changes_requested'],
      ['in_review', 'approved'],
      ['received', 'superseded'],
      ['in_review', 'superseded'],
      ['approved', 'superseded'],
    ];
    for (const desde of SCRIPT_VERSION_STATUSES) {
      for (const hacia of SCRIPT_VERSION_STATUSES) {
        const esperada = validas.some(([a, b]) => a === desde && b === hacia);
        expect(canTransitionScriptVersion(desde, hacia), `${desde} → ${hacia}`).toBe(esperada);
      }
    }
  });

  it('changes_requested y superseded son terminales; NO existe changes_requested → in_review', () => {
    expect(SCRIPT_VERSION_TRANSITIONS.changes_requested).toEqual([]);
    expect(SCRIPT_VERSION_TRANSITIONS.superseded).toEqual([]);
    expect(canTransitionScriptVersion('changes_requested', 'in_review')).toBe(false);
    expect(canTransitionScriptVersion('changes_requested', 'superseded')).toBe(false);
  });

  it('no se aprueba sin pasar por in_review, y aprobar no se deshace (approved solo → superseded)', () => {
    expect(canTransitionScriptVersion('received', 'approved')).toBe(false);
    expect(SCRIPT_VERSION_TRANSITIONS.approved).toEqual(['superseded']);
  });

  it('solo received e in_review están abiertas', () => {
    expect(SCRIPT_VERSION_STATUSES.filter(isOpenScriptVersion)).toEqual(['received', 'in_review']);
  });
});

function etiqueta(raw: unknown) {
  const r = normalizarEtiquetaDeEntregable(raw);
  if (!r.ok) throw new Error(`no debía fallar: ${r.error.message}`);
  return r.value;
}

describe('normalizarEtiquetaDeEntregable', () => {
  it('«Reel principal» y «  REEL   principal » comparten clave', () => {
    expect(etiqueta('Reel principal').key).toBe('reel principal');
    expect(etiqueta('  REEL   principal ').key).toBe('reel principal');
    expect(etiqueta('  REEL   principal ').label).toBe('REEL principal');
  });

  it('NFKC en la clave: las variantes de ancho completo se igualan', () => {
    expect(etiqueta('ＲＥＥＬ principal').key).toBe('reel principal');
  });

  it('colapsa tabuladores y saltos de línea; NO pliega acentos', () => {
    expect(etiqueta('Reel\n\tprincipal').label).toBe('Reel principal');
    expect(etiqueta('Réel').key).not.toBe(etiqueta('Reel').key);
  });

  it('rechaza vacío, no-texto, demasiado largo y caracteres de control', () => {
    for (const malo of ['', '   ', 42, null, undefined, 'a'.repeat(121), 'Reel\u0000x', 'Reel​x']) {
      const r = normalizarEtiquetaDeEntregable(malo);
      expect(r.ok, String(malo)).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('VALIDATION_FAILED');
    }
    expect(normalizarEtiquetaDeEntregable('a'.repeat(120)).ok).toBe(true);
  });
});

describe('etiquetasParecidas', () => {
  it('detecta contención y erratas pequeñas; lo igual no es «parecido»', () => {
    expect(etiquetasParecidas('reel principal', 'reel principal')).toBe(false);
    expect(etiquetasParecidas('reel', 'reel principal')).toBe(true);
    expect(etiquetasParecidas('reel principal', 'reel')).toBe(true);
    expect(etiquetasParecidas('reel pricipal', 'reel principal')).toBe(true);
    expect(etiquetasParecidas('story 1', 'story 2')).toBe(false);
    expect(etiquetasParecidas('story de lanzamiento', 'reel principal')).toBe(false);
  });

  it('las etiquetas muy cortas solo se parecen por contención de ≥3 caracteres', () => {
    expect(etiquetasParecidas('a', 'ab')).toBe(false);
    expect(etiquetasParecidas('ig', 'tt')).toBe(false);
    expect(etiquetasParecidas('tik', 'tiktok')).toBe(true);
  });
});

const valentinaRios: ParticipanteReconocible = {
  id: 'p-rios',
  displayName: 'Valentina Ríos',
  handles: ['@valentina.rios', 'valentinar'],
  products: ['TCL C655 Pro'],
};
const valentinaGomez: ParticipanteReconocible = {
  id: 'p-gomez',
  displayName: 'Valentina Gómez',
  handles: ['valegomez'],
  products: ['TCL P755'],
};
const diego: ParticipanteReconocible = { id: 'p-diego', displayName: 'Diego Peña', handles: ['diegop'] };
const todos = [valentinaRios, valentinaGomez, diego];

describe('candidatosDeParticipacion', () => {
  it('una sola coincidencia → unique (sin acentos ni mayúsculas)', () => {
    for (const mencion of ['diego', 'DIEGO', 'Diego Peña', 'diego pena', 'peña']) {
      const r = candidatosDeParticipacion(mencion, todos);
      expect(r.razon, mencion).toBe('unique');
      expect(r.elegido?.id).toBe('p-diego');
    }
  });

  it('el nombre de pila compartido NO elige a nadie: ambiguous con todos los candidatos', () => {
    const r = candidatosDeParticipacion('Valentina', todos);
    expect(r.razon).toBe('ambiguous');
    expect(r.elegido).toBeUndefined();
    expect(r.candidatos.map((p) => p.id)).toEqual(['p-rios', 'p-gomez']);
  });

  it('nunca elige «el primero»: ni con el orden invertido ni con duplicados', () => {
    const r = candidatosDeParticipacion('valentina', [valentinaGomez, valentinaRios]);
    expect(r.elegido).toBeUndefined();
    expect(candidatosDeParticipacion('valentina', [valentinaRios, valentinaRios]).razon).toBe('ambiguous');
  });

  it('el nombre completo (con o sin acento) resuelve', () => {
    expect(candidatosDeParticipacion('Valentina Ríos', todos).elegido?.id).toBe('p-rios');
    expect(candidatosDeParticipacion('valentina gomez', todos).elegido?.id).toBe('p-gomez');
  });

  it('@handle exacto resuelve; un handle parcial o ajeno, no', () => {
    expect(candidatosDeParticipacion('@valentina.rios', todos).elegido?.id).toBe('p-rios');
    expect(candidatosDeParticipacion('valegomez', todos).elegido?.id).toBe('p-gomez');
    expect(candidatosDeParticipacion('@valentina', todos).razon).toBe('not_found');
    expect(candidatosDeParticipacion('@diego', todos).razon).toBe('not_found');
  });

  it('una mención con @ no identifica por nombre', () => {
    expect(candidatosDeParticipacion('@Diego Peña', todos).razon).toBe('not_found');
  });

  it('la desambiguación (apellido, handle o producto) elige solo si deja exactamente uno', () => {
    expect(candidatosDeParticipacion('valentina', todos, 'Ríos').elegido?.id).toBe('p-rios');
    expect(candidatosDeParticipacion('valentina', todos, 'gomez').razon).toBe('disambiguated');
    expect(candidatosDeParticipacion('valentina', todos, '@valegomez').elegido?.id).toBe('p-gomez');
    expect(candidatosDeParticipacion('valentina', todos, 'P755').elegido?.id).toBe('p-gomez');
    // sigue siendo ambigua: la pista no distingue, o distingue a nadie
    expect(candidatosDeParticipacion('valentina', todos, 'TCL').razon).toBe('ambiguous');
    expect(candidatosDeParticipacion('valentina', todos, 'valentina').razon).toBe('ambiguous');
    expect(candidatosDeParticipacion('valentina', todos, 'martinez').razon).toBe('ambiguous');
    expect(candidatosDeParticipacion('valentina', todos, '   ').razon).toBe('ambiguous');
  });

  it('la desambiguación no rescata una mención que no coincide con nadie', () => {
    expect(candidatosDeParticipacion('Camila', todos, 'Ríos').razon).toBe('not_found');
  });

  it('mención vacía, de un carácter o no-texto: not_found', () => {
    for (const m of ['', ' ', 'a', '@', '@a', 7 as unknown as string]) {
      expect(candidatosDeParticipacion(m, todos).razon, String(m)).toBe('not_found');
    }
    expect(candidatosDeParticipacion('diego', []).razon).toBe('not_found');
  });

  it('la desambiguación nunca devuelve un participante fuera de los candidatos', () => {
    const r = candidatosDeParticipacion('valentina', todos, 'Diego Peña');
    expect(r.elegido).toBeUndefined();
  });
});

describe('resumenDeEntregable', () => {
  const v = (version: number, status: ScriptVersionStatus) => ({ version, status });

  it('sin versiones → sin_guion', () => {
    expect(resumenDeEntregable([])).toBe('sin_guion');
  });

  it('sin aprobada: en_curso (recibida / en revisión) o cambios_solicitados (la última)', () => {
    expect(resumenDeEntregable([v(1, 'received')])).toBe('en_curso');
    expect(resumenDeEntregable([v(1, 'in_review')])).toBe('en_curso');
    expect(resumenDeEntregable([v(1, 'changes_requested')])).toBe('cambios_solicitados');
    expect(resumenDeEntregable([v(1, 'changes_requested'), v(2, 'received')])).toBe('en_curso');
    expect(resumenDeEntregable([v(1, 'in_review'), v(2, 'changes_requested')])).toBe('cambios_solicitados');
  });

  it('con aprobada: aprobado, o aprobado_con_nueva_en_revision si una MÁS NUEVA sigue abierta', () => {
    expect(resumenDeEntregable([v(1, 'approved')])).toBe('aprobado');
    expect(resumenDeEntregable([v(1, 'approved'), v(2, 'received')])).toBe('aprobado_con_nueva_en_revision');
    expect(resumenDeEntregable([v(1, 'approved'), v(2, 'in_review')])).toBe('aprobado_con_nueva_en_revision');
    // la nueva con cambios solicitados ya no está abierta: la aprobada sigue vigente
    expect(resumenDeEntregable([v(1, 'approved'), v(2, 'changes_requested')])).toBe('aprobado');
    // una anterior abierta (rezagada) no cuenta como «nueva»
    expect(resumenDeEntregable([v(1, 'in_review'), v(2, 'approved')])).toBe('aprobado');
  });

  it('las reemplazadas no cambian el resumen; no depende del orden de entrada', () => {
    const lista = [v(3, 'approved'), v(1, 'superseded'), v(2, 'superseded')];
    expect(resumenDeEntregable(lista)).toBe('aprobado');
    expect(resumenDeEntregable([...lista].reverse())).toBe('aprobado');
    expect(resumenDeEntregable([v(2, 'received'), v(3, 'approved'), v(1, 'superseded')])).toBe('aprobado');
  });
});
