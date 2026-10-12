import { describe, expect, it } from 'vitest';
import { catalogoDelBrief } from './brief-catalog';
import { KPI_METRICS } from './kpi-metrics';
import {
  CLAVES_DE_BRIEF_EXCLUIDAS_PARA_TCL,
  CLAVES_DE_BRIEF_PARA_TCL,
  CLAVES_DE_DTO_TCL,
  asegurarProyeccionTcl,
  estadoDeCampanaParaTcl,
  estadoDeContenidoParaTcl,
  estadoDeKpiParaTcl,
  fechaParaTcl,
  proyectarBriefParaTcl,
  proyectarCampanaDetalleParaTcl,
  proyectarCampanaListaParaTcl,
  proyectarContenidoParaTcl,
  proyectarDocumentoParaTcl,
  proyectarInfluencerParaTcl,
  proyectarKpiParaTcl,
  valorDeBriefParaTcl,
} from './tcl-projection';
import {
  clavesProhibidasEn,
  esClaveProhibidaTcl,
  proyectarOperacionParaTcl,
} from './tcl-projection-operacion';

function claves(o: object): string[] {
  return Object.keys(o).sort();
}
function esperadas(nombre: keyof typeof CLAVES_DE_DTO_TCL): string[] {
  return [...CLAVES_DE_DTO_TCL[nombre]].sort();
}

const OP = proyectarOperacionParaTcl({
  participacionId: 'p1',
  nombreVisible: 'Valentina Ríos',
  unidadesComprometidas: 2,
  unidadesEntregadas: 2,
  hayEnvioAbierto: false,
  entregablesTotales: 2,
  entregablesConGuionAprobado: 2,
});

describe('catálogo del Brief: lista blanca completa y explícita', () => {
  it('lista blanca ∪ exclusiones = catálogo completo, sin solapes (una clave nueva exige decisión)', () => {
    const catalogo = catalogoDelBrief().map((c) => c.key);
    const permitidas = new Set(CLAVES_DE_BRIEF_PARA_TCL);
    const excluidas = new Set(CLAVES_DE_BRIEF_EXCLUIDAS_PARA_TCL);
    for (const k of permitidas) expect(excluidas.has(k), `${k} en ambas listas`).toBe(false);
    expect([...permitidas, ...excluidas].sort()).toEqual([...catalogo].sort());
  });
  it('el presupuesto y las fechas estructuradas están excluidos', () => {
    expect(CLAVES_DE_BRIEF_PARA_TCL).not.toContain('practico.presupuesto');
    expect(CLAVES_DE_BRIEF_EXCLUIDAS_PARA_TCL).toContain('practico.presupuesto');
  });
});

describe('estados client-safe: todo estado interno colapsa a mínimos', () => {
  it('campaña', () => {
    expect(estadoDeCampanaParaTcl('activa')).toBe('en_curso');
    expect(estadoDeCampanaParaTcl('archivada')).toBe('finalizada');
    expect(estadoDeCampanaParaTcl('cualquier-cosa')).toBe('finalizada');
  });
  it('contenido: solo `approved` es aprobado; el resto no deja rastro', () => {
    expect(estadoDeContenidoParaTcl('approved')).toBe('aprobado');
    for (const s of ['received', 'in_review', 'changes_requested', 'superseded', 'draft', null, undefined]) {
      expect(estadoDeContenidoParaTcl(s)).toBe('pendiente');
    }
  });
  it('kpi: no_comparable y sin_medicion colapsan', () => {
    expect(estadoDeKpiParaTcl('cumplido')).toBe('cumplido');
    expect(estadoDeKpiParaTcl('por_debajo')).toBe('por_debajo');
    expect(estadoDeKpiParaTcl('no_comparable')).toBe('sin_medicion');
    expect(estadoDeKpiParaTcl('sin_medicion')).toBe('sin_medicion');
    expect(estadoDeKpiParaTcl('lo-que-sea')).toBe('sin_medicion');
  });
  it('fechas', () => {
    expect(fechaParaTcl('2026-10-11')).toBe('2026-10-11');
    expect(fechaParaTcl('2026-10-11T05:00:00.000Z')).toBe('2026-10-11');
    expect(fechaParaTcl('ayer')).toBeNull();
    expect(fechaParaTcl(new Date())).toBeNull();
  });
});

