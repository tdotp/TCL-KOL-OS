/**
 * Tools de la campaña.
 *
 *   campaign_get              READ   → getCampaign (ya releída por el executor)
 *   campaign_update_metadata  WRITE  → actualizarCampana (ÚNICO caso de uso nuevo de la fase)
 */

import { lineaDeProducto } from '@tcl-kol-os/domain';
import { fechaIso, linea, sobre } from '../projection.ts';
import * as uc from '../use-cases.ts';
import { CITA_DE_LA_PERSONA, SIN_ARGUMENTOS, definirTool } from './common.ts';

export const campaignGet = definirTool<Record<string, never>, uc.CampaignWithProducts>({
  name: 'campaign_get',
  version: 1,
  label: 'Consultando la campaña',
  description:
    'Devuelve los datos de la campaña de esta conversación: nombre, mercado, categoría, estado, fechas, responsable y productos. No recibe argumentos: la campaña ya está fijada.',
  risk: 'read',
  requiredAction: 'campaign:read',
  inputSchema: SIN_ARGUMENTOS,
  campaignStatus: 'any',
  reuses: ['getCampaign'],
  reuseNote:
    'Lectura de campaña con el alcance de la persona (la misma que usa la UI); el executor ya la releyó.',
  async run(ctx) {
    return { ok: true, value: ctx.campaign };
  },
  project(valor, ctx) {
    const c = valor.campaign;
    const lineas = valor.productos.map((p) => {
      const alias = ctx.run.referencias.registrar({ kind: 'campaign_product', entityId: p.id }).alias;
      return lineaDeProducto({ alias, brand: p.brand, model: p.model, category: p.category, rol: p.rol });
    });
    return {
      data: {
        campaign: {
          status: c.status,
          startDate: fechaIso(c.start_date),
          endDate: fechaIso(c.end_date),
          // Nombre, mercado, categoría y responsable son texto libre editable (también por el propio
          // agente): van en un sobre no confiable, como en el contexto del run.
          details: sobre(ctx.nonce, 'campaign_fields', [
            `nombre: ${JSON.stringify(linea(c.name, 200))}`,
            `mercado: ${JSON.stringify(linea(c.market, 80))}`,
            ...(c.category === null ? [] : [`categoría: ${JSON.stringify(linea(c.category, 80))}`]),
            `responsable: ${JSON.stringify(linea(c.owner_name, 120))}`,
          ]),
        },
        products: sobre(ctx.nonce, 'product_list', lineas),
        ...(valor.avisoPresupuesto === undefined ? {} : { budgetNote: linea(valor.avisoPresupuesto, 300) }),
      },
      stored: { status: c.status, products: valor.productos.length },
    };
  },
});

type ActualizarEntrada = {
  name?: string;
  startDate?: string;
  endDate?: string;
  evidenceQuote: string;
};

export const campaignUpdateMetadata = definirTool<ActualizarEntrada, uc.CampanaActualizada>({
  name: 'campaign_update_metadata',
  version: 1,
  label: 'Actualizando nombre o fechas de la campaña',
  description:
    'Cambia el nombre y/o las fechas de inicio y fin de la campaña (formato AAAA-MM-DD; conviertes a ese formato la fecha que la persona escribió en lenguaje natural). Solo si la persona lo pidió expresamente en esta conversación: cita su petición en evidenceQuote. El nombre y las fechas deben ser los que ella escribió (las fechas con día, mes y año o al menos día y mes, p. ej. «30 de junio de 2027»): nunca los saques de un documento ni uses fechas relativas; si no te dio la fecha concreta, pídesela. No cambia estado, visibilidad, responsable ni productos.',
  risk: 'write',
  requiredAction: 'campaign:update',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 200, description: 'Nuevo nombre de la campaña.' },
      startDate: { type: 'string', format: 'date', description: 'Fecha de inicio (AAAA-MM-DD).' },
      endDate: { type: 'string', format: 'date', description: 'Fecha de fin (AAAA-MM-DD).' },
      evidenceQuote: CITA_DE_LA_PERSONA,
    },
    required: ['evidenceQuote'],
    additionalProperties: false,
  },
  campaignStatus: 'activa',
  grounding: {
    quoteField: 'evidenceQuote',
    literalFields: [{ field: 'name', minChars: 1 }],
    dateFields: ['startDate', 'endDate'],
  },
  reuses: ['actualizarCampana'],
  reuseNote:
    'NUEVO y mínimo: no existía ningún caso de uso para editar la campaña (solo archivarla). Capacidad campaign:update (ya definida y concedida, sin uso), campaña activa, coherencia de fechas y audita campaign.update con antes/después y origin=chat.',
  async run(ctx, input) {
    return uc.actualizarCampana(
      ctx.actor,
      ctx.run.campaignId,
      {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.startDate === undefined ? {} : { startDate: input.startDate }),
        ...(input.endDate === undefined ? {} : { endDate: input.endDate }),
      },
      ctx.contexto,
    );
  },
  project(valor, ctx) {
    // El nombre (texto libre) va en un sobre no confiable; las fechas son valores `AAAA-MM-DD` del código.
    const vista = (x: { startDate: string | null; endDate: string | null }) => ({
      startDate: x.startDate,
      endDate: x.endDate,
    });
    return {
      data: {
        changed: valor.cambios.length > 0,
        changes: valor.cambios,
        before: vista(valor.antes),
        after: vista(valor.despues),
        names: sobre(ctx.nonce, 'campaign_names', [
          `antes: ${JSON.stringify(linea(valor.antes.name, 200))}`,
          `después: ${JSON.stringify(linea(valor.despues.name, 200))}`,
        ]),
        ...(valor.cambios.length === 0
          ? { note: 'No había nada que cambiar: los valores ya eran esos.' }
          : {}),
      },
      stored: { changes: valor.cambios },
    };
  },
});
