/**
 * QA de contexto · sección `content` (V2 · Fase 7): entregables y su última versión, ensamblados con el
 * ensamblador REAL contra PostgreSQL real (base `_test`).
 *
 * La sección lleva solo estados, conteos y alias (E, V, P): NUNCA texto de guion, de hallazgos ni de
 * comentarios. Presupuesto 3 000 caracteres / 20 ítems / 260 por ítem, con truncado explícito. Los alias del
 * contexto son los que luego resuelven las tools (alias-only).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type * as DbModule from '@tcl-kol-os/db';
import {
  closePool,
  crearEntregable,
  ensamblarContexto,
  proponerAccion,
  query,
  solicitarAnalisisDeGuion,
  solicitarCambiosDeScript,
} from '@tcl-kol-os/db';
import { limpiarEscenarioDeContenido } from '@tcl-kol-os/db/test-utils';
import { PRESUPUESTO_POR_DEFECTO, RegistroDeReferencias, verificarSobres } from '@tcl-kol-os/domain';
import { abrirTurno, json, llamar, registro } from '../tools/test-support.ts';
import {
  type MundoDeContenido,
  clienteQueResponde,
  crearMundoDeContenido,
  registrarVersionDePrueba,
} from './testing/contenido.ts';
import type { User } from '@tcl-kol-os/domain';
import { vi } from 'vitest';
import type { EstadoDeAnalisis } from './testing/contenido.ts';

const analisis = vi.hoisted(() => ({ cliente: undefined, iaActiva: true }) as EstadoDeAnalisis);
vi.mock('@tcl-kol-os/db', async (importOriginal) => {
  const real = await importOriginal<typeof DbModule>();
  return {
    ...real,
    solicitarAnalisisDeGuion: (
      actor: Parameters<typeof real.solicitarAnalisisDeGuion>[0],
      versionId: string,
      input: Parameters<typeof real.solicitarAnalisisDeGuion>[2],
      contexto?: Parameters<typeof real.solicitarAnalisisDeGuion>[3],
    ) =>
      real.solicitarAnalisisDeGuion(actor, versionId, input, contexto, {
        ...(analisis.cliente === undefined ? {} : { cliente: analisis.cliente }),
        env: (n: string) =>
          n === 'AI_ENABLED' ? String(analisis.iaActiva) : n === 'AI_PROVIDER' ? 'fake' : undefined,
      }),
  };
});

const r = registro();
const SECRETO = 'secreto-de-prueba-del-servidor-f7-contexto';
const MARCA_DE_GUION = 'MARCADOR-SECRETO-DEL-GUION';
let m: MundoDeContenido;
let iaAntes: string | undefined;
let contadorDeRun = 0;
let vPendiente: string;
let vCambios: string;
let vConHallazgos: string;

beforeAll(async () => {
  iaAntes = process.env['AI_ENABLED'];
  process.env['AI_ENABLED'] = 'true';
  m = await crearMundoDeContenido('QA contexto contenido');
  const texto = [
    `Hola, este es el guion. ${MARCA_DE_GUION} y la oferta única.`,
    'Segundo fragmento del guion.',
  ];

  // Prioridad 0: propuesta de aprobación abierta (storyRios)
  const a = await registrarVersionDePrueba(
    m.e,
    m.e.entregables.storyRios,
    m.e.participaciones.valentinaRios,
    m.e.consultor,
    texto,
  );
  vPendiente = a.versionId;
  analisis.cliente = clienteQueResponde([
    {
      category: 'cta_missing',
      refs: ['accion_kpis.accion_esperada'],
      description: `Hallazgo con ${MARCA_DE_GUION}.`,
    },
  ]);
  const an = await solicitarAnalisisDeGuion(m.e.consultor, vPendiente, {
    mode: 'ensure',
    idempotencyKey: `ctx-a-${Date.now().toString(36)}`,
  });
  if (!an.ok) throw new Error(`análisis: ${an.error.code}`);
  const p = await proponerAccion(m.e.consultor, {
    type: 'script_version.approve',
    resourceId: vPendiente,
    origin: 'chat',
  });
  if (!p.ok) throw new Error(`propuesta: ${p.error.code}`);

  // Prioridad 1: cambios solicitados (reelRios)
  const b = await registrarVersionDePrueba(
    m.e,
    m.e.entregables.reelRios,
    m.e.participaciones.valentinaRios,
    m.e.consultor,
    texto,
  );
  vCambios = b.versionId;
  const c = await solicitarCambiosDeScript(m.e.consultor, vCambios, {
    items: [{ body: `Cambiar el cierre ${MARCA_DE_GUION}` }],
  });
  if (!c.ok) throw new Error(`cambios: ${c.error.code}`);

  // Prioridad 2: hallazgos abiertos (reelGomez)
  const d = await registrarVersionDePrueba(
    m.e,
    m.e.entregables.reelGomez,
    m.e.participaciones.valentinaGomez,
    m.e.consultor,
    texto,
  );
  vConHallazgos = d.versionId;
  analisis.cliente = clienteQueResponde([
    { category: 'cta_missing', refs: ['accion_kpis.accion_esperada'] },
    { category: 'requirement_not_covered', refs: ['mensaje_principal.mensaje_clave'] },
  ]);
  const an2 = await solicitarAnalisisDeGuion(m.e.consultor, vConHallazgos, {
    mode: 'ensure',
    idempotencyKey: `ctx-d-${Date.now().toString(36)}`,
  });
  if (!an2.ok) throw new Error(`análisis: ${an2.error.code} ${JSON.stringify(an2.error.details)}`);

  // Resto: 36 entregables de Diego sin guion → 40 entregables en total
  for (let i = 0; i < 36; i += 1) {
    const x = await crearEntregable(m.e.consultor, {
      campaignInfluencerId: m.e.participaciones.diego,
      label: `Pieza de relleno ${String(i + 1).padStart(2, '0')}`,
    });
    if (!x.ok) throw new Error(x.error.message);
  }
});
afterAll(async () => {
  if (iaAntes === undefined) delete process.env['AI_ENABLED'];
  else process.env['AI_ENABLED'] = iaAntes;
  await limpiarEscenarioDeContenido(m.e);
  await closePool();
});

async function contexto(actor: User, adjuntos: string[] = []) {
  contadorDeRun += 1;
  const x = await ensamblarContexto(actor, {
    conversationId: `conv-${contadorDeRun}`,
    messageId: `msg-${contadorDeRun}`,
    runId: `run-f7-${Date.now().toString(36)}-${contadorDeRun}`,
    campaignId: m.e.campanaId,
    nonceSecret: SECRETO,
    mensajeActual: {
      texto: 'Dame el estado de los guiones',
      adjuntos: adjuntos.map((sourceId) => ({ sourceId })),
    },
    ventana: [],
    ahora: new Date('2026-10-06T12:00:00.000Z'),
  });
  if (!x.ok) throw new Error(`${x.error.code}: ${x.error.message}`);
  return x.value;
}

describe('sección `content`', () => {
  it('40 entregables ⇒ ≤20 ítems, ≤3 000 caracteres y un truncado EXPLÍCITO (herramienta sugerida)', async () => {
    const c = await contexto(m.e.consultor);
    const sec = c.secciones.find((s) => s.id === 'content');
    expect(sec, 'la sección content debe estar').toBeDefined();
    const presupuesto = PRESUPUESTO_POR_DEFECTO.secciones.content;
    expect(sec!.items).toBeLessThanOrEqual(presupuesto.maxItems);
    expect(sec!.items).toBe(20);
    expect(sec!.chars).toBeLessThanOrEqual(presupuesto.maxChars + 600); // encabezado confiable + aviso
    for (const i of sec!.itemsIncluidos)
      expect(i.texto.length).toBeLessThanOrEqual(presupuesto.maxCharsPorItem);
    // encabezado con el total real y aviso de omisión que apunta a la tool de lectura
    expect(sec!.texto).toContain('Entregables activos de la campaña: 40');
    expect(sec!.texto).toMatch(/se omitieron 20 elemento\(s\)/);
    expect(sec!.texto).toContain('deliverable_list');
    const informe = c.informe.sections.find((s) => s.id === 'content')!;
    expect(informe).toMatchObject({ available: true, included: true, items: 20 });
    expect(informe.omissions.reduce((n, o) => n + o.count, 0)).toBeGreaterThanOrEqual(20);
    expect(c.informe).toMatchObject({ assemblerVersion: 'ctx-2', budgetVersion: 'budget-2' });
  });

  it('orden por atención: propuesta pendiente > cambios solicitados > hallazgos abiertos > resto', async () => {
    const c = await contexto(m.e.consultor);
    const lineas = c.secciones.find((s) => s.id === 'content')!.itemsIncluidos.map((i) => i.texto);
    expect(lineas[0]).toContain('propuesta de aprobación pendiente');
    expect(lineas[0]).toContain('Story de lanzamiento');
    expect(lineas[1]).toContain('cambios solicitados');
    expect(lineas[1]).toContain('cambios pedidos: 1');
    expect(lineas[2]).toMatch(/hallazgos: 2 \(alta \d+, media \d+, baja \d+\)/);
    expect(lineas[2]).toContain('análisis: vigente');
    expect(lineas[3]).toContain('sin guion recibido');
    // una línea por entregable, solo estados y alias
    expect(lineas[0]).toMatch(
      /^E\d+ \| P\d+ \| nombre: "Valentina Ríos" \| entregable: "Story de lanzamiento" \| última V\d+ \(n=1,/,
    );
  });

  it('nunca texto de guion, de hallazgos ni de cambios pedidos: ni un marcador ni una descripción', async () => {
    const c = await contexto(m.e.consultor);
    const todo = [c.texto.sistema, c.texto.contexto, c.texto.mensajeActual].join('\n');
    expect(todo).not.toContain(MARCA_DE_GUION);
    expect(todo).not.toContain('oferta única');
    expect(todo).not.toContain('Falta la llamada a la acción');
    // la frontera se cumple
    expect(verificarSobres(c.texto.contexto, c.nonce).violaciones).toEqual([]);
    // los datos de personas (nombre, etiqueta, archivo) van dentro del sobre `content_state`
    const sec = c.secciones.find((s) => s.id === 'content')!;
    expect(sec.noConfiable.join('\n')).toContain('kind=content_state');
    expect(sec.confiable).not.toContain('Valentina');
    expect(sec.confiable).not.toContain('Story de lanzamiento');
  });

  it('un adjunto del turno trae como mucho 2 fragmentos de su texto (en sobre); un guion NO adjunto, ninguno', async () => {
    const fuente = (
      await query<{ source_document_id: string }>(
        `SELECT source_document_id FROM script_versions WHERE id = $1`,
        [vCambios],
      )
    )[0]!.source_document_id;
    const sinAdjunto = await contexto(m.e.consultor);
    expect(sinAdjunto.texto.contexto).not.toContain(MARCA_DE_GUION);
    const conAdjunto = await contexto(m.e.consultor, [fuente]);
    const texto = conAdjunto.texto.contexto;
    expect(texto).toContain(MARCA_DE_GUION);
    expect(texto.split(MARCA_DE_GUION).length - 1).toBeLessThanOrEqual(2);
    // y está dentro de un sobre de fragmento del adjunto
    const fuera = texto.replace(/<<<NC:[\s\S]*?<<<FIN:[0-9a-f]+>>>/g, '');
    expect(fuera).not.toContain(MARCA_DE_GUION);
  });

  it('una fuente SENSIBLE adjunta: ni su nombre ni su texto llegan (regla QA-04); la sección content no la nombra', async () => {
    const c = await contexto(m.e.consultor, [m.e.fuentes.sensible]);
    const todo = c.texto.contexto;
    expect(todo).not.toContain('guion-sensible');
    expect(todo).not.toContain('Texto sintético del guion guion-sensible');
    expect(todo).toContain('restringida');
  });

  it('la sección se AUSENTA (sin encabezado ni conteo) para los roles sin acceso a contenido', async () => {
    for (const u of [m.e.operativo, m.e.analista, m.e.legal]) {
      const c = await contexto(u);
      const informe = c.informe.sections.find((s) => s.id === 'content')!;
      expect(informe, u.role).toMatchObject({ available: false, included: false, items: 0 });
      expect(c.texto.contexto, u.role).not.toContain('Entregables activos');
      expect(c.texto.contexto, u.role).not.toContain('content_state');
    }
    // el cliente no recibe NINGÚN contexto
    await expect(contexto(m.e.cliente)).rejects.toThrow(/FORBIDDEN_ROLE/);
  });
});

describe('alias del contexto ⇒ alias que resuelven las tools', () => {
  it('E, V y P del contexto están en el registro y las tools los aceptan; un UUID del mismo recurso, no', async () => {
    const c = await contexto(m.e.consultor);
    const refs = c.registro.listar();
    expect(refs.filter((x) => x.kind === 'deliverable').length).toBeGreaterThanOrEqual(20);
    expect(refs.filter((x) => x.kind === 'script_version').length).toBe(3);
    const v = refs.find((x) => x.kind === 'script_version' && x.entityId === vConHallazgos)!;
    const e = refs.find((x) => x.kind === 'deliverable' && x.entityId === m.e.entregables.reelGomez)!;
    expect(v.alias).toMatch(/^V\d+$/);
    expect(e.alias).toMatch(/^E\d+$/);

    // el run de la tool usa EL MISMO registro que armó el contexto
    const t = await abrirTurno(m.e.consultor, m.e.campanaId, 'Dame el estado del guion de Gómez');
    Object.assign(t, { referencias: RegistroDeReferencias.importar(c.registro.exportar()) });
    const x = await llamar(r, t, 'script_version_get', { versionId: v.alias });
    expect(x.status).toBe('succeeded');
    expect(json(x)).toMatchObject({ ref: v.alias, number: 1 });
    const g = await llamar(r, t, 'deliverable_get', { deliverableId: e.alias });
    expect(g.status).toBe('succeeded');
    // el mismo recurso por UUID: no
    const porUuid = await llamar(r, t, 'script_version_get', { versionId: vConHallazgos });
    expect(porUuid.errorCode).toBe('VALIDATION_FAILED');
  });

  it('el registro solo conserva lo que llegó al contexto: un entregable omitido por el tope NO tiene alias', async () => {
    const c = await contexto(m.e.consultor);
    const incluidos = new Set(c.secciones.find((s) => s.id === 'content')!.itemsIncluidos.map((i) => i.id));
    const entregables = c.registro.listar().filter((x) => x.kind === 'deliverable');
    for (const ref of entregables) expect(incluidos.has(ref.entityId!), ref.alias).toBe(true);
    // 40 existen; solo 20 tienen alias
    expect(entregables).toHaveLength(20);
  });
});