describe('campaña: lista y detalle', () => {
  const entrada = {
    id: 'c1',
    nombre: 'Lanzamiento P80',
    mercado: 'CO',
    categoria: 'Smartphones',
    fechaInicio: '2026-11-01',
    fechaFin: '2026-12-01',
    estadoInterno: 'activa',
  };
  it('lista: claves exactas, sin owner, presupuesto, confidencialidad ni visibilidad', () => {
    const sucia = {
      ...entrada,
      ownerId: 'u1',
      ownerName: 'Gerardo',
      budget: 1,
      confidentiality_level: 'interna',
      visibility: 'tcl',
      organization_id: 'o1',
    } as unknown as typeof entrada;
    const r = proyectarCampanaListaParaTcl(sucia);
    expect(claves(r)).toEqual(esperadas('campanaLista'));
    expect(JSON.stringify(r)).not.toContain('u1');
    expect(r.estado).toBe('en_curso');
  });
  it('detalle: claves exactas (incluidos conteos y productos)', () => {
    const r = proyectarCampanaDetalleParaTcl({
      ...entrada,
      influencersActivos: 3,
      guionesAprobados: 5,
      guionesTotales: 4,
      kpiCumplidos: 1,
      kpiTotales: 2,
      productos: [
        { marca: 'TCL', modelo: 'P80', categoria: 'Smartphone', rol: 'flagship', presupuesto: 0.6 },
      ],
    } as never);
    expect(claves(r)).toEqual(esperadas('campanaDetalle'));
    expect(claves(r.conteos)).toEqual(esperadas('conteos'));
    expect(claves(r.productos[0]!)).toEqual(esperadas('producto'));
    // aprobados nunca supera el total
    expect(r.conteos.guionesAprobados).toBe(4);
  });
  it('un nombre o categoría con dinero se omite (null), no se recorta', () => {
    const r = proyectarCampanaListaParaTcl({
      ...entrada,
      nombre: 'P80 fee $5.000.000',
      categoria: 'ana@x.co',
    });
    expect(r.nombre).toBeNull();
    expect(r.categoria).toBeNull();
    expect(r.mercado).toBe('CO');
  });
});

