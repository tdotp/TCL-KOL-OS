/**
 * E5-3 a E5-6 · La extracción, del worker a la base.
 *
 * Estas pruebas verifican el reparto de responsabilidades, no la calidad del
 * modelo. Concretamente: que esta capa **solo entregue al worker fragmentos que
 * el usuario podía ver**, y que lo que vuelve se persista con las mismas reglas
 * que rigen a un campo escrito a mano.
 *
 * Sprint 4, cierre: `persistirExtraccion` ya no crea la versión — la recibe
 * de `obtenerOCrearVersionDeTrabajo` (DEC-024). Estas pruebas siembran su
 * propia versión de trabajo antes de persistir, igual que haría `extraerBrief`.
 *
 * Las que llaman al modelo de verdad están marcadas y cuestan unos centavos de
 * dólar por corrida; se saltan solas si el worker no responde, para que una
 * suite completa no dependa de tener todo levantado.
 *
 * Requiere: docker compose up -d db worker
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, query, transaction } from './client.ts';
import { obtenerOCrearVersionDeTrabajo } from './brief-version.ts';
import {
  camposDeVersion,
  extraerCampos,
  persistirExtraccion,
  type CampoExtraido,
  type ResultadoExtraccion,
} from './extraction.ts';

let orgId: string;
/** Campaña real, de solo lectura: se usa únicamente para leer fragmentos ya procesados. */
let campaignId: string;
let userId: string;
let orgAjena: string;
let campanaAjena: string;

/**
 * Campaña PROPIA de esta corrida, desechable — mismo motivo que ya documenta
 * `brief-rules.test.ts`: `obtenerOCrearVersionDeTrabajo` (DEC-024) REUTILIZA
 * cualquier versión `es` no terminal que encuentre. Sobre una campaña
 * compartida como la P80 del seed, eso significa reutilizar (y luego borrar
 * en la limpieza) una versión real que alguien más pudo haber dejado ahí.
 * Aquí nunca se toca la campaña compartida más que para LEER sus fragmentos.
 */
let campanaDePrueba: string;
let campaignProductId: string | undefined;
let campaignProductIdAjeno: string | undefined;

let hayWorker = false;
const versionesCreadas: string[] = [];

beforeAll(async () => {
  const [propia] = await query<{ org: string; camp: string; usr: string }>(
    `SELECT c.organization_id AS org, c.id AS camp, u.id AS usr
       FROM campaigns c
       JOIN users u ON u.organization_id = c.organization_id AND u.email = 'gerardo@smartpr.co'
      WHERE EXISTS (
              SELECT 1 FROM source_documents s
               WHERE s.campaign_id = c.id AND s.status = 'procesado')
      LIMIT 1`,
  );
  if (!propia) throw new Error('Se necesita una campaña con al menos una fuente procesada.');

  orgId = propia.org;
  campaignId = propia.camp;
  userId = propia.usr;

  const [ajena] = await query<{ org: string; camp: string }>(
    `SELECT organization_id AS org, id AS camp FROM campaigns WHERE organization_id <> $1 LIMIT 1`,
    [orgId],
  );
  orgAjena = ajena!.org;
  campanaAjena = ajena!.camp;

  // Campaña propia y desechable, con dos productos reales del catálogo
  // (nunca los de la campaña compartida) para las pruebas de anclaje.
  const campana = await query<{ id: string }>(
    `INSERT INTO campaigns (organization_id, name, owner_id, created_by)
     VALUES ($1, $2, $3, $3) RETURNING id`,
    [orgId, `Extracción · corrida de prueba ${Date.now()}`, userId],
  );
  campanaDePrueba = campana[0]!.id;

  const productosCatalogo = await query<{ id: string }>(`SELECT id FROM products LIMIT 2`);
  for (const [i, p] of productosCatalogo.entries()) {
    await query(
      `INSERT INTO campaign_products (campaign_id, product_id, rol, prioridad)
       VALUES ($1, $2, $3, $4)`,
      [campanaDePrueba, p.id, i === 0 ? 'flagship' : 'secundario', i + 1],
    );
  }
  const productos = await query<{ id: string }>(
    `SELECT id FROM campaign_products WHERE campaign_id = $1 ORDER BY prioridad`,
    [campanaDePrueba],
  );
  campaignProductId = productos[0]?.id;

  const [productoAjeno] = await query<{ id: string }>(
    `SELECT id FROM campaign_products WHERE campaign_id <> $1 LIMIT 1`,
    [campanaDePrueba],
  );
  campaignProductIdAjeno = productoAjeno?.id;

  hayWorker = await workerVivo();
});

