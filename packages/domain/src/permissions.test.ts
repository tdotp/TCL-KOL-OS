/**
 * E13-2 · Aislamiento entre organizaciones (§27, casos S-01 a S-04).
 *
 * Un fallo en esta suite invalida la nota global de la rúbrica de gerencia (§31).
 * No resta puntos: invalida.
 */

import { describe, expect, it } from 'vitest';
import { ROLES } from './types';
import type { ResourceScope, Role, User } from './types';
import { actionsFor, authorize, canAccessResource, roleCan } from './permissions';

function user(role: Role, organizationId = 'org-smartpr'): User {
  return {
    id: `usr-${role}`,
    email: `${role}@example.co`,
    name: role,
    organizationId,
    role,
    status: 'activo',
  };
}

function scope(overrides: Partial<ResourceScope> = {}): ResourceScope {
  return {
    organizationId: 'org-smartpr',
    campaignId: 'cmp-1',
    confidentialityLevel: 'interna',
    visibility: 'interna',
    createdBy: 'usr-admin',
    ...overrides,
  };
}

// ─────────────────────────── Aislamiento horizontal ────────────────────────────

describe('aislamiento entre organizaciones (caso S-01)', () => {
  it('ningún rol accede a un recurso interno de otra organización', () => {
    const ajeno = scope({ organizationId: 'org-otra-agencia' });
    for (const role of ROLES) {
      expect(canAccessResource(user(role), ajeno), `${role} accedió a otra organización`).toBe(false);
    }
  });

  it('devuelve RESOURCE_NOT_FOUND, no FORBIDDEN: revelar que existe ya es una filtración', () => {
    const result = authorize(user('admin'), 'campaign:read', scope({ organizationId: 'org-otra' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('el mensaje de error no revela la organización propietaria', () => {
    const result = authorize(user('admin'), 'campaign:read', scope({ organizationId: 'org-secreta' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).not.toContain('org-secreta');
      expect(JSON.stringify(result.error.details)).not.toContain('org-secreta');
    }
  });

  it('un usuario inactivo no accede a nada', () => {
    const inactivo: User = { ...user('admin'), status: 'inactivo' };
    expect(canAccessResource(inactivo, scope())).toBe(false);
  });
});

// ─────────────────────────── Vista del cliente TCL ─────────────────────────────

describe('vista del cliente TCL (DEC-012 / ADR-004)', () => {
  it('no ve recursos internos', () => {
    expect(canAccessResource(user('cliente', 'org-tcl'), scope({ visibility: 'interna' }))).toBe(false);
  });

  it('sí ve lo compartido explícitamente', () => {
    expect(canAccessResource(user('cliente', 'org-tcl'), scope({ visibility: 'tcl' }))).toBe(true);
    expect(canAccessResource(user('cliente', 'org-tcl'), scope({ visibility: 'compartida' }))).toBe(true);
  });

  it('NO puede aprobar internamente: eso sigue siendo exclusivo de admin/director', () => {
    expect(roleCan('cliente', 'brief:approve_internal')).toBe(false);
  });

  it('desde Sprint 5 (Fase D) sí decide sobre su propia revisión, pero nada más', () => {
    // `brief:register_client_decision` ya existía, reservada para que el
    // personal registrara la decisión del cliente en su nombre (DEC-012) —
    // ahora el propio cliente también la ejerce (DEC-030).
    expect(roleCan('cliente', 'brief:register_client_decision')).toBe(true);
    expect(roleCan('cliente', 'brief:request_client_changes')).toBe(true);
    // Nunca la transición genérica: solo esas dos, mapeadas explícitamente en
    // `packages/db/src/transitions.ts` (`accionParaDestino`).
    expect(roleCan('cliente', 'brief:transition')).toBe(false);
  });

  it('no puede editar, cargar fuentes ni ver auditoría', () => {
    for (const action of ['brief:edit', 'source:upload', 'audit:read', 'airun:read'] as const) {
      expect(roleCan('cliente', action), `el cliente podía ${action}`).toBe(false);
    }
  });

  it('nunca ve comentarios internos, abiertos o resueltos (Sprint 5, Fase B — decisión explícita del product owner)', () => {
    expect(roleCan('cliente', 'comment:internal')).toBe(false);
    expect(roleCan('cliente', 'comment:client_visible')).toBe(false);
  });

  it('solo lee campaña y brief, exporta, y decide sobre su propia revisión — nada más', () => {
    expect([...actionsFor('cliente')].sort()).toEqual([
      'brief:export',
      'brief:read',
      'brief:register_client_decision',
      'brief:request_client_changes',
      'campaign:read',
    ]);
  });
});

// ─────────────────────────── Escalamiento de rol ───────────────────────────────

describe('escalamiento de rol (caso S-03)', () => {
  it('solo el admin administra usuarios, integraciones y el flag de IA', () => {
    for (const action of ['admin:users', 'admin:integrations', 'admin:ai_flag'] as const) {
      for (const role of ROLES) {
        expect(roleCan(role, action), `${role} podía ${action}`).toBe(role === 'admin');
      }
    }
  });

  it('el consultor no puede aprobar internamente', () => {
    expect(roleCan('consultor', 'brief:approve_internal')).toBe(false);
    const result = authorize(user('consultor'), 'brief:approve_internal', scope());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('FORBIDDEN_ROLE');
  });

  it('el consultor propone términos de glosario pero no los aprueba', () => {
    expect(roleCan('consultor', 'glossary:propose')).toBe(true);
    expect(roleCan('consultor', 'glossary:approve')).toBe(false);
  });

  it('el analista no modifica nada', () => {
    for (const action of ['campaign:create', 'campaign:update', 'brief:edit', 'source:upload'] as const) {
      expect(roleCan('analista', action), `el analista podía ${action}`).toBe(false);
    }
  });

  it('el rol legal no accede a material confidencial sin asignación explícita', () => {
    expect(canAccessResource(user('legal'), scope({ confidentialityLevel: 'confidencial' }))).toBe(false);
    expect(canAccessResource(user('legal'), scope({ confidentialityLevel: 'interna' }))).toBe(true);
  });
});

// ─────────────────────────── Camino feliz ──────────────────────────────────────

describe('accesos legítimos', () => {
  it('el admin de la misma organización puede todo sobre un recurso interno', () => {
    for (const action of actionsFor('admin')) {
      expect(authorize(user('admin'), action, scope()).ok, `admin no pudo ${action}`).toBe(true);
    }
  });

  it('el consultor puede editar el brief de su organización', () => {
    expect(authorize(user('consultor'), 'brief:edit', scope()).ok).toBe(true);
  });
});
