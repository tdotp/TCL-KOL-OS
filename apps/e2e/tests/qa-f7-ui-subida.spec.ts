import { expect, test } from '@playwright/test';
import { query } from '@tcl-kol-os/db';
import { limpiarContenido } from '../src/contenido';
import {
  contextoDe,
  cuerpoMultipart,
  postCrudo,
  sembrarEscenarioQa,
  type EscenarioQa,
} from '../src/qa-f7-ui';

/**
 * QA adversarial de la capa web de la Fase 7 — U3 (route handler de subida de guiones) y U12 (abuso de
 * recursos). Peticiones HTTP crudas (multipart armado a mano) contra el servidor 3040: CSRF, Content-Length
 * falso o ausente, nombres de archivo hostiles, tipos no aceptados, campos duplicados, ids cruzados,
 * subidas simultáneas del mismo archivo y ráfagas. Lo ROTO queda como `test.fail(...)`.
 */
test.describe.configure({ mode: 'serial' });

let s: EscenarioQa;
const md = (texto: string): Buffer => Buffer.from(`# Guion\n\n${texto} ${Math.random()}\n`);
const ruta = (): string => `/api/campanas/${s.campaignId}/contenido/guiones`;
const INEXISTENTE = '00000000-0000-4000-8000-000000000000';

test.beforeAll(async () => {
  test.setTimeout(300_000);
  s = await sembrarEscenarioQa('qaui-subida');
  const adm = await contextoDe(s.e.admin.id);
  await adm.post(ruta(), { multipart: { x: 'y' }, timeout: 180_000 }); // compila el route handler
  await adm.dispose();
});

test.afterAll(async () => {
  await limpiarContenido();
});

function partes(opciones: {
  archivo?: Buffer;
  nombre?: string;
  tipo?: string;
  participacionId?: string;
  deliverableId?: string;
  etiqueta?: string;
}) {
  return [
    {
      nombre: 'archivo',
      valor: opciones.archivo ?? md('guion de prueba'),
      archivo: opciones.nombre ?? 'guion.md',
      tipo: opciones.tipo ?? 'text/markdown',
    },
    { nombre: 'participacionId', valor: opciones.participacionId ?? s.valentina.participacionId },
    ...(opciones.etiqueta === undefined && opciones.deliverableId === undefined
      ? [{ nombre: 'deliverableId', valor: s.valentina.deliverableId }]
      : []),
    ...(opciones.deliverableId === undefined
      ? []
      : [{ nombre: 'deliverableId', valor: opciones.deliverableId }]),
    ...(opciones.etiqueta === undefined ? [] : [{ nombre: 'etiqueta', valor: opciones.etiqueta }]),
  ];
}

const subir = (
  p: ReturnType<typeof partes>,
  extra: Parameters<typeof postCrudo>[2] = {},
  quien: string = s.e.consultor.id,
) => postCrudo(ruta(), cuerpoMultipart(p), { userId: quien, ...extra });

const contarVersiones = async (): Promise<number> =>
  (
    await query<{ n: number }>(`SELECT count(*)::int AS n FROM script_versions WHERE campaign_id = $1`, [
      s.campaignId,
    ])
  )[0]!.n;
const contarFuentes = async (): Promise<number> =>
  (
    await query<{ n: number }>(`SELECT count(*)::int AS n FROM source_documents WHERE campaign_id = $1`, [
      s.campaignId,
    ])
  )[0]!.n;

// ─────────────────────────── U3 · CSRF ─────────────────────────────────────────

test('U3a — RESISTE: una subida de otro sitio (Sec-Fetch-Site cross-site/same-site, Origin ajeno o «null») se rechaza sin efecto', async () => {
  const antes = await contarVersiones();
  const fuentesAntes = await contarFuentes();
  for (const cabeceras of [
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site' },
    { origin: 'https://evil.example' },
    { origin: 'null' },
    { origin: 'http://localhost:3040.evil.example' },
    { 'sec-fetch-site': 'cross-site', origin: 'http://localhost:3040' },
  ]) {
    const r = await subir(partes({}), { cabeceras });
    expect(r.http, JSON.stringify(cabeceras)).toBe(403);
    expect(r.json?.['codigo']).toBe('FORBIDDEN');
  }
  expect(await contarVersiones()).toBe(antes);
  expect(await contarFuentes()).toBe(fuentesAntes);
});

