import { notFound, redirect } from 'next/navigation';
import { getCampaign, listarPreguntas, versionesDelBrief } from '@tcl-kol-os/db';
import { Encabezado } from '@/components/Encabezado';
import { currentUser } from '@/lib/session';
import { archivarCampana, crearBriefManualDeCampana } from '@/lib/actions';

export const dynamic = 'force-dynamic';

/**
 * UI-05 · Detalle de campaña.
 *
 * Una campaña de otra organización llega aquí como 404, igual que una que no
 * existe. Es deliberado: distinguirlas revelaría que el recurso existe (S-01).
 */
export default async function DetalleCampanaPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await currentUser();
  if (user === undefined) redirect('/login');

  const { id } = await params;
  const { error } = await searchParams;

  const resultado = await getCampaign(user, id);
  if (!resultado.ok) notFound();

  const { campaign, productos, avisoPresupuesto } = resultado.value;

  const versiones = await versionesDelBrief(user, id);
  const versionActual = versiones.ok ? versiones.value[0] : undefined;

  const preguntas = await listarPreguntas(user, id, { status: 'pendiente' });
  const preguntasCriticasPendientes = preguntas.ok
    ? preguntas.value.filter((p) => p.criticidad === 'critico').length
    : 0;

  return (
    <>
      <Encabezado user={user} />
      <main>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
          <h1>{campaign.name}</h1>
          <span className={`pill ${campaign.status === 'activa' ? 'ok' : ''}`}>{campaign.status}</span>
        </div>
        <p className="sub">
          {campaign.category ?? 'Sin categoría'} · {campaign.market} · responsable {campaign.owner_name}
        </p>

        {error === 'no_permitido' && (
          <div className="aviso error">
            <strong>Acción no permitida</strong>
            Tu rol no puede ejecutar esa acción sobre esta campaña.
          </div>
        )}
        {error !== undefined && error !== 'no_permitido' && (
          <div className="aviso error">
            <strong>No se pudo completar la acción</strong>
            {decodeURIComponent(error)}
          </div>
        )}

        {avisoPresupuesto !== undefined && (
          <div className="aviso">
            <strong>Revisar el reparto de presupuesto</strong>
            {avisoPresupuesto} Puede ser deliberado; se registra tal como se declaró.
          </div>
        )}

        <div className="card">
          <h2>Productos ({productos.length})</h2>
          <table>
            <thead>
              <tr>
                <th>Producto</th>
                <th>Categoría</th>
                <th>Rol</th>
                <th>Prioridad</th>
                <th>% presupuesto</th>
              </tr>
            </thead>
            <tbody>
              {productos.map((p) => (
                <tr key={p.id}>
                  <td style={{ fontWeight: 600 }}>{p.model}</td>
                  <td>{p.category}</td>
                  <td>
                    <span className={`pill ${p.rol === 'flagship' ? 'info' : ''}`}>{p.rol}</span>
                  </td>
                  <td>{p.prioridad}</td>
                  <td>
                    {p.participacion_presupuesto === null
                      ? '—'
                      : `${Math.round(Number(p.participacion_presupuesto) * 100)}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
            <h2 style={{ margin: 0 }}>Fuentes</h2>
            <a className="btn" href={`/campanas/${campaign.id}/fuentes`}>
              Ver y cargar fuentes
            </a>
          </div>
          <p className="sub" style={{ margin: 0 }}>
            PPT de TCL China, fichas técnicas y briefs del cliente: el material del que sale el brief.
          </p>
        </div>

        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
            <h2 style={{ margin: 0 }}>Brief</h2>
            {versionActual !== undefined && (
              <a className="btn pri" href={`/campanas/${campaign.id}/brief`}>
                Ver el brief ({versionActual.status})
              </a>
            )}
          </div>

          {preguntasCriticasPendientes > 0 && (
            <div className="aviso error" style={{ marginBottom: 12 }}>
              <strong>{preguntasCriticasPendientes} pregunta(s) crítica(s) pendiente(s)</strong>
              <a href={`/campanas/${campaign.id}/preguntas?status=pendiente`}>Ver y responder →</a>
            </div>
          )}

          {versionActual === undefined ? (
            <>
              <p className="sub" style={{ marginTop: 0 }}>
                Todavía no hay ninguna versión. Cargue fuentes y extraiga, o empiece el brief a mano — la
                asistencia de IA nunca es requisito para avanzar.
              </p>
              <div className="row" style={{ gap: 8 }}>
                <a className="btn" href={`/campanas/${campaign.id}/fuentes`}>
                  Ir a fuentes →
                </a>
                {user.role !== 'cliente' && (
                  <form action={crearBriefManualDeCampana}>
                    <input type="hidden" name="campaignId" value={campaign.id} />
                    <button className="btn pri" type="submit">
                      Empezar el brief a mano
                    </button>
                  </form>
                )}
              </div>
            </>
          ) : (
            <p className="sub" style={{ margin: 0 }}>
              Versión {versionActual.version} · estado <span className="pill">{versionActual.status}</span>
            </p>
          )}
        </div>

        <div className="card">
          <h2>Datos</h2>
          <table>
            <tbody>
              <tr>
                <td style={{ color: 'var(--muted)', width: 180 }}>Identificador</td>
                <td className="mono">{campaign.id}</td>
              </tr>
              <tr>
                <td style={{ color: 'var(--muted)' }}>Fechas</td>
                <td>
                  {campaign.start_date === null
                    ? '—'
                    : `${new Date(campaign.start_date).toLocaleDateString('es-CO')} → ${
                        campaign.end_date === null
                          ? '…'
                          : new Date(campaign.end_date).toLocaleDateString('es-CO')
                      }`}
                </td>
              </tr>
              <tr>
                <td style={{ color: 'var(--muted)' }}>Confidencialidad</td>
                <td>
                  <span className="pill">{campaign.confidentiality_level}</span>{' '}
                  <span className="pill">visibilidad: {campaign.visibility}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        {campaign.status === 'activa' && (
          <form action={archivarCampana}>
            <input type="hidden" name="id" value={campaign.id} />
            <button className="btn" type="submit">
              Archivar campaña
            </button>
          </form>
        )}
      </main>
    </>
  );
}
