/**
 * Recorrido de integración completo (sección 8 del cierre de Sprint 4):
 * crear campaña → extraerBrief (contrato HTTP real, proveedor falso) →
 * confirmar/corregir campos → generarPreguntas → responderPregunta en las
 * críticas → transicionarBrief(..., 'internal_review'). Y el mismo destino
 * por el camino 100% manual, sin tocar el worker en absoluto.
 *
 * Determinístico y sin red externa (corrección 6): requiere un worker HTTP
 * levantado con `AI_PROVIDER=fake` (ver docs/product/D0-17-cierre-sprint4.md
 * para el comando exacto) — nunca OpenRouter real. Si no hay worker
 * disponible en `AI_WORKER_URL`, el caso que depende de él se omite con
 * aviso; el camino manual no depende de ningún worker y siempre corre.
 *
 * Campaña propia y desechable en cada caso — nunca el seed, nunca P80
 * (INC-001A).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { User } from '@tcl-kol-os/domain';
import { closePool, query } from './client.ts';
import { eliminarCampanaDePrueba } from './test-utils.ts';
import { crearBriefManual } from './manual.ts';
import { confirmarCampo } from './brief-fields.ts';
import { extraerBrief } from './extraction.ts';
import {
  generarPreguntas,
  responderPregunta,
  descartarPregunta,
  listarPreguntas,
} from './local-questions.ts';
import { transicionarBrief } from './transitions.ts';

let orgId: string;
let userId: string;
let actor: User;
const campanasCreadas: string[] = [];

async function nuevaCampanaConProductos(etiqueta: string): Promise<string> {
  const campana = await query<{ id: string }>(
    `INSERT INTO campaigns (organization_id, name, owner_id, created_by)
     VALUES ($1, $2, $3, $3) RETURNING id`,
    [orgId, `E2E · ${etiqueta} · ${Date.now()}`, userId],
  );
  const id = campana[0]!.id;
  campanasCreadas.push(id);

  const productos = await query<{ id: string }>(`SELECT id FROM products LIMIT 2`);
  for (const [i, p] of productos.entries()) {
    await query(
      `INSERT INTO campaign_products (campaign_id, product_id, rol, prioridad) VALUES ($1, $2, $3, $4)`,
      [id, p.id, i === 0 ? 'flagship' : 'secundario', i + 1],
    );
  }
  return id;
}

/** Fuente y fragmento sintéticos, sin depender de ningún archivo real ni de un consumidor activo. */
async function sembrarFuenteProcesada(campaignId: string): Promise<void> {
  const fuente = await query<{ id: string }>(
    `INSERT INTO source_documents
            (campaign_id, organization_id, file_id, filename, type, mime_type, size_bytes,
             hash, status, confidentiality_level, visibility, created_by)
     VALUES ($1, $2, 'e2e-sintetico', 'Brief sintético E2E.md', 'brief_cliente', 'text/markdown', 128,
             md5(random()::text), 'procesado', 'interna', 'interna', $3)
     RETURNING id`,
    [campaignId, orgId, userId],
  );
  await query(
    `INSERT INTO source_fragments (source_id, ordinal, section, linea, text)
     VALUES ($1, 1, 'Contexto', 1, 'Lanzamiento de la línea de smartphones en el segmento medio-alto, en Colombia, para el segundo semestre.')`,
    [fuente[0]!.id],
  );
}

async function completarCriticosPendientes(versionId: string, campaignId: string): Promise<void> {
  await generarPreguntas(actor, versionId);
  const preguntas = await listarPreguntas(actor, campaignId, { status: 'pendiente' });
  if (!preguntas.ok) return;
  for (const p of preguntas.value) {
    if (p.criticidad === 'critico') {
      let valor: unknown = `Respuesta de prueba para ${p.key}`;
      if (p.key.includes('fecha'))
        valor = { tipo: 'exacta', fecha: '2026-09-04', textoOriginal: '2026-09-04' };
      else if (p.key === 'objetivo.tipo') valor = 'awareness';
      else if (p.key === 'mandatorios') valor = [{ categoria: 'mensaje', descripcion: 'Hashtag oficial.' }];
      else if (p.key === 'practico.restricciones') valor = ['Canal de venta autorizado por el cliente.'];
      const respondida = await responderPregunta(actor, p.id, { answerValue: valor });
      if (!respondida.ok) await descartarPregunta(actor, p.id, 'No se pudo responder automáticamente.');
    } else {
      await descartarPregunta(actor, p.id, 'Sin evidencia real disponible en esta prueba.');
    }
  }
}

async function confirmarEncontrados(versionId: string): Promise<void> {
  const filas = await query<{ id: string; revision: number }>(
    `SELECT id, revision FROM brief_fields WHERE brief_version_id = $1 AND status = 'found' AND review_status = 'pending'`,
    [versionId],
  );
  for (const f of filas) {
    await confirmarCampo(actor, versionId, f.id, { revisionEsperada: f.revision });
  }
}

