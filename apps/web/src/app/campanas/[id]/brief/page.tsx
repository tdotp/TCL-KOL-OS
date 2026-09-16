import { notFound, redirect } from 'next/navigation';
import {
  getCampaign,
  listarPreguntas,
  motivoDeUltimaDevolucion,
  verCamposDeVersion,
  versionesDelBrief,
} from '@tcl-kol-os/db';
import { allowedTransitions, campoDelCatalogo, type BriefStatus } from '@tcl-kol-os/domain';
import { Encabezado } from '@/components/Encabezado';
import { currentUser } from '@/lib/session';
import { ORDEN_DE_SECCIONES, TITULO_SECCION } from '@/lib/brief-sections';
import {
  crearBriefManualDeCampana,
  crearVersionHijaDeCampana,
  reintentarExtraccionDeBrief,
  transicionarBriefDeCampana,
} from '@/lib/actions';
import { BotonExtraer } from './BotonExtraer';
import { TablaCampos } from './TablaCampos';
import { FormularioSolicitarCambiosInternos } from './FormularioSolicitarCambiosInternos';
import { VistaCliente, type CampoParaCliente } from './VistaCliente';

export const dynamic = 'force-dynamic';

/** Los doce estados reales de §7.3 — antes esta tabla tenía nombres que no existían. */
const ESTADO_EN_ESPANOL: Record<BriefStatus, string> = {
  draft: 'borrador',
  processing: 'extrayendo…',
  extraction_review: 'revisión de extracción',
  local_questions: 'preguntas locales',
  internal_review: 'revisión interna',
  internal_changes_requested: 'cambios internos solicitados',
  client_review: 'revisión del cliente',
  client_changes_requested: 'cambios del cliente solicitados',
  approved: 'aprobado',
  superseded: 'reemplazado',
  cancelled: 'cancelado',
  processing_failed: 'extracción fallida',
};

/** Qué transición ofrecer y con qué texto — la regla vive en el dominio, esto solo la muestra. */
const TEXTO_DEL_BOTON: Partial<Record<BriefStatus, string>> = {
  local_questions: 'Ir a las preguntas',
  extraction_review: 'Volver al brief',
  internal_review: 'Enviar a revisión interna',
  client_review: 'Aprobar internamente',
  approved: 'Aprobar',
};

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
      <>
        <Encabezado user={user} />
        <main>
          <p className="sub" style={{ marginBottom: 4 }}>
            <a href={`/campanas/${id}`}>← {campana.value.campaign.name}</a>
          </p>
          <h1>Brief</h1>

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
        </main>
      </>
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
    <>
      <Encabezado user={user} />
      <main>
        <p className="sub" style={{ marginBottom: 4 }}>
          <a href={`/campanas/${id}`}>← {campana.value.campaign.name}</a>
        </p>
        <h1>Brief</h1>
        <p className="sub">
          Campos propuestos a partir de las fuentes cargadas. Cada afirmación abre el documento, la ubicación
          y la frase exacta de donde salió.
        </p>

        {error !== undefined && (
          <div className="aviso error">
            <strong>No se pudo completar la acción</strong>
            {decodeURIComponent(error)}
            {detalle !== undefined && (
              <p style={{ marginTop: 6 }}>
                Campos afectados: <span className="mono">{decodeURIComponent(detalle)}</span>
              </p>
            )}
          </div>
        )}

        {ultima === undefined && <BotonExtraer campaignId={id} />}

        {ultima === undefined ? (
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
        ) : (
          <>
            <div className="card">
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <h2 style={{ margin: 0 }}>
                  Versión {ultima.version}{' '}
                  <span
                    className={`pill ${ultima.status === 'approved' ? 'ok' : ultima.status === 'processing_failed' ? 'bad' : 'info'}`}
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

              {preguntasCriticasPendientes > 0 && (
                <p className="aviso error" style={{ marginTop: 10 }}>
                  {preguntasCriticasPendientes} pregunta(s) crítica(s) pendiente(s).{' '}
                  <a href={`/campanas/${id}/preguntas`}>Responder ahora →</a>
                </p>
              )}

              {devolucion !== undefined && (
                <p className="aviso error" style={{ marginTop: 10 }}>
                  <strong>
                    {devolucion.to === 'internal_changes_requested'
                      ? 'Devuelto en revisión interna'
                      : 'El cliente solicitó cambios'}
                  </strong>{' '}
                  por {devolucion.actorName ?? 'alguien'} el{' '}
                  {new Date(devolucion.createdAt).toLocaleString('es-CO')}: {devolucion.motivo}
                  {devolucion.camposSenalados.length > 0 && (
                    <>
                      {' '}
                      — campos señalados:{' '}
                      <span className="mono">{devolucion.camposSenalados.join(', ')}</span>
                    </>
                  )}
                </p>
              )}

              {/* El estado y la siguiente acción posible siempre quedan visibles
                  (corrección 1 del cierre de Sprint 4). */}
              <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                <a className="btn" href={`/campanas/${id}/brief/editar`}>
                  Abrir el editor
                </a>
                {(preguntasPendientes > 0 || ultima.status === 'local_questions') && (
                  <a className="btn" href={`/campanas/${id}/preguntas`}>
                    Preguntas locales{preguntasPendientes > 0 ? ` (${preguntasPendientes})` : ''}
                  </a>
                )}
                {ultima.status === 'processing_failed' && (
                  <form action={reintentarExtraccionDeBrief}>
                    <input type="hidden" name="campaignId" value={id} />
                    <input type="hidden" name="versionId" value={ultima.id} />
                    <button className="btn pri" type="submit">
                      Reintentar extracción
                    </button>
                  </form>
                )}
                {transicionesPosibles
                  .filter((t) => t in TEXTO_DEL_BOTON)
                  .map((to) => (
                    <form action={transicionarBriefDeCampana} key={to}>
                      <input type="hidden" name="campaignId" value={id} />
                      <input type="hidden" name="versionId" value={ultima.id} />
                      <input type="hidden" name="to" value={to} />
                      <button className="btn pri" type="submit">
                        {TEXTO_DEL_BOTON[to]}
                      </button>
                    </form>
                  ))}
                {transicionesPosibles.includes('internal_changes_requested') && (
                  <FormularioSolicitarCambiosInternos versionId={ultima.id} campaignId={id} />
                )}
                {ultima.status === 'approved' && (
                  <form action={crearVersionHijaDeCampana}>
                    <input type="hidden" name="campaignId" value={id} />
                    <input type="hidden" name="versionId" value={ultima.id} />
                    <button className="btn" type="submit">
                      Crear nueva revisión
                    </button>
                  </form>
                )}
              </div>
            </div>

            <TablaCampos campos={listaCampos} campaignId={id} versionId={ultima.id} editable />
          </>
        )}

        {listaVersiones.length > 1 && (
          <div className="card">
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
                      <span className="pill">{ESTADO_EN_ESPANOL[v.status as BriefStatus] ?? v.status}</span>
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
      </main>
    </>
  );
}
