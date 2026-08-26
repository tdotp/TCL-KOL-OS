'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import {
  confirmarCampoDeBrief,
  corregirCampoDeBrief,
  declararExcepcionDeCampo,
  revertirExcepcionDeCampo,
} from '@/lib/actions';

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
  nivel: string;
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
  if (Array.isArray(value))
    return value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(', ');
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
export function CampoEditable({
  campo,
  versionId,
  productoSeleccionado,
}: {
  campo: CampoParaEditar;
  versionId: string;
  /** Producto activo en el selector — solo relevante para campos `compartido_con_excepcion` (E7-8). */
  productoSeleccionado?: string | undefined;
}) {
  const [valorTexto, setValorTexto] = useState(valorLegible(campo.value));
  const [evidenciaAbierta, setEvidenciaAbierta] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const [estadoCorreccion, corregir, corrigiendo] = useActionState(corregirCampoDeBrief, {});
  const [estadoConfirmacion, confirmar, confirmando] = useActionState(confirmarCampoDeBrief, {});

  const conflictoDeRevision =
    estadoCorreccion.error?.includes('modificó este campo') ||
    estadoConfirmacion.error?.includes('modificó este campo');

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
            <button
              className="btn"
              type="submit"
              disabled={confirmando}
              style={{ padding: '3px 10px', fontSize: 12 }}
            >
              {confirmando ? 'Confirmando…' : 'Confirmar tal cual'}
            </button>
          </form>
        )}
        {campo.evidencias.length > 0 && (
          <button
            type="button"
            onClick={() => setEvidenciaAbierta((v) => !v)}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--brand)',
              cursor: 'pointer',
              fontSize: 12,
            }}
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

      {campo.nivel === 'compartido_con_excepcion' && productoSeleccionado !== undefined && (
        <ControlExcepcion campo={campo} versionId={versionId} productoSeleccionado={productoSeleccionado} />
      )}

      {evidenciaAbierta && (
        <div style={{ marginTop: 8, background: 'var(--chip)', padding: 8, borderRadius: 6 }}>
          {campo.evidencias.map((e, i) => (
            <div key={i} style={{ padding: '6px 0', fontSize: 13 }}>
              <strong>{e.filename}</strong>{' '}
              <span style={{ color: 'var(--muted)' }}>
                ·{' '}
                {e.slide !== null
                  ? `diapositiva ${e.slide}`
                  : e.section !== null
                    ? e.section
                    : e.page !== null
                      ? `página ${e.page}`
                      : ''}
              </span>
              <blockquote
                style={{
                  margin: '4px 0 0',
                  paddingLeft: 10,
                  borderLeft: '3px solid var(--line)',
                  fontStyle: 'italic',
                }}
              >
                {e.quote}
              </blockquote>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * E7-8 · Interruptor compartido/específico por producto (DEC-016).
 *
 * `campo.campaignProductId === productoSeleccionado` significa que esta fila
 * YA es la excepción del producto activo (se ofrece revertir). `=== null`
 * significa que se está mostrando la fila compartida porque ese producto no
 * tiene excepción todavía (se ofrece declarar una, con motivo obligatorio).
 * `EditorBrief` nunca renderiza ambas filas a la vez para el mismo producto.
 */
function ControlExcepcion({
  campo,
  versionId,
  productoSeleccionado,
}: {
  campo: CampoParaEditar;
  versionId: string;
  productoSeleccionado: string;
}) {
  const [abierto, setAbierto] = useState(false);
  const [valor, setValor] = useState('');
  const [motivo, setMotivo] = useState('');
  const [estado, declarar, declarando] = useActionState(declararExcepcionDeCampo, {});
  const [estadoRevertir, revertir, revirtiendo] = useActionState(revertirExcepcionDeCampo, {});

  const esExcepcion = campo.campaignProductId === productoSeleccionado;

  if (esExcepcion) {
    return (
      <div style={{ marginTop: 8, fontSize: 12 }}>
        <span className="pill info">excepción declarada para este producto</span>{' '}
        <form action={revertir} style={{ display: 'inline' }}>
          <input type="hidden" name="versionId" value={versionId} />
          <input type="hidden" name="fieldId" value={campo.id} />
          <button
            className="btn"
            type="submit"
            disabled={revirtiendo}
            style={{ padding: '2px 8px', fontSize: 11, marginLeft: 4 }}
          >
            {revirtiendo ? 'Volviendo…' : 'Volver a compartido'}
          </button>
        </form>
        {estadoRevertir.error !== undefined && (
          <div style={{ color: 'var(--bad)', marginTop: 4 }}>{estadoRevertir.error}</div>
        )}
      </div>
    );
  }

  if (!abierto) {
    return (
      <button
        type="button"
        onClick={() => setAbierto(true)}
        style={{
          background: 'none',
          border: 'none',
          color: 'var(--brand)',
          cursor: 'pointer',
          fontSize: 12,
          marginTop: 6,
        }}
      >
        Declarar excepción solo para este producto
      </button>
    );
  }

  return (
    <form action={declarar} style={{ marginTop: 8, padding: 8, background: 'var(--chip)', borderRadius: 6 }}>
      <input type="hidden" name="versionId" value={versionId} />
      <input type="hidden" name="key" value={campo.key} />
      <input type="hidden" name="campaignProductId" value={productoSeleccionado} />
      <input type="hidden" name="value" value={JSON.stringify(valor)} />
      <p className="sub" style={{ margin: '0 0 6px' }}>
        Este valor aplicará solo a este producto; los demás siguen viendo el compartido.
      </p>
      <input
        value={valor}
        onChange={(e) => setValor(e.target.value)}
        placeholder="Valor exclusivo para este producto"
        style={{ width: '100%', padding: '6px 8px', fontSize: 13, marginBottom: 6 }}
      />
      <input
        name="motivo"
        value={motivo}
        onChange={(e) => setMotivo(e.target.value)}
        placeholder="¿Por qué este producto necesita un valor distinto? (obligatorio)"
        style={{ width: '100%', padding: '6px 8px', fontSize: 13, marginBottom: 6 }}
      />
      <div className="row" style={{ gap: 6 }}>
        <button
          className="btn pri"
          type="submit"
          disabled={declarando}
          style={{ padding: '3px 10px', fontSize: 12 }}
        >
          {declarando ? 'Guardando…' : 'Declarar excepción'}
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => setAbierto(false)}
          style={{ padding: '3px 10px', fontSize: 12 }}
        >
          Cancelar
        </button>
      </div>
      {estado.error !== undefined && (
        <div style={{ color: 'var(--bad)', fontSize: 12, marginTop: 4 }}>{estado.error}</div>
      )}
    </form>
  );
}
