/**
 * V2 · Fase 5 — reglas puras de matching, producto y diferencias.
 *
 * Todo es determinístico: el nombre NUNCA decide, no hay fuzzy matching, y ante
 * duda (ambigüedad, conflicto, cambio de cuenta o de producto) la decisión es
 * humana, nunca silenciosa.
 */

import { describe, expect, it } from 'vitest';
import {
  accountKey,
  compararRegistros,
  decidirIdentidad,
  decidirProductos,
  type CampaignProductOption,
  type IdentityFacts,
} from './influencer-import';
import type { SheetAccount, SheetRecord } from './influencer-sheet';
import { normalizeProductRef } from './influencer-sheet';

function cuenta(platform: SheetAccount['platform'], handle: string, row = 3): SheetAccount {
  return { platform, handle, normalizedHandle: handle.toLowerCase(), row };
}

function registro(parcial: Partial<SheetRecord> = {}): SheetRecord {
  return {
    sourceKey: 'INF-001',
    displayName: 'Valentina Rojas',
    accounts: [cuenta('instagram', 'valentina.rojas')],
    products: [],
    futureValues: [],
    rows: [3],
    locators: [],
    problems: [],
    fingerprint: { name: '', accounts: '', products: '', future: '' },
    ...parcial,
  };
}

function hechos(parcial: Partial<IdentityFacts> & { duenos?: Record<string, string> } = {}): IdentityFacts {
  return {
    binding: undefined,
    accountOwners: new Map(Object.entries(parcial.duenos ?? {})),
    boundToOtherKey: new Map(),
    accountsByInfluencer: new Map(),
    participations: new Map(),
    displayNames: new Map(),
    ...parcial,
  };
}

