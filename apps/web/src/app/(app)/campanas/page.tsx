import { redirect } from 'next/navigation';
import { listCampaigns, listarPreguntas } from '@tcl-kol-os/db';
import { currentUser } from '@/lib/session';
import { TablaCampanas } from './TablaCampanas';

export const dynamic = 'force-dynamic';

/**
 * UI-03 · Lista de campañas, con próximas acciones reales al lado (solo las
 * de la organización del usuario, E2-4). "Next actions" del mockup de
 * referencia se deriva de preguntas críticas pendientes — no es una entidad
 * nueva ni un dato inventado.
 */
export default async function CampanasPage() {
  const user = await currentUser();
  if (user === undefined) redirect('/login');

  const resultado = await listCampaigns(user);
  const campanas = resultado.ok ? resultado.value : [];

  const activas = campanas.filter((c) => c.status === 'activa').slice(0, 6);
  const proximasAcciones =
    user.role === 'cliente'
      ? []
      : (
          await Promise.all(
            activas.map(async (c) => {
              const preguntas = await listarPreguntas(user, c.id, { status: 'pendiente' });
              const criticas = preguntas.ok ? preguntas.value.filter((p) => p.criticidad === 'critico') : [];
              return criticas.length > 0 ? { campana: c, criticas: criticas.length } : undefined;
            }),
          )
        ).filter((x): x is { campana: (typeof activas)[number]; criticas: number } => x !== undefined);

  return (
    <div className="content">
      <div className="page-head">
        <div>
          <h1>Campañas</h1>
          <p className="sub">Organización: {user.organizationId.slice(0, 8)}…</p>
        </div>
        {user.role !== 'cliente' && (
          <a className="btn pri" href="/campanas/nueva">
            + Nueva campaña
          </a>
        )}
      </div>

      <div className="grid-2">
        <div className="card" style={{ padding: 18 }}>
          {!resultado.ok ? (
            <div className="aviso error">
              <strong>Sin acceso</strong>
              {resultado.error.message}
            </div>
          ) : campanas.length === 0 ? (
            <p className="vacio">
              No hay campañas visibles para tu rol.
              {user.role === 'cliente' && ' Verás las campañas cuando se te compartan.'}
            </p>
          ) : (
            <TablaCampanas campanas={campanas} />
          )}
        </div>

        <aside className="side-stack">
          {user.role !== 'cliente' && (
            <div className="card" style={{ padding: 18 }}>
              <h3 className="section-title">Próximas acciones</h3>
              {proximasAcciones.length === 0 ? (
                <p className="sub" style={{ margin: 0 }}>
                  Sin preguntas críticas pendientes en tus campañas activas.
                </p>
              ) : (
                <div className="action-list">
                  {proximasAcciones.map(({ campana, criticas }) => (
                    <div className="action-row primary" key={campana.id}>
                      <div className="action-ico">?</div>
                      <a href={`/campanas/${campana.id}/brief/editar?panel=preguntas`}>
                        <b>
                          {criticas} pregunta{criticas > 1 ? 's' : ''} crítica{criticas > 1 ? 's' : ''}{' '}
                          pendiente{criticas > 1 ? 's' : ''}
                        </b>
                        <span className="detalle">{campana.name}</span>
                      </a>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
