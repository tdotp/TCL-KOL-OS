import { obtenerKpisParaTcl } from '@tcl-kol-os/db';
import { cargarCampanaTcl, valorOr404 } from '@/lib/tcl-server';
import {
  ETIQUETA_DE_ESTADO_DE_KPI,
  etiquetaDeComparador,
  etiquetaDeMetrica,
  formatearCumplimiento,
  formatearFecha,
  formatearValorDeKpi,
  tonoDeKpi,
} from '@/lib/tcl-ui';
import { CabeceraTcl, PildoraTcl, VacioTcl } from '../../../CabeceraTcl';

export const dynamic = 'force-dynamic';

export default async function TclKpiPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, campana } = await cargarCampanaTcl(id);
  const lista = valorOr404(await obtenerKpisParaTcl(user, campana.id));
  const filas = lista.flatMap((p) => p.kpis.map((k) => ({ p, k })));

  return (
    <div className="content content-wide ui-enter" data-testid="tcl-kpi">
      <CabeceraTcl
        campana={campana}
        activa="kpi"
        titulo="KPI"
        descripcion="Objetivos acordados y resultados medidos."
      />
      {filas.length === 0 ? (
        <VacioTcl titulo="Sin KPI definidos" texto="Cuando se acuerden objetivos de KPI aparecerán aquí." />
      ) : (
        <div className="table-shell">
          <table>
            <caption className="eyebrow">Objetivos y resultados ({filas.length})</caption>
            <thead>
              <tr>
                <th scope="col">Influencer</th>
                <th scope="col">Métrica</th>
                <th scope="col">Plataforma</th>
                <th scope="col">Objetivo</th>
                <th scope="col">Resultado</th>
                <th scope="col">Cumplimiento</th>
                <th scope="col">Estado</th>
                <th scope="col">Fecha</th>
              </tr>
            </thead>
            <tbody>
              {filas.map(({ p, k }, i) => (
                <tr
                  key={`${p.participacionId}-${k.metrica}-${k.plataforma ?? ''}-${i}`}
                  data-testid="fila-kpi"
                >
                  <th scope="row">{p.nombreVisible ?? 'Influencer'}</th>
                  <td>{etiquetaDeMetrica(k.metrica)}</td>
                  <td>{k.plataforma ?? 'Todas'}</td>
                  <td>
                    {etiquetaDeComparador(k.comparador)} {formatearValorDeKpi(k.objetivo, k.unidad)}
                  </td>
                  <td>{formatearValorDeKpi(k.resultado, k.unidad)}</td>
                  <td>{formatearCumplimiento(k.cumplimiento)}</td>
                  <td>
                    <PildoraTcl tono={tonoDeKpi(k.estado)}>{ETIQUETA_DE_ESTADO_DE_KPI[k.estado]}</PildoraTcl>
                  </td>
                  <td>{formatearFecha(k.fecha)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
