'use client';

import { useActionState, useState } from 'react';
import { aprobarComoClienteDeCampana, solicitarCambiosClienteDeCampana } from '@/lib/actions';
import { ConfirmarAccion } from '@/components/ConfirmarAccion';

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
 * Fase D · vista de solo lectura del cliente (ADR-004, ampliada Sprint 5).
 *
 * Componente separado a propósito de `TablaCampos`/`CampoEditable` (los del
 * equipo interno): nunca importa ni recibe `confidence`, `provenanceType`,
 * costo de IA, modelo, ni la clave técnica del campo — no hay forma de que
 * se filtren por accidente si el componente nunca los tiene en sus props.
 */
export function VistaCliente({
  campaignId,
  versionId,
  version,
  estadoVersion,
  secciones,
  productos,
}: {
  campaignId: string;
  versionId: string;
  version: number;
  estadoVersion: string;
  secciones: Array<{ id: string; titulo: string; campos: CampoParaCliente[] }>;
  productos: Array<{ id: string; model: string }>;
}) {
  const [productoActivo, setProductoActivo] = useState<string | undefined>(productos[0]?.id);
  const [mostrarSolicitud, setMostrarSolicitud] = useState(false);
  const [camposSenalados, setCamposSenalados] = useState<Set<string>>(new Set());
  const [estadoSolicitud, solicitar, solicitando] = useActionState(solicitarCambiosClienteDeCampana, {});

  const puedeDecidir = estadoVersion === 'client_review';

  const toggleCampo = (key: string) => {
    setCamposSenalados((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <>
      <div className="card client-review-decision">
        <div className="eyebrow">Decisión</div>
        <h2 style={{ margin: 0 }}>
          Versión {version} <span className="pill info">revisión del cliente</span>
        </h2>
        <p className="sub">
          Estos son los valores que el equipo de SmartPR propone para esta campaña. Puede navegar por sección,
          revisar la evidencia de cada dato y decidir si aprueba o solicita cambios.
        </p>

        {!puedeDecidir && (
          <p className="aviso" style={{ marginTop: 10 }}>
            {estadoVersion === 'approved' || estadoVersion === 'superseded'
              ? 'Este brief ya fue aprobado. Puede consultarlo, pero ya no admite cambios.'
              : estadoVersion === 'client_changes_requested'
                ? 'Ya solicitó cambios sobre este brief — el equipo los está corrigiendo. Le llegará de nuevo cuando estén listos.'
                : 'Este brief todavía no fue enviado a su revisión — vuelva más tarde.'}
          </p>
        )}

        {puedeDecidir && (
          <div className="row" style={{ gap: 20, marginTop: 16, flexWrap: 'wrap', alignItems: 'center' }}>
            <form action={aprobarComoClienteDeCampana}>
              <input type="hidden" name="versionId" value={versionId} />
              <input type="hidden" name="campaignId" value={campaignId} />
              <ConfirmarAccion
                etiqueta="Aprobar"
                titulo={`¿Aprobar el brief v${version}?`}
                consecuencias={[
                  'Queda aprobado de inmediato — nadie podrá volver a editar sus campos.',
                  'El equipo de SmartPR ya puede usarlo como referencia final para el contenido.',
                  'Si más adelante hace falta un cambio, tendrán que crear una versión nueva.',
                ]}
                textoConfirmar="Sí, aprobar"
              />
            </form>
            <span style={{ width: 1, height: 24, background: 'var(--line)' }} />
            <button type="button" className="btn" onClick={() => setMostrarSolicitud((v) => !v)}>
              Solicitar cambios
            </button>
          </div>
        )}

        {puedeDecidir && mostrarSolicitud && (
          <form action={solicitar} className="inline-form">
            <input type="hidden" name="versionId" value={versionId} />
            <input type="hidden" name="campaignId" value={campaignId} />
            {[...camposSenalados].map((k) => (
              <input key={k} type="hidden" name="campo" value={k} />
            ))}
            <p className="sub" style={{ margin: '0 0 6px' }}>
              Marque los campos que quiere que se corrijan (opcional) y explique por qué.
            </p>
            <textarea
              name="motivo"
              required
              placeholder="¿Qué debe cambiar? (obligatorio)"
              style={{ width: '100%', padding: '8px 10px', minHeight: 70, border: '1px solid var(--line)', borderRadius: 6, font: 'inherit', fontSize: 13.5 }}
            />
            <div className="row" style={{ gap: 8, marginTop: 8 }}>
              <button className="btn pri" type="submit" disabled={solicitando}>
                {solicitando ? 'Enviando…' : 'Enviar solicitud'}
              </button>
              <button type="button" className="btn" onClick={() => setMostrarSolicitud(false)}>
                Cancelar
              </button>
            </div>
            {estadoSolicitud.error !== undefined && (
              <p style={{ color: 'var(--bad)', fontSize: 12, marginTop: 6 }}>{estadoSolicitud.error}</p>
            )}
          </form>
        )}
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
                    {puedeDecidir && mostrarSolicitud && (
                      <label style={{ fontSize: 12, display: 'flex', gap: 4, alignItems: 'center', color: 'var(--muted)' }}>
                        <input
                          type="checkbox"
                          checked={camposSenalados.has(c.key)}
                          onChange={() => toggleCampo(c.key)}
                        />
                        señalar
                      </label>
                    )}
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
