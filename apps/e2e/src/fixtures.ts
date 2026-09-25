/**
 * Fixtures de Playwright — Sprint 6, Checkpoint 2.
 *
 * Reutiliza las mismas funciones de `packages/db` que ya prueba
 * `brief-workspace.test.ts` (nunca SQL propio, nunca una segunda forma de
 * crear una campaña). Cada prueba crea su propia campaña desechable y la
 * borra al terminar (INC-001A) — nunca P80, nunca el seed compartido.
 *
 * Candado explícito: como estas funciones se llaman desde un proceso de
 * Node normal (Playwright), no desde `vitest` (que sí tiene el candado de
 * `packages/db/vitest.setup.ts`), este archivo repite la misma
 * verificación a mano — nunca corre contra una base que no termine en
 * `_test`.
 */
import {
  crearBriefManual,
  descartarPregunta,
  findUserByEmail,
  generarPreguntas,
  listarPreguntas,
  query,
  responderPregunta,
  transicionarBrief,
} from '@tcl-kol-os/db';
import { eliminarCampanaDePrueba } from '@tcl-kol-os/db/test-utils';
import type { User } from '@tcl-kol-os/domain';

function candadoDeBaseDePrueba(): void {
  const url = process.env['DATABASE_URL'] ?? '';
  let nombre = '';
  try {
    nombre = new URL(url).pathname.replace(/^\//, '');
  } catch {
    // deja `nombre` vacío, falla abajo igual
  }
  if (!nombre.endsWith('_test')) {
    throw new Error(
      `Sprint 6 E2E: DATABASE_URL debe apuntar a una base "_test" (INC-001A). Recibido: "${nombre || url}".`,
    );
  }
}

export interface Actores {
  readonly admin: User;
  readonly director: User;
  readonly consultor: User;
  readonly cliente: User;
  readonly ajeno: User;
}

export async function cargarActores(): Promise<Actores> {
  candadoDeBaseDePrueba();
  const [admin, director, consultor, cliente, ajeno] = await Promise.all([
    findUserByEmail('gerardo@smartpr.co'),
    findUserByEmail('director@smartpr.co'),
    findUserByEmail('consultor@smartpr.co'),
    findUserByEmail('marena@tcl.com'),
    findUserByEmail('ajeno@otraagencia.co'),
  ]);
  if (!admin || !director || !consultor || !cliente || !ajeno) {
    throw new Error('Sprint 6 E2E: falta un usuario sembrado — ¿corrió `npm run seed` contra esta base?');
  }
  return { admin, director, consultor, cliente, ajeno };
}

const campanasCreadas: string[] = [];

export async function nuevaCampanaConBrief(
  admin: User,
  etiqueta: string,
  opciones?: { productos?: number; generarPreguntasCriticas?: boolean },
): Promise<{ campaignId: string; versionId: string }> {
  candadoDeBaseDePrueba();
  const campana = await query<{ id: string }>(
    `INSERT INTO campaigns (organization_id, name, owner_id, created_by)
     VALUES ($1, $2, $3, $3) RETURNING id`,
    [admin.organizationId, `E2E · ${etiqueta} · ${Date.now()}`, admin.id],
  );
  const campaignId = campana[0]!.id;
  campanasCreadas.push(campaignId);

  if (opciones?.productos) {
    const productos = await query<{ id: string }>(`SELECT id FROM products LIMIT $1`, [opciones.productos]);
    for (const [i, p] of productos.entries()) {
      await query(
        `INSERT INTO campaign_products (campaign_id, product_id, rol, prioridad) VALUES ($1, $2, $3, $4)`,
        [campaignId, p.id, i === 0 ? 'flagship' : 'secundario', i + 1],
      );
    }
  }

  const creado = await crearBriefManual(admin, campaignId);
  if (!creado.ok) throw new Error(`Sprint 6 E2E: no se pudo crear el brief manual — ${creado.error.message}`);

  if (opciones?.generarPreguntasCriticas) {
    await generarPreguntas(admin, creado.value.versionId);
  }

  return { campaignId, versionId: creado.value.versionId };
}

/** Mismo patrón que `client-review.test.ts`/`brief-workspace.test.ts`: llega a `internal_review` real. */
export async function completarHastaInternalReview(
  admin: User,
  campaignId: string,
  versionId: string,
): Promise<void> {
  await generarPreguntas(admin, versionId);
  const preguntas = await listarPreguntas(admin, campaignId, { status: 'pendiente' });
  if (!preguntas.ok) return;
  for (const p of preguntas.value) {
    if (p.criticidad === 'critico') {
      let valor: unknown = `Respuesta de prueba para ${p.key}`;
      if (p.key.includes('fecha'))
        valor = { tipo: 'exacta', fecha: '2026-09-04', textoOriginal: '2026-09-04' };
      else if (p.key === 'objetivo.tipo') valor = 'awareness';
      else if (p.key === 'mandatorios')
        valor = [{ categoria: 'mensaje', descripcion: 'Mencionar el hashtag oficial de la campaña.' }];
      else if (p.key === 'practico.restricciones')
        valor = ['Único canal de venta autorizado: el que declare el cliente.'];
      const resultado = await responderPregunta(admin, p.id, { answerValue: valor });
      if (!resultado.ok) await descartarPregunta(admin, p.id, 'No se pudo responder automáticamente.');
    } else {
      await descartarPregunta(admin, p.id, 'No aplica: sin evidencia real disponible en esta prueba.');
    }
  }
  const resultado = await transicionarBrief(admin, versionId, 'internal_review');
  if (!resultado.ok)
    throw new Error(`Sprint 6 E2E: no se pudo llegar a internal_review — ${resultado.error.message}`);
}

/**
 * Borra las campañas que este archivo de prueba creó. Deliberadamente NO
 * cierra el pool de conexiones (`closePool`) — varios `.spec.ts` corren en
 * el mismo proceso de Playwright (`workers: 1`) y cerrarlo aquí rompería al
 * siguiente archivo. El proceso del worker se encarga de cerrar los
 * sockets al terminar.
 */
export async function limpiarTodo(): Promise<void> {
  candadoDeBaseDePrueba();
  if (campanasCreadas.length > 0) {
    await eliminarCampanaDePrueba(campanasCreadas.splice(0, campanasCreadas.length));
  }
}
