import { expect, test } from '@playwright/test';
import { crearEntregable, query } from '@tcl-kol-os/db';
import {
  TEXTO_SEMBRADO,
  huellaDeAprobacion,
  limpiarContenido,
  registrarGuionSembrado,
  revisarComoHumano,
} from '../src/contenido';
import {
  contextoDe,
  cuerpoMultipart,
  invocarAccion,
  postCrudo,
  sembrarEscenarioQa,
  type EscenarioQa,
} from '../src/qa-f7-ui';

/**
 * QA adversarial de la capa web de la Fase 7 — U1 (IDOR / rutas forzadas), U2 (server actions),
 * U5 (fuga por DTO/serialización) y U11 (cabeceras, caché, redirecciones). Todo por HTTP contra el servidor
 * de la configuración `playwright.qa-f7-ui.config.ts` (puerto 3040), con cookies de sesión firmadas con el
 * secreto de PRUEBA de ese servidor; sin navegador. Lo ROTO queda como `test.fail(...)` («QA-F7-UI-xx
 * abierto») para que la suite siga verde.
 */
test.describe.configure({ mode: 'serial' });

let s: EscenarioQa;
const NO_UUID = 'not-a-uuid';
const INEXISTENTE = '00000000-0000-4000-8000-000000000000';

const detalle = (c: string, p: string, d: string): string => `/campanas/${c}/contenido/${p}/${d}`;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  s = await sembrarEscenarioQa('qaui-acceso');
  // Compila bajo demanda las páginas (y registra sus server actions en el manifiesto) una sola vez.
  const adm = await contextoDe(s.e.admin.id);
  for (const ruta of [
    `/campanas/${s.campaignId}/contenido`,
    `/campanas/${s.campaignId}/contenido/${s.valentina.participacionId}`,
    detalle(s.campaignId, s.valentina.participacionId, s.valentina.deliverableId),
  ]) {
    await adm.get(ruta, { timeout: 180_000 });
  }
  await adm.dispose();
});

test.afterAll(async () => {
  await limpiarContenido();
});

const rolesDe = () =>
  [
    ['admin', s.e.admin.id],
    ['director', s.e.director.id],
    ['consultor', s.e.consultor.id],
    ['operativo', s.e.operativo.id],
    ['analista', s.e.analista.id],
    ['legal', s.e.legal.id],
    ['cliente', s.e.cliente.id],
    ['otra agencia', s.e.ajeno.id],
  ] as const;

// ─────────────────────────── U1 · rutas forzadas ───────────────────────────────

test('U1a — RESISTE: matriz rol × ruta (cuenta y operativo 200; analista, legal, cliente y otra agencia 404; sin sesión al login)', async () => {
  const rutas = [
    `/campanas/${s.campaignId}/contenido`,
    `/campanas/${s.campaignId}/contenido/${s.valentina.participacionId}`,
    detalle(s.campaignId, s.valentina.participacionId, s.valentina.deliverableId),
    `${detalle(s.campaignId, s.valentina.participacionId, s.valentina.deliverableId)}?v=1`,
  ];
  for (const [rol, id] of rolesDe()) {
    const ctx = await contextoDe(id);
    const esperado =
      rol === 'admin' || rol === 'director' || rol === 'consultor' || rol === 'operativo' ? 200 : 404;
    for (const ruta of rutas) {
      expect((await ctx.get(ruta, { timeout: 120_000 })).status(), `${rol} ${ruta}`).toBe(esperado);
    }
    await ctx.dispose();
  }
  const anonimo = await contextoDe();
  for (const ruta of rutas) {
    const r = await anonimo.get(ruta);
    expect(r.status(), ruta).toBe(307);
    expect(r.headers()['location']).toMatch(/\/login$/);
  }
  await anonimo.dispose();
});

