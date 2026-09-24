import { notFound, redirect } from 'next/navigation';
import { getCampaign, listSources } from '@tcl-kol-os/db';
import { currentUser } from '@/lib/session';
import { FormularioFuente } from './FormularioFuente';
import { TablaFuentes } from './TablaFuentes';

export const dynamic = 'force-dynamic';

/**
 * UI-06 · Carga de fuentes y UI-07 · Estado de procesamiento.
 *
 * Van juntas a propósito: quien acaba de cargar un archivo quiere ver en qué va,
 * y separarlo en dos pantallas obligaría a navegar para saberlo.
 */
export default async function FuentesPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (user === undefined) redirect('/login');

  const { id } = await params;

  const campana = await getCampaign(user, id);
  if (!campana.ok) notFound();

  const fuentes = await listSources(user, id);
  const filas = fuentes.ok ? fuentes.value : [];

  const resumen = {
    procesado: filas.filter((f) => f.status === 'procesado').length,
    procesando: filas.filter((f) => f.status === 'procesando').length,
    pendiente: filas.filter((f) => f.status === 'pendiente').length,
    fallido: filas.filter((f) => f.status === 'fallido').length,
  };
  const total = filas.length;
  // Segmentos del donut en el mismo orden que la leyenda — porcentajes
  // acumulados reales, nunca aproximados a ojo.
  const segmentos: Array<[number, string]> = [
    [resumen.procesado, 'var(--ok)'],
    [resumen.procesando, 'var(--warn)'],
    [resumen.pendiente, 'var(--muted-soft)'],
    [resumen.fallido, 'var(--bad)'],
  ];
  let acumulado = 0;
  const stops = segmentos
    .map(([cantidad, color]) => {
      const desde = acumulado;
      acumulado += total === 0 ? 0 : (cantidad / total) * 100;
      return `${color} ${desde}% ${acumulado}%`;
    })
    .join(', ');

  return (
    <div className="content">
      <p className="sub" style={{ marginBottom: 4 }}>
        <a href={`/campanas/${id}`}>← {campana.value.campaign.name}</a>
      </p>
      <h1>Fuentes</h1>
      <p className="sub">
        El material que alimenta el brief: PPT de TCL China, fichas técnicas y briefs del cliente.
      </p>

      <div className="grid-2">
        <div>{user.role !== 'cliente' && <FormularioFuente campaignId={id} />}</div>
        <aside className="side-stack">
          <div className="card side-card">
            <h3 className="section-title">Resumen</h3>
            {filas.length === 0 ? (
              <p className="sub" style={{ margin: 0 }}>
                Todavía no hay fuentes cargadas.
              </p>
            ) : (
              <div className="row" style={{ gap: 18, alignItems: 'center' }}>
                <div className="ring" style={{ background: `conic-gradient(${stops})` }}>
                  <div>
                    <strong>{total}</strong>
                    <span>archivos</span>
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <span className="status-dot ok">{resumen.procesado} procesado(s)</span>
                  <span className="status-dot warn">{resumen.procesando} procesando</span>
                  <span className="status-dot">{resumen.pendiente} en cola</span>
                  {resumen.fallido > 0 && <span className="status-dot bad">{resumen.fallido} fallido(s)</span>}
                </div>
              </div>
            )}
          </div>
        </aside>
      </div>

      <TablaFuentes campaignId={id} fuentes={filas} />
    </div>
  );
}
