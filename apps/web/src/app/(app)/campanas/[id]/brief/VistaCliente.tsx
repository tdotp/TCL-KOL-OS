'use client';

import { useState } from 'react';

export interface CampoParaCliente {
  key: string;
  label: string;
  section: string;
  value: unknown;
  campaignProductId: string | null;
  evidencias: Array<{
    quote: string;
    filename: string;
    page: number | null;
    slide: number | null;
    section: string | null;
  }>;
}

function etiquetaEstado(estado: string): string {
  if (estado === 'approved') return 'aprobado';
  if (estado === 'superseded') return 'reemplazado';
  return 'en revisión de SmartPR';
}

function valorLegible(value: unknown): string {
  if (value === null || value === undefined || value === '') return '— sin dato —';
  if (typeof value === 'string') return value;
  if (Array.isArray(value))
    return value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(', ');
  if (typeof value === 'object' && 'textoOriginal' in (value as Record<string, unknown>)) {
    return String((value as Record<string, unknown>)['textoOriginal']);
  }
  return JSON.stringify(value);
}

/**
 * Vista de solo lectura del cliente (ADR-004). El cliente no aprueba ni pide
 * cambios: esas decisiones son de SmartPR (`docs/product/CLIENT_WORKFLOW_CORRECTION.md`).
 *
 * Componente separado a propósito de `TablaCampos`/`CampoEditable` (los del
 * equipo interno): nunca importa ni recibe `confidence`, `provenanceType`,
 * costo de IA, modelo, ni la clave técnica del campo — no hay forma de que
 * se filtren por accidente si el componente nunca los tiene en sus props.
 */
export function VistaCliente({
  version,
  estadoVersion,
  secciones,
  productos,
}: {
  version: number;
  estadoVersion: string;
  secciones: Array<{ id: string; titulo: string; campos: CampoParaCliente[] }>;
  productos: Array<{ id: string; model: string }>;
}) {
  const [productoActivo, setProductoActivo] = useState<string | undefined>(productos[0]?.id);

  return (
    <>
      <div className="card client-review-decision">
        <div className="eyebrow">Consulta</div>
        <h2 style={{ margin: 0 }}>
          Versión {version} <span className="pill info">{etiquetaEstado(estadoVersion)}</span>
        </h2>
        <p className="sub">
          Estos son los valores que el equipo de SmartPR propone para esta campaña. Puede navegar por sección
          y revisar la evidencia de cada dato. La revisión y la aprobación las gestiona SmartPR.
        </p>
      </div>

      {productos.length > 1 && (
        <div className="row" style={{ gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
          {productos.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`pill ${productoActivo === p.id ? 'curso' : 'neutro'}`}
              onClick={() => setProductoActivo(p.id)}
              style={{ cursor: 'pointer' }}
            >
              {p.model}
            </button>
          ))}
        </div>
      )}

      {secciones.map((seccion) => {
        const camposVisibles = seccion.campos.filter(
          (c) => c.campaignProductId === null || c.campaignProductId === productoActivo,
        );
        if (camposVisibles.length === 0) return null;
        return (
          <div className="card client-brief-section" key={seccion.id}>
            <h2 style={{ marginTop: 0 }}>{seccion.titulo}</h2>
            {camposVisibles.map((c) => {
              const vacio = c.value === null || c.value === undefined || c.value === '';
              return (
                <div key={c.key} style={{ padding: '10px 0', borderTop: '1px solid var(--line-soft)' }}>
                  <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <strong style={{ fontSize: 14 }}>{c.label}</strong>
                  </div>
                  <p className={vacio ? 'valor-vacio' : undefined} style={{ margin: '4px 0' }}>
                    {valorLegible(c.value)}
                  </p>
                  {c.evidencias.length > 0 && (
                    <details style={{ fontSize: 13 }}>
                      <summary style={{ cursor: 'pointer', color: 'var(--brand)' }}>
                        ver evidencia ({c.evidencias.length})
                      </summary>
                      {c.evidencias.map((e, i) => (
                        <blockquote
                          key={i}
                          style={{ margin: '6px 0 0', paddingLeft: 10, borderLeft: '3px solid var(--line)' }}
                        >
                          {e.quote}
                          <br />
                          <span style={{ color: 'var(--muted)' }}>
                            — {e.filename}
                            {e.slide !== null
                              ? `, diapositiva ${e.slide}`
                              : e.section !== null
                                ? `, ${e.section}`
                                : e.page !== null
                                  ? `, página ${e.page}`
                                  : ''}
                          </span>
                        </blockquote>
                      ))}
                    </details>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </>
  );
}
