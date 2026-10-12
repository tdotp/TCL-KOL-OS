import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { COLUMNAS_CSV_TCL, CLAVES_DE_DTO_TCL } from '@tcl-kol-os/domain';
import { limpiarOperacion } from '../src/operacion';
import { login } from '../src/login';
import { gotoConReintento } from '../src/nav';
import { idDeAccion } from '../src/qa-f7-ui';
import {
  CENTINELA_TCL,
  TODOS_LOS_CENTINELAS_TCL,
  VISIBLE_TCL,
  contextoHttp,
  huellaDeEscrituras,
  parsearCsv,
  sembrarEscenarioTcl,
  type EscenarioTcl,
} from '../src/tcl';

/**
 * V2 · Fase 9 — dashboard TCL de solo lectura. El cliente (marena@tcl.com) ve SOLO la proyección de las campañas
 * compartidas: ningún centinela (borrador, guion rechazado, hallazgos, comentarios internos, fuente interna, fee,
 * factura, pago, PII) en DOM, respuesta cruda, cabeceras ni export; el personal interno y otras agencias reciben
 * 404 en `/tcl`; el cliente no puede escribir por ninguna vía; las rutas legadas redirigen o dan 404.
 */
test.describe.configure({ mode: 'serial' });
test.afterAll(async () => {
  await limpiarOperacion();
});

let t: EscenarioTcl;
let clienteId = '';
const SECCIONES = ['', '/influencers', '/contenido', '/operacion', '/kpi', '/documentos', '/brief'] as const;
const rutaTcl = (id: string, seccion = ''): string => `/tcl/campanas/${id}${seccion}`;

test.beforeAll(async () => {
  t = await sembrarEscenarioTcl('e2e-f9-tcl');
  clienteId = t.op.cliente.id;
});

function sinCentinelas(texto: string, donde: string): void {
  for (const c of TODOS_LOS_CENTINELAS_TCL)
    expect(texto, `«${c}» no debe estar en ${donde}`).not.toContain(c);
  for (const id of [
    t.operacion.envioId,
    t.operacion.obligacionId,
    t.operacion.documentoId,
    t.operacion.piiRecordId,
    t.versiones.aprobada.v1,
    t.versiones.rechazada.versionId,
    t.documentoInternoId,
  ]) {
    expect(texto, `un id interno no debe estar en ${donde}`).not.toContain(id);
  }
}

/** Barrido completo de una ruta como cliente: DOM, respuesta cruda y cabeceras. */
async function barrer(page: Page, ruta: string): Promise<number> {
  const r = await gotoConReintento(page, ruta);
  const estado = r?.status() ?? 0;
  sinCentinelas(await page.content(), `el DOM de ${ruta}`);
  const cruda = await page.request.get(ruta);
  sinCentinelas(await cruda.text(), `la respuesta cruda de ${ruta}`);
  for (const [n, v] of Object.entries(cruda.headers()))
    sinCentinelas(`${n}: ${v}`, `las cabeceras de ${ruta}`);
  return estado;
}

async function filas(page: Page, ruta: string, testid: string): Promise<string[][]> {
  await gotoConReintento(page, ruta);
  return page
    .getByTestId(testid)
    .evaluateAll((trs) =>
      trs.map((tr) =>
        Array.from(tr.querySelectorAll('th,td')).map((c) =>
          (c.textContent ?? '').replace(/\s+/g, ' ').trim(),
        ),
      ),
    );
}

test('TCL-01 — marena ve /tcl solo con las campañas compartidas y el shell apunta a /tcl', async ({
  page,
}) => {
  await login(page, 'marena@tcl.com');
  await expect(page).toHaveURL(/\/tcl$/);
  expect(await barrer(page, '/tcl')).toBe(200);
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.locator('h1')).toHaveText('Campañas');
  const enlaces = await page
    .locator('main a[href^="/tcl/campanas/"]')
    .evaluateAll((as) => as.map((a) => a.getAttribute('href')));
  expect(enlaces).toContain(rutaTcl(t.campaignId));
  expect(enlaces).not.toContain(rutaTcl(t.op.otraCampanaId));
  expect(enlaces).not.toContain(rutaTcl(t.op.campanaAjenaId));
  await expect(page.locator('table caption')).toHaveCount(1);
  await expect(page.locator('main table th[scope="col"]').first()).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Navegación principal' }).getByRole('link', { name: 'Campañas' }),
  ).toHaveAttribute('href', '/tcl');
});

