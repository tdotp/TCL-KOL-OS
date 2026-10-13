import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/session';
import { desviarClienteDeRutaLegada } from '@/lib/tcl-guard';
import {
  cargarAcuerdoConHistorial,
  cargarEnvios,
  cargarEstadoOperativo,
  cargarEventosOperativos,
  cargarEvidenciaDeSujeto,
  cargarHistorialDeKpi,
  cargarKpiDeParticipacion,
  cargarKpiPactadoDelSheet,
  cargarProductosAsignados,
  cargarResumenPii,
  cargarSeguimientoDePago,
  type SujetoOperativo,
} from '@/lib/operacion-server';
import { NavCampana } from '@/components/NavCampana';
import { SeccionAcuerdo } from '../SeccionAcuerdo';
import { SeccionContenido } from '../SeccionContenido';
import { SeccionFacturacion } from '../SeccionFacturacion';
import { SeccionKpi } from '../SeccionKpi';
import { SeccionLogistica } from '../SeccionLogistica';
import styles from '../operacion.module.css';

export const dynamic = 'force-dynamic';

/**
 * Estado operativo de UNA participación, en cinco secciones (acuerdo, productos y logística, facturación y
 * pagos, contenido, KPI). Cada sección existe solo si el loader la trae para el rol: sin la capacidad, la
 * sección no está en el DOM. Cliente, otras organizaciones y participaciones de otra campaña ⇒ 404 (lo hacen
 * los loaders). Las escrituras solo se ofrecen con la campaña activa y el influencer no retirado.
 */
export default async function OperacionDeParticipacionPage({
  params,
}: {
  params: Promise<{ id: string; participacionId: string }>;
}) {
  const user = await currentUser();
  if (user === undefined) redirect('/login');
  // Cliente TCL: a su equivalente de `/tcl` (o 404) ANTES de cualquier cargador interno.
  desviarClienteDeRutaLegada(user, { tipo: 'oculta' });

  const { id, participacionId } = await params;
  const { campana, estado, permisos } = await cargarEstadoOperativo(user, participacionId, id);

  const campanaActiva = campana.status === 'activa';
  const activo = estado.estadoDeParticipacion === 'activo';
  const puedeEscribir = campanaActiva && activo;
  const puedeMedirKpi = permisos.medirKpi && (campanaActiva || campana.status === 'archivada');
  const necesitaProductos = permisos.gestionarAcuerdo || permisos.gestionarEnvios;

  const [acuerdo, envios, seguimiento, kpi, historialKpi, sugerencia, productos, piiResumen] =
    await Promise.all([
      cargarAcuerdoConHistorial(user, estado.participacionId),
      cargarEnvios(user, estado.participacionId),
      permisos.verFinanzas ? cargarSeguimientoDePago(user, estado.participacionId) : Promise.resolve(null),
      cargarKpiDeParticipacion(user, estado.participacionId),
      cargarHistorialDeKpi(user, estado.participacionId),
      cargarKpiPactadoDelSheet(user, estado.participacionId),
      necesitaProductos ? cargarProductosAsignados(user, estado.participacionId) : Promise.resolve([]),
      permisos.verPiiResumen ? cargarResumenPii(user, estado.participacionId) : Promise.resolve(null),
    ]);

  // Historial (eventos y evidencia) por sujeto: envíos, documentos de cobro y la obligación de pago.
  const sujetos: SujetoOperativo[] = [
    ...(envios ?? []).map((e): SujetoOperativo => ({ subjectType: 'shipment', subjectId: e.id })),
    ...(seguimiento !== null
      ? [
          { subjectType: 'payment_obligation', subjectId: seguimiento.obligation.id } as SujetoOperativo,
          ...seguimiento.documents.map((d): SujetoOperativo => ({
            subjectType: 'billing_document',
            subjectId: d.id,
          })),
        ]
      : []),
  ];
  const historiales = Object.fromEntries(
    await Promise.all(
      sujetos.map(async (s) => {
        const [eventos, evidencia] = await Promise.all([
          cargarEventosOperativos(user, s),
          cargarEvidenciaDeSujeto(user, s),
        ]);
        return [s.subjectId, { eventos, evidencia }] as const;
      }),
    ),
  );

  const base = `/campanas/${campana.id}/operacion`;
  const logistica = estado.logistica;
  const tieneKpi = kpi !== null;

  return (
    <div
      className="content content-wide ui-enter"
      data-testid="operacion-detalle-page"
      data-participacion-id={estado.participacionId}
    >
      <a className="back-link" href={base}>
        ← Operación de {campana.name}
      </a>

      <NavCampana campaignId={campana.id} role={user.role} activa="operacion" />

      <div className={styles['pagina']}>
        <header className={styles['cabecera']}>
          <div>
            <div className="eyebrow">Influencer</div>
            <h1 data-testid="operacion-influencer">{estado.nombre}</h1>
            <p className={styles['nota']}>Estado operativo del influencer en {campana.name}.</p>
          </div>
          <div className={styles['etiquetas']}>
            {!activo && <span className="pill neutro">Retirado de la campaña</span>}
          </div>
        </header>

        {!campanaActiva && (
          <div className="aviso" role="status" data-testid="operacion-campana-solo-lectura">
            <strong>Campaña {campana.status}</strong>
            La operación es de solo lectura: no se registran cambios nuevos.
          </div>
        )}
        {campanaActiva && !activo && (
          <div className="aviso" role="status" data-testid="operacion-participacion-retirada">
            <strong>Influencer retirado</strong>
            Su historia se conserva, pero no admite cambios.
          </div>
        )}

        {acuerdo !== null && (
          <SeccionAcuerdo
            participacionId={estado.participacionId}
            datos={acuerdo}
            permisos={permisos}
            productos={productos}
            puedeEscribir={puedeEscribir}
          />
        )}

        {envios !== null && (
          <SeccionLogistica
            campaignId={campana.id}
            participacionId={estado.participacionId}
            logistica={logistica}
            envios={envios}
            historiales={historiales}
            permisos={permisos}
            productos={productos}
            piiResumen={piiResumen}
            puedeEscribir={puedeEscribir}
          />
        )}

        {permisos.verFinanzas && (
          <SeccionFacturacion
            campaignId={campana.id}
            participacionId={estado.participacionId}
            seguimiento={seguimiento}
            historiales={historiales}
            permisos={permisos}
            puedeEscribir={puedeEscribir}
          />
        )}

        {estado.contenido !== undefined && (
          <SeccionContenido
            campaignId={campana.id}
            participacionId={estado.participacionId}
            contenido={estado.contenido}
          />
        )}

        {tieneKpi && (
          <SeccionKpi
            participacionId={estado.participacionId}
            kpi={kpi}
            historial={historialKpi}
            sugerencia={sugerencia}
            permisos={permisos}
            puedeFijarObjetivos={permisos.gestionarObjetivosKpi && campanaActiva && activo}
            puedeMedir={puedeMedirKpi}
          />
        )}
      </div>
    </div>
  );
}
