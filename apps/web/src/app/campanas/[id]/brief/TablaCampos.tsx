'use client';

import { Fragment, useActionState, useEffect, useState } from 'react';
import { confirmarCampoDeBrief, corregirCampoDeBrief } from '@/lib/actions';

interface Evidencia {
  quote: string;
  relation: string;
  filename: string;
  sourceId: string;
  page: number | null;
  slide: number | null;
  section: string | null;
  linea: number | null;
}

interface Campo {
  id: string;
  key: string;
  campaignProductId: string | null;
  value: unknown;
  status: string;
  criticidad: string;
  confidence: number | null;
  provenanceType: string;
  reviewStatus: string;
  revision: number;
  evidencias: Evidencia[];
}

/** El localizador que corresponda al formato (DEC-018). */
function localizador(e: Evidencia): string {
  if (e.slide !== null) return `diapositiva ${e.slide}`;
  if (e.section !== null && e.section !== '') {
    return e.linea !== null ? `${e.section} · línea ${e.linea}` : e.section;
  }
  if (e.page !== null) return `página ${e.page}`;
  return 'sin ubicación';
}

const ETIQUETA_ESTADO: Record<string, { texto: string; clase: string }> = {
  found: { texto: 'encontrado', clase: 'ok' },
  not_found: { texto: 'no está en las fuentes', clase: '' },
  conflict: { texto: 'fuentes en desacuerdo', clase: 'warn' },
  manual: { texto: 'capturado a mano', clase: 'info' },
};

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

function valorLegible(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(', ');
  if (typeof value === 'object' && 'textoOriginal' in (value as Record<string, unknown>)) {
    return String((value as Record<string, unknown>)['textoOriginal']);
  }
  return JSON.stringify(value);
}

/**
 * Confirmar, con concurrencia optimista visible (corrección 7 del cierre): si
 * el servidor devuelve `FIELD_REVISION_CONFLICT`, la fila avisa y recarga en
 * vez de reintentar en silencio — nunca "el último que escribe gana".
 */
