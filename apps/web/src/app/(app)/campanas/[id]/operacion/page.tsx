import { notFound, redirect } from 'next/navigation';
import { currentUser } from '@/lib/session';
import { desviarClienteDeRutaLegada } from '@/lib/tcl-guard';
import { cargarResumenOperacion, filtrosDeOperacionDesdeUrl } from '@/lib/operacion-server';
import { NavCampana } from '../contenido/NavCampana';
import { Insignia } from './Insignia';
import {
  ESTADO_DE_ACUERDO,
  ESTADO_DE_CONTENIDO,
  ESTADO_DE_KPI_RESUMEN,
  ESTADO_LOGISTICO,
  PILL_DE_ACUERDO,
  PILL_DE_CONTENIDO,
  PILL_DE_KPI_RESUMEN,
  PILL_DE_PAGO,
  PILL_LOGISTICO,
  SEGUIMIENTO_DE_PAGO,
} from './etiquetas';
import styles from './operacion.module.css';

export const dynamic = 'force-dynamic';

type Busqueda = Readonly<Record<string, string | string[] | undefined>>;

/**
 * Operación de una campaña: por influencer (participación), el estado del acuerdo, la logística, el contenido,
 * los KPI y —solo con `finance:read`— el pago. La autorización, el aislamiento por organización y el 404 de
 * cliente, analista, legal y otras organizaciones los hace el loader (`cargarResumenOperacion`).
 */
