import type { EventoOperativo, SeguimientoDePago } from '@tcl-kol-os/db';
import {
  anularDocumentoAction,
  rechazarDocumentoAction,
  registrarNotaDeCorreccionDePagoAction,
  reportarPagoAction,
  validarDocumentoAction,
} from '@/lib/operacion-actions';
import type { PermisosDeOperacion } from '@/lib/operacion-comun';
import type { EvidenciaDeOperacion } from '@/lib/operacion-server';
import { fechaHora } from '../contenido/etiquetas';
import { CampoNota } from './CamposDeFormulario';
import { FormularioOperativo } from './FormularioOperativo';
import {
  ESTADO_DE_DOCUMENTO,
  PILL_DE_DOCUMENTO,
  PILL_DE_PAGO,
  SEGUIMIENTO_DE_PAGO,
  TIPO_DE_EVENTO,
  TIPO_DE_SOPORTE,
  fechaDeDia,
} from './etiquetas';
import styles from './operacion.module.css';

export interface HistorialDeSujeto {
  readonly eventos: readonly EventoOperativo[] | null;
  readonly evidencia: readonly EvidenciaDeOperacion[] | null;
}

function Historial({ id, historial }: { id: string; historial: HistorialDeSujeto | undefined }) {
  const eventos = historial?.eventos ?? [];
  const evidencia = historial?.evidencia ?? [];
  return (
    <>
      {evidencia.length > 0 && (
        <ul className={styles['historial']} data-testid={`evidencia-${id}`} aria-label="Evidencia">
          {evidencia.map((ev) => (
            <li key={ev.id}>
              {ev.filename} · {TIPO_DE_SOPORTE.find((s) => s.valor === ev.kind)?.etiqueta ?? ev.kind}
              {ev.retractedAt !== null ? ' · retirada' : ''}
            </li>
          ))}
        </ul>
      )}
      {eventos.length > 0 && (
        <ul className={styles['historial']} aria-label="Historial de eventos">
          {eventos.map((ev) => (
            <li key={ev.id} data-testid="evento-operativo" data-tipo={ev.eventType}>
              {TIPO_DE_EVENTO[ev.eventType] ?? ev.eventType} · {fechaHora(ev.recordedAt)}
              {ev.recordedByName !== null ? ` · ${ev.recordedByName}` : ''}
              {ev.happenedOn !== null ? ` · hecho el ${fechaDeDia(ev.happenedOn)}` : ''}
              {ev.note !== undefined && ev.note !== null && ev.note !== '' ? ` · ${ev.note}` : ''}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function SelectorDeSoporte({ porDefecto }: { porDefecto: string }) {
  return (
    <label>
      Tipo de soporte
      <select name="kind" defaultValue={porDefecto}>
        {TIPO_DE_SOPORTE.map((s) => (
          <option key={s.valor} value={s.valor}>
            {s.etiqueta}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Facturación y pagos (solo con `finance:read`): seguimiento derivado, documentos de cobro y formularios de
 * registrar/validar/rechazar/anular. Reportar un pago es solo `payment:report` y SOLO registra que alguien
 * reportó un pago: el sistema no ejecuta pagos. Un canje puro no tiene formularios de pago.
 */
export function SeccionFacturacion({
  campaignId,
  participacionId,
  seguimiento,
  historiales,
  permisos,
  puedeEscribir,
}: {
  campaignId: string;
  participacionId: string;
  /** `null` = la participación aún no tiene acuerdo (no hay obligación). */
  seguimiento: SeguimientoDePago | null;
  historiales: Readonly<Record<string, HistorialDeSujeto>>;
  permisos: PermisosDeOperacion;
  puedeEscribir: boolean;
}) {
  if (seguimiento === null) {
    return (
      <section
        className={`card ${styles['seccion'] ?? ''}`}
        data-testid="seccion-facturacion-pagos"
        aria-labelledby="titulo-facturacion"
      >
        <div className={styles['seccionCabecera']}>
          <h2 id="titulo-facturacion">Facturación y pagos</h2>
        </div>
        <p className={styles['vacio']} data-testid="facturacion-sin-acuerdo">
          Aún no hay acuerdo: no hay obligación de pago ni documentos de cobro.
        </p>
      </section>
    );
  }

  const { obligation, documents, tracking } = seguimiento;
  const esCanje = seguimiento.agreement.compensationType === 'barter';
  const pendiente = obligation.status === 'pending';
  const hayValidado = documents.some((d) => d.status === 'validated');
  const factura = permisos.gestionarFacturacion && puedeEscribir && !esCanje;
  const reporta = permisos.reportarPago && puedeEscribir && !esCanje;
  const ocultosObligacion = { paymentObligationId: obligation.id, expectedSeq: obligation.rowSeq };

  return (
    <section
      className={`card ${styles['seccion'] ?? ''}`}
      data-testid="seccion-facturacion-pagos"
      aria-labelledby="titulo-facturacion"
    >
      <div className={styles['seccionCabecera']}>
        <h2 id="titulo-facturacion">Facturación y pagos</h2>
        <span
          className={PILL_DE_PAGO[tracking] ?? 'pill neutro'}
          data-testid="seguimiento-pago"
          data-valor={tracking}
        >
          {SEGUIMIENTO_DE_PAGO[tracking] ?? tracking}
        </span>
      </div>

      {esCanje ? (
        <p className={styles['aviso']} data-testid="pago-no-aplica-canje">
          No aplica (canje)
        </p>
      ) : (
        <>
          {obligation.status === 'reported_paid' && (
            <dl className={styles['datos']} data-testid="pago-reportado">
              <div>
                <dt>Pago reportado el</dt>
                <dd>{fechaHora(obligation.reportedAt ?? undefined)}</dd>
              </div>
              <div>
                <dt>Fecha del pago</dt>
                <dd>{fechaDeDia(obligation.paidOn)}</dd>
              </div>
              <div>
                <dt>Referencia externa</dt>
                <dd data-testid="pago-referencia">{obligation.externalReference ?? '—'}</dd>
              </div>
              {obligation.billingValidatedAtReport === false && (
                <div>
                  <dt>Documento de cobro</dt>
                  <dd data-testid="pago-sin-documento-validado">Se reportó sin un documento validado</dd>
                </div>
              )}
            </dl>
          )}

          <div>
            <p className={styles['subtitulo']}>Documentos de cobro</p>
            {documents.length === 0 ? (
              <p className={styles['vacio']} data-testid="documentos-vacio">
                Todavía no hay documentos de cobro registrados.
              </p>
            ) : (
              <ul className={styles['lista']} data-testid="documentos-lista">
                {documents.map((d) => {
                  const ocultos = { billingDocumentId: d.id, expectedSeq: d.rowSeq };
                  return (
                    <li
                      key={d.id}
                      className={styles['item']}
                      data-testid="documento-cobro"
                      data-documento-id={d.id}
                      data-estado={d.status}
                    >
                      <div className={styles['itemCabecera']}>
                        <strong>{d.documentNumber}</strong>
                        <span
                          className={PILL_DE_DOCUMENTO[d.status] ?? 'pill neutro'}
                          data-testid="documento-estado"
                        >
                          {ESTADO_DE_DOCUMENTO[d.status] ?? d.status}
                        </span>
                      </div>
                      <div className={styles['itemMeta']}>
                        Emitido el {fechaDeDia(d.issuedOn)} · Cobra {d.claimedAmount} {d.claimedCurrency} ·
                        Archivo {d.sourceFilename}
                      </div>
                      {factura && (d.status === 'registered' || d.status === 'validated') && (
                        <div className={styles['formularios']}>
                          {d.status === 'registered' && (
                            <>
                              <FormularioOperativo
                                testid="form-validar-documento"
                                boton="Validar documento"
                                accion={validarDocumentoAction}
                                ocultos={ocultos}
                              >
                                <CampoNota />
                              </FormularioOperativo>
                              <FormularioOperativo
                                testid="form-rechazar-documento"
                                boton="Rechazar documento"
                                variante="neutro"
                                accion={rechazarDocumentoAction}
                                ocultos={ocultos}
                              >
                                <label style={{ gridColumn: '1 / -1' }}>
                                  Motivo del rechazo
                                  <textarea name="note" required maxLength={2000} rows={2} />
                                </label>
                              </FormularioOperativo>
                            </>
                          )}
                          <FormularioOperativo
                            testid="form-anular-documento"
                            boton="Anular documento"
                            variante="neutro"
                            accion={anularDocumentoAction}
                            ocultos={ocultos}
                          >
                            <label style={{ gridColumn: '1 / -1' }}>
                              Motivo de la anulación
                              <textarea name="note" required maxLength={2000} rows={2} />
                            </label>
                          </FormularioOperativo>
                        </div>
                      )}
                      {permisos.adjuntarEvidencia &&
                        puedeEscribir &&
                        (d.status === 'registered' || d.status === 'validated') && (
                          <FormularioOperativo
                            testid="form-documento-evidencia"
                            boton="Adjuntar evidencia al documento"
                            variante="neutro"
                            subida={{
                              campaignId,
                              tipo: 'documento_cobro',
                              accion: 'adjuntar',
                              requerido: true,
                              mensajeExito: 'Evidencia adjunta al documento.',
                            }}
                            ocultos={{ participacionId, ...ocultos }}
                          >
                            <SelectorDeSoporte porDefecto="cuenta_cobro" />
                            <CampoNota />
                          </FormularioOperativo>
                        )}
                      <Historial id={d.id} historial={historiales[d.id]} />
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {factura && pendiente && (
            <FormularioOperativo
              testid="form-registrar-documento"
              titulo="Registrar un documento de cobro"
              boton="Registrar documento de cobro"
              subida={{
                campaignId,
                tipo: 'documento_cobro',
                accion: 'registrar',
                requerido: true,
                etiquetaArchivo: 'Archivo del documento de cobro',
                mensajeExito: 'Documento de cobro registrado.',
              }}
              ocultos={{ participacionId, paymentObligationId: obligation.id }}
            >
              <label>
                Número del documento
                <input type="text" name="documentNumber" required maxLength={100} autoComplete="off" />
              </label>
              <label>
                Fecha de emisión
                <input type="date" name="issuedOn" required />
              </label>
              <label>
                Monto que cobra el documento
                <input type="text" name="claimedAmount" required inputMode="decimal" autoComplete="off" />
              </label>
              <label>
                Moneda (3 letras)
                <input
                  type="text"
                  name="claimedCurrency"
                  required
                  maxLength={3}
                  autoComplete="off"
                  placeholder="COP"
                />
              </label>
              <CampoNota />
            </FormularioOperativo>
          )}

          {reporta && pendiente && (
            <FormularioOperativo
              testid="form-reportar-pago"
              titulo="Reportar un pago"
              boton="Reportar pago"
              accion={reportarPagoAction}
              subida={{
                campaignId,
                tipo: 'pago',
                accion: 'reportar',
                requerido: false,
                etiquetaArchivo: 'Comprobante (opcional)',
                mensajeExito: 'Pago reportado con su comprobante.',
              }}
              ocultos={ocultosObligacion}
            >
              <p
                className={styles['aviso']}
                style={{ gridColumn: '1 / -1', margin: 0 }}
                data-testid="aviso-pago-solo-registro"
              >
                Esto registra que un pago fue reportado; el sistema no ejecuta pagos.
              </p>
              {!hayValidado && (
                <p
                  className={styles['aviso']}
                  style={{ gridColumn: '1 / -1', margin: 0 }}
                  data-testid="aviso-sin-documento-validado"
                >
                  Aún no hay un documento de cobro validado. Puedes reportar el pago igual, pero quedará
                  marcado como reportado sin documento validado.
                </p>
              )}
              <label>
                Fecha del pago
                <input type="date" name="paidOn" required />
              </label>
              <label>
                Referencia externa del pago
                <input type="text" name="externalReference" required maxLength={200} autoComplete="off" />
              </label>
              <CampoNota />
            </FormularioOperativo>
          )}

          {reporta && obligation.status === 'reported_paid' && (
            <FormularioOperativo
              testid="form-correccion-pago"
              titulo="Anotar una corrección al pago reportado"
              boton="Anotar corrección de pago"
              variante="neutro"
              accion={registrarNotaDeCorreccionDePagoAction}
              ocultos={ocultosObligacion}
            >
              <label>
                Referencia externa corregida (opcional)
                <input type="text" name="externalReference" maxLength={200} autoComplete="off" />
              </label>
              <label>
                Fecha corregida (opcional)
                <input type="date" name="happenedOn" />
              </label>
              <label style={{ gridColumn: '1 / -1' }}>
                Qué se corrige y por qué
                <textarea name="note" required maxLength={2000} rows={2} />
              </label>
            </FormularioOperativo>
          )}

          {permisos.adjuntarEvidencia &&
            puedeEscribir &&
            (pendiente || obligation.status === 'reported_paid') && (
              <FormularioOperativo
                testid="form-pago-evidencia"
                boton="Adjuntar comprobante de pago"
                variante="neutro"
                subida={{
                  campaignId,
                  tipo: 'pago',
                  accion: 'adjuntar',
                  requerido: true,
                  mensajeExito: 'Comprobante adjunto.',
                }}
                ocultos={{ participacionId, ...ocultosObligacion }}
              >
                <SelectorDeSoporte porDefecto="comprobante" />
                <CampoNota />
              </FormularioOperativo>
            )}
          <Historial id={obligation.id} historial={historiales[obligation.id]} />
        </>
      )}
    </section>
  );
}
