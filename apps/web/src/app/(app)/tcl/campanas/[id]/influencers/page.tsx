import { obtenerInfluencersParaTcl } from '@tcl-kol-os/db';
import { cargarCampanaTcl, valorOr404 } from '@/lib/tcl-server';
import {
  ETIQUETA_DE_ETAPA,
  ETIQUETA_DE_GUION,
  ETIQUETA_DE_PRODUCTO_RECIBIDO,
  ETIQUETA_DE_ESTADO_DE_KPI,
  nombreDeProducto,
  tonoDeEtapa,
  tonoDeGuion,
} from '@/lib/tcl-ui';
import { CabeceraTcl, PildoraTcl, VacioTcl } from '../../../CabeceraTcl';

export const dynamic = 'force-dynamic';

export default async function TclInfluencersPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, campana } = await cargarCampanaTcl(id);
  const lista = valorOr404(await obtenerInfluencersParaTcl(user, campana.id));

  return (
    <div className="content content-wide ui-enter" data-testid="tcl-influencers">
      <CabeceraTcl campana={campana} activa="influencers" titulo="Influencers" />
      {lista.length === 0 ? (
        <VacioTcl
          titulo="Sin influencers activos"
          texto="Cuando haya influencers en la campaña aparecerán aquí."
        />
      ) : (
        <div className="table-shell">
          <table>
            <caption className="eyebrow">Influencers activos ({lista.length})</caption>
            <thead>
              <tr>
                <th scope="col">Influencer</th>
                <th scope="col">Cuentas</th>
                <th scope="col">Productos</th>
                <th scope="col">Etapa</th>
                <th scope="col">Producto recibido</th>
                <th scope="col">Guion</th>
                <th scope="col">KPI</th>
              </tr>
            </thead>
            <tbody>
              {lista.map((i) => (
                <tr key={i.participacionId} data-testid="fila-influencer">
                  <th scope="row">{i.nombreVisible ?? 'Influencer'}</th>
                  <td>
                    {i.cuentas.length === 0
                      ? '—'
                      : i.cuentas
                          .map(
                            (c) =>
                              `${c.plataforma}${c.handle === null ? '' : ` @${c.handle.replace(/^@/u, '')}`}`,
                          )
                          .join(', ')}
                  </td>
                  <td>
                    {i.productos.length === 0
                      ? '—'
                      : i.productos.map((p) => nombreDeProducto(p) ?? 'Producto').join(', ')}
                  </td>
                  <td>
                    <PildoraTcl tono={tonoDeEtapa(i.etapa)}>{ETIQUETA_DE_ETAPA[i.etapa]}</PildoraTcl>
                  </td>
                  <td>{ETIQUETA_DE_PRODUCTO_RECIBIDO[i.productoRecibido]}</td>
                  <td>
                    <PildoraTcl tono={tonoDeGuion(i.guion.estado)}>
                      {ETIQUETA_DE_GUION[i.guion.estado]}
                    </PildoraTcl>{' '}
                    ({i.guion.aprobados} de {i.guion.total})
                  </td>
                  <td>
                    {i.kpis.length === 0
                      ? '—'
                      : `${i.kpis.filter((k) => k.estado === 'cumplido').length} de ${i.kpis.length} ${ETIQUETA_DE_ESTADO_DE_KPI.cumplido.toLowerCase()}s`}
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
