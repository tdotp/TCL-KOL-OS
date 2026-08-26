'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { confirmarCampoDeBrief, corregirCampoDeBrief } from '@/lib/actions';

export interface CampoParaEditar {
  id: string;
  key: string;
  label: string;
  description: string;
  campaignProductId: string | null;
  value: unknown;
  status: string;
  criticidad: string;
  confidence: number | null;
  provenanceType: string;
  reviewStatus: string;
  revision: number;
  valueType: string;
  valoresPermitidos?: readonly string[] | undefined;
  evidencias: Array<{
    quote: string;
    relation: string;
    filename: string;
    sourceId: string;
    page: number | null;
    slide: number | null;
    section: string | null;
    linea: number | null;
  }>;
}

function valorLegible(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(', ');
  if (typeof value === 'object' && 'textoOriginal' in (value as Record<string, unknown>)) {
    return String((value as Record<string, unknown>)['textoOriginal']);
  }
  return JSON.stringify(value);
}

const ETIQUETA_PROCEDENCIA: Record<string, string> = {
  extracted: 'extraído',
  manual_local: 'manual',
  inferred: 'inferido',
  translated: 'traducido',
  pending: 'sin llenar',
};

const ETIQUETA_REVISION: Record<string, { texto: string; clase: string }> = {
  pending: { texto: 'sin confirmar', clase: 'warn' },
  confirmed: { texto: 'confirmado', clase: 'ok' },
  corrected: { texto: 'corregido', clase: 'info' },
};

/**
 * Un campo del editor: valor, insignias de estado/criticidad/procedencia,
 * evidencia sin salir de la pantalla, confirmación y corrección con
 * autoguardado por `onBlur` — nunca por tecla (§5.4/§6 del cierre de
 * Sprint 4). La clave técnica queda en un `<details>` secundario.
 */
export function CampoEditable({ campo, versionId }: { campo: CampoParaEditar; versionId: string }) {
  const [valorTexto, setValorTexto] = useState(valorLegible(campo.value));
  const [evidenciaAbierta, setEvidenciaAbierta] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const [estadoCorreccion, corregir, corrigiendo] = useActionState(corregirCampoDeBrief, {});
  const [estadoConfirmacion, confirmar, confirmando] = useActionState(confirmarCampoDeBrief, {});

  const conflictoDeRevision =
    estadoCorreccion.error?.includes('modificó este campo') || estadoConfirmacion.error?.includes('modificó este campo');

  useEffect(() => {
    if (conflictoDeRevision) {
      const t = setTimeout(() => window.location.reload(), 1500);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [conflictoDeRevision]);

  const guardar = () => {
    if (valorTexto === valorLegible(campo.value)) return; // sin cambios, nada que guardar
    formRef.current?.requestSubmit();
  };

  const estado = ETIQUETA_REVISION[campo.reviewStatus] ?? { texto: campo.reviewStatus, clase: '' };

  if (conflictoDeRevision) {
    return (
      <div className="card" style={{ marginBottom: 10 }}>
        <span className="pill warn">este campo cambió en otra pestaña — recargando…</span>
      </div>
    );
  }

  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <strong>{campo.label}</strong>
        <div className="row" style={{ gap: 4 }}>
          {campo.criticidad === 'critico' && <span className="pill warn">crítico</span>}
          {campo.criticidad === 'claim' && <span className="pill info">claim</span>}
          <span className={`pill ${estado.clase}`}>{estado.texto}</span>
          <span className="pill">{ETIQUETA_PROCEDENCIA[campo.provenanceType] ?? campo.provenanceType}</span>
        </div>
      </div>
      {campo.description !== '' && (
        <p className="sub" style={{ margin: '2px 0 8px' }}>
          {campo.description}
        </p>
      )}

      <form ref={formRef} action={corregir}>
        <input type="hidden" name="versionId" value={versionId} />
        <input type="hidden" name="fieldId" value={campo.id} />
        <input type="hidden" name="revision" value={campo.revision} />
        <input type="hidden" name="value" value={valorTexto} />
        <input
          value={valorTexto}
          onChange={(e) => setValorTexto(e.target.value)}
          onBlur={guardar}
          placeholder={campo.status === 'not_found' ? 'Sin dato — escriba para completarlo' : undefined}
          style={{ width: '100%', padding: '6px 8px', fontSize: 14 }}
          disabled={corrigiendo}
        />
      </form>

      <div className="row" style={{ gap: 8, marginTop: 8, alignItems: 'center' }}>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>
          {corrigiendo ? 'guardando…' : estadoCorreccion.ok ? 'guardado' : ''}
        </span>
        {campo.status === 'found' && campo.reviewStatus === 'pending' && (
          <form action={confirmar}>
            <input type="hidden" name="versionId" value={versionId} />
            <input type="hidden" name="fieldId" value={campo.id} />
            <input type="hidden" name="revision" value={campo.revision} />
            <button className="btn" type="submit" disabled={confirmando} style={{ padding: '3px 10px', fontSize: 12 }}>
              {confirmando ? 'Confirmando…' : 'Confirmar tal cual'}
            </button>
          </form>
        )}
        {campo.evidencias.length > 0 && (
          <button
            type="button"
            onClick={() => setEvidenciaAbierta((v) => !v)}
            style={{ background: 'none', border: 'none', color: 'var(--brand)', cursor: 'pointer', fontSize: 12 }}
          >
            {evidenciaAbierta ? 'ocultar evidencia' : `ver evidencia (${campo.evidencias.length})`}
          </button>
        )}
        <details style={{ fontSize: 11, color: 'var(--muted)' }}>
          <summary style={{ cursor: 'pointer' }}>clave técnica</summary>
          <span className="mono">{campo.key}</span>
        </details>
      </div>

      {estadoCorreccion.error !== undefined && !conflictoDeRevision && (
        <div style={{ color: 'var(--bad)', fontSize: 12, marginTop: 4 }}>{estadoCorreccion.error}</div>
      )}

      {evidenciaAbierta && (
        <div style={{ marginTop: 8, background: 'var(--chip)', padding: 8, borderRadius: 6 }}>
          {campo.evidencias.map((e, i) => (
            <div key={i} style={{ padding: '6px 0', fontSize: 13 }}>
              <strong>{e.filename}</strong>{' '}
              <span style={{ color: 'var(--muted)' }}>
                · {e.slide !== null ? `diapositiva ${e.slide}` : e.section !== null ? e.section : e.page !== null ? `página ${e.page}` : ''}
              </span>
              <blockquote style={{ margin: '4px 0 0', paddingLeft: 10, borderLeft: '3px solid var(--line)', fontStyle: 'italic' }}>
                {e.quote}
              </blockquote>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
