/**
 * V2 · Fase 7 — esquema del contenido (migración 023): invariantes que impone LA BASE.
 *
 * Todo con SQL directo, sin pasar por los casos de uso: lo que la aplicación omita, la base lo
 * rechaza. Tablas y columnas esperadas (y NINGUNA de dinero, envío, KPI, acuerdo, publicación ni
 * listas jsonb de guiones/hallazgos), claves compuestas, índices parciales, triggers, aislamiento
 * por organización y campaña, unicidad de la etiqueta normalizada y los CHECK de coherencia.
 */

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { User } from '@tcl-kol-os/domain';
import { closePool, query, transaction } from './client.ts';
import {
  type EscenarioDeContenido,
  crearEscenarioDeContenido,
  crearFuenteDeGuionDePrueba,
  crearFuenteDePrueba,
  limpiarEscenarioDeContenido,
} from './test-utils.ts';

let e: EscenarioDeContenido;

beforeAll(async () => {
  e = await crearEscenarioDeContenido('F7 esquema');
});
afterAll(async () => {
  await limpiarEscenarioDeContenido(e);
  await closePool();
});

/** Mensaje del rechazo de la base ('' si pasó). */
async function rechazo(sql: string, params: unknown[] = []): Promise<string> {
  try {
    await query(sql, params);
    return '';
  } catch (error) {
    return (error as Error).message;
  }
}

async function conBypass(fn: (c: pg.PoolClient) => Promise<void>): Promise<void> {
  await transaction(async (c) => {
    await c.query(`SET LOCAL tclkolos.permitir_borrado_historico = 'on'`);
    await fn(c);
  });
}

