'use client';

import { Fragment, useState } from 'react';

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
  value: unknown;
  status: string;
  criticidad: string;
  confidence: number | null;
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

/**
 * UI-08 + UI-11 · Campos con su evidencia desplegable.
 *
 * El orden no es alfabético a propósito: primero lo que exige una decisión
 * —conflictos y críticos sin dato—, después lo encontrado, y al final lo que
 * simplemente no está. Una tabla ordenada por nombre de campo obliga a leerla
 * entera para saber si hay algo que hacer.
 */
export function TablaCampos({ campos, campaignId }: { campos: Campo[]; campaignId: string }) {
  const [abierto, setAbierto] = useState<string | null>(null);
  const [soloPendientes, setSoloPendientes] = useState(false);

  const prioridad = (c: Campo): number => {
    if (c.status === 'conflict') return 0;
    if (c.criticidad === 'critico' && c.status !== 'found') return 1;
    if (c.criticidad === 'claim' && c.status !== 'found') return 2;
    if (c.status === 'found') return 3;
    return 4;
  };

  const visibles = (soloPendientes ? campos.filter((c) => prioridad(c) <= 2) : campos)
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
        // La tabla tiene cinco columnas y valores largos: en pantallas
        // estrechas se desborda. Que scrolee ella y no el documento entero.
        <div style={{ overflowX: 'auto' }}>
          <table style={{ minWidth: 820 }}>
            <thead>
              <tr>
                <th style={{ minWidth: 210 }}>Campo</th>
                <th style={{ width: 110 }}>Criticidad</th>
                <th style={{ width: 150 }}>Estado</th>
                <th style={{ minWidth: 260 }}>Valor</th>
                <th style={{ width: 90 }}>Evidencia</th>
              </tr>
            </thead>
            <tbody>
              {visibles.map((c) => {
                const estado = ETIQUETA_ESTADO[c.status] ?? { texto: c.status, clase: '' };
                const desplegado = abierto === c.id;

                return (
                  <Fragment key={c.id}>
                    <tr>
                      <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{c.key}</td>
                      <td>
                        {c.criticidad === 'critico' && <span className="pill warn">crítico</span>}
                        {c.criticidad === 'claim' && <span className="pill info">claim</span>}
                        {c.criticidad === 'informativo' && <span className="pill">informativo</span>}
                      </td>
                      <td>
                        <span className={`pill ${estado.clase}`}>{estado.texto}</span>
                      </td>
                      <td style={{ fontSize: 13 }}>
                        {c.value === null ? (
                          <span style={{ color: 'var(--muted)' }}>
                            {c.status === 'conflict'
                              ? 'sin valor hasta que alguien resuelva el desacuerdo'
                              : '—'}
                          </span>
                        ) : (
                          String(c.value)
                        )}
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
                    </tr>

                    {desplegado && (
                      <tr>
                        <td colSpan={5} style={{ background: 'var(--chip)' }}>
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