describe('KPI', () => {
  const base = {
    metric: 'views',
    unit: 'count',
    comparator: 'gte',
    target: 100000,
    actual: 85000,
    achievement: 85,
    estado: 'por_debajo',
    platform: 'instagram',
    observedAt: '2026-10-05T12:00:00.000Z',
  };
  it('objetivo, resultado y cumplimiento compatibles', () => {
    const k = proyectarKpiParaTcl(base)!;
    expect(claves(k)).toEqual(esperadas('kpi'));
    expect(k).toMatchObject({
      metrica: 'views',
      unidad: 'count',
      objetivo: 100000,
      resultado: 85000,
      cumplimiento: 85,
      estado: 'por_debajo',
      fecha: '2026-10-05',
    });
  });
  it('la métrica `other` nunca sale (su etiqueta es texto libre)', () => {
    expect(proyectarKpiParaTcl({ ...base, metric: 'other', unit: 'other' })).toBeNull();
    expect(proyectarKpiParaTcl({ ...base, metric: 'other', unit: 'count' })).toBeNull();
  });
  it('métrica fuera del catálogo o unidad incompatible con la del catálogo no sale', () => {
    expect(proyectarKpiParaTcl({ ...base, metric: 'cpm' })).toBeNull();
    expect(proyectarKpiParaTcl({ ...base, unit: 'percent' })).toBeNull();
    expect(proyectarKpiParaTcl({ ...base, metric: 'engagement_rate', unit: 'count' })).toBeNull();
    expect(proyectarKpiParaTcl({ ...base, comparator: 'eq' })).toBeNull();
    expect(proyectarKpiParaTcl({ ...base, target: Number.NaN })).toBeNull();
  });
  it('sin medición comparable: ni resultado, ni cumplimiento, ni fecha (aunque la entrada los traiga)', () => {
    for (const estado of ['sin_medicion', 'no_comparable']) {
      const k = proyectarKpiParaTcl({ ...base, estado })!;
      expect(k).toMatchObject({ estado: 'sin_medicion', resultado: null, cumplimiento: null, fecha: null });
      expect(k.objetivo).toBe(100000);
    }
    const sinActual = proyectarKpiParaTcl({ ...base, actual: null, achievement: null, estado: 'cumplido' })!;
    expect(sinActual.estado).toBe('sin_medicion');
  });
  it('todas las métricas del catálogo salvo `other` son representables', () => {
    for (const m of KPI_METRICS.filter((x) => x !== 'other')) {
      const unit = m === 'engagement_rate' ? 'percent' : 'count';
      expect(proyectarKpiParaTcl({ ...base, metric: m, unit })?.metrica).toBe(m);
    }
  });
  it('la plataforma solo admite un identificador corto en minúsculas', () => {
    expect(proyectarKpiParaTcl({ ...base, platform: 'Instagram DM 3001234567' })!.plataforma).toBeNull();
    expect(proyectarKpiParaTcl({ ...base, platform: null })!.plataforma).toBeNull();
  });
});

describe('influencer, contenido y documento', () => {
  it('influencer: claves exactas y se arma desde la MISMA proyección operativa', () => {
    const kpi = proyectarKpiParaTcl({
      metric: 'views',
      unit: 'count',
      comparator: 'gte',
      target: 10,
      actual: 5,
      achievement: 50,
      estado: 'por_debajo',
      platform: null,
      observedAt: '2026-10-05',
    })!;
    const r = proyectarInfluencerParaTcl({
      operacion: OP,
      cuentas: [
        { plataforma: 'instagram', handle: 'valentina.rios', profileUrl: 'https://x', email: 'a@b.co' },
        { plataforma: 'tiktok', handle: 'ana 3001234567' },
        { plataforma: 'Mala Plataforma!', handle: 'x' },
      ] as never,
      productos: [{ marca: 'TCL', modelo: 'P80', categoria: 'Smartphone' }],
      kpis: [kpi],
    });
    expect(claves(r)).toEqual(esperadas('influencer'));
    expect(claves(r.cuentas[0]!)).toEqual(esperadas('cuenta'));
    expect(claves(r.guion)).toEqual(esperadas('guion'));
    expect(r.cuentas).toEqual([
      { plataforma: 'instagram', handle: 'valentina.rios' },
      { plataforma: 'tiktok', handle: null },
    ]);
    expect(r.etapa).toBe(OP.etapa);
    expect(r.guion).toEqual(OP.guion);
    expect(JSON.stringify(r)).not.toMatch(/a@b\.co|https:\/\/x/u);
  });

  it('contenido: aprobado con fecha; todo lo demás es «pendiente» sin rastro', () => {
    const entrada = {
      participacionId: 'p1',
      entregableId: 'e1',
      etiqueta: 'Reel principal',
      plataforma: 'instagram',
      producto: { marca: 'TCL', modelo: 'P80', categoria: 'x' },
      estadoDeLaVersionAprobada: 'approved',
      aprobadoEl: '2026-10-05T12:00:00.000Z',
    };
    const ok = proyectarContenidoParaTcl(entrada);
    expect(claves(ok)).toEqual(esperadas('contenido'));
    expect(claves(ok.entregable)).toEqual(esperadas('entregable'));
    expect(ok.estado).toBe('aprobado');
    expect(ok.aprobadoEl).toBe('2026-10-05T12:00:00.000Z');
    for (const interno of ['received', 'in_review', 'changes_requested', 'superseded', null]) {
      const p = proyectarContenidoParaTcl({ ...entrada, estadoDeLaVersionAprobada: interno });
      expect(p.estado).toBe('pendiente');
      expect(p.aprobadoEl).toBeNull();
    }
  });

  it('documento: claves exactas, idioma reducido a es/en y tipo cerrado', () => {
    const d = proyectarDocumentoParaTcl({
      sourceId: 's1',
      titulo: 'Ficha técnica P80.pdf',
      tipo: 'ficha_tecnica',
      idioma: 'ES-CO',
      fecha: '2026-10-05',
      hash: 'abc',
      url: 'x',
    } as never);
    expect(claves(d)).toEqual(esperadas('documento'));
    expect(d).toMatchObject({ idioma: 'es', tipo: 'ficha_tecnica' });
    const raro = proyectarDocumentoParaTcl({
      sourceId: 's2',
      titulo: 'Cotización fee 5 millones.pdf',
      tipo: 'soporte_operativo',
      idioma: 'fr',
      fecha: null,
    });
    expect(raro).toMatchObject({ titulo: null, tipo: 'otro', idioma: null, fecha: null });
  });
});

