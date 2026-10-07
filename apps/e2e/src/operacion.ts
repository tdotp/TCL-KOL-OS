/**
 * Helpers de los E2E de Operación (V2 · Fase 8: acuerdos, logística, facturación/pagos como SEGUIMIENTO, KPI y
 * datos de entrega).
 *
 * Igual que `contenido.ts`: los datos se CREAN con los casos de uso de `packages/db` y sus utilidades de prueba
 * (`@tcl-kol-os/db/test-utils`); las consultas de este archivo son SOLO LECTURAS de verificación sobre la base
 * `_test` aislada (candado de `candadoDeBaseDePrueba`). Todo es sintético (nunca P80 real ni `.env`/`.storage`).
 *
 * Los «centinelas» son valores únicos y reconocibles (fee, cédula, teléfono, dirección, guía, referencia de pago,
 * nombre de archivo de evidencia, nota interna) que se siembran para comprobar que NO aparecen donde no deben.
 */
import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import {
  crearEnvio,
  guardarPii,
  obtenerSeguimientoDePago,
  query,
  registrarDocumentoDeCobro,
  registrarKpiObjetivo,
  registrarMedicionKpi,
  reportarPago,
  transicionarEnvio,
  validarDocumento,
} from '@tcl-kol-os/db';
import {
  type EscenarioDeOperacion,
  claveDePrueba,
  crearEscenarioDeOperacion,
  limpiarEscenarioDeOperacion,
} from '@tcl-kol-os/db/test-utils';
import { candadoDeBaseDePrueba } from './fixtures';
import { loginPorCookie } from './login';

// ─────────────────────────── Centinelas ────────────────────────────────────────

/** Valores únicos que el sistema debe mostrar solo a quien corresponde. */
export const CENTINELA = {
  /** Fee del acuerdo (así lo imprime la interfaz: `7654321.00`). */
  fee: '7654321',
  moneda: 'COP',
  cedula: '7733221100',
  telefono: '3105550142',
  direccion: 'Carrera 99 # 88-77 Torre Centinela',
  transportadora: 'TransCentinela',
  guia: 'TRK-CENTINELA-5521',
  costoDeEnvio: '88123',
  referenciaDePago: 'REF-PAGO-CENTINELA-9913',
  archivoDeEvidencia: 'soporte-centinela-4471.pdf',
  archivoDeCobro: 'cuenta-cobro-centinela-8820.pdf',
  numeroDeDocumento: 'CC-CENTINELA-6612',
  montoDelDocumento: '7654321',
  notaInterna: 'NOTA-INTERNA-CENTINELA-3308',
} as const;

/** Valores personales (datos de entrega): ni el consultor, ni el director, ni el cliente los ven jamás. */
export const CENTINELAS_PII: readonly string[] = [CENTINELA.cedula, CENTINELA.telefono, CENTINELA.direccion];

/** Todos los centinelas de texto (para las barridas del cliente TCL). */
export const TODOS_LOS_CENTINELAS: readonly string[] = [
  CENTINELA.fee,
  CENTINELA.cedula,
  CENTINELA.telefono,
  CENTINELA.direccion,
  CENTINELA.transportadora,
  CENTINELA.guia,
  CENTINELA.costoDeEnvio,
  CENTINELA.referenciaDePago,
  CENTINELA.archivoDeEvidencia,
  CENTINELA.archivoDeCobro,
  CENTINELA.numeroDeDocumento,
  CENTINELA.notaInterna,
];

// ─────────────────────────── Escenario ─────────────────────────────────────────

const escenarios: EscenarioDeOperacion[] = [];

/**
 * Escenario de operación desechable (campaña ACTIVA con productos, tres influencers sintéticos, las cinco personas y
 * una organización ajena). `acuerdo` crea el acuerdo inicial de «Valentina Ríos» con el modo pedido. Limpiar con
 * `limpiarOperacion`.
 */
export async function escenarioDeOperacion(
  nombre: string,
  opciones: { readonly acuerdo?: 'fee' | 'barter' | 'mixed'; readonly monto?: string } = {},
): Promise<EscenarioDeOperacion> {
  candadoDeBaseDePrueba();
  const op = await crearEscenarioDeOperacion(`E2E · ${nombre}`, {
    ...(opciones.acuerdo === undefined
      ? {}
      : {
          acuerdo: {
            mode: opciones.acuerdo,
            ...(opciones.monto === undefined ? {} : { amount: opciones.monto }),
          },
        }),
  });
  escenarios.push(op);
  return op;
}

/** Limpia todo lo creado por `escenarioDeOperacion` en este proceso (en orden inverso: restaura `STORAGE_LOCAL_PATH`). */
export async function limpiarOperacion(): Promise<void> {
  candadoDeBaseDePrueba();
  for (const op of escenarios.splice(0, escenarios.length).reverse()) await limpiarEscenarioDeOperacion(op);
}

/** El selector del login de desarrollo no ofrece al operativo: se entra con la cookie firmada de prueba. */
export async function entrarComoOperativo(page: Page, op: EscenarioDeOperacion): Promise<void> {
  await loginPorCookie(page, op.operativo.id);
}