test('TCL-02 — recorre todas las pantallas: contenido correcto, accesibilidad y cero centinelas', async ({
  page,
}) => {
  await login(page, 'marena@tcl.com');
  for (const s of SECCIONES) {
    const ruta = rutaTcl(t.campaignId, s);
    expect(await barrer(page, ruta), ruta).toBe(200);
    await expect(page.locator('h1'), ruta).toHaveCount(1);
    await expect(
      page.locator('nav[aria-label="Secciones de la campaña"] [aria-current="page"]'),
      ruta,
    ).toHaveCount(1);
    // Solo lectura: nada de formularios, campos ni botones en el contenido.
    await expect(
      page.locator('main form, main input, main textarea, main select, main button'),
      ruta,
    ).toHaveCount(0);
    const cuerpo = await page.locator('main').innerText();
    expect(cuerpo, ruta).not.toMatch(/publicaciones/i);
    for (const tabla of await page.locator('main table').all()) {
      await expect(tabla.locator('caption')).toHaveCount(1);
      await expect(tabla.locator('thead th:not([scope="col"])')).toHaveCount(0);
    }
  }

  const rutaContenido = rutaTcl(t.campaignId, '/contenido');
  const contenido = await filas(page, rutaContenido, 'fila-contenido');
  expect(contenido.length).toBeGreaterThanOrEqual(3);
  const estados = contenido.map((f) => f[3]);
  expect(estados.filter((e) => e === 'Aprobado')).toHaveLength(1);
  expect(estados.filter((e) => e === 'Pendiente de aprobación').length).toBe(contenido.length - 1);

  const operacion = await filas(page, rutaTcl(t.campaignId, '/operacion'), 'fila-operacion');
  expect(operacion.length).toBe(3);
  for (const f of operacion) expect(f.slice(-2)).toEqual(['No disponible', 'No disponible']);

  const kpi = await filas(page, rutaTcl(t.campaignId, '/kpi'), 'fila-kpi');
  expect(kpi).toHaveLength(1);
  expect(kpi[0]!.join(' ')).toContain('50.000');
  expect(kpi[0]!.join(' ')).toContain('61.420');
  expect(kpi[0]!.join(' ')).toContain('Cumplido');

  const documentos = (await filas(page, rutaTcl(t.campaignId, '/documentos'), 'fila-documento')).map(
    (f) => f[0],
  );
  expect(documentos).toContain(VISIBLE_TCL.documentoCompartido);
  expect(documentos.join(' ')).not.toContain(CENTINELA_TCL.fuenteInterna);

  await gotoConReintento(page, rutaTcl(t.campaignId, '/brief'));
  const brief = await page.locator('main').innerText();
  expect(brief).toContain(VISIBLE_TCL.tono);
  expect(brief).toContain(VISIBLE_TCL.oneLine);
  for (const omitido of [
    CENTINELA_TCL.borradorDeBrief,
    CENTINELA_TCL.presupuestoDeBrief,
    CENTINELA_TCL.feeEnBrief,
  ]) {
    expect(brief).not.toContain(omitido);
  }
});

