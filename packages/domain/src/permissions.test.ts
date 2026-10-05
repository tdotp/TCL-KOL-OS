/**
 * E13-2 · Aislamiento entre organizaciones (§27, casos S-01 a S-04).
 *
 * Un fallo en esta suite invalida la nota global de la rúbrica de gerencia (§31).
 * No resta puntos: invalida.
 */

import { describe, expect, it } from 'vitest';
import { ROLES } from './types';
import type { ResourceScope, Role, User } from './types';
import {
  actionsFor,
  authorize,
  authorizeInternalResource,
  canAccessResource,
  isTclVisible,
  roleCan,
} from './permissions';

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

  it('es de solo lectura sobre el workflow: ni aprueba, ni pide cambios, ni transiciona', () => {
    // Corrección del workflow cliente: SmartPR opera y decide; el cliente solo
    // consulta. Las acciones `brief:register_client_decision` y
    // `brief:request_client_changes` dejaron de existir.
    expect(roleCan('cliente', 'brief:approve_internal')).toBe(false);
    expect(roleCan('cliente', 'brief:transition')).toBe(false);
    expect(roleCan('cliente', 'brief:request_review')).toBe(false);
    expect(actionsFor('cliente').filter((a) => a.includes('client'))).toEqual([]);
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

  it('solo lee campaña, brief y las fuentes que SmartPR le expone, y exporta — nada más', () => {
    // V2 · Fase 1A añadió `source:read_shared`: lectura de fuentes marcadas
    // visibles para TCL. NO es `source:read` (todas las de la organización).
    expect([...actionsFor('cliente')].sort()).toEqual([
      'brief:export',
      'brief:read',
      'campaign:read',
      'source:read_shared',
    ]);
    expect(roleCan('cliente', 'source:read')).toBe(false);
    expect(roleCan('cliente', 'source:set_visibility')).toBe(false);
  });
});

// ─────────────────────────── Visibilidad (V2 · Fase 1A) ────────────────────────

