/**
 * E13-1 · Cobertura funcional 100% de las transiciones de estado (§27).
 *
 * Se prueba cada transición declarada, cada transición inválida representativa,
 * y las tres guardas que sostienen los umbrales de §15.
 */

import { describe, expect, it } from 'vitest';
import {
  LEGACY_CLIENT_STATES,
  REQUIRED_REPRESENTATION_LANGUAGES,
  TERMINAL_STATES,
  TRANSITIONS,
  allowedTransitions,
  assertEditable,
  isImmutable,
  isLegacyClientState,
  transition,
  transitionsFrom,
} from './brief-states';
import type { BriefField, BriefRepresentation, BriefStatus, BriefVersion, Role, User } from './types';
import { esEquivalenteAlOriginal, resumirSincronizacion } from './representations';

// ─────────────────────────── Utilidades de prueba ──────────────────────────────

function user(role: Role): User {
  return {
    id: `usr-${role}`,
    email: `${role}@smartpr.co`,
    name: role,
    organizationId: 'org-smartpr',
    role,
    status: 'activo',
  };
}

function field(overrides: Partial<BriefField> = {}): BriefField {
  return {
    id: 'bf-1',
    key: 'marca_producto.beneficio_principal',
    value: 'Panel QLED de 144Hz',
    status: 'found',
    confidence: 0.9,
    provenanceType: 'extracted',
    criticidad: 'claim',
    evidence: [
      {
        sourceId: 'src-ficha',
        fragmentId: 'frg-1',
        page: 2,
        quote: 'Native 144Hz VRR panel',
        relation: 'soporta',
      },
    ],
    // Un campo "sano" por defecto no debe bloquear ninguna transición ajena a
    // lo que cada `describe` está probando — igual que `status`/`evidence`.
    reviewStatus: 'confirmed',
    revision: 1,
    ...overrides,
  };
}

function version(status: BriefStatus, overrides: Partial<BriefVersion> = {}): BriefVersion {
  return {
    id: 'bv-1',
    briefId: 'br-1',
    version: 1,
    language: 'es',
    status,
    fields: [field()],
    createdBy: 'usr-admin',
    createdAt: '2026-08-11T10:00:00-05:00',
    ...overrides,
  };
}

// ─────────────────────────── Cobertura de transiciones ─────────────────────────

describe('cobertura de la máquina de estados', () => {
  it('cada transición declarada es ejecutable por al menos un actor autorizado', () => {
    for (const rule of TRANSITIONS) {
      const actor = rule.roles === 'system' ? ('system' as const) : user(rule.roles[0] as Role);
      const result = transition({ version: version(rule.from), actor }, rule.to);

      // Si falla, debe ser por una guarda de datos, nunca por rol ni por existencia.
      if (!result.ok) {
        expect(
          ['BRIEF_MISSING_EVIDENCE', 'BRIEF_UNRESOLVED_CONFLICT', 'BRIEF_PENDING_QUESTIONS'],
          `${rule.from} → ${rule.to} falló con ${result.error.code}`,
        ).toContain(result.error.code);
      } else {
        expect(result.value).toBe(rule.to);
      }
    }
  });

  it('los doce estados de §7.3 están representados', () => {
    const declared = new Set<BriefStatus>();
    for (const t of TRANSITIONS) {
      declared.add(t.from);
      declared.add(t.to);
    }
    const expected: BriefStatus[] = [
      'draft',
      'processing',
      'extraction_review',
      'local_questions',
      'internal_review',
      'internal_changes_requested',
      'client_review',
      'client_changes_requested',
      'approved',
      'superseded',
      'cancelled',
      'processing_failed',
    ];
    for (const s of expected) expect(declared, `falta el estado ${s}`).toContain(s);
  });

  it('los estados terminales no tienen salida', () => {
    for (const s of TERMINAL_STATES) {
      expect(transitionsFrom(s), `${s} debería ser terminal`).toHaveLength(0);
    }
  });
});

// ─────────────────────────── Transiciones inválidas ────────────────────────────

