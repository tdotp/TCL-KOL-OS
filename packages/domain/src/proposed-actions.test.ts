/**
 * V2 · Fase 1D — política pura de acciones propuestas (human-in-the-loop).
 */

import { describe, expect, it } from 'vitest';
import {
  PROPOSED_ACTION_SPECS,
  capacidadesDe,
  puedeCancelar,
  puedeConfirmar,
  puedeEjecutar,
  puedeProponer,
  rolPuedeConfirmar,
  rolPuedeProponer,
  specDeAccion,
  type ProposedAction,
  type ProposedActionType,
} from './proposed-actions';
import type { Role, User } from './types';

function user(role: Role, id = `usr-${role}`, organizationId = 'org-smartpr'): User {
  return { id, email: `${role}@x.co`, name: role, organizationId, role, status: 'activo' };
}

const AHORA = new Date('2026-10-03T12:00:00Z');

function accion(overrides: Partial<ProposedAction> = {}): ProposedAction {
  return {
    id: 'pa-1',
    organizationId: 'org-smartpr',
    campaignId: 'cmp-1',
    type: 'brief.approve',
    resourceType: 'brief_version',
    resourceId: 'ver-1',
    payload: { versionId: 'ver-1' },
    payloadHash: 'h',
    status: 'pending',
    proposedBy: 'usr-consultor',
    proposedOrigin: 'chat',
    expiresAt: '2026-10-04T12:00:00Z',
    createdAt: '2026-10-03T11:00:00Z',
    ...overrides,
  };
}

const spec = PROPOSED_ACTION_SPECS['brief.approve'];

describe('quién puede proponer', () => {
  it('el sistema y el personal con capacidad; no cliente, operativo ni analista', () => {
    expect(puedeProponer('system', spec).ok).toBe(true);
    for (const rol of ['admin', 'director', 'consultor'] as const) {
      expect(puedeProponer(user(rol), spec).ok, rol).toBe(true);
    }
    for (const rol of ['cliente', 'operativo', 'analista', 'legal'] as const) {
      expect(puedeProponer(user(rol), spec).ok, rol).toBe(false);
    }
  });
});

