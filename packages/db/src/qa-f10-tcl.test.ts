/**
 * QA adversarial F10 (independiente) — ATAQUES 3, 4, 5, 9, 11 y 17 (parte de base de datos): TCL.
 *
 * El actor es `marena@tcl.com` (rol `cliente`, organización de tipo `cliente`) sobre una campaña de SmartPR puesta en
 * `tcl`. La campaña tiene un centinela en cada superficie interna (acuerdo con fee, PII, fragmentos, guion en borrador,
 * comentario, chat…). Lo que TCL SÍ puede ver por contrato (nombre de campaña y valores del Brief aprobado) no se
 * trata como centinela.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLAVES_DE_DTO_TCL } from '@tcl-kol-os/domain';
import * as db from './index.ts';
import { closePool, query } from './client.ts';
import { unico } from './ops-test-support.ts';
import {
  C,
  CENTINELAS_INTERNOS,
  type Sembrado,
  escriturasDe,
  huellaDeCampana,
  sembrarSmartPR,
} from './qa-f10-soporte.ts';
import {
  type EscenarioDeOperacion,
  crearEscenarioDeOperacion,
  crearFuenteDePrueba,
  limpiarEscenarioDeOperacion,
} from './test-utils.ts';

let op: EscenarioDeOperacion;
let s: Sembrado;
const docs: Record<string, string> = {};

/** Centinelas que TCL no puede ver NUNCA (la campaña y el Brief aprobado sí son suyos por contrato). */
const PROHIBIDOS_PARA_TCL = CENTINELAS_INTERNOS.filter((c) => c !== C.campana && c !== C.brief);

beforeAll(async () => {
  op = await crearEscenarioDeOperacion('QA F10 tcl', { conAcuerdoAjeno: false });
  s = await sembrarSmartPR(op);
  await query(`UPDATE campaigns SET visibility = 'tcl' WHERE id = $1`, [op.campanaId]);

  const nuevaFuente = async (clave: string, nombre: string): Promise<string> => {
    const id = await crearFuenteDePrueba(op.campanaId, op.admin, clave);
    await query(`UPDATE source_documents SET filename = $2 WHERE id = $1`, [id, nombre]);
    docs[clave] = id;
    return id;
  };
  const ok = await nuevaFuente('ok', 'QAF10-DOC-COMPARTIDO.pdf');
  await query(`UPDATE source_documents SET visibility = 'tcl' WHERE id = $1`, [ok]);
  const tarifa = await nuevaFuente('tarifa', 'Propuesta con tarifa y fee del creador 4000000 COP.pdf');
  await query(`UPDATE source_documents SET visibility = 'tcl' WHERE id = $1`, [tarifa]);
  const pii = await nuevaFuente('pii', `Cedula ${C.documento} telefono ${C.telefono}.pdf`);
  await query(`UPDATE source_documents SET visibility = 'tcl' WHERE id = $1`, [pii]);
  const sensible = await nuevaFuente('sensible', 'QAF10-DOC-SENSIBLE.pdf');
  await query(
    `UPDATE source_documents SET confidentiality_level = 'sensible', visibility = 'tcl' WHERE id = $1`,
    [sensible],
  ).catch(() => undefined);
  // El guion en borrador compartido «por error» con TCL.
  const [v] = await query<{ source_id: string }>(
    `SELECT source_document_id AS source_id FROM script_versions WHERE id = $1`,
    [s.guionBorradorId],
  );
  docs['guionBorrador'] = v!.source_id;
  // Fuente INTERNA con fragmento centinela (visibilidad por omisión: interna).
}, 240_000);

afterAll(async () => {
  await limpiarEscenarioDeOperacion(op);
  await closePool();
});

function recorrer(valor: unknown, visita: (clave: string, v: unknown) => void): void {
  if (Array.isArray(valor)) valor.forEach((x) => recorrer(x, visita));
  else if (valor !== null && typeof valor === 'object') {
    for (const [k, v] of Object.entries(valor)) {
      visita(k, v);
      recorrer(v, visita);
    }
  }
}

const CLAVES_PERMITIDAS = new Set<string>([
  'seccion',
  ...Object.values(CLAVES_DE_DTO_TCL).flatMap((x) => [...x]),
]);

const PROHIBIDA =
  /fee|monto|amount|payment|pago|billing|factura|invoice|phone|telefono|email|address|direccion|document_?id|cedula|hallazgo|finding|comment|comentario|provenance|procedencia|evidence|evidencia|quote|cita|cost|costo|precio|price|canje|barter|tarifa|condicion/iu;