export default async function OperacionDeCampanaPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Busqueda>;
}) {
  const user = await currentUser();
  if (user === undefined) redirect('/login');
  // Cliente TCL: a su equivalente de `/tcl` (o 404) ANTES de cualquier cargador interno.
  desviarClienteDeRutaLegada(user, { tipo: 'oculta' });

  const { id } = await params;
  const busqueda = await searchParams;
  const filtros = filtrosDeOperacionDesdeUrl(busqueda);
  const { campana, resumen, permisos } = await cargarResumenOperacion(user, id, filtros);
  if (resumen.campaignId !== campana.id) notFound();

  const base = `/campanas/${campana.id}/operacion`;
  const enlace = (extra: Readonly<Record<string, string>>): string => {
    const q = new URLSearchParams(extra);
    const texto = q.toString();
    return texto === '' ? base : `${base}?${texto}`;
  };
  const conservar = (clave: string, activo: boolean): Record<string, string> =>
    activo ? { [clave]: '1' } : {};
  const retirados = filtros.incluirRetirados === true;
  const activaDe = {
    logistica: filtros.logisticaPendiente === true,
    pago: filtros.pagoPendiente === true,
    sin: filtros.sinAcuerdo === true,
  };
  const ninguno = !activaDe.logistica && !activaDe.pago && !activaDe.sin;
  const { conteos } = resumen;
  const limite = resumen.limite;
  const desde = resumen.desde;
  const hayAnterior = desde > 0;
  const haySiguiente = desde + limite < resumen.total;
  const paginaCon = (nuevoDesde: number): string =>
    enlace({
      ...conservar('logisticaPendiente', activaDe.logistica),
      ...conservar('pagoPendiente', activaDe.pago),
      ...conservar('sinAcuerdo', activaDe.sin),
      ...conservar('retirados', retirados),
      ...(nuevoDesde > 0 ? { desde: String(nuevoDesde) } : {}),
    });

  return (
    <div className="content content-wide ui-enter" data-testid="operacion-page">
      <a className="back-link" href={`/campanas/${campana.id}`}>
        ← {campana.name}
      </a>

      <NavCampana campaignId={campana.id} role={user.role} activa="operacion" />

      <div className={styles['pagina']}>
        <header className={styles['cabecera']}>
          <div>
            <div className="eyebrow">Operación</div>
            <h1>Operación de {campana.name}</h1>
            <p className={styles['nota']}>
              Estado operativo de cada influencer: acuerdo, logística, contenido y KPI
              {permisos.verFinanzas ? ', facturación y pagos' : ''}. Entra a un influencer para ver el detalle
              {permisos.gestionarAcuerdo || permisos.gestionarEnvios ? ' y registrar cambios' : ''}.
            </p>
          </div>
        </header>

        {campana.status !== 'activa' && (
          <div className="aviso" role="status" data-testid="operacion-campana-solo-lectura">
            <strong>Campaña {campana.status}</strong>
            La operación es de solo lectura: no se registran cambios nuevos.
          </div>
        )}

        <ul className={styles['conteos']} data-testid="operacion-conteos" aria-label="Conteos de la campaña">
          <li className={styles['conteo']}>
            <strong data-testid="conteo-participaciones">{conteos.participaciones}</strong>
            <span>Influencers</span>
          </li>
          {conteos.sinAcuerdo !== undefined && (
            <li className={styles['conteo']}>
              <strong data-testid="conteo-sin-acuerdo">{conteos.sinAcuerdo}</strong>
              <span>Sin acuerdo</span>
            </li>
          )}
          {conteos.logisticaPendiente !== undefined && (
            <li className={styles['conteo']}>
              <strong data-testid="conteo-logistica-pendiente">{conteos.logisticaPendiente}</strong>
              <span>Logística pendiente</span>
            </li>
          )}
          {conteos.pagoPendiente !== undefined && (
            <li className={styles['conteo']}>
              <strong data-testid="conteo-pago-pendiente">{conteos.pagoPendiente}</strong>
              <span>Pago pendiente</span>
            </li>
          )}
        </ul>

        <nav className={styles['filtros']} aria-label="Filtros de la lista" data-testid="operacion-filtros">
          <a
            href={enlace(conservar('retirados', retirados))}
            className={`${styles['filtro']} ${ninguno ? (styles['filtroActivo'] ?? '') : ''}`}
            {...(ninguno ? { 'aria-current': 'true' as const } : {})}
            data-testid="filtro-todos"
          >
            Todos
          </a>
          {permisos.verEnvios && (
            <a
              href={enlace({ logisticaPendiente: '1', ...conservar('retirados', retirados) })}
              className={`${styles['filtro']} ${activaDe.logistica ? (styles['filtroActivo'] ?? '') : ''}`}
              {...(activaDe.logistica ? { 'aria-current': 'true' as const } : {})}
              data-testid="filtro-logistica-pendiente"
            >
              Logística pendiente
            </a>
          )}
          {permisos.verFinanzas && (
            <a
              href={enlace({ pagoPendiente: '1', ...conservar('retirados', retirados) })}
              className={`${styles['filtro']} ${activaDe.pago ? (styles['filtroActivo'] ?? '') : ''}`}
              {...(activaDe.pago ? { 'aria-current': 'true' as const } : {})}
              data-testid="filtro-pago-pendiente"
            >
              Pago pendiente
            </a>
          )}
          {permisos.verAcuerdo && (
            <a
              href={enlace({ sinAcuerdo: '1', ...conservar('retirados', retirados) })}
              className={`${styles['filtro']} ${activaDe.sin ? (styles['filtroActivo'] ?? '') : ''}`}
              {...(activaDe.sin ? { 'aria-current': 'true' as const } : {})}
              data-testid="filtro-sin-acuerdo"
            >
              Sin acuerdo
            </a>
          )}
          <a
            href={enlace({
              ...conservar('logisticaPendiente', activaDe.logistica),
              ...conservar('pagoPendiente', activaDe.pago),
              ...conservar('sinAcuerdo', activaDe.sin),
              ...(retirados ? {} : { retirados: '1' }),
            })}
            className={`${styles['filtro']} ${retirados ? (styles['filtroActivo'] ?? '') : ''}`}
            {...(retirados ? { 'aria-current': 'true' as const } : {})}
            data-testid="filtro-retirados"
          >
            {retirados ? 'Ocultar retirados' : 'Mostrar retirados'}
          </a>
        </nav>

        {resumen.items.length === 0 ? (
          <section className="card empty-state compact-empty" data-testid="operacion-vacia">
            <div className="empty-state-mark">O</div>
            <h2>
              {ninguno && !retirados
                ? 'Todavía no hay influencers en esta campaña'
                : 'Ningún influencer cumple este filtro'}
            </h2>
            <p>
              {ninguno && !retirados
                ? 'La operación se organiza por participación: asocia influencers a la campaña para empezar.'
                : 'Quita el filtro para ver todos los influencers de la campaña.'}
            </p>
          </section>
        ) : (
          <ul
            className={styles['filas']}
            data-testid="operacion-lista"
            aria-label="Influencers de la campaña"
          >
            {resumen.items.map((p) => {
              const r = p.resumen;
              return (
                <li
                  key={p.participacionId}
                  className={styles['fila']}
                  data-testid="fila-participacion"
                  data-participacion-id={p.participacionId}
                  data-estado={p.estadoDeParticipacion}
                >
                  <div className={styles['filaTitulo']}>
                    <a href={`${base}/${p.participacionId}`} data-testid="enlace-participacion">
                      {p.nombre}
                    </a>
                    {p.estadoDeParticipacion === 'retirado' && (
                      <span className="pill neutro">Retirado de la campaña</span>
                    )}
                  </div>
                  <div className={styles['etiquetas']}>
                    {r.acuerdo !== undefined && (
                      <Insignia
                        rotulo="Acuerdo"
                        testid="estado-acuerdo"
                        valor={r.acuerdo.estado}
                        texto={ESTADO_DE_ACUERDO[r.acuerdo.estado] ?? r.acuerdo.estado}
                        clase={PILL_DE_ACUERDO[r.acuerdo.estado] ?? 'pill neutro'}
                      />
                    )}
                    {r.logistica !== undefined && (
                      <Insignia
                        rotulo="Logística"
                        testid="estado-logistica"
                        valor={r.logistica.estado}
                        texto={ESTADO_LOGISTICO[r.logistica.estado] ?? r.logistica.estado}
                        clase={PILL_LOGISTICO[r.logistica.estado] ?? 'pill neutro'}
                      />
                    )}
                    {r.contenido !== undefined && (
                      <Insignia
                        rotulo="Contenido"
                        testid="estado-contenido"
                        valor={r.contenido.estado}
                        texto={ESTADO_DE_CONTENIDO[r.contenido.estado] ?? r.contenido.estado}
                        clase={PILL_DE_CONTENIDO[r.contenido.estado] ?? 'pill neutro'}
                      />
                    )}
                    {r.kpi !== undefined && (
                      <Insignia
                        rotulo="KPI"
                        testid="estado-kpi"
                        valor={r.kpi?.estado ?? 'sin_objetivos'}
                        texto={ESTADO_DE_KPI_RESUMEN[r.kpi?.estado ?? 'sin_objetivos'] ?? 'Sin objetivos'}
                        clase={PILL_DE_KPI_RESUMEN[r.kpi?.estado ?? 'sin_objetivos'] ?? 'pill neutro'}
                      />
                    )}
                    {r.pago !== undefined && (
                      <Insignia
                        rotulo="Pago"
                        testid="estado-pago"
                        valor={r.pago.seguimiento ?? 'sin_acuerdo'}
                        texto={
                          r.pago.seguimiento === null
                            ? 'Sin acuerdo'
                            : (SEGUIMIENTO_DE_PAGO[r.pago.seguimiento] ?? r.pago.seguimiento)
                        }
                        clase={
                          r.pago.seguimiento === null
                            ? 'pill neutro'
                            : (PILL_DE_PAGO[r.pago.seguimiento] ?? 'pill neutro')
                        }
                      />
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {(hayAnterior || haySiguiente) && (
          <nav className={styles['paginacion']} aria-label="Paginación" data-testid="operacion-paginacion">
            {hayAnterior && (
              <a
                className="btn"
                href={paginaCon(Math.max(0, desde - limite))}
                data-testid="paginacion-anterior"
              >
                Anterior
              </a>
            )}
            <span>
              {desde + 1}–{Math.min(desde + limite, resumen.total)} de {resumen.total}
            </span>
            {haySiguiente && (
              <a className="btn" href={paginaCon(desde + limite)} data-testid="paginacion-siguiente">
                Siguiente
              </a>
            )}
          </nav>
        )}
      </div>
    </div>
  );
}
