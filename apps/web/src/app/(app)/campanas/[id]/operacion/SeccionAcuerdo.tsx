import {
  crearAcuerdoAction,
  registrarVersionDeAcuerdoAction,
  cancelarAcuerdoAction,
} from '@/lib/operacion-actions';
import type { PermisosDeOperacion } from '@/lib/operacion-comun';
import type { AcuerdoConHistorial, ProductoAsignado } from '@/lib/operacion-server';
import { fechaHora } from '../contenido/etiquetas';
import { AvisoSinPii, TerminosDeAcuerdo } from './CamposDeFormulario';
import { FormularioOperativo } from './FormularioOperativo';
import { ESTADO_DE_ACUERDO, MODO_DE_ACUERDO, PILL_DE_ACUERDO, fechaDeDia } from './etiquetas';
import styles from './operacion.module.css';

/**
 * Acuerdo de la participación: términos de la versión vigente, historial de versiones (inmutables) y, para
 * `agreement:manage`, los formularios de crear, registrar versión nueva y cancelar. Los montos solo aparecen
 * si el loader los trae (`finance:read`). Esta sección solo se renderiza si el loader trajo el acuerdo.
 */
export function SeccionAcuerdo({
  participacionId,
  datos,
  permisos,
  productos,
  puedeEscribir,
}: {
  participacionId: string;
  datos: AcuerdoConHistorial;
  permisos: PermisosDeOperacion;
  productos: readonly ProductoAsignado[];
  /** Campaña activa e influencer no retirado. */
  puedeEscribir: boolean;
}) {
  const { acuerdo, versiones } = datos;
  const opciones = productos.map((p) => ({ id: p.campaignProductId, nombre: `${p.brand} ${p.model}` }));
  const gestiona = permisos.gestionarAcuerdo && puedeEscribir;

  return (
    <section
      className={`card ${styles['seccion'] ?? ''}`}
      data-testid="seccion-acuerdo"
      aria-labelledby="titulo-acuerdo"
    >
      <div className={styles['seccionCabecera']}>
        <h2 id="titulo-acuerdo">Acuerdo</h2>
        <span
          className={PILL_DE_ACUERDO[acuerdo?.status ?? 'sin_acuerdo'] ?? 'pill neutro'}
          data-testid="acuerdo-estado"
          data-valor={acuerdo?.status ?? 'sin_acuerdo'}
        >
          {ESTADO_DE_ACUERDO[acuerdo?.status ?? 'sin_acuerdo']}
        </span>
      </div>

      {acuerdo === null ? (
        <>
          <p className={styles['vacio']} data-testid="acuerdo-vacio">
            Esta participación todavía no tiene acuerdo.
          </p>
          {gestiona && (
            <FormularioOperativo
              testid="form-crear-acuerdo"
              titulo="Crear el acuerdo"
              boton="Registrar acuerdo"
              accion={crearAcuerdoAction}
              ocultos={{ participacionId }}
            >
              <TerminosDeAcuerdo productos={opciones} mostrarMonto={permisos.verFinanzas} />
            </FormularioOperativo>
          )}
        </>
      ) : (
        <>
          <dl className={styles['datos']} data-testid="acuerdo-vigente">
            <div>
              <dt>Modo</dt>
              <dd data-testid="acuerdo-modo" data-valor={acuerdo.terms.compensationType}>
                {MODO_DE_ACUERDO[acuerdo.terms.compensationType] ?? acuerdo.terms.compensationType}
              </dd>
            </div>
            <div>
              <dt>Versión vigente</dt>
              <dd data-testid="acuerdo-version-vigente">V{acuerdo.currentVersion}</dd>
            </div>
            <div>
              <dt>Vigencia</dt>
              <dd>
                {fechaDeDia(acuerdo.terms.startsOn)} – {fechaDeDia(acuerdo.terms.endsOn)}
              </dd>
            </div>
            {acuerdo.terms.compensationType === 'barter' ? (
              <div>
                <dt>Pago</dt>
                <dd data-testid="pago-no-aplica">Pago: no aplica</dd>
              </div>
            ) : (
              acuerdo.terms.feeAmount !== undefined &&
              acuerdo.terms.feeAmount !== null && (
                <div>
                  <dt>Monto del fee</dt>
                  <dd data-testid="acuerdo-monto">
                    {acuerdo.terms.feeAmount} {acuerdo.terms.feeCurrency ?? ''}
                  </dd>
                </div>
              )
            )}
            {acuerdo.status === 'cancelled' && (
              <div>
                <dt>Cancelado</dt>
                <dd>
                  {fechaHora(acuerdo.cancelledAt ?? undefined)}
                  {acuerdo.cancelReason !== null ? ` · ${acuerdo.cancelReason}` : ''}
                </dd>
              </div>
            )}
          </dl>
          {acuerdo.terms.conditions !== null && (
            <div>
              <p className={styles['subtitulo']}>Condiciones</p>
              <p className={styles['texto']} data-testid="acuerdo-condiciones">
                {acuerdo.terms.conditions}
              </p>
            </div>
          )}
          <div>
            <p className={styles['subtitulo']}>Compromisos de producto</p>
            {acuerdo.terms.commitments.length === 0 ? (
              <p className={styles['vacio']} data-testid="acuerdo-sin-compromisos">
                Sin compromisos de producto en esta versión.
              </p>
            ) : (
              <ul className={styles['lista']} data-testid="acuerdo-compromisos">
                {acuerdo.terms.commitments.map((c) => (
                  <li key={c.campaignProductId} className={styles['itemMeta']}>
                    {c.productName} × {c.quantity}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <p className={styles['subtitulo']}>Historial de versiones</p>
            <ul className={styles['lista']} data-testid="acuerdo-historial">
              {[...versiones]
                .sort((a, b) => b.version - a.version)
                .map((v) => (
                  <li
                    key={v.id}
                    className={styles['item']}
                    data-testid="acuerdo-version"
                    data-version={v.version}
                  >
                    <div className={styles['itemCabecera']}>
                      <strong>V{v.version}</strong>
                      <span className={styles['itemMeta']}>
                        {MODO_DE_ACUERDO[v.compensationType] ?? v.compensationType} · {fechaHora(v.createdAt)}
                        {v.createdByName !== null ? ` · ${v.createdByName}` : ''}
                      </span>
                    </div>
                    <div className={styles['itemMeta']}>
                      Vigencia {fechaDeDia(v.startsOn)} – {fechaDeDia(v.endsOn)}
                      {v.feeAmount !== undefined && v.feeAmount !== null
                        ? ` · Fee ${v.feeAmount} ${v.feeCurrency ?? ''}`
                        : ''}
                      {v.commitments.length > 0
                        ? ` · ${v.commitments.map((c) => `${c.productName} × ${c.quantity}`).join(', ')}`
                        : ''}
                    </div>
                    {v.changeReason !== null && (
                      <div className={`${styles['itemMeta'] ?? ''} ${styles['texto'] ?? ''}`}>
                        Motivo: {v.changeReason}
                      </div>
                    )}
                  </li>
                ))}
            </ul>
          </div>

          {gestiona && acuerdo.status === 'active' && (
            <div className={styles['formularios']}>
              <FormularioOperativo
                testid="form-nueva-version-acuerdo"
                titulo="Registrar una versión nueva"
                boton="Registrar nueva versión"
                accion={registrarVersionDeAcuerdoAction}
                ocultos={{ agreementId: acuerdo.id, expectedVersion: acuerdo.currentVersion }}
              >
                <TerminosDeAcuerdo
                  productos={opciones}
                  mostrarMonto={permisos.verFinanzas}
                  inicial={{
                    modo: acuerdo.terms.compensationType,
                    feeAmount: acuerdo.terms.feeAmount,
                    feeCurrency: acuerdo.terms.feeCurrency,
                    startsOn: acuerdo.terms.startsOn,
                    endsOn: acuerdo.terms.endsOn,
                    conditions: acuerdo.terms.conditions,
                    compromisos: acuerdo.terms.commitments.map((c) => ({
                      id: c.campaignProductId,
                      cantidad: c.quantity,
                    })),
                  }}
                />
                <label style={{ gridColumn: '1 / -1' }}>
                  Motivo del cambio
                  <textarea name="changeReason" required maxLength={1000} rows={2} />
                </label>
                <AvisoSinPii />
              </FormularioOperativo>
              <FormularioOperativo
                testid="form-cancelar-acuerdo"
                titulo="Cancelar el acuerdo"
                boton="Cancelar acuerdo"
                variante="neutro"
                accion={cancelarAcuerdoAction}
                ocultos={{ agreementId: acuerdo.id }}
              >
                <label style={{ gridColumn: '1 / -1' }}>
                  Motivo de la cancelación
                  <textarea name="reason" required maxLength={500} rows={2} />
                </label>
                <AvisoSinPii />
              </FormularioOperativo>
            </div>
          )}
        </>
      )}
    </section>
  );
}