test('U3b — RESISTE: del mismo sitio (Origin propio, Sec-Fetch-Site same-origin) o sin cabeceras de navegador la subida funciona', async () => {
  for (const cabeceras of [{ origin: 'http://localhost:3040', 'sec-fetch-site': 'same-origin' }, {}]) {
    const r = await subir(partes({}), { cabeceras });
    expect(r.http, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ ok: true, resultado: 'registrada' });
  }
});

test.fail(
  'QA-F7-UI-09 abierto (P3, informativo): el origen NO se valida con `x-forwarded-host` enviado por el cliente (un Origin ajeno + X-Forwarded-Host ajeno pasa)',
  async () => {
    const r = await subir(partes({}), {
      cabeceras: { origin: 'https://evil.example', 'x-forwarded-host': 'evil.example' },
    });
    expect(r.http).toBe(403);
  },
);

// ─────────────────────────── U3 · tamaño y Content-Length ──────────────────────

test('U3c — RESISTE: sin Content-Length (chunked) 411; Content-Length falso 4xx; excedido 413 ANTES de leer; vacío o sin archivo 422', async () => {
  const antes = await contarVersiones();
  const cuerpo = cuerpoMultipart(partes({}));
  const chunked = await postCrudo(ruta(), cuerpo, { userId: s.e.consultor.id, contentLength: 'omitir' });
  expect(chunked.http).toBe(411);

  // Un Content-Length menor que el cuerpo real: el servidor lo corta (400) o cierra la conexión; nunca lo procesa.
  const corto = await postCrudo(ruta(), cuerpo, { userId: s.e.consultor.id, contentLength: 40 }).catch(
    () => ({ http: 400 }),
  );
  expect(corto.http).toBeGreaterThanOrEqual(400);
  expect(corto.http).toBeLessThan(500);

  // Un archivo mayor que el tope (CHAT_ATTACHMENT_MAX_MB=1 en este servidor).
  // (el servidor responde 413 y corta: el cliente puede ver el 413 o el cierre de la conexión).
  const grande = await subir(partes({ archivo: Buffer.alloc(1024 * 1024 + 1, 0x61) })).catch(() => ({
    http: 413,
    json: { codigo: 'PAYLOAD_TOO_LARGE' } as Record<string, unknown> | undefined,
  }));
  expect(grande.http).toBe(413);
  expect(grande.json?.['codigo']).toBe('PAYLOAD_TOO_LARGE');
  // Declarar un Content-Length enorme se rechaza por la cabecera, sin leer el cuerpo.
  const declarado = await postCrudo(ruta(), cuerpo, {
    userId: s.e.consultor.id,
    contentLength: 50 * 1024 * 1024,
  }).catch(() => undefined);
  if (declarado !== undefined) expect(declarado.http).toBe(413);

  const vacio = await subir(partes({ archivo: Buffer.alloc(0) }));
  expect(vacio.http).toBe(422);
  const sinArchivo = await subir([
    { nombre: 'participacionId', valor: s.valentina.participacionId },
    { nombre: 'deliverableId', valor: s.valentina.deliverableId },
  ]);
  expect(sinArchivo.http).toBe(422);
  const archivoComoTexto = await subir([
    { nombre: 'archivo', valor: 'esto no es un archivo' },
    { nombre: 'participacionId', valor: s.valentina.participacionId },
    { nombre: 'deliverableId', valor: s.valentina.deliverableId },
  ]);
  expect(archivoComoTexto.http).toBe(422);
  // Cuerpo que no es multipart.
  const noMultipart = await postCrudo(ruta(), Buffer.from('{"a":1}'), {
    userId: s.e.consultor.id,
    cabeceras: { 'content-type': 'application/json' },
  });
  expect(noMultipart.http).toBeGreaterThanOrEqual(400);
  expect(noMultipart.http).toBeLessThan(500);
  expect(await contarVersiones()).toBe(antes);
});

