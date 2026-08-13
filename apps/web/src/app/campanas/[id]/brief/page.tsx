import { notFound, redirect } from 'next/navigation';
import { getCampaign, verCamposDeVersion, versionesDelBrief } from '@tcl-kol-os/db';
import { Encabezado } from '@/components/Encabezado';
import { currentUser } from '@/lib/session';
import { BotonExtraer } from './BotonExtraer';
import { TablaCampos } from './TablaCampos';

export const dynamic = 'force-dynamic';

/** Los estados del brief, en el idioma en que se trabaja (§6, glosario D0-06). */
const ESTADO_EN_ESPANOL: Record<string, string> = {
  draft: 'borrador',
  processing: 'procesando',
  internal_review: 'revisión interna',
  approved: 'aprobado',
  sent_to_client: 'enviado al cliente',
  client_review: 'revisión del cliente',
  changes_requested: 'cambios solicitados',
  client_approved: 'aprobado por el cliente',
  archived: 'archivado',
  cancelled: 'cancelado',
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
 * Lo que esta pantalla deja explícito, y es lo que la hace útil:
 *   · qué campos faltan, en vez de mostrar solo lo que se encontró;
 *   · cuáles son críticos, para saber qué bloquea la aprobación;
 *   · de dónde salió cada afirmación, con archivo, ubicación y cita.
 */
export default async function BriefPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (user === undefined) redirect('/login');

  const { id } = await params;

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

        {user.role !== 'cliente' && <BotonExtraer campaignId={id} />}

        {ultima === undefined ? (
          <div className="card">
            <h2>Todavía no hay ninguna versión</h2>
            <p className="sub">
              Cargue fuentes en la campaña y ejecute la extracción, o empiece el brief a mano: la
              asistencia de IA nunca es requisito para avanzar.
            </p>
            <p style={{ marginTop: 12 }}>
              <a href={`/campanas/${id}/fuentes`}>Ir a fuentes →</a>
            </p>
          </div>
        ) : (
          <>
            <div className="card">
              <h2>
                Versión {ultima.version}{' '}
                <span className={`pill ${ultima.status === 'approved' ? 'ok' : 'info'}`}>
                  {ESTADO_EN_ESPANOL[ultima.status] ?? ultima.status}
                </span>
              </h2>
              <p className="sub">
                {encontrados.length} campo(s) con dato · {criticosFaltantes.length} crítico(s)
                pendiente(s) · {conflictos.length} conflicto(s)
                {ultima.modelo !== null && (
                  <>
                    {' '}
                    · extraído con <code>{ultima.modelo}</code>
                    {ultima.costoUsd !== null && ` (USD ${ultima.costoUsd.toFixed(4)})`}
                  </>
                )}
              </p>

              {criticosFaltantes.length > 0 && (
                <p className="sub" style={{ marginTop: 10 }}>
                  Los campos críticos que siguen sin dato impiden aprobar el brief. No se rellenan
                  solos: hay que buscarlos en la fuente o preguntarlos.
                </p>
              )}
            </div>

            <TablaCampos campos={listaCampos} campaignId={id} />
          </>
        )}

        {listaVersiones.length > 1 && (
          <div className="card">
            <h2>Versiones anteriores</h2>
            <table>
              <thead>
                <tr>
                  <th style={{ width: 80 }}>Versión</th>
                  <th style={{ width: 120 }}>Estado</th>
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
                      <span className="pill">{ESTADO_EN_ESPANOL[v.status] ?? v.status}</span>
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