describe('transiciones inválidas', () => {
  it('rechaza approved → draft (caso F-26)', () => {
    const result = transition({ version: version('approved'), actor: user('admin') }, 'draft');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('BRIEF_INVALID_TRANSITION');
  });

  it('rechaza saltar de draft a approved sin pasar por revisión', () => {
    const result = transition({ version: version('draft'), actor: user('admin') }, 'approved');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('BRIEF_INVALID_TRANSITION');
  });

  it('el error informa qué transiciones sí eran posibles', () => {
    const result = transition({ version: version('approved'), actor: user('admin') }, 'draft');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details?.['permitidas']).toEqual(['superseded']);
  });
});

// ─────────────────────────── Autorización por rol ──────────────────────────────

describe('autorización de transiciones (caso F-27)', () => {
  it('el consultor NO puede aprobar el brief', () => {
    const result = transition({ version: version('internal_review'), actor: user('consultor') }, 'approved');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('FORBIDDEN_ROLE');
  });

  it('el director y el admin sí pueden aprobar el brief', () => {
    for (const rol of ['director', 'admin'] as const) {
      const result = transition({ version: version('internal_review'), actor: user(rol) }, 'approved');
      expect(result.ok, rol).toBe(true);
    }
  });

  it('un humano no puede ejecutar transiciones reservadas al sistema', () => {
    const result = transition({ version: version('processing'), actor: user('admin') }, 'extraction_review');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('FORBIDDEN_ROLE');
  });

  it('el sistema (worker / IA) no puede aprobar: la IA nunca decide', () => {
    for (const rule of TRANSITIONS.filter((t) => t.to === 'approved')) {
      const result = transition({ version: version(rule.from), actor: 'system' }, 'approved');
      expect(result.ok, `el sistema logró ${rule.from} → approved`).toBe(false);
    }
  });

  it('allowedTransitions refleja el rol del actor', () => {
    expect(allowedTransitions('internal_review', user('consultor'))).not.toContain('approved');
    expect(allowedTransitions('internal_review', user('director'))).toContain('approved');
  });
});

// ─────────────────────── Cliente de solo lectura + estados legacy ──────────────

describe('cliente read-only: ninguna transición de estado (corrección del workflow cliente)', () => {
  it('el rol cliente no puede ejecutar NINGUNA transición declarada', () => {
    for (const rule of TRANSITIONS) {
      const result = transition({ version: version(rule.from), actor: user('cliente') }, rule.to);
      expect(result.ok, `el cliente logró ${rule.from} → ${rule.to}`).toBe(false);
    }
  });

  it('allowedTransitions es vacío para el cliente en todos los estados', () => {
    for (const rule of TRANSITIONS) {
      expect(allowedTransitions(rule.from, user('cliente')), rule.from).toHaveLength(0);
    }
  });

  it('el rol cliente no aparece en ninguna regla', () => {
    for (const rule of TRANSITIONS) {
      if (rule.roles !== 'system') expect(rule.roles, `${rule.from} → ${rule.to}`).not.toContain('cliente');
    }
  });
});

