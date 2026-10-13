/**
 * V2 · Fase 7 — revisión humana de guiones: CONCURRENCIA y ATOMICIDAD (`script-review.ts`).
 *
 * El mutex es el entregable (`bloquearEntregable`) y luego la versión FOR UPDATE: comentar, pedir
 * cambios y aprobar se serializan. Aquí se prueba con `Promise.all` y con ventanas deterministas
 * (una transacción de prueba que retiene el bloqueo mientras el caso de uso espera), y que un
 * fallo inyectado en cualquier punto de `solicitarCambiosDeScript` / `crearComentarioDeRevision`
 * no deja NADA a medias (ni comentarios ni estado).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Result, ScriptVersionStatus, User } from '@tcl-kol-os/domain';
import { closePool, getPool, query } from './client.ts';
import { adminPool } from './test-admin.ts';
import { crearEntregable } from './deliverables.ts';
import {
  crearComentarioDeRevision,
  listarComentariosDeRevision,
  solicitarCambiosDeScript,
} from './script-review.ts';
import { registrarVersionDeGuion } from './script-versions.ts';
import {
  type EscenarioDeContenido,
  crearEscenarioDeContenido,
  crearFuenteDeGuionDePrueba,
  limpiarEscenarioDeContenido,
} from './test-utils.ts';

let e: EscenarioDeContenido;

const valor = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
};
const codigo = <T>(r: Result<T>): string | undefined => (r.ok ? undefined : r.error.code);
const razon = <T>(r: Result<T>): unknown =>
  r.ok ? undefined : (r.error.details as { reason?: unknown } | undefined)?.reason;
const pausa = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

beforeAll(async () => {
  e = await crearEscenarioDeContenido('F7 revisión concurrencia');
});
afterAll(async () => {
  await limpiarEscenarioDeContenido(e);
  await closePool();
});

// ─────────────────────────── Ayudantes locales ─────────────────────────────────

let seq = 0;

async function nuevaVersion(): Promise<{ deliverableId: string; versionId: string }> {
  const n = ++seq;
  const entregable = valor(
    await crearEntregable(e.consultor, {
      campaignInfluencerId: e.participaciones.diego,
      label: `Concurrencia ${n} ${e.sufijo}`,
    }),
  );
  const fuente = await crearFuenteDeGuionDePrueba(e.campanaId, e.admin, `conc-${n}`);
  const r = valor(
    await registrarVersionDeGuion(e.consultor, {
      campaignId: e.campanaId,
      sourceId: fuente,
      participation: { participationId: e.participaciones.diego },
      deliverable: { id: entregable.id },
    }),
  );
  if (r.kind !== 'registered') throw new Error(`se esperaba registered y fue ${r.kind}`);
  return { deliverableId: entregable.id, versionId: r.version.id };
}

async function estado(versionId: string): Promise<ScriptVersionStatus> {
  const [f] = await query<{ status: ScriptVersionStatus }>(
    `SELECT status FROM script_versions WHERE id = $1`,
    [versionId],
  );
  return f!.status;
}

async function cuentaDeComentarios(versionId: string): Promise<number> {
  const [f] = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM script_review_comments WHERE script_version_id = $1`,
    [versionId],
  );
  return Number(f!.n);
}

async function cuentaDeAuditoria(action: string, entityId: string): Promise<number> {
  const [f] = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_events WHERE action = $1 AND entity_id = $2`,
    [action, entityId],
  );
  return Number(f!.n);
}

const comentar = (versionId: string, body: string, actor: User = e.consultor) =>
  crearComentarioDeRevision(actor, versionId, { kind: 'editorial', body });

// ─────────────────────────── Comentarios simultáneos ───────────────────────────

describe('comentarios simultáneos', () => {
  it('10 comentarios distintos sobre una versión recibida: todos entran y la revisión arranca UNA sola vez', async () => {
    const { versionId } = await nuevaVersion();
    const autores = [e.admin, e.director, e.consultor];
    const rs = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        comentar(versionId, `Comentario simultáneo ${i + 1}`, autores[i % 3]!),
      ),
    );
    const valores = rs.map(valor);
    expect(valores.every((v) => !v.deduplicated)).toBe(true);
    expect(valores.filter((v) => v.startedReview)).toHaveLength(1);
    expect(new Set(valores.map((v) => v.comment.id)).size).toBe(10);
    expect(await cuentaDeComentarios(versionId)).toBe(10);
    expect(await estado(versionId)).toBe('in_review');
    expect(await cuentaDeAuditoria('script_version.transition', versionId)).toBe(1);
    const creados = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_events
        WHERE action = 'script_review_comment.create' AND metadata->>'scriptVersionId' = $1`,
      [versionId],
    );
    expect(Number(creados[0]!.n)).toBe(10);
  });

  it('10 solicitudes IDÉNTICAS de la misma persona: una crea y las otras 9 devuelven el existente', async () => {
    const { versionId } = await nuevaVersion();
    const rs = await Promise.all(
      Array.from({ length: 10 }, () => comentar(versionId, 'El mismo comentario, diez veces')),
    );
    const valores = rs.map(valor);
    expect(valores.filter((v) => !v.deduplicated)).toHaveLength(1);
    expect(valores.filter((v) => v.deduplicated)).toHaveLength(9);
    expect(new Set(valores.map((v) => v.comment.id)).size).toBe(1);
    expect(await cuentaDeComentarios(versionId)).toBe(1);
    expect(await cuentaDeAuditoria('script_review_comment.create', valores[0]!.comment.id)).toBe(1);
  });
});

// ─────────────────────────── Comentar ‖ pedir cambios ──────────────────────────

describe('comentar ‖ solicitar cambios', () => {
  it('cada carrera termina coherente: la versión queda cerrada y el comentario o está o fue rechazado (not_open)', async () => {
    let comentariosQueEntraron = 0;
    let comentariosRechazados = 0;
    for (let ronda = 0; ronda < 8; ronda++) {
      const { versionId } = await nuevaVersion();
      const [c, s] = await Promise.all([
        comentar(versionId, `Comentario de la ronda ${ronda}`, e.director),
        solicitarCambiosDeScript(e.consultor, versionId, {
          items: [{ body: `Cambio de la ronda ${ronda}` }],
        }),
      ]);
      // Pedir cambios nunca pierde contra un comentario (un comentario no cierra la versión).
      valor(s);
      expect(await estado(versionId)).toBe('changes_requested');
      if (c.ok) {
        comentariosQueEntraron++;
        expect(await cuentaDeComentarios(versionId)).toBe(2);
      } else {
        comentariosRechazados++;
        expect(razon(c)).toBe('not_open');
        expect(await cuentaDeComentarios(versionId)).toBe(1);
      }
    }
    expect(comentariosQueEntraron + comentariosRechazados).toBe(8);
  });

  it('dos solicitudes de cambios simultáneas (dos personas): una gana, la otra ve not_open y no deja nada', async () => {
    const { versionId } = await nuevaVersion();
    const [a, b] = await Promise.all([
      solicitarCambiosDeScript(e.consultor, versionId, {
        items: [{ body: 'Cambio de la consultora uno' }, { body: 'Cambio de la consultora dos' }],
      }),
      solicitarCambiosDeScript(e.director, versionId, { items: [{ body: 'Cambio del director' }] }),
    ]);
    const ganadoras = [a, b].filter((r) => r.ok);
    const perdedoras = [a, b].filter((r) => !r.ok);
    expect(ganadoras).toHaveLength(1);
    expect(perdedoras).toHaveLength(1);
    expect(codigo(perdedoras[0]!)).toBe('RESOURCE_CONFLICT');
    expect(razon(perdedoras[0]!)).toBe('not_open');
    const ganadora = valor(ganadoras[0]!);
    expect(await cuentaDeComentarios(versionId)).toBe(ganadora.changeRequests.length);
    expect(await cuentaDeAuditoria('script_version.request_changes', versionId)).toBe(1);
    expect(await estado(versionId)).toBe('changes_requested');
  });

  it('10 solicitudes de cambios simultáneas sobre la misma versión: exactamente una gana', async () => {
    const { versionId } = await nuevaVersion();
    const rs = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        solicitarCambiosDeScript(i % 2 === 0 ? e.consultor : e.director, versionId, {
          items: [{ body: `Cambio concurrente ${i}` }],
        }),
      ),
    );
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    for (const r of rs.filter((x) => !x.ok)) expect(razon(r)).toBe('not_open');
    expect(await cuentaDeComentarios(versionId)).toBe(1);
    expect(await cuentaDeAuditoria('script_version.request_changes', versionId)).toBe(1);
  });
});

describe('orden de llegada bajo el mutex (determinista)', () => {
  /** Retiene el mutex del entregable; encola las acciones EN ORDEN (cada una espera) y lo suelta. */
  async function encoladas<T>(
    deliverableId: string,
    acciones: (() => Promise<Result<T>>)[],
  ): Promise<Result<T>[]> {
    const cliente = await getPool().connect();
    try {
      await cliente.query('BEGIN');
      await cliente.query(`SELECT 1 FROM deliverables WHERE id = $1 FOR UPDATE`, [deliverableId]);
      const pendientes: Promise<Result<T>>[] = [];
      for (const accion of acciones) {
        pendientes.push(accion());
        await pausa(250); // la siguiente llega DESPUÉS: queda detrás en la cola del bloqueo
      }
      await cliente.query('COMMIT');
      return await Promise.all(pendientes);
    } catch (error) {
      await cliente.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      cliente.release();
    }
  }

  it('pedir cambios llega primero → el comentario posterior ve la versión cerrada (not_open)', async () => {
    const { deliverableId, versionId } = await nuevaVersion();
    const [s, c] = await encoladas<unknown>(deliverableId, [
      () =>
        solicitarCambiosDeScript(e.consultor, versionId, { items: [{ body: 'Cambio que llega primero' }] }),
      () => comentar(versionId, 'Comentario que llega después', e.director),
    ]);
    valor(s as Result<unknown>);
    expect(razon(c as Result<unknown>)).toBe('not_open');
    expect(await cuentaDeComentarios(versionId)).toBe(1);
  });

  it('el comentario llega primero → entra y la solicitud de cambios posterior también (2 comentarios, versión cerrada)', async () => {
    const { deliverableId, versionId } = await nuevaVersion();
    const [c, s] = await encoladas<unknown>(deliverableId, [
      () => comentar(versionId, 'Comentario que llega primero', e.director),
      () =>
        solicitarCambiosDeScript(e.consultor, versionId, { items: [{ body: 'Cambio que llega después' }] }),
    ]);
    valor(c as Result<unknown>);
    valor(s as Result<unknown>);
    expect(await cuentaDeComentarios(versionId)).toBe(2);
    expect(await estado(versionId)).toBe('changes_requested');
    expect(await cuentaDeAuditoria('script_version.request_changes', versionId)).toBe(1);
  });
});

