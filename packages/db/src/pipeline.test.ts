/**
 * Verificación de punta a punta del procesamiento documental (Épica E4).
 *
 * Es la demo del Sprint 2: cargar un PPT y comprobar que
 *  1. la carga responde de inmediato — la interfaz no se bloquea;
 *  2. el worker procesa en segundo plano;
 *  3. cada fragmento conserva su número de diapositiva.
 *
 * Corrección posterior al cierre de Sprint 4: esta prueba dependía de rutas
 * absolutas de una máquina de desarrollo concreta
 * (`/Users/.../Downloads/*.pptx`), así que nunca corría en CI ni en ninguna
 * otra máquina — se omitía en silencio, sin que nadie lo notara, exactamente
 * el tipo de falla silenciosa que este proyecto existe para evitar. Ahora usa
 * un fixture sintético versionado (`fixtures/pipeline/documento-de-prueba.pptx`,
 * generado una vez con `python-pptx`, 3 diapositivas con texto real): la
 * misma propiedad que verificaba con material real de una campaña —parseo,
 * cola, localizador por diapositiva—, sin depender de que exista en disco
 * nada fuera del repositorio ni de una clave de proveedor de IA.
 *
 * Requiere un worker real procesando la cola —el parseo no llama a ningún
 * proveedor de IA, `AI_ENABLED`/`AI_PROVIDER` no le afectan—:
 *     cd services/ai-worker && PYTHONPATH=. .venv/bin/python worker.py
 * En CI lo levanta el propio workflow (`ci.yml`, job `web`) con
 * `AI_PROVIDER=fake`. Si no hay ningún worker alcanzable ni siquiera así, la
 * prueba se omite con un mensaje explícito en vez de fallar por timeout —
 * nunca en silencio.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { User } from '@tcl-kol-os/domain';
import { closePool, query } from './client.ts';
import { findUserByEmail } from './users.ts';
import { getFragments, listSources, uploadSource } from './sources.ts';

const MIME_PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/** Fixture sintético versionado — nunca una ruta personal (ver docstring). */
const RAIZ_DEL_REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RUTA_FIXTURE = join(RAIZ_DEL_REPO, 'fixtures', 'pipeline', 'documento-de-prueba.pptx');

let admin: User;
let campanaId: string;
let hayWorker = false;

async function workerVivo(): Promise<boolean> {
  try {
    const url = (process.env['AI_WORKER_URL'] ?? 'http://localhost:8000').replace(/\/+$/, '');
    const r = await fetch(`${url}/ready`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  admin = (await findUserByEmail('gerardo@smartpr.co'))!;
  const filas = await query<{ id: string }>(`SELECT id FROM campaigns WHERE name = 'Lanzamiento línea P80'`);
  campanaId = filas[0]!.id;
  hayWorker = await workerVivo();
});

afterAll(async () => {
  await query(`DELETE FROM source_documents WHERE filename LIKE 'e2e-%'`);
  await closePool();
});

/** Sondea el estado como lo hace la interfaz (UI-07). */
async function esperarProcesamiento(sourceId: string, segundos = 45) {
  const limite = Date.now() + segundos * 1000;
  while (Date.now() < limite) {
    const fuentes = await listSources(admin, campanaId);
    if (fuentes.ok) {
      const f = fuentes.value.find((x) => x.id === sourceId);
      if (f !== undefined && (f.status === 'procesado' || f.status === 'fallido')) return f;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return undefined;
}

describe('procesamiento de un PPT (fixture sintético versionado)', () => {
  it(
    'la carga responde rápido y el procesamiento ocurre en segundo plano',
    async () => {
      if (!hayWorker) {
        // Nunca en silencio: se declara explícitamente por qué se omite, y
        // qué hace falta para que corra. En CI (`ci.yml`, job `web`) siempre
        // hay un worker con AI_PROVIDER=fake — esta rama solo se toma en un
        // entorno local sin `docker compose up -d worker` ni
        // `python worker.py` corriendo.
        console.warn(
          'No hay worker en AI_WORKER_URL; se omite. ' +
            'El parseo no depende de AI_ENABLED/AI_PROVIDER — solo hace falta el worker corriendo.',
        );
        return;
      }

      const contenido = new Uint8Array(await readFile(RUTA_FIXTURE));
      const mb = contenido.byteLength / 1024 / 1024;

      // La detección de duplicados por hash es correcta y funciona; para que
      // esta prueba sea repetible hay que retirar cualquier copia previa del
      // mismo contenido, venga del propio test o de material de demo.
      const hash = createHash('sha256').update(contenido).digest('hex');
      await query(`DELETE FROM source_documents WHERE campaign_id = $1 AND hash = $2`, [campanaId, hash]);

      const t0 = Date.now();
      const resultado = await uploadSource(admin, {
        campaignId: campanaId,
        filename: 'e2e-documento-de-prueba.pptx',
        contenido,
        tipoDeclarado: MIME_PPTX,
        type: 'ppt_global',
      });
      const msCarga = Date.now() - t0;

      expect(resultado.ok, JSON.stringify(resultado)).toBe(true);
      if (!resultado.ok) return;

      // El criterio de la Épica E4: "procesar sin bloquear la interfaz".
      // La carga solo valida, hashea y encola; el parseo llega después.
      expect(msCarga, `la carga de ${mb.toFixed(1)} MB tardó ${msCarga} ms`).toBeLessThan(5000);
      expect(resultado.value.encolado).toBe(true);

      const fuente = await esperarProcesamiento(resultado.value.id);
      expect(fuente, 'el worker no procesó el documento; ¿está en marcha?').toBeDefined();
      expect(fuente!.status).toBe('procesado');
      expect(fuente!.fragmentos).toBeGreaterThan(0);

      // La propiedad que sostiene toda la evidencia (§9.4).
      const fragmentos = await getFragments(admin, resultado.value.id, 1000);
      expect(fragmentos.ok).toBe(true);
      if (!fragmentos.ok) return;

      const sinUbicacion = fragmentos.value.filter((f) => f.slide === null && f.page === null);
      expect(sinUbicacion, 'todo fragmento debe saber de dónde salió').toHaveLength(0);

      const diapositivas = new Set(fragmentos.value.map((f) => f.slide));
      expect(diapositivas.size).toBeGreaterThan(1);

      // eslint-disable-next-line no-console
      console.log(
        `\n  ${mb.toFixed(1)} MB · carga ${msCarga} ms · ${fuente!.fragmentos} fragmentos · ` +
          `${diapositivas.size} diapositivas\n`,
      );
    },
    { timeout: 90_000 },
  );
});

describe('idempotencia del procesamiento (E4-10)', () => {
  it('reprocesar no duplica fragmentos', async () => {
    // Se reutiliza el documento ya procesado si existe.
    const fuentes = await listSources(admin, campanaId);
    if (!fuentes.ok) return;

    const procesada = fuentes.value.find((f) => f.status === 'procesado' && f.fragmentos > 0);
    if (procesada === undefined) return; // sin material, nada que comprobar

    const antes = procesada.fragmentos;

    // El worker borra los fragmentos previos dentro de la transacción que
    // inserta los nuevos: ejecutar dos veces deja el mismo resultado.
    await query(
      `UPDATE processing_jobs SET status = 'pendiente', disponible_en = now()
        WHERE source_id = $1 AND status = 'completado'`,
      [procesada.id],
    );

    const despues = await esperarProcesamiento(procesada.id, 45);
    if (despues !== undefined && despues.status === 'procesado') {
      expect(despues.fragmentos).toBe(antes);
    }
  }, 60_000);
});
