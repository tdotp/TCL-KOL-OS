import { notFound, redirect } from 'next/navigation';
import {
  getCampaign,
  listarPreguntas,
  motivoDeUltimaDevolucion,
  verCamposDeVersion,
  versionesDelBrief,
} from '@tcl-kol-os/db';
import { allowedTransitions, campoDelCatalogo, type BriefStatus } from '@tcl-kol-os/domain';
import { currentUser } from '@/lib/session';
import { ORDEN_DE_SECCIONES, TITULO_SECCION } from '@/lib/brief-sections';
import { ESTADO_EN_ESPANOL, ETAPAS, TEXTO_DEL_BOTON, etapaDeStatus } from '@/lib/brief-ui';
import { monogramaColor, monogramaIniciales } from '@/lib/monograma';
import {
  crearBriefManualDeCampana,
  crearVersionHijaDeCampana,
  reintentarExtraccionDeBrief,
  transicionarBriefDeCampana,
} from '@/lib/actions';
import { ConfirmarAccion } from '@/components/ConfirmarAccion';
import { BotonExtraer } from './BotonExtraer';
import { TablaCampos } from './TablaCampos';
import { FormularioSolicitarCambiosInternos } from './FormularioSolicitarCambiosInternos';
import { VistaCliente, type CampoParaCliente } from './VistaCliente';

export const dynamic = 'force-dynamic';


function CabeceraBrief({
  id,
  name,
  market,
  category,
  status,
  cliente = false,
}: {
  id: string;
  name: string;
  market: string;
  category: string | null;
  status: BriefStatus | undefined;
  cliente?: boolean;
}) {
  const etapa = etapaDeStatus(status);
  const indice = ETAPAS.findIndex((e) => e.id === etapa);
  return (
    <>
      <a className="back-link" href={`/campanas/${id}`}>← {name}</a>
      <header className="campaign-header compact-campaign-header review-campaign-header">
        <span className={`monogram lg ${monogramaColor(id)}`}>{monogramaIniciales(name)}</span>
        <div className="campaign-heading-copy">
          <div className="campaign-kickers">
            <span className="pill neutro">{cliente ? 'Vista cliente' : 'Review workspace'}</span>
            {status !== undefined && <span className="status-dot">{ESTADO_EN_ESPANOL[status] ?? status}</span>}
          </div>
          <h1>{name}</h1>
          <p>{market} · {category ?? 'Sin categoría'}</p>
        </div>
        {!cliente && (
          <div className="campaign-header-actions">
            <a className="btn" href={`/campanas/${id}/fuentes`}>Fuentes</a>
            <a className="btn" href={`/campanas/${id}/brief/editar`}>Editar brief</a>
          </div>
        )}
      </header>
      <nav className="campaign-context-nav" aria-label="Secciones de campaña">
        <a href={`/campanas/${id}`}>Resumen</a>
        <a href={`/campanas/${id}/fuentes`}>Fuentes</a>
        <a className="active" href={`/campanas/${id}/brief`}>Brief</a>
        {!cliente && <a href={`/campanas/${id}/brief/editar`}>Editar</a>}
      </nav>
      <div className="stepper campaign-stepper">
        {ETAPAS.map((item, i) => (
          <div key={item.id} className={`step ${i < indice ? 'done' : i === indice ? 'current' : ''}`}>
            <div className="step-num">{i < indice ? '✓' : i + 1}</div>
            <div className="step-name">{item.nombre}</div>
          </div>
        ))}
      </div>
    </>
  );
}

/**
 * UI-08 · Revisión de extracción, con UI-11 · Evidencias integradas.
 *
 * Van en la misma pantalla y no en dos, por la misma razón que UI-06 y UI-07:
 * la pregunta que se hace el consultor al revisar un campo es *"¿de dónde salió
 * esto?"*, y mandarlo a otra pantalla para responderla convierte la
 * verificación en un trámite que nadie hace. La evidencia se despliega bajo el
 * campo que respalda.
 *
 * Los botones de transición nunca reimplementan una guarda del dominio
 * (ADR-008): se calculan con `allowedTransitions`, la misma función que usa
 * `transicionarBrief`, y si el servidor rechaza la transición, el mensaje que
 * vuelve es el de la guarda que falló — nunca "brief inválido" genérico
 * (sección 7 del cierre de Sprint 4).
 */