// ─────────────────────────── Aprobación fijada por SQL de prueba ───────────────

describe('comentar / pedir cambios ‖ una aprobación en curso (fijada por SQL de prueba)', () => {
  /**
   * Una transacción de prueba toma el mutex (entregable y versión FOR UPDATE), el caso de uso
   * arranca y debe ESPERAR; al confirmarse la aprobación, el caso de uso ve la versión aprobada.
   */
  async function conAprobacionEnCurso<T>(
    deliverableId: string,
    versionId: string,
    accion: () => Promise<Result<T>>,
  ): Promise<Result<T>> {
    const cliente = await getPool().connect();
    try {
      await cliente.query('BEGIN');
      await cliente.query(`SET LOCAL tclkolos.permitir_borrado_historico = 'on'`);
      await cliente.query(`SELECT 1 FROM deliverables WHERE id = $1 FOR UPDATE`, [deliverableId]);
      await cliente.query(`SELECT 1 FROM script_versions WHERE id = $1 FOR UPDATE`, [versionId]);
      let resuelta = false;
      const pendiente = accion().then((r) => {
        resuelta = true;
        return r;
      });
      await pausa(400);
      expect(resuelta, 'el caso de uso debe esperar al mutex del entregable').toBe(false);
      await cliente.query(
        `UPDATE script_versions SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`,
        [versionId, e.director.id],
      );
      await cliente.query('COMMIT');
      return await pendiente;
    } catch (error) {
      await cliente.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      cliente.release();
    }
  }

  it('un comentario que esperaba el mutex ve la versión aprobada: not_open y nada se escribe', async () => {
    const { deliverableId, versionId } = await nuevaVersion();
    const r = await conAprobacionEnCurso(deliverableId, versionId, () =>
      comentar(versionId, 'Comentario en carrera'),
    );
    expect(codigo(r)).toBe('RESOURCE_CONFLICT');
    expect(razon(r)).toBe('not_open');
    expect(await estado(versionId)).toBe('approved');
    expect(await cuentaDeComentarios(versionId)).toBe(0);
    expect(await cuentaDeAuditoria('script_version.transition', versionId)).toBe(0);
  });

  it('una solicitud de cambios que esperaba el mutex ve la versión aprobada: not_open y la versión queda aprobada', async () => {
    const { deliverableId, versionId } = await nuevaVersion();
    const r = await conAprobacionEnCurso(deliverableId, versionId, () =>
      solicitarCambiosDeScript(e.consultor, versionId, { items: [{ body: 'Cambio en carrera' }] }),
    );
    expect(razon(r)).toBe('not_open');
    expect(await estado(versionId)).toBe('approved');
    expect(await cuentaDeComentarios(versionId)).toBe(0);
    expect(await cuentaDeAuditoria('script_version.request_changes', versionId)).toBe(0);
  });

  it('la lectura no espera al mutex: sigue disponible mientras hay una aprobación en curso', async () => {
    const { deliverableId, versionId } = await nuevaVersion();
    valor(await comentar(versionId, 'Comentario previo de la lectura'));
    const r = await conAprobacionEnCurso(deliverableId, versionId, async () => {
      // Esto resuelve ya (no bloquea): `conAprobacionEnCurso` espera que la acción SIGA pendiente,
      // así que se encadena tras una pausa para medir que la lectura respondió sin esperar.
      const antes = Date.now();
      const lectura = await listarComentariosDeRevision(e.consultor, versionId);
      expect(Date.now() - antes).toBeLessThan(300);
      await pausa(500);
      return lectura;
    });
    expect(valor(r).total).toBe(1);
  });
});

