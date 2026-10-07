import { SHIPMENT_TRANSITIONS, type ShipmentStatus } from '@tcl-kol-os/domain';
import type { PiiSummary } from '@tcl-kol-os/domain';
import type { EnvioVista, DetalleDeLogistica } from '@tcl-kol-os/db';
import { crearEnvioAction, transicionarEnvioAction } from '@/lib/operacion-actions';
import type { PermisosDeOperacion } from '@/lib/operacion-comun';
import type { EvidenciaDeOperacion, ProductoAsignado } from '@/lib/operacion-server';
import type { EventoOperativo } from '@tcl-kol-os/db';
import { fechaHora } from '../contenido/etiquetas';
import { BloqueDatosDeEntrega } from './BloqueDatosDeEntrega';
import { CampoNota, FilasDeProducto } from './CamposDeFormulario';
import { FormularioOperativo } from './FormularioOperativo';
import {
  ESTADO_DE_ENVIO,
  ESTADO_LOGISTICO,
  PILL_DE_ENVIO,
  PILL_LOGISTICO,
  TIPO_DE_EVENTO,
  TIPO_DE_SOPORTE,
  fechaDeDia,
  hoyEnColombia,
} from './etiquetas';
import styles from './operacion.module.css';

export interface HistorialDeEnvio {
  readonly eventos: readonly EventoOperativo[] | null;
  readonly evidencia: readonly EvidenciaDeOperacion[] | null;
}

const TRANSICIONES: Readonly<Record<string, { boton: string; testid: string }>> = {
  prepared: { boton: 'Marcar preparado', testid: 'form-envio-preparado' },
  shipped: { boton: 'Marcar enviado', testid: 'form-envio-enviado' },
  delivered: { boton: 'Marcar entregado', testid: 'form-envio-entregado' },
  failed: { boton: 'Marcar fallido', testid: 'form-envio-fallido' },
  returned: { boton: 'Marcar devuelto', testid: 'form-envio-devuelto' },
  cancelled: { boton: 'Cancelar envío', testid: 'form-envio-cancelado' },
};