describe('estados legacy client_review / client_changes_requested', () => {
  it('ninguna transición entra a los estados legacy: ninguna versión nueva los alcanza', () => {
    for (const rule of TRANSITIONS) {
      expect(isLegacyClientState(rule.to), `${rule.from} → ${rule.to} entra a un estado legacy`).toBe(false);
    }
  });

  it('el flujo vigente no puede pasar de internal_review a client_review', () => {
    const result = transition({ version: version('internal_review'), actor: user('admin') }, 'client_review');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('BRIEF_INVALID_TRANSITION');
  });

  it('los estados legacy se siguen leyendo y siguen siendo editables según su definición previa', () => {
    expect(isLegacyClientState('client_review')).toBe(true);
    expect(isLegacyClientState('client_changes_requested')).toBe(true);
    expect(isLegacyClientState('internal_review')).toBe(false);
    expect(isImmutable('client_review')).toBe(false);
  });

  it('client_review legacy: Dirección puede cerrarla o devolverla a revisión interna', () => {
    expect([...allowedTransitions('client_review', user('director'))].sort()).toEqual(
      ['approved', 'cancelled', 'internal_review'].sort(),
    );
    expect(allowedTransitions('client_review', user('consultor'))).toHaveLength(0);
  });

  it('client_changes_requested legacy: SmartPR la retoma hacia internal_review, sin camino al cliente', () => {
    expect(allowedTransitions('client_changes_requested', user('consultor'))).toEqual(['internal_review']);
  });

  it('ninguna campaña queda bloqueada en un estado legacy', () => {
    for (const legacy of LEGACY_CLIENT_STATES) {
      const salidas = allowedTransitions(legacy, user('admin'));
      expect(salidas.length, `${legacy} sin salida`).toBeGreaterThan(0);
    }
  });

  it('un brief legacy en client_review se aprueba con las mismas guardas que internal_review → approved', () => {
    const sinEvidencia = version('client_review', { fields: [field({ evidence: [] })] });
    const bloqueada = transition({ version: sinEvidencia, actor: user('director') }, 'approved');
    expect(bloqueada.ok).toBe(false);
    if (!bloqueada.ok) expect(bloqueada.error.code).toBe('BRIEF_MISSING_EVIDENCE');
    expect(transition({ version: version('client_review'), actor: user('director') }, 'approved').ok).toBe(
      true,
    );
  });
});

// ─────────────────────────── Guardas de datos ──────────────────────────────────

describe('guarda: claims sin evidencia (caso F-16, GS-006)', () => {
  it('bloquea la aprobación de un claim sin evidencia', () => {
    const v = version('internal_review', { fields: [field({ evidence: [] })] });
    const result = transition({ version: v, actor: user('admin') }, 'approved');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('BRIEF_MISSING_EVIDENCE');
      expect(result.error.details?.['campos']).toEqual(['marca_producto.beneficio_principal']);
    }
  });

  it('un campo informativo sin evidencia no bloquea', () => {
    const v = version('internal_review', {
      fields: [field({ criticidad: 'informativo', evidence: [] })],
    });
    expect(transition({ version: v, actor: user('admin') }, 'approved').ok).toBe(true);
  });

  it('un campo not_found sin evidencia no bloquea: la ausencia es un resultado válido', () => {
    const v = version('internal_review', {
      fields: [field({ status: 'not_found', value: null, evidence: [] })],
    });
    expect(transition({ version: v, actor: user('admin') }, 'approved').ok).toBe(true);
  });
});

describe('guarda: conflicto sin resolver (caso F-17, GS-005)', () => {
  it('bloquea el envío a revisión interna', () => {
    const v = version('extraction_review', {
      fields: [field({ status: 'conflict', value: null })],
    });
    const result = transition({ version: v, actor: user('consultor') }, 'internal_review');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('BRIEF_UNRESOLVED_CONFLICT');
  });

  it('un conflicto en campo informativo no bloquea', () => {
    const v = version('extraction_review', {
      fields: [field({ status: 'conflict', value: null, criticidad: 'informativo' })],
    });
    expect(transition({ version: v, actor: user('consultor') }, 'internal_review').ok).toBe(true);
  });
});