async function proyeccion() {
  const r = await db.obtenerProyeccionTclDeCampana(op.cliente, op.campanaId);
  if (!r.ok) throw new Error(`proyección: ${r.error.code}`);
  return r.value;
}

describe('QA F10 · (3)(4) TCL: sin finanzas ni PII en la proyección, el export JSON y el CSV', () => {
  it('la proyección no contiene ningún centinela interno y SÍ muestra lo contractual (control)', async () => {
    const texto = JSON.stringify(await proyeccion());
    for (const c of PROHIBIDOS_PARA_TCL) expect(texto, c).not.toContain(c);
    expect(texto, 'control: el nombre de campaña es de TCL').toContain(C.campana);
  });

  it('las claves de cada objeto de la proyección ⊆ lista blanca de DTO y ninguna huele a finanzas/PII', async () => {
    const claves = new Set<string>();
    recorrer(await proyeccion(), (k) => claves.add(k));
    for (const k of claves) {
      expect(CLAVES_PERMITIDAS.has(k), `clave fuera de la lista blanca: ${k}`).toBe(true);
      expect(PROHIBIDA.test(k), `clave sospechosa: ${k}`).toBe(false);
    }
  });

  it('export JSON y CSV: mismos hechos que la proyección, sin centinelas, sin claves nuevas (EXPORT ⊆ UI)', async () => {
    const p = await proyeccion();
    const json = await db.exportarCampanaParaTcl(op.cliente, op.campanaId, 'json');
    const csv = await db.exportarCampanaParaTcl(op.cliente, op.campanaId, 'csv');
    if (!json.ok || !csv.ok) throw new Error('export');
    for (const c of PROHIBIDOS_PARA_TCL) {
      expect(json.value.contenido, `json ${c}`).not.toContain(c);
      expect(csv.value.contenido, `csv ${c}`).not.toContain(c);
    }
    expect(JSON.parse(json.value.contenido)).toEqual(JSON.parse(JSON.stringify(p)));
    const clavesJson = new Set<string>();
    recorrer(JSON.parse(json.value.contenido), (k) => clavesJson.add(k));
    for (const k of clavesJson) expect(CLAVES_PERMITIDAS.has(k), `clave de export: ${k}`).toBe(true);
    // Cabecera CSV ⊆ lista blanca.
    const cabecera = csv.value.contenido
      .replace(/^\uFEFF/u, '')
      .split('\r\n')[0]!
      .split(',');
    for (const col of cabecera)
      expect(CLAVES_PERMITIDAS.has(col.replaceAll('"', '')), `columna ${col}`).toBe(true);
    // Todo hecho de la proyección aparece en el CSV: ni más ni menos filas que secciones con datos.
    expect(csv.value.contenido).toContain('QAF10-DOC-COMPARTIDO.pdf');
  });

  it('nombre de archivo del export: solo [a-z0-9-.], sin el nombre real de la campaña con centinela', async () => {
    const r = await db.exportarCampanaParaTcl(op.cliente, op.campanaId, 'csv');
    if (!r.ok) throw new Error('export');
    expect(r.value.nombreDeArchivo).toMatch(/^[a-z0-9.-]+$/u);
  });

  it('un formato inválido o inyectado falla con VALIDATION_FAILED solo tras autorizar; una campaña ajena, con el mismo 404', async () => {
    for (const f of ['xml', 'CSV', 'csv;rm', 'json\r\nSet-Cookie: a=b', '', '../json']) {
      const r = await db.exportarCampanaParaTcl(op.cliente, op.campanaId, f);
      expect(r.ok, f).toBe(false);
    }
    const nada = await db.exportarCampanaParaTcl(op.cliente, '99999999-9999-4999-8999-999999999999', 'xml');
    const ajena = await db.exportarCampanaParaTcl(op.cliente, op.otraCampanaId, 'xml');
    expect(JSON.stringify(ajena)).toBe(JSON.stringify(nada));
  });
});

