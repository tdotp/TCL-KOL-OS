/**
 * QA adversarial F10 (independiente) — ATAQUES 7, 8, 9, 10, 14, 19 y 20 contra el AGENTE (registro de tools real, BD real).
 *
 *  (20) Toda tool delega en un caso de uso clasificado; ningún archivo de `tools/` toca SQL; el cliente TCL no ve ni ejecuta
 *       ninguna tool; ids crudos de otra campaña / otra organización responden como inexistentes.
 *  (8)(9) Barrido de TODAS las tools con argumentos generados desde su esquema, como cada rol de la agencia: ni el modelo
 *       (`content`) ni lo guardado (`agent_tool_invocations`) contienen dinero, PII, evidencia operativa, fuentes sensibles ni
 *       texto de otra campaña/organización.
 *  (7)(14) Ninguna tool deja una acción confirmada/ejecutada, aprueba, reporta un pago o cambia la visibilidad de una fuente.
 *  (10) La CITA de evidencia del Brief con texto histórico del Sheet no llega al modelo (proyecciones de `brief_get_workspace`,
 *       `finding_list`, contexto ensamblado).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closePool,
  ensamblarContexto,
  query,
  solicitarAnalisisDeGuion,
  registerLinkedSource,
} from '@tcl-kol-os/db';
import {
  crearBriefAprobadoDePrueba,
  crearFuenteDePrueba,
  crearFragmentoDePrueba,
} from '@tcl-kol-os/db/test-utils';
import { type User, roleCan } from '@tcl-kol-os/domain';
import { CATALOGO_V1 } from '../tools/catalog/index.ts';
import { MANIFIESTO_DE_DB, clasificacionDe, esImportablePorElAgente } from '../tools/manifest.ts';
import type { AnyToolDefinition } from '../tools/types.ts';
import { abrirTurno, llamar, registro } from '../tools/test-support.ts';
import { construirMensajesIniciales } from '../prompts/agente-cuenta.ts';
import { clienteQueResponde, entornoDeAnalisis } from './testing/contenido.ts';
import {
  CENTINELAS,
  type MundoDeOperacion,
  crearMundoDeOperacion,
  crearSheetConKpi,
  limpiarMundoDeOperacion,
  SENTINELA_CANJE_DEL_SHEET,
  SENTINELA_FEE_DEL_SHEET,
} from './testing/operacion.ts';

const AQUI = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(AQUI, '..');
const r = registro();

const FEE_HIST = 'FEE-HIST-QAF10-AGENTE-7712345';
const OTRA_CAMPANA = 'QAF10-OTRA-CAMPANA-SECRETA';
const AJENA = 'QAF10-AJENA-SECRETA';
const SENSIBLE = 'QAF10-SENSIBLE-FRAGMENTO-SECRETO';
const PROHIBIDOS: readonly string[] = [
  ...CENTINELAS,
  FEE_HIST,
  OTRA_CAMPANA,
  AJENA,
  SENSIBLE,
  SENTINELA_FEE_DEL_SHEET,
  SENTINELA_CANJE_DEL_SHEET,
];

let m: MundoDeOperacion;
let guionId = '';
const ids: Record<string, string> = {};

beforeAll(async () => {
  m = await crearMundoDeOperacion('QA F10 agente');
  const op = m.op;
  const sheet = await crearSheetConKpi(op.admin, op.campanaId, m.rios, 'Alcanzar 50.000 vistas');
  const [frag] = await query<{ id: string }>(
    `INSERT INTO source_fragments (source_id, snapshot_id, ordinal, section, text, locator)
     VALUES ($1, $2, 9, 'Influencers', $3,
             '{"kind":"range","sheet":"Influencers","range":"A1:J3","rowStart":1,"rowEnd":3,"colStart":1,"colEnd":10}'::jsonb)
     RETURNING id`,
    [sheet.sourceId, sheet.snapshotId, `fee: ${FEE_HIST}`],
  );
  const brief = await crearBriefAprobadoDePrueba(op.campanaId, op.admin, {
    estado: 'draft',
    productos: [op.productos.p80, op.productos.pro],
    noEncontrados: ['objetivo.comportamiento_esperado'],
  });
  await query(
    `INSERT INTO evidence (brief_field_id, source_id, fragment_id, quote, relation) VALUES ($1, $2, $3, $4, 'soporta')`,
    [brief.campos['accion_kpis.accion_esperada']!, sheet.sourceId, frag!.id, `fee: ${FEE_HIST}`],
  );
  await query(`UPDATE brief_versions SET status = 'approved', approved_at = now() WHERE id = $1`, [
    brief.versionId,
  ]);
  const { registrarVersionDePrueba } = await import('./testing/contenido.ts');
  const reg = await registrarVersionDePrueba(
    op,
    op.entregables.reelRios,
    op.participaciones.valentinaRios,
    op.consultor,
  );
  guionId = reg.versionId;
  const a = await solicitarAnalisisDeGuion(
    op.consultor,
    guionId,
    { mode: 'reanalyze', idempotencyKey: `qa-f10-agente-${Date.now()}` },
    undefined,
    {
      cliente: clienteQueResponde([{ category: 'cta_missing', refs: ['accion_kpis.accion_esperada'] }]),
      env: entornoDeAnalisis(true),
      esperar: async () => {},
    } as never,
  );
  if (!a.ok) throw new Error(`análisis: ${a.error.code}`);

  // Fuentes hostiles de la MISMA campaña: sensible (con fragmento), y de OTRA campaña / OTRA organización.
  const sensible = await crearFuenteDePrueba(op.campanaId, op.admin, 'qaf10-sensible');
  await crearFragmentoDePrueba(sensible, 1, SENSIBLE);
  await query(`UPDATE source_documents SET confidentiality_level = 'sensible' WHERE id = $1`, [sensible]);
  const otra = await crearFuenteDePrueba(op.otraCampanaId, op.admin, 'qaf10-otra');
  await crearFragmentoDePrueba(otra, 1, OTRA_CAMPANA);
  const ajena = await crearFuenteDePrueba(op.campanaAjenaId, op.ajeno, 'qaf10-ajena');
  await crearFragmentoDePrueba(ajena, 1, AJENA);
  const [pOtra] = await query<{ id: string }>(
    `SELECT id FROM campaign_influencers WHERE campaign_id = $1 LIMIT 1`,
    [op.campanaAjenaId],
  );
  Object.assign(ids, {
    sensible,
    otra,
    ajena,
    sheet: sheet.sourceId,
    participacionAjena: pOtra?.id ?? op.ajena.participacion,
    campanaAjena: op.campanaAjenaId,
    otraCampana: op.otraCampanaId,
    rios: m.rios,
    gomez: m.gomez,
    diego: m.diego,
    entregable: op.entregables.reelRios,
    guion: guionId,
  });
  void registerLinkedSource;
}, 300_000);

afterAll(async () => {
  await limpiarMundoDeOperacion(m);
  await closePool();
});

function archivos(dir: string, patron: RegExp): string[] {
  const salida: string[] = [];
  for (const nombre of readdirSync(dir)) {
    const ruta = join(dir, nombre);
    if (statSync(ruta).isDirectory()) salida.push(...archivos(ruta, patron));
    else if (patron.test(nombre) && !/\.test\.tsx?$/u.test(nombre)) salida.push(ruta);
  }
  return salida;
}

// ─────────────────────────── (20) las tools delegan en casos de uso clasificados ─

describe('QA F10 · (20) ninguna tool evade los casos de uso', () => {
  const archivosDeTools = archivos(join(SRC, 'tools'), /\.ts$/u).filter(
    (f) => !f.endsWith('manifest.ts') && !f.endsWith('test-support.ts'),
  );

  it('ningún archivo de tools/ contiene SQL, getPool, query( ni importa pg', () => {
    expect(archivosDeTools.length).toBeGreaterThan(15);
    for (const f of archivosDeTools) {
      const t = readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//gu, '')
        .replace(/\/\/.*$/gmu, '');
      const rel = relative(SRC, f);
      expect(t, `${rel}: query(`).not.toMatch(/(^|[^\w.])query\s*[<(]/u);
      expect(t, `${rel}: getPool`).not.toMatch(/getPool|\.query\s*\(|\btransaction\s*\(/u);
      expect(t, `${rel}: SQL`).not.toMatch(
        /\b(SELECT\s+[\w*,\s.]+\s+FROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/u,
      );
      expect(t, `${rel}: pg`).not.toMatch(/from\s+['"]pg['"]/u);
    }
  });

  it('solo use-cases.ts importa de @tcl-kol-os/db y solo funciones importables según el manifiesto', () => {
    const importan = archivos(SRC, /\.ts$/u).filter(
      (f) =>
        !/\/(testing|qa)\/|test-support\.ts$/u.test(f) &&
        /from\s+['"]@tcl-kol-os\/db(\/[\w-]+)?['"]/u.test(readFileSync(f, 'utf8')),
    );
    const permitidos = new Set(['tools/use-cases.ts', 'runtime/db-ports.ts']);
    for (const f of importan) {
      const rel = relative(SRC, f);
      const t = readFileSync(f, 'utf8');
      expect(permitidos.has(rel) || /^(runtime|model)\//u.test(rel), `${rel} importa de db`).toBe(true);
      expect(t, `${rel}: test-utils en producción`).not.toMatch(/@tcl-kol-os\/db\/test-utils/u);
    }
    const uc = readFileSync(join(SRC, 'tools/use-cases.ts'), 'utf8');
    const nombres = [...uc.matchAll(/(?:^|\n)\s+(?:type\s+)?([A-Za-z_][\w]*),?(?=\s*(?:\/\/.*)?\n)/gu)].map(
      (x) => x[1]!,
    );
    const bloque = /import\s*\{([\s\S]*?)\}\s*from\s*'@tcl-kol-os\/db'/u.exec(uc)?.[1] ?? '';
    const importados = bloque
      .split('\n')
      .map((l) =>
        l
          .replace(/\/\/.*$/u, '')
          .trim()
          .replace(/,$/u, ''),
      )
      .filter((l) => /^[A-Za-z_]\w*$/u.test(l));
    expect(importados.length).toBeGreaterThan(30);
    for (const n of importados)
      expect(esImportablePorElAgente(n), `use-cases importa «${n}» (prohibida/ui-only)`).toBe(true);
    void nombres;
  });

  it('cada tool declara `reuses` con funciones clasificadas read/write/proposal/runtime; ninguna reutiliza una prohibida', () => {
    const fallos: string[] = [];
    for (const t of CATALOGO_V1) {
      expect(t.reuses.length, t.name).toBeGreaterThan(0);
      for (const caso of t.reuses) {
        const nombre = caso.split(' ')[0]!;
        const clase = clasificacionDe(nombre);
        if (
          !['read-tool', 'write-tool', 'proposal-tool', 'runtime-only'].includes(clase) &&
          !(nombre in MANIFIESTO_DE_DB)
        ) {
          fallos.push(`${t.name} reutiliza «${nombre}» (${clase})`);
        }
        if (clase === 'prohibited' || clase === 'ui-only')
          fallos.push(`${t.name} reutiliza «${nombre}» (${clase})`);
      }
      // Una tool que escribe o propone nunca es de riesgo `read`, y una `read` nunca reutiliza un write-tool.
      if (t.risk === 'read') {
        for (const caso of t.reuses) {
          const clase = clasificacionDe(caso.split(' ')[0]!);
          if (clase === 'write-tool' || clase === 'proposal-tool')
            fallos.push(`${t.name} (read) reutiliza ${caso} (${clase})`);
        }
      }
    }
    expect(fallos).toEqual([]);
  });

  it('el catálogo no contiene tools de pagos, acuerdos, envíos, facturación, PII, mediciones ni visibilidad', () => {
    const nombres = CATALOGO_V1.map((t) => t.name);
    for (const n of nombres) {
      expect(n, n).not.toMatch(
        /pay|pago|billing|factura|agreement|acuerdo|shipment|envio|pii|measure|medicion|visibility|approve_script|confirm|execute/u,
      );
    }
    // La única «approve» son las PROPUESTAS.
    expect(nombres.filter((n) => /approv/u.test(n)).sort()).toEqual([
      'brief_propose_approval',
      'script_propose_approval',
    ]);
    expect(CATALOGO_V1.filter((t) => /approv/u.test(t.name)).every((t) => t.risk !== 'read')).toBe(true);
  });

  it('cliente TCL: 0 tools ofrecidas y 0 ejecutables; analista/legal no reciben ninguna tool que escriba', async () => {
    for (const u of [m.op.cliente]) expect(r.definitionsFor(u)).toEqual([]);
    const porRol = (u: User): AnyToolDefinition[] =>
      CATALOGO_V1.filter((t) => r.definitionsFor(u).some((d) => d.name === t.name));
    for (const u of [m.op.analista, m.op.legal]) {
      expect(
        porRol(u)
          .filter((t) => t.risk !== 'read')
          .map((t) => t.name),
        u.role,
      ).toEqual([]);
    }
    for (const u of [m.op.admin, m.op.director, m.op.consultor, m.op.operativo, m.op.analista, m.op.legal]) {
      for (const d of r.definitionsFor(u)) {
        const t = CATALOGO_V1.find((x) => x.name === d.name)!;
        const exigidas = typeof t.requiredAction === 'string' ? [t.requiredAction] : t.requiredAction;
        for (const a of exigidas) expect(roleCan(u.role, a), `${u.role} ve ${t.name} sin ${a}`).toBe(true);
      }
    }
  });
});

// ─────────────────────────── generación de argumentos desde el esquema ─────────

type Esquema = {
  type?: string;
  properties?: Record<string, Esquema>;
  required?: string[];
  enum?: unknown[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  items?: Esquema;
  minItems?: number;
  oneOf?: Esquema[];
  anyOf?: Esquema[];
};

function valorPara(nombre: string, e: Esquema, variante: number): unknown {
  if (e.enum !== undefined && e.enum.length > 0) return e.enum[variante % e.enum.length];
  const alt = e.oneOf ?? e.anyOf;
  if (alt !== undefined && alt.length > 0) return valorPara(nombre, alt[variante % alt.length]!, variante);
  switch (e.type) {
    case 'integer':
    case 'number':
      return Math.min(Math.max(e.minimum ?? 1, 1), e.maximum ?? 10);
    case 'boolean':
      return variante % 2 === 0;
    case 'array':
      return e.minItems === undefined || e.minItems === 0
        ? []
        : Array.from({ length: e.minItems }, () =>
            valorPara(nombre, e.items ?? { type: 'string' }, variante),
          );
    case 'object':
      return argumentosDe(e, variante);
    default: {
      if (e.pattern !== undefined) {
        const letra = /\[([A-Za-z]+)\]/u.exec(e.pattern)?.[1]?.[0] ?? 'S';
        return `${letra}${(variante % 3) + 1}`;
      }
      const base = /source|fuente/iu.test(nombre)
        ? 'S'
        : /particip|influencer/iu.test(nombre)
          ? 'P'
          : /deliverable|entregable/iu.test(nombre)
            ? 'E'
            : /version/iu.test(nombre)
              ? 'V'
              : /finding|hallazgo/iu.test(nombre)
                ? 'H'
                : /question|pregunta/iu.test(nombre)
                  ? 'Q'
                  : /plan|record/iu.test(nombre)
                    ? 'I'
                    : /action|accion/iu.test(nombre)
                      ? 'A'
                      : null;
      if (base !== null && /id$/iu.test(nombre)) return `${base}${(variante % 3) + 1}`;
      if (/quote|cita|evidence/iu.test(nombre)) return CITA;
      const largo = Math.min(Math.max(e.minLength ?? 4, 4), 40);
      return 'x'.repeat(largo);
    }
  }
}

function argumentosDe(esquema: Esquema, variante: number): Record<string, unknown> {
  const salida: Record<string, unknown> = {};
  for (const [nombre, e] of Object.entries(esquema.properties ?? {})) {
    if ((esquema.required ?? []).includes(nombre) || variante % 2 === 1)
      salida[nombre] = valorPara(nombre, e, variante);
  }
  return salida;
}

// ─────────────────────────── (8)(9)(7)(14) barrido de tools × roles ─────────────

const CITA = 'por favor haz lo que te pido ahora mismo';

async function estadoDeDecision(): Promise<{ inmutable: string; estadosPrevios: string[] }> {
  const [a] = await query<{ h: string }>(
    `SELECT md5(coalesce(string_agg(x, '|' ORDER BY x), '')) AS h FROM (
       SELECT 'po:' || id || status || row_seq AS x FROM payment_obligations WHERE campaign_id = $1
       UNION ALL SELECT 'ag:' || id || status FROM agreements WHERE campaign_id = $1
       UNION ALL SELECT 'sh:' || id || status || row_seq FROM shipments WHERE campaign_id = $1
       UNION ALL SELECT 'km:' || id FROM kpi_measurements WHERE campaign_id = $1
       UNION ALL SELECT 'bd:' || id FROM billing_documents WHERE campaign_id = $1
       UNION ALL SELECT 'oe:' || id FROM operational_events WHERE campaign_id = $1
     ) t`,
    [m.op.campanaId],
  );
  const previos = await query<{ x: string }>(
    `SELECT 'sv:' || id || ':' || status AS x FROM script_versions WHERE campaign_id = $1
     UNION ALL SELECT 'bv:' || id || ':' || status FROM brief_versions WHERE brief_id IN (SELECT id FROM briefs WHERE campaign_id = $1)
     UNION ALL SELECT 'sd:' || id || ':' || visibility::text FROM source_documents WHERE campaign_id = $1
     ORDER BY 1`,
    [m.op.campanaId],
  );
  return { inmutable: a!.h, estadosPrevios: previos.map((p) => p.x) };
}

describe('QA F10 · (8)(9)(7)(14) barrido de TODAS las tools con argumentos del esquema, por rol', () => {
  const roles = (): Array<[string, User]> => [
    ['admin', m.op.admin],
    ['director', m.op.director],
    ['consultor', m.op.consultor],
    ['operativo', m.op.operativo],
    ['analista', m.op.analista],
    ['legal', m.op.legal],
  ];

  it('control de cobertura: el barrido ejecuta decenas de tools y los centinelas existen en la base', async () => {
    const [n] = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM source_fragments WHERE text LIKE $1 OR text LIKE $2`,
      [`%${SENSIBLE}%`, `%${OTRA_CAMPANA}%`],
    );
    expect(Number(n!.n)).toBe(2);
    expect(CATALOGO_V1.length).toBeGreaterThanOrEqual(40);
  });

  it('ningún resultado al modelo ni lo guardado contiene dinero, PII, evidencia operativa, fuentes sensibles ni otra campaña/organización', async () => {
    const antes = await estadoDeDecision();
    const salidas: string[] = [];
    const estados = new Map<string, Set<string>>();
    const sinChat: string[] = [];
    let ejecuciones = 0;
    for (const [rol, u] of roles()) {
      const probe = await abrirTurno(u, m.op.campanaId, CITA).catch(() => undefined);
      if (probe === undefined) {
        // Un rol sin `chat:write` ni siquiera abre conversación: el agente no existe para él.
        expect(r.definitionsFor(u), `${rol} sin chat pero con tools`).toEqual([]);
        sinChat.push(rol);
        continue;
      }
      const visibles = r.definitionsFor(u).map((d) => d.name);
      for (const tool of CATALOGO_V1.filter((x) => visibles.includes(x.name))) {
        for (const variante of [0, 1, 2]) {
          // Un turno NUEVO por llamada: el presupuesto de lecturas (25) y de efectos no la corta.
          const t = await abrirTurno(u, m.op.campanaId, CITA);
          for (const cebo of ['source_list', 'influencer_list_participants', 'deliverable_list'] as const) {
            salidas.push((await llamar(r, t, cebo, {})).content);
          }
          const args = argumentosDe(tool.inputSchema as unknown as Esquema, variante);
          const x = await llamar(r, t, tool.name, args);
          salidas.push(x.content);
          ejecuciones += 1;
          const g = estados.get(tool.name) ?? new Set<string>();
          g.add(x.status === 'failed' ? `failed:${x.errorCode ?? ''}` : x.status);
          estados.set(tool.name, g);
        }
      }
    }
    expect(sinChat.sort()).toEqual(['analista', 'legal', 'operativo']);
    expect(ejecuciones).toBeGreaterThan(100);
    // Cobertura NO vacía: la mayoría de las lecturas SÍ se ejecutó con éxito (no solo fallos de validación o de presupuesto).
    const lecturasOk = CATALOGO_V1.filter(
      (t) => t.risk === 'read' && [...(estados.get(t.name) ?? [])].some((e) => e === 'succeeded'),
    );
    const lecturas = CATALOGO_V1.filter((t) => t.risk === 'read');
    expect(
      lecturasOk.length / lecturas.length,
      `lecturas con éxito: ${lecturasOk.map((t) => t.name).join(',')}`,
    ).toBeGreaterThan(0.6);
    const todo = salidas.join('\n');
    for (const c of PROHIBIDOS) expect(todo, `el modelo recibió «${c}»`).not.toContain(c);
    // Lo guardado (argumentos y resultado de cada invocación).
    const filas = await query<{ args: unknown; result: unknown }>(
      `SELECT args, result FROM agent_tool_invocations WHERE campaign_id = $1`,
      [m.op.campanaId],
    );
    expect(filas.length).toBeGreaterThan(300);
    const guardado = JSON.stringify(filas);
    for (const c of PROHIBIDOS) expect(guardado, `se guardó «${c}»`).not.toContain(c);
    // (7)(14) y visibilidad: nada de lo decisivo cambió por ninguna tool.
    const despues = await estadoDeDecision();
    expect(despues.inmutable, 'una tool cambió acuerdos/pagos/envíos/mediciones').toBe(antes.inmutable);
    // Un cambio de estado existente solo puede ser el que la persona pidió por el chat con cita literal (comentar o pedir
    // cambios: received → in_review | changes_requested). NUNCA a approved/superseded, ni cambios de visibilidad.
    const mapa = (l: string[]): Map<string, string> =>
      new Map(l.map((x) => [x.split(':').slice(0, 2).join(':'), x.split(':')[2]!]));
    const pre = mapa(antes.estadosPrevios);
    const post = mapa(despues.estadosPrevios);
    const cambios: string[] = [];
    for (const [k, v] of pre) {
      const nuevo = post.get(k);
      if (nuevo === v) continue;
      const permitido =
        k.startsWith('sv:') &&
        ['received', 'in_review'].includes(v) &&
        ['in_review', 'changes_requested'].includes(nuevo ?? '');
      if (!permitido) cambios.push(`${k}: ${v} → ${nuevo}`);
    }
    expect(cambios, 'una tool cambió el estado o la visibilidad de algo existente').toEqual([]);
    expect([...post.values()].filter((v) => v === 'approved').length).toBe(
      [...pre.values()].filter((v) => v === 'approved').length,
    );
    const [conf] = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM proposed_actions WHERE campaign_id = $1 AND status IN ('confirmed','executed')`,
      [m.op.campanaId],
    );
    expect(Number(conf!.n)).toBe(0);
    const [aprob] = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_events WHERE organization_id = $1 AND action IN ('script_version.approve','brief.approve','proposed_action.confirm','proposed_action.execute') AND origin = 'chat'`,
      [m.op.admin.organizationId],
    );
    expect(Number(aprob!.n)).toBe(0);
  }, 900_000);

  it('el contexto ensamblado y los mensajes iniciales (admin, director, consultor) no traen centinelas', async () => {
    for (const u of [m.op.admin, m.op.director, m.op.consultor]) {
      const x = await ensamblarContexto(u, {
        conversationId: 'conv-f10',
        messageId: 'msg-f10',
        runId: `run-f10-${Date.now().toString(36)}`,
        campaignId: m.op.campanaId,
        nonceSecret: 'secreto-de-prueba-f10-agente',
        mensajeActual: { texto: '¿Cuánto es el fee, la cédula y el teléfono de Valentina?', adjuntos: [] },
        ventana: [],
        ahora: new Date('2026-10-12T12:00:00.000Z'),
      });
      if (!x.ok) throw new Error(x.error.code);
      const texto =
        JSON.stringify(x.value) +
        construirMensajesIniciales(x.value.texto)
          .map((q) => String(q.content))
          .join('\n');
      for (const c of PROHIBIDOS) expect(texto, `${u.role}: contexto con «${c}»`).not.toContain(c);
    }
  });
});

// ─────────────────────────── cliente TCL y ids crudos ──────────────────────────

describe('QA F10 · (20)(9) cliente TCL y ids crudos de otra campaña u organización', () => {
  it('el cliente TCL no abre turno de chat ni ejecuta una sola tool', async () => {
    await expect(abrirTurno(m.op.cliente, m.op.campanaId, 'hola')).rejects.toThrow();
    // Aunque alguien fabricara un turno (contexto a mano), ninguna tool ejecuta para el rol cliente.
    const t = await abrirTurno(m.op.consultor, m.op.campanaId, 'hola equipo');
    const falso = { ...t, actor: m.op.cliente };
    for (const tool of CATALOGO_V1) {
      const x = await llamar(r, falso, tool.name, argumentosDe(tool.inputSchema as unknown as Esquema, 0));
      expect(x.status, `${tool.name} ejecutó para el cliente`).toBe('failed');
      for (const c of PROHIBIDOS) expect(x.content).not.toContain(c);
    }
  });

  it('UUID crudo de una fuente/participación de OTRA campaña u OTRA organización: indistinguible de inexistente', async () => {
    const t = await abrirTurno(m.op.admin, m.op.campanaId, 'Lee estas fuentes');
    const inexistente = '99999999-9999-4999-8999-999999999999';
    const casos: Array<[string, Record<string, unknown>]> = [];
    for (const id of [ids['otra']!, ids['ajena']!, ids['sensible']!, inexistente]) {
      casos.push(['source_get', { sourceId: id }], ['source_read_content', { sourceId: id }]);
    }
    for (const id of [ids['participacionAjena']!, inexistente]) {
      casos.push(['influencer_get_participation', { participationId: id }]);
      casos.push(['influencer_get_origin', { participationId: id }]);
      casos.push(['operations_participation_status', { participationId: id }]);
      casos.push(['kpi_scoreboard_get', { participationId: id }]);
    }
    const por = new Map<string, Set<string>>();
    for (const [tool, args] of casos) {
      const x = await llamar(r, t, tool, args);
      for (const c of PROHIBIDOS) expect(x.content, `${tool} devolvió «${c}»`).not.toContain(c);
      const clave = `${tool}:${JSON.stringify(Object.values(args)[0]) === JSON.stringify(inexistente) ? 'inexistente' : 'ajeno'}`;
      const g = por.get(tool) ?? new Set<string>();
      g.add(`${x.status}|${x.errorCode ?? ''}|${clave.endsWith('inexistente') ? '' : ''}`);
      por.set(tool, g);
    }
    // Para cada tool: ajeno ≡ inexistente (mismo estado y código de error).
    for (const [tool, g] of por) {
      expect(g.size, `${tool}: respuestas distintas`).toBe(1);
      expect([...g][0], `${tool}: no es el 404 uniforme`).toMatch(
        /^failed\|(RESOURCE_NOT_FOUND|VALIDATION_FAILED)/u,
      );
    }
    // Search textual con el nombre de la fuente de otra campaña: nada.
    const busqueda = await llamar(r, t, 'source_search_text', { text: 'QAF10' });
    for (const c of [OTRA_CAMPANA, AJENA, SENSIBLE]) expect(busqueda.content).not.toContain(c);
  });
});

// ─────────────────────────── (10) la cita histórica no llega al modelo ──────────

describe('QA F10 · (10) la cita de evidencia con texto histórico del Sheet no llega al modelo', () => {
  it('finding_list, brief_get_workspace, script_version_get y el contexto no la incluyen (aunque los lectores internos sí: QA-F10-05)', async () => {
    const [n] = await query<{ n: string }>(`SELECT count(*)::text AS n FROM evidence WHERE quote LIKE $1`, [
      `%${FEE_HIST}%`,
    ]);
    expect(Number(n!.n), 'control: la evidencia con fee existe').toBe(1);
    for (const u of [m.op.admin, m.op.consultor]) {
      const t = await abrirTurno(u, m.op.campanaId, 'Muéstrame los hallazgos del guion');
      await llamar(r, t, 'deliverable_list', {});
      const salidas: string[] = [];
      salidas.push((await llamar(r, t, 'brief_get_workspace', {})).content);
      for (const alias of ['V1', 'V2', 'V3']) {
        salidas.push((await llamar(r, t, 'finding_list', { versionId: alias })).content);
        salidas.push((await llamar(r, t, 'script_version_get', { versionId: alias })).content);
      }
      const joined = salidas.join('\n');
      expect(joined, u.role).not.toContain(FEE_HIST);
      expect(joined).toContain('accion_kpis.accion_esperada'); // control positivo: SÍ ve los campos del Brief
    }
  });
});