describe('Brief para TCL', () => {
  const campo = (key: string, value: unknown, producto: { marca: string; modelo: string } | null = null) => ({
    key,
    producto,
    value,
  });
  const entrada = {
    version: 3,
    aprobadoEl: '2026-10-05T12:00:00.000Z',
    representaciones: [
      {
        idioma: 'es' as const,
        campos: [
          campo('mensaje_principal.one_line', 'El P80 Pro lleva tu fotografía a otro nivel.'),
          campo('practico.restricciones', ['No comparar con la competencia.']),
          campo('mandatorios', [
            { categoria: 'legal', descripcion: 'Incluir la etiqueta de publicidad.' },
            { categoria: 'mensaje', descripcion: 'Mencionar #P80Pro.' },
          ]),
          campo('marca_producto[].rtbs', ['Cámara de 200 MP'], { marca: 'TCL', modelo: 'P80 Pro' }),
        ],
      },
    ],
  };
  it('claves exactas; texto y lista; mandatorios como «categoría: descripción»', () => {
    const b = proyectarBriefParaTcl(entrada);
    expect(claves(b)).toEqual(esperadas('brief'));
    expect(claves(b.representaciones[0]!)).toEqual(esperadas('briefRepresentacion'));
    expect(claves(b.representaciones[0]!.campos[0]!)).toEqual(esperadas('briefCampo'));
    const [uno, restricciones, mandatorios, rtbs] = b.representaciones[0]!.campos;
    expect(uno).toMatchObject({ clave: 'mensaje_principal.one_line', etiqueta: 'Mensaje en una línea' });
    expect(uno!.texto).toContain('P80 Pro');
    expect(uno!.items).toBeNull();
    expect(restricciones!.items).toEqual(['No comparar con la competencia.']);
    expect(mandatorios!.items).toEqual([
      'legal: Incluir la etiqueta de publicidad.',
      'mensaje: Mencionar #P80Pro.',
    ]);
    expect(claves(rtbs!.producto!)).toEqual(esperadas('briefProducto'));
    expect(b.idiomaOriginal).toBe('es');
  });
  it('el presupuesto, las fechas estructuradas y claves desconocidas NO salen aunque lleguen', () => {
    const b = proyectarBriefParaTcl({
      ...entrada,
      representaciones: [
        {
          idioma: 'es',
          campos: [
            campo('practico.presupuesto', 'Presupuesto total'),
            campo('practico.fecha_inicio', { tipo: 'exacta', fecha: '2026-11-01' }),
            campo('clave.inventada', 'texto'),
            campo('mensaje_principal.tono', 'Cercano'),
          ],
        },
      ],
    });
    expect(b.representaciones[0]!.campos.map((c) => c.clave)).toEqual(['mensaje_principal.tono']);
  });
  it('un campo con texto inseguro se omite COMPLETO (no se recorta); los demás siguen', () => {
    const b = proyectarBriefParaTcl({
      ...entrada,
      representaciones: [
        {
          idioma: 'es',
          campos: [
            campo('objetivo.negocio', 'Crecer ventas; el fee del creador es de $ 5.000.000'),
            campo('practico.restricciones', ['Sin comparativos', 'Pago a 30 días con factura']),
            campo('mensaje_principal.tono', 'Cercano'),
          ],
        },
      ],
    });
    expect(b.representaciones[0]!.campos.map((c) => c.clave)).toEqual(['mensaje_principal.tono']);
    expect(JSON.stringify(b)).not.toMatch(/fee|factura|5\.000/u);
  });
  it('valores de forma inesperada se omiten', () => {
    for (const v of [null, undefined, 42, true, {}, [], [1, 2], [{}], [{ categoria: 'x' }], ''])
      expect(valorDeBriefParaTcl(v), JSON.stringify(v)).toBeNull();
    expect(valorDeBriefParaTcl(Array.from({ length: 61 }, () => 'a'))).toBeNull();
  });
  it('idioma: en/es', () => {
    const b = proyectarBriefParaTcl({
      ...entrada,
      representaciones: [
        { idioma: 'es', campos: [] },
        { idioma: 'en', campos: [] },
      ],
    });
    expect(b.representaciones.map((r) => r.idioma)).toEqual(['es', 'en']);
  });
});