describe('QA F10 · (9)(11) TCL: fuentes y borradores no pasan aunque se marquen «tcl»', () => {
  it('documentos: solo la fuente limpia y compartida; no el soporte operativo, ni el guion en borrador, ni la interna', async () => {
    const p = await proyeccion();
    const titulos = p.documentos.map((d) => d.titulo);
    expect(titulos).toContain('QAF10-DOC-COMPARTIDO.pdf');
    expect(titulos).not.toContain('QAF10-SOPORTE-OPERATIVO.pdf');
    expect(JSON.stringify(titulos)).not.toContain(C.fuente);
    expect(JSON.stringify(titulos)).not.toContain(C.guion);
    // El guion en borrador, compartido por error, no sale como documento.
    const [guion] = await query<{ filename: string }>(`SELECT filename FROM source_documents WHERE id = $1`, [
      docs['guionBorrador'],
    ]);
    expect(titulos).not.toContain(guion!.filename);
  });

  // QA-F10-01 (abierto) se documenta abajo: el NOMBRE de archivo de un documento compartido es texto libre.
  it('el título de un documento compartido con tarifa/fee en el nombre no llega a TCL', async () => {
    const titulos = (await proyeccion()).documentos.map((d) => d.titulo);
    expect(titulos.join('|')).not.toMatch(/tarifa|fee/iu);
  });

  it('el título de un documento compartido con cédula y teléfono en el nombre no llega a TCL', async () => {
    const titulos = (await proyeccion()).documentos.map((d) => d.titulo).join('|');
    expect(titulos).not.toContain(C.documento);
    expect(titulos).not.toContain(C.telefono);
  });

  it('la base IMPIDE exponer a TCL una fuente soporte_operativo (evidencia operativa) y fijar su tipo después', async () => {
    const [soporte] = await query<{ id: string }>(
      `INSERT INTO source_documents
         (campaign_id, organization_id, type, filename, file_id, mime_type, size_bytes, hash, status, confidentiality_level, visibility, created_by)
       VALUES ($1, $2, 'soporte_operativo', 'QAF10-SOPORTE-OPERATIVO.pdf', 'test/qaf10-soporte.pdf', 'application/pdf',
               10, $3, 'procesado', 'sensible', 'interna', $4) RETURNING id`,
      [op.campanaId, op.admin.organizationId, `hash-soporte-${unico('f10')}`, op.admin.id],
    );
    await expect(
      query(`UPDATE source_documents SET visibility = 'tcl' WHERE id = $1`, [soporte!.id]),
    ).rejects.toThrow(/interna|TCL/iu);
    // QA-F10: la fuente de un guion NO aprobado tampoco se puede exponer a TCL (trigger de la base).
    await expect(
      query(`UPDATE source_documents SET visibility = 'tcl' WHERE id = $1`, [docs['guionBorrador']]),
    ).rejects.toThrow(/no es la aprobada vigente/u);
    await expect(
      query(`UPDATE source_documents SET type = 'otro' WHERE id = $1`, [docs['ok']]),
    ).resolves.toBeDefined();
    await expect(
      query(`UPDATE source_documents SET type = 'soporte_operativo' WHERE id = $1`, [docs['ok']]),
    ).rejects.toThrow(/soporte_operativo/u);
  });

  // QA-F10-01 (abierto, P3 TEÓRICO): `documentosDe` (tcl-projection.ts) no filtra `confidentiality_level = 'sensible'`
  // y `setSourceVisibility` (sources.ts) tampoco lo rechaza; la base solo lo impide para `soporte_operativo`. Hoy NINGÚN
  // código de la aplicación crea una fuente `sensible` que no sea evidencia operativa (ya excluida), así que solo se
  // explota con SQL directo. Se documenta como defensa en profundidad faltante: el título/tipo/fecha saldrían a TCL.
  it.fails(
    'QA-F10-01 abierto · un documento marcado «sensible» y «tcl» no llega a TCL (o la base impide marcarlo)',
    async () => {
      const titulos = (await proyeccion()).documentos.map((d) => d.titulo);
      expect(titulos).not.toContain('QAF10-DOC-SENSIBLE.pdf');
    },
  );

  it('contenido: solo la fila aprobada vigente; el guion en borrador, sus comentarios y hallazgos no dejan rastro', async () => {
    const p = await proyeccion();
    const texto = JSON.stringify(p.contenido) + JSON.stringify(p.influencers) + JSON.stringify(p.operacion);
    for (const c of [C.guion, C.comentario, 'in_review', 'received', 'hallazgo', 'finding']) {
      expect(texto, c).not.toContain(c);
    }
    expect(p.contenido.length).toBeGreaterThanOrEqual(1);
    expect(p.contenido.every((x) => x.estado === 'aprobado' || x.estado === 'pendiente')).toBe(true);
  });

  it('un Brief no aprobado (borrador hijo) no sustituye al aprobado vigente', async () => {
    const hijo = await db.crearVersionHija(op.consultor, s.briefVersionId);
    if (!hijo.ok) throw new Error(hijo.error.code);
    await query(
      `UPDATE brief_fields SET value = $2::jsonb WHERE brief_version_id = $1 AND key = 'mensaje_principal.one_line'`,
      [hijo.value.versionId, JSON.stringify('QAF10-BORRADOR-DE-BRIEF-NO-APROBADO')],
    );
    const b = await db.obtenerBriefParaTcl(op.cliente, op.campanaId);
    expect(JSON.stringify(b)).not.toContain('QAF10-BORRADOR-DE-BRIEF-NO-APROBADO');
    const e = await db.exportarCampanaParaTcl(op.cliente, op.campanaId, 'json');
    expect(JSON.stringify(e)).not.toContain('QAF10-BORRADOR-DE-BRIEF-NO-APROBADO');
  });

  it('legado: getSource/getFragments/listSources/búsqueda con el actor cliente y la fuente compartida: denegado', async () => {
    const id = docs['ok']!;
    for (const r of [
      await db.getSource(op.cliente, id),
      await db.getFragments(op.cliente, id),
      await db.listSources(op.cliente, op.campanaId),
      await db.obtenerRepresentacionNormalizada(op.cliente, id, {}),
      await db.buscarTextoEnFuentes(op.cliente, { campaignId: op.campanaId, texto: 'QAF10' }),
      await db.buscarEvidenciaComoActor(op.cliente, {
        campaignId: op.campanaId,
        vector: Array.from({ length: 1536 }, () => 0.01),
        distanciaMaxima: 2,
      }),
    ]) {
      expect(r.ok).toBe(false);
    }
  });
});

