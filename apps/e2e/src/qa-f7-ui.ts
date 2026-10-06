/**
 * Helpers del QA adversarial de la capa web de la Fase 7 (U1–U12). Solo para `tests/qa-f7-ui-*.spec.ts`
 * y `playwright.qa-f7-ui.config.ts` (servidor propio en 3040). Todo sintético; la base debe ser `_test`.
 *
 * Aquí viven: la cookie de sesión firmada con el secreto de PRUEBA del servidor 3040, contextos HTTP
 * por rol (sin seguir redirecciones), el descubrimiento y la repetición de server actions (cabecera
 * `Next-Action`, como lo haría un atacante que capturó el id) y un escenario sembrado con casos
 * hostiles y ajenos.
 */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { request, type APIRequestContext, type APIResponse } from '@playwright/test';
import {
  asociarInfluencerACampana,
  crearEntregable,
  crearInfluencer,
  registrarVersionDeGuion,
} from '@tcl-kol-os/db';
import { crearFuenteDeGuionConTexto } from '@tcl-kol-os/db/test-utils';
import type { User } from '@tcl-kol-os/domain';
import {
  TEXTO_SEMBRADO,
  aprobarComoPersona,
  escenarioDeContenido,
  registrarGuionSembrado,
  revisarComoHumano,
  type EscenarioE2E,
} from './contenido';
import { candadoDeBaseDePrueba } from './fixtures';

export const BASE = process.env['QAUI_BASE_URL'] ?? 'http://localhost:3040';
/** Secreto de sesión de PRUEBA del servidor 3040 (el mismo de `playwright.qa-f7-ui.config.ts`). */
const SESSION_SECRET = 'qaui-session-secret-no-es-real-0123456789';