test('U1b — RESISTE: ids de otra campaña (misma organización), de otra organización, inexistentes o mal formados dan 404 a Cuenta', async () => {
  const ctx = await contextoDe(s.e.consultor.id);
  const { campaignId: c, valentina: v, otraCampana: o, ajena: x } = s;
  const casos: [string, string][] = [
    ['entregable de otra campaña bajo esta', detalle(c, o.participacionId, o.deliverableId)],
    ['participación de otra campaña', `/campanas/${c}/contenido/${o.participacionId}`],
    ['campaña de otra organización', detalle(x.campaignId, x.participacionId, x.deliverableId)],
    ['entregable ajeno bajo mi campaña', detalle(c, v.participacionId, x.deliverableId)],
    ['participación inexistente', `/campanas/${c}/contenido/${INEXISTENTE}`],
    ['entregable inexistente', detalle(c, v.participacionId, INEXISTENTE)],
    ['participación mal formada', `/campanas/${c}/contenido/${NO_UUID}`],
    ['entregable mal formado', detalle(c, v.participacionId, NO_UUID)],
    ['entregable de Diego bajo Valentina', detalle(c, v.participacionId, s.diego.deliverableId)],
    ['campaña inexistente', `/campanas/${INEXISTENTE}/contenido`],
    ['campaña de otra agencia (lista)', `/campanas/${x.campaignId}/contenido`],
    ['id con ruta de escape', `/campanas/${c}/contenido/%2e%2e%2f%2e%2e`],
    ['id con barra invertida', `/campanas/${c}/contenido/..%5C..`],
    ['id con SQL', `/campanas/${c}/contenido/${encodeURIComponent("' OR '1'='1")}`],
  ];
  for (const [nombre, ruta] of casos) {
    expect((await ctx.get(ruta, { timeout: 120_000 })).status(), nombre).toBe(404);
  }
  await ctx.dispose();
});

test('U1c — RESISTE: `?v=` extremo o repetido no abre otra versión ni revienta (404 para Cuenta; el Operativo nunca recibe detalle)', async () => {
  const base = detalle(s.campaignId, s.valentina.participacionId, s.valentina.deliverableId);
  const cons = await contextoDe(s.e.consultor.id);
  for (const v of ['0', '-1', '1.5', 'abc', '99999999999', '1e3', '%00', '4', '999999']) {
    expect((await cons.get(`${base}?v=${v}`)).status(), `?v=${v}`).toBe(404);
  }
  // Repetido (`?v=1&v=3`): el valor es una lista → 404 (no se elige una al azar).
  expect((await cons.get(`${base}?v=1&v=3`)).status()).toBe(404);
  // Existentes: 200.
  for (const v of ['1', '2', '3']) expect((await cons.get(`${base}?v=${v}`)).status(), `?v=${v}`).toBe(200);
  await cons.dispose();

  // Operativo: con `?v=2` o `?v=99` ve el MISMO estado reducido (no hay detalle por versión).
  const op = await contextoDe(s.e.operativo.id);
  const sin = await (await op.get(base)).text();
  const con = await (await op.get(`${base}?v=1`)).text();
  expect(con).toContain('contenido-estado-reducido');
  expect(con).not.toContain('contenido-version-detalle');
  expect(sin).not.toContain('contenido-version-detalle');
  await op.dispose();
});

test('QA-F7-UI-01 (P3, corregido): una campaña con id que no es UUID responde 404, no 500 (hoy `getCampaign` revienta en la base)', async () => {
  const ctx = await contextoDe(s.e.consultor.id);
  try {
    const r = await ctx.get(`/campanas/${NO_UUID}/contenido`, { timeout: 120_000 });
    expect(r.status()).toBe(404);
  } finally {
    await ctx.dispose();
  }
});

test('U1d — RESISTE: Operativo y otros roles reciben la MISMA respuesta con una pieza real y con una inexistente (no se distingue «no existe» de «no autorizado»)', async () => {
  for (const [rol, id] of rolesDe().filter(([r]) =>
    ['analista', 'legal', 'cliente', 'otra agencia'].includes(r),
  )) {
    const ctx = await contextoDe(id);
    const real = await ctx.get(detalle(s.campaignId, s.valentina.participacionId, s.valentina.deliverableId));
    const falso = await ctx.get(detalle(INEXISTENTE, s.valentina.participacionId, s.valentina.deliverableId));
    expect(real.status(), rol).toBe(404);
    expect(falso.status(), rol).toBe(404);
    const [a, b] = [await real.text(), await falso.text()];
    // Misma forma (el id de la ruta aparece en el flujo, por eso se compara el tamaño con holgura mínima).
    expect(Math.abs(a.length - b.length), rol).toBeLessThan(64);
    expect(real.headers()['cache-control']).toBe(falso.headers()['cache-control']);
    await ctx.dispose();
  }
});