describe('guarda: preguntas críticas pendientes', () => {
  it('bloquea la aprobación', () => {
    const result = transition(
      { version: version('internal_review'), actor: user('admin'), pendingCriticalQuestions: 2 },
      'approved',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('BRIEF_PENDING_QUESTIONS');
  });

  it('bloquea también extraction_review → internal_review (Sprint 4, sección 7 del cierre)', () => {
    // Antes del cierre de Sprint 4 esta guarda solo se aplicaba antes de
    // aprobar; la sección 7 del pedido exige comprobarlo también aquí, para
    // que internal_review nunca reciba un brief con preguntas críticas sin
    // resolver.
    const result = transition(
      { version: version('extraction_review'), actor: user('consultor'), pendingCriticalQuestions: 2 },
      'internal_review',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('BRIEF_PENDING_QUESTIONS');
  });

  it('sin preguntas críticas pendientes, extraction_review → internal_review sí procede', () => {
    const result = transition(
      { version: version('extraction_review'), actor: user('consultor'), pendingCriticalQuestions: 0 },
      'internal_review',
    );
    expect(result.ok).toBe(true);
  });
});

describe('guarda: campos críticos sin revisar, sin resolver o sin anclar (Sprint 4, sección 7 del cierre)', () => {
  it('bloquea internal_review si un crítico sigue sin valor ni descarte justificado', () => {
    const v = version('extraction_review', {
      fields: [field({ status: 'not_found', value: null, criticidad: 'critico' })],
    });
    const result = transition(
      { version: v, actor: user('consultor'), unresolvedCriticalFields: ['objetivo.tipo'] },
      'internal_review',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('BRIEF_MISSING_CRITICAL_FIELD');
      expect(result.error.details?.['campos']).toEqual(['objetivo.tipo']);
    }
  });

  it('un crítico ausente pero con descarte justificado (fuera de la lista del llamador) no bloquea', () => {
    const v = version('extraction_review', {
      fields: [field({ status: 'not_found', value: null, criticidad: 'critico' })],
    });
    const result = transition({ version: v, actor: user('consultor') }, 'internal_review');
    expect(result.ok).toBe(true);
  });

  it('bloquea internal_review si un campo de producto no está anclado a un producto de campaña', () => {
    const v = version('extraction_review', {
      fields: [field({ key: 'marca_producto[].rtbs', campaignProductId: undefined })],
    });
    const result = transition({ version: v, actor: user('consultor') }, 'internal_review');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('BRIEF_FIELD_INVALID');
      expect(result.error.details?.['campos']).toEqual(['marca_producto[].rtbs']);
    }
  });

  it('un campo de producto anclado a un campaign_product_id no bloquea', () => {
    const v = version('extraction_review', {
      fields: [field({ key: 'marca_producto[].rtbs', campaignProductId: 'cp-p80-ultra' })],
    });
    expect(transition({ version: v, actor: user('consultor') }, 'internal_review').ok).toBe(true);
  });

  it('bloquea internal_review si un campo encontrado por la extracción sigue sin confirmar ni corregir', () => {
    const v = version('extraction_review', { fields: [field({ reviewStatus: 'pending' })] });
    const result = transition({ version: v, actor: user('consultor') }, 'internal_review');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('BRIEF_FIELD_INVALID');
  });

  it('un campo confirmado (sin cambiar su procedencia extraída) no bloquea', () => {
    const v = version('extraction_review', {
      fields: [field({ reviewStatus: 'confirmed', provenanceType: 'extracted' })],
    });
    expect(transition({ version: v, actor: user('consultor') }, 'internal_review').ok).toBe(true);
  });

  it('un crítico no técnico respondido manualmente (manual_local, sin evidencia) avanza con atribución', () => {
    // Sección 4.4 / DEC-028 del pedido: un campo crítico no técnico (criticidad
    // 'critico', no 'claim') respondido por pregunta local no exige evidencia
    // documental — solo autor y fecha, que vive en brief_field_revisions/audit.
    const v = version('extraction_review', {
      fields: [
        field({
          key: 'practico.restricciones',
          criticidad: 'critico',
          status: 'found',
          value: 'Único canal de venta: Alkosto',
          provenanceType: 'manual_local',
          reviewStatus: 'confirmed',
          evidence: [],
        }),
      ],
    });
    expect(transition({ version: v, actor: user('consultor') }, 'internal_review').ok).toBe(true);
  });

  it('un claim manual sin evidencia sigue bloqueado (DEC-028: los claims siempre exigen evidencia)', () => {
    const v = version('extraction_review', {
      fields: [
        field({
          key: 'marca_producto[].rtbs',
          campaignProductId: 'cp-p80-ultra',
          criticidad: 'claim',
          status: 'found',
          provenanceType: 'manual_local',
          reviewStatus: 'confirmed',
          evidence: [],
        }),
      ],
    });
    const result = transition({ version: v, actor: user('consultor') }, 'internal_review');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('BRIEF_MISSING_EVIDENCE');
  });
});

describe('guarda: preguntas locales pendientes bloquea volver al brief', () => {
  it('bloquea local_questions → extraction_review si quedan preguntas de cualquier criticidad', () => {
    const result = transition(
      { version: version('local_questions'), actor: user('consultor'), pendingQuestionsTotal: 1 },
      'extraction_review',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('BRIEF_PENDING_QUESTIONS');
  });

  it('permite volver cuando ya no queda ninguna pregunta pendiente', () => {
    const result = transition(
      { version: version('local_questions'), actor: user('consultor'), pendingQuestionsTotal: 0 },
      'extraction_review',
    );
    expect(result.ok).toBe(true);
  });
});

describe('versiones EN históricas (anteriores a V2): no son versiones lógicas', () => {
  // Regla V2 que reemplaza el caso F-33 («una versión EN sin translationOfId
  // bloquea»): ya no existen versiones EN independientes con estado propio. Una
  // fila EN histórica es una representación de otra versión y no avanza sola;
  // el origen de las traducciones nuevas lo verifica `guardRepresentationsHaveOrigin`.
  it('ninguna transición se puede ejecutar sobre una fila EN histórica', () => {
    for (const translationOfId of [undefined, 'bv-es-3']) {
      const v = version('extraction_review', { language: 'en', translationOfId });
      const result = transition({ version: v, actor: user('consultor') }, 'internal_review');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('BRIEF_INVALID_TRANSITION');
        expect(result.error.details?.['motivo']).toBe('legacy_language_version');
      }
    }
  });

  it('ni siquiera aprobar: no existe «aprobar solo EN»', () => {
    const v = version('internal_review', { language: 'en', translationOfId: 'bv-es-3' });
    expect(transition({ version: v, actor: user('director') }, 'approved').ok).toBe(false);
  });
});

// ─────────────────────────── Representaciones ES / EN (V2 · Fase 2) ────────────

describe('guardas de representaciones lingüísticas', () => {
  const original: BriefRepresentation = {
    id: 'rep-es',
    language: 'es',
    kind: 'original',
    createdAt: '2026-08-11T10:00:00-05:00',
    staleFieldKeys: [],
    unverifiedFieldKeys: [],
    missingFieldKeys: [],
  };
  const traduccion = (overrides: Partial<BriefRepresentation> = {}): BriefRepresentation => ({
    id: 'rep-en',
    language: 'en',
    kind: 'translation',
    sourceRepresentationId: 'rep-es',
    sourceLanguage: 'es',
    createdAt: '2026-08-11T11:00:00-05:00',
    staleFieldKeys: [],
    unverifiedFieldKeys: [],
    missingFieldKeys: [],
    ...overrides,
  });
  const conReps = (status: BriefStatus, reps: BriefRepresentation[]) =>
    version(status, { representations: reps });

  it('una traducción sin origen verificable bloquea revisión interna y aprobación', () => {
    const sinOrigen = traduccion({ sourceRepresentationId: undefined, sourceLanguage: undefined });
    for (const [desde, hasta, actor] of [
      ['extraction_review', 'internal_review', user('consultor')],
      ['draft', 'internal_review', user('consultor')],
      ['internal_review', 'approved', user('director')],
      ['client_review', 'approved', user('director')],
    ] as const) {
      const r = transition({ version: conReps(desde, [original, sinOrigen]), actor }, hasta);
      expect(r.ok, `${desde} → ${hasta}`).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('TRANSLATION_MISSING_ORIGIN');
    }
  });

  it('un origen del mismo idioma tampoco es verificable', () => {
    const r = transition(
      {
        version: conReps('internal_review', [original, traduccion({ sourceLanguage: 'en' })]),
        actor: user('director'),
      },
      'approved',
    );
    expect(r.ok).toBe(false);
  });

  it('una traducción stale NO se aprueba (y no se da por equivalente)', () => {
    const stale = traduccion({ staleFieldKeys: ['objetivo.negocio'] });
    expect(esEquivalenteAlOriginal(stale)).toBe(false);
    expect(resumirSincronizacion(stale)).toBe('stale');
    const r = transition(
      { version: conReps('internal_review', [original, stale]), actor: user('director') },
      'approved',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('TRANSLATION_STALE');
      expect(r.error.details?.['representaciones']).toEqual([
        { idioma: 'en', desactualizados: ['objetivo.negocio'], sinVerificar: [], sinTraducir: [] },
      ]);
    }
  });

  it('sin verificar (histórica) o incompleta tampoco se aprueban', () => {
    for (const parcial of [{ unverifiedFieldKeys: ['a'] }, { missingFieldKeys: ['b'] }]) {
      const r = transition(
        {
          version: conReps('internal_review', [original, traduccion(parcial)]),
          actor: user('director'),
        },
        'approved',
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('TRANSLATION_STALE');
    }
  });

  it('una traducción al día sí se aprueba: la aprobación cubre la versión lógica completa', () => {
    const al_dia = traduccion();
    expect(esEquivalenteAlOriginal(al_dia)).toBe(true);
    expect(resumirSincronizacion(al_dia)).toBe('current');
    const r = transition(
      { version: conReps('internal_review', [original, al_dia]), actor: user('director') },
      'approved',
    );
    expect(r.ok).toBe(true);
  });

  it('sin representación EN (todavía no se genera) la versión se aprueba; el original es requerido', () => {
    expect(
      transition({ version: conReps('internal_review', [original]), actor: user('director') }, 'approved').ok,
    ).toBe(true);
    const sinOriginal = transition(
      { version: conReps('internal_review', []), actor: user('director') },
      'approved',
    );
    expect(sinOriginal.ok).toBe(false);
    if (!sinOriginal.ok) expect(sinOriginal.error.code).toBe('REPRESENTATION_MISSING');
    expect(REQUIRED_REPRESENTATION_LANGUAGES).toEqual(['es']);
  });

  it('una traducción stale no impide revisar o devolver; solo aprobar', () => {
    const stale = traduccion({ staleFieldKeys: ['x'] });
    expect(
      transition(
        { version: conReps('draft', [original, stale]), actor: user('consultor') },
        'internal_review',
      ).ok,
    ).toBe(true);
    expect(
      transition(
        { version: conReps('internal_review', [original, stale]), actor: user('director') },
        'internal_changes_requested',
      ).ok,
    ).toBe(true);
  });

  it('las reglas de rol no cambian: cliente, consultor, sistema no aprueban aunque todo esté al día', () => {
    const v = conReps('internal_review', [original, traduccion()]);
    for (const actor of [user('cliente'), user('consultor'), user('operativo'), 'system' as const]) {
      expect(transition({ version: v, actor }, 'approved').ok).toBe(false);
    }
  });

  it('el resumen prioriza stale sobre sin verificar y este sobre incompleta', () => {
    expect(resumirSincronizacion(traduccion({ staleFieldKeys: ['a'], unverifiedFieldKeys: ['b'] }))).toBe(
      'stale',
    );
    expect(resumirSincronizacion(traduccion({ unverifiedFieldKeys: ['b'], missingFieldKeys: ['c'] }))).toBe(
      'unverified',
    );
    expect(resumirSincronizacion(traduccion({ missingFieldKeys: ['c'] }))).toBe('incomplete');
    expect(resumirSincronizacion(original)).toBe('original');
  });
});

// ─────────────────────────── Ciclo asistido completo (Sprint 4, corrección 1) ──

describe('ciclo completo de extracción asistida', () => {
  it('recorre draft → processing → extraction_review', () => {
    const r1 = transition({ version: version('draft'), actor: user('consultor') }, 'processing');
    expect(r1.ok).toBe(true);

    const r2 = transition({ version: version('processing'), actor: 'system' }, 'extraction_review');
    expect(r2.ok).toBe(true);
  });

  it('un fallo del worker lleva a processing_failed, nunca directo a extraction_review', () => {
    const result = transition({ version: version('processing'), actor: 'system' }, 'processing_failed');
    expect(result.ok).toBe(true);
  });

  it('un reintento reusa la transición ya definida: processing_failed → processing', () => {
    const result = transition(
      { version: version('processing_failed'), actor: user('consultor') },
      'processing',
    );
    expect(result.ok).toBe(true);
  });

  it('extraction_review → local_questions no exige guardas: se dispara al detectar vacíos', () => {
    const result = transition(
      { version: version('extraction_review'), actor: user('consultor') },
      'local_questions',
    );
    expect(result.ok).toBe(true);
  });

  it('el ciclo completo hasta internal_review nunca usa una transición inexistente', () => {
    const camino: BriefStatus[] = [
      'draft',
      'processing',
      'extraction_review',
      'local_questions',
      'extraction_review',
      'internal_review',
    ];
    let actual = camino[0] as BriefStatus;
    for (const siguiente of camino.slice(1)) {
      const actor =
        siguiente === 'extraction_review' && actual === 'processing' ? 'system' : user('consultor');
      const ctx = { version: version(actual), actor, pendingQuestionsTotal: 0 } as const;
      const result = transition(ctx, siguiente);
      expect(result.ok, `falló ${actual} → ${siguiente}: ${!result.ok ? result.error.code : ''}`).toBe(true);
      actual = siguiente;
    }
    expect(actual).toBe('internal_review');
  });
});

// ─────────────────────────── Modo manual (§5, principio 9) ─────────────────────

describe('camino sin IA (casos R-09, R-10)', () => {
  it('se puede ir de draft a internal_review sin pasar por processing', () => {
    const result = transition({ version: version('draft'), actor: user('consultor') }, 'internal_review');
    expect(result.ok).toBe(true);
  });

  it('existe un camino completo de draft a approved sin tocar processing', () => {
    const path: BriefStatus[] = ['draft', 'internal_review', 'approved'];
    let current = path[0] as BriefStatus;

    for (const next of path.slice(1)) {
      const actor = user('director');
      const result = transition({ version: version(current), actor }, next);
      expect(result.ok, `falló ${current} → ${next}`).toBe(true);
      current = next;
    }

    expect(current).toBe('approved');
  });

  it('un procesamiento fallido permite continuar manualmente', () => {
    const result = transition({ version: version('processing_failed'), actor: user('consultor') }, 'draft');
    expect(result.ok).toBe(true);
  });
});

// ─────────────────────────── Inmutabilidad (E13-3, ADR-003) ────────────────────

describe('inmutabilidad de versiones aprobadas (casos F-28, F-29)', () => {
  it('una versión aprobada no admite edición', () => {
    const result = assertEditable(version('approved'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('BRIEF_VERSION_IMMUTABLE');
  });

  it('las versiones superseded y cancelled tampoco', () => {
    expect(assertEditable(version('superseded')).ok).toBe(false);
    expect(assertEditable(version('cancelled')).ok).toBe(false);
  });

  it('un borrador sí admite edición', () => {
    expect(assertEditable(version('draft')).ok).toBe(true);
  });

  it('isImmutable marca exactamente los tres estados cerrados', () => {
    const inmutables: BriefStatus[] = ['approved', 'superseded', 'cancelled'];
    const mutables: BriefStatus[] = [
      'draft',
      'processing',
      'extraction_review',
      'local_questions',
      'internal_review',
      'internal_changes_requested',
      'client_review',
      'client_changes_requested',
      'processing_failed',
    ];
    for (const s of inmutables) expect(isImmutable(s), s).toBe(true);
    for (const s of mutables) expect(isImmutable(s), s).toBe(false);
  });

  it('la única salida de approved es superseded', () => {
    expect(transitionsFrom('approved').map((t) => t.to)).toEqual(['superseded']);
  });
});
