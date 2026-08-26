'use client';

import { useState } from 'react';
import { transicionarBriefDeCampana } from '@/lib/actions';
import { AlertaPreguntasCriticas } from './AlertaPreguntasCriticas';
import { CampoEditable, type CampoParaEditar } from './CampoEditable';
import { NavegacionSecciones } from './NavegacionSecciones';
import { SelectorProducto } from './SelectorProducto';

interface Seccion {
  id: string;
  titulo: string;
  campos: CampoParaEditar[];
}

/**
 * UI-10 · Orquesta navegación por bloque, selector de producto y la lista de
 * campos editables de la sección activa.
 *
 * Para un campo `compartido_con_excepcion` (DEC-016), si el producto activo
 * ya tiene su propia excepción se muestra ESA fila; si no, se muestra la
 * compartida con la opción de declarar una (E7-8) — nunca las dos filas a
 * la vez para el mismo producto.
 */
export function EditorBrief({
  campaignId,
  versionId,
  estadoVersion,
  secciones,
  productos,
  preguntasCriticasPendientes,
}: {
  campaignId: string;
  versionId: string;
  estadoVersion: string;
  secciones: Seccion[];
  productos: { id: string; model: string; rol: string }[];
  preguntasCriticasPendientes: number;
}) {
  const [seccionActiva, setSeccionActiva] = useState(secciones[0]?.id ?? '');
  const [productoSeleccionado, setProductoSeleccionado] = useState<string | undefined>(productos[0]?.id);

  const seccion = secciones.find((s) => s.id === seccionActiva) ?? secciones[0];

  const seccionesConPendientes = secciones.map((s) => ({
    id: s.id,
    titulo: s.titulo,
    pendientes: s.campos.filter((c) => c.criticidad !== 'informativo' && c.status !== 'found').length,
  }));

  const tieneCamposDeProducto =
    seccion?.campos.some((c) => c.nivel === 'producto' || c.nivel === 'compartido_con_excepcion') ?? false;

  const camposVisibles =
    seccion === undefined
      ? []
      : seccion.campos.filter((c) => {
          if (c.nivel === 'producto') return c.campaignProductId === productoSeleccionado;
          if (c.nivel === 'compartido_con_excepcion') {
            const tieneExcepcion = seccion.campos.some(
              (x) => x.key === c.key && x.campaignProductId === productoSeleccionado,
            );
            // Con excepción declarada para el producto activo: se muestra solo
            // esa fila. Sin excepción: se muestra la compartida.
            return tieneExcepcion
              ? c.campaignProductId === productoSeleccionado
              : c.campaignProductId === null;
          }
          return true; // campaña: siempre visible, siempre una sola fila
        });

  return (
    <div>
      <AlertaPreguntasCriticas campaignId={campaignId} cantidad={preguntasCriticasPendientes} />

      <NavegacionSecciones
        secciones={seccionesConPendientes}
        activa={seccionActiva}
        onSeleccionar={setSeccionActiva}
      />

      {tieneCamposDeProducto && (
        <SelectorProducto
          productos={productos}
          seleccionado={productoSeleccionado}
          onSeleccionar={setProductoSeleccionado}
        />
      )}

      <h2 style={{ marginTop: 0 }}>{seccion?.titulo}</h2>

      {camposVisibles.length === 0 ? (
        <p className="vacio">Esta sección no tiene campos para el producto seleccionado.</p>
      ) : (
        camposVisibles.map((c) => (
          <CampoEditable
            key={c.id}
            campo={c}
            versionId={versionId}
            productoSeleccionado={c.nivel === 'compartido_con_excepcion' ? productoSeleccionado : undefined}
          />
        ))
      )}

      <div className="card" style={{ marginTop: 24 }}>
        <h2 style={{ marginTop: 0 }}>Validar y enviar</h2>
        <p className="sub">
          Se comprueban las mismas reglas que aplica el sistema en cualquier otro punto: sin conflictos
          críticos, sin preguntas críticas pendientes, claims con evidencia, campos de producto anclados. Si
          algo falta, se explica exactamente qué es.
        </p>
        <form action={transicionarBriefDeCampana}>
          <input type="hidden" name="campaignId" value={campaignId} />
          <input type="hidden" name="versionId" value={versionId} />
          <input type="hidden" name="to" value="internal_review" />
          <button className="btn pri" type="submit" disabled={estadoVersion === 'internal_review'}>
            {estadoVersion === 'internal_review'
              ? 'Ya está en revisión interna'
              : 'Enviar a revisión interna'}
          </button>
        </form>
      </div>
    </div>
  );
}