// ─────────────────────────── U2 · server actions ───────────────────────────────

const RUTA = (): string => detalle(s.campaignId, s.valentina.participacionId, s.valentina.deliverableId);

test('U2a — RESISTE: cada acción por rol sin permiso o fuera de su organización se niega, sin efecto (sin sesión, operativo, analista, legal, cliente, otra agencia)', async () => {
  const huella = await huellaDeAprobacion(s.e.director, s.diegoV1.versionId);
  const antes = await query<{ n: number }>(
    `SELECT (SELECT count(*) FROM script_review_comments WHERE campaign_id = $1)::int
          + (SELECT count(*) FROM deliverables WHERE campaign_id = $1)::int
          + (SELECT count(*) FROM content_analysis_runs WHERE campaign_id = $1)::int AS n`,
    [s.campaignId],
  );
  const acciones: [string, unknown[]][] = [
    ['aprobarVersionDeGuion', [s.campaignId, s.diegoV1.versionId, huella]],
    ['registrarRevisionHumanaDeContenido', [s.campaignId, s.story.versionId, 'a'.repeat(64)]],
    ['solicitarCambiosDeContenido', [s.campaignId, s.story.versionId, 'un cambio']],
    ['anadirComentarioDeContenido', [s.campaignId, s.story.versionId, 'comentario']],
    ['solicitarAnalisisDeContenido', [s.campaignId, s.story.versionId, 'ensure', 'qaui:acceso-12345678']],
    ['crearDeliverableDeContenido', [s.campaignId, s.valentina.participacionId, 'No debe existir']],
  ];
  const sesiones: [string, string | undefined, string][] = [
    ['anónimo', undefined, 'SESSION'],
    ['operativo', s.e.operativo.id, 'FORBIDDEN_ROLE'],
    ['analista', s.e.analista.id, 'RESOURCE_NOT_FOUND'],
    ['legal', s.e.legal.id, 'RESOURCE_NOT_FOUND'],
    ['cliente', s.e.cliente.id, 'RESOURCE_NOT_FOUND'],
    ['otra agencia', s.e.ajeno.id, 'RESOURCE_NOT_FOUND'],
  ];
  for (const [quien, id, codigo] of sesiones) {
    const ctx = await contextoDe(id);
    for (const [nombre, args] of acciones) {
      const r = await invocarAccion(ctx, RUTA(), nombre, args);
      expect(r.resultado?.ok, `${quien} ${nombre}`).toBe(false);
      expect(r.resultado?.codigo, `${quien} ${nombre}`).toBe(codigo);
    }
    await ctx.dispose();
  }
  const despues = await query<{ n: number }>(
    `SELECT (SELECT count(*) FROM script_review_comments WHERE campaign_id = $1)::int
          + (SELECT count(*) FROM deliverables WHERE campaign_id = $1)::int
          + (SELECT count(*) FROM content_analysis_runs WHERE campaign_id = $1)::int AS n`,
    [s.campaignId],
  );
  expect(despues[0]!.n).toBe(antes[0]!.n);
});

test('U2b — RESISTE: el consultor NO aprueba por server action (script:approve), aunque tenga la huella correcta', async () => {
  const huella = await huellaDeAprobacion(s.e.director, s.diegoV1.versionId);
  const cons = await contextoDe(s.e.consultor.id);
  const r = await invocarAccion(cons, RUTA(), 'aprobarVersionDeGuion', [
    s.campaignId,
    s.diegoV1.versionId,
    huella,
  ]);
  expect(r.resultado).toMatchObject({ ok: false, codigo: 'FORBIDDEN_ROLE' });
  const [fila] = await query<{ status: string }>(`SELECT status FROM script_versions WHERE id = $1`, [
    s.diegoV1.versionId,
  ]);
  expect(fila!.status).toBe('in_review');
  await cons.dispose();
});

