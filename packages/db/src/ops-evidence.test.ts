/**
 * V2 · Fase 8 (W1b) — evidencia operativa: la fuente `soporte_operativo` (sensible, interna, sin
 * procesamiento), reutilización por hash, adjuntar con evento, retirar sin borrar y lectura por la capacidad de
 * su sujeto (nombre, hash, tamaño, tipo; nunca el contenido).
 */

import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Result } from '@tcl-kol-os/domain';
import { closePool } from './client.ts';
import {
  adjuntarEvidenciaOperativa,
  listarEvidenciaDeEvento,
  listarEvidenciaDeSujeto,
  retractarEvidencia,
  subirEvidenciaOperativa,
} from './ops-evidence.ts';
import { transaccionOperativa } from './operational-events.ts';
import {
  type EscenarioDeOperacion,
  archivoDePrueba,
  auditoriaDeSujeto,
  crearAcuerdoPorSql,
  crearEscenarioDeOperacion,
  fila,
  insertar,
  limpiarEscenarioDeOperacion,
  nuevaParticipacion,
  pdfDePrueba,
  unico,
} from './ops-test-support.ts';
import { crearEnvio } from './shipments.ts';
import { getSource, listSources } from './sources.ts';
import { getPool } from './client.ts';

let op: EscenarioDeOperacion;
let e: EscenarioDeOperacion['e'];

beforeAll(async () => {
  op = await crearEscenarioDeOperacion('F8 evidencia');
  e = op.e;
});

afterAll(async () => {
  await limpiarEscenarioDeOperacion(op);
  await closePool();
});

