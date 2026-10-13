'use client';

import { useEffect, useMemo, useState } from 'react';
import { generarPreguntasDeBrief, transicionarBriefDeCampana } from '@/lib/actions';
import { AlertaPreguntasCriticas } from './AlertaPreguntasCriticas';
import { CampoEditable, type CampoParaEditar } from './CampoEditable';
import { NavegacionSecciones } from './NavegacionSecciones';
import { SelectorProducto } from './SelectorProducto';
import { TablaPreguntas } from './TablaPreguntas';

interface Seccion {
  id: string;
  titulo: string;
  campos: CampoParaEditar[];
}

const PANEL_PREGUNTAS = 'preguntas' as const;

type Contexto = 'comentarios' | 'evidencia';

export function EditorBrief({
  campaignId,
  versionId,
  estadoVersion,
  secciones,
  productos,
  preguntasCriticasPendientes,
  preguntasPendientesTotal,
  conteosComentarios = {},
  preguntas,
  filtroPreguntasStatus,
  filtroPreguntasProducto,
  panelInicial,
}: {
  campaignId: string;
  versionId: string;
  estadoVersion: string;
  secciones: Seccion[];
  productos: { id: string; model: string; rol: string }[];
  preguntasCriticasPendientes: number;
  preguntasPendientesTotal: number;
  conteosComentarios?: Record<string, number>;
  preguntas: Parameters<typeof TablaPreguntas>[0]['preguntas'];
  filtroPreguntasStatus?: string | undefined;
  filtroPreguntasProducto?: string | undefined;
  panelInicial?: typeof PANEL_PREGUNTAS | undefined;
}) {
  const [panelActivo, setPanelActivo] = useState<string>(panelInicial ?? secciones[0]?.id ?? '');
  const [productoSeleccionado, setProductoSeleccionado] = useState<string | undefined>(productos[0]?.id);
  const [contextoActivo, setContextoActivo] = useState<Contexto>('comentarios');

  useEffect(() => {
    if (panelInicial === PANEL_PREGUNTAS) setPanelActivo(PANEL_PREGUNTAS);
  }, [panelInicial]);

  const enPreguntas = panelActivo === PANEL_PREGUNTAS;
  const seccion = secciones.find((s) => s.id === panelActivo) ?? secciones[0];

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
            return tieneExcepcion
              ? c.campaignProductId === productoSeleccionado
              : c.campaignProductId === null;
          }
          return true;
        });

  const comentariosAbiertos = secciones
    .flatMap((s) => s.campos)
    .filter((c) => (conteosComentarios[c.key] ?? 0) > 0)
    .map((c) => ({ key: c.key, label: c.label, cantidad: conteosComentarios[c.key] ?? 0 }));

  const evidencias = useMemo(() => {
    if (enPreguntas) return [];
    return camposVisibles.flatMap((campo) =>
      campo.evidencias.map((e) => ({
        ...e,
        fieldKey: campo.key,
        fieldLabel: campo.label,
      })),
    );
  }, [camposVisibles, enPreguntas]);

  const camposCompletos = camposVisibles.filter((c) => c.status === 'found').length;
  const progresoSeccion =
    camposVisibles.length === 0 ? 0 : Math.round((camposCompletos / camposVisibles.length) * 100);

  return (
    <div className="workspace brief-workspace">
      <aside className="card workspace-nav">
        <div className="workspace-nav-head">
          <div className="eyebrow">Secciones</div>
          <strong>Brief</strong>
        </div>
        <NavegacionSecciones
          secciones={seccionesConPendientes}
          activa={enPreguntas ? '' : panelActivo}
          onSeleccionar={setPanelActivo}
        />
        <div className="workspace-nav-divider" />
        <button
          type="button"
          onClick={() => setPanelActivo(PANEL_PREGUNTAS)}
          className={`workspace-special-nav ${enPreguntas ? 'active' : ''}`}
        >
          <span className="section-number">?</span>
          <span>
            <b>Preguntas</b>
            <small>
              {preguntasPendientesTotal > 0 ? `${preguntasPendientesTotal} pendientes` : 'sin pendientes'}
            </small>
          </span>
        </button>
      </aside>

      <section className="card workspace-main">
        <AlertaPreguntasCriticas campaignId={campaignId} cantidad={preguntasCriticasPendientes} />

        {enPreguntas ? (
          <>
            <div className="workspace-section-header">
              <div>
                <div className="eyebrow">Pendientes del brief</div>
                <h2>Preguntas locales</h2>
                <p>Resuelve en el mismo workspace lo que no pudo completarse automáticamente.</p>
              </div>
              <form action={generarPreguntasDeBrief}>
                <input type="hidden" name="campaignId" value={campaignId} />
                <input type="hidden" name="versionId" value={versionId} />
                <button className="btn" type="submit">
                  Regenerar pendientes
                </button>
              </form>
            </div>
            <TablaPreguntas
              preguntas={preguntas}
              campaignId={campaignId}
              productos={productos.map((p) => ({ id: p.id, model: p.model }))}
              filtroStatus={filtroPreguntasStatus}
              filtroProducto={filtroPreguntasProducto}
              editable
            />
          </>
        ) : (
          <>
            <div className="workspace-section-header">
              <div>
                <div className="eyebrow">Sección del brief</div>
                <h2>{seccion?.titulo}</h2>
                <p>
                  {camposCompletos} de {camposVisibles.length} campos con dato.
                </p>
              </div>
              <div className="section-progress">
                <strong>{progresoSeccion}%</strong>
                <span>completo</span>
                <div className="progreso">
                  <span style={{ width: `${progresoSeccion}%` }} />
                </div>
              </div>
            </div>

            {tieneCamposDeProducto && (
              <div className="product-context-bar">
                <span>Producto</span>
                <SelectorProducto
                  productos={productos}
                  seleccionado={productoSeleccionado}
                  onSeleccionar={setProductoSeleccionado}
                />
              </div>
            )}

            <div className="fields-stack">
              {camposVisibles.length === 0 ? (
                <p className="vacio">Esta sección no tiene campos para el producto seleccionado.</p>
              ) : (
                camposVisibles.map((c) => (
                  <CampoEditable
                    key={c.id}
                    campo={c}
                    versionId={versionId}
                    productoSeleccionado={
                      c.nivel === 'compartido_con_excepcion' ? productoSeleccionado : undefined
                    }
                    conteoComentariosAbiertos={conteosComentarios[c.key] ?? 0}
                  />
                ))
              )}
            </div>
          </>
        )}

        <div className="workspace-dock">
          <div className="workspace-dock-copy">
            <span className="status-mark status-mark-ok" />
            <div>
              <strong>Autoguardado activo</strong>
              <small>Los campos se guardan al salir de cada input.</small>
            </div>
          </div>
          <form action={transicionarBriefDeCampana}>
            <input type="hidden" name="campaignId" value={campaignId} />
            <input type="hidden" name="versionId" value={versionId} />
            <input type="hidden" name="to" value="internal_review" />
            <button className="btn pri" type="submit" disabled={estadoVersion === 'internal_review'}>
              {estadoVersion === 'internal_review' ? 'En revisión interna' : 'Enviar a revisión →'}
            </button>
          </form>
        </div>
      </section>

      <aside className="card workspace-side">
        <div className="context-tabs" role="tablist" aria-label="Contexto del brief">
          <button
            type="button"
            className={contextoActivo === 'comentarios' ? 'active' : ''}
            onClick={() => setContextoActivo('comentarios')}
          >
            Comentarios
          </button>
          <button
            type="button"
            className={contextoActivo === 'evidencia' ? 'active' : ''}
            onClick={() => setContextoActivo('evidencia')}
          >
            Evidencia
          </button>
        </div>

        {contextoActivo === 'comentarios' ? (
          <div className="context-panel">
            <div className="context-panel-head">
              <div>
                <div className="eyebrow">Conversaciones</div>
                <h3>Comentarios abiertos</h3>
              </div>
              <span>{comentariosAbiertos.length}</span>
            </div>
            {comentariosAbiertos.length === 0 ? (
              <div className="quiet-state compact">
                <span className="status-mark status-mark-ok" />
                <div>
                  <strong>Sin conversaciones abiertas</strong>
                  <p>Los comentarios de cada campo se abren en contexto.</p>
                </div>
              </div>
            ) : (
              <div className="context-list">
                {comentariosAbiertos.map((c) => (
                  <a href={`#campo-${c.key}`} key={c.key}>
                    <span className="context-list-icon">◌</span>
                    <span>
                      <strong>{c.label}</strong>
                      <small>
                        {c.cantidad} comentario{c.cantidad > 1 ? 's' : ''}
                      </small>
                    </span>
                    <b>→</b>
                  </a>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="context-panel">
            <div className="context-panel-head">
              <div>
                <div className="eyebrow">Sección activa</div>
                <h3>Evidencia</h3>
              </div>
              <span>{evidencias.length}</span>
            </div>
            {evidencias.length === 0 ? (
              <div className="quiet-state compact">
                <span className="status-mark status-mark-neutral" />
                <div>
                  <strong>Sin evidencia en esta vista</strong>
                  <p>Cuando un campo tenga soporte documental aparecerá aquí.</p>
                </div>
              </div>
            ) : (
              <div className="evidence-list">
                {evidencias.slice(0, 8).map((e, i) => (
                  <a
                    href={`/campanas/${campaignId}/fuentes/${e.sourceId}`}
                    key={`${e.sourceId}-${e.fieldKey}-${i}`}
                  >
                    <span className="evidence-file-icon">▤</span>
                    <span>
                      <strong>{e.filename}</strong>
                      <small>{e.fieldLabel}</small>
                      <em>“{e.quote}”</em>
                    </span>
                  </a>
                ))}
              </div>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}