test('U2c — RESISTE: ids cruzados (versión de otra campaña, campaña ajena, huella ajena, tipos raros, sin argumentos) no aprueban nada', async () => {
  const dir = await contextoDe(s.e.director.id);
  const huellaDiego = await huellaDeAprobacion(s.e.director, s.diegoV1.versionId);
  const casos: [string, unknown, string][] = [
    ['versión de otra campaña', [s.campaignId, s.otraCampana.versionId, huellaDiego], 'RESOURCE_NOT_FOUND'],
    [
      'campaña de otra campaña con versión mía',
      [s.otraCampana.campaignId, s.diegoV1.versionId, huellaDiego],
      'RESOURCE_NOT_FOUND',
    ],
    [
      'campaña y versión de otra organización',
      [s.ajena.campaignId, s.ajena.versionId, huellaDiego],
      'RESOURCE_NOT_FOUND',
    ],
    ['versión mal formada', [s.campaignId, 'xx', huellaDiego], 'RESOURCE_NOT_FOUND'],
    ['versión como objeto', [s.campaignId, { id: s.diegoV1.versionId }, huellaDiego], 'RESOURCE_NOT_FOUND'],
    ['campaña como número', [5, s.diegoV1.versionId, huellaDiego], 'RESOURCE_NOT_FOUND'],
    ['sin argumentos', [], 'RESOURCE_NOT_FOUND'],
    ['cuerpo null', null, 'RESOURCE_NOT_FOUND'],
    ['huella vacía', [s.campaignId, s.diegoV1.versionId, ''], 'VALIDATION_FAILED'],
    ['huella inventada', [s.campaignId, s.diegoV1.versionId, 'a'.repeat(64)], 'PROPOSAL_STALE'],
    [
      'huella de OTRA versión',
      [
        s.campaignId,
        s.diegoV1.versionId,
        await huellaDeAprobacion(s.e.director, s.historial.v3).catch(() => 'b'.repeat(64)),
      ],
      'PROPOSAL_STALE',
    ],
  ];
  for (const [nombre, args, codigo] of casos) {
    const r = await invocarAccion(dir, RUTA(), 'aprobarVersionDeGuion', args);
    expect(r.resultado?.ok, nombre).toBe(false);
    expect(r.resultado?.codigo, nombre).toBe(codigo);
  }
  const [fila] = await query<{ status: string }>(`SELECT status FROM script_versions WHERE id = $1`, [
    s.diegoV1.versionId,
  ]);
  expect(fila!.status).toBe('in_review');
  await dir.dispose();
});

test('U2d — RESISTE: origen, canal y autor se fijan en el servidor (argumentos extra inyectados se ignoran) y la aprobación deja actor humano y origen ui', async () => {
  const dir = await contextoDe(s.e.director.id);
  const huella = await huellaDeAprobacion(s.e.director, s.diegoV1.versionId);
  // Argumentos inyectados: origen/canal/autor/usuario. Los parámetros de la acción son posicionales.
  const r = await invocarAccion(dir, RUTA(), 'aprobarVersionDeGuion', [
    s.campaignId,
    s.diegoV1.versionId,
    huella,
    'chat',
    {
      origen: 'chat',
      origin: 'system',
      canal: 'agent',
      autor: s.e.admin.id,
      userId: s.e.admin.id,
      approvedBy: s.e.admin.id,
    },
  ]);
  expect(r.resultado?.ok, JSON.stringify(r.resultado)).toBe(true);
  const [v] = await query<{
    status: string;
    approved_by: string;
    approved_via_proposed_action_id: string | null;
  }>(`SELECT status, approved_by, approved_via_proposed_action_id FROM script_versions WHERE id = $1`, [
    s.diegoV1.versionId,
  ]);
  expect(v).toMatchObject({
    status: 'approved',
    approved_by: s.e.director.id,
    approved_via_proposed_action_id: null,
  });
  const eventos = await query<{ origin: string | null; actor_id: string | null }>(
    `SELECT origin, actor_id FROM audit_events WHERE entity_id = $1 AND action = 'script_version.approve'`,
    [s.diegoV1.versionId],
  );
  expect(eventos).toHaveLength(1);
  expect(eventos[0]).toMatchObject({ origin: 'ui', actor_id: s.e.director.id });
  await dir.dispose();

  // Comentario con argumentos inyectados: autor = la sesión (consultor), canal ui, sin chat_message_id.
  const cons = await contextoDe(s.e.consultor.id);
  const c = await invocarAccion(cons, RUTA(), 'anadirComentarioDeContenido', [
    s.campaignId,
    s.story.versionId,
    'Comentario del consultor',
    { autor: s.e.admin.id, origen: 'chat', chatMessageId: INEXISTENTE },
  ]);
  expect(c.resultado?.ok).toBe(true);
  const [com] = await query<{ author_id: string; origin: string; chat_message_id: string | null }>(
    `SELECT author_id, origin, chat_message_id FROM script_review_comments
      WHERE script_version_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [s.story.versionId],
  );
  expect(com).toMatchObject({ author_id: s.e.consultor.id, origin: 'ui', chat_message_id: null });
  await cons.dispose();
});

test('U2e — RESISTE: dos o más aprobaciones simultáneas con la misma huella dejan UNA sola aprobación y un solo evento', async () => {
  const { e } = s;
  const dir = await contextoDe(e.director.id);
  // Pieza nueva lista para aprobar (Valentina Gómez: V1 en revisión humana).
  const d = await crearEntregable(e.consultor, {
    campaignInfluencerId: e.participaciones.valentinaGomez,
    label: `Doble clic ${e.sufijo}`,
  });
  if (!d.ok) throw new Error(d.error.code);
  const v = await registrarGuionSembrado(s, d.value.id, e.participaciones.valentinaGomez, TEXTO_SEMBRADO);
  await revisarComoHumano(v.versionId, e.consultor);
  const huella = await huellaDeAprobacion(e.director, v.versionId);
  const rs = await Promise.all(
    Array.from({ length: 6 }, () =>
      invocarAccion(dir, RUTA(), 'aprobarVersionDeGuion', [s.campaignId, v.versionId, huella]),
    ),
  );
  expect(rs.filter((r) => r.resultado?.ok === true)).toHaveLength(1);
  for (const r of rs.filter((r) => r.resultado?.ok !== true)) {
    expect(r.http).toBe(200);
    expect(r.resultado?.codigo).toMatch(/^(SCRIPT_INVALID_TRANSITION|PROPOSAL_STALE|RESOURCE_CONFLICT)$/);
  }
  const [conteo] = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_events WHERE entity_id = $1 AND action = 'script_version.approve'`,
    [v.versionId],
  );
  expect(conteo!.n).toBe(1);
  await dir.dispose();
});

