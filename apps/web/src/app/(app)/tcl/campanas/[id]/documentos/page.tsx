import { obtenerDocumentosParaTcl } from '@tcl-kol-os/db';
import { cargarCampanaTcl, valorOr404 } from '@/lib/tcl-server';
import { ETIQUETA_DE_TIPO_DE_DOCUMENTO, formatearFecha } from '@/lib/tcl-ui';
import { CabeceraTcl, VacioTcl } from '../../../CabeceraTcl';

export const dynamic = 'force-dynamic';

/** Documentos que SmartPR compartió con TCL a propósito. Solo metadatos: no hay descarga ni vista previa. */
export default async function TclDocumentosPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, campana } = await cargarCampanaTcl(id);
  const lista = valorOr404(await obtenerDocumentosParaTcl(user, campana.id));

  return (
    <div className="content content-wide ui-enter" data-testid="tcl-documentos">
      <CabeceraTcl
        campana={campana}
        activa="documentos"
        titulo="Documentos"
        descripcion="Material que SmartPR compartió contigo para esta campaña."
      />
      {lista.length === 0 ? (
        <VacioTcl
          titulo="Sin documentos compartidos"
          texto="Cuando SmartPR comparta material contigo aparecerá aquí."
        />
      ) : (
        <div className="table-shell">
          <table>
            <caption className="eyebrow">Documentos compartidos ({lista.length})</caption>
            <thead>
              <tr>
                <th scope="col">Título</th>
                <th scope="col">Tipo</th>
                <th scope="col">Idioma</th>
                <th scope="col">Fecha</th>
              </tr>
            </thead>
            <tbody>
              {lista.map((d) => (
                <tr key={d.sourceId} data-testid="fila-documento">
                  <th scope="row">{d.titulo ?? 'Documento'}</th>
                  <td>{ETIQUETA_DE_TIPO_DE_DOCUMENTO[d.tipo] ?? 'Otro'}</td>
                  <td>{d.idioma === 'es' ? 'Español' : d.idioma === 'en' ? 'Inglés' : '—'}</td>
                  <td>{formatearFecha(d.fecha)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
