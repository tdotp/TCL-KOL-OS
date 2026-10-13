import { redirect } from 'next/navigation';
import { roleCan } from '@tcl-kol-os/domain';
import { actividadReciente, listCampaigns, listarPreguntas } from '@tcl-kol-os/db';
import { currentUser } from '@/lib/session';
import { desviarClienteDeRutaLegada } from '@/lib/tcl-guard';
import { TablaCampanas } from './TablaCampanas';

export const dynamic = 'force-dynamic';

function accionLegible(action: string): string {
  const conocidas: Record<string, string> = {
    'campaign.create': 'Creó una campaña',
    'campaign.archive': 'Archivó una campaña',
    'source.upload': 'Cargó una fuente',
    'source.retry': 'Reintentó una fuente',
    'brief.transition': 'Actualizó el estado de un brief',
    'brief.field.correct': 'Corrigió un campo del brief',
    'brief.field.confirm': 'Confirmó un campo del brief',
    'comment.create': 'Añadió un comentario',
    'question.answer': 'Respondió una pregunta',
  };
  return conocidas[action] ?? action.replaceAll('.', ' · ');
}

/** Lista de campañas + trabajo operativo derivado exclusivamente de datos reales. */
export default async function CampanasPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const user = await currentUser();
  const { q } = await searchParams;
  if (user === undefined) redirect('/login');
  // Cliente TCL: a su equivalente de `/tcl` (o 404) ANTES de cualquier cargador interno.
  desviarClienteDeRutaLegada(user, { tipo: 'lista' });

  const resultado = await listCampaigns(user);
  const campanas = resultado.ok ? resultado.value : [];
  // La actividad es auditoría: solo con `audit:read`; y sin `finance:read` no incluye pagos, PII ni acuerdos.
  const actividad = await actividadReciente(user);

  const activas = campanas.filter((c) => c.status === 'activa').slice(0, 6);
  const proximasAcciones = !roleCan(user.role, 'brief:read')
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
    <div className="content content-wide ui-enter">
      <div className="page-head page-head-spacious">
        <div>
          <div className="eyebrow">Workspace</div>
          <h1>Campañas</h1>
          <p className="sub">Administra y sigue el avance de todas las campañas KOL visibles para tu rol.</p>
        </div>
        {roleCan(user.role, 'campaign:create') && (
          <a className="btn pri" href="/campanas/nueva">
            <span className="btn-plus">＋</span> Nueva campaña
          </a>
        )}
      </div>

      <div className="grid-2 campaigns-layout">
        <section className="card campaigns-card">
          {!resultado.ok ? (
            <div className="aviso error">
              <strong>Sin acceso</strong>
              {resultado.error.message}
            </div>
          ) : campanas.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-mark" aria-hidden="true">
                ▤
              </div>
              <h2>No hay campañas todavía</h2>
              <p>
                {user.role === 'cliente'
                  ? 'Verás las campañas cuando se compartan contigo.'
                  : 'Crea la primera campaña para empezar a organizar fuentes, preguntas y brief.'}
              </p>
              {roleCan(user.role, 'campaign:create') && (
                <a className="btn pri" href="/campanas/nueva">
                  Crear campaña
                </a>
              )}
            </div>
          ) : (
            <TablaCampanas campanas={campanas} initialSearch={q ?? ''} />
          )}
        </section>

        <aside className="side-stack campaigns-side">
          {roleCan(user.role, 'brief:read') && (
            <section className="card side-card">
              <div className="side-card-head">
                <div>
                  <div className="eyebrow">Prioridad</div>
                  <h3 className="section-title">Próximas acciones</h3>
                </div>
              </div>
              {proximasAcciones.length === 0 ? (
                <div className="quiet-state">
                  <span className="status-mark status-mark-ok" />
                  <div>
                    <strong>Todo al día</strong>
                    <p>Sin preguntas críticas pendientes en campañas activas.</p>
                  </div>
                </div>
              ) : (
                <div className="action-list">
                  {proximasAcciones.map(({ campana, criticas }) => (
                    <a
                      className="action-row action-row-link"
                      key={campana.id}
                      href={`/campanas/${campana.id}/brief/editar?panel=preguntas`}
                    >
                      <div className="action-ico">?</div>
                      <div className="action-copy">
                        <b>
                          {criticas} pregunta{criticas > 1 ? 's' : ''} crítica{criticas > 1 ? 's' : ''}
                        </b>
                        <span className="detalle">{campana.name}</span>
                      </div>
                      <span className="action-arrow">→</span>
                    </a>
                  ))}
                </div>
              )}
            </section>
          )}

          {actividad.length > 0 && (
            <section className="card side-card">
              <div className="side-card-head">
                <div>
                  <div className="eyebrow">Auditoría</div>
                  <h3 className="section-title">Actividad reciente</h3>
                </div>
              </div>
              <div className="activity-list">
                {actividad.map((a) => (
                  <div className="activity-item" key={a.id}>
                    <span className="activity-avatar">{(a.actor_name ?? 'S').slice(0, 2).toUpperCase()}</span>
                    <div>
                      <strong>{a.actor_name ?? 'Sistema'}</strong>
                      <p>{accionLegible(a.action)}</p>
                      <time>{new Date(a.created_at).toLocaleString('es-CO')}</time>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