test('U2f — RESISTE: una petición de otro sitio a una server action (Origin ajeno) no se ejecuta', async () => {
  const cons = await contextoDe(s.e.consultor.id);
  const antes = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM script_review_comments WHERE script_version_id = $1`,
    [s.story.versionId],
  );
  const r = await invocarAccion(
    cons,
    RUTA(),
    'anadirComentarioDeContenido',
    [s.campaignId, s.story.versionId, 'Comentario CSRF'],
    { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
  );
  expect(r.resultado?.ok).not.toBe(true);
  const despues = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM script_review_comments WHERE script_version_id = $1`,
    [s.story.versionId],
  );
  expect(despues[0]!.n).toBe(antes[0]!.n);
  await cons.dispose();
});

test('U2g — RESISTE: texto gigante, tipos inesperados y caracteres de control en comentarios/etiquetas se rechazan con mensajes en español', async () => {
  const cons = await contextoDe(s.e.consultor.id);
  const casos: [string, string, unknown[], RegExp][] = [
    [
      'anadirComentarioDeContenido',
      'comentario de 2001',
      [s.campaignId, s.story.versionId, 'b'.repeat(2001)],
      /2000/,
    ],
    ['anadirComentarioDeContenido', 'comentario numérico', [s.campaignId, s.story.versionId, 5], /Escribe/],
    [
      'anadirComentarioDeContenido',
      'comentario con NUL',
      [s.campaignId, s.story.versionId, 'a\u0000b'],
      /no válidos/,
    ],
    [
      'crearDeliverableDeContenido',
      'etiqueta de 10 000',
      [s.campaignId, s.valentina.participacionId, 'z'.repeat(10_000)],
      /120/,
    ],
    [
      'crearDeliverableDeContenido',
      'plataforma inválida',
      [s.campaignId, s.valentina.participacionId, 'ok1', 'myspace'],
      /plataforma/,
    ],
    [
      'solicitarCambiosDeContenido',
      '21 cambios',
      [s.campaignId, s.story.versionId, Array.from({ length: 21 }, (_, i) => `c${i}`).join('\n')],
      /entre 1 y 20/,
    ],
    [
      'solicitarAnalisisDeContenido',
      'clave corta',
      [s.campaignId, s.story.versionId, 'ensure', 'k'],
      /idempotencia/,
    ],
  ];
  for (const [nombre, etiqueta, args, mensaje] of casos) {
    const r = await invocarAccion(cons, RUTA(), nombre, args);
    expect(r.resultado?.ok, etiqueta).toBe(false);
    expect(r.resultado?.error, etiqueta).toMatch(mensaje);
  }
  await cons.dispose();
});