describe('quién puede confirmar', () => {
  it('system nunca confirma, ni siquiera con canal ui', () => {
    const r = puedeConfirmar('system', 'ui', accion(), AHORA);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('HUMAN_CONFIRMATION_REQUIRED');
  });

  it('el canal chat o system nunca confirma, aunque sea una persona con permiso', () => {
    for (const canal of ['chat', 'system'] as const) {
      const r = puedeConfirmar(user('admin'), canal, accion(), AHORA);
      expect(r.ok, canal).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('HUMAN_CONFIRMATION_REQUIRED');
    }
  });

  it('solo admin y director confirman; consultor, operativo, cliente, analista y legal no', () => {
    for (const rol of ['admin', 'director'] as const) {
      expect(puedeConfirmar(user(rol), 'ui', accion(), AHORA).ok, rol).toBe(true);
    }
    for (const rol of ['consultor', 'operativo', 'cliente', 'analista', 'legal'] as const) {
      const r = puedeConfirmar(user(rol), 'ui', accion(), AHORA);
      expect(r.ok, rol).toBe(false);
    }
  });

  it('una persona de otra organización no la ve', () => {
    const r = puedeConfirmar(user('admin', 'x', 'org-otra'), 'ui', accion(), AHORA);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('solo una acción pendiente y vigente se confirma', () => {
    for (const status of ['confirmed', 'executed', 'cancelled', 'expired'] as const) {
      const r = puedeConfirmar(user('admin'), 'ui', accion({ status }), AHORA);
      expect(r.ok, status).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('PROPOSAL_INVALID_STATE');
    }
    const vencida = puedeConfirmar(user('admin'), 'ui', accion({ expiresAt: '2026-10-03T11:59:59Z' }), AHORA);
    expect(vencida.ok).toBe(false);
    if (!vencida.ok) expect(vencida.error.code).toBe('PROPOSAL_EXPIRED');
  });

  it('una acción asignada la confirma solo la persona asignada', () => {
    const asignada = accion({ assignedTo: 'usr-director' });
    expect(puedeConfirmar(user('admin'), 'ui', asignada, AHORA).ok).toBe(false);
    expect(puedeConfirmar(user('director'), 'ui', asignada, AHORA).ok).toBe(true);
  });
});

describe('quién puede ejecutar', () => {
  const confirmada = accion({ status: 'confirmed', confirmedBy: 'usr-admin' });

  it('solo la persona que confirmó, desde la interfaz, con el permiso vigente', () => {
    expect(puedeEjecutar(user('admin'), 'ui', confirmada, AHORA).ok).toBe(true);
    expect(puedeEjecutar(user('director'), 'ui', confirmada, AHORA).ok).toBe(false);
    expect(puedeEjecutar('system', 'ui', confirmada, AHORA).ok).toBe(false);
    expect(puedeEjecutar(user('admin'), 'chat', confirmada, AHORA).ok).toBe(false);
  });

  it('no ejecuta una pendiente ni una ya ejecutada, cancelada o vencida', () => {
    for (const status of ['pending', 'executed', 'cancelled', 'expired'] as const) {
      const r = puedeEjecutar(user('admin'), 'ui', { ...confirmada, status }, AHORA);
      expect(r.ok, status).toBe(false);
    }
  });

  it('el permiso se verifica de nuevo: un rol sin capacidad no ejecuta aunque figure como confirmante', () => {
    const r = puedeEjecutar(
      user('consultor', 'usr-consultor'),
      'ui',
      { ...confirmada, confirmedBy: 'usr-consultor' },
      AHORA,
    );
    expect(r.ok).toBe(false);
  });
});

describe('quién puede cancelar', () => {
  it('quien la propuso o quien puede confirmarla; solo si está abierta', () => {
    expect(puedeCancelar(user('consultor'), accion()).ok).toBe(true);
    expect(puedeCancelar(user('director'), accion()).ok).toBe(true);
    expect(puedeCancelar(user('operativo'), accion()).ok).toBe(false);
    expect(puedeCancelar(user('admin'), accion({ status: 'executed' })).ok).toBe(false);
  });
});

// ─────────────────────────── V2 · Fase 6: importación por el chat ──────────────

const TIPOS_DE_IMPORTACION = ['influencer_import.apply', 'influencer_import.resolve_record'] as const;

function accionDeImportacion(
  type: (typeof TIPOS_DE_IMPORTACION)[number],
  overrides: Partial<ProposedAction> = {},
) {
  return accion({
    type,
    resourceType: type === 'influencer_import.apply' ? 'influencer_import_plan' : 'influencer_import_record',
    ...overrides,
  });
}

describe('registro de tipos', () => {
  it('hay un spec por tipo, con su recurso y capacidades; un nombre heredado del prototipo no es un tipo', () => {
    expect(Object.keys(PROPOSED_ACTION_SPECS).sort()).toEqual(
      ['brief.approve', ...TIPOS_DE_IMPORTACION, 'script_version.approve'].sort(),
    );
    for (const tipo of Object.keys(PROPOSED_ACTION_SPECS) as ProposedActionType[]) {
      expect(specDeAccion(tipo)?.type).toBe(tipo);
    }
    expect(PROPOSED_ACTION_SPECS['influencer_import.apply'].resourceType).toBe('influencer_import_plan');
    expect(PROPOSED_ACTION_SPECS['influencer_import.resolve_record'].resourceType).toBe(
      'influencer_import_record',
    );
    for (const nombre of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'nope']) {
      expect(specDeAccion(nombre), nombre).toBeUndefined();
    }
  });

  it('brief.approve conserva su capacidad única (propone brief:request_review, confirma brief:approve_internal)', () => {
    expect(capacidadesDe(PROPOSED_ACTION_SPECS['brief.approve'].proposeCapability)).toEqual([
      'brief:request_review',
    ]);
    expect(capacidadesDe(PROPOSED_ACTION_SPECS['brief.approve'].confirmCapability)).toEqual([
      'brief:approve_internal',
    ]);
  });

  it('la importación exige TODAS sus capacidades para proponer y confirmar', () => {
    for (const tipo of TIPOS_DE_IMPORTACION) {
      const spec = PROPOSED_ACTION_SPECS[tipo];
      expect(capacidadesDe(spec.proposeCapability)).toEqual([
        'influencer:manage',
        'campaign_influencer:manage',
      ]);
      expect(capacidadesDe(spec.confirmCapability)).toEqual([
        'influencer:manage',
        'campaign_influencer:manage',
      ]);
    }
  });
});

describe('importación: quién propone, confirma, ejecuta y cancela', () => {
  for (const tipo of TIPOS_DE_IMPORTACION) {
    const spec = PROPOSED_ACTION_SPECS[tipo];

    it(`${tipo}: propone el personal con la capacidad (y el sistema, que prepara); no cliente ni operativo`, () => {
      expect(puedeProponer('system', spec).ok).toBe(true);
      for (const rol of ['admin', 'director', 'consultor'] as const) {
        expect(puedeProponer(user(rol), spec).ok, rol).toBe(true);
        expect(rolPuedeProponer(rol, spec), rol).toBe(true);
      }
      for (const rol of ['cliente', 'operativo', 'analista', 'legal'] as const) {
        const r = puedeProponer(user(rol), spec);
        expect(r.ok, rol).toBe(false);
        if (!r.ok) expect(r.error.code).toBe('FORBIDDEN_ROLE');
        expect(rolPuedeProponer(rol, spec), rol).toBe(false);
      }
    });

    it(`${tipo}: confirma una PERSONA con la capacidad desde la interfaz; nunca system ni el canal chat`, () => {
      const a = accionDeImportacion(tipo);
      for (const rol of ['admin', 'director', 'consultor'] as const) {
        expect(puedeConfirmar(user(rol), 'ui', a, AHORA).ok, rol).toBe(true);
        expect(rolPuedeConfirmar(rol, spec), rol).toBe(true);
      }
      for (const rol of ['cliente', 'operativo', 'analista', 'legal'] as const) {
        expect(puedeConfirmar(user(rol), 'ui', a, AHORA).ok, rol).toBe(false);
      }
      for (const canal of ['chat', 'system'] as const) {
        for (const rol of ['admin', 'director', 'consultor'] as const) {
          const r = puedeConfirmar(user(rol), canal, a, AHORA);
          expect(r.ok, `${rol}/${canal}`).toBe(false);
          if (!r.ok) expect(r.error.code).toBe('HUMAN_CONFIRMATION_REQUIRED');
        }
      }
      const sistema = puedeConfirmar('system', 'ui', a, AHORA);
      expect(sistema.ok).toBe(false);
      if (!sistema.ok) expect(sistema.error.code).toBe('HUMAN_CONFIRMATION_REQUIRED');
      // Otra organización: no la ve.
      const ajena = puedeConfirmar(user('admin', 'x', 'org-otra'), 'ui', a, AHORA);
      expect(ajena.ok).toBe(false);
      if (!ajena.ok) expect(ajena.error.code).toBe('RESOURCE_NOT_FOUND');
    });

    it(`${tipo}: ejecuta solo quien confirmó, desde la interfaz; chat y system nunca`, () => {
      const confirmada = accionDeImportacion(tipo, { status: 'confirmed', confirmedBy: 'usr-consultor' });
      expect(puedeEjecutar(user('consultor'), 'ui', confirmada, AHORA).ok).toBe(true);
      expect(puedeEjecutar(user('admin'), 'ui', confirmada, AHORA).ok).toBe(false);
      expect(puedeEjecutar(user('consultor'), 'chat', confirmada, AHORA).ok).toBe(false);
      expect(puedeEjecutar('system', 'ui', confirmada, AHORA).ok).toBe(false);
    });

    it(`${tipo}: cancela quien la propuso o quien puede confirmarla`, () => {
      const a = accionDeImportacion(tipo);
      expect(puedeCancelar(user('consultor'), a).ok).toBe(true);
      expect(puedeCancelar(user('operativo'), a).ok).toBe(false);
      expect(puedeCancelar(user('cliente'), a).ok).toBe(false);
    });
  }
});

// ─────────────────────────── V2 · Fase 7: aprobar un guion ─────────────────────

describe('script_version.approve (Fase 7)', () => {
  const specGuion = PROPOSED_ACTION_SPECS['script_version.approve'];
  const accionGuion = (overrides: Partial<ProposedAction> = {}) =>
    accion({ type: 'script_version.approve', resourceType: 'script_version', ...overrides });

  it('propone script:manage y confirma script:approve; el recurso es la versión de guion', () => {
    expect(specGuion.resourceType).toBe('script_version');
    expect(capacidadesDe(specGuion.proposeCapability)).toEqual(['script:manage']);
    expect(capacidadesDe(specGuion.confirmCapability)).toEqual(['script:approve']);
  });

  it('propone admin, director y consultor (y el sistema, que prepara); no operativo, analista, legal ni cliente', () => {
    expect(puedeProponer('system', specGuion).ok).toBe(true);
    for (const rol of ['admin', 'director', 'consultor'] as const) {
      expect(puedeProponer(user(rol), specGuion).ok, rol).toBe(true);
      expect(rolPuedeProponer(rol, specGuion), rol).toBe(true);
    }
    for (const rol of ['operativo', 'analista', 'legal', 'cliente'] as const) {
      expect(puedeProponer(user(rol), specGuion).ok, rol).toBe(false);
      expect(rolPuedeProponer(rol, specGuion), rol).toBe(false);
    }
  });

  it('confirma y ejecuta SOLO admin y director, por la interfaz; el consultor propone pero no confirma', () => {
    for (const rol of ['admin', 'director'] as const) {
      expect(rolPuedeConfirmar(rol, specGuion), rol).toBe(true);
      expect(puedeConfirmar(user(rol), 'ui', accionGuion(), AHORA).ok, rol).toBe(true);
    }
    for (const rol of ['consultor', 'operativo', 'analista', 'legal', 'cliente'] as const) {
      expect(rolPuedeConfirmar(rol, specGuion), rol).toBe(false);
      const r = puedeConfirmar(user(rol), 'ui', accionGuion(), AHORA);
      expect(r.ok, rol).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('FORBIDDEN_ROLE');
    }
  });

  it('ni el chat ni el sistema confirman o ejecutan, aunque el actor sea un director', () => {
    for (const canal of ['chat', 'system'] as const) {
      const r = puedeConfirmar(user('director'), canal, accionGuion(), AHORA);
      expect(r.ok, canal).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('HUMAN_CONFIRMATION_REQUIRED');
    }
    const s = puedeConfirmar('system', 'ui', accionGuion(), AHORA);
    expect(s.ok).toBe(false);
    if (!s.ok) expect(s.error.code).toBe('HUMAN_CONFIRMATION_REQUIRED');
    const e = puedeEjecutar(
      user('director'),
      'chat',
      accionGuion({ status: 'confirmed', confirmedBy: 'usr-director' }),
      AHORA,
    );
    expect(e.ok).toBe(false);
  });
});