const columnas = async (
  tabla: string,
): Promise<Array<{ column_name: string; data_type: string; is_nullable: string }>> =>
  query(
    `SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [tabla],
  );

const INSERTAR_ENTREGABLE = `INSERT INTO deliverables (organization_id, campaign_id, campaign_influencer_id, platform, label, label_key,
                                                       campaign_product_id, created_by)
                             VALUES ($1, $2, $3, $4::social_platform, $5, $6, $7, $8) RETURNING id`;

let secuencia = 0;
const etiqueta = () => `esquema ${++secuencia} ${Date.now().toString(36)}`;

describe('tablas y columnas esperadas', () => {
  it('deliverables', async () => {
    const cols = await columnas('deliverables');
    expect(cols.map((c) => c.column_name)).toEqual([
      'id',
      'organization_id',
      'campaign_id',
      'campaign_influencer_id',
      'platform',
      'label',
      'label_key',
      'campaign_product_id',
      'status',
      'archived_at',
      'last_version',
      'created_by',
      'created_at',
      'updated_at',
    ]);
    // la plataforma es informativa: nullable; el resto de la identidad no
    const nulos = cols.filter((c) => c.is_nullable === 'YES').map((c) => c.column_name);
    expect(nulos.sort()).toEqual(['archived_at', 'campaign_product_id', 'platform']);
  });

  it('script_versions', async () => {
    const cols = await columnas('script_versions');
    expect(cols.map((c) => c.column_name)).toEqual([
      'id',
      'organization_id',
      'campaign_id',
      'deliverable_id',
      'version',
      'status',
      'source_document_id',
      'source_filename',
      'source_hash',
      'created_by',
      'created_at',
      'updated_at',
      'approved_by',
      'approved_at',
      'approved_via_proposed_action_id',
      'approved_analysis_id',
      'approved_brief_version_id',
      'approval_snapshot',
      'superseded_by_version_id',
      'superseded_at',
    ]);
  });

  it('script_review_comments', async () => {
    const cols = await columnas('script_review_comments');
    expect(cols.map((c) => c.column_name)).toEqual([
      'id',
      'organization_id',
      'campaign_id',
      'script_version_id',
      'author_id',
      'kind',
      'body',
      'locator',
      'origin',
      'chat_message_id',
      'correlation',
      'created_at',
    ]);
    // autor siempre una persona; sin columna de IA ni de sistema: no pueden firmar
    expect(cols.find((c) => c.column_name === 'author_id')?.is_nullable).toBe('NO');
    expect(
      cols
        .map((c) => c.column_name)
        .filter((c) => /ai_|generated|model|prompt|system|status|resolved/.test(c)),
    ).toEqual([]);
  });

  it('NINGUNA columna de fee, pago, envío, KPI, acuerdo ni publicación (DEC-044: eso es de fases posteriores)', async () => {
    for (const tabla of ['deliverables', 'script_versions', 'script_review_comments']) {
      const nombres = (await columnas(tabla)).map((c) => c.column_name);
      expect(
        nombres.filter((c) =>
          /fee|pago|payment|invoice|factur|envio|shipping|kpi|acuerdo|agreement|publica|publication|precio|price|cost/i.test(
            c,
          ),
        ),
        tabla,
      ).toEqual([]);
    }
  });

  it('ninguna lista jsonb de guiones o hallazgos: solo snapshot de aprobación, localizador y correlación', async () => {
    const jsonb: string[] = [];
    for (const tabla of ['deliverables', 'script_versions', 'script_review_comments']) {
      for (const c of await columnas(tabla)) {
        if (c.data_type === 'jsonb' || c.data_type === 'json' || c.data_type === 'ARRAY')
          jsonb.push(`${tabla}.${c.column_name}`);
      }
    }
    expect(jsonb.sort()).toEqual([
      'script_review_comments.correlation',
      'script_review_comments.locator',
      'script_versions.approval_snapshot',
    ]);
  });

  it('un Deliverable es de la participación (CampaignInfluencer), nunca del Influencer', async () => {
    const nombres = (await columnas('deliverables')).map((c) => c.column_name);
    expect(nombres).toContain('campaign_influencer_id');
    expect(nombres).not.toContain('influencer_id');
  });
});

describe('claves foráneas compuestas, índices y triggers', () => {
  async function definicion(nombre: string): Promise<string> {
    const [f] = await query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`,
      [nombre],
    );
    return f?.def ?? '';
  }

  it('las FK compuestas amarran organización y campaña', async () => {
    expect(await definicion('deliverables_campaign_fkey')).toBe(
      'FOREIGN KEY (campaign_id, organization_id) REFERENCES campaigns(id, organization_id) ON DELETE RESTRICT',
    );
    expect(await definicion('deliverables_participacion_fkey')).toBe(
      'FOREIGN KEY (campaign_influencer_id, campaign_id) REFERENCES campaign_influencers(id, campaign_id) ON DELETE RESTRICT',
    );
    expect(await definicion('deliverables_producto_fkey')).toBe(
      'FOREIGN KEY (campaign_product_id, campaign_id) REFERENCES campaign_products(id, campaign_id) ON DELETE RESTRICT',
    );
    expect(await definicion('deliverables_autor_fkey')).toBe(
      'FOREIGN KEY (created_by, organization_id) REFERENCES users(id, organization_id) ON DELETE RESTRICT',
    );
    expect(await definicion('script_versions_entregable_fkey')).toBe(
      'FOREIGN KEY (deliverable_id, organization_id, campaign_id) REFERENCES deliverables(id, organization_id, campaign_id) ON DELETE RESTRICT',
    );
    expect(await definicion('script_versions_fuente_org_fkey')).toBe(
      'FOREIGN KEY (source_document_id, organization_id) REFERENCES source_documents(id, organization_id) ON DELETE RESTRICT',
    );
    expect(await definicion('script_versions_fuente_campaign_fkey')).toBe(
      'FOREIGN KEY (source_document_id, campaign_id) REFERENCES source_documents(id, campaign_id) ON DELETE RESTRICT',
    );
    expect(await definicion('script_versions_accion_fkey')).toBe(
      'FOREIGN KEY (approved_via_proposed_action_id, organization_id, campaign_id) REFERENCES proposed_actions(id, organization_id, campaign_id) ON DELETE RESTRICT',
    );
    expect(await definicion('script_versions_aprobador_fkey')).toContain(
      'FOREIGN KEY (approved_by, organization_id)',
    );
    expect(await definicion('script_versions_brief_fkey')).toContain('REFERENCES brief_versions(id)');
    expect(await definicion('script_review_comments_version_fkey')).toBe(
      'FOREIGN KEY (script_version_id, organization_id, campaign_id) REFERENCES script_versions(id, organization_id, campaign_id) ON DELETE RESTRICT',
    );
    expect(await definicion('script_review_comments_autor_fkey')).toContain(
      'FOREIGN KEY (author_id, organization_id)',
    );
    // la FK de approved_analysis_id hacia los análisis la añade la 024
    const fks = await query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'script_versions'::regclass AND contype = 'f'`,
    );
    expect(fks.map((f) => f.conname)).toContain('script_versions_analisis_fkey');
  });

  it('índices únicos parciales: etiqueta activa por participación y UNA aprobada vigente por entregable', async () => {
    const [clave] = await query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'deliverables_clave_activa_key'`,
    );
    expect(clave?.indexdef).toContain('UNIQUE INDEX');
    expect(clave?.indexdef).toContain('(campaign_influencer_id, label_key)');
    expect(clave?.indexdef).toMatch(/WHERE \(status = 'active'/);
    const [vigente] = await query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'script_versions_aprobada_vigente_key'`,
    );
    expect(vigente?.indexdef).toContain('UNIQUE INDEX');
    expect(vigente?.indexdef).toContain('(deliverable_id)');
    expect(vigente?.indexdef).toMatch(/WHERE \(status = 'approved'/);
    expect(await definicion('script_versions_numero_key')).toBe('UNIQUE (deliverable_id, version)');
  });

  it('los triggers de integridad existen (incluida la guarda sobre source_documents)', async () => {
    const triggers = await query<{ tgname: string; tabla: string }>(
      `SELECT t.tgname, c.relname AS tabla FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal AND t.tgname = ANY($1::text[])`,
      [
        [
          'deliverables_integridad',
          'script_versions_integridad',
          'script_versions_sucesora_aprobada',
          'script_review_comments_integridad',
          'source_documents_guion_guarda',
        ],
      ],
    );
    expect(triggers.map((t) => `${t.tabla}.${t.tgname}`).sort()).toEqual([
      'deliverables.deliverables_integridad',
      'script_review_comments.script_review_comments_integridad',
      'script_versions.script_versions_integridad',
      'script_versions.script_versions_sucesora_aprobada',
      'source_documents.source_documents_guion_guarda',
    ]);
  });
});

describe('aislamiento por SQL directo: deliverables', () => {
  const base = (over: Partial<Record<number, unknown>> = {}) => {
    const p: unknown[] = [
      e.admin.organizationId,
      e.campanaId,
      e.participaciones.diego,
      'instagram',
      etiqueta(),
      `clave-${secuencia}`,
      null,
      e.consultor.id,
    ];
    for (const [i, v] of Object.entries(over)) p[Number(i)] = v;
    return p;
  };

  it('el insert base válido pasa (control)', async () => {
    const [{ id } = { id: '' }] = await query<{ id: string }>(
      INSERTAR_ENTREGABLE,
      base({ 5: `control-${Date.now()}` }),
    );
    expect(id).toBeDefined();
  });

  it('una participación de OTRA campaña no se puede usar (FK compuesta)', async () => {
    const m = await rechazo(
      INSERTAR_ENTREGABLE,
      base({ 1: e.otraCampanaId, 5: `otra-campana-${Date.now()}` }),
    );
    expect(m).toMatch(/deliverables_participacion_fkey|foreign key/);
  });

  it('una campaña de OTRA organización no se puede usar (FK compuesta con la organización)', async () => {
    const m = await rechazo(
      INSERTAR_ENTREGABLE,
      base({ 0: e.ajeno.organizationId, 5: `otra-org-${Date.now()}` }),
    );
    expect(m).toMatch(/deliverables_campaign_fkey|foreign key/);
    const m2 = await rechazo(
      INSERTAR_ENTREGABLE,
      base({ 0: e.ajeno.organizationId, 1: e.campanaAjenaId, 5: `otra-org-2-${Date.now()}` }),
    );
    expect(m2).not.toBe('');
  });

  it('un producto de OTRA campaña no se puede usar (FK compuesta)', async () => {
    const [otro] = await query<{ id: string }>(
      `INSERT INTO campaign_products (campaign_id, product_id, rol, prioridad, participacion_presupuesto)
       SELECT $1, product_id, 'secundario', 1, 0.5 FROM campaign_products WHERE id = $2 RETURNING id`,
      [e.otraCampanaId, e.productos.p80],
    );
    const m = await rechazo(INSERTAR_ENTREGABLE, base({ 6: otro!.id, 5: `prod-otra-${Date.now()}` }));
    // (el trigger BEFORE responde antes que la FK; ambos impiden el cruce)
    expect(m).toMatch(/no está asignado|deliverables_producto_fkey|foreign key/);
  });

  it('un producto de la campaña pero NO asignado a la participación: la base lo rechaza', async () => {
    const m = await rechazo(
      INSERTAR_ENTREGABLE,
      base({ 6: e.productos.pro, 5: `prod-no-asignado-${Date.now()}` }),
    );
    expect(m).toMatch(/no está asignado/);
    // asignado: pasa
    expect(
      await rechazo(
        INSERTAR_ENTREGABLE,
        base({ 2: e.participaciones.valentinaRios, 6: e.productos.p80, 5: `prod-ok-${Date.now()}` }),
      ),
    ).toBe('');
  });

  it('created_by: un cliente, de otra organización, o quien no es personal con manage, se rechaza', async () => {
    for (const autor of [e.cliente, e.ajeno, e.operativo, e.analista, e.legal] as User[]) {
      const m = await rechazo(
        INSERTAR_ENTREGABLE,
        base({ 7: autor.id, 5: `autor-${autor.role}-${Date.now()}` }),
      );
      expect(m, autor.role).not.toBe('');
    }
    // admin, director y consultor sí
    for (const autor of [e.admin, e.director, e.consultor]) {
      expect(
        await rechazo(INSERTAR_ENTREGABLE, base({ 7: autor.id, 5: `autor-ok-${autor.role}-${Date.now()}` })),
        autor.role,
      ).toBe('');
    }
  });

  it('un entregable nace activo y sin versiones', async () => {
    expect(
      await rechazo(
        `INSERT INTO deliverables (organization_id, campaign_id, campaign_influencer_id, label, label_key, created_by, status, archived_at)
         VALUES ($1, $2, $3, 'X', 'x-arch', $4, 'archived', now())`,
        [e.admin.organizationId, e.campanaId, e.participaciones.diego, e.consultor.id],
      ),
    ).toMatch(/nace activo/);
    expect(
      await rechazo(
        `INSERT INTO deliverables (organization_id, campaign_id, campaign_influencer_id, label, label_key, created_by, last_version)
         VALUES ($1, $2, $3, 'X', 'x-ver', $4, 5)`,
        [e.admin.organizationId, e.campanaId, e.participaciones.diego, e.consultor.id],
      ),
    ).toMatch(/nace activo/);
  });

  it('last_version solo avanza de uno en uno y solo al registrar una versión (nadie la fija a mano)', async () => {
    const [{ id } = { id: '' }] = await query<{ id: string }>(
      INSERTAR_ENTREGABLE,
      base({ 5: `contador-${Date.now()}` }),
    );
    expect(await rechazo(`UPDATE deliverables SET last_version = 5 WHERE id = $1`, [id])).toMatch(
      /de uno en uno/,
    );
    // 025 · QA-F7-01b: avanzar de uno en uno SIN registrar la versión deja un hueco: se rechaza al cerrar la transacción.
    expect(await rechazo(`UPDATE deliverables SET last_version = 1 WHERE id = $1`, [id])).toMatch(
      /debe coincidir con la mayor versión/,
    );
    expect(await rechazo(`UPDATE deliverables SET last_version = 2 WHERE id = $1`, [id])).toMatch(
      /de uno en uno/,
    );
  });
});

describe('unicidad y formato de la etiqueta (la base)', () => {
  it('dos entregables ACTIVOS de la misma participación no comparten clave; archivar la libera', async () => {
    const clave = `unica-${Date.now()}`;
    const insertar = () =>
      rechazo(
        `INSERT INTO deliverables (organization_id, campaign_id, campaign_influencer_id, label, label_key, created_by)
         VALUES ($1, $2, $3, 'Etiqueta', $4, $5)`,
        [e.admin.organizationId, e.campanaId, e.participaciones.diego, clave, e.consultor.id],
      );
    expect(await insertar()).toBe('');
    expect(await insertar()).toMatch(/deliverables_clave_activa_key|duplicate key/);
    await query(
      `UPDATE deliverables SET status = 'archived', archived_at = now() WHERE campaign_influencer_id = $1 AND label_key = $2`,
      [e.participaciones.diego, clave],
    );
    expect(await insertar()).toBe('');
  });

  it('la clave debe llegar normalizada y la etiqueta sin espacios sobrantes ni control', async () => {
    const insertar = (label: string, key: string) =>
      rechazo(
        `INSERT INTO deliverables (organization_id, campaign_id, campaign_influencer_id, label, label_key, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [e.admin.organizationId, e.campanaId, e.participaciones.diego, label, key, e.consultor.id],
      );
    expect(await insertar('Reel', 'Reel')).toMatch(/deliverables_label_key_valida|check/); // mayúsculas
    expect(await insertar('Reel', ' reel')).toMatch(/deliverables_label_key_valida|check/); // espacios
    expect(await insertar('Reel', '')).toMatch(/deliverables_label_key_valida|check/);
    expect(await insertar(' Reel ', 'reel-x')).toMatch(/deliverables_label_valida|check/);
    expect(await insertar('Re\u0001el', 'reel-y')).toMatch(/deliverables_label_valida|check/);
    expect(await insertar('x'.repeat(121), 'x'.repeat(121))).not.toBe('');
    expect(await insertar('', '')).not.toBe('');
  });

  it('la plataforma debe ser una del enum social_platform (o faltar)', async () => {
    const insertar = (plataforma: string | null, key: string) =>
      rechazo(
        `INSERT INTO deliverables (organization_id, campaign_id, campaign_influencer_id, platform, label, label_key, created_by)
         VALUES ($1, $2, $3, $4::social_platform, 'Plat', $5, $6)`,
        [e.admin.organizationId, e.campanaId, e.participaciones.diego, plataforma, key, e.consultor.id],
      );
    expect(await insertar('myspace', `plat-a-${Date.now()}`)).not.toBe('');
    expect(await insertar(null, `plat-b-${Date.now()}`)).toBe('');
    expect(await insertar('youtube', `plat-c-${Date.now()}`)).toBe('');
  });
});