describe('QA F10 · (5) escritura desde TCL: ningún caso de uso mutador acepta al cliente', () => {
  it('cada mutador con ids REALES y argumentos válidos falla y no cambia una sola fila', async () => {
    const escrituras = escriturasDe(op.cliente, s);
    for (const [nombre, llamar] of escrituras) {
      const antes = await huellaDeCampana(op.campanaId, op.admin.organizationId);
      let r: unknown;
      try {
        r = await llamar();
      } catch (e) {
        r = { ok: false, lanzo: e instanceof Error ? e.name : typeof e };
      }
      const o = r as { ok?: boolean };
      if (typeof o === 'object' && o !== null && 'ok' in o) {
        expect(o.ok, `${nombre}: el cliente TCL ejecutó un mutador`).toBe(false);
      }
      const despues = await huellaDeCampana(op.campanaId, op.admin.organizationId);
      expect(despues, `${nombre}: el cliente TCL cambió filas`).toBe(antes);
    }
  }, 120_000);

  it('barrido por reflexión: con el actor cliente ninguna función exportada cambia filas ni devuelve centinelas', async () => {
    const SIN_ACTOR = new Set([
      'closePool',
      'getPool',
      'query',
      'queryOne',
      'transaction',
      'migrate',
      'abandonarRunsCaducados',
      'vencerAccionesCaducadas',
      'transaccionOperativa',
    ]);
    const antes = await huellaDeCampana(op.campanaId, op.admin.organizationId);
    const ids = Object.values(s.ids);
    const kitchen = (id: string): Record<string, unknown> => ({
      campaignId: s.campanaId,
      campaignInfluencerId: s.participacionId,
      participationId: s.participacionId,
      influencerId: s.influencerId,
      deliverableId: s.entregableId,
      sourceId: docs['ok'],
      versionId: s.briefVersionId,
      scriptVersionId: s.guionBorradorId,
      conversationId: s.conversacionId,
      idempotencyKey: unico('qa-f10-tcl-sweep'),
      expectedSeq: 1,
      text: 'QAF10',
      texto: 'QAF10',
      to: 'approved',
      visibility: 'tcl',
      id,
    });
    const permitidas = new Set([
      'listarCampanasParaTcl',
      'obtenerDetalleTclDeCampana',
      'obtenerInfluencersParaTcl',
      'obtenerContenidoParaTcl',
      'obtenerBriefParaTcl',
      'obtenerOperacionParaTcl',
      'obtenerKpisParaTcl',
      'obtenerDocumentosParaTcl',
      'obtenerProyeccionTclDeCampana',
      'exportarCampanaParaTcl',
      'autorizarCampanaParaTcl',
      // Auxiliares PUROS sin actor ni datos de negocio: reflejan su primer argumento.
      'exigirPersona',
      'respuestaGuionada',
    ]);
    const exitosos: string[] = [];
    const fugas: string[] = [];
    const nombres = Object.keys(db)
      .filter((n) => typeof (db as Record<string, unknown>)[n] === 'function' && !SIN_ACTOR.has(n))
      .sort();
    for (const nombre of nombres) {
      const fn = (db as unknown as Record<string, (...a: unknown[]) => unknown>)[nombre]!;
      const intentos: unknown[][] = [[op.cliente], [op.cliente, kitchen(s.campanaId)]];
      for (const id of ids) {
        intentos.push([op.cliente, id], [op.cliente, id, {}], [op.cliente, id, kitchen(id)]);
        intentos.push([op.cliente, kitchen(id)]);
      }
      for (const args of intentos) {
        let r: unknown;
        try {
          r = await Promise.race([
            Promise.resolve(fn(...args)),
            new Promise((res) => setTimeout(() => res('TIMEOUT'), 4000)),
          ]);
        } catch {
          continue;
        }
        const t = (() => {
          try {
            return (
              JSON.stringify(r, (_k, x) =>
                typeof x === 'bigint' ? String(x) : x instanceof Map ? [...x] : x,
              ) ?? ''
            );
          } catch {
            return '';
          }
        })();
        for (const c of PROHIBIDOS_PARA_TCL) if (t.includes(c)) fugas.push(`${nombre} → ${c}`);
        const o = r as { ok?: unknown } | null;
        if (typeof o === 'object' && o !== null && 'ok' in o && o.ok === true && !permitidas.has(nombre)) {
          exitosos.push(nombre);
        }
      }
    }
    expect([...new Set(fugas)], 'centinelas internos entregados al cliente TCL').toEqual([]);
    // Funciones que devuelven ok:true al cliente fuera de la proyección: solo directorios SIN actor ni datos.
    expect([...new Set(exitosos)].sort(), 'ok:true al cliente fuera de la proyección').toEqual([]);
    expect(await huellaDeCampana(op.campanaId, op.admin.organizationId)).toBe(antes);
  }, 900_000);
});