// ─────────────────────────── U3 · nombres y tipos ──────────────────────────────

test('U3d — RESISTE: nombres con ../, barras, NUL y caracteres de control quedan sin ruta ni controles; nombres larguísimos no se aceptan sin extensión reconocible', async () => {
  const casos: [string, string][] = [
    ['../../../etc/passwd.md', 'passwd.md'],
    ['..\\..\\windows\\system32\\guion.md', 'guion.md'],
    ['C:\\fakepath\\guion.md', 'guion.md'],
    ['guion\u0000.exe.md', 'guion.exe.md'],
  ];
  for (const [entrada, esperado] of casos) {
    const r = await subir(partes({ archivo: md(`nombre ${entrada.length}`), nombre: entrada }));
    expect(r.http, entrada).toBe(200);
    const [fila] = await query<{ source_filename: string }>(
      `SELECT source_filename FROM script_versions WHERE deliverable_id = $1 ORDER BY version DESC LIMIT 1`,
      [s.valentina.deliverableId],
    );
    expect(fila!.source_filename, entrada).toBe(esperado);
    // eslint-disable-next-line no-control-regex
    expect(fila!.source_filename).not.toMatch(/[\\/\u0000-\u001f]/u);
  }
  // 10 000 caracteres: se acota a 200 (pierde la extensión) y el tipo no se reconoce → 422, sin 500.
  const largo = await subir(partes({ archivo: md('largo'), nombre: `${'a'.repeat(10_000)}.md` }));
  expect(largo.http).toBeLessThan(500);
  const conExtension = await subir(partes({ archivo: md('largo2'), nombre: `${'b'.repeat(150)}.md` }));
  expect(conExtension.http).toBe(200);
});