function BotonConfirmar({ versionId, fieldId, revision }: { versionId: string; fieldId: string; revision: number }) {
  const [estado, accion, pendiente] = useActionState(confirmarCampoDeBrief, {});

  useEffect(() => {
    if (estado.error?.includes('modificó este campo')) {
      const t = setTimeout(() => window.location.reload(), 1500);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [estado.error]);

  if (estado.error?.includes('modificó este campo')) {
    return <span className="pill warn">este campo cambió, recargando…</span>;
  }

  return (
    <form action={accion}>
      <input type="hidden" name="versionId" value={versionId} />
      <input type="hidden" name="fieldId" value={fieldId} />
      <input type="hidden" name="revision" value={revision} />
      <button className="btn" type="submit" disabled={pendiente} style={{ padding: '4px 10px', fontSize: 12 }}>
        {pendiente ? 'Confirmando…' : 'Confirmar'}
      </button>
      {estado.error !== undefined && (
        <div style={{ color: 'var(--bad)', fontSize: 11, marginTop: 2 }}>{estado.error}</div>
      )}
    </form>
  );
}

function FormularioCorregir({
  versionId,
  fieldId,
  revision,
  valorInicial,
  onCancelar,
  onGuardado,
}: {
  versionId: string;
  fieldId: string;
  revision: number;
  valorInicial: string;
  onCancelar: () => void;
  onGuardado: () => void;
}) {
  const [estado, accion, pendiente] = useActionState(corregirCampoDeBrief, {});

  useEffect(() => {
    if (estado.ok) onGuardado();
  }, [estado.ok, onGuardado]);

  if (estado.error?.includes('modificó este campo')) {
    return <span className="pill warn">este campo cambió, recargue para ver el valor actual</span>;
  }

  return (
    <form action={accion} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', gap: 6 }}>
        <input type="hidden" name="versionId" value={versionId} />
        <input type="hidden" name="fieldId" value={fieldId} />
        <input type="hidden" name="revision" value={revision} />
        <input name="value" defaultValue={valorInicial} style={{ flex: 1, padding: '4px 6px', fontSize: 13 }} autoFocus />
        <button className="btn" type="submit" disabled={pendiente} style={{ padding: '4px 10px' }}>
          {pendiente ? 'Guardando…' : 'Guardar'}
        </button>
        <button type="button" className="btn" style={{ padding: '4px 10px' }} onClick={onCancelar}>
          Cancelar
        </button>
      </div>
      {estado.error !== undefined && <div style={{ color: 'var(--bad)', fontSize: 11 }}>{estado.error}</div>}
    </form>
  );
}

/**
 * UI-08 + UI-11 · Campos con su evidencia desplegable, confirmación y
 * corrección (§3.1 del cierre de Sprint 4).
 *
 * Confirmar nunca cambia la procedencia extraída — solo marca que una
 * persona lo revisó. Corregir sí cambia el valor y la procedencia a
 * `manual_local`: el campo queda visiblemente diferenciado de lo extraído,
 * nunca sobrescrito en silencio.
 */
export function TablaCampos({
  campos,
  campaignId,
  versionId,
  editable,
}: {
  campos: Campo[];
  campaignId: string;
  versionId: string;
  editable: boolean;
}) {
  const [abierto, setAbierto] = useState<string | null>(null);
  const [editando, setEditando] = useState<string | null>(null);
  const [soloPendientes, setSoloPendientes] = useState(false);

  const prioridad = (c: Campo): number => {
    if (c.status === 'conflict') return 0;
    if (c.criticidad === 'critico' && c.status !== 'found') return 1;
    if (c.criticidad === 'claim' && c.status !== 'found') return 2;
    if (c.status === 'found' && c.reviewStatus === 'pending') return 3;
    if (c.status === 'found') return 4;
    return 5;
  };

  const visibles = (soloPendientes ? campos.filter((c) => prioridad(c) <= 3) : campos)
    .slice()
    .sort((a, b) => prioridad(a) - prioridad(b) || a.key.localeCompare(b.key));

  return (
    <div className="card">
      <h2>Campos extraídos</h2>

      <label style={{ display: 'block', margin: '8px 0 16px', fontSize: 14 }}>
        <input
          type="checkbox"
          checked={soloPendientes}
          onChange={(e) => setSoloPendientes(e.target.checked)}
          style={{ marginRight: 8 }}
        />
        Mostrar solo lo que exige una decisión
      </label>

      {visibles.length === 0 ? (
        <p className="sub">No hay campos que revisar con este filtro.</p>
      ) : (
        // La tabla tiene muchas columnas y valores largos: en pantallas
        // estrechas se desborda. Que scrolee ella y no el documento entero.
        <div style={{ overflowX: 'auto' }}>
          <table style={{ minWidth: 980 }}>
            <thead>
              <tr>
                <th style={{ minWidth: 200 }}>Campo</th>
                <th style={{ width: 100 }}>Criticidad</th>
                <th style={{ width: 140 }}>Estado</th>
                <th style={{ minWidth: 220 }}>Valor</th>
                <th style={{ width: 100 }}>Procedencia</th>
                <th style={{ width: 110 }}>Revisión</th>
                <th style={{ width: 90 }}>Evidencia</th>
                {editable && <th style={{ width: 170 }}>Acciones</th>}
              </tr>
            </thead>
            <tbody>
              {visibles.map((c) => {
                const estado = ETIQUETA_ESTADO[c.status] ?? { texto: c.status, clase: '' };
                const revision = ETIQUETA_REVISION[c.reviewStatus] ?? { texto: c.reviewStatus, clase: '' };
                const desplegado = abierto === c.id;
                const editandoEste = editando === c.id;

                return (
                  <Fragment key={c.id}>
                    <tr>
                      <td style={{ fontFamily: 'monospace', fontSize: 12 }}>
                        {c.key}
                        {c.campaignProductId !== null && (
                          <div style={{ color: 'var(--muted)', fontSize: 11 }}>producto {c.campaignProductId.slice(0, 8)}</div>
                        )}
                      </td>
                      <td>
                        {c.criticidad === 'critico' && <span className="pill warn">crítico</span>}
                        {c.criticidad === 'claim' && <span className="pill info">claim</span>}
                        {c.criticidad === 'informativo' && <span className="pill">informativo</span>}
                      </td>
                      <td>
                        <span className={`pill ${estado.clase}`}>{estado.texto}</span>
                      </td>
                      <td style={{ fontSize: 13 }}>
                        {editandoEste ? (
                          <FormularioCorregir
                            versionId={versionId}
                            fieldId={c.id}
                            revision={c.revision}
                            valorInicial={valorLegible(c.value)}
                            onCancelar={() => setEditando(null)}
                            onGuardado={() => setEditando(null)}
                          />
                        ) : c.value === null ? (
                          <span style={{ color: 'var(--muted)' }}>
                            {c.status === 'conflict'
                              ? 'sin valor hasta que alguien resuelva el desacuerdo'
                              : '—'}
                          </span>
                        ) : (
                          valorLegible(c.value)
                        )}
                      </td>
                      <td style={{ fontSize: 12 }}>{ETIQUETA_PROCEDENCIA[c.provenanceType] ?? c.provenanceType}</td>
                      <td>
                        <span className={`pill ${revision.clase}`}>{revision.texto}</span>
                      </td>
                      <td>
                        {c.evidencias.length === 0 ? (
                          <span style={{ color: 'var(--muted)', fontSize: 13 }}>—</span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setAbierto(desplegado ? null : c.id)}
                            style={{
                              background: 'none',
                              border: 'none',
                              padding: 0,
                              color: 'var(--brand)',
                              cursor: 'pointer',
                              font: 'inherit',
                              fontSize: 13,
                            }}
                            aria-expanded={desplegado}
                          >
                            {desplegado ? 'ocultar' : `ver ${c.evidencias.length}`}
                          </button>
                        )}
                      </td>
                      {editable && (
                        <td>
                          <div className="row" style={{ gap: 6 }}>
                            {c.status === 'found' && (
                              <BotonConfirmar versionId={versionId} fieldId={c.id} revision={c.revision} />
                            )}
                            {!editandoEste && (
                              <button
                                type="button"
                                className="btn"
                                style={{ padding: '4px 10px', fontSize: 12 }}
                                onClick={() => setEditando(c.id)}
                              >
                                Corregir
                              </button>
                            )}
                          </div>
                        </td>
                      )}
                    </tr>

                    {desplegado && (
                      <tr>
                        <td colSpan={editable ? 8 : 7} style={{ background: 'var(--chip)' }}>
                          {c.evidencias.map((e, i) => (
                            <div key={i} style={{ padding: '8px 0' }}>
                              <div style={{ fontSize: 13, marginBottom: 4 }}>
                                <strong>{e.filename}</strong>{' '}
                                <span style={{ color: 'var(--muted)' }}>· {localizador(e)}</span>{' '}
                                {e.relation !== 'soporta' && <span className="pill warn">{e.relation}</span>}
                              </div>
                              <blockquote
                                style={{
                                  margin: 0,
                                  paddingLeft: 12,
                                  borderLeft: '3px solid var(--line)',
                                  fontSize: 13,
                                  fontStyle: 'italic',
                                  whiteSpace: 'pre-wrap',
                                }}
                              >
                                {e.quote}
                              </blockquote>
                              <div style={{ marginTop: 6, fontSize: 13 }}>
                                <a href={`/campanas/${campaignId}/fuentes/${e.sourceId}`}>
                                  Abrir el documento en su ubicación →
                                </a>
                              </div>
                            </div>
                          ))}
                          <p className="sub" style={{ marginTop: 4, fontSize: 12 }}>
                            Cada cita se comprobó contra el texto del fragmento antes de guardarse.
                          </p>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