// ─────────────────────────── Atomicidad con fallos inyectados ──────────────────

describe('atomicidad: un fallo inyectado no deja comentarios ni estado a medias', () => {
  const FUNCION = 'test_fallo_inyectado_w2b';

  type Punto =
    | { tipo: 'auditoria'; action: string; entityId: string }
    | { tipo: 'estado'; destino: string; versionId: string }
    | { tipo: 'comentario'; body: string };

  /** Un trigger de prueba, SOLO para el recurso indicado, que lanza una excepción real de base. */
  async function conFalloEn(punto: Punto, fn: () => Promise<void>): Promise<void> {
    const pool = adminPool();
    await pool.query(`
      CREATE OR REPLACE FUNCTION ${FUNCION}() RETURNS trigger AS $$
      BEGIN
        IF TG_ARGV[0] = 'auditoria' THEN
          IF NEW.action = TG_ARGV[1] AND NEW.entity_id::text = TG_ARGV[2] THEN
            RAISE EXCEPTION 'fallo inyectado: auditoría %', TG_ARGV[1];
          END IF;
        ELSIF TG_ARGV[0] = 'estado' THEN
          IF NEW.status::text = TG_ARGV[1] AND NEW.id::text = TG_ARGV[2] THEN
            RAISE EXCEPTION 'fallo inyectado: estado %', TG_ARGV[1];
          END IF;
        ELSIF TG_ARGV[0] = 'comentario' THEN
          IF NEW.body = TG_ARGV[1] THEN
            RAISE EXCEPTION 'fallo inyectado: comentario';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`);
    const tabla =
      punto.tipo === 'auditoria'
        ? 'audit_events'
        : punto.tipo === 'estado'
          ? 'script_versions'
          : 'script_review_comments';
    const evento = punto.tipo === 'estado' ? 'UPDATE' : 'INSERT';
    const argumentos =
      punto.tipo === 'auditoria'
        ? `'auditoria', '${punto.action}', '${punto.entityId}'`
        : punto.tipo === 'estado'
          ? `'estado', '${punto.destino}', '${punto.versionId}'`
          : `'comentario', '${punto.body.replace(/'/g, "''")}'`;
    const trigger = `${FUNCION}_${Math.random().toString(36).slice(2, 10)}`;
    await pool.query(
      `CREATE TRIGGER ${trigger} BEFORE ${evento} ON ${tabla}
         FOR EACH ROW EXECUTE FUNCTION ${FUNCION}(${argumentos})`,
    );
    try {
      await fn();
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON ${tabla}`);
    }
  }

  /** El caso de uso NO debe terminar bien: error de dominio o excepción de la base. */
  async function falla(p: Promise<Result<unknown>>): Promise<void> {
    try {
      const r = await p;
      expect(r.ok, 'el fallo inyectado debía impedir el resultado').toBe(false);
    } catch (error) {
      expect((error as Error).message).toMatch(/fallo inyectado/);
    }
  }

  async function sinRastro(versionId: string, esperado: ScriptVersionStatus): Promise<void> {
    expect(await estado(versionId)).toBe(esperado);
    expect(await cuentaDeComentarios(versionId)).toBe(0);
    expect(await cuentaDeAuditoria('script_version.request_changes', versionId)).toBe(0);
    expect(await cuentaDeAuditoria('script_version.transition', versionId)).toBe(0);
  }

  const items = [
    { body: 'Primer cambio atómico' },
    { body: 'Segundo cambio atómico' },
    { body: 'Tercer cambio atómico' },
  ];

  it('solicitarCambios: fallo en la auditoría → ni comentarios ni cambio de estado', async () => {
    const { versionId } = await nuevaVersion();
    await conFalloEn(
      { tipo: 'auditoria', action: 'script_version.request_changes', entityId: versionId },
      async () => {
        await falla(solicitarCambiosDeScript(e.consultor, versionId, { items, nota: 'Una nota atómica' }));
      },
    );
    await sinRastro(versionId, 'received');
    // Sin el fallo, el mismo pedido sí funciona (la versión quedó utilizable).
    valor(await solicitarCambiosDeScript(e.consultor, versionId, { items, nota: 'Una nota atómica' }));
    expect(await cuentaDeComentarios(versionId)).toBe(4);
  });

  it('solicitarCambios: fallo al cambiar el estado → los comentarios ya insertados se deshacen', async () => {
    const { versionId } = await nuevaVersion();
    await conFalloEn({ tipo: 'estado', destino: 'changes_requested', versionId }, async () => {
      await falla(solicitarCambiosDeScript(e.consultor, versionId, { items }));
    });
    await sinRastro(versionId, 'received');
  });

  it('solicitarCambios: fallo en el tercer comentario → los dos primeros se deshacen y la versión sigue abierta', async () => {
    const { versionId } = await nuevaVersion();
    await conFalloEn({ tipo: 'comentario', body: 'Tercer cambio atómico' }, async () => {
      await falla(solicitarCambiosDeScript(e.consultor, versionId, { items }));
    });
    await sinRastro(versionId, 'received');
  });

  it('crearComentario: fallo en la auditoría → ni comentario ni arranque de la revisión', async () => {
    const { versionId } = await nuevaVersion();
    const previo = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_events WHERE action = 'script_review_comment.create' AND metadata->>'scriptVersionId' = $1`,
      [versionId],
    );
    expect(previo[0]!.n).toBe('0');
    // La auditoría del comentario se identifica por su acción y la versión en la metadata: el
    // trigger de prueba filtra por acción y entidad, así que se inyecta sobre TODA la acción
    // para esta versión recién creada usando el id de la versión como filtro de metadata.
    const pool = adminPool();
    const funcion = 'test_fallo_inyectado_w2b_meta';
    await pool.query(`
      CREATE OR REPLACE FUNCTION ${funcion}() RETURNS trigger AS $$
      BEGIN
        IF NEW.action = 'script_review_comment.create' AND NEW.metadata->>'scriptVersionId' = TG_ARGV[0] THEN
          RAISE EXCEPTION 'fallo inyectado: auditoría del comentario';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`);
    const trigger = `${funcion}_${Math.random().toString(36).slice(2, 10)}`;
    await pool.query(
      `CREATE TRIGGER ${trigger} BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION ${funcion}('${versionId}')`,
    );
    try {
      await falla(comentar(versionId, 'Comentario atómico'));
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON audit_events`);
    }
    await sinRastro(versionId, 'received');
    expect(valor(await comentar(versionId, 'Comentario atómico')).startedReview).toBe(true);
  });

  it('crearComentario: fallo al insertar → no queda la revisión arrancada (la versión sigue received)', async () => {
    const { versionId } = await nuevaVersion();
    await conFalloEn({ tipo: 'comentario', body: 'Comentario que falla al insertar' }, async () => {
      await falla(comentar(versionId, 'Comentario que falla al insertar'));
    });
    await sinRastro(versionId, 'received');
  });
});