describe('identidad', () => {
  it('sin cuenta conocida → crear (la persona es nueva)', () => {
    const d = decidirIdentidad(registro(), hechos());
    expect(d).toMatchObject({ outcome: 'create_new', participation: 'associate' });
    expect(d.influencerId).toBeUndefined();
  });

  it('coincidencia exacta de cuenta → ese Influencer', () => {
    const d = decidirIdentidad(registro(), hechos({ duenos: { 'instagram:valentina.rojas': 'inf-A' } }));
    expect(d).toMatchObject({
      outcome: 'matched_existing',
      influencerId: 'inf-A',
      participation: 'associate',
    });
  });

  it('el nombre NUNCA es un criterio: mismo nombre sin cuenta común → crear', () => {
    const d = decidirIdentidad(registro(), hechos({ displayNames: new Map([['inf-A', 'Valentina Rojas']]) }));
    expect(d.outcome).toBe('create_new');
    expect(d.influencerId).toBeUndefined();
  });

  it('el nombre parecido (casi igual) tampoco cuenta', () => {
    const d = decidirIdentidad(
      registro({ displayName: 'Valentina Rojas' }),
      hechos({
        displayNames: new Map([
          ['inf-A', 'Valentina Roja'],
          ['inf-B', 'valentina rojas '],
        ]),
      }),
    );
    expect(d.outcome).toBe('create_new');
  });

  it('el binding previo gana sobre el matching por cuenta', () => {
    const d = decidirIdentidad(
      registro(),
      hechos({
        binding: { influencerId: 'inf-X', campaignInfluencerId: 'ci-X' },
        duenos: { 'instagram:valentina.rojas': 'inf-X' },
        participations: new Map([['inf-X', { id: 'ci-X', status: 'activo' as const }]]),
      }),
    );
    expect(d).toMatchObject({
      outcome: 'matched_binding',
      influencerId: 'inf-X',
      campaignInfluencerId: 'ci-X',
      participation: 'exists',
    });
  });

  it('con binding, un cambio de nombre se INFORMA pero no cambia la identidad ni crea otra persona', () => {
    const d = decidirIdentidad(
      registro({ displayName: 'Valentina R. de Pérez' }),
      hechos({
        binding: { influencerId: 'inf-X', campaignInfluencerId: 'ci-X' },
        duenos: { 'instagram:valentina.rojas': 'inf-X' },
        displayNames: new Map([['inf-X', 'Valentina Rojas']]),
        participations: new Map([['inf-X', { id: 'ci-X', status: 'activo' as const }]]),
      }),
    );
    expect(d.outcome).toBe('matched_binding');
    expect(d.nameDiffers).toEqual({ sheet: 'Valentina R. de Pérez', existing: 'Valentina Rojas' });
  });

  it('con binding, si el handle ahora es de OTRA persona → conflicto (no muta)', () => {
    const d = decidirIdentidad(
      registro(),
      hechos({
        binding: { influencerId: 'inf-X', campaignInfluencerId: 'ci-X' },
        duenos: { 'instagram:valentina.rojas': 'inf-OTRO' },
      }),
    );
    expect(d).toMatchObject({ outcome: 'conflict', reasons: ['account_owned_by_other_influencer'] });
    expect(d.candidates).toEqual(['inf-X', 'inf-OTRO']);
  });

  it('con binding, cambio de handle en una plataforma ya ocupada → decisión humana', () => {
    const d = decidirIdentidad(
      registro({ accounts: [cuenta('instagram', 'valentina.nueva')] }),
      hechos({
        binding: { influencerId: 'inf-X', campaignInfluencerId: 'ci-X' },
        accountsByInfluencer: new Map([
          ['inf-X', new Map([['instagram' as const, new Set(['valentina.rojas'])]])],
        ]),
        participations: new Map([['inf-X', { id: 'ci-X', status: 'activo' as const }]]),
      }),
    );
    expect(d).toMatchObject({ outcome: 'needs_resolution', reasons: ['account_change'] });
    expect(d.accountChanges.map((c) => c.handle)).toEqual(['valentina.nueva']);
    expect(d.additiveAccounts).toEqual([]);
  });

  it('con binding, una cuenta nueva en OTRA plataforma es un alta aditiva', () => {
    const d = decidirIdentidad(
      registro({ accounts: [cuenta('instagram', 'valentina.rojas'), cuenta('tiktok', 'valerojas', 4)] }),
      hechos({
        binding: { influencerId: 'inf-X', campaignInfluencerId: 'ci-X' },
        duenos: { 'instagram:valentina.rojas': 'inf-X' },
        accountsByInfluencer: new Map([
          ['inf-X', new Map([['instagram' as const, new Set(['valentina.rojas'])]])],
        ]),
        participations: new Map([['inf-X', { id: 'ci-X', status: 'activo' as const }]]),
      }),
    );
    expect(d.outcome).toBe('matched_binding');
    expect(d.additiveAccounts.map((c) => c.platform)).toEqual(['tiktok']);
  });

  it('las cuentas de un mismo registro apuntan a personas distintas → ambiguo', () => {
    const d = decidirIdentidad(
      registro({ accounts: [cuenta('instagram', 'a'), cuenta('tiktok', 'b', 4)] }),
      hechos({ duenos: { 'instagram:a': 'inf-A', 'tiktok:b': 'inf-B' } }),
    );
    expect(d).toMatchObject({ outcome: 'ambiguous', candidates: ['inf-A', 'inf-B'] });
    expect(d.influencerId).toBeUndefined();
  });

  it('la persona ya está vinculada a OTRA clave de esta fuente → conflicto', () => {
    const d = decidirIdentidad(
      registro({ sourceKey: 'INF-002' }),
      hechos({
        duenos: { 'instagram:valentina.rojas': 'inf-A' },
        boundToOtherKey: new Map([['inf-A', 'INF-001']]),
      }),
    );
    expect(d).toMatchObject({ outcome: 'conflict', reasons: ['influencer_bound_to_other_key'] });
  });

  it('una participación RETIRADA no se reactiva sola', () => {
    const d = decidirIdentidad(
      registro(),
      hechos({
        duenos: { 'instagram:valentina.rojas': 'inf-A' },
        participations: new Map([['inf-A', { id: 'ci-A', status: 'retirado' as const }]]),
      }),
    );
    expect(d).toMatchObject({
      outcome: 'needs_resolution',
      participation: 'retired',
      reasons: ['participation_retired'],
    });
  });

  it('la misma persona de otra campaña se reutiliza y recibe participación NUEVA en esta', () => {
    const d = decidirIdentidad(registro(), hechos({ duenos: { 'instagram:valentina.rojas': 'inf-A' } }));
    expect(d).toMatchObject({ outcome: 'matched_existing', participation: 'associate' });
  });

  it('un registro inválido nunca se materializa', () => {
    const d = decidirIdentidad(
      registro({ problems: [{ code: 'ROW_HANDLE_INVALID', message: 'x' }] }),
      hechos({ duenos: { 'instagram:valentina.rojas': 'inf-A' } }),
    );
    expect(d).toMatchObject({ outcome: 'invalid', reasons: ['record_invalid'] });
    expect(d.influencerId).toBeUndefined();
  });

  it('es determinística', () => {
    const f = hechos({ duenos: { 'instagram:valentina.rojas': 'inf-A' } });
    expect(decidirIdentidad(registro(), f)).toEqual(decidirIdentidad(registro(), f));
  });

  it('accountKey compone plataforma y handle normalizado', () => {
    expect(accountKey('tiktok', 'ana')).toBe('tiktok:ana');
  });
});

const OPCIONES: CampaignProductOption[] = [
  { campaignProductId: 'cp-p80', brand: 'TCL', model: 'P80' },
  { campaignProductId: 'cp-pro', brand: 'TCL', model: 'P80 Pro' },
  { campaignProductId: 'cp-dup1', brand: 'TCL', model: 'S64' },
  { campaignProductId: 'cp-dup2', brand: 'Otra', model: 's64' },
];