test('QA-F7-UI-05 (P3, corregido): los controles bidi/invisibles (RLO U+202E, ZWSP…) se rechazan o se limpian en comentarios, notas y nombres de archivo', async () => {
  const cons = await contextoDe(s.e.consultor.id);
  try {
    // Comentario con «anulación derecha-a-izquierda»: hoy solo se rechaza el NUL.
    const c = await invocarAccion(cons, RUTA(), 'anadirComentarioDeContenido', [
      s.campaignId,
      s.story.versionId,
      'Aprobado\u202E dobarpA\u200Bx',
    ]);
    expect(c.resultado?.ok, 'comentario con RLO/ZWSP').toBe(false);
    // Nombre de archivo con RLO: `nombreSeguro` solo quita \u0000-\u001f y \u007f.
    const cuerpo = cuerpoMultipart([
      {
        nombre: 'archivo',
        valor: Buffer.from(`# g\n\nrlo ${Math.random()}\n`),
        archivo: 'guion\u202Efdp.md',
        tipo: 'text/markdown',
      },
      { nombre: 'participacionId', valor: s.valentina.participacionId },
      { nombre: 'deliverableId', valor: s.story.deliverableId },
    ]);
    const r = await postCrudo(`/api/campanas/${s.campaignId}/contenido/guiones`, cuerpo, {
      userId: s.e.consultor.id,
    });
    expect(r.http).toBe(200);
    const [fila] = await query<{ filename: string }>(
      `SELECT source_filename AS filename FROM script_versions WHERE deliverable_id = $1 ORDER BY version DESC LIMIT 1`,
      [s.story.deliverableId],
    );
    expect(fila!.filename).not.toMatch(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/u);
  } finally {
    await cons.dispose();
  }
});

test('QA-F7-UI-01b (P3, corregido): una acción con campaignId que no es UUID responde «no encontrado», no el error genérico INTERNAL', async () => {
  const cons = await contextoDe(s.e.consultor.id);
  try {
    const r = await invocarAccion(cons, RUTA(), 'anadirComentarioDeContenido', [
      NO_UUID,
      s.story.versionId,
      'x',
    ]);
    expect(r.resultado?.codigo).toBe('RESOURCE_NOT_FOUND');
  } finally {
    await cons.dispose();
  }
});

// ─────────────────────────── U5 · fuga por DTO / serialización ─────────────────

test('U5a — RESISTE: el HTML y el flujo RSC del Operativo no llevan ids de versión/fuente, hashes, comentarios, autores, huellas ni nombres de archivos no aprobados', async () => {
  const { e } = s;
  const filas = await query<{
    id: string;
    source_document_id: string;
    source_filename: string;
    source_hash: string;
    version: number;
  }>(
    `SELECT id, source_document_id, source_filename, source_hash, version FROM script_versions
      WHERE deliverable_id = $1 ORDER BY version`,
    [s.valentina.deliverableId],
  );
  const [v1, v2, v3] = filas;
  const secretos: Record<string, string> = {
    'id V1': v1!.id,
    'id V2': v2!.id,
    'id V3': v3!.id,
    'fuente V1': v1!.source_document_id,
    'fuente V2': v2!.source_document_id,
    'fuente V3': v3!.source_document_id,
    'archivo V1': v1!.source_filename,
    'archivo V3': v3!.source_filename,
    'hash V1': v1!.source_hash,
    'hash V2': v2!.source_hash,
    'hash V3': v3!.source_hash,
    'id V1 de Diego': s.diegoV1.versionId,
    'fuente de Diego': s.diegoV1.fuenteId,
    'nombre del consultor': e.consultor.name,
    'nombre del director': e.director.name,
    'campaña ajena': s.ajena.campaignId,
    'otra campaña': s.otraCampana.campaignId,
  };
  const op = await contextoDe(e.operativo.id);
  const rutas = [
    `/campanas/${s.campaignId}/contenido`,
    `/campanas/${s.campaignId}/contenido/${s.valentina.participacionId}`,
    detalle(s.campaignId, s.valentina.participacionId, s.valentina.deliverableId),
    `${detalle(s.campaignId, s.valentina.participacionId, s.valentina.deliverableId)}?v=1`,
    detalle(s.campaignId, s.diego.participacionId, s.diego.deliverableId),
  ];
  for (const ruta of rutas) {
    for (const [tipo, cabeceras] of [
      ['HTML', {}],
      ['RSC', { rsc: '1' }],
    ] as const) {
      const r = await op.get(ruta, { headers: cabeceras, timeout: 120_000 });
      expect(r.status(), `${tipo} ${ruta}`).toBe(200);
      const cuerpo = await r.text();
      for (const [nombre, valor] of Object.entries(secretos)) {
        // El nombre del consultor/director aparece en la barra de la app si es quien navega; aquí navega el operativo.
        expect(cuerpo.includes(valor), `${tipo} ${ruta} filtra «${nombre}»`).toBe(false);
      }
      for (const palabra of [
        'huella',
        'fingerprint',
        'ai_run',
        'proposed_action',
        'payloadHash',
        'hallazgosDelBrief',
        'cambiosSolicitados',
      ]) {
        expect(cuerpo.includes(palabra), `${tipo} ${ruta} contiene «${palabra}»`).toBe(false);
      }
    }
  }
  await op.dispose();
});

