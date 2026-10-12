import { notFound, redirect } from 'next/navigation';
import { getCampaign, listSources, versionesDelBrief } from '@tcl-kol-os/db';
import type { BriefStatus } from '@tcl-kol-os/domain';
import { currentUser } from '@/lib/session';
import { desviarClienteDeRutaLegada } from '@/lib/tcl-guard';
import { ETAPAS, etapaDeStatus } from '@/lib/brief-ui';
import { monogramaColor, monogramaIniciales } from '@/lib/monograma';
import { FormularioFuente } from './FormularioFuente';
import { TablaFuentes } from './TablaFuentes';

export const dynamic = 'force-dynamic';

export default async function FuentesPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (user === undefined) redirect('/login');
  // Cliente TCL: a su equivalente de `/tcl` (o 404) ANTES de cualquier cargador interno.
  desviarClienteDeRutaLegada(user, { tipo: 'fuentes', id: (await params).id });

  const { id } = await params;
  const campana = await getCampaign(user, id);
  if (!campana.ok) notFound();

  const [fuentes, versiones] = await Promise.all([listSources(user, id), versionesDelBrief(user, id)]);
  const filas = fuentes.ok ? fuentes.value : [];
  const versionActual = versiones.ok ? versiones.value[0] : undefined;
  const etapaActual = etapaDeStatus(versionActual?.status as BriefStatus | undefined);
  const indiceEtapaActual = ETAPAS.findIndex((e) => e.id === etapaActual);

  const resumen = {
    procesado: filas.filter((f) => f.status === 'procesado').length,
    procesando: filas.filter((f) => f.status === 'procesando').length,
    pendiente: filas.filter((f) => f.status === 'pendiente').length,
    fallido: filas.filter((f) => f.status === 'fallido').length,
  };
  const total = filas.length;
  const procesadosPct = total === 0 ? 0 : Math.round((resumen.procesado / total) * 100);

  return (
    <div className="content content-wide ui-enter">
      <a className="back-link" href={`/campanas/${id}`}>← {campana.value.campaign.name}</a>

      <header className="campaign-header compact-campaign-header">
        <span className={`monogram lg ${monogramaColor(id)}`}>{monogramaIniciales(campana.value.campaign.name)}</span>
        <div className="campaign-heading-copy">
          <div className="campaign-kickers"><span className="status-dot ok">{campana.value.campaign.status}</span></div>
          <h1>{campana.value.campaign.name}</h1>
          <p>{campana.value.campaign.market} · {campana.value.campaign.category ?? 'Sin categoría'}</p>
        </div>
        <div className="campaign-header-actions">
          <a className="btn" href={`/campanas/${id}`}>Resumen</a>
          <a className="btn pri" href={`/campanas/${id}/brief`}>Abrir brief →</a>
        </div>
      </header>

      <nav className="campaign-context-nav" aria-label="Secciones de campaña">
        <a href={`/campanas/${id}`}>Resumen</a>
        <a className="active" href={`/campanas/${id}/fuentes`}>Fuentes <span>{filas.length}</span></a>
        <a href={`/campanas/${id}/brief`}>Brief</a>
        {user.role !== 'cliente' && <a href={`/campanas/${id}/brief/editar`}>Editar</a>}
      </nav>

      <div className="stepper campaign-stepper">
        {ETAPAS.map((etapa, i) => (
          <div key={etapa.id} className={`step ${i < indiceEtapaActual ? 'done' : i === 0 || i === indiceEtapaActual ? 'current' : ''}`}>
            <div className="step-num">{i < indiceEtapaActual ? '✓' : i + 1}</div>
            <div className="step-name">{etapa.nombre}</div>
          </div>
        ))}
      </div>

      <div className="sources-layout">
        <section>
          {user.role !== 'cliente' && <FormularioFuente campaignId={id} />}
        </section>
        <aside className="side-stack">
          <section className="card side-card sources-summary-card">
            <div className="eyebrow">Fuentes</div>
            <h3 className="section-title">Resumen</h3>
            <div className="source-summary-main">
              <div className="source-number"><strong>{total}</strong><span>archivos</span></div>
              <div className="source-progress-copy"><strong>{procesadosPct}%</strong><span>procesado</span></div>
            </div>
            <div className="progreso"><span style={{ width: `${procesadosPct}%` }} /></div>
            <div className="source-summary-lines">
              <span><i className="status-mark status-mark-ok" />{resumen.procesado} procesados</span>
              <span><i className="status-mark status-mark-neutral" />{resumen.procesando} procesando</span>
              <span><i className="status-mark status-mark-neutral" />{resumen.pendiente} en cola</span>
              {resumen.fallido > 0 && <span><i className="status-mark status-mark-bad" />{resumen.fallido} fallidos</span>}
            </div>
          </section>

          {(resumen.procesando > 0 || resumen.pendiente > 0 || resumen.fallido > 0) && (
            <section className="card side-card">
              <div className="eyebrow">Atención</div>
              <h3 className="section-title">Próximas acciones</h3>
              <div className="action-list">
                {resumen.procesando + resumen.pendiente > 0 && (
                  <div className="action-row"><div className="action-ico">◷</div><div className="action-copy"><b>{resumen.procesando + resumen.pendiente} en proceso</b><span className="detalle">La página se actualiza automáticamente.</span></div></div>
                )}
                {resumen.fallido > 0 && (
                  <div className="action-row"><div className="action-ico">!</div><div className="action-copy"><b>{resumen.fallido} con error</b><span className="detalle">Revisa el detalle y vuelve a intentar.</span></div></div>
                )}
              </div>
            </section>
          )}
        </aside>
      </div>

      <TablaFuentes campaignId={id} fuentes={filas} />
    </div>
  );
}