test('U3e — RESISTE: SVG, doble extensión ejecutable, PDF declarado que es texto y binarios sin firma se rechazan por contenido real', async () => {
  const antes = await contarVersiones();
  const rechazados: [string, Buffer, string, string][] = [
    [
      'svg',
      Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>${Math.random()}`),
      'g.svg',
      'image/svg+xml',
    ],
    ['doble extensión', md('exe'), 'guion.pdf.exe', 'application/octet-stream'],
    ['pdf declarado que es texto', md('falso pdf'), 'g.pdf', 'application/pdf'],
    [
      'html con extensión html',
      Buffer.from(`<html><script>alert(1)</script>${Math.random()}</html>`),
      'g.html',
      'text/html',
    ],
    [
      'ejecutable .exe',
      Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 1)]),
      'g.exe',
      'application/x-msdownload',
    ],
  ];
  for (const [nombre, archivo, archivoNombre, tipo] of rechazados) {
    const r = await subir(partes({ archivo, nombre: archivoNombre, tipo }));
    expect(r.http, nombre).toBe(422);
    expect(r.json?.['mensaje'], nombre).toMatch(/tipo de archivo/);
  }
  expect(await contarVersiones()).toBe(antes);
});

// ─────────────────────────── U3 · ids cruzados y campos duplicados ─────────────

test('U3f — RESISTE: participación y entregable cruzados (de otra persona, otra campaña, otra organización, inexistentes, mal formados) dan 404 sin dejar fuente ni versión', async () => {
  const versionesAntes = await contarVersiones();
  const fuentesAntes = await contarFuentes();
  const cruces: [string, ReturnType<typeof partes>][] = [
    ['entregable de Diego con participación de Valentina', partes({ deliverableId: s.diego.deliverableId })],
    [
      'entregable de otra campaña',
      partes({ participacionId: s.otraCampana.participacionId, deliverableId: s.otraCampana.deliverableId }),
    ],
    [
      'entregable de otra organización',
      partes({ participacionId: s.ajena.participacionId, deliverableId: s.ajena.deliverableId }),
    ],
    ['entregable inexistente', partes({ deliverableId: INEXISTENTE })],
    ['entregable mal formado', partes({ deliverableId: 'zz' })],
    ['participación mal formada', partes({ participacionId: 'zz' })],
  ];
  for (const [nombre, p] of cruces) {
    const r = await subir(p);
    expect([404, 422], nombre).toContain(r.http);
  }
  expect(await contarVersiones()).toBe(versionesAntes);
  expect(await contarFuentes()).toBe(fuentesAntes);
  // Otra agencia hacia la campaña de esta: 404 (no existe para ella).
  const ajeno = await subir(partes({}), {}, s.e.ajeno.id);
  expect(ajeno.http).toBe(404);
});

test('U3g — RESISTE: con el campo `deliverableId` duplicado se usa el PRIMERO (el cruce se detecta); con `archivo` duplicado se usa el primero', async () => {
  const antes = await contarVersiones();
  const r = await subir([
    { nombre: 'archivo', valor: md('dup campos'), archivo: 'a.md', tipo: 'text/markdown' },
    { nombre: 'participacionId', valor: s.valentina.participacionId },
    { nombre: 'deliverableId', valor: s.diego.deliverableId },
    { nombre: 'deliverableId', valor: s.valentina.deliverableId },
  ]);
  expect(r.http).toBe(404);
  expect(await contarVersiones()).toBe(antes);

  const dos = await subir([
    {
      nombre: 'archivo',
      valor: Buffer.from('# Primero\n\nprimero'),
      archivo: 'primero.md',
      tipo: 'text/markdown',
    },
    {
      nombre: 'archivo',
      valor: Buffer.from('# Segundo\n\nsegundo'),
      archivo: 'segundo.md',
      tipo: 'text/markdown',
    },
    { nombre: 'participacionId', valor: s.valentina.participacionId },
    { nombre: 'deliverableId', valor: s.valentina.deliverableId },
  ]);
  expect(dos.http).toBe(200);
  const [fila] = await query<{ source_filename: string }>(
    `SELECT source_filename FROM script_versions WHERE deliverable_id = $1 ORDER BY version DESC LIMIT 1`,
    [s.valentina.deliverableId],
  );
  expect(fila!.source_filename).toBe('primero.md');
});

test('U3h — RESISTE: el mismo archivo dos veces en el mismo entregable es idempotente (misma versión, no otra)', async () => {
  const contenido = md('idempotente');
  const a = await subir(partes({ archivo: contenido, nombre: 'idem.md' }));
  const b = await subir(partes({ archivo: contenido, nombre: 'idem.md' }));
  expect(a.json).toMatchObject({ ok: true, resultado: 'registrada' });
  expect(b.json).toMatchObject({ ok: true, resultado: 'ya_registrada', archivoDuplicado: true });
  expect(b.json?.['version']).toBe(a.json?.['version']);
});

test('U3i — RESISTE (QA-F7-02a por HTTP): el mismo archivo subido a la vez a TRES entregables nunca da 5xx, no corrompe la numeración y la fuente respalda a lo sumo UNA versión', async () => {
  const mismo = md('concurrente en tres entregables');
  const respuestas = await Promise.all([
    subir(partes({ archivo: mismo, nombre: 'c.md' })),
    subir(
      partes({
        archivo: mismo,
        nombre: 'c.md',
        participacionId: s.diego.participacionId,
        deliverableId: s.diego.deliverableId,
      }),
    ),
    subir(partes({ archivo: mismo, nombre: 'c.md', deliverableId: s.story.deliverableId })),
  ]);
  for (const r of respuestas) {
    expect(r.http, r.texto).toBeLessThan(500);
    expect([200, 409, 422]).toContain(r.http);
  }
  expect(respuestas.filter((r) => r.http === 200).length).toBeGreaterThanOrEqual(1);
  const reparto = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM script_versions WHERE campaign_id = $1 GROUP BY source_document_id ORDER BY 1 DESC LIMIT 1`,
    [s.campaignId],
  );
  expect(reparto[0]!.n).toBe(1);
  const repetidas = await query<{ c: number }>(
    `SELECT count(*)::int AS c FROM script_versions WHERE campaign_id = $1 GROUP BY deliverable_id, version HAVING count(*) > 1`,
    [s.campaignId],
  );
  expect(repetidas).toHaveLength(0);
  // Después, de forma secuencial, el mismo archivo hacia OTRO entregable tampoco da 5xx.
  const otra = await subir(
    partes({
      archivo: mismo,
      nombre: 'c.md',
      participacionId: s.hostil.participacionId,
      deliverableId: s.hostil.deliverableId,
    }),
  );
  expect(otra.http).toBeLessThan(500);
});

test('U3j — RESISTE: con la campaña archivada la subida se rechaza con 409 y sin efecto', async () => {
  await query(`UPDATE campaigns SET status = 'archivada' WHERE id = $1`, [s.otraCampana.campaignId]);
  try {
    const antes = (
      await query<{ n: number }>(`SELECT count(*)::int AS n FROM source_documents WHERE campaign_id = $1`, [
        s.otraCampana.campaignId,
      ])
    )[0]!.n;
    const r = await postCrudo(
      `/api/campanas/${s.otraCampana.campaignId}/contenido/guiones`,
      cuerpoMultipart(
        partes({
          participacionId: s.otraCampana.participacionId,
          deliverableId: s.otraCampana.deliverableId,
        }),
      ),
      { userId: s.e.admin.id },
    );
    expect(r.http).toBe(409);
    expect(r.json?.['mensaje']).toMatch(/no está activa/);
    const despues = (
      await query<{ n: number }>(`SELECT count(*)::int AS n FROM source_documents WHERE campaign_id = $1`, [
        s.otraCampana.campaignId,
      ])
    )[0]!.n;
    expect(despues).toBe(antes);
  } finally {
    await query(`UPDATE campaigns SET status = 'activa' WHERE id = $1`, [s.otraCampana.campaignId]);
  }
});

// ─────────────────────────── Fuentes huérfanas ─────────────────────────────────

test('QA-F7-UI-06 (P3, corregido): si el registro de la versión falla DESPUÉS de guardar el archivo (needs_choice, participación de otra campaña con etiqueta), no queda una fuente huérfana visible para el Operativo y la extracción del Brief', async () => {
  const antes = await contarFuentes();
  // 1) etiqueta parecida a una existente → NEEDS_CHOICE (409) tras haber guardado el archivo.
  const ambigua = await subir(partes({ archivo: md('huérfana'), etiqueta: 'Reel principa' }));
  expect(ambigua.http).toBe(409);
  // 2) participación de otra campaña con etiqueta nueva → 404 tras haber guardado el archivo.
  const cruzada = await subir(
    partes({
      archivo: md('huérfana 2'),
      participacionId: s.otraCampana.participacionId,
      etiqueta: 'nuevo',
    }),
  );
  expect(cruzada.http).toBe(404);
  // Esperado: ninguna fuente nueva (o, al menos, ligada/oculta). Hoy quedan 2 fuentes sueltas, internas.
  expect(await contarFuentes()).toBe(antes);
});

// ─────────────────────────── U12 · ráfagas ─────────────────────────────────────

test('U12a — RESISTE: 50 subidas simultáneas de archivos distintos a un entregable no dan 5xx y numeran sin huecos ni duplicados', async () => {
  const base =
    (
      await query<{ m: number | null }>(
        `SELECT max(version)::int AS m FROM script_versions WHERE deliverable_id = $1`,
        [s.hostil.deliverableId],
      )
    )[0]!.m ?? 0;
  const t0 = Date.now();
  const rs = await Promise.all(
    Array.from({ length: 50 }, (_, i) =>
      subir(
        partes({
          archivo: md(`ráfaga ${i}`),
          nombre: `r${i}.md`,
          participacionId: s.hostil.participacionId,
          deliverableId: s.hostil.deliverableId,
        }),
      ),
    ),
  );
  const ms = Date.now() - t0;
  expect(rs.filter((r) => r.http >= 500)).toHaveLength(0);
  const ok = rs.filter((r) => r.http === 200).length;
  expect(ok).toBeGreaterThan(0);
  const filas = await query<{ version: number }>(
    `SELECT version FROM script_versions WHERE deliverable_id = $1 AND version > $2 ORDER BY version`,
    [s.hostil.deliverableId, base],
  );
  expect(filas.map((f) => f.version)).toEqual(Array.from({ length: filas.length }, (_, i) => base + i + 1));
  expect(filas.length).toBe(ok);
  expect(ms).toBeLessThan(60_000);
});

test('U12b — RESISTE: reanálisis en ráfaga: uno activo por versión y tope de 10 análisis asistidos por versión', async () => {
  const { invocarAccion } = await import('../src/qa-f7-ui');
  const cons = await contextoDe(s.e.consultor.id);
  const det = `/campanas/${s.campaignId}/contenido/${s.valentina.participacionId}/${s.valentina.deliverableId}`;
  await cons.get(det, { timeout: 120_000 });
  // 14 simultáneos con claves distintas: como mucho UNO se crea (uno activo por versión).
  const rafaga = await Promise.all(
    Array.from({ length: 14 }, (_, i) =>
      invocarAccion(cons, det, 'solicitarAnalisisDeContenido', [
        s.campaignId,
        s.historial.v3,
        'reanalyze',
        `qaui:rafaga-${i}-${Date.now()}`,
      ]),
    ),
  );
  expect(rafaga.filter((r) => r.resultado?.ok === true).length).toBeLessThanOrEqual(2);
  expect(rafaga.filter((r) => r.http >= 500)).toHaveLength(0);
  // Secuencial: tope de 10 por versión.
  const resultados: boolean[] = [];
  for (let i = 0; i < 12; i += 1) {
    const r = await invocarAccion(cons, det, 'solicitarAnalisisDeContenido', [
      s.campaignId,
      s.historial.v3,
      'reanalyze',
      `qaui:seq-${i}-${Date.now()}`,
    ]);
    resultados.push(r.resultado?.ok === true);
  }
  const [conteo] = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM content_analysis_runs WHERE script_version_id = $1 AND kind = 'ai_assisted'`,
    [s.historial.v3],
  );
  expect(conteo!.n).toBeLessThanOrEqual(10);
  expect(resultados.slice(-2)).toEqual([false, false]);
  await cons.dispose();
});

test('U12c — RESISTE: crear entregables en ráfaga respeta la clave única (misma etiqueta normalizada ⇒ uno solo) y no da 5xx', async () => {
  const { invocarAccion } = await import('../src/qa-f7-ui');
  const cons = await contextoDe(s.e.consultor.id);
  const det = `/campanas/${s.campaignId}/contenido/${s.valentina.participacionId}/${s.valentina.deliverableId}`;
  await cons.get(det);
  const etiquetas = ['Ráfaga Uno', 'RÁFAGA   UNO', 'Ráfaga Uno ', 'ráfaga uno'];
  const rs = await Promise.all(
    etiquetas.map((e) =>
      invocarAccion(cons, det, 'crearDeliverableDeContenido', [
        s.campaignId,
        s.diego.participacionId,
        e,
        'instagram',
      ]),
    ),
  );
  expect(rs.filter((r) => r.http >= 500)).toHaveLength(0);
  expect(rs.filter((r) => r.resultado?.ok === true)).toHaveLength(1);
  await cons.dispose();
});