describe('comprobación de claves por token (sin falsos positivos por subcadena)', () => {
  it('detecta claves prohibidas con distintos estilos de escritura', () => {
    for (const k of [
      'fee',
      'feeAmount',
      'fee_amount',
      'shippingCost',
      'shippingcost',
      'Tracking-Ref',
      'billingDocument',
      'paymentStatus',
      'invoiceNumber',
      'agreementMode',
      'phoneNumber',
      'homeAddress',
      'pii',
      'filename',
      'evidenceUrl',
      'idempotencyKey',
      'notas',
      'notes',
      'documents',
      'emails',
    ]) {
      expect(esClaveProhibidaTcl(k), k).toBe(true);
    }
  });
  it('NO marca los nombres legítimos de los DTO ni palabras que contienen un término por casualidad', () => {
    const legitimas = [
      'documentos',
      'documento',
      'participacionId',
      'sourceId',
      'nombreVisible',
      'productoRecibido',
      'influencersActivos',
      'hashtag',
      'smartphone',
      'preferencias',
      'notebook',
      'cumplimiento',
      'aprobadoEl',
      'plataforma',
      'handle',
      'etapa',
      'items',
      'texto',
      'bloque',
      'clave',
    ];
    for (const k of legitimas) expect(esClaveProhibidaTcl(k), k).toBe(false);
  });
  it('todas las claves de todos los DTO declarados son legítimas', () => {
    const todas = Object.values(CLAVES_DE_DTO_TCL).flat();
    expect(todas.filter(esClaveProhibidaTcl)).toEqual([]);
  });
  it('clavesProhibidasEn y asegurarProyeccionTcl: rutas y falla en vez de filtrar', () => {
    expect(clavesProhibidasEn({ a: [{ b: { feeAmount: 1 } }], documentos: [] })).toEqual([
      'a[0].b.feeAmount',
    ]);
    expect(() => asegurarProyeccionTcl({ ok: 1, nested: { payment: 'x' } })).toThrow(/payment/u);
    expect(asegurarProyeccionTcl({ documentos: [{ titulo: 'x' }] })).toEqual({
      documentos: [{ titulo: 'x' }],
    });
  });
});
