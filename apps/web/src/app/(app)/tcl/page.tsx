import { listarCampanasParaTcl } from '@tcl-kol-os/db';
import { usuarioDeTcl } from '@/lib/tcl-guard';
import { valorOr404 } from '@/lib/tcl-server';
import { rutaDeCampanaTcl } from '@/lib/tcl-rutas';
import { ETIQUETA_DE_ESTADO_DE_CAMPANA, coincideConBusqueda, formatearRango } from '@/lib/tcl-ui';
import { PildoraTcl, VacioTcl } from './CabeceraTcl';

export const dynamic = 'force-dynamic';

/** Lista de campañas visibles para TCL (proyección de solo lectura). */
export default async function TclCampanasPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const user = await usuarioDeTcl();
  const { q } = await searchParams;
  const todas = valorOr404(await listarCampanasParaTcl(user));
  const consulta = typeof q === 'string' ? q.slice(0, 100) : '';
  const visibles = todas.filter((c) => coincideConBusqueda(c, consulta));

  return (
    <div className="content content-wide ui-enter" data-testid="tcl-lista">
      <div className="page-head page-head-spacious">
        <div>
          <div className="eyebrow">TCL KOL OS</div>
          <h1>Campañas</h1>
          <p className="sub">Las campañas que SmartPR comparte contigo, en modo de solo lectura.</p>
        </div>
      </div>

      {todas.length === 0 ? (
        <VacioTcl
          titulo="Todavía no hay campañas compartidas"
          texto="Cuando SmartPR comparta una campaña contigo, aparecerá aquí."
        />
      ) : visibles.length === 0 ? (
        <VacioTcl titulo="Ninguna campaña coincide" texto="Prueba con otro texto de búsqueda." />
      ) : (
        <div className="table-shell">
          <table className="campaigns-table">
            <caption className="eyebrow">
              Campañas compartidas ({visibles.length} de {todas.length})
            </caption>
            <thead>
              <tr>
                <th scope="col">Campaña</th>
                <th scope="col">Mercado</th>
                <th scope="col">Categoría</th>
                <th scope="col">Fechas</th>
                <th scope="col">Estado</th>
              </tr>
            </thead>
            <tbody>
              {visibles.map((c) => (
                <tr key={c.id}>
                  <th scope="row">
                    <a href={rutaDeCampanaTcl(c.id)}>{c.nombre ?? 'Campaña'}</a>
                  </th>
                  <td>{c.mercado ?? '—'}</td>
                  <td>{c.categoria ?? '—'}</td>
                  <td>{formatearRango(c.fechaInicio, c.fechaFin)}</td>
                  <td>
                    <PildoraTcl tono={c.estado === 'en_curso' ? 'ok' : 'neutro'}>
                      {ETIQUETA_DE_ESTADO_DE_CAMPANA[c.estado]}
                    </PildoraTcl>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