describe('contrato de visibilidad documental', () => {
  it('interna es solo de SmartPR; tcl y compartida son visibles para TCL', () => {
    expect(isTclVisible('interna')).toBe(false);
    expect(isTclVisible('tcl')).toBe(true);
    expect(isTclVisible('compartida')).toBe(true);
  });

  it('decidir qué ve TCL es de SmartPR (admin, director, consultor), nunca de TCL ni de Operativo', () => {
    for (const rol of ['admin', 'director', 'consultor'] as const) {
      expect(roleCan(rol, 'source:set_visibility'), rol).toBe(true);
    }
    for (const rol of ['cliente', 'operativo', 'analista', 'legal'] as const) {
      expect(roleCan(rol, 'source:set_visibility'), rol).toBe(false);
    }
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

// ─────────────────────────── Usuario Operativo (V2 · Fase 1B) ──────────────────

describe('usuario operativo', () => {
  it('existe como rol propio, distinto de cliente y de analista', () => {
    expect(ROLES).toContain('operativo');
    expect(actionsFor('operativo')).not.toEqual(actionsFor('cliente'));
    expect(actionsFor('operativo')).not.toEqual(actionsFor('analista'));
  });

  it('solo entra y consulta: campaña, fuentes internas, brief y (Fase 3) influencers y su participación', () => {
    // Fase 3 legitima ampliar esta lista exactamente con las dos LECTURAS de
    // influencer: el Usuario Operativo trabaja sobre los influencers de la
    // campaña. Sigue sin ninguna capacidad de escritura.
    expect([...actionsFor('operativo')].sort()).toEqual([
      'brief:read',
      'campaign:read',
      'campaign_influencer:read',
      'influencer:read',
      'source:read',
    ]);
  });

  it('no aprueba, no transiciona, no edita, no administra', () => {
    for (const action of [
      'brief:approve_internal',
      'brief:transition',
      'brief:request_review',
      'brief:edit',
      'field:correct',
      'field:confirm',
      'question:answer',
      'comment:internal',
      'source:upload',
      'source:set_visibility',
      'admin:users',
      'admin:integrations',
      'admin:ai_flag',
      'audit:read',
      'airun:read',
      'glossary:approve',
    ] as const) {
      expect(roleCan('operativo', action), `operativo podía ${action}`).toBe(false);
    }
  });

  it('es de SmartPR, no de TCL: respeta el aislamiento por organización y la visibilidad no lo amplía', () => {
    const operativo = user('operativo', 'org-smartpr');
    expect(
      canAccessResource(operativo, scope({ organizationId: 'org-smartpr', visibility: 'interna' })),
    ).toBe(true);
    expect(canAccessResource(operativo, scope({ organizationId: 'org-otra', visibility: 'tcl' }))).toBe(
      false,
    );
  });

  it('admin, director y cliente conservan su comportamiento', () => {
    expect(roleCan('admin', 'brief:approve_internal')).toBe(true);
    expect(roleCan('director', 'brief:approve_internal')).toBe(true);
    expect(roleCan('consultor', 'brief:approve_internal')).toBe(false);
    expect(roleCan('cliente', 'brief:transition')).toBe(false);
  });
});

// ─────────────────────────── Influencer (V2 · Fase 3) ──────────────────────────

describe('influencer y participación en campaña', () => {
  const ACCIONES = [
    'influencer:read',
    'influencer:manage',
    'campaign_influencer:read',
    'campaign_influencer:manage',
  ] as const;

  it('Cuenta (admin, director, consultor) lee y gestiona', () => {
    for (const rol of ['admin', 'director', 'consultor'] as const) {
      for (const accion of ACCIONES) expect(roleCan(rol, accion), `${rol} ${accion}`).toBe(true);
    }
  });

  it('Operativo solo lee; no gestiona identidad ni participación', () => {
    expect(roleCan('operativo', 'influencer:read')).toBe(true);
    expect(roleCan('operativo', 'campaign_influencer:read')).toBe(true);
    expect(roleCan('operativo', 'influencer:manage')).toBe(false);
    expect(roleCan('operativo', 'campaign_influencer:manage')).toBe(false);
  });

  it('el cliente TCL no recibe ninguna capacidad nueva (su dashboard tendrá una proyección propia)', () => {
    for (const accion of ACCIONES) expect(roleCan('cliente', accion), accion).toBe(false);
  });

  it('analista y legal tampoco: no se otorgan permisos por anticipación', () => {
    for (const rol of ['analista', 'legal'] as const) {
      for (const accion of ACCIONES) expect(roleCan(rol, accion), `${rol} ${accion}`).toBe(false);
    }
  });

  it('no existen permisos financieros anticipados', () => {
    const todas = ROLES.flatMap((rol) => [...actionsFor(rol)]) as string[];
    expect(todas.filter((a) => /^(payment|invoice|agreement|kpi|shipping)/.test(a))).toEqual([]);
  });
});

describe('authorizeInternalResource (recursos internos sin visibilidad hacia TCL)', () => {
  it('mismo organización y rol con capacidad: permitido', () => {
    expect(authorizeInternalResource(user('consultor'), 'influencer:manage', 'org-smartpr').ok).toBe(true);
    expect(authorizeInternalResource(user('operativo'), 'influencer:read', 'org-smartpr').ok).toBe(true);
  });

  it('otra organización: RESOURCE_NOT_FOUND para cualquier rol (no revela que existe)', () => {
    for (const rol of ROLES) {
      const r = authorizeInternalResource(user(rol), 'influencer:read', 'org-otra');
      expect(r.ok, rol).toBe(false);
      if (!r.ok) expect(r.error.code, rol).toBe('RESOURCE_NOT_FOUND');
    }
  });

  it('el cliente nunca accede, ni siquiera con la misma organización: la visibilidad no lo amplía', () => {
    const cliente = user('cliente', 'org-smartpr');
    const r = authorizeInternalResource(cliente, 'influencer:read', 'org-smartpr');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('un rol sin la capacidad recibe FORBIDDEN_ROLE', () => {
    const r = authorizeInternalResource(user('operativo'), 'influencer:manage', 'org-smartpr');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('FORBIDDEN_ROLE');
  });

  it('un usuario inactivo no accede', () => {
    const inactivo: User = { ...user('admin'), status: 'inactivo' };
    expect(authorizeInternalResource(inactivo, 'influencer:read', 'org-smartpr').ok).toBe(false);
  });
});

// ─────────────────────────── Chat del agente (V2 · Fase 6) ─────────────────────

describe('chat del agente de Cuenta (D4)', () => {
  const ACCIONES = ['chat:read', 'chat:write'] as const;

  it('Cuenta (admin, director, consultor) lee y escribe en el chat', () => {
    for (const rol of ['admin', 'director', 'consultor'] as const) {
      for (const accion of ACCIONES) expect(roleCan(rol, accion), `${rol} ${accion}`).toBe(true);
    }
  });

  it('operativo, analista, legal y cliente no reciben ninguna capacidad de chat', () => {
    for (const rol of ['operativo', 'analista', 'legal', 'cliente'] as const) {
      for (const accion of ACCIONES) expect(roleCan(rol, accion), `${rol} ${accion}`).toBe(false);
    }
  });

  it('no hay capacidades de chat más amplias (sin chat:read_all ni permisos de tools)', () => {
    const todas = ROLES.flatMap((rol) => [...actionsFor(rol)]) as string[];
    expect(
      [
        ...new Set(
          todas.filter((a) => a.startsWith('chat') || a.startsWith('tool') || a.startsWith('agent')),
        ),
      ].sort(),
    ).toEqual(['chat:read', 'chat:write']);
  });

  it('el chat es interno: un rol con la capacidad en otra organización recibe RESOURCE_NOT_FOUND', () => {
    const r = authorizeInternalResource(user('consultor'), 'chat:read', 'org-otra');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('RESOURCE_NOT_FOUND');
    expect(authorizeInternalResource(user('consultor'), 'chat:write', 'org-smartpr').ok).toBe(true);
    const sin = authorizeInternalResource(user('operativo'), 'chat:read', 'org-smartpr');
    expect(sin.ok).toBe(false);
    if (!sin.ok) expect(sin.error.code).toBe('FORBIDDEN_ROLE');
  });

  it('la matriz exacta de los demás roles no cambió (operativo y cliente conservan su lista)', () => {
    expect([...actionsFor('operativo')].sort()).toEqual([
      'brief:read',
      'campaign:read',
      'campaign_influencer:read',
      'influencer:read',
      'source:read',
    ]);
    expect([...actionsFor('cliente')].sort()).toEqual([
      'brief:export',
      'brief:read',
      'campaign:read',
      'source:read_shared',
    ]);
  });
});
