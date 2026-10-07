import { redirect } from 'next/navigation';
import { roleCan } from '@tcl-kol-os/domain';
import { listAudit, getPool, listCampaigns } from '@tcl-kol-os/db';
import { currentUser } from '@/lib/session';
import { monogramaColor, monogramaIniciales } from '@/lib/monograma';

export const dynamic = 'force-dynamic';

function accionLegible(action: string): string {
  return action.replaceAll('.', ' · ');
}

/** Inicio operativo: pocas señales, próximas rutas y actividad real. */
export default async function Home() {
  const user = await currentUser();
  if (user === undefined) redirect('/login');

  const campanas = await listCampaigns(user);
  const visibles = campanas.ok ? campanas.value : [];
  const recientes = visibles.slice(0, 5);
  // La actividad es auditoría: solo con `audit:read`; y sin `finance:read` no incluye pagos, PII ni acuerdos.
  const actividad = roleCan(user.role, 'audit:read')
    ? await listAudit(getPool(), user.organizationId, 6, { incluirOperativas: roleCan(user.role, 'finance:read') })
    : [];
  const activas = visibles.filter((c) => c.status === 'activa').length;

  return (
    <div className="content content-wide ui-enter">
      <div className="page-head page-head-spacious home-head">
        <div>
          <div className="eyebrow">TCL KOL OS</div>
          <h1>Inicio</h1>
          <p className="sub">Lo que está activo ahora, sin convertir el inicio en otro dashboard pesado.</p>
        </div>
        {user.role !== 'cliente' && <a className="btn pri" href="/campanas/nueva">＋ Nueva campaña</a>}
      </div>

      <div className="home-kpis">
        <div><span>Campañas visibles</span><strong>{visibles.length}</strong></div>
        <div><span>Activas</span><strong>{activas}</strong></div>
        <div><span>Rol actual</span><strong className="text-value">{user.role}</strong></div>
      </div>

      <div className="grid-2 home-layout">
        <section className="card home-campaigns-card">
          <div className="side-card-head">
            <div><div className="eyebrow">Trabajo reciente</div><h2 className="plain-heading">Campañas</h2></div>
            <a href="/campanas">Ver todas →</a>
          </div>
          {recientes.length === 0 ? (
            <div className="empty-state compact-empty"><h3>No hay campañas todavía</h3><p>Cuando haya campañas visibles aparecerán aquí.</p></div>
          ) : (
            <div className="home-campaign-list">
              {recientes.map((c) => (
                <a href={`/campanas/${c.id}`} key={c.id}>
                  <span className={`monogram ${monogramaColor(c.id)}`}>{monogramaIniciales(c.name)}</span>
                  <span><strong>{c.name}</strong><small>{c.market} · {c.category ?? 'Sin categoría'}</small></span>
                  <span className={`status-dot ${c.status === 'activa' ? 'ok' : ''}`}>{c.status}</span>
                  <b>→</b>
                </a>
              ))}
            </div>
          )}
        </section>

        <aside className="card side-card">
          <div className="side-card-head"><div><div className="eyebrow">Auditoría</div><h2 className="plain-heading">Actividad</h2></div></div>
          {actividad.length === 0 ? (
            <div className="quiet-state compact"><span className="status-mark status-mark-neutral" /><div><strong>Sin actividad reciente</strong><p>No hay eventos para mostrar.</p></div></div>
          ) : (
            <div className="activity-list">
              {actividad.map((a) => (
                <div className="activity-item" key={a.id}>
                  <span className="activity-avatar">{(a.actor_name ?? 'S').slice(0, 2).toUpperCase()}</span>
                  <div><strong>{a.actor_name ?? 'Sistema'}</strong><p>{accionLegible(a.action)}</p><time>{new Date(a.created_at).toLocaleString('es-CO')}</time></div>
                </div>
              ))}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