export default async function BriefPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; detalle?: string }>;
}) {
  const user = await currentUser();
  if (user === undefined) redirect('/login');

  const { id } = await params;
  const { error, detalle } = await searchParams;

  const campana = await getCampaign(user, id);
  if (!campana.ok) notFound();

  const versiones = await versionesDelBrief(user, id);
  const listaVersiones = versiones.ok ? versiones.value : [];
  const ultima = listaVersiones[0];

  const campos = ultima === undefined ? null : await verCamposDeVersion(user, ultima.id);
  const listaCampos = campos !== null && campos.ok ? campos.value : [];

  // Fase D: el cliente nunca ve la pantalla interna (modelo, costo, revisión
  // técnica, clave del catálogo) — un componente aparte que solo recibe
  // label/valor/evidencia, para que una filtración no dependa de acordarse
  // de ocultar un campo más en esta misma pantalla.
  if (user.role === 'cliente') {
    const ESTADOS_VISIBLES_PARA_CLIENTE = [
      'client_review',
      'client_changes_requested',
      'approved',
      'superseded',
    ];
    const visible = ultima !== undefined && ESTADOS_VISIBLES_PARA_CLIENTE.includes(ultima.status);

    const camposParaCliente: CampoParaCliente[] = !visible
      ? []
      : listaCampos
          .filter((c) => c.status === 'found')
          .map((c) => {
            const catalogo = campoDelCatalogo(c.key);
            return {
              key: c.key,
              label: catalogo?.label ?? c.key,
              section: catalogo?.section ?? 'practico',
              value: c.value,
              campaignProductId: c.campaignProductId,
              evidencias: c.evidencias,
            };
          });

    const seccionesParaCliente = ORDEN_DE_SECCIONES.filter((s) =>
      camposParaCliente.some((c) => c.section === s),
    ).map((s) => ({
      id: s,
      titulo: TITULO_SECCION[s] ?? s,
      campos: camposParaCliente.filter((c) => c.section === s),
    }));

    return (
      <div className="content content-wide ui-enter">
        <CabeceraBrief
          id={id}
          name={campana.value.campaign.name}
          market={campana.value.campaign.market}
          category={campana.value.campaign.category}
          status={ultima?.status as BriefStatus | undefined}
          cliente
        />

        {error !== undefined && (
          <div className="aviso error">
            <strong>No se pudo completar la acción</strong>
            {decodeURIComponent(error)}
          </div>
        )}

        {ultima === undefined || !visible ? (
          <div className="card">
            <p className="vacio">Todavía no hay nada para revisar en esta campaña.</p>
          </div>
        ) : (
          <VistaCliente
            campaignId={id}
            versionId={ultima.id}
            version={ultima.version}
            estadoVersion={ultima.status}
            secciones={seccionesParaCliente}
            productos={campana.value.productos.map((p) => ({ id: p.id, model: p.model }))}
          />
        )}
      </div>
    );
  }

  const criticosFaltantes = listaCampos.filter((c) => c.criticidad === 'critico' && c.status !== 'found');
  const conflictos = listaCampos.filter((c) => c.status === 'conflict');
  const encontrados = listaCampos.filter((c) => c.status === 'found');
  const sinRevisar = listaCampos.filter((c) => c.status === 'found' && c.reviewStatus === 'pending');

  const preguntas =
    ultima === undefined ? undefined : await listarPreguntas(user, id, { status: 'pendiente' });
  const preguntasPendientes = preguntas?.ok ? preguntas.value.length : 0;
  const preguntasCriticasPendientes = preguntas?.ok
    ? preguntas.value.filter((p) => p.criticidad === 'critico').length
    : 0;

  const devolucion =
    ultima !== undefined &&
    (ultima.status === 'internal_changes_requested' || ultima.status === 'client_changes_requested')
      ? await motivoDeUltimaDevolucion(ultima.id)
      : undefined;

  const transicionesPosibles =
    ultima !== undefined
      ? allowedTransitions(ultima.status as BriefStatus, user).filter((t) => t !== 'cancelled')
      : [];

  return (
    <div className="content content-wide ui-enter">
      <CabeceraBrief
        id={id}
        name={campana.value.campaign.name}
        market={campana.value.campaign.market}
        category={campana.value.campaign.category}
        status={ultima?.status as BriefStatus | undefined}
      />
      <div className="review-intro">
        <div className="eyebrow">Revisión estructurada</div>
        <h2>Contenido y decisión</h2>
        <p>Verifica cada afirmación con su evidencia y avanza únicamente con las transiciones reales del workflow.</p>
      </div>

      {error !== undefined && (
        <div className="bloqueo">
          <p className="titulo">
            No se pudo completar la acción
            {detalle !== undefined &&
              ` — falta${decodeURIComponent(detalle).split(',').length > 1 ? 'n' : ''} ${decodeURIComponent(detalle).split(',').length} condición${decodeURIComponent(detalle).split(',').length > 1 ? 'es' : ''}`}
          </p>
          <p className="cuerpo">{decodeURIComponent(error)}</p>
          {detalle !== undefined && (
            <ol>
              {decodeURIComponent(detalle)
                .split(',')
                .map((campo) => (
                  <li key={campo}>
                    <span className="mono">{campo.trim()}</span>
                    <a href={`#campo-${campo.trim()}`}>Ir al campo →</a>
                  </li>
                ))}
            </ol>
          )}
        </div>
      )}

      {ultima === undefined ? (
        <>
          <BotonExtraer campaignId={id} />
          <div className="card">
            <h2>Todavía no hay ninguna versión</h2>
            <p className="sub">
              Cargue fuentes en la campaña y ejecute la extracción, o empiece el brief a mano: la asistencia
              de IA nunca es requisito para avanzar.
            </p>
            <div className="row" style={{ gap: 8, marginTop: 12 }}>
              <a className="btn" href={`/campanas/${id}/fuentes`}>
                Ir a fuentes →
              </a>
              <form action={crearBriefManualDeCampana}>
                <input type="hidden" name="campaignId" value={id} />
                <button className="btn pri" type="submit">
                  Empezar el brief a mano
                </button>
              </form>
            </div>
          </div>
        </>
      ) : (
        <div className="review-layout">
          <section className="card review-main">
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <h2 style={{ margin: 0 }}>
                Versión {ultima.version}{' '}
                <span
                  className={`pill ${ultima.status === 'approved' ? 'ok' : ultima.status === 'processing_failed' ? 'bad' : 'curso'}`}
                >
                  {ESTADO_EN_ESPANOL[ultima.status as BriefStatus] ?? ultima.status}
                </span>
              </h2>
              <BotonExtraer campaignId={id} />
            </div>
            <p className="sub">
              {encontrados.length} campo(s) con dato · {criticosFaltantes.length} crítico(s) pendiente(s) ·{' '}
              {conflictos.length} conflicto(s) · {sinRevisar.length} sin confirmar
              {ultima.modelo !== null && (
                <>
                  {' '}
                  · extraído con <code>{ultima.modelo}</code>
                  {ultima.costoUsd !== null && ` (USD ${ultima.costoUsd.toFixed(4)})`}
                </>
              )}
            </p>

            {devolucion !== undefined && (
              <div className="chat-msg" style={{ marginTop: 10 }}>
                <div className="chat-avatar" style={{ background: 'var(--bad)' }}>
                  {(devolucion.actorName ?? '?').slice(0, 2).toUpperCase()}
                </div>
                <div style={{ flex: 1 }}>
                  <div className="chat-bubble" style={{ background: 'var(--bad-soft)' }}>
                    <div className="chat-meta">
                      <strong>{devolucion.actorName ?? 'alguien'}</strong>{' '}
                      {devolucion.to === 'internal_changes_requested'
                        ? 'devolvió el brief en revisión interna'
                        : 'solicitó cambios como cliente'}{' '}
                      · {new Date(devolucion.createdAt).toLocaleString('es-CO')}
                    </div>
                    <div className="chat-texto">{devolucion.motivo}</div>
                  </div>
                  {devolucion.camposSenalados.length > 0 && (
                    <p className="sub" style={{ margin: '4px 0 0', fontSize: 12 }}>
                      Campos señalados:{' '}
                      {devolucion.camposSenalados.map((campo, i) => (
                        <span key={campo}>
                          {i > 0 && ', '}
                          <a href={`#campo-${campo}`} className="mono">
                            {campo}
                          </a>
                        </span>
                      ))}
                    </p>
                  )}
                </div>
              </div>
            )}

            <TablaCampos campos={listaCampos} campaignId={id} versionId={ultima.id} editable />

            {listaVersiones.length > 1 && (
              <div style={{ marginTop: 20 }}>
                <h2>Versiones anteriores</h2>
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: 80 }}>Versión</th>
                      <th style={{ width: 160 }}>Estado</th>
                      <th style={{ width: 180 }}>Fecha</th>
                      <th>Modelo</th>
                      <th style={{ width: 100 }}>Costo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {listaVersiones.slice(1).map((v) => (
                      <tr key={v.id}>
                        <td>{v.version}</td>
                        <td>
                          <span className="pill neutro">
                            {ESTADO_EN_ESPANOL[v.status as BriefStatus] ?? v.status}
                          </span>
                        </td>
                        <td style={{ fontSize: 13, color: 'var(--muted)' }}>
                          {new Date(v.createdAt).toLocaleString('es-CO')}
                        </td>
                        <td style={{ fontSize: 13 }}>{v.modelo ?? '— manual —'}</td>
                        <td style={{ fontSize: 13 }}>
                          {v.costoUsd === null ? '—' : `USD ${v.costoUsd.toFixed(4)}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <aside className="side-stack">
            <div className="card side-card">
              <h3 className="section-title">Decisión</h3>

              {preguntasCriticasPendientes > 0 && (
                <p className="aviso error" style={{ marginTop: 0 }}>
                  {preguntasCriticasPendientes} pregunta(s) crítica(s) pendiente(s).{' '}
                  <a href={`/campanas/${id}/brief/editar?panel=preguntas`}>Responder ahora →</a>
                </p>
              )}

              {/* El estado y la siguiente acción posible siempre quedan visibles
                  (corrección 1 del cierre de Sprint 4). */}
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <a className="btn" href={`/campanas/${id}/brief/editar`} style={{ width: '100%' }}>
                  Abrir el editor
                </a>
                {(preguntasPendientes > 0 || ultima.status === 'local_questions') && (
                  <a className="btn" href={`/campanas/${id}/brief/editar?panel=preguntas`} style={{ width: '100%' }}>
                    Preguntas locales{preguntasPendientes > 0 ? ` (${preguntasPendientes})` : ''}
                  </a>
                )}
                {ultima.status === 'processing_failed' && (
                  <form action={reintentarExtraccionDeBrief} style={{ width: '100%' }}>
                    <input type="hidden" name="campaignId" value={id} />
                    <input type="hidden" name="versionId" value={ultima.id} />
                    <button className="btn pri" type="submit" style={{ width: '100%' }}>
                      Reintentar extracción
                    </button>
                  </form>
                )}
                {transicionesPosibles
                  .filter((t) => t in TEXTO_DEL_BOTON)
                  .map((to) => (
                    <form action={transicionarBriefDeCampana} key={to} style={{ width: '100%' }}>
                      <input type="hidden" name="campaignId" value={id} />
                      <input type="hidden" name="versionId" value={ultima.id} />
                      <input type="hidden" name="to" value={to} />
                      {to === 'client_review' || to === 'approved' ? (
                        <ConfirmarAccion
                          etiqueta={TEXTO_DEL_BOTON[to] ?? ''}
                          titulo={
                            to === 'client_review'
                              ? `¿Aprobar internamente el brief v${ultima.version}?`
                              : `¿Aprobar el brief v${ultima.version} sin pasar por revisión del cliente?`
                          }
                          consecuencias={
                            to === 'client_review'
                              ? [
                                  `${encontrados.length} campo(s) quedan tal como están ahora mismo.`,
                                  'El brief pasa a revisión del cliente — usted ya no puede editarlo.',
                                  'Para cambiar algo habrá que devolverlo o crear una versión nueva.',
                                ]
                              : [
                                  `${encontrados.length} campo(s) quedan congelados de inmediato.`,
                                  'El brief queda aprobado e inmutable — nadie podrá editarlo.',
                                  'Para cambiar algo habrá que crear una versión nueva.',
                                ]
                          }
                          textoConfirmar={to === 'client_review' ? 'Sí, aprobar internamente' : 'Sí, aprobar'}
                          className="btn pri"
                          style={{ width: '100%' }}
                        />
                      ) : (
                        <button className="btn pri" type="submit" style={{ width: '100%' }}>
                          {TEXTO_DEL_BOTON[to]}
                        </button>
                      )}
                    </form>
                  ))}
                {transicionesPosibles.includes('internal_changes_requested') && (
                  <FormularioSolicitarCambiosInternos versionId={ultima.id} campaignId={id} />
                )}
                {ultima.status === 'approved' && (
                  <form action={crearVersionHijaDeCampana} style={{ width: '100%' }}>
                    <input type="hidden" name="campaignId" value={id} />
                    <input type="hidden" name="versionId" value={ultima.id} />
                    <ConfirmarAccion
                      etiqueta="Crear nueva revisión"
                      titulo={`¿Crear una versión nueva a partir de v${ultima.version}?`}
                      consecuencias={[
                        `La versión v${ultima.version} queda marcada como reemplazada — se conserva intacta, solo de lectura.`,
                        'La versión nueva empieza en borrador con una copia de los campos actuales.',
                        'A partir de ahí se puede volver a editar todo.',
                      ]}
                      textoConfirmar="Sí, crear versión nueva"
                      className="btn"
                      style={{ width: '100%' }}
                    />
                  </form>
                )}
              </div>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