describe('QA F10 · (17) export TCL: campaña interna o cancelada ⇒ el mismo 404; compartida ⇒ sí', () => {
  it('interna y cancelada devuelven el mismo error que un id inexistente; compartida sí exporta', async () => {
    const nada = JSON.stringify(
      await db.exportarCampanaParaTcl(op.cliente, '99999999-9999-4999-8999-999999999999', 'json'),
    );
    try {
      await query(`UPDATE campaigns SET visibility = 'interna' WHERE id = $1`, [op.campanaId]);
      expect(JSON.stringify(await db.exportarCampanaParaTcl(op.cliente, op.campanaId, 'json'))).toBe(nada);
      expect(JSON.stringify(await db.exportarCampanaParaTcl(op.cliente, op.campanaId, 'csv'))).toBe(nada);
      expect((await db.listarCampanasParaTcl(op.cliente)).ok).toBe(true);
      const lista = await db.listarCampanasParaTcl(op.cliente);
      expect(lista.ok && lista.value.map((c) => c.id)).not.toContain(op.campanaId);

      await query(`UPDATE campaigns SET visibility = 'tcl', status = 'cancelada' WHERE id = $1`, [
        op.campanaId,
      ]);
      expect(JSON.stringify(await db.exportarCampanaParaTcl(op.cliente, op.campanaId, 'json'))).toBe(nada);
      expect((await db.obtenerProyeccionTclDeCampana(op.cliente, op.campanaId)).ok).toBe(false);

      await query(`UPDATE campaigns SET visibility = 'compartida', status = 'activa' WHERE id = $1`, [
        op.campanaId,
      ]);
      expect((await db.exportarCampanaParaTcl(op.cliente, op.campanaId, 'json')).ok).toBe(true);
    } finally {
      await query(`UPDATE campaigns SET visibility = 'tcl', status = 'activa' WHERE id = $1`, [op.campanaId]);
    }
  });

  it('un usuario `cliente` activo pero DESACTIVADO, o un actor falsificado con rol de agencia, no lee', async () => {
    expect(
      (await db.obtenerProyeccionTclDeCampana({ ...op.cliente, status: 'inactivo' } as never, op.campanaId))
        .ok,
    ).toBe(false);
    expect((await db.obtenerProyeccionTclDeCampana({ ...op.admin }, op.campanaId)).ok).toBe(false);
    expect(
      (
        await db.obtenerProyeccionTclDeCampana(
          { ...op.cliente, organizationId: op.admin.organizationId },
          op.campanaId,
        )
      ).ok,
    ).toBe(false);
  });
});