function tamano(bytes: number | null): string {
  if (bytes === null) return '';
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Productos y logística: comprometido vs enviado vs entregado por producto, envíos con su estado, formularios
 * de crear y mover envíos y adjuntar soporte, historial de eventos y el bloque aparte de datos de entrega
 * (solo con capacidad PII). Solo se renderiza si el loader trajo los envíos.
 */
export function SeccionLogistica({
  campaignId,
  participacionId,
  logistica,
  envios,
  historiales,
  permisos,
  productos,
  piiResumen,
  puedeEscribir,
}: {
  campaignId: string;
  participacionId: string;
  logistica: DetalleDeLogistica | undefined;
  envios: readonly EnvioVista[];
  historiales: Readonly<Record<string, HistorialDeEnvio>>;
  permisos: PermisosDeOperacion;
  productos: readonly ProductoAsignado[];
  piiResumen: PiiSummary | null;
  puedeEscribir: boolean;
}) {
  const opciones = productos.map((p) => ({ id: p.campaignProductId, nombre: `${p.brand} ${p.model}` }));
  const gestiona = permisos.gestionarEnvios && puedeEscribir;
  const hoy = hoyEnColombia();
  const datosDeEntrega = permisos.verPiiResumen
    ? {
        resumen: piiResumen,
        puedeRevelar: permisos.revelarPii,
        puedeGuardar: permisos.gestionarPii && puedeEscribir,
      }
    : undefined;

  return (
    <section
      className={`card ${styles['seccion'] ?? ''}`}
      data-testid="seccion-logistica"
      aria-labelledby="titulo-logistica"
    >
      <div className={styles['seccionCabecera']}>
        <h2 id="titulo-logistica">Productos y logística</h2>
        {logistica !== undefined && (
          <span
            className={PILL_LOGISTICO[logistica.estado] ?? 'pill neutro'}
            data-testid="logistica-estado"
            data-valor={logistica.estado}
          >
            {ESTADO_LOGISTICO[logistica.estado] ?? logistica.estado}
          </span>
        )}
      </div>

      <div>
        <p className={styles['subtitulo']}>Comprometido, enviado y entregado por producto</p>
        {logistica === undefined || logistica.productos.length === 0 ? (
          <p className={styles['vacio']} data-testid="logistica-sin-productos">
            Todavía no hay productos comprometidos ni enviados.
          </p>
        ) : (
          <div className={styles['tablaEnvoltura']}>
            <table className={styles['tabla']} data-testid="logistica-productos">
              <thead>
                <tr>
                  <th scope="col">Producto</th>
                  <th scope="col" className={styles['numero']}>
                    Comprometido
                  </th>
                  <th scope="col" className={styles['numero']}>
                    Enviado
                  </th>
                  <th scope="col" className={styles['numero']}>
                    Entregado
                  </th>
                </tr>
              </thead>
              <tbody>
                {logistica.productos.map((p) => (
                  <tr key={p.campaignProductId} data-testid="logistica-producto">
                    <th scope="row">{p.nombre}</th>
                    <td className={styles['numero']}>{p.comprometido}</td>
                    <td className={styles['numero']}>{p.enviado}</td>
                    <td className={styles['numero']}>{p.entregado}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div>
        <p className={styles['subtitulo']}>Envíos</p>
        {envios.length === 0 ? (
          <p className={styles['vacio']} data-testid="envios-vacio">
            Todavía no hay envíos para esta participación.
          </p>
        ) : (
          <ul className={styles['lista']} data-testid="envios-lista">
            {envios.map((e, i) => {
              const historial = historiales[e.id];
              const destinos = (SHIPMENT_TRANSITIONS[e.status as ShipmentStatus] ?? []).filter(
                (d) => TRANSICIONES[d] !== undefined,
              );
              const ocultos = { shipmentId: e.id, expectedSeq: e.rowSeq };
              return (
                <li
                  key={e.id}
                  className={styles['item']}
                  data-testid="envio"
                  data-envio-id={e.id}
                  data-estado={e.status}
                >
                  <div className={styles['itemCabecera']}>
                    <strong>Envío {envios.length - i}</strong>
                    <span className={PILL_DE_ENVIO[e.status] ?? 'pill neutro'} data-testid="envio-estado">
                      {ESTADO_DE_ENVIO[e.status] ?? e.status}
                    </span>
                  </div>
                  <dl className={styles['datos']}>
                    <div>
                      <dt>Transportadora</dt>
                      <dd data-testid="envio-transportadora">{e.carrier ?? '—'}</dd>
                    </div>
                    <div>
                      <dt>Guía (tracking)</dt>
                      <dd data-testid="envio-tracking">{e.trackingRef ?? '—'}</dd>
                    </div>
                    <div>
                      <dt>Enviado el</dt>
                      <dd>{fechaDeDia(e.shippedOn)}</dd>
                    </div>
                    <div>
                      <dt>Entregado el</dt>
                      <dd>{fechaDeDia(e.deliveredOn)}</dd>
                    </div>
                    {e.shippingCost !== undefined && e.shippingCost !== null && (
                      <div>
                        <dt>Costo de envío</dt>
                        <dd data-testid="envio-costo">
                          {e.shippingCost} {e.shippingCurrency ?? ''}
                        </dd>
                      </div>
                    )}
                    {e.cancelReason !== null && (
                      <div>
                        <dt>Motivo de cancelación</dt>
                        <dd>{e.cancelReason}</dd>
                      </div>
                    )}
                  </dl>
                  <ul className={styles['lista']} data-testid="envio-items">
                    {e.items.map((it) => (
                      <li key={it.campaignProductId} className={styles['itemMeta']}>
                        {it.productModel} × {it.quantity}
                      </li>
                    ))}
                  </ul>

                  {gestiona && destinos.length > 0 && (
                    <div className={styles['formularios']}>
                      {destinos.map((d) => {
                        const t = TRANSICIONES[d];
                        if (t === undefined) return null;
                        const conSoporte = d === 'shipped' || d === 'delivered';
                        return (
                          <FormularioOperativo
                            key={d}
                            testid={t.testid}
                            boton={t.boton}
                            variante={
                              d === 'cancelled' || d === 'failed' || d === 'returned' ? 'neutro' : 'pri'
                            }
                            accion={transicionarEnvioAction}
                            ocultos={{ ...ocultos, to: d }}
                            {...(conSoporte
                              ? {
                                  subida: {
                                    campaignId,
                                    tipo: 'envio' as const,
                                    accion: 'transicionar',
                                    requerido: false,
                                    mensajeExito: 'Envío actualizado con su soporte.',
                                  },
                                }
                              : {})}
                          >
                            {d === 'shipped' && (
                              <>
                                <label>
                                  Transportadora
                                  <input
                                    type="text"
                                    name="carrier"
                                    maxLength={120}
                                    defaultValue={e.carrier ?? ''}
                                  />
                                </label>
                                <label>
                                  Guía (tracking)
                                  <input
                                    type="text"
                                    name="trackingRef"
                                    maxLength={200}
                                    defaultValue={e.trackingRef ?? ''}
                                  />
                                </label>
                              </>
                            )}
                            {(d === 'shipped' || d === 'delivered') && (
                              <label>
                                {d === 'shipped' ? 'Fecha de envío' : 'Fecha de entrega'}
                                <input type="date" name="happenedOn" required defaultValue={hoy} />
                              </label>
                            )}
                            {d === 'cancelled' && (
                              <label style={{ gridColumn: '1 / -1' }}>
                                Motivo de la cancelación
                                <textarea name="cancelReason" required maxLength={500} rows={2} />
                              </label>
                            )}
                            <CampoNota />
                          </FormularioOperativo>
                        );
                      })}
                    </div>
                  )}
                  {permisos.adjuntarEvidencia && puedeEscribir && (
                    <FormularioOperativo
                      testid="form-envio-evidencia"
                      boton="Adjuntar evidencia"
                      variante="neutro"
                      subida={{
                        campaignId,
                        tipo: 'envio',
                        accion: 'adjuntar',
                        requerido: true,
                        mensajeExito: 'Evidencia adjunta al envío.',
                      }}
                      ocultos={ocultos}
                    >
                      <label>
                        Tipo de soporte
                        <select name="kind" defaultValue="guia">
                          {TIPO_DE_SOPORTE.map((s) => (
                            <option key={s.valor} value={s.valor}>
                              {s.etiqueta}
                            </option>
                          ))}
                        </select>
                      </label>
                      <CampoNota />
                    </FormularioOperativo>
                  )}

                  {historial?.evidencia !== null &&
                    historial?.evidencia !== undefined &&
                    historial.evidencia.length > 0 && (
                      <div>
                        <p className={styles['subtitulo']}>Evidencia</p>
                        <ul className={styles['historial']} data-testid="envio-evidencia">
                          {historial.evidencia.map((ev) => (
                            <li key={ev.id}>
                              {ev.filename} ·{' '}
                              {TIPO_DE_SOPORTE.find((s) => s.valor === ev.kind)?.etiqueta ?? ev.kind}
                              {ev.sizeBytes !== null ? ` · ${tamano(ev.sizeBytes)}` : ''}
                              {ev.retractedAt !== null ? ' · retirada' : ''}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  {historial?.eventos !== null &&
                    historial?.eventos !== undefined &&
                    historial.eventos.length > 0 && (
                      <div>
                        <p className={styles['subtitulo']}>Historial del envío</p>
                        <ul className={styles['historial']} data-testid="envio-historial">
                          {historial.eventos.map((ev) => (
                            <li key={ev.id} data-testid="envio-evento" data-tipo={ev.eventType}>
                              {TIPO_DE_EVENTO[ev.eventType] ?? ev.eventType} · {fechaHora(ev.recordedAt)}
                              {ev.recordedByName !== null ? ` · ${ev.recordedByName}` : ''}
                              {ev.happenedOn !== null ? ` · hecho el ${fechaDeDia(ev.happenedOn)}` : ''}
                              {ev.evidenceCount > 0 ? ` · ${ev.evidenceCount} soporte(s)` : ''}
                              {ev.note !== undefined && ev.note !== null && ev.note !== ''
                                ? ` · ${ev.note}`
                                : ''}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {gestiona && (
        <FormularioOperativo
          testid="form-crear-envio"
          titulo="Crear un envío"
          boton="Crear envío"
          accion={crearEnvioAction}
          ocultos={{ participacionId }}
        >
          <FilasDeProducto
            productos={opciones}
            campoProducto="itemProductId"
            campoCantidad="itemQuantity"
            rotulo="Productos del envío"
          />
          <label>
            Transportadora (opcional)
            <input type="text" name="carrier" maxLength={120} />
          </label>
          <label>
            Guía o tracking (opcional)
            <input type="text" name="trackingRef" maxLength={200} />
          </label>
          {permisos.verFinanzas && (
            <>
              <label>
                Costo del envío (opcional)
                <input type="text" name="shippingCost" inputMode="decimal" autoComplete="off" />
              </label>
              <label>
                Moneda del costo
                <input
                  type="text"
                  name="shippingCurrency"
                  maxLength={3}
                  autoComplete="off"
                  placeholder="COP"
                />
              </label>
            </>
          )}
          {permisos.gestionarPii && piiResumen !== null && !piiResumen.erased && (
            <label className={styles['checkbox']} style={{ gridColumn: '1 / -1' }}>
              <input type="checkbox" name="piiRecordId" value={piiResumen.recordId} />
              Usar los datos de entrega guardados
            </label>
          )}
          <CampoNota />
        </FormularioOperativo>
      )}

      {!gestiona && permisos.gestionarEnvios && !puedeEscribir && (
        <p className={styles['aviso']}>
          La campaña o el influencer no admiten cambios: la logística es de solo lectura.
        </p>
      )}
      {datosDeEntrega !== undefined && (
        <BloqueDatosDeEntrega
          participacionId={participacionId}
          resumen={datosDeEntrega.resumen}
          puedeRevelar={datosDeEntrega.puedeRevelar}
          puedeGuardar={datosDeEntrega.puedeGuardar}
        />
      )}
    </section>
  );
}