describe('aislamiento por SQL directo: script_versions', () => {
  const insertar = (over: {
    deliverable?: string;
    org?: string;
    campana?: string;
    fuente: string;
    autor?: User;
  }) =>
    rechazo(
      `INSERT INTO script_versions (organization_id, campaign_id, deliverable_id, source_document_id, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        over.org ?? e.admin.organizationId,
        over.campana ?? e.campanaId,
        over.deliverable ?? e.entregables.reelDiego,
        over.fuente,
        (over.autor ?? e.consultor).id,
      ],
    );

  it('control: el insert válido pasa', async () => {
    expect(
      await insertar({ fuente: await crearFuenteDeGuionDePrueba(e.campanaId, e.admin, 'esq-control') }),
    ).toBe('');
  });

  it('una fuente de OTRA campaña o de OTRA organización se rechaza (FK compuestas)', async () => {
    const deOtraCampana = await crearFuenteDeGuionDePrueba(e.otraCampanaId, e.admin, 'esq-otra-campana');
    const deOtraOrg = await crearFuenteDeGuionDePrueba(e.campanaAjenaId, e.ajeno, 'esq-otra-org');
    expect(await insertar({ fuente: deOtraCampana })).toMatch(
      /script_versions_fuente_campaign_fkey|foreign key/,
    );
    expect(await insertar({ fuente: deOtraOrg })).toMatch(
      /script_versions_fuente_(org|campaign)_fkey|foreign key/,
    );
  });

  it('un entregable de otra campaña u organización no se puede usar (FK compuesta con el entregable)', async () => {
    const fuente = await crearFuenteDeGuionDePrueba(e.campanaId, e.admin, 'esq-entregable-ajeno');
    expect(await insertar({ fuente, campana: e.otraCampanaId })).not.toBe('');
    expect(await insertar({ fuente, org: e.ajeno.organizationId })).not.toBe('');
  });

  it('una fuente enlace (origin=link) no es un guion', async () => {
    const [enlace] = await query<{ id: string }>(
      `INSERT INTO source_documents (campaign_id, organization_id, type, filename, status, created_by, origin,
                                     external_provider, external_id, external_url, canonical_url)
       VALUES ($1, $2, 'otro', 'Enlace', 'por_resolver', $3, 'link', 'google_docs', $4, 'https://docs.google.com/document/d/y', $5)
       RETURNING id`,
      [
        e.campanaId,
        e.admin.organizationId,
        e.admin.id,
        `esq-${e.sufijo}`,
        `https://docs.google.com/d/esq-${e.sufijo}`,
      ],
    );
    expect(await insertar({ fuente: enlace!.id })).toMatch(/debe ser un archivo/);
  });

  it('una fuente visible para TCL no se puede usar como guion', async () => {
    const f = await crearFuenteDeGuionDePrueba(e.campanaId, e.admin, 'esq-visible-tcl');
    await query(`UPDATE source_documents SET visibility = 'tcl' WHERE id = $1`, [f]);
    expect(await insertar({ fuente: f })).toMatch(/visible para TCL/);
    await query(`UPDATE source_documents SET visibility = 'compartida' WHERE id = $1`, [f]);
    expect(await insertar({ fuente: f })).toMatch(/visible para TCL/);
  });

  it('el hash de la fuente debe ser un SHA-256 hexadecimal (la base no acepta provenance sin huella)', async () => {
    const f = await crearFuenteDePrueba(e.campanaId, e.admin, 'esq-hash-raro'); // hash «hash-…», no SHA-256
    expect(await insertar({ fuente: f })).toMatch(/script_versions_hash_valido|check/);
  });

  it('created_by: cliente, otra organización y roles sin manage se rechazan; admin/director/consultor pasan', async () => {
    for (const autor of [e.cliente, e.ajeno, e.operativo, e.analista, e.legal]) {
      const f = await crearFuenteDeGuionDePrueba(e.campanaId, e.admin, `esq-autor-${autor.role}`);
      expect(await insertar({ fuente: f, autor }), autor.role).not.toBe('');
    }
    for (const autor of [e.admin, e.director]) {
      const f = await crearFuenteDeGuionDePrueba(e.campanaId, e.admin, `esq-autor-ok-${autor.role}`);
      expect(await insertar({ fuente: f, autor }), autor.role).toBe('');
    }
  });

  it('un entregable archivado no admite versiones', async () => {
    const [{ id } = { id: '' }] = await query<{ id: string }>(INSERTAR_ENTREGABLE, [
      e.admin.organizationId,
      e.campanaId,
      e.participaciones.diego,
      null,
      'Para archivar',
      `arch-${Date.now()}`,
      null,
      e.consultor.id,
    ]);
    await query(`UPDATE deliverables SET status = 'archived', archived_at = now() WHERE id = $1`, [id]);
    const f = await crearFuenteDeGuionDePrueba(e.campanaId, e.admin, 'esq-archivado');
    expect(await insertar({ fuente: f, deliverable: id })).toMatch(/archivado/);
  });
});