test('TCL-03 — campañas internas o de otra agencia por UUID directo: 404 uniforme en todas las pantallas y el export', async ({
  page,
}) => {
  await login(page, 'marena@tcl.com');
  const inexistente = '00000000-0000-4000-8000-000000000000';
  const ref = await page.request.get(rutaTcl(inexistente));
  expect(ref.status()).toBe(404);
  for (const id of [t.op.otraCampanaId, t.op.campanaAjenaId, inexistente, 'no-es-uuid']) {
    for (const s of SECCIONES) {
      const r = await page.request.get(rutaTcl(id, s));
      expect(r.status(), `${id}${s}`).toBe(404);
      expect(await r.text()).not.toContain(t.nombreDeCampana);
    }
    for (const f of ['csv', 'json']) {
      expect((await page.request.get(`/api/tcl/campanas/${id}/export?formato=${f}`)).status()).toBe(404);
    }
  }
});

test('TCL-04 — personal interno y otra agencia: 404 en /tcl y en el export; sin sesión: login', async ({
  page,
  browser,
}) => {
  for (const email of [
    'gerardo@smartpr.co',
    'director@smartpr.co',
    'consultor@smartpr.co',
    'ajeno@otraagencia.co',
  ]) {
    await login(page, email);
    for (const ruta of ['/tcl', rutaTcl(t.campaignId), rutaTcl(t.campaignId, '/kpi')]) {
      const r = await page.request.get(ruta);
      expect(r.status(), `${email} ${ruta}`).toBe(404);
    }
    for (const f of ['csv', 'json']) {
      const r = await page.request.get(`/api/tcl/campanas/${t.campaignId}/export?formato=${f}`);
      expect(r.status(), `${email} export ${f}`).toBe(404);
      sinCentinelas(await r.text(), 'el 404 del export');
    }
    await page.context().clearCookies();
  }
  const anonimo = await browser.newContext({ baseURL: 'http://localhost:3017' });
  const p = await anonimo.newPage();
  await p.goto('/tcl');
  await expect(p).toHaveURL(/\/login/);
  await p.goto(rutaTcl(t.campaignId));
  await expect(p).toHaveURL(/\/login/);
  expect((await p.request.get(`/api/tcl/campanas/${t.campaignId}/export?formato=csv`)).status()).toBe(404);
  await anonimo.close();
});

