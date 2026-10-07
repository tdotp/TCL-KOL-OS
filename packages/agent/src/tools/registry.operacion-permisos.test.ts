/**
 * Permisos de las tools de operación y KPIs (V2 · Fase 8): heredan los del caso de uso y el registro exige además
 * `chat:write`. Sin la capacidad, la tool NO se ofrece y, si se invoca igual, NO se ejecuta (sin efecto).
 *
 * Ningún rol con acceso al chat (admin, director, consultor) carece de `operations:read`, `kpi:read` o
 * `kpi:target_manage`; para probar la revocación de UNA capacidad se niega `roleCan` para esa acción (el registro y el
 * executor la consultan en cada oferta y en cada llamada).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as DomainModule from '@tcl-kol-os/domain';
import { closePool, query } from '@tcl-kol-os/db';
import { crearEscenarioDeOperacion, eliminarCampanaDePrueba } from '@tcl-kol-os/db/test-utils';
import type { EscenarioDeOperacion } from '@tcl-kol-os/db/test-utils';
import { roleCan } from '@tcl-kol-os/domain';
import { abrirTurno, json, llamar, registro } from './test-support.ts';

const negadas = vi.hoisted(() => new Set<string>());
vi.mock('@tcl-kol-os/domain', async (importOriginal) => {
  const real = await importOriginal<typeof DomainModule>();
  return {
    ...real,
    roleCan: (role: DomainModule.Role, action: DomainModule.Action) =>
      !negadas.has(action) && real.roleCan(role, action),
  };
});

const r = registro();
let op: EscenarioDeOperacion;

beforeAll(async () => {
  op = await crearEscenarioDeOperacion('Tools operación · permisos');
}, 60_000);

afterAll(async () => {
  negadas.clear();
  await eliminarCampanaDePrueba(op.campanas);
  await closePool();
});

const ofrecidas = (u = op.consultor): string[] => r.definitionsFor(u).map((d) => d.name);
const codigo = (x: { content: string }): unknown =>
  (json(x as never)['error'] as { code?: string } | undefined)?.code;

/** Capacidad que el rol pierde → las tools que dejan de ofrecerse (y solo esas). */
const POR_CAPACIDAD: readonly [string, readonly string[]][] = [
  ['operations:read', ['operations_summary_list', 'operations_participation_status']],
  ['kpi:read', ['kpi_scoreboard_get', 'kpi_history_get']],
  ['kpi:target_manage', ['sheet_kpi_pactado_get', 'kpi_target_register']],
  [
    'campaign_influencer:read',
    [
      'operations_participation_status',
      'kpi_scoreboard_get',
      'kpi_history_get',
      'sheet_kpi_pactado_get',
      'kpi_target_register',
    ],
  ],
  ['source:read', ['sheet_kpi_pactado_get']],
];

describe('matriz real de roles', () => {
  it('la matriz que el registro lee: con chat y con las capacidades de KPI y operación solo admin, director y consultor', () => {
    for (const rol of ['admin', 'director', 'consultor'] as const) {
      for (const a of ['chat:write', 'operations:read', 'kpi:read', 'kpi:target_manage'] as const) {
        expect(roleCan(rol, a), `${rol} ${a}`).toBe(true);
      }
    }
    // operativo mide y lee, pero no tiene chat: no se le ofrece ninguna tool
    expect(roleCan('operativo', 'operations:read')).toBe(true);
    expect(roleCan('operativo', 'kpi:target_manage')).toBe(false);
    expect(roleCan('operativo', 'chat:write')).toBe(false);
    expect(ofrecidas(op.operativo)).toEqual([]);
    for (const u of [op.analista, op.legal, op.cliente]) expect(ofrecidas(u), u.role).toEqual([]);
  });

  it('director y consultor reciben las 6 tools de operación', () => {
    for (const u of [op.director, op.consultor, op.admin]) {
      const nombres = ofrecidas(u);
      for (const n of [
        'operations_summary_list',
        'operations_participation_status',
        'kpi_scoreboard_get',
        'kpi_history_get',
        'sheet_kpi_pactado_get',
        'kpi_target_register',
      ]) {
        expect(nombres, `${u.role} ${n}`).toContain(n);
      }
    }
  });
});

describe('sin la capacidad la tool no se ofrece ni se ejecuta', () => {
  for (const [capacidad, tools] of POR_CAPACIDAD) {
    it(`sin ${capacidad}: no se ofrecen ${tools.join(', ')} (y las demás de operación siguen ofrecidas)`, async () => {
      // el turno se abre ANTES de negar la capacidad (abrir una conversación también consulta permisos)
      const t = await abrirTurno(op.consultor, op.campanaId, 'Para Diego, 5.000 vistas');
      const p = t.referencias.registrar({
        kind: 'campaign_influencer',
        entityId: op.participaciones.diego,
      }).alias;
      negadas.add(capacidad);
      try {
        const nombres = ofrecidas();
        for (const n of tools) expect(nombres, n).not.toContain(n);
        // la capacidad base y la de otras tools no se tocan
        expect(nombres).toContain('campaign_get');
        // y si el modelo la invoca igual, el executor la rechaza (relee la capacidad en cada llamada)
        const args: Record<string, Record<string, unknown>> = {
          operations_summary_list: {},
          operations_participation_status: { participationId: p },
          kpi_scoreboard_get: { participationId: p },
          kpi_history_get: { participationId: p },
          sheet_kpi_pactado_get: { participationId: p },
          kpi_target_register: {
            participationId: p,
            metric: 'views',
            targetValue: 5_000,
            evidenceQuote: '5.000 vistas',
          },
        };
        for (const n of tools) {
          const x = await llamar(r, t, n, args[n]);
          expect(x.status, n).toBe('failed');
          expect(codigo(x), n).toBe('FORBIDDEN_ROLE');
        }
      } finally {
        negadas.delete(capacidad);
      }
    });
  }

  it('sin kpi:target_manage la tool de registro NO deja ningún objetivo, aunque la cita y el valor sean impecables', async () => {
    const t = await abrirTurno(op.consultor, op.campanaId, 'Para Diego, 5.000 vistas');
    const p = t.referencias.registrar({
      kind: 'campaign_influencer',
      entityId: op.participaciones.diego,
    }).alias;
    negadas.add('kpi:target_manage');
    try {
      const x = await llamar(r, t, 'kpi_target_register', {
        participationId: p,
        metric: 'views',
        targetValue: 5_000,
        evidenceQuote: '5.000 vistas',
      });
      expect(codigo(x)).toBe('FORBIDDEN_ROLE');
      const n = await query<{ n: string }>(
        `SELECT count(*)::text AS n FROM kpi_targets WHERE campaign_influencer_id = $1`,
        [op.participaciones.diego],
      );
      expect(n[0]!.n).toBe('0');
    } finally {
      negadas.delete('kpi:target_manage');
    }
  });

  it('sin chat:write (la capacidad base) no se ofrece NINGUNA tool ni se ejecuta ninguna', async () => {
    const t = await abrirTurno(op.consultor, op.campanaId, 'estado');
    negadas.add('chat:write');
    try {
      expect(ofrecidas()).toEqual([]);
      const x = await llamar(r, t, 'operations_summary_list', {});
      expect(x.status).toBe('failed');
      expect(codigo(x)).toBe('FORBIDDEN_ROLE');
    } finally {
      negadas.delete('chat:write');
    }
  });

  it('al restituir la capacidad, las tools vuelven a ofrecerse (el registro no cachea el rol)', () => {
    expect(negadas.size).toBe(0);
    expect(ofrecidas()).toHaveLength(42);
  });
});