export function rutaDeOperacion(campaignId: string, participacionId?: string): string {
  const base = `/campanas/${campaignId}/operacion`;
  return participacionId === undefined ? base : `${base}/${participacionId}`;
}

export function rutaDeEvidencia(campaignId: string): string {
  return `/api/campanas/${campaignId}/operacion/evidencia`;
}

// ─────────────────────────── Archivos sintéticos ───────────────────────────────

/** PDF mínimo y válido, de contenido ÚNICO (el hash de la evidencia es por contenido). */
export function pdfSintetico(marca: string = randomBytes(6).toString('hex')): Buffer {
  return Buffer.from(`%PDF-1.4\n% ${marca}\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n`, 'utf8');
}

export interface ArchivoDeSubida {
  readonly name: string;
  readonly mimeType: string;
  readonly buffer: Buffer;
}

export function archivoPdf(nombre: string): ArchivoDeSubida {
  return { name: nombre, mimeType: 'application/pdf', buffer: pdfSintetico() };
}

/** `YYYY-MM-DD` de hace `atras` días (los hechos no pueden estar en el futuro). */
export function dia(atras = 1): string {
  return new Date(Date.now() - atras * 86_400_000).toISOString().slice(0, 10);
}

// ─────────────────────────── Sembrado por casos de uso ─────────────────────────

const UI = { origin: 'ui' } as const;

function exito<T>(
  r: { ok: true; value: T } | { ok: false; error: { code: string; message: string } },
  que: string,
): T {
  if (!r.ok) throw new Error(`Operación E2E: ${que} — ${r.error.code}: ${r.error.message}`);
  return r.value;
}

export interface OperacionSembrada {
  readonly participacionId: string;
  readonly influencerId: string;
  readonly piiRecordId: string;
  readonly envioId: string;
  readonly obligacionId: string;
  readonly documentoId: string;
}

/**
 * Siembra, con los casos de uso y como persona (origen `ui`), una participación con TODOS los centinelas: datos
 * personales, un envío enviado (transportadora, guía, costo, nota interna y un soporte con nombre centinela), un
 * documento de cobro validado (con archivo centinela) y, con `reportarPago`, el pago reportado con su referencia.
 * Requiere el escenario creado con un acuerdo `fee` o `mixed` de «Valentina Ríos» (el monto lleva el fee centinela).
 */
export async function sembrarOperacionConCentinelas(
  op: EscenarioDeOperacion,
  opciones: { readonly reportarPago: boolean },
): Promise<OperacionSembrada> {
  candadoDeBaseDePrueba();
  const ci = op.acuerdoParticipacion;
  if (ci === undefined) throw new Error('Operación E2E: el escenario no tiene acuerdo.');
  const operativo = op.operativo;
  const [fila] = await query<{ influencer_id: string }>(
    `SELECT influencer_id FROM campaign_influencers WHERE id = $1`,
    [ci],
  );
  const influencerId = fila!.influencer_id;

  const pii = exito(
    await guardarPii(
      operativo,
      {
        influencerId,
        documentId: CENTINELA.cedula,
        phone: CENTINELA.telefono,
        address: CENTINELA.direccion,
      },
      UI,
    ),
    'guardar datos personales',
  );
  const piiRecordId = pii.record.recordId;

  const creado = exito(
    await crearEnvio(
      operativo,
      {
        campaignInfluencerId: ci,
        items: [{ campaignProductId: op.productos.p80, quantity: 1 }],
        shippingCost: `${CENTINELA.costoDeEnvio}.00`,
        shippingCurrency: CENTINELA.moneda,
        piiRecordId,
        note: CENTINELA.notaInterna,
        idempotencyKey: claveDePrueba('envio'),
      },
      UI,
    ),
    'crear el envío',
  );
  const preparado = exito(
    await transicionarEnvio(
      operativo,
      {
        shipmentId: creado.envio.id,
        to: 'prepared',
        expectedSeq: creado.envio.rowSeq,
        idempotencyKey: claveDePrueba('prep'),
      },
      UI,
    ),
    'preparar el envío',
  );
  exito(
    await transicionarEnvio(
      operativo,
      {
        shipmentId: creado.envio.id,
        to: 'shipped',
        expectedSeq: preparado.envio.rowSeq,
        idempotencyKey: claveDePrueba('env'),
        happenedOn: dia(2),
        carrier: CENTINELA.transportadora,
        trackingRef: CENTINELA.guia,
        evidencia: {
          archivo: {
            filename: CENTINELA.archivoDeEvidencia,
            contenido: pdfSintetico(),
            tipoDeclarado: 'application/pdf',
          },
          kind: 'guia',
        },
      },
      UI,
    ),
    'enviar el envío',
  );

  const seguimiento = exito(await obtenerSeguimientoDePago(operativo, ci), 'leer el seguimiento de pago');
  if (seguimiento === null) throw new Error('Operación E2E: el acuerdo no generó obligación de pago.');
  const documento = exito(
    await registrarDocumentoDeCobro(
      operativo,
      {
        paymentObligationId: seguimiento.obligation.id,
        documentNumber: CENTINELA.numeroDeDocumento,
        issuedOn: dia(1),
        claimedAmount: `${CENTINELA.montoDelDocumento}.00`,
        claimedCurrency: CENTINELA.moneda,
        archivo: {
          filename: CENTINELA.archivoDeCobro,
          contenido: pdfSintetico(),
          tipoDeclarado: 'application/pdf',
        },
        idempotencyKey: claveDePrueba('doc'),
      },
      UI,
    ),
    'registrar el documento de cobro',
  );
  exito(
    await validarDocumento(
      operativo,
      {
        billingDocumentId: documento.documento.id,
        expectedSeq: documento.documento.rowSeq,
        idempotencyKey: claveDePrueba('val'),
      },
      UI,
    ),
    'validar el documento de cobro',
  );
  if (opciones.reportarPago) {
    const actual = exito(await obtenerSeguimientoDePago(operativo, ci), 'releer el seguimiento de pago');
    exito(
      await reportarPago(
        operativo,
        {
          paymentObligationId: seguimiento.obligation.id,
          expectedSeq: actual!.obligation.rowSeq,
          idempotencyKey: claveDePrueba('pago'),
          paidOn: dia(0),
          externalReference: CENTINELA.referenciaDePago,
        },
        UI,
      ),
      'reportar el pago',
    );
  }
  return {
    participacionId: ci,
    influencerId,
    piiRecordId,
    envioId: creado.envio.id,
    obligacionId: seguimiento.obligation.id,
    documentoId: documento.documento.id,
  };
}

