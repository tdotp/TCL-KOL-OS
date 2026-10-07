'use client';

import { useEffect, useRef, useState } from 'react';
import { guardarPiiAction, revelarPiiAction } from '@/lib/operacion-actions';
import { FormularioOperativo } from './FormularioOperativo';
import { ETIQUETA_DE_CAMPO_PII } from './etiquetas';
import styles from './operacion.module.css';

type CampoPii = 'document_id' | 'phone' | 'address';

export interface ResumenDePiiVista {
  readonly recordId: string;
  readonly version: number;
  readonly hasDocumentId: boolean;
  readonly hasPhone: boolean;
  readonly hasAddress: boolean;
  readonly erased: boolean;
}

/** Cuánto tiempo quedan visibles los valores revelados antes de ocultarse solos. */
const SEGUNDOS_VISIBLE = 60;

/**
 * «Datos de entrega» (dirección, teléfono, cédula) del influencer. Aparte del resto del envío: solo existe con
 * capacidad PII. Muestra QUÉ campos existen; los valores solo salen al hacer clic en «Revelar datos»
 * (`revelarPiiAction`, auditada) y viven únicamente en el estado de este componente: no van a atributos,
 * URLs, almacenamiento ni consola, y se ocultan solos a los 60 s. «Guardar datos personales» escribe una
 * versión nueva cifrada (los campos vacíos se conservan).
 */
export function BloqueDatosDeEntrega({
  participacionId,
  resumen,
  puedeRevelar,
  puedeGuardar,
}: {
  participacionId: string;
  resumen: ResumenDePiiVista | null;
  puedeRevelar: boolean;
  puedeGuardar: boolean;
}) {
  const [valores, setValores] = useState<Readonly<Partial<Record<CampoPii, string>>> | undefined>(undefined);
  const [mensaje, setMensaje] = useState<{ ok: boolean; texto: string } | undefined>(undefined);
  const [pendiente, setPendiente] = useState(false);
  const enVuelo = useRef(false);

  useEffect(() => {
    if (valores === undefined) return;
    const t = setTimeout(() => setValores(undefined), SEGUNDOS_VISIBLE * 1000);
    return () => clearTimeout(t);
  }, [valores]);

  // Al cambiar la versión (se guardó otra) los valores revelados quedan viejos: se ocultan.
  const version = resumen?.version;
  useEffect(() => setValores(undefined), [version]);

  const campos: readonly CampoPii[] =
    resumen === null || resumen.erased
      ? []
      : [
          ...(resumen.hasDocumentId ? (['document_id'] as const) : []),
          ...(resumen.hasPhone ? (['phone'] as const) : []),
          ...(resumen.hasAddress ? (['address'] as const) : []),
        ];

  const revelar = async () => {
    if (enVuelo.current || resumen === null || campos.length === 0) return;
    enVuelo.current = true;
    setPendiente(true);
    setMensaje(undefined);
    try {
      const r = await revelarPiiAction(resumen.recordId, campos);
      if (r.ok) {
        setValores({ ...r.values });
        setMensaje({ ok: true, texto: r.message });
      } else {
        setValores(undefined);
        setMensaje({ ok: false, texto: r.message });
      }
    } catch {
      setMensaje({ ok: false, texto: 'No se pudieron revelar los datos. Inténtalo de nuevo.' });
    } finally {
      enVuelo.current = false;
      setPendiente(false);
    }
  };

  const existe = (c: CampoPii): boolean =>
    resumen !== null &&
    !resumen.erased &&
    (c === 'document_id' ? resumen.hasDocumentId : c === 'phone' ? resumen.hasPhone : resumen.hasAddress);

  return (
    <div
      className={styles['pii']}
      data-testid="bloque-datos-entrega"
      role="group"
      aria-labelledby="titulo-datos-entrega"
    >
      <h3 id="titulo-datos-entrega" className={styles['formularioTitulo']}>
        Datos de entrega
      </h3>
      <p className={styles['itemMeta']}>
        Datos personales del influencer, cifrados. Revelarlos queda registrado en la auditoría.
      </p>

      {resumen === null ? (
        <p className={styles['vacio']} data-testid="datos-entrega-vacios">
          Todavía no hay datos de entrega guardados.
        </p>
      ) : resumen.erased ? (
        <p className={styles['vacio']} data-testid="datos-entrega-borrados">
          Los datos personales de este influencer fueron borrados.
        </p>
      ) : (
        <ul className={styles['lista']} data-testid="datos-entrega-campos">
          {(['document_id', 'phone', 'address'] as const).map((c) => (
            <li key={c} className={styles['itemMeta']} data-testid={`pii-campo-${c}`}>
              {ETIQUETA_DE_CAMPO_PII[c]}:{' '}
              {valores !== undefined && existe(c) ? (
                <span className={styles['valorRevelado']} data-testid={`pii-valor-${c}`}>
                  {valores[c] ?? '—'}
                </span>
              ) : existe(c) ? (
                'guardado'
              ) : (
                'sin registrar'
              )}
            </li>
          ))}
        </ul>
      )}

      {puedeRevelar && campos.length > 0 && (
        <div className={styles['acciones']}>
          {valores === undefined ? (
            <button type="button" className="btn" onClick={revelar} disabled={pendiente}>
              Revelar datos
            </button>
          ) : (
            <button type="button" className="btn" onClick={() => setValores(undefined)}>
              Ocultar datos
            </button>
          )}
        </div>
      )}
      <div aria-live="polite">
        {mensaje !== undefined &&
          (mensaje.ok ? (
            <p className={styles['exito']} role="status" data-testid="revelar-datos-resultado">
              {mensaje.texto}
            </p>
          ) : (
            <p className={styles['error']} role="alert" data-testid="revelar-datos-resultado">
              {mensaje.texto}
            </p>
          ))}
      </div>

      {puedeGuardar && (
        <FormularioOperativo
          testid="form-guardar-datos-personales"
          titulo="Guardar datos personales"
          boton="Guardar datos personales"
          accion={guardarPiiAction}
          ocultos={{ participacionId }}
        >
          <label>
            Documento de identidad
            <input type="text" name="documentId" maxLength={40} autoComplete="off" />
          </label>
          <label>
            Teléfono
            <input type="text" name="phone" maxLength={40} autoComplete="off" />
          </label>
          <label style={{ gridColumn: '1 / -1' }}>
            Dirección de entrega
            <textarea name="address" maxLength={300} rows={2} autoComplete="off" />
          </label>
          <p className={styles['itemMeta']} style={{ gridColumn: '1 / -1', margin: 0 }}>
            Deja vacío lo que no cambia: se conserva.
          </p>
        </FormularioOperativo>
      )}
    </div>
  );
}
