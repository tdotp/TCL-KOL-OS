import { redirect } from 'next/navigation';
import { listAudit, getPool, listCampaigns } from '@tcl-kol-os/db';
import { currentUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

/** UI-02 · Inicio operativo: qué está pendiente, sin tener que buscarlo. */
export default async function Home() {
  const user = await currentUser();
  if (user === undefined) redirect('/login');

  const campanas = await listCampaigns(user);
  const recientes = campanas.ok ? campanas.value.slice(0, 5) : [];
  const actividad = await listAudit(getPool(), user.organizationId, 6);

  return (
    <div className="content">
      <div className="page-head">
        <div>
          <h1>Inicio</h1>
          <p className="sub">{campanas.ok ? campanas.value.length : 0} campaña(s) en tu organización.</p>
        </div>
      </div>

      <div className="card">
        <h2>Campañas recientes</h2>
        {recientes.length === 0 ? (
          <p className="vacio">
            Todavía no hay campañas. <a href="/campanas/nueva">Crear la primera</a>.
          </p>
        ) : (
          <table>
            <tbody>
              {recientes.map((c) => (
                <tr key={c.id}>
                  <td>
                    <a href={`/campanas/${c.id}`}>{c.name}</a>
                  </td>
                  <td>{c.category ?? '—'}</td>
                  <td>
                    <span className={`pill ${c.status === 'activa' ? 'ok' : 'neutro'}`}>{c.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>Actividad</h2>
        {actividad.length === 0 ? (
          <p className="vacio">Sin actividad registrada.</p>
        ) : (
          <table>
            <tbody>
              {actividad.map((a) => (
                <tr key={a.id}>
                  <td className="mono">{a.action}</td>
                  <td>{a.actor_name ?? '—'}</td>
                  <td style={{ color: 'var(--muted)', fontSize: 13 }}>
                    {new Date(a.created_at).toLocaleString('es-CO')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