function exito<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message} ${JSON.stringify(r.error.details)}`);
  return r.value;
}
const codigo = <T>(r: Result<T>): string => (r.ok ? 'OK' : r.error.code);
const razon = <T>(r: Result<T>): unknown =>
  r.ok ? undefined : (r.error.details as { reason?: unknown } | undefined)?.reason;

async function envio(): Promise<{ id: string; seq: number; ci: string }> {
  const { ci } = await nuevaParticipacion(op, 'Evidencia', [e.productos.p80]);
  const r = exito(
    await crearEnvio(e.operativo, {
      campaignInfluencerId: ci,
      items: [{ campaignProductId: e.productos.p80, quantity: 1 }],
      idempotencyKey: unico('c'),
    }),
  );
  return { id: r.envio.id, seq: r.envio.rowSeq, ci };
}

describe('subirEvidenciaOperativa', () => {
  it('crea la fuente soporte_operativo: sensible, interna, procesada, sin jobs ni fragmentos, hash real', async () => {
    const archivo = archivoDePrueba();
    const r = await transaccionOperativa((c) =>
      subirEvidenciaOperativa(c, { actor: e.operativo, campaignId: e.campanaId, archivo }),
    );
    const subida = exito(r);
    expect(subida).toMatchObject({ reutilizada: false, mimeType: 'application/pdf' });
    const f = await fila<Record<string, unknown>>(
      `SELECT type::text AS type, confidentiality_level::text AS conf, visibility::text AS vis,
              status::text AS status, origin::text AS origin, hash, size_bytes::int AS size, filename,
              (SELECT count(*) FROM processing_jobs WHERE source_id = s.id)::int AS jobs,
              (SELECT count(*) FROM source_fragments WHERE source_id = s.id)::int AS fragmentos
         FROM source_documents s WHERE id = $1`,
      [subida.sourceDocumentId],
    );
    expect(f).toEqual({
      type: 'soporte_operativo',
      conf: 'sensible',
      vis: 'interna',
      status: 'procesado',
      origin: 'file',
      hash: createHash('sha256').update(archivo.contenido).digest('hex'),
      size: archivo.contenido.byteLength,
      filename: archivo.filename,
      jobs: 0,
      fragmentos: 0,
    });
    expect(subida.sizeBytes).toBe(archivo.contenido.byteLength);
  });

  it('el mismo contenido en la campaña REUTILIZA la fuente (no duplica ni falla)', async () => {
    const archivo = archivoDePrueba();
    const a = exito(
      await transaccionOperativa((c) =>
        subirEvidenciaOperativa(c, { actor: e.operativo, campaignId: e.campanaId, archivo }),
      ),
    );
    const b = exito(
      await transaccionOperativa((c) =>
        subirEvidenciaOperativa(c, {
          actor: e.director,
          campaignId: e.campanaId,
          archivo: { ...archivo, filename: 'otro-nombre.pdf' },
        }),
      ),
    );
    expect(b.sourceDocumentId).toBe(a.sourceDocumentId);
    expect(b.reutilizada).toBe(true);
    const n = await fila<{ n: string }>(
      `SELECT count(*) AS n FROM source_documents WHERE campaign_id = $1 AND hash = $2`,
      [e.campanaId, createHash('sha256').update(archivo.contenido).digest('hex')],
    );
    expect(Number(n.n)).toBe(1);
  });

  it('un contenido que ya existe como OTRA fuente (p. ej. un guion) no se convierte en evidencia', async () => {
    const contenido = pdfDePrueba(unico('otro'));
    await insertar(getPool(), 'source_documents', {
      campaign_id: e.campanaId,
      organization_id: e.admin.organizationId,
      type: 'otro',
      filename: 'ya-existe.pdf',
      file_id: `test/${unico('f')}.pdf`,
      mime_type: 'application/pdf',
      size_bytes: contenido.byteLength,
      hash: createHash('sha256').update(contenido).digest('hex'),
      status: 'procesado',
      created_by: e.admin.id,
    });
    const r = await transaccionOperativa((c) =>
      subirEvidenciaOperativa(c, {
        actor: e.operativo,
        campaignId: e.campanaId,
        archivo: { filename: 'x.pdf', contenido },
      }),
    );
    expect(codigo(r)).toBe('RESOURCE_CONFLICT');
    expect(razon(r)).toBe('hash_in_other_source');
  });

  it('valida por contenido real (no por extensión), exige nombre y la capacidad ops_evidence:attach', async () => {
    const subir = (
      actor: typeof e.operativo,
      archivo: { filename: string; contenido: Uint8Array },
      campaignId = e.campanaId,
    ) => transaccionOperativa((c) => subirEvidenciaOperativa(c, { actor, campaignId, archivo }));
    expect(
      codigo(
        await subir(e.operativo, {
          filename: 'falso.pdf',
          contenido: new TextEncoder().encode('esto no es un pdf'),
        }),
      ),
    ).not.toBe('OK');
    expect(codigo(await subir(e.operativo, { filename: 'vacio.pdf', contenido: new Uint8Array() }))).not.toBe(
      'OK',
    );
    expect(codigo(await subir(e.operativo, { filename: '   ', contenido: pdfDePrueba() }))).toBe(
      'VALIDATION_FAILED',
    );
    expect(codigo(await subir(e.consultor, archivoDePrueba()))).toBe('FORBIDDEN_ROLE');
    for (const actor of [e.ajeno, e.cliente]) {
      expect(codigo(await subir(actor, archivoDePrueba())), actor.role).toBe('RESOURCE_NOT_FOUND');
    }
    expect(codigo(await subir(e.operativo, archivoDePrueba(), e.campanaAjenaId))).toBe('RESOURCE_NOT_FOUND');
    // el nombre se sanea: sin rutas
    const r = exito(
      await subir(e.operativo, { filename: '../../etc/guia\u0000.pdf', contenido: pdfDePrueba() }),
    );
    const f = await fila<{ filename: string }>(`SELECT filename FROM source_documents WHERE id = $1`, [
      r.sourceDocumentId,
    ]);
    expect(f.filename).toBe('guia.pdf');
  });

  it('la evidencia NO aparece en las fuentes de la campaña (listSources / getSource) para ningún rol', async () => {
    const r = exito(
      await transaccionOperativa((c) =>
        subirEvidenciaOperativa(c, {
          actor: e.operativo,
          campaignId: e.campanaId,
          archivo: archivoDePrueba(),
        }),
      ),
    );
    for (const actor of [e.admin, e.operativo, e.consultor, e.cliente]) {
      const lista = await listSources(actor, e.campanaId);
      if (lista.ok)
        expect(
          lista.value.map((s) => s.id),
          actor.role,
        ).not.toContain(r.sourceDocumentId);
      const una = await getSource(actor, r.sourceDocumentId);
      expect(una.ok, actor.role).toBe(false);
    }
  });
});

describe('adjuntarEvidenciaOperativa', () => {
  it('añade soporte a un envío con un evento evidence.attached que avanza row_seq', async () => {
    const s = await envio();
    const archivo = archivoDePrueba();
    const r = exito(
      await adjuntarEvidenciaOperativa(e.operativo, {
        subjectType: 'shipment',
        subjectId: s.id,
        expectedSeq: s.seq,
        idempotencyKey: unico('adj'),
        kind: 'guia',
        archivo,
        note: 'SENTINELA-NOTA',
      }),
    );
    expect(r.evento).toMatchObject({
      eventType: 'evidence.attached',
      fromStatus: null,
      toStatus: null,
      subjectSeq: s.seq + 1,
      evidenceCount: 1,
    });
    expect(r.sujeto).toMatchObject({ status: 'pending', rowSeq: s.seq + 1 });
    const bd = await fila<{ status: string; row_seq: number }>(
      `SELECT status, row_seq FROM shipments WHERE id = $1`,
      [s.id],
    );
    expect(bd).toEqual({ status: 'pending', row_seq: s.seq + 1 });

    // el operativo y el consultor (shipment:read) leen nombre, hash, tamaño y tipo; nunca contenido
    for (const actor of [e.operativo, e.consultor]) {
      const lista = exito(await listarEvidenciaDeEvento(actor, r.evento.id));
      expect(lista).toHaveLength(1);
      expect(lista[0]).toMatchObject({
        kind: 'guia',
        filename: archivo.filename,
        sizeBytes: archivo.contenido.byteLength,
        hash: createHash('sha256').update(archivo.contenido).digest('hex'),
        retractedAt: null,
        eventType: 'evidence.attached',
      });
      expect(Object.keys(lista[0]!)).not.toEqual(
        expect.arrayContaining(['contenido', 'content', 'bytes', 'fileId']),
      );
    }
    // auditoría: ids, tipo y conteo, nunca el nombre del archivo ni la nota
    const reg = await auditoriaDeSujeto(s.id);
    const texto = JSON.stringify(reg);
    expect(reg.map((x) => x.action)).toContain('ops_evidence.attached');
    expect(texto).not.toContain(archivo.filename);
    expect(texto).not.toContain('SENTINELA');
    expect(reg.find((x) => x.action === 'ops_evidence.attached')!.metadata).toMatchObject({
      kind: 'guia',
      evidenceCount: 1,
      hasEvidence: true,
    });
  });

  it('idempotente (misma clave y archivo ⇒ el mismo evento), desfase ⇒ stale, tipo inválido ⇒ validación', async () => {
    const s = await envio();
    const entrada = {
      subjectType: 'shipment' as const,
      subjectId: s.id,
      expectedSeq: s.seq,
      idempotencyKey: unico('idem'),
      kind: 'soporte' as const,
      archivo: archivoDePrueba(),
    };
    const a = exito(await adjuntarEvidenciaOperativa(e.operativo, entrada));
    const b = exito(await adjuntarEvidenciaOperativa(e.operativo, entrada));
    expect(b.repetido).toBe(true);
    expect(b.evento.id).toBe(a.evento.id);
    const n = await fila<{ n: string }>(
      `SELECT count(*) AS n FROM operational_evidence WHERE event_id = $1`,
      [a.evento.id],
    );
    expect(Number(n.n)).toBe(1);
    expect(
      razon(
        await adjuntarEvidenciaOperativa(e.operativo, {
          ...entrada,
          idempotencyKey: unico('s'),
          archivo: archivoDePrueba(),
        }),
      ),
    ).toBe('stale_transition');
    expect(
      codigo(
        await adjuntarEvidenciaOperativa(e.operativo, {
          ...entrada,
          kind: 'foto' as never,
          idempotencyKey: unico('k'),
        }),
      ),
    ).toBe('VALIDATION_FAILED');
  });

  it('el mismo archivo puede respaldar eventos distintos (se reutiliza la fuente), no dos veces el mismo evento', async () => {
    const s = await envio();
    const archivo = archivoDePrueba();
    const a = exito(
      await adjuntarEvidenciaOperativa(e.operativo, {
        subjectType: 'shipment',
        subjectId: s.id,
        expectedSeq: s.seq,
        idempotencyKey: unico('a'),
        kind: 'guia',
        archivo,
      }),
    );
    const b = exito(
      await adjuntarEvidenciaOperativa(e.operativo, {
        subjectType: 'shipment',
        subjectId: s.id,
        expectedSeq: a.sujeto.rowSeq,
        idempotencyKey: unico('b'),
        kind: 'otro',
        archivo,
      }),
    );
    const ev = exito(
      await listarEvidenciaDeSujeto(e.operativo, { subjectType: 'shipment', subjectId: s.id }),
    );
    expect(ev).toHaveLength(2);
    expect(new Set(ev.map((x) => x.sourceDocumentId)).size).toBe(1);
    expect(b.evento.id).not.toBe(a.evento.id);
  });

  it('permisos: consultor FORBIDDEN; ajeno/cliente NOT_FOUND; chat y sistema rechazados; la financiera exige finance:read', async () => {
    const s = await envio();
    const entrada = (clave: string) => ({
      subjectType: 'shipment' as const,
      subjectId: s.id,
      expectedSeq: s.seq,
      idempotencyKey: clave,
      kind: 'guia' as const,
      archivo: archivoDePrueba(),
    });
    expect(codigo(await adjuntarEvidenciaOperativa(e.consultor, entrada(unico('p'))))).toBe('FORBIDDEN_ROLE');
    for (const actor of [e.ajeno, e.cliente]) {
      expect(codigo(await adjuntarEvidenciaOperativa(actor, entrada(unico('p')))), actor.role).toBe(
        'RESOURCE_NOT_FOUND',
      );
    }
    expect(
      codigo(await adjuntarEvidenciaOperativa(e.operativo, entrada(unico('p')), { origin: 'chat' })),
    ).toBe('HUMAN_CONFIRMATION_REQUIRED');
    expect(
      codigo(await adjuntarEvidenciaOperativa(e.operativo, entrada(unico('p')), { origin: 'system' })),
    ).toBe('FORBIDDEN_ROLE');
    expect(
      codigo(
        await adjuntarEvidenciaOperativa(e.operativo, {
          ...entrada(unico('p')),
          subjectId: '00000000-0000-4000-8000-000000000000',
        }),
      ),
    ).toBe('RESOURCE_NOT_FOUND');
    const n = await fila<{ n: string }>(
      `SELECT count(*) AS n FROM operational_events WHERE shipment_id = $1`,
      [s.id],
    );
    expect(Number(n.n)).toBe(1);

    // soporte de una obligación de pago: lo ven y adjuntan quienes tienen finance:read; el consultor no
    const { ci } = await nuevaParticipacion(op, 'Pago evidencia');
    const ac = await crearAcuerdoPorSql(op, { ci, mode: 'fee' });
    const pago = {
      subjectType: 'payment_obligation' as const,
      subjectId: ac.obligationId,
      expectedSeq: 1,
      kind: 'comprobante' as const,
    };
    expect(
      codigo(
        await adjuntarEvidenciaOperativa(e.consultor, {
          ...pago,
          idempotencyKey: unico('f'),
          archivo: archivoDePrueba(),
        }),
      ),
    ).toBe('FORBIDDEN_ROLE');
    const ok = exito(
      await adjuntarEvidenciaOperativa(e.director, {
        ...pago,
        idempotencyKey: unico('f'),
        archivo: archivoDePrueba(),
      }),
    );
    expect(codigo(await listarEvidenciaDeEvento(e.consultor, ok.evento.id))).toBe('FORBIDDEN_ROLE');
    expect(codigo(await listarEvidenciaDeEvento(e.ajeno, ok.evento.id))).toBe('RESOURCE_NOT_FOUND');
    expect(exito(await listarEvidenciaDeEvento(e.operativo, ok.evento.id))).toHaveLength(1);
  });
});

describe('retractarEvidencia', () => {
  it('marca el vínculo (no borra): la fuente y el evento se conservan; una sola vez; ops_evidence:attach', async () => {
    const s = await envio();
    const r = exito(
      await adjuntarEvidenciaOperativa(e.operativo, {
        subjectType: 'shipment',
        subjectId: s.id,
        expectedSeq: s.seq,
        idempotencyKey: unico('a'),
        kind: 'guia',
        archivo: archivoDePrueba(),
      }),
    );
    const [ev] = exito(await listarEvidenciaDeEvento(e.operativo, r.evento.id));
    expect(codigo(await retractarEvidencia(e.consultor, ev!.id))).toBe('FORBIDDEN_ROLE');
    for (const actor of [e.ajeno, e.cliente]) {
      expect(codigo(await retractarEvidencia(actor, ev!.id)), actor.role).toBe('RESOURCE_NOT_FOUND');
    }
    expect(codigo(await retractarEvidencia(e.operativo, ev!.id, { origin: 'chat' }))).toBe(
      'HUMAN_CONFIRMATION_REQUIRED',
    );
    expect(codigo(await retractarEvidencia(e.operativo, 'no-uuid'))).toBe('RESOURCE_NOT_FOUND');

    const retirada = exito(await retractarEvidencia(e.director, ev!.id));
    expect(retirada.evidenceId).toBe(ev!.id);
    expect(codigo(await retractarEvidencia(e.operativo, ev!.id))).toBe('RESOURCE_CONFLICT');

    const [despues] = exito(await listarEvidenciaDeEvento(e.operativo, r.evento.id));
    expect(despues).toMatchObject({ id: ev!.id, retractedAt: retirada.retractedAt });
    const f = await fila<{ n: string; fuente: string; retractedBy: string }>(
      `SELECT (SELECT count(*) FROM operational_evidence WHERE id = $1) AS n,
              (SELECT count(*) FROM source_documents WHERE id = $2) AS fuente,
              (SELECT retracted_by FROM operational_evidence WHERE id = $1) AS "retractedBy"`,
      [ev!.id, ev!.sourceDocumentId],
    );
    expect(f).toEqual({ n: '1', fuente: '1', retractedBy: e.director.id });
    // el evento cuenta solo la evidencia vigente
    const hist = exito(
      await listarEvidenciaDeSujeto(e.operativo, { subjectType: 'shipment', subjectId: s.id }),
    );
    expect(hist).toHaveLength(1);
    const reg = await auditoriaDeSujeto(ev!.id);
    expect(reg.map((x) => x.action)).toEqual(['ops_evidence.retracted']);
    expect(JSON.stringify(reg)).not.toContain(ev!.filename);
  });
});
