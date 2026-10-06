'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { registrarRevisionHumanaDeContenido, solicitarAnalisisDeContenido } from '@/lib/contenido-actions';
import { MOTIVO_DE_PRONTITUD } from './etiquetas';
import styles from './contenido.module.css';

/**
 * Acciones de REVISIÓN de una versión abierta: pedir el análisis asistido (o reanalizar) y registrar la
 * revisión humana contra el Brief aprobado vigente. Ninguna aprueba: aprobar es otra decisión, con su
 * propio diálogo. La IA analiza y señala; la revisión humana la registra una persona por la interfaz.
 */
export function AccionesDeRevision({
  campaignId,
  versionId,
  numeroDeVersion,
  /** Hay una revisión (CURRENT o STALE) de la que reanalizar; si no, «Solicitar análisis». */
  hayRevision,
  /** Motivo por el que no se puede pedir el análisis ahora (`ready` ⇒ `undefined`). */
  prontitud,
  briefVigenteNumero,
  huellaDelBrief,
  /** Token único por render del servidor: un doble clic reutiliza el mismo análisis. */
  claveDeIdempotencia,
}: {
  campaignId: string;
  versionId: string;
  numeroDeVersion: number;
  hayRevision: boolean;
  prontitud: string | undefined;
  briefVigenteNumero: number | undefined;
  huellaDelBrief: string | undefined;
  claveDeIdempotencia: string;
}) {
  const router = useRouter();
  const [pendiente, iniciar] = useTransition();
  const [errorDeAnalisis, setErrorDeAnalisis] = useState<string | undefined>(undefined);
  const [mensaje, setMensaje] = useState<string | undefined>(undefined);
  const [abierto, setAbierto] = useState(false);
  const [confirmado, setConfirmado] = useState(false);
  const [errorDeRevision, setErrorDeRevision] = useState<string | undefined>(undefined);
  const enVuelo = useRef(false);

  const sinBrief = briefVigenteNumero === undefined || huellaDelBrief === undefined;
  const puedeAnalizar = prontitud === 'ready';

  const pedirAnalisis = (modo: 'ensure' | 'reanalyze') => {
    if (enVuelo.current) return;
    enVuelo.current = true;
    setErrorDeAnalisis(undefined);
    setMensaje(undefined);
    iniciar(async () => {
      try {
        const r = await solicitarAnalisisDeContenido(campaignId, versionId, modo, claveDeIdempotencia);
        if (r.ok) {
          setMensaje(
            r.resultado === 'reutilizado'
              ? 'Ya había un análisis vigente con los mismos insumos: no se repitió.'
              : 'Análisis listo. Los hallazgos son observaciones para la persona que revisa; no aprueban nada.',
          );
        } else {
          setErrorDeAnalisis(r.error);
        }
        router.refresh();
      } finally {
        enVuelo.current = false;
      }
    });
  };

  const registrarRevision = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (enVuelo.current || sinBrief || !confirmado) return;
    const nota = String(new FormData(e.currentTarget).get('nota') ?? '');
    enVuelo.current = true;
    setErrorDeRevision(undefined);
    iniciar(async () => {
      try {
        const r = await registrarRevisionHumanaDeContenido(
          campaignId,
          versionId,
          huellaDelBrief ?? '',
          nota === '' ? undefined : nota,
        );
        if (r.ok) {
          setAbierto(false);
          setConfirmado(false);
        } else {
          setErrorDeRevision(r.error);
        }
        router.refresh();
      } finally {
        enVuelo.current = false;
      }
    });
  };

  return (
    <div className={styles['formulario']} data-testid="contenido-acciones-revision">
      <div className={styles['acciones']}>
        <button
          type="button"
          className="btn"
          onClick={() => pedirAnalisis(hayRevision ? 'reanalyze' : 'ensure')}
          disabled={pendiente || !puedeAnalizar}
          data-testid={hayRevision ? 'contenido-reanalizar' : 'contenido-solicitar-analisis'}
        >
          {pendiente && !abierto ? 'Analizando…' : hayRevision ? 'Reanalizar' : 'Solicitar análisis'}
        </button>
        {!abierto && (
          <button
            type="button"
            className="btn pri"
            onClick={() => {
              setErrorDeRevision(undefined);
              setAbierto(true);
            }}
            disabled={pendiente || sinBrief}
            data-testid="contenido-revision-humana-abrir"
          >
            {sinBrief
              ? 'Registrar revisión humana'
              : `Registrar revisión humana contra el Brief V${briefVigenteNumero}`}
          </button>
        )}
      </div>

      {!puedeAnalizar && prontitud !== undefined && (
        <p className={styles['nota']} style={{ margin: 0 }} data-testid="contenido-analisis-motivo">
          {MOTIVO_DE_PRONTITUD[prontitud] ?? 'El análisis asistido no está disponible ahora.'}
        </p>
      )}
      {sinBrief && (
        <p className={styles['nota']} style={{ margin: 0 }} data-testid="contenido-sin-brief-revision">
          Todavía no existe un Brief aprobado para usar como documento rector: no se puede registrar la
          revisión.
        </p>
      )}
      {errorDeAnalisis !== undefined && (
        <p className={styles['error']} role="alert" data-testid="contenido-analisis-error">
          {errorDeAnalisis}
        </p>
      )}
      {mensaje !== undefined && errorDeAnalisis === undefined && (
        <p className={styles['exito']} role="status" data-testid="contenido-analisis-ok">
          {mensaje}
        </p>
      )}

      {abierto && !sinBrief && (
        <form
          className={styles['formulario']}
          onSubmit={registrarRevision}
          data-testid="contenido-revision-humana-form"
        >
          <p className={styles['nota']} style={{ margin: 0 }}>
            La revisión humana declara que una persona leyó la V{numeroDeVersion} contra el Brief V
            {briefVigenteNumero}. Es válida para aprobar (igual que la asistida) y queda registrada a tu
            nombre; si el Brief aprobado cambia, deja de estar vigente.
          </p>
          <label className={styles['checkbox']}>
            <input
              type="checkbox"
              checked={confirmado}
              onChange={(e) => setConfirmado(e.target.checked)}
              required
              data-testid="contenido-revision-humana-checkbox"
            />
            Confirmo que revisé la versión V{numeroDeVersion} de este guion contra el Brief aprobado vigente
            (V
            {briefVigenteNumero}).
          </label>
          <label>
            Nota (opcional)
            <textarea name="nota" maxLength={1000} rows={2} data-testid="contenido-revision-humana-nota" />
          </label>
          {errorDeRevision !== undefined && (
            <p className={styles['error']} role="alert" data-testid="contenido-revision-humana-error">
              {errorDeRevision}
            </p>
          )}
          <div className={styles['acciones']}>
            <button
              type="submit"
              className="btn pri"
              disabled={pendiente || !confirmado}
              data-testid="contenido-revision-humana-confirmar"
            >
              {pendiente ? 'Registrando…' : 'Registrar revisión humana'}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => setAbierto(false)}
              disabled={pendiente}
              data-testid="contenido-revision-humana-cancelar"
            >
              Cancelar
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
