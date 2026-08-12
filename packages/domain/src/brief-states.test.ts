/**
 * E13-1 · Cobertura funcional 100% de las transiciones de estado (§27).
 *
 * Se prueba cada transición declarada, cada transición inválida representativa,
 * y las tres guardas que sostienen los umbrales de §15.
 */

import { describe, expect, it } from 'vitest';
import {
  TERMINAL_STATES,
  TRANSITIONS,
  allowedTransitions,
  assertEditable,
  isImmutable,
  transition,
  transitionsFrom,
} from './brief-states';
import type { BriefField, BriefStatus, BriefVersion, Role, User } from './types';

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
  it('el consultor NO puede aprobar internamente', () => {
    const result = transition(
      { version: version('internal_review'), actor: user('consultor') },
      'client_review',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('FORBIDDEN_ROLE');
  });

  it('el director sí puede aprobar internamente', () => {
    const result = transition(
      { version: version('internal_review'), actor: user('director') },
      'client_review',
    );
    expect(result.ok).toBe(true);
  });

  it('el cliente no puede ejecutar ninguna transición', () => {
    for (const rule of TRANSITIONS) {
      const result = transition({ version: version(rule.from), actor: user('cliente') }, rule.to);
      expect(result.ok, `el cliente logró ${rule.from} → ${rule.to}`).toBe(false);
    }
  });

  it('un humano no puede ejecutar transiciones reservadas al sistema', () => {
    const result = transition({ version: version('processing'), actor: user('admin') }, 'extraction_review');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('FORBIDDEN_ROLE');
  });

  it('el sistema no puede ejecutar transiciones humanas', () => {
    const result = transition({ version: version('internal_review'), actor: 'system' }, 'client_review');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('FORBIDDEN_ROLE');
  });

  it('allowedTransitions refleja el rol del actor', () => {
    expect(allowedTransitions('internal_review', user('consultor'))).not.toContain('client_review');
    expect(allowedTransitions('internal_review', user('director'))).toContain('client_review');
  });
});

// ─────────────────────────── Guardas de datos ──────────────────────────────────

describe('guarda: claims sin evidencia (caso F-16, GS-006)', () => {
  it('bloquea la aprobación de un claim sin evidencia', () => {
    const v = version('client_review', { fields: [field({ evidence: [] })] });
    const result = transition({ version: v, actor: user('admin') }, 'approved');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('BRIEF_MISSING_EVIDENCE');
      expect(result.error.details?.['campos']).toEqual(['marca_producto.beneficio_principal']);
    }
  });

  it('un campo informativo sin evidencia no bloquea', () => {
    const v = version('client_review', {
      fields: [field({ criticidad: 'informativo', evidence: [] })],
    });
    expect(transition({ version: v, actor: user('admin') }, 'approved').ok).toBe(true);
  });

  it('un campo not_found sin evidencia no bloquea: la ausencia es un resultado válido', () => {
    const v = version('client_review', {
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
      { version: version('client_review'), actor: user('admin'), pendingCriticalQuestions: 2 },
      'approved',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('BRIEF_PENDING_QUESTIONS');
  });

  it('no bloquea el envío a revisión interna: el revisor debe poder verlas', () => {
    const result = transition(
      { version: version('extraction_review'), actor: user('consultor'), pendingCriticalQuestions: 2 },
      'internal_review',
    );
    expect(result.ok).toBe(true);
  });
});

describe('guarda: traducción sin origen (caso F-33)', () => {
  it('bloquea una versión EN sin translationOfId', () => {
    const v = version('extraction_review', { language: 'en' });
    const result = transition({ version: v, actor: user('consultor') }, 'internal_review');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('TRANSLATION_MISSING_ORIGIN');
  });

  it('acepta una versión EN con origen declarado', () => {
    const v = version('extraction_review', { language: 'en', translationOfId: 'bv-es-3' });
    expect(transition({ version: v, actor: user('consultor') }, 'internal_review').ok).toBe(true);
  });
});

// ─────────────────────────── Modo manual (§5, principio 9) ─────────────────────

describe('camino sin IA (casos R-09, R-10)', () => {
  it('se puede ir de draft a internal_review sin pasar por processing', () => {
    const result = transition({ version: version('draft'), actor: user('consultor') }, 'internal_review');
    expect(result.ok).toBe(true);
  });

  it('existe un camino completo de draft a approved sin tocar processing', () => {
    const path: BriefStatus[] = ['draft', 'internal_review', 'client_review', 'approved'];
    let current = path[0] as BriefStatus;

    for (const next of path.slice(1)) {
      const actor = next === 'client_review' ? user('director') : user('admin');
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