function conProductos(...refs: string[]): SheetRecord {
  return registro({
    products: refs.map((ref, i) => ({ ref, normalizedRef: normalizeProductRef(ref), row: 3 + i })),
  });
}

describe('producto', () => {
  const decidir = (refs: string[], asignados: string[] = []) =>
    decidirProductos(conProductos(...refs), OPCIONES, new Set(asignados)).map((d) => [
      d.ref,
      d.outcome,
      d.campaignProductId,
    ]);

  it('exactamente uno → asignable', () => {
    expect(decidir(['p80'])).toEqual([['p80', 'assign', 'cp-p80']]);
    expect(decidir(['P80 PRO'])).toEqual([['P80 PRO', 'assign', 'cp-pro']]);
  });

  it('no hay similitud: P80 no es P80 Pro, ni «p8» es P80', () => {
    expect(decidir(['p8'])).toEqual([['p8', 'unresolved', undefined]]);
    expect(decidir(['Pro'])).toEqual([['Pro', 'unresolved', undefined]]);
  });

  it('ninguno → necesita resolución; varios → ambiguo', () => {
    expect(decidir(['X999'])[0]![1]).toBe('unresolved');
    expect(decidir(['S64'])[0]![1]).toBe('ambiguous');
    expect(decidirProductos(conProductos('S64'), OPCIONES, new Set())[0]!.candidates).toEqual([
      'cp-dup1',
      'cp-dup2',
    ]);
  });

  it('un producto de otra campaña no está entre las opciones → sin resolver', () => {
    expect(decidir(['C7L'])).toEqual([['C7L', 'unresolved', undefined]]);
  });

  it('ya asignado → sin cambio (no se duplica)', () => {
    expect(decidir(['P80'], ['cp-p80'])).toEqual([['P80', 'unchanged', 'cp-p80']]);
  });

  it('varias referencias nuevas sobre una persona sin productos → todas asignables', () => {
    expect(decidir(['P80', 'P80 Pro']).map((r) => r[1])).toEqual(['assign', 'assign']);
  });

  it('añadir un producto al conjunto declarado es aditivo', () => {
    expect(decidir(['P80', 'P80 Pro'], ['cp-p80']).map((r) => r[1])).toEqual(['unchanged', 'assign']);
  });

  it('cambiar de producto (el asignado ya no está en el Sheet) NO es un reemplazo automático', () => {
    expect(decidir(['P80 Pro'], ['cp-p80'])).toEqual([['P80 Pro', 'product_change', 'cp-pro']]);
  });

  it('un registro sin producto no genera decisiones', () => {
    expect(decidir([], ['cp-p80'])).toEqual([]);
  });
});

describe('diferencias entre snapshots', () => {
  const r = (
    clave: string,
    nombre: string,
    extra: Partial<Record<'accounts' | 'products' | 'future', string>> = {},
  ) => ({
    sourceKey: clave,
    fingerprint: { name: nombre, accounts: '[]', products: '[]', future: '[]', ...extra },
  });

  it('nuevo, sin cambios, cambiado y desaparecido, por clave (no por fila)', () => {
    const antes = [r('INF-001', 'Ana'), r('INF-002', 'Beto'), r('INF-003', 'Carla')];
    const ahora = [r('INF-003', 'Carla'), r('INF-001', 'Ana María'), r('INF-004', 'Dani')];
    const diff = compararRegistros(antes, ahora);
    const por = (c: string) => diff.find((d) => d.sourceKey === c)!;
    expect(por('INF-003')).toMatchObject({ change: 'unchanged' });
    expect(por('INF-001')).toMatchObject({ change: 'changed', fields: ['name'] });
    expect(por('INF-004')).toMatchObject({ change: 'new' });
    expect(por('INF-002')).toMatchObject({ change: 'missing_from_source' });
  });

  it('distingue qué cambió: cuentas, productos o campos futuros', () => {
    const antes = [r('INF-001', 'Ana', { accounts: 'a1', products: 'p80', future: 'fee100' })];
    const ahora = [r('INF-001', 'Ana', { accounts: 'a2', products: 'x955', future: 'fee200' })];
    expect(compararRegistros(antes, ahora)[0]).toMatchObject({
      change: 'changed',
      fields: ['accounts', 'products', 'future'],
    });
  });

  it('reordenar filas no es un cambio', () => {
    const a = [r('INF-001', 'Ana'), r('INF-002', 'Beto')];
    const b = [r('INF-002', 'Beto'), r('INF-001', 'Ana')];
    expect(compararRegistros(a, b).every((d) => d.change === 'unchanged')).toBe(true);
  });

  it('sin snapshot anterior, todo es nuevo', () => {
    expect(compararRegistros([], [r('INF-001', 'Ana')]).map((d) => d.change)).toEqual(['new']);
  });
});