test('TCL-05 — export CSV/JSON: cabeceras seguras, sin centinelas y paridad con la interfaz', async ({
  page,
}) => {
  await login(page, 'marena@tcl.com');
  await gotoConReintento(page, rutaTcl(t.campaignId));
  // El enlace del resumen descarga de verdad.
  const descarga = page.waitForEvent('download');
  await page.getByTestId('export-csv').click();
  const d = await descarga;
  expect(d.suggestedFilename()).toMatch(/^tcl-[a-z0-9-]+-\d{8}\.csv$/);
  const csvDescargado = readFileSync((await d.path())!, 'utf8');

  const base = `/api/tcl/campanas/${t.campaignId}/export`;
  const csv = await page.request.get(`${base}?formato=csv`);
  const json = await page.request.get(`${base}?formato=json`);
  for (const [r, tipo] of [
    [csv, 'text/csv'],
    [json, 'application/json'],
  ] as const) {
    expect(r.status()).toBe(200);
    expect(r.headers()['content-type']).toContain(tipo);
    expect(r.headers()['content-disposition']).toMatch(
      /^attachment; filename="tcl-[a-z0-9-]+-\d{8}\.(csv|json)"$/,
    );
    expect(r.headers()['x-content-type-options']).toBe('nosniff');
    expect(r.headers()['cache-control']).toBe('private, no-store');
  }
  const csvTexto = await csv.text();
  const jsonTexto = await json.text();
  for (const [texto, donde] of [
    [csvTexto, 'el CSV'],
    [jsonTexto, 'el JSON'],
    [csvDescargado, 'el CSV descargado'],
  ] as const) {
    sinCentinelas(texto, donde);
  }
  expect((await page.request.get(`${base}?formato=xml`)).status()).toBe(404);

  // Columnas ⊆ DTO; claves del JSON ⊆ DTO.
  const dto = new Set<string>(Object.values(CLAVES_DE_DTO_TCL).flat());
  const tabla = parsearCsv(csvTexto);
  const cabecera = tabla[0]!;
  expect(cabecera).toEqual([...COLUMNAS_CSV_TCL]);
  for (const col of cabecera) expect(col === 'seccion' || dto.has(col), col).toBe(true);
  const claves = new Set<string>();
  const recorrer = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(recorrer);
    else if (v !== null && typeof v === 'object')
      for (const [k, x] of Object.entries(v)) {
        claves.add(k);
        recorrer(x);
      }
  };
  const p = JSON.parse(jsonTexto) as {
    campana: { id: string; conteos: Record<string, number> };
    influencers: unknown[];
    contenido: { estado: string }[];
    kpis: { kpis: unknown[] }[];
    documentos: { titulo: string }[];
    operacion: unknown[];
  };
  recorrer(p);
  for (const k of claves) expect(dto.has(k), `clave ${k}`).toBe(true);

  // Paridad con la UI.
  expect(p.campana.id).toBe(t.campaignId);
  const ui = {
    influencers: await filas(page, rutaTcl(t.campaignId, '/influencers'), 'fila-influencer'),
    contenido: await filas(page, rutaTcl(t.campaignId, '/contenido'), 'fila-contenido'),
    operacion: await filas(page, rutaTcl(t.campaignId, '/operacion'), 'fila-operacion'),
    kpi: await filas(page, rutaTcl(t.campaignId, '/kpi'), 'fila-kpi'),
    documentos: await filas(page, rutaTcl(t.campaignId, '/documentos'), 'fila-documento'),
  };
  expect(ui.influencers).toHaveLength(p.influencers.length);
  expect(ui.influencers).toHaveLength(p.campana.conteos['influencersActivos']!);
  expect(ui.contenido).toHaveLength(p.contenido.length);
  expect(ui.contenido.filter((f) => f[3] === 'Aprobado')).toHaveLength(
    p.contenido.filter((c) => c.estado === 'aprobado').length,
  );
  expect(ui.operacion).toHaveLength(p.operacion.length);
  expect(ui.kpi).toHaveLength(p.kpis.flatMap((k) => k.kpis).length);
  expect(ui.documentos.map((f) => f[0]).sort()).toEqual(p.documentos.map((x) => x.titulo).sort());
  // Filas del CSV por sección = filas de la UI.
  const secciones = tabla.slice(1).map((f) => f[0]);
  const n = (s: string): number => secciones.filter((x) => x === s).length;
  expect(n('influencer')).toBe(ui.influencers.length);
  expect(n('contenido')).toBe(ui.contenido.length);
  expect(n('documento')).toBe(ui.documentos.length);
});

