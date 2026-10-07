import type { HistorialDeKpi, KpiDeParticipacion, KpiPactadoDelSheet } from '@tcl-kol-os/db';
import { KPI_METRICS } from '@tcl-kol-os/domain';
import {
  corregirMedicionKpiAction,
  registrarKpiObjetivoAction,
  registrarMedicionKpiAction,
} from '@/lib/operacion-actions';
import type { PermisosDeOperacion } from '@/lib/operacion-comun';
import { fechaHora } from '../contenido/etiquetas';
import { AvisoSinPii } from './CamposDeFormulario';
import { FormularioOperativo } from './FormularioOperativo';
import {
  COMPARADOR_DE_KPI,
  ESTADO_DE_KPI,
  ESTADO_DE_KPI_RESUMEN,
  PILL_DE_KPI,
  UNIDAD_DE_KPI,
  fechaDeDia,
  nombreDeMetrica,
  numero,
} from './etiquetas';
import styles from './operacion.module.css';

function SelectorDeMetrica() {
  return (
    <>
      <label>
        Métrica
        <select name="metric" defaultValue="views">
          {KPI_METRICS.map((m) => (
            <option key={m} value={m}>
              {nombreDeMetrica(m, null)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Etiqueta (solo para «Otra métrica»)
        <input type="text" name="otherLabel" maxLength={80} autoComplete="off" />
      </label>
    </>
  );
}

/**
 * KPI de la participación: tabla objetivo · real · cumplimiento · estado por métrica (bloque público), historial
 * de correcciones y formularios (objetivo: `kpi:target_manage`; medición y corrección: `kpi:measure`). Cada
 * métrica va en su propia fila: nunca se suman métricas distintas. Solo se renderiza si el loader trajo el KPI.
 */
export function SeccionKpi({
  participacionId,
  kpi,
  historial,
  sugerencia,
  permisos,
  puedeFijarObjetivos,
  puedeMedir,
}: {
  participacionId: string;
  kpi: KpiDeParticipacion;
  historial: HistorialDeKpi | null;
  sugerencia: KpiPactadoDelSheet | null;
  permisos: PermisosDeOperacion;
  puedeFijarObjetivos: boolean;
  puedeMedir: boolean;
}) {
  const filas = kpi.public;
  const hayMediciones = filas.some((f) => f.actual !== null);
  const objetivosVigentes = (historial?.public.targets ?? []).filter((t) => t.status === 'active');
  const medicionesVigentes = (historial?.public.measurements ?? []).filter((m) => m.current);
  const correcciones = (historial?.public.measurements ?? []).filter((m) => m.supersedesId !== null);
  const internas = new Map((historial?.internal.measurements ?? []).map((m) => [m.id, m]));

  return (
    <section
      className={`card ${styles['seccion'] ?? ''}`}
      data-testid="seccion-kpi"
      aria-labelledby="titulo-kpi"
    >
      <div className={styles['seccionCabecera']}>
        <h2 id="titulo-kpi">KPIs</h2>
        <span className="pill neutro" data-testid="kpi-resumen" data-valor={kpi.resumen.estado}>
          {ESTADO_DE_KPI_RESUMEN[kpi.resumen.estado] ?? kpi.resumen.estado}
        </span>
      </div>

      {filas.length === 0 ? (
        <p className={styles['vacio']} data-testid="kpi-sin-objetivos">
          Todavía no hay objetivos de KPI para esta participación.
        </p>
      ) : (
        <>
          {!hayMediciones && (
            <p className={styles['aviso']} data-testid="kpi-sin-datos">
              Sin datos: aún no hay mediciones registradas.
            </p>
          )}
          <div className={styles['tablaEnvoltura']}>
            <table className={styles['tabla']} data-testid="kpi-tabla">
              <thead>
                <tr>
                  <th scope="col">Métrica</th>
                  <th scope="col" className={styles['numero']}>
                    Objetivo
                  </th>
                  <th scope="col" className={styles['numero']}>
                    Real
                  </th>
                  <th scope="col" className={styles['numero']}>
                    Cumplimiento
                  </th>
                  <th scope="col">Estado</th>
                </tr>
              </thead>
              <tbody>
                {filas.map((f, i) => (
                  <tr
                    key={`${f.metric}-${f.otherLabel ?? ''}-${f.deliverableId ?? ''}-${f.platform ?? ''}-${i}`}
                    data-testid="kpi-fila"
                    data-metrica={f.metric}
                  >
                    <th scope="row">
                      {nombreDeMetrica(f.metric, f.otherLabel)}
                      {f.platform !== null ? ` · ${f.platform}` : ''}
                      <div className={styles['itemMeta']}>
                        {COMPARADOR_DE_KPI[f.comparator] ?? f.comparator}
                        {UNIDAD_DE_KPI[f.unit] ? ` · ${UNIDAD_DE_KPI[f.unit]}` : ''}
                      </div>
                    </th>
                    <td className={styles['numero']} data-testid="kpi-objetivo">
                      {numero(f.target)}
                    </td>
                    <td className={styles['numero']} data-testid="kpi-real">
                      {f.actual === null ? 'Sin datos' : numero(f.actual)}
                    </td>
                    <td className={styles['numero']} data-testid="kpi-cumplimiento">
                      {f.achievement === null ? '—' : `${numero(f.achievement)} %`}
                    </td>
                    <td>
                      <span
                        className={PILL_DE_KPI[f.estado] ?? 'pill neutro'}
                        data-testid="kpi-estado"
                        data-valor={f.estado}
                      >
                        {ESTADO_DE_KPI[f.estado] ?? f.estado}
                      </span>
                      {f.observedAt !== null && (
                        <div className={styles['itemMeta']}>{fechaHora(f.observedAt)}</div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {historial !== null && correcciones.length > 0 && (
        <div>
          <p className={styles['subtitulo']}>Historial de correcciones</p>
          <ul className={styles['historial']} data-testid="kpi-correcciones">
            {correcciones.map((m) => (
              <li key={m.id} data-testid="kpi-correccion">
                {nombreDeMetrica(m.metric, m.otherLabel)}: corregida a {numero(m.value)} ·{' '}
                {fechaHora(m.recordedAt)}
                {internas.get(m.id)?.recordedByName ? ` · ${internas.get(m.id)?.recordedByName}` : ''}
                {internas.get(m.id)?.correctionReason
                  ? ` · Motivo: ${internas.get(m.id)?.correctionReason}`
                  : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      {puedeFijarObjetivos && (
        <FormularioOperativo
          testid="form-registrar-objetivo"
          titulo="Registrar un objetivo"
          boton="Registrar objetivo"
          accion={registrarKpiObjetivoAction}
          ocultos={{
            participacionId,
            ...(sugerencia !== null ? { sheetTextHash: sugerencia.provenance.textHash } : {}),
          }}
        >
          {sugerencia !== null && (
            <div style={{ gridColumn: '1 / -1' }} data-testid="kpi-sugerencia-sheet">
              <p className={styles['subtitulo']}>KPI pactado en el Sheet (sugerencia)</p>
              {/* Texto literal de un tercero: no confiable, se muestra solo como texto. */}
              <p className={styles['texto']} data-testid="kpi-sugerencia-texto">
                {sugerencia.text}
              </p>
              {sugerencia.ambiguous && (
                <p className={styles['itemMeta']}>
                  Hay varias filas con KPI distinto en el Sheet: se muestra la primera.
                </p>
              )}
              <label className={styles['checkbox']}>
                <input type="checkbox" name="usarSugerenciaDelSheet" value="1" />
                Registrar este objetivo con la procedencia del Sheet
              </label>
            </div>
          )}
          <SelectorDeMetrica />
          <label>
            Valor objetivo
            <input type="text" name="targetValue" required inputMode="decimal" autoComplete="off" />
          </label>
          <label>
            Comparador
            <select name="comparator" defaultValue="gte">
              <option value="gte">Al menos</option>
              <option value="lte">Como máximo</option>
            </select>
          </label>
          <label>
            Inicio del periodo (opcional)
            <input type="date" name="periodStart" />
          </label>
          <label>
            Fin del periodo (opcional)
            <input type="date" name="periodEnd" />
          </label>
          {objetivosVigentes.length > 0 && (
            <label style={{ gridColumn: '1 / -1' }}>
              Reemplaza el objetivo vigente (opcional)
              <select name="supersedesId" defaultValue="">
                <option value="">No reemplaza ninguno</option>
                {objetivosVigentes.map((t) => (
                  <option key={t.id} value={t.id}>
                    {nombreDeMetrica(t.metric, t.otherLabel)} ·{' '}
                    {COMPARADOR_DE_KPI[t.comparator] ?? t.comparator} {numero(t.targetValue)}
                  </option>
                ))}
              </select>
            </label>
          )}
        </FormularioOperativo>
      )}

      {puedeMedir && (
        <>
          <FormularioOperativo
            testid="form-registrar-medicion"
            titulo="Registrar una medición"
            boton="Registrar medición"
            accion={registrarMedicionKpiAction}
            ocultos={{ participacionId }}
          >
            <SelectorDeMetrica />
            <label>
              Valor medido
              <input type="text" name="value" required inputMode="decimal" autoComplete="off" />
            </label>
            <label>
              Fecha de la observación
              <input type="date" name="observedAt" required />
            </label>
          </FormularioOperativo>
          {medicionesVigentes.length > 0 && (
            <FormularioOperativo
              testid="form-corregir-medicion"
              titulo="Corregir una medición"
              boton="Corregir medición"
              variante="neutro"
              accion={corregirMedicionKpiAction}
            >
              <label>
                Medición a corregir
                <select name="measurementId" required defaultValue="">
                  <option value="" disabled>
                    Elige una medición
                  </option>
                  {medicionesVigentes.map((m) => (
                    <option key={m.id} value={m.id}>
                      {nombreDeMetrica(m.metric, m.otherLabel)} · {numero(m.value)} ·{' '}
                      {fechaDeDia(m.observedAt)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Valor correcto
                <input type="text" name="value" required inputMode="decimal" autoComplete="off" />
              </label>
              <label style={{ gridColumn: '1 / -1' }}>
                Motivo de la corrección
                <textarea name="correctionReason" required maxLength={500} rows={2} />
              </label>
              <AvisoSinPii />
            </FormularioOperativo>
          )}
        </>
      )}
      {permisos.verKpi && !puedeFijarObjetivos && !puedeMedir && (
        <p className={styles['itemMeta']} data-testid="kpi-solo-lectura">
          Tu rol consulta los KPI; no los modifica.
        </p>
      )}
    </section>
  );
}
