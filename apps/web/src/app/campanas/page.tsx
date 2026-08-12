import { redirect } from 'next/navigation';
import { listCampaigns } from '@tcl-kol-os/db';
import { Encabezado } from '@/components/Encabezado';
import { currentUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

/** UI-03 · Lista de campañas. Solo las de la organización del usuario (E2-4). */
export default async function CampanasPage() {
  const user = await currentUser();
  if (user === undefined) redirect('/login');

  const resultado = await listCampaigns(user);

  return (
    <>
      <Encabezado user={user} />
      <main>
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 4 }}>
          <h1>Campañas</h1>
          {user.role !== 'cliente' && (
            <a className="btn pri" href="/campanas/nueva">
              + Nueva campaña
            </a>
          )}
        </div>
        <p className="sub">Organización: {user.organizationId.slice(0, 8)}…</p>

        {!resultado.ok ? (
          <div className="aviso error">
            <strong>Sin acceso</strong>
            {resultado.error.message}
          </div>
        ) : resultado.value.length === 0 ? (
          <div className="card">
            <p className="vacio">
              No hay campañas visibles para tu rol.
              {user.role === 'cliente' && ' Verás las campañas cuando se te compartan.'}
            </p>
          </div>
        ) : (
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>Campaña</th>
                  <th>Categoría</th>
                  <th>Responsable</th>
                  <th>Fechas</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                {resultado.value.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <a href={`/campanas/${c.id}`} style={{ fontWeight: 600 }}>
                        {c.name}
                      </a>
                    </td>
                    <td>{c.category ?? '—'}</td>
                    <td>{c.owner_name}</td>
                    <td style={{ color: 'var(--muted)', fontSize: 13 }}>
                      {c.start_date === null
                        ? '—'
                        : `${new Date(c.start_date).toLocaleDateString('es-CO')} → ${
                            c.end_date === null ? '…' : new Date(c.end_date).toLocaleDateString('es-CO')
                          }`}
                    </td>
                    <td>
                      <span className={`pill ${c.status === 'activa' ? 'ok' : ''}`}>{c.status}</span>
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
