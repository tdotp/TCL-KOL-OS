import { notFound, redirect } from 'next/navigation';
import { getCampaign, listarPreguntas, verCamposDeVersion, versionesDelBrief } from '@tcl-kol-os/db';
import { allowedTransitions, type BriefStatus } from '@tcl-kol-os/domain';
import { Encabezado } from '@/components/Encabezado';
import { currentUser } from '@/lib/session';
import { crearBriefManualDeCampana, reintentarExtraccionDeBrief, transicionarBriefDeCampana } from '@/lib/actions';
import { BotonExtraer } from './BotonExtraer';
import { TablaCampos } from './TablaCampos';

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

  const criticosFaltantes = listaCampos.filter(
    (c) => c.criticidad === 'critico' && c.status !== 'found',
  );
  const conflictos = listaCampos.filter((c) => c.status === 'conflict');
  const encontrados = listaCampos.filter((c) => c.status === 'found');
  const sinRevisar = listaCampos.filter((c) => c.status === 'found' && c.reviewStatus === 'pending');

  const preguntas = ultima === undefined ? undefined : await listarPreguntas(user, id, { status: 'pendiente' });
  const preguntasPendientes = preguntas?.ok ? preguntas.value.length : 0;
  const preguntasCriticasPendientes = preguntas?.ok
    ? preguntas.value.filter((p) => p.criticidad === 'critico').length
    : 0;

  const transicionesPosibles =
    ultima !== undefined ? allowedTransitions(ultima.status as BriefStatus, user).filter((t) => t !== 'cancelled') : [];

  return (
    <>
      <Encabezado user={user} />
      <main>
        <p className="sub" style={{ marginBottom: 4 }}>
          <a href={`/campanas/${id}`}>← {campana.value.campaign.name}</a>
        </p>
        <h1>Brief</h1>
        <p className="sub">
          Campos propuestos a partir de las fuentes cargadas. Cada afirmación abre el documento,
          la ubicación y la frase exacta de donde salió.
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

        {user.role !== 'cliente' && ultima === undefined && <BotonExtraer campaignId={id} />}

        {ultima === undefined ? (
          <div className="card">
            <h2>Todavía no hay ninguna versión</h2>
            <p className="sub">
              Cargue fuentes en la campaña y ejecute la extracción, o empiece el brief a mano: la
              asistencia de IA nunca es requisito para avanzar.
            </p>
            <div className="row" style={{ gap: 8, marginTop: 12 }}>
              <a className="btn" href={`/campanas/${id}/fuentes`}>
                Ir a fuentes →
              </a>
              {user.role !== 'cliente' && (
                <form action={crearBriefManualDeCampana}>
                  <input type="hidden" name="campaignId" value={id} />
                  <button className="btn pri" type="submit">
                    Empezar el brief a mano
                  </button>
                </form>
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="card">
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <h2 style={{ margin: 0 }}>
                  Versión {ultima.version}{' '}
                  <span className={`pill ${ultima.status === 'approved' ? 'ok' : ultima.status === 'processing_failed' ? 'bad' : 'info'}`}>
                    {ESTADO_EN_ESPANOL[ultima.status as BriefStatus] ?? ultima.status}
                  </span>
                </h2>
                {user.role !== 'cliente' && <BotonExtraer campaignId={id} />}
              </div>
              <p className="sub">
                {encontrados.length} campo(s) con dato · {criticosFaltantes.length} crítico(s)
                pendiente(s) · {conflictos.length} conflicto(s) · {sinRevisar.length} sin confirmar
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
                {user.role !== 'cliente' && ultima.status === 'processing_failed' && (
                  <form action={reintentarExtraccionDeBrief}>
                    <input type="hidden" name="campaignId" value={id} />
                    <input type="hidden" name="versionId" value={ultima.id} />
                    <button className="btn pri" type="submit">
                      Reintentar extracción
                    </button>
                  </form>
                )}
                {user.role !== 'cliente' &&
                  transicionesPosibles
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
              </div>
            </div>

            <TablaCampos campos={listaCampos} campaignId={id} versionId={ultima.id} editable={user.role !== 'cliente'} />
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
