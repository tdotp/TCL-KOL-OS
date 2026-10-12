import { obtenerContenidoParaTcl } from '@tcl-kol-os/db';
import { cargarCampanaTcl, valorOr404 } from '@/lib/tcl-server';
import { ETIQUETA_DE_CONTENIDO, formatearFecha, nombreDeProducto } from '@/lib/tcl-ui';
import { CabeceraTcl, PildoraTcl, VacioTcl } from '../../../CabeceraTcl';

export const dynamic = 'force-dynamic';

/** Contenido: solo el guion APROBADO vigente de cada entregable. Todo lo demás es «pendiente», sin más rastro. */
export default async function TclContenidoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, campana } = await cargarCampanaTcl(id);
  const lista = valorOr404(await obtenerContenidoParaTcl(user, campana.id));
  const aprobados = lista.filter((c) => c.estado === 'aprobado').length;

  return (
    <div className="content content-wide ui-enter" data-testid="tcl-contenido">
      <CabeceraTcl
        campana={campana}
        activa="contenido"
        titulo="Contenido"
        descripcion="Aquí ves si el guion de cada entregable ya está aprobado. El texto de los guiones no se muestra."
      />
      {lista.length === 0 ? (
        <VacioTcl
          titulo="Sin entregables"
          texto="Cuando se definan los entregables de la campaña aparecerán aquí."
        />
      ) : (
        <div className="table-shell">
          <table>
            <caption className="eyebrow">
              Entregables ({aprobados} de {lista.length} con guion aprobado)
            </caption>
            <thead>
              <tr>
                <th scope="col">Entregable</th>
                <th scope="col">Plataforma</th>
                <th scope="col">Producto</th>
                <th scope="col">Estado del guion</th>
                <th scope="col">Aprobado el</th>
              </tr>
            </thead>
            <tbody>
              {lista.map((c) => (
                <tr key={c.entregable.id} data-testid="fila-contenido">
                  <th scope="row">{c.entregable.etiqueta ?? 'Entregable'}</th>
                  <td>{c.entregable.plataforma ?? '—'}</td>
                  <td>{nombreDeProducto(c.entregable.producto) ?? '—'}</td>
                  <td>
                    <PildoraTcl tono={c.estado === 'aprobado' ? 'ok' : 'warn'}>
                      {ETIQUETA_DE_CONTENIDO[c.estado]}
                    </PildoraTcl>
                  </td>
                  <td>{c.estado === 'aprobado' ? formatearFecha(c.aprobadoEl) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