afterAll(async () => {
  if (versionesCreadas.length > 0) {
    // Una versión aprobada es inmutable pero sí se puede borrar en limpieza:
    // el trigger protege contra edición, no contra DELETE de la versión.
    await query(`DELETE FROM brief_versions WHERE id = ANY($1::uuid[])`, [versionesCreadas]);
  }
  if (campanaDePrueba) {
    // Arrastra en cascada el brief, versiones y campaign_products propios —
    // nunca toca la campaña compartida.
    await query(`DELETE FROM campaigns WHERE id = $1`, [campanaDePrueba]);
  }
  await closePool();
});

async function workerVivo(): Promise<boolean> {
  try {
    const url = (process.env['AI_WORKER_URL'] ?? 'http://localhost:8000').replace(/\/+$/, '');
    const r = await fetch(`${url}/ready`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return false;
    return ((await r.json()) as { ai_enabled?: boolean }).ai_enabled === true;
  } catch {
    return false;
  }
}

/**
 * Siembra una versión de trabajo nueva (DEC-024) sobre la campaña PROPIA de
 * esta corrida — nunca sobre la campaña compartida, precisamente para que
 * `obtenerOCrearVersionDeTrabajo` no pueda reutilizar (ni el `afterAll`
 * borrar) una versión real que no creó esta prueba.
 */
async function nuevaVersion(): Promise<string> {
  const version = await transaction((client) =>
    obtenerOCrearVersionDeTrabajo(client, {
      campaignId: campanaDePrueba,
      organizationId: orgId,
      createdBy: userId,
    }),
  );
  versionesCreadas.push(version.versionId);
  return version.versionId;
}

// ─────────────────── Lo que se le entrega al worker ───────────────────────────

describe('el worker solo ve fragmentos ya autorizados', () => {
  it('exige organización y campaña', async () => {
    await expect(extraerCampos('', campaignId)).rejects.toThrow(/exige organización y campaña/);
    await expect(extraerCampos(orgId, '')).rejects.toThrow(/exige organización y campaña/);
  });

  it('una campaña sin fuentes procesadas no llega a llamar al modelo', async () => {
    // Falla antes de gastar una llamada, y lo dice en términos accionables.
    await expect(extraerCampos(orgAjena, campanaAjena)).rejects.toThrow(
      /no tiene fuentes procesadas/,
    );
  });

  it('la organización equivocada no puede extraer de una campaña ajena', async () => {
    // Mismo campaignId, organización distinta: no hay fragmentos que entregar.
    await expect(extraerCampos(orgAjena, campaignId)).rejects.toThrow(
      /no tiene fuentes procesadas/,
    );
  });
});

// ─────────────────────────── Persistencia ─────────────────────────────────────

/** Resultado sintético: prueba la persistencia sin gastar una llamada al modelo. */
function resultadoDePrueba(campos: CampoExtraido[]): ResultadoExtraccion {
  return {
    modelo: 'modelo/de-prueba',
    nivel: 'eficiente',
    promptVersion: 'prueba-1',
    inputHash: 'a'.repeat(64),
    costoUsd: 0.000123,
    latenciaMs: 1234,
    promptTokens: 100,
    completionTokens: 50,
    generationId: 'gen-de-prueba',
    descartes: [],
    campos,
  };
}

describe('lo persistido respeta las reglas del brief', () => {
  it('guarda campos y evidencias, y deja el AIRun con su costo', async () => {
    const [frag] = await query<{ id: string; source_id: string }>(
      `SELECT f.id, f.source_id
         FROM source_fragments f
         JOIN source_documents s ON s.id = f.source_id
        WHERE s.campaign_id = $1 LIMIT 1`,
      [campaignId],
    );

    const versionId = await nuevaVersion();
    const resultado = resultadoDePrueba([
      {
        key: 'mensaje_principal.beneficio_diferencial',
        value: 'Pantalla que se lee bajo el sol',
        status: 'found',
        criticidad: 'claim',
        confidence: 0.9,
        nota: null,
        productoId: null,
        evidence: [
          {
            fragmentId: frag!.id,
            sourceId: frag!.source_id,
            quote: 'cita de prueba',
            relation: 'soporta',
          },
        ],
      },
      {
        key: 'practico.presupuesto',
        value: null,
        status: 'not_found',
        criticidad: 'informativo',
        confidence: null,
        nota: null,
        productoId: null,
        evidence: [],
      },
    ]);

    const guardado = await persistirExtraccion({ organizationId: orgId, campaignId, versionId, resultado });

    expect(guardado.campos).toBe(2);
    expect(guardado.evidencias).toBe(1);

    const [run] = await query<{ cost_usd: string; model: string; task: string; tier: string }>(
      `SELECT cost_usd, model, task, tier FROM ai_runs WHERE id = $1`,
      [guardado.aiRunId],
    );
    expect(run!.task).toBe('extraer_campos');
    expect(run!.model).toBe('modelo/de-prueba');
    expect(Number(run!.cost_usd)).toBeCloseTo(0.000123, 6);
  });

  it('la versión nace en borrador: la IA no aprueba (ADR-002)', async () => {
    const versionId = await nuevaVersion();
    const resultado = resultadoDePrueba([
      {
        key: 'contexto.categoria',
        value: 'Smartphones',
        status: 'found',
        criticidad: 'informativo',
        confidence: null,
        nota: null,
        productoId: null,
        evidence: [],
      },
    ]);

    await persistirExtraccion({ organizationId: orgId, campaignId, versionId, resultado });

    const [v] = await query<{ status: string; approved_at: string | null }>(
      `SELECT status::text, approved_at FROM brief_versions WHERE id = $1`,
      [versionId],
    );
    expect(v!.status).toBe('draft');
    expect(v!.approved_at).toBeNull();
  });

  it('un conflicto se guarda sin valor, con sus dos evidencias', async () => {
    const frags = await query<{ id: string; source_id: string }>(
      `SELECT f.id, f.source_id
         FROM source_fragments f
         JOIN source_documents s ON s.id = f.source_id
        WHERE s.campaign_id = $1 LIMIT 2`,
      [campaignId],
    );

    const versionId = await nuevaVersion();
    const resultado = resultadoDePrueba([
      {
        key: 'practico.fecha_inicio',
        // El worker ya lo anula; que la base lo reciba anulado igual es la red
        // de seguridad: dos capas, no una convención.
        value: 'Septiembre 2026',
        status: 'conflict',
        criticidad: 'critico',
        confidence: null,
        nota: null,
        productoId: null,
        evidence: [
          {
            fragmentId: frags[0]!.id,
            sourceId: frags[0]!.source_id,
            quote: 'septiembre',
            relation: 'soporta',
          },
          {
            fragmentId: frags[1]!.id,
            sourceId: frags[1]!.source_id,
            quote: 'octubre',
            relation: 'contradice',
          },
        ],
      },
    ]);

    await persistirExtraccion({ organizationId: orgId, campaignId, versionId, resultado });

    const campos = await camposDeVersion(versionId);
    const conflicto = campos.find((c) => c.key === 'practico.fecha_inicio')!;
    expect(conflicto.status).toBe('conflict');
    expect(conflicto.value).toBeNull();
    expect(conflicto.evidencias).toHaveLength(2);
  });

  it('la evidencia trae el localizador para abrir la fuente (prueba 19)', async () => {
    const [frag] = await query<{ id: string; source_id: string }>(
      `SELECT f.id, f.source_id
         FROM source_fragments f
         JOIN source_documents s ON s.id = f.source_id
        WHERE s.campaign_id = $1
          AND (f.slide IS NOT NULL OR f.page IS NOT NULL OR f.section IS NOT NULL)
        LIMIT 1`,
      [campaignId],
    );

    const versionId = await nuevaVersion();
    await persistirExtraccion({
      organizationId: orgId,
      campaignId: campanaDePrueba,
      versionId,
      resultado: resultadoDePrueba([
        {
          key: 'marca_producto[].rtbs',
          value: 'Pantalla AMOLED',
          status: 'found',
          criticidad: 'claim',
          confidence: null,
          nota: null,
          productoId: campaignProductId ?? null,
          evidence: [
            {
              fragmentId: frag!.id,
              sourceId: frag!.source_id,
              quote: 'AMOLED',
              relation: 'soporta',
            },
          ],
        },
      ]),
    });

    // La versión de trabajo se reutiliza entre pruebas de este describe
    // (DEC-024): se busca el campo por clave Y producto, nunca por posición.
    const campos = await camposDeVersion(versionId);
    const campo = campos.find(
      (c) => c.key === 'marca_producto[].rtbs' && c.campaignProductId === (campaignProductId ?? null),
    )!;
    const ev = campo.evidencias[0]!;
    expect(ev.filename).toBeTruthy();
    expect(ev.page !== null || ev.slide !== null || ev.section !== null).toBe(true);
    // El campo queda anclado al producto correcto de la campaña, no huérfano.
    expect(campo.campaignProductId).toBe(campaignProductId ?? null);
  });
});

// ────── Anclaje de producto verificable (DEC-023, pruebas 11, 12, 20) ─────────

describe('anclaje de producto al persistir la extracción', () => {
  it('rechaza toda la extracción si el worker devuelve un producto de otra campaña (prueba 12)', async () => {
    if (!campaignProductIdAjeno) {
      console.warn('No hay una segunda campaña con producto para esta prueba; se omite.');
      return;
    }
    const versionId = await nuevaVersion();
    const resultado = resultadoDePrueba([
      {
        key: 'marca_producto[].rtbs',
        value: 'Algo',
        status: 'found',
        criticidad: 'claim',
        confidence: null,
        nota: null,
        productoId: campaignProductIdAjeno,
        evidence: [],
      },
    ]);

    await expect(
      persistirExtraccion({ organizationId: orgId, campaignId: campanaDePrueba, versionId, resultado }),
    ).rejects.toThrow(/no pertenece a esta campaña/);

    // Nada quedó persistido para ESTE producto ajeno: el rechazo es de toda
    // la extracción, no parcial. Se busca por clave Y producto — la versión
    // de trabajo se reutiliza entre pruebas (DEC-024) y puede tener otras
    // filas legítimas con la misma clave ancladas a productos distintos.
    const campos = await camposDeVersion(versionId);
    expect(
      campos.find((c) => c.key === 'marca_producto[].rtbs' && c.campaignProductId === campaignProductIdAjeno),
    ).toBeUndefined();
  });

  it('rechaza un producto inventado que no existe en ninguna campaña (prueba 11)', async () => {
    const versionId = await nuevaVersion();
    const resultado = resultadoDePrueba([
      {
        key: 'marca_producto[].rtbs',
        value: 'Algo',
        status: 'found',
        criticidad: 'claim',
        confidence: null,
        nota: null,
        productoId: '00000000-0000-0000-0000-000000000000',
        evidence: [],
      },
    ]);

    await expect(
      persistirExtraccion({ organizationId: orgId, campaignId: campanaDePrueba, versionId, resultado }),
    ).rejects.toThrow(/no pertenece a esta campaña/);
  });

  it('cada producto válido de la campaña queda en su propia fila, sin mezclar valores (prueba 20)', async () => {
    const productos = await query<{ id: string }>(
      `SELECT id FROM campaign_products WHERE campaign_id = $1 ORDER BY prioridad`,
      [campanaDePrueba],
    );
    if (productos.length < 2) {
      console.warn('Esta campaña no es multiproducto; se omite la prueba 20 a nivel de repositorio.');
      return;
    }

    const versionId = await nuevaVersion();
    const resultado = resultadoDePrueba(
      productos.map((p, i) => ({
        key: 'marca_producto[].rtbs',
        value: `RTBS del producto ${i}`,
        status: 'found' as const,
        criticidad: 'claim' as const,
        confidence: null,
        nota: null,
        productoId: p.id,
        evidence: [],
      })),
    );

    await persistirExtraccion({ organizationId: orgId, campaignId: campanaDePrueba, versionId, resultado });

    const campos = await camposDeVersion(versionId);
    const filas = campos.filter((c) => c.key === 'marca_producto[].rtbs');
    expect(filas).toHaveLength(productos.length);
    const valores = new Set(filas.map((f) => f.value));
    expect(valores.size).toBe(productos.length);
    const idsAnclados = new Set(filas.map((f) => f.campaignProductId));
    expect(idsAnclados).toEqual(new Set(productos.map((p) => p.id)));
  });
});

// ────────────────── Contra el modelo real (cuesta dinero) ─────────────────────

describe('extracción contra el modelo real', () => {
  it(
    'produce campos verificados y una versión aprobable',
    async () => {
      if (!hayWorker) {
        console.warn('Worker no disponible o AI_ENABLED=false: se omite la extracción real.');
        return;
      }

      const resultado = await extraerCampos(orgId, campaignId);
      expect(resultado.campos.length).toBeGreaterThan(0);
      expect(resultado.costoUsd).toBeGreaterThan(0);

      // Lo esencial: ningún claim encontrado se queda sin respaldo. El worker
      // ya bajó a not_found los que no pudo verificar.
      const claimsSinRespaldo = resultado.campos.filter(
        (c) => c.criticidad === 'claim' && c.status === 'found' && c.evidence.length === 0,
      );
      expect(claimsSinRespaldo).toEqual([]);

      // Y ningún not_found conserva valor.
      const ausentesConValor = resultado.campos.filter(
        (c) => c.status === 'not_found' && c.value !== null,
      );
      expect(ausentesConValor).toEqual([]);

      // Esta prueba persiste sobre la campaña COMPARTIDA a propósito: es la
      // única que valida el flujo real de punta a punta contra el material
      // real de P80. Por eso, a diferencia de todo lo demás en este archivo,
      // su versión NUNCA se agrega a `versionesCreadas` — un incidente real
      // de este mismo cierre (ver HANDOFF) confirmó que reutilizar-y-luego-
      // borrar en `afterAll` puede destruir una versión de trabajo genuina de
      // otra sesión. Terminar en `approved` dentro de la misma prueba es la
      // manera segura de dejar constancia sin necesitar borrarla después.
      const version = await transaction((client) =>
        obtenerOCrearVersionDeTrabajo(client, { campaignId, organizationId: orgId, createdBy: userId }),
      );
      await persistirExtraccion({ organizationId: orgId, campaignId, versionId: version.versionId, resultado });

      // La prueba de fuego: la base la deja aprobar, porque todo claim cita.
      await expect(
        query(`UPDATE brief_versions SET status='approved', approved_at=now() WHERE id=$1`, [
          version.versionId,
        ]),
      ).resolves.toBeDefined();
    },
    { timeout: 120_000 },
  );
});