describe('CHECK de coherencia de script_versions (fijando estados con el bypass de pruebas)', () => {
  async function versionNueva(etiquetaFuente: string): Promise<string> {
    const [d] = await query<{ id: string }>(INSERTAR_ENTREGABLE, [
      e.admin.organizationId,
      e.campanaId,
      e.participaciones.diego,
      null,
      `CHK ${etiquetaFuente}`,
      `chk-${etiquetaFuente}-${Date.now()}`,
      null,
      e.consultor.id,
    ]);
    const f = await crearFuenteDeGuionDePrueba(e.campanaId, e.admin, etiquetaFuente);
    const [v] = await query<{ id: string }>(
      `INSERT INTO script_versions (organization_id, campaign_id, deliverable_id, source_document_id, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [e.admin.organizationId, e.campanaId, d!.id, f, e.consultor.id],
    );
    return v!.id;
  }
  const fijar = async (sql: string, params: unknown[]): Promise<string> => {
    try {
      await conBypass(async (c) => {
        await c.query(sql, params);
      });
      return '';
    } catch (error) {
      return (error as Error).message;
    }
  };

  it('approved exige aprobación completa y sin reemplazo; approved_at y approved_by van en pareja', async () => {
    const v = await versionNueva('chk-a');
    expect(await fijar(`UPDATE script_versions SET status = 'approved' WHERE id = $1`, [v])).toMatch(
      /script_versions_aprobada_coherente|check/,
    );
    expect(
      await fijar(`UPDATE script_versions SET status = 'approved', approved_at = now() WHERE id = $1`, [v]),
    ).toMatch(/aprobacion_par|check/);
    expect(
      await fijar(
        `UPDATE script_versions SET status = 'in_review', approved_by = $2, approved_at = now() WHERE id = $1`,
        [v, e.director.id],
      ),
    ).toMatch(/nunca_aprobada|check/);
  });

  it('las demás marcas de aprobación solo existen si hubo aprobación; el snapshot es un objeto', async () => {
    const v = await versionNueva('chk-b');
    expect(
      await fijar(`UPDATE script_versions SET approved_analysis_id = gen_random_uuid() WHERE id = $1`, [v]),
    ).toMatch(/aprobacion_completa|check/);
    expect(
      await fijar(`UPDATE script_versions SET approval_snapshot = '{}'::jsonb WHERE id = $1`, [v]),
    ).toMatch(/aprobacion_completa|check/);
    expect(
      await fijar(
        `UPDATE script_versions SET status = 'approved', approved_by = $2, approved_at = now(), approval_snapshot = '[1]'::jsonb WHERE id = $1`,
        [v, e.director.id],
      ),
    ).toMatch(/snapshot_objeto|check/);
    // aprobada con su snapshot es válida (la FK al análisis la añade la 024)
    expect(
      await fijar(
        `UPDATE script_versions SET status = 'approved', approved_by = $2, approved_at = now(),
                approval_snapshot = '{"version": 1}'::jsonb WHERE id = $1`,
        [v, e.director.id],
      ),
    ).toBe('');
  });

  it('superseded exige sucesora y fecha, y solo superseded las lleva', async () => {
    const v = await versionNueva('chk-c');
    expect(await fijar(`UPDATE script_versions SET status = 'superseded' WHERE id = $1`, [v])).toMatch(
      /reemplazo_coherente|check/,
    );
    expect(await fijar(`UPDATE script_versions SET superseded_at = now() WHERE id = $1`, [v])).toMatch(
      /reemplazo|check/,
    );
    expect(await fijar(`UPDATE script_versions SET status = 'archivada' WHERE id = $1`, [v])).toMatch(
      /estado_valido|check/,
    );
  });

  it('versión >= 1 y la sucesora debe ser del MISMO entregable (FK compuesta)', async () => {
    const a = await versionNueva('chk-d1');
    const b = await versionNueva('chk-d2');
    expect(await fijar(`UPDATE script_versions SET version = 0 WHERE id = $1`, [a])).toMatch(
      /version_valida|check/,
    );
    expect(
      await fijar(
        `UPDATE script_versions SET status = 'superseded', superseded_by_version_id = $2, superseded_at = now() WHERE id = $1`,
        [a, b],
      ),
    ).toMatch(/script_versions_sucesora_fkey|foreign key/);
  });
});

describe('sin DELETE: la historia se conserva', () => {
  it('ninguna de las tres tablas admite DELETE (salvo el bypass de bases _test)', async () => {
    const [d] = await query<{ id: string }>(`SELECT id FROM deliverables WHERE campaign_id = $1 LIMIT 1`, [
      e.campanaId,
    ]);
    expect(await rechazo(`DELETE FROM deliverables WHERE id = $1`, [d!.id])).toMatch(/no admite DELETE/);
    const f = await crearFuenteDeGuionDePrueba(e.campanaId, e.admin, 'esq-delete');
    const [v] = await query<{ id: string }>(
      `INSERT INTO script_versions (organization_id, campaign_id, deliverable_id, source_document_id, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [e.admin.organizationId, e.campanaId, e.entregables.reelGomez, f, e.consultor.id],
    );
    expect(await rechazo(`DELETE FROM script_versions WHERE id = $1`, [v!.id])).toMatch(/no admite DELETE/);
  });
});