test('U5b — RESISTE: las respuestas de las acciones y del route handler no revelan trazas ni existencia (mismo mensaje para «no existe» y «no autorizado»)', async () => {
  const cli = await contextoDe(s.e.cliente.id);
  const real = await invocarAccion(cli, RUTA(), 'anadirComentarioDeContenido', [
    s.campaignId,
    s.story.versionId,
    'x',
  ]);
  const falso = await invocarAccion(cli, RUTA(), 'anadirComentarioDeContenido', [
    INEXISTENTE,
    s.story.versionId,
    'x',
  ]);
  expect(real.resultado).toEqual(falso.resultado);
  expect(real.texto).not.toMatch(/\bat \S+\.(ts|js)|postgres|pg_|SELECT |stack/i);
  await cli.dispose();

  // Route handler: cliente y otra agencia reciben el mismo 404 con una campaña real y con una inexistente.
  for (const id of [s.e.cliente.id, s.e.ajeno.id]) {
    const ctx = await contextoDe(id);
    const cuerpo = {
      multipart: {
        archivo: { name: 'g.md', mimeType: 'text/markdown', buffer: Buffer.from('# x\n\ntexto') },
        participacionId: s.valentina.participacionId,
        deliverableId: s.valentina.deliverableId,
      },
    };
    const a = await ctx.post(`/api/campanas/${s.campaignId}/contenido/guiones`, cuerpo);
    const b = await ctx.post(`/api/campanas/${INEXISTENTE}/contenido/guiones`, cuerpo);
    expect(a.status()).toBe(404);
    expect(b.status()).toBe(404);
    expect(await a.json()).toEqual(await b.json());
    await ctx.dispose();
  }
});

// ─────────────────────────── U11 · cabeceras, caché, redirecciones ─────────────

test('U11a — RESISTE: las páginas y el route handler no se cachean (datos privados) y no anuncian la tecnología', async () => {
  const cons = await contextoDe(s.e.consultor.id);
  for (const ruta of [
    `/campanas/${s.campaignId}/contenido`,
    detalle(s.campaignId, s.valentina.participacionId, s.valentina.deliverableId),
  ]) {
    const r = await cons.get(ruta);
    expect(r.headers()['cache-control'], ruta).toMatch(/no-store/);
    expect(r.headers()['x-powered-by']).toBeUndefined();
  }
  const post = await cons.post(`/api/campanas/${s.campaignId}/contenido/guiones`, { multipart: { x: 'y' } });
  expect(post.headers()['cache-control']).toMatch(/no-store/);
  expect(post.headers()['content-type']).toMatch(/application\/json/);
  await cons.dispose();
});

