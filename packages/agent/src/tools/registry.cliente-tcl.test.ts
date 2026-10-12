/**
 * V2 · Fase 9 (DEC-050): el agente y su registro de tools siguen SIN superficie para el cliente TCL.
 *
 * El dashboard de TCL es de solo lectura y no hay agente para TCL. Las capacidades nuevas del cliente
 * (`campaign:read_client`, `content:read_approved_client`, `operations:read_summary_client`, `kpi:read_client`,
 * `export:client`) no las exige ninguna tool, y ninguna tool reutiliza la proyección TCL. Pruebas estáticas y de
 * registro: no necesitan datos (solo el entorno de pruebas de packages/db).
 */
import { describe, expect, it } from 'vitest';
import { actionsFor, roleCan } from '@tcl-kol-os/domain';
import type { Action, User } from '@tcl-kol-os/domain';
import { CATALOGO_V1 } from './catalog/index.ts';
import { registro } from './test-support.ts';

const CAPACIDADES_DE_TCL: readonly Action[] = [
  'campaign:read_client',
  'content:read_approved_client',
  'operations:read_summary_client',
  'kpi:read_client',
  'export:client',
  'document:read_client',
];

const CLIENTE: User = {
  id: '00000000-0000-4000-8000-0000000000c1',
  email: 'cliente@tcl.test',
  name: 'Cliente TCL',
  organizationId: '00000000-0000-4000-8000-0000000000c2',
  role: 'cliente',
  status: 'activo',
};

const exigidas = (a: (typeof CATALOGO_V1)[number]['requiredAction']): readonly Action[] =>
  typeof a === 'string' ? [a] : a;

describe('el registro de tools no tiene superficie para el cliente TCL', () => {
  it('el registro no ofrece ninguna tool al cliente (ni activo ni con todas sus capacidades)', () => {
    const r = registro();
    expect(r.definitionsFor(CLIENTE)).toEqual([]);
    expect(r.definitionsFor({ ...CLIENTE, status: 'inactivo' })).toEqual([]);
  });

  it('ninguna tool exige una capacidad de TCL: no son capacidades del agente', () => {
    for (const t of CATALOGO_V1) {
      for (const a of exigidas(t.requiredAction)) {
        expect(CAPACIDADES_DE_TCL, `${t.name} exige ${a}`).not.toContain(a);
      }
    }
  });

  it('el cliente no cumple los requisitos de NINGUNA tool, ni el chat (chat:read / chat:write)', () => {
    expect(roleCan('cliente', 'chat:read')).toBe(false);
    expect(roleCan('cliente', 'chat:write')).toBe(false);
    for (const t of CATALOGO_V1) {
      expect(
        exigidas(t.requiredAction).every((a) => roleCan('cliente', a)),
        t.name,
      ).toBe(false);
    }
  });

  it('el cliente no tiene ninguna capacidad interna: solo las de la proyección TCL', () => {
    expect([...actionsFor('cliente')].sort()).toEqual([...CAPACIDADES_DE_TCL].sort());
  });

  it('ninguna tool reutiliza la proyección TCL (ni sus funciones, ni sus nombres)', () => {
    for (const t of CATALOGO_V1) {
      expect(t.reuses.join(' '), t.name).not.toMatch(/ParaTcl|TclDeCampana|tcl-projection/u);
      expect(`${t.name} ${t.description}`, t.name).not.toMatch(/_tcl_|export_client/u);
    }
  });
});
