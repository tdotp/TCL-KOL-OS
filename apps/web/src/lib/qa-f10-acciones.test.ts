/**
 * QA adversarial F10 (independiente) — ATAQUES 6, 7, 14 y 18 a nivel de SERVER ACTIONS, con base de datos real.
 *
 * Se mockea SOLO el borde de Next (`session`, `next/cache`, `next/navigation`, `next/headers`); los casos de uso y la
 * base son los reales. Cada acción exportada se invoca con la sesión de un rol que NO debe poder usarla y se verifica:
 *   · el resultado no es éxito (o la acción redirige / lanza antes de escribir);
 *   · la huella de TODAS las tablas de la campaña sembrada no cambia;
 *   · el resultado no contiene centinelas internos.
 *
 * Solo corre con una base de pruebas (`TEST_DATABASE_URL` terminada en `_test`): las pruebas de `apps/web` no tienen
 * candado propio y esta NO debe tocar nunca la base de desarrollo.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@tcl-kol-os/domain';
import type * as ModuloSoporte from '../../../../packages/db/src/qa-f10-soporte.ts';
import type * as ModuloUtiles from '../../../../packages/db/src/test-utils.ts';

const URL_DE_PRUEBA = process.env['TEST_DATABASE_URL'] ?? '';
const HAY_BASE = /\/[A-Za-z0-9_-]*_test$/u.test(URL_DE_PRUEBA);
if (HAY_BASE) {
  process.env['DATABASE_URL'] = URL_DE_PRUEBA;
  // Claves de PII SOLO DE PRUEBA (la base es `_test`): las pruebas de `packages/db` las fijan igual.
  process.env['PII_ENCRYPTION_KEYS'] ||= `prueba-1:${Buffer.alloc(32, 0x11).toString('base64')}`;
  process.env['PII_INDEX_KEY'] ||= Buffer.alloc(32, 0x22).toString('base64');
}

const mocks = vi.hoisted(() => ({ currentUser: vi.fn() }));
vi.mock('./session.ts', () => ({
  currentUser: mocks.currentUser,
  authProvider: () => 'oidc',
  buildSessionValue: () => 'x',
  SESSION_COOKIE: 'c',
  SESSION_MAX_AGE: 1,
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({ set: vi.fn(), delete: vi.fn(), get: () => undefined }),
  headers: async () => new Headers(),
}));
vi.mock('./chat-server.ts', () => ({
  dispararRunEnSegundoPlano: vi.fn(),
  estadoDelAsistente: vi.fn(() => ({ disponible: false })),
  obtenerOCrearConversacion: vi.fn(),
  limiteDeAdjuntoBytes: () => 1024,
}));

const d = HAY_BASE ? describe : describe.skip;

type Soporte = typeof ModuloSoporte;
type Utiles = typeof ModuloUtiles;
let soporte: Soporte;
let utiles: Utiles;
let op: Awaited<ReturnType<Utiles['crearEscenarioDeOperacion']>>;
let s: Awaited<ReturnType<Soporte['sembrarSmartPR']>>;
let huellaDeVersion = '';
let huellaInicial = '';

beforeAll(async () => {
  if (!HAY_BASE) return;
  soporte = await import('../../../../packages/db/src/qa-f10-soporte.ts');
  utiles = await import('../../../../packages/db/src/test-utils.ts');
  op = await utiles.crearEscenarioDeOperacion('QA F10 acciones', { conAcuerdoAjeno: true });
  s = await soporte.sembrarSmartPR(op);
  const apoyo = await import('../../../../packages/db/src/script-approval-test-support.ts');
  huellaDeVersion = await apoyo.huellaDe(s.guionPropuestoId);
  huellaInicial = await soporte.huellaDeCampana(op.campanaId, op.admin.organizationId);
}, 240_000);

afterAll(async () => {
  if (!HAY_BASE) return;
  await utiles.limpiarEscenarioDeOperacion(op);
  const { closePool } = await import('@tcl-kol-os/db');
  await closePool();
});

beforeEach(() => {
  mocks.currentUser.mockReset();
});

function sesion(u: User | undefined): void {
  mocks.currentUser.mockResolvedValue(u);
}

function formularioUniversal(): FormData {
  const f = new FormData();
  const ids: Record<string, string> = {
    campaignId: s.campanaId,
    campanaId: s.campanaId,
    id: s.campanaId,
    versionId: s.briefVersionId,
    sourceId: s.fuenteId,
    fieldId: s.briefFieldId,
    commentId: s.comentarioId,
    participacionId: s.participacionId,
    campaignInfluencerId: s.participacionId,
    influencerId: s.influencerId,
    shipmentId: s.envioId,
    paymentObligationId: s.obligacionId,
    agreementId: s.acuerdoId,
    measurementId: s.medicionKpiId,
    targetId: s.objetivoKpiId,
    deliverableId: s.entregableId,
    piiRecordId: s.piiRecordId,
    actionId: s.accionId,
    scriptVersionId: s.guionPropuestoId,
    expectedSeq: '1',
    idempotencyKey: 'qa-f10-universal-key-0001',
    to: 'approved',
    name: 'QA F10',
    email: 'gerardo@smartpr.co',
    value: 'qa',
    motivo: 'qa f10',
    key: 'mensaje_principal.one_line',
    fieldKey: 'mensaje_principal.one_line',
    revision: '1',
    market: 'CO',
    productos: s.ids['producto']!,
    tipo: 'brief',
    huellaVista: huellaDeVersion,
    paidOn: '2026-10-01',
    externalReference: 'REF-QA',
    metric: 'views',
    targetValue: '10',
    phone: '3000000000',
    address: 'calle qa',
    documentId: '1000000001',
  };
  for (const [k, v] of Object.entries(ids)) f.append(k, v);
  return f;
}

async function llamarComoPudiera(
  fn: (...a: never[]) => unknown,
): Promise<Array<{ resultado: unknown; lanzo: string | undefined }>> {
  const f = (): FormData => formularioUniversal();
  const combos: unknown[][] = [
    [f()],
    [undefined, f()],
    [{}, f()],
    [s.campanaId, s.guionPropuestoId, huellaDeVersion],
    [s.campanaId, s.accionId, huellaDeVersion],
    [s.campanaId, s.guionPropuestoId, 'texto qa f10', 'nota'],
    [s.campanaId, s.participacionId, 'etiqueta qa f10', 'instagram'],
    [s.campanaId, s.guionPropuestoId],
    [s.campanaId, 'qa f10 mensaje', 'qa-f10-clave-idem-0001', []],
    [s.campanaId],
  ];
  const salida: Array<{ resultado: unknown; lanzo: string | undefined }> = [];
  for (const args of combos) {
    try {
      const r = await Promise.race([
        Promise.resolve((fn as (...a: unknown[]) => unknown)(...args)),
        new Promise((res) => setTimeout(() => res('TIMEOUT'), 5000)),
      ]);
      salida.push({ resultado: r, lanzo: undefined });
    } catch (e) {
      salida.push({ resultado: undefined, lanzo: e instanceof Error ? e.message : String(e) });
    }
  }
  return salida;
}

function esExito(r: unknown): boolean {
  if (typeof r !== 'object' || r === null) return false;
  const o = r as { ok?: unknown; error?: unknown };
  return o.ok === true;
}

async function barrer(
  modulos: ReadonlyArray<Record<string, unknown>>,
  excluir: ReadonlySet<string>,
  quien: string,
): Promise<{ exitos: string[]; fugas: string[]; llamadas: number }> {
  const exitos: string[] = [];
  const fugas: string[] = [];
  let llamadas = 0;
  for (const m of modulos) {
    for (const [nombre, fn] of Object.entries(m)) {
      if (typeof fn !== 'function' || excluir.has(nombre)) continue;
      for (const { resultado } of await llamarComoPudiera(fn as never)) {
        llamadas += 1;
        if (esExito(resultado)) exitos.push(`${quien}:${nombre}`);
        const t = JSON.stringify(resultado ?? null);
        for (const c of soporte.CENTINELAS_INTERNOS) if (t.includes(c)) fugas.push(`${nombre} → ${c}`);
      }
    }
  }
  return { exitos, fugas, llamadas };
}

async function cargarAcciones(): Promise<Array<Record<string, unknown>>> {
  return [
    (await import('./actions.ts')) as Record<string, unknown>,
    (await import('./operacion-actions.ts')) as Record<string, unknown>,
    (await import('./contenido-actions.ts')) as Record<string, unknown>,
    (await import('./chat-actions.ts')) as Record<string, unknown>,
  ];
}

d('QA F10 · (5)(18) server actions con sesión de CLIENTE TCL: ninguna ejecuta', () => {
  it('toda action exportada (campañas, brief, fuentes, operación, contenido, chat) falla y no escribe', async () => {
    sesion(op.cliente);
    const { exitos, fugas, llamadas } = await barrer(
      await cargarAcciones(),
      new Set(['iniciarSesion', 'cerrarSesion']),
      'cliente',
    );
    expect(llamadas).toBeGreaterThan(200);
    expect(exitos, 'actions que devolvieron ok:true con sesión de cliente TCL').toEqual([]);
    expect(fugas).toEqual([]);
    expect(await soporte.huellaDeCampana(op.campanaId, op.admin.organizationId)).toBe(huellaInicial);
  }, 300_000);

  it('sin sesión: ninguna action escribe', async () => {
    sesion(undefined);
    const { exitos } = await barrer(
      await cargarAcciones(),
      new Set(['iniciarSesion', 'cerrarSesion']),
      'anónimo',
    );
    expect(exitos).toEqual([]);
    expect(await soporte.huellaDeCampana(op.campanaId, op.admin.organizationId)).toBe(huellaInicial);
  }, 300_000);

  it('sesión de OTRA agencia (admin): ninguna action escribe en la campaña de SmartPR', async () => {
    sesion(op.ajeno);
    const { exitos, fugas } = await barrer(
      await cargarAcciones(),
      new Set(['iniciarSesion', 'cerrarSesion', 'crearCampana', 'enviarMensajeDeChat']),
      'ajeno',
    );
    expect(exitos, 'ok:true de una acción de otra organización sobre ids de SmartPR').toEqual([]);
    expect(fugas).toEqual([]);
    expect(await soporte.huellaDeCampana(op.campanaId, op.admin.organizationId)).toBe(huellaInicial);
  }, 300_000);
});

d(
  'QA F10 · (6)(7) el Operativo y el consultor NO aprueban ni revisan contenido, ni confirman lo que propone la IA',
  () => {
    const sinAprobar = async (u: User, etiqueta: string): Promise<void> => {
      sesion(u);
      const contenido = await import('./contenido-actions.ts');
      const chat = await import('./chat-actions.ts');
      const acciones = await import('./actions.ts');
      const resultados = [
        await contenido.aprobarVersionDeGuion(s.campanaId, s.guionPropuestoId, huellaDeVersion),
        await chat.confirmarAccionPropuestaDeChat(s.campanaId, s.accionId, 'a'.repeat(64)),
      ];
      for (const r of resultados) expect(esExito(r), `${etiqueta}: acción ejecutada`).toBe(false);
      // Brief: aprobar o pedir revisión vía formulario.
      for (const to of ['approved', 'internal_review']) {
        const f = formularioUniversal();
        f.set('to', to);
        f.set('versionId', s.briefVersionId);
        await acciones.transicionarBriefDeCampana(f).catch(() => undefined);
      }
      expect(await soporte.huellaDeCampana(op.campanaId, op.admin.organizationId), etiqueta).toBe(
        huellaInicial,
      );
    };

    it('operativo: no aprueba guion, no confirma la propuesta de la IA, no aprueba ni transiciona el Brief', async () => {
      await sinAprobar(op.operativo, 'operativo');
      const contenido = await import('./contenido-actions.ts');
      sesion(op.operativo);
      for (const r of [
        await contenido.registrarRevisionHumanaDeContenido(s.campanaId, s.guionPropuestoId, huellaDeVersion),
        await contenido.anadirComentarioDeContenido(
          s.campanaId,
          s.guionBorradorId,
          'comentario del operativo',
        ),
        await contenido.solicitarCambiosDeContenido(s.campanaId, s.guionBorradorId, 'cambio uno\ncambio dos'),
        await contenido.solicitarAnalisisDeContenido(
          s.campanaId,
          s.guionBorradorId,
          'reanalyze',
          'qa-f10-clave-analisis-1',
        ),
      ]) {
        expect(esExito(r), 'el Operativo ejecutó una acción de revisión de contenido').toBe(false);
      }
      expect(await soporte.huellaDeCampana(op.campanaId, op.admin.organizationId)).toBe(huellaInicial);
    });

    it('analista y legal (lectura): ninguna aprobación ni revisión', async () => {
      await sinAprobar(op.analista, 'analista');
      await sinAprobar(op.legal, 'legal');
    });

    it('consultor: prepara y propone pero NO aprueba el guion ni aprueba el Brief', async () => {
      await sinAprobar(op.consultor, 'consultor');
    });
  },
);

d(
  'QA F10 · CONTROL: con los MISMOS argumentos, quien sí tiene el permiso lo logra (las negativas no son vacías)',
  () => {
    it('el director aprueba el guion con la huella vista y el chat solo propuso (la IA no había confirmado nada)', async () => {
      const { query } = await import('@tcl-kol-os/db');
      const [antes] = await query<{ status: string; confirmed_by: string | null }>(
        `SELECT status, confirmed_by FROM proposed_actions WHERE id = $1`,
        [s.accionId],
      );
      expect(antes).toEqual({ status: 'pending', confirmed_by: null });
      sesion(op.director);
      const contenido = await import('./contenido-actions.ts');
      const r = await contenido.aprobarVersionDeGuion(s.campanaId, s.guionPropuestoId, huellaDeVersion);
      expect(esExito(r), JSON.stringify(r)).toBe(true);
    });
  },
);