async function hayWorkerFalso(): Promise<boolean> {
  try {
    const url = (process.env['AI_WORKER_URL'] ?? 'http://localhost:8000').replace(/\/+$/, '');
    const r = await fetch(`${url}/ready`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  const [admin] = await query<{ id: string; organization_id: string }>(
    `SELECT id, organization_id FROM users WHERE email = 'gerardo@smartpr.co'`,
  );
  userId = admin!.id;
  orgId = admin!.organization_id;
  actor = {
    id: userId,
    email: 'gerardo@smartpr.co',
    name: 'Gerardo',
    organizationId: orgId,
    role: 'admin',
    status: 'activo',
  };
});

afterAll(async () => {
  for (const id of campanasCreadas) {
    // `eliminarCampanaDePrueba` ya borra `briefs` (que arrastra en cascada
    // `brief_versions → brief_fields → evidence`, por el lado CASCADE) antes
    // que `campaigns` (que arrastra `source_documents`, por el lado
    // RESTRICT) — ese orden basta para que el RESTRICT nunca choque. Un
    // `DELETE FROM brief_versions` aparte, fuera de esa transacción con
    // bypass, lo rechazaría la migración 010 (hallazgo 2).
    await eliminarCampanaDePrueba(id);
  }
  await closePool();
});

describe('recorrido con asistencia (proveedor falso, determinístico)', () => {
  it('crear campaña → extraerBrief real (HTTP, AI_PROVIDER=fake) → completar → internal_review', async () => {
    if (!(await hayWorkerFalso())) {
      console.warn(
        'No hay worker en AI_WORKER_URL con AI_PROVIDER=fake; se omite. ' +
          'Ver docs/product/D0-17-cierre-sprint4.md para levantarlo.',
      );
      return;
    }

    const campaignId = await nuevaCampanaConProductos('asistido');
    await sembrarFuenteProcesada(campaignId);

    const extraido = await extraerBrief(actor, campaignId);
    expect(extraido.ok, !extraido.ok ? extraido.error.message : '').toBe(true);
    if (!extraido.ok) return;

    const [version] = await query<{ status: string }>(
      `SELECT status::text FROM brief_versions WHERE id = $1`,
      [extraido.value.versionId],
    );
    expect(version!.status).toBe('extraction_review');

    await confirmarEncontrados(extraido.value.versionId);
    await completarCriticosPendientes(extraido.value.versionId, campaignId);
    await confirmarEncontrados(extraido.value.versionId);

    // Si quedaron preguntas pendientes tras completar los críticos (poco
    // probable, pero posible si algo quedó sin decidir), se resuelve antes
    // de intentar volver al brief.
    const status = await query<{ status: string }>(`SELECT status::text FROM brief_versions WHERE id = $1`, [
      extraido.value.versionId,
    ]);
    if (status[0]!.status === 'local_questions') {
      const vuelta = await transicionarBrief(actor, extraido.value.versionId, 'extraction_review');
      expect(vuelta.ok, !vuelta.ok ? vuelta.error.message : '').toBe(true);
    }

    const final = await transicionarBrief(actor, extraido.value.versionId, 'internal_review');
    expect(final.ok, !final.ok ? `${final.error.message} ${JSON.stringify(final.error.details)}` : '').toBe(
      true,
    );
  }, 30_000);
});

describe('recorrido 100% manual (sin worker en absoluto)', () => {
  it('crear campaña → brief manual → completar campos → responder preguntas → internal_review', async () => {
    const campaignId = await nuevaCampanaConProductos('manual');

    const creado = await crearBriefManual(actor, campaignId);
    expect(creado.ok).toBe(true);
    if (!creado.ok) return;

    await completarCriticosPendientes(creado.value.versionId, campaignId);

    const status = await query<{ status: string }>(`SELECT status::text FROM brief_versions WHERE id = $1`, [
      creado.value.versionId,
    ]);
    if (status[0]!.status === 'local_questions') {
      // El camino manual nunca pasó por `extraction_review`; se transiciona
      // directo desde `local_questions` no aplica — se documenta como
      // pendiente de siguiente incremento si ocurriera (no debería, porque
      // `crearBriefManual` nace en `draft`, y `generarPreguntas` solo mueve
      // a `local_questions` si el estado actual era `extraction_review`).
      throw new Error('Estado inesperado: local_questions en un brief que nunca pasó por extraction_review.');
    }

    const final = await transicionarBrief(actor, creado.value.versionId, 'internal_review');
    expect(final.ok, !final.ok ? `${final.error.message} ${JSON.stringify(final.error.details)}` : '').toBe(
      true,
    );
    if (final.ok) expect(final.value.status).toBe('internal_review');
  });
});