test('TCL-06 — el cliente no escribe: métodos, API internas y server actions fallan sin cambiar nada', async ({
  page,
  browser,
}) => {
  // Las pantallas internas se visitan como consultor para que sus server actions figuren en el manifiesto.
  const ctxInterno = await browser.newContext({ baseURL: 'http://localhost:3017' });
  const interno = await ctxInterno.newPage();
  await login(interno, 'consultor@smartpr.co');
  for (const r of [
    `/campanas/${t.campaignId}/contenido`,
    `/campanas/${t.campaignId}/operacion`,
    `/campanas/${t.campaignId}/fuentes`,
  ]) {
    await gotoConReintento(interno, r);
  }
  await ctxInterno.close();

  await login(page, 'marena@tcl.com');
  const antes = await huellaDeEscrituras(t.campaignId, clienteId);
  const export_ = `/api/tcl/campanas/${t.campaignId}/export?formato=csv`;
  for (const m of ['post', 'put', 'patch', 'delete'] as const) {
    const r = await page.request[m](export_, { data: '{}' });
    expect([404, 405], `${m} export`).toContain(r.status());
  }
  const apis = [
    `/api/campanas/${t.campaignId}/contenido/guiones`,
    `/api/campanas/${t.campaignId}/chat/adjuntos`,
    `/api/campanas/${t.campaignId}/operacion/evidencia`,
  ];
  for (const api of apis) {
    for (const m of ['post', 'put', 'patch', 'delete'] as const) {
      const r = await page.request[m](api, {
        multipart: {
          archivo: { name: 'intruso.md', mimeType: 'text/markdown', buffer: Buffer.from('# intruso') },
          participacionId: t.s.valentina.participacionId,
          deliverableId: t.s.valentina.deliverableId,
        },
      });
      expect([404, 405], `${m} ${api}`).toContain(r.status());
    }
  }

  // Server actions con argumentos reales, repetidas como un atacante con el id capturado.
  const ctx = await contextoHttp(clienteId);
  const v = t.versiones;
  const intentos: [string, string, unknown[]][] = [
    [
      'crearDeliverableDeContenido',
      `/campanas/${t.campaignId}/contenido`,
      [t.campaignId, t.s.valentina.participacionId, 'Intruso'],
    ],
    [
      'anadirComentarioDeContenido',
      `/campanas/${t.campaignId}/contenido`,
      [t.campaignId, v.aprobada.v1, 'intruso'],
    ],
    [
      'solicitarCambiosDeContenido',
      `/campanas/${t.campaignId}/contenido`,
      [t.campaignId, v.rechazada.versionId, [{ body: 'x' }]],
    ],
    [
      'aprobarVersionDeGuion',
      `/campanas/${t.campaignId}/contenido`,
      [t.campaignId, v.rechazada.versionId, 'huella'],
    ],
  ];
  for (const [nombre, ruta, args] of intentos) {
    const r = await ctx.post(ruta, {
      headers: {
        'next-action': idDeAccion(nombre),
        'content-type': 'text/plain;charset=UTF-8',
        accept: 'text/x-component',
      },
      data: JSON.stringify(args),
    });
    const texto = await r.text();
    sinCentinelas(texto, `la respuesta de ${nombre}`);
    expect(texto, nombre).not.toMatch(/"ok":true/);
  }
  await ctx.dispose();
  expect(await huellaDeEscrituras(t.campaignId, clienteId)).toBe(antes);
});

test('TCL-07 — rutas legadas: el cliente es redirigido a /tcl o recibe 404, sin filtrar nada', async ({
  page,
}) => {
  await login(page, 'marena@tcl.com');
  const id = t.campaignId;
  const destinos: [string, string][] = [
    ['/', '/tcl'],
    ['/campanas', '/tcl'],
    [`/campanas/${id}`, rutaTcl(id)],
    [`/campanas/${id}/brief`, rutaTcl(id, '/brief')],
    [`/campanas/${id}/brief/editar`, rutaTcl(id, '/brief')],
    [`/campanas/${id}/brief/workspace`, rutaTcl(id, '/brief')],
    [`/campanas/${id}/fuentes`, rutaTcl(id, '/documentos')],
  ];
  for (const [desde, hacia] of destinos) {
    await gotoConReintento(page, desde);
    await expect(page, desde).toHaveURL(new RegExp(`${hacia}$`));
    sinCentinelas(await page.content(), `el DOM tras ${desde}`);
  }
  for (const ruta of [
    `/campanas/${id}/contenido`,
    `/campanas/${id}/contenido/${t.s.valentina.participacionId}`,
    `/campanas/${id}/operacion`,
    `/campanas/${id}/operacion/${t.s.valentina.participacionId}`,
    `/campanas/${id}/chat`,
    `/campanas/${id}/fuentes/${t.documentoInternoId}`,
    '/campanas/nueva',
  ]) {
    const r = await gotoConReintento(page, ruta);
    expect(r?.status(), ruta).toBe(404);
    // (el id pedido aparece en la propia URL del 404: solo se comprueban los centinelas de texto)
    const html = await page.content();
    for (const c of TODOS_LOS_CENTINELAS_TCL) expect(html, `«${c}» en el 404 de ${ruta}`).not.toContain(c);
  }
  // Una campaña no compartida termina en el mismo 404 de /tcl.
  const r = await gotoConReintento(page, `/campanas/${t.op.otraCampanaId}/brief`);
  expect(r?.status()).toBe(404);
});
