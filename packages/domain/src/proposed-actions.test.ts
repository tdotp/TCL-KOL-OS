/**
 * V2 · Fase 1D — política pura de acciones propuestas (human-in-the-loop).
 */

import { describe, expect, it } from 'vitest';
import {
  PROPOSED_ACTION_SPECS,
  puedeCancelar,
  puedeConfirmar,
  puedeEjecutar,
  puedeProponer,
  type ProposedAction,
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
