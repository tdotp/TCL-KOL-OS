import { rutaDeCampanaTcl, rutaDeExportTcl } from '@/lib/tcl-rutas';
import { cargarCampanaTcl } from '@/lib/tcl-server';
import { nombreDeProducto } from '@/lib/tcl-ui';
import { CabeceraTcl, VacioTcl } from '../../CabeceraTcl';

export const dynamic = 'force-dynamic';

/** Resumen de la campaña: conteos, productos, navegación de secciones y export de la misma proyección. */
export default async function TclResumenPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { campana } = await cargarCampanaTcl(id);
  const c = campana.conteos;

  return (
    <div className="content content-wide ui-enter" data-testid="tcl-resumen">
      <CabeceraTcl campana={campana} activa="resumen" titulo="Resumen de la campaña" />

      <section className="card" aria-labelledby="tcl-conteos">
        <h2 id="tcl-conteos">En números</h2>
        <dl className="home-kpis" data-testid="tcl-conteos">
          <div>
            <dt>Influencers activos</dt>
            <dd data-testid="conteo-influencers">{c.influencersActivos}</dd>
          </div>
          <div>
            <dt>Guiones aprobados</dt>
            <dd data-testid="conteo-guiones">
              {c.guionesAprobados} de {c.guionesTotales}
            </dd>
          </div>
          <div>
            <dt>KPI cumplidos</dt>
            <dd data-testid="conteo-kpi">
              {c.kpiCumplidos} de {c.kpiTotales}
            </dd>
          </div>
        </dl>
      </section>

      <section className="card" aria-labelledby="tcl-productos">
        <h2 id="tcl-productos">Productos</h2>
        {campana.productos.length === 0 ? (
          <p className="sub">La campaña aún no tiene productos asociados.</p>
        ) : (
          <ul data-testid="tcl-productos">
            {campana.productos.map((p, i) => (
              <li key={`${p.marca ?? ''}-${p.modelo ?? ''}-${i}`}>
                {nombreDeProducto(p) ?? 'Producto'}
                {p.categoria === null ? '' : ` · ${p.categoria}`}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card" aria-labelledby="tcl-secciones">
        <h2 id="tcl-secciones">Secciones</h2>
        <ul>
          <li>
            <a href={rutaDeCampanaTcl(campana.id, 'influencers')}>Influencers</a> — quiénes participan y cómo
            avanzan.
          </li>
          <li>
            <a href={rutaDeCampanaTcl(campana.id, 'contenido')}>Contenido</a> — guiones aprobados por
            entregable.
          </li>
          <li>
            <a href={rutaDeCampanaTcl(campana.id, 'operacion')}>Operación</a> — estado general de cada
            participación.
          </li>
          <li>
            <a href={rutaDeCampanaTcl(campana.id, 'kpi')}>KPI</a> — objetivos y resultados.
          </li>
          <li>
            <a href={rutaDeCampanaTcl(campana.id, 'documentos')}>Documentos</a> — material compartido contigo.
          </li>
          <li>
            <a href={rutaDeCampanaTcl(campana.id, 'brief')}>Brief</a> — la versión aprobada vigente.
          </li>
        </ul>
      </section>

      <section className="card" aria-labelledby="tcl-export">
        <h2 id="tcl-export">Exportar</h2>
        <p className="sub">Descarga exactamente lo que ves en estas pantallas.</p>
        <p>
          <a className="btn" href={rutaDeExportTcl(campana.id, 'csv')} data-testid="export-csv">
            Descargar CSV
          </a>{' '}
          <a className="btn" href={rutaDeExportTcl(campana.id, 'json')} data-testid="export-json">
            Descargar JSON
          </a>
        </p>
      </section>

      {campana.conteos.influencersActivos === 0 && campana.productos.length === 0 ? (
        <VacioTcl
          titulo="Campaña en preparación"
          texto="Todavía no hay influencers ni productos para mostrar."
        />
      ) : null}
    </div>
  );
}
