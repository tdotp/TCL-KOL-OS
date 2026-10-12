import { obtenerOperacionParaTcl } from '@tcl-kol-os/db';
import { cargarCampanaTcl, valorOr404 } from '@/lib/tcl-server';
import {
  ETIQUETA_DE_ETAPA,
  ETIQUETA_DE_GUION,
  ETIQUETA_DE_PRODUCTO_RECIBIDO,
  tonoDeEtapa,
  tonoDeGuion,
} from '@/lib/tcl-ui';
import { CabeceraTcl, PildoraTcl, VacioTcl } from '../../../CabeceraTcl';

export const dynamic = 'force-dynamic';

/** Estado seguro por participación: etapa, producto recibido y guion. Producción y publicación aún no existen. */
export default async function TclOperacionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, campana } = await cargarCampanaTcl(id);
  const lista = valorOr404(await obtenerOperacionParaTcl(user, campana.id));

  return (
    <div className="content content-wide ui-enter" data-testid="tcl-operacion">
      <CabeceraTcl
        campana={campana}
        activa="operacion"
        titulo="Operación"
        descripcion="Estado general de cada participación."
      />
      {lista.length === 0 ? (
        <VacioTcl
          titulo="Sin participaciones"
          texto="Cuando haya influencers en la campaña verás su estado aquí."
        />
      ) : (
        <div className="table-shell">
          <table>
            <caption className="eyebrow">Estado por participación ({lista.length})</caption>
            <thead>
              <tr>
                <th scope="col">Influencer</th>
                <th scope="col">Etapa</th>
                <th scope="col">Producto recibido</th>
                <th scope="col">Guion</th>
                <th scope="col">Producción</th>
                <th scope="col">Publicación</th>
              </tr>
            </thead>
            <tbody>
              {lista.map((o) => (
                <tr key={o.participacionId} data-testid="fila-operacion">
                  <th scope="row">{o.nombreVisible ?? 'Influencer'}</th>
                  <td>
                    <PildoraTcl tono={tonoDeEtapa(o.etapa)}>{ETIQUETA_DE_ETAPA[o.etapa]}</PildoraTcl>
                  </td>
                  <td>{ETIQUETA_DE_PRODUCTO_RECIBIDO[o.productoRecibido]}</td>
                  <td>
                    <PildoraTcl tono={tonoDeGuion(o.guion.estado)}>
                      {ETIQUETA_DE_GUION[o.guion.estado]}
                    </PildoraTcl>{' '}
                    ({o.guion.aprobados} de {o.guion.total})
                  </td>
                  <td>No disponible</td>
                  <td>No disponible</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