test('U11b — RESISTE: ninguna ruta de contenido redirige a un destino elegido por quien llama (sin sesión solo va a /login)', async () => {
  const anonimo = await contextoDe();
  for (const ruta of [
    `/campanas/${s.campaignId}/contenido?next=https://evil.example&redirect=//evil.example`,
    `/campanas/${s.campaignId}/contenido/%2F%2Fevil.example`,
    `/campanas/${s.campaignId}/contenido/${s.valentina.participacionId}/${s.valentina.deliverableId}?v=1&returnTo=//evil.example`,
  ]) {
    const r = await anonimo.get(ruta);
    const destino = r.headers()['location'] ?? '';
    expect(
      destino === '' || /^\/login$/.test(destino) || /^https?:\/\/localhost:3040\/login$/.test(destino),
      `${ruta} → ${destino}`,
    ).toBe(true);
    expect(destino).not.toMatch(/evil/);
  }
  await anonimo.dispose();
});

test.fail(
  'QA-F7-UI-08 abierto (P3): las respuestas llevan cabeceras de endurecimiento básicas (X-Content-Type-Options, X-Frame-Options/frame-ancestors, Referrer-Policy)',
  async () => {
    const cons = await contextoDe(s.e.consultor.id);
    try {
      const r = await cons.get(detalle(s.campaignId, s.valentina.participacionId, s.valentina.deliverableId));
      const h = r.headers();
      expect(h['x-content-type-options']).toBe('nosniff');
      expect(h['x-frame-options'] ?? h['content-security-policy']).toBeTruthy();
      expect(h['referrer-policy']).toBeTruthy();
    } finally {
      await cons.dispose();
    }
  },
);

// ─────────────────────────── U2 · campaña archivada (último: cambia el estado de la campaña) ──

test('U2h — RESISTE: con la campaña archivada ninguna acción escribe (aprobar con huella válida incluida) y las pantallas son de solo lectura sin controles', async () => {
  const { e } = s;
  const d = await crearEntregable(e.consultor, {
    campaignInfluencerId: e.participaciones.valentinaGomez,
    label: `Archivada ${e.sufijo}`,
  });
  if (!d.ok) throw new Error(d.error.code);
  const v = await registrarGuionSembrado(s, d.value.id, e.participaciones.valentinaGomez, TEXTO_SEMBRADO);
  await revisarComoHumano(v.versionId, e.consultor);
  const huella = await huellaDeAprobacion(e.director, v.versionId);
  await query(`UPDATE campaigns SET status = 'archivada' WHERE id = $1`, [s.campaignId]);
  try {
    const dir = await contextoDe(e.director.id);
    const ruta = detalle(s.campaignId, e.participaciones.valentinaGomez, d.value.id);
    const aprobar = await invocarAccion(dir, ruta, 'aprobarVersionDeGuion', [
      s.campaignId,
      v.versionId,
      huella,
    ]);
    expect(aprobar.resultado?.ok).toBe(false);
    expect(aprobar.resultado?.codigo).toBe('RESOURCE_CONFLICT');
    expect(aprobar.resultado?.error).toMatch(/no está activa/);
    for (const [nombre, args] of [
      ['anadirComentarioDeContenido', [s.campaignId, v.versionId, 'x']],
      ['solicitarCambiosDeContenido', [s.campaignId, v.versionId, 'x']],
      ['crearDeliverableDeContenido', [s.campaignId, e.participaciones.valentinaGomez, 'Nuevo en archivada']],
      ['registrarRevisionHumanaDeContenido', [s.campaignId, v.versionId, huella]],
    ] as [string, unknown[]][]) {
      const r = await invocarAccion(dir, ruta, nombre, args);
      expect(r.resultado?.ok, nombre).toBe(false);
    }
    expect(await query(`SELECT status FROM script_versions WHERE id = $1`, [v.versionId])).toEqual([
      { status: 'in_review' },
    ]);

    // Subida por el route handler: 409 (ya cubierto en la prueba de subida, aquí con la campaña principal).
    const html = await (await dir.get(ruta)).text();
    expect(html).toContain('contenido-campana-solo-lectura');
    for (const control of [
      'contenido-aprobar"',
      'contenido-subir-form',
      'contenido-acciones-comentario',
      'contenido-acciones-revision',
    ]) {
      expect(html.includes(`data-testid="${control.replace('"', '')}`), control).toBe(false);
    }
    await dir.dispose();
  } finally {
    await query(`UPDATE campaigns SET status = 'activa' WHERE id = $1`, [s.campaignId]);
  }
});
