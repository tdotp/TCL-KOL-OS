'use client';

import { useEffect, useState } from 'react';
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
  /** Preguntas locales pendientes de cualquier criticidad — cuenta del nav. */
  preguntasPendientesTotal: number;
  /** E7-6 · conversaciones abiertas por clave de campo. Nunca llega para el rol `cliente`. */
  conteosComentarios?: Record<string, number>;
  /** UI-09 · Preguntas locales, fusionadas en este mismo workspace. */
  preguntas: Parameters<typeof TablaPreguntas>[0]['preguntas'];
  filtroPreguntasStatus?: string | undefined;
  filtroPreguntasProducto?: string | undefined;
  panelInicial?: typeof PANEL_PREGUNTAS | undefined;
}) {
  const [panelActivo, setPanelActivo] = useState<string>(panelInicial ?? secciones[0]?.id ?? '');
  const [productoSeleccionado, setProductoSeleccionado] = useState<string | undefined>(productos[0]?.id);

  // `panelInicial` viene de `?panel=preguntas` en la URL (enlaces desde fuera
  // del editor, como la alerta de preguntas críticas o "siguiente acción" en
  // el overview de campaña). El componente sigue montado entre navegaciones
  // dentro de la misma ruta, así que el estado inicial de `useState` no
  // reacciona solo — sin este efecto, un segundo enlace desde otra pantalla
  // no movería el panel si ya se había cambiado de sección a mano.
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
            // Con excepción declarada para el producto activo: se muestra solo
            // esa fila. Sin excepción: se muestra la compartida.
            return tieneExcepcion
              ? c.campaignProductId === productoSeleccionado
              : c.campaignProductId === null;
          }
          return true; // campaña: siempre visible, siempre una sola fila
        });

  const comentariosAbiertos = secciones
    .flatMap((s) => s.campos)
    .filter((c) => (conteosComentarios[c.key] ?? 0) > 0)
    .map((c) => ({ key: c.key, label: c.label, cantidad: conteosComentarios[c.key] ?? 0 }));

  return (
    <div className="workspace">
      <aside className="card workspace-nav">
        <NavegacionSecciones
          secciones={seccionesConPendientes}
          activa={enPreguntas ? '' : panelActivo}
          onSeleccionar={setPanelActivo}
        />
        <button
          type="button"
          onClick={() => setPanelActivo(PANEL_PREGUNTAS)}
          className={`pill ${enPreguntas ? 'ok' : preguntasPendientesTotal > 0 ? 'warn' : ''}`}
          style={{ cursor: 'pointer', border: 'none', marginTop: 10 }}
        >
          Preguntas{preguntasPendientesTotal > 0 ? ` (${preguntasPendientesTotal})` : ''}
        </button>
      </aside>

      <section className="card workspace-main">
        <AlertaPreguntasCriticas campaignId={campaignId} cantidad={preguntasCriticasPendientes} />

        {enPreguntas ? (
          <>
            <h2 style={{ marginTop: 0 }}>Preguntas locales</h2>
            <p className="sub">
              Un campo que el sistema no pudo llenar solo, con el motivo por el que quedó pendiente. Cada
              pregunta se responde con autor y fecha, o se descarta con justificación.
            </p>
            <form action={generarPreguntasDeBrief} style={{ marginBottom: 16 }}>
              <input type="hidden" name="campaignId" value={campaignId} />
              <input type="hidden" name="versionId" value={versionId} />
              <button className="btn" type="submit">
                Generar preguntas de lo que falte
              </button>
            </form>
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
                  conteoComentariosAbiertos={conteosComentarios[c.key] ?? 0}
                />
              ))
            )}
          </>
        )}

        <div className="card" style={{ marginTop: 24, background: 'var(--bg)' }}>
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
      </section>

      <aside className="card workspace-side">
        <h3 className="section-title">Comentarios abiertos</h3>
        {comentariosAbiertos.length === 0 ? (
          <p className="sub" style={{ margin: 0 }}>
            Sin conversaciones abiertas en esta versión.
          </p>
        ) : (
          <div className="action-list">
            {comentariosAbiertos.map((c) => (
              <div className="action-row" key={c.key}>
                <div className="action-ico">💬</div>
                <a href={`#campo-${c.key}`}>
                  <b>{c.label}</b>
                  <span className="detalle">
                    {c.cantidad} comentario{c.cantidad > 1 ? 's' : ''} abierto{c.cantidad > 1 ? 's' : ''}
                  </span>
                </a>
              </div>
            ))}
          </div>
        )}
      </aside>
    </div>
  );
}