/** Objetivo de Views 50.000 (consultor) y medición 61.420 (operativo) de la participación, por los casos de uso. */
export async function sembrarKpiDeViews(op: EscenarioDeOperacion, participacionId: string): Promise<void> {
  candadoDeBaseDePrueba();
  exito(
    await registrarKpiObjetivo(
      op.consultor,
      {
        campaignInfluencerId: participacionId,
        metric: 'views',
        targetValue: 50_000,
        comparator: 'gte',
        idempotencyKey: claveDePrueba('obj'),
      },
      UI,
    ),
    'registrar el objetivo de KPI',
  );
  exito(
    await registrarMedicionKpi(
      op.operativo,
      {
        campaignInfluencerId: participacionId,
        metric: 'views',
        value: 61_420,
        observedAt: new Date(Date.now() - 86_400_000).toISOString(),
        idempotencyKey: claveDePrueba('med'),
      },
      UI,
    ),
    'registrar la medición de KPI',
  );
}

// ─────────────────────────── Lecturas de verificación en BD ────────────────────

export interface FilaDeObligacion {
  readonly id: string;
  readonly status: string;
  readonly row_seq: number;
}

export async function obligacionesDe(campaignId: string): Promise<FilaDeObligacion[]> {
  candadoDeBaseDePrueba();
  return query<FilaDeObligacion>(
    `SELECT id, status::text AS status, row_seq FROM payment_obligations WHERE campaign_id = $1 ORDER BY created_at, id`,
    [campaignId],
  );
}

/** Cuántos eventos operativos de esa campaña tienen ese tipo (`shipment.delivered`, `payment.reported`…). */
export async function contarEventosOperativos(campaignId: string, tipo: string): Promise<number> {
  candadoDeBaseDePrueba();
  const [fila] = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM operational_events WHERE campaign_id = $1 AND event_type = $2`,
    [campaignId, tipo],
  );
  return fila!.n;
}

export async function tiposDeEventosOperativos(campaignId: string): Promise<string[]> {
  candadoDeBaseDePrueba();
  const filas = await query<{ event_type: string }>(
    `SELECT event_type FROM operational_events WHERE campaign_id = $1 ORDER BY recorded_at, id`,
    [campaignId],
  );
  return filas.map((f) => f.event_type);
}

export async function estadosDeEnvios(campaignId: string): Promise<string[]> {
  candadoDeBaseDePrueba();
  const filas = await query<{ status: string }>(
    `SELECT status::text AS status FROM shipments WHERE campaign_id = $1 ORDER BY created_at, id`,
    [campaignId],
  );
  return filas.map((f) => f.status);
}

export async function contarEnvios(campaignId: string): Promise<number> {
  return (await estadosDeEnvios(campaignId)).length;
}

export interface FilaDeMedicion {
  readonly id: string;
  readonly metric: string;
  readonly value: string;
  readonly supersedes_id: string | null;
  readonly correction_reason: string | null;
}

export async function medicionesDe(campaignId: string): Promise<FilaDeMedicion[]> {
  candadoDeBaseDePrueba();
  return query<FilaDeMedicion>(
    `SELECT id, metric, value::text AS value, supersedes_id, correction_reason
       FROM kpi_measurements WHERE campaign_id = $1 ORDER BY seq`,
    [campaignId],
  );
}

export async function contarVersionesDeAcuerdo(campaignId: string): Promise<number> {
  candadoDeBaseDePrueba();
  const [fila] = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM agreement_versions WHERE campaign_id = $1`,
    [campaignId],
  );
  return fila!.n;
}