/** Valor de la cookie `tclkolos_session` firmada con el secreto de prueba (mismo formato que la app). */
export function valorDeSesion(userId: string, expiraEn = Date.now() + 60 * 60 * 1000): string {
  const payload = `${userId}.${expiraEn}`;
  const firma = createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${firma}`;
}

/** Contexto HTTP (sin redirecciones) con la sesión de `userId`; sin `userId`, anónimo. */
export async function contextoDe(
  userId?: string,
  cabeceras: Record<string, string> = {},
): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: BASE,
    maxRedirects: 0,
    extraHTTPHeaders: {
      ...(userId === undefined ? {} : { cookie: `tclkolos_session=${valorDeSesion(userId)}` }),
      ...cabeceras,
    },
  });
}

// ─────────────────────────── Server actions ────────────────────────────────────

/** Manifiesto del servidor de desarrollo (`apps/web/.next`, o el distDir propio si se usa `QAUI_DIST_DIR`). */
const MANIFIESTO = join(
  process.cwd(),
  process.env['QAUI_DIST_DIR'] ?? join('..', 'web', '.next'),
  'server',
  'server-reference-manifest.json',
);

/** Id de una server action (por el nombre exportado) leído del manifiesto del servidor de desarrollo. */
export function idDeAccion(nombre: string): string {
  const crudo = JSON.parse(readFileSync(MANIFIESTO, 'utf8')) as {
    node: Record<string, { workers: Record<string, { moduleId: string }> }>;
  };
  for (const [id, v] of Object.entries(crudo.node)) {
    for (const w of Object.values(v.workers)) {
      const decodificado = decodeURIComponent(w.moduleId);
      if (decodificado.includes(`"id":"${id}","exportedName":"${nombre}"`)) return id;
    }
  }
  throw new Error(`No se encontró la server action «${nombre}» en el manifiesto: ¿se visitó su página?`);
}

export interface RespuestaDeAccion {
  readonly http: number;
  readonly cabeceras: Readonly<Record<string, string>>;
  readonly texto: string;
  /** Resultado devuelto por la acción (`{ok, ...}`), o `undefined` si el servidor la rechazó antes. */
  readonly resultado: { ok: boolean; error?: string; codigo?: string; [k: string]: unknown } | undefined;
}

/** Interpreta el flujo RSC de una server action y extrae el objeto devuelto. */
function interpretar(texto: string): RespuestaDeAccion['resultado'] {
  for (const linea of texto.split('\n')) {
    const m = /^\d+:(\{.*\})$/u.exec(linea);
    if (m === null) continue;
    try {
      const o = JSON.parse(m[1]!) as Record<string, unknown>;
      if (typeof o['ok'] === 'boolean') return o as NonNullable<RespuestaDeAccion['resultado']>;
    } catch {
      // línea que no es JSON: se ignora
    }
  }
  return undefined;
}

/**
 * Repite una server action como lo haría un atacante con el id capturado: POST a una página, cabecera
 * `Next-Action` y cuerpo = argumentos en JSON. `args` puede ser cualquier cosa (tipos inesperados).
 */
export async function invocarAccion(
  ctx: APIRequestContext,
  ruta: string,
  nombre: string,
  args: unknown,
  cabeceras: Record<string, string> = {},
): Promise<RespuestaDeAccion> {
  const r: APIResponse = await ctx.post(ruta, {
    headers: {
      'next-action': idDeAccion(nombre),
      'content-type': 'text/plain;charset=UTF-8',
      accept: 'text/x-component',
      ...cabeceras,
    },
    data: JSON.stringify(args),
    timeout: 60_000,
  });
  const texto = await r.text();
  return { http: r.status(), cabeceras: r.headers(), texto, resultado: interpretar(texto) };
}

// ─────────────────────────── Escenario sembrado ────────────────────────────────

export interface EscenarioQa extends EscenarioE2E {
  /** Valentina Ríos / «Reel principal»: V1 aprobada→reemplazada, V2 aprobada vigente, V3 recibida (última). */
  readonly historial: {
    readonly v1: string;
    readonly v2: string;
    readonly v3: string;
    readonly fuentes: string[];
  };
  /** Valentina Ríos / «Story…»: V1 recibida (sin revisión). */
  readonly story: { readonly deliverableId: string; readonly versionId: string; readonly fuenteId: string };
  /** Diego / «Reel principal»: V1 en revisión humana, con un comentario. */
  readonly diegoV1: { readonly versionId: string; readonly fuenteId: string };
  /** Entregable de una influencer con nombre hostil, y su guion. */
  readonly hostil: {
    readonly participacionId: string;
    readonly deliverableId: string;
    readonly versionId: string;
  };
  /** Otra campaña de la MISMA organización (con su propia participación, entregable y versión). */
  readonly otraCampana: {
    readonly campaignId: string;
    readonly participacionId: string;
    readonly deliverableId: string;
    readonly versionId: string;
    readonly fuenteId: string;
  };
  /** Campaña de OTRA organización (con su propia participación, entregable y versión). */
  readonly ajena: {
    readonly campaignId: string;
    readonly participacionId: string;
    readonly deliverableId: string;
    readonly versionId: string;
    readonly fuenteId: string;
  };
}

export const NOMBRE_HOSTIL = 'Eva <img src=x onerror="window.__xss=1"> <script>window.__xss=1</script>';
export const ETIQUETA_HOSTIL = 'Reel <b onmouseover="window.__xss=1">x</b> {{7*7}} ${7*7}';

function exito<T>(r: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}

async function participacionConEntregable(
  actor: User,
  campaignId: string,
  sufijo: string,
  nombre: string,
  etiqueta: string,
): Promise<{ participacionId: string; deliverableId: string; influencerId: string }> {
  const inf = exito(
    await crearInfluencer(actor, {
      displayName: nombre,
      cuentas: [{ platform: 'instagram', handle: `qaui.${sufijo}` }],
    }),
  );
  const ci = exito(await asociarInfluencerACampana(actor, { campaignId, influencerId: inf.influencer.id }));
  const d = exito(await crearEntregable(actor, { campaignInfluencerId: ci.id, label: etiqueta }));
  return { participacionId: ci.id, deliverableId: d.id, influencerId: inf.influencer.id };
}

async function versionEnOtraCampana(
  actor: User,
  campaignId: string,
  participacionId: string,
  deliverableId: string,
  etiqueta: string,
): Promise<{ versionId: string; fuenteId: string }> {
  const fuenteId = await crearFuenteDeGuionConTexto(campaignId, actor, etiqueta, [...TEXTO_SEMBRADO]);
  const r = exito(
    await registrarVersionDeGuion(
      actor,
      {
        campaignId,
        sourceId: fuenteId,
        participation: { participationId: participacionId },
        deliverable: { id: deliverableId },
      },
      { origin: 'ui' },
    ),
  );
  if (r.kind !== 'registered') throw new Error(`no se registró la versión: ${r.kind}`);
  return { versionId: r.version.id, fuenteId };
}

/** Escenario completo del QA (ver `EscenarioQa`). Limpiar con `limpiarContenido()` de `./contenido`. */
export async function sembrarEscenarioQa(nombre: string): Promise<EscenarioQa> {
  candadoDeBaseDePrueba();
  const s = await escenarioDeContenido(nombre);
  const { e } = s;
  const { participacionId, deliverableId } = s.valentina;

  // Historial de Valentina: V1 aprobada, V2 aprobada (V1 queda «reemplazada»), V3 recibida.
  const v1 = await registrarGuionSembrado(s, deliverableId, participacionId, TEXTO_SEMBRADO);
  await revisarComoHumano(v1.versionId, e.consultor);
  const a1 = await aprobarComoPersona(e.director, v1.versionId);
  if (!a1.ok) throw new Error(`no se aprobó la V1: ${a1.error.code}`);
  const v2 = await registrarGuionSembrado(s, deliverableId, participacionId, TEXTO_SEMBRADO);
  await revisarComoHumano(v2.versionId, e.consultor);
  const a2 = await aprobarComoPersona(e.director, v2.versionId);
  if (!a2.ok) throw new Error(`no se aprobó la V2: ${a2.error.code}`);
  const v3 = await registrarGuionSembrado(s, deliverableId, participacionId, TEXTO_SEMBRADO);

  const story = await registrarGuionSembrado(s, s.e.entregables.storyRios, participacionId, TEXTO_SEMBRADO);
  const diegoV1 = await registrarGuionSembrado(
    s,
    s.diego.deliverableId,
    s.diego.participacionId,
    TEXTO_SEMBRADO,
  );
  await revisarComoHumano(diegoV1.versionId, e.consultor, 'Nota <u>de la revisión</u>');

  const hostilBase = await participacionConEntregable(
    e.admin,
    s.campaignId,
    `h${e.sufijo}`,
    NOMBRE_HOSTIL,
    ETIQUETA_HOSTIL,
  );
  s.e.influencerIds.push(hostilBase.influencerId);
  const hostilV = await registrarGuionSembrado(
    s,
    hostilBase.deliverableId,
    hostilBase.participacionId,
    TEXTO_SEMBRADO,
  );

  const otra = await participacionConEntregable(
    e.admin,
    e.otraCampanaId,
    `o${e.sufijo}`,
    'Otra Campaña Influencer',
    'Reel ajeno a la campaña A',
  );
  s.e.influencerIds.push(otra.influencerId);
  const otraV = await versionEnOtraCampana(
    e.consultor,
    e.otraCampanaId,
    otra.participacionId,
    otra.deliverableId,
    `otra-${e.sufijo}`,
  );

  const ajena = await participacionConEntregable(
    e.ajeno,
    e.campanaAjenaId,
    `x${e.sufijo}`,
    'Influencer de otra agencia',
    'Reel de otra agencia',
  );
  s.e.influencerIds.push(ajena.influencerId);
  const ajenaV = await versionEnOtraCampana(
    e.ajeno,
    e.campanaAjenaId,
    ajena.participacionId,
    ajena.deliverableId,
    `ajena-${e.sufijo}`,
  );

  return {
    ...s,
    historial: {
      v1: v1.versionId,
      v2: v2.versionId,
      v3: v3.versionId,
      fuentes: [v1.fuenteId, v2.fuenteId, v3.fuenteId],
    },
    story: { deliverableId: s.e.entregables.storyRios, versionId: story.versionId, fuenteId: story.fuenteId },
    diegoV1,
    hostil: {
      participacionId: hostilBase.participacionId,
      deliverableId: hostilBase.deliverableId,
      versionId: hostilV.versionId,
    },
    otraCampana: {
      campaignId: e.otraCampanaId,
      participacionId: otra.participacionId,
      deliverableId: otra.deliverableId,
      ...otraV,
    },
    ajena: {
      campaignId: e.campanaAjenaId,
      participacionId: ajena.participacionId,
      deliverableId: ajena.deliverableId,
      ...ajenaV,
    },
  };
}

// ─────────────────────────── Subida cruda (multipart a mano) ───────────────────

export interface ParteDeFormulario {
  readonly nombre: string;
  readonly valor: string | Buffer;
  /** Si existe, la parte es un archivo con ese nombre (se escribe tal cual, sin sanear). */
  readonly archivo?: string;
  readonly tipo?: string;
}

/** Cuerpo multipart armado a mano (permite nombres de archivo hostiles, campos duplicados, etc.). */
export function cuerpoMultipart(partes: readonly ParteDeFormulario[], frontera = '----qaui7MA4YWxk'): Buffer {
  const trozos: Buffer[] = [];
  for (const p of partes) {
    const cabecera =
      `--${frontera}\r\nContent-Disposition: form-data; name="${p.nombre}"` +
      (p.archivo === undefined ? '' : `; filename="${p.archivo}"`) +
      `\r\n` +
      (p.archivo === undefined ? '' : `Content-Type: ${p.tipo ?? 'application/octet-stream'}\r\n`) +
      `\r\n`;
    trozos.push(
      Buffer.from(cabecera, 'utf8'),
      Buffer.isBuffer(p.valor) ? p.valor : Buffer.from(p.valor, 'utf8'),
      Buffer.from('\r\n'),
    );
  }
  trozos.push(Buffer.from(`--${frontera}--\r\n`));
  return Buffer.concat(trozos);
}

/** POST crudo (sin ayudas del cliente HTTP) al route handler: controla `Content-Length` y las cabeceras. */
export async function postCrudo(
  ruta: string,
  cuerpo: Buffer,
  opciones: {
    userId?: string;
    cabeceras?: Record<string, string>;
    /** `omitir`: sin Content-Length (chunked). Un número: valor falso declarado. */
    contentLength?: 'omitir' | number;
    frontera?: string;
  } = {},
): Promise<{
  http: number;
  json: Record<string, unknown> | undefined;
  texto: string;
  cabeceras: Record<string, string | string[] | undefined>;
}> {
  const { request: httpRequest } = await import('node:http');
  const url = new URL(ruta, BASE);
  const cabeceras: Record<string, string | number> = {
    'content-type': `multipart/form-data; boundary=${opciones.frontera ?? '----qaui7MA4YWxk'}`,
    ...(opciones.userId === undefined
      ? {}
      : { cookie: `tclkolos_session=${valorDeSesion(opciones.userId)}` }),
    ...(opciones.cabeceras ?? {}),
  };
  if (opciones.contentLength === undefined) cabeceras['content-length'] = cuerpo.length;
  else if (opciones.contentLength === 'omitir') cabeceras['transfer-encoding'] = 'chunked';
  else cabeceras['content-length'] = opciones.contentLength;
  return new Promise((resolver, rechazar) => {
    const req = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'POST',
        headers: cabeceras,
        agent: false,
      },
      (res) => {
        const trozos: Buffer[] = [];
        res.on('data', (t: Buffer) => trozos.push(t));
        res.on('end', () => {
          const texto = Buffer.concat(trozos).toString('utf8');
          let json: Record<string, unknown> | undefined;
          try {
            json = JSON.parse(texto) as Record<string, unknown>;
          } catch {
            json = undefined;
          }
          resolver({ http: res.statusCode ?? 0, json, texto, cabeceras: res.headers });
        });
      },
    );
    req.setTimeout(30_000, () => req.destroy(new Error('timeout')));
    req.on('error', rechazar);
    req.write(cuerpo);
    req.end();
  });
}
