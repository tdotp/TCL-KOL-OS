'use client';

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { type EstadoDeAccion, ESTADO_INICIAL, MENSAJE_GENERICO } from '@/lib/operacion-cliente';
import { ACEPTA_EVIDENCIA } from './etiquetas';
import styles from './operacion.module.css';

type AccionDeOperacion = (previo: EstadoDeAccion, formData: FormData) => Promise<EstadoDeAccion>;

/** Subida de un soporte por `POST /api/campanas/[id]/operacion/evidencia` (las server actions limitan el cuerpo a 1 MB). */
export interface SubidaDeEvidencia {
  readonly campaignId: string;
  readonly tipo: 'documento_cobro' | 'envio' | 'pago';
  readonly accion: string;
  /** `true`: sin archivo no se envía. `false`: con archivo va por la ruta de subida; sin archivo, por la server action. */
  readonly requerido: boolean;
  readonly etiquetaArchivo?: string;
  /** Mensaje de éxito de la subida (el de la server action lo pone el servidor). */
  readonly mensajeExito?: string;
}

interface RespuestaDeSubida {
  readonly ok?: boolean;
  readonly mensaje?: string;
  readonly campo?: string;
  readonly repetido?: boolean;
  readonly sinDocumentoValidado?: boolean;
}

function nuevaClave(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Formulario de escritura de Operación. Genera al montar el campo oculto `idempotencyKey` (uuid; se renueva
 * tras un éxito), manda los campos al `accion` (server action con firma `(previo, formData)`) o, si trae un
 * archivo, a la ruta de subida; deshabilita el botón mientras envía (doble clic = un solo envío) y muestra el
 * resultado como `role="status"` (éxito) o `role="alert"` (error), con el foco en el campo con problema.
 * Nunca guarda ni registra lo que la persona escribió.
 */
export function FormularioOperativo({
  testid,
  boton,
  titulo,
  accion,
  subida,
  ocultos,
  variante = 'pri',
  children,
}: {
  /** `data-testid` del formulario: `form-<nombre>`. */
  testid: string;
  /** Nombre accesible del botón (estable). */
  boton: string;
  titulo?: string;
  accion?: AccionDeOperacion;
  subida?: SubidaDeEvidencia;
  ocultos?: Readonly<Record<string, string | number>>;
  variante?: 'pri' | 'neutro';
  children?: ReactNode;
}) {
  const router = useRouter();
  const [clave, setClave] = useState('');
  const [generacion, setGeneracion] = useState(0);
  const [pendiente, setPendiente] = useState(false);
  const [estado, setEstado] = useState<EstadoDeAccion | undefined>(undefined);
  const enVuelo = useRef(false);

  useEffect(() => {
    setClave(nuevaClave());
  }, []);

  const enfocar = (form: HTMLFormElement, campo: string | undefined) => {
    if (campo === undefined) return;
    const el = form.elements.namedItem(campo);
    const objetivo = el instanceof RadioNodeList ? el[0] : el;
    if (objetivo instanceof HTMLElement) objetivo.focus();
  };

  const enviar = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (enVuelo.current || clave === '') return; // doble clic: un solo envío
    const form = e.currentTarget;
    const datos = new FormData(form);
    datos.set('idempotencyKey', clave);
    const archivo = datos.get('archivo');
    const hayArchivo = archivo instanceof File && archivo.size > 0;

    enVuelo.current = true;
    setPendiente(true);
    setEstado(undefined);
    let resultado: EstadoDeAccion;
    try {
      if (subida !== undefined && (hayArchivo || subida.requerido)) {
        if (!hayArchivo) {
          resultado = { ok: false, message: 'Selecciona un archivo.', field: 'archivo' };
        } else {
          datos.set('tipo', subida.tipo);
          datos.set('accion', subida.accion);
          const respuesta = await fetch(`/api/campanas/${subida.campaignId}/operacion/evidencia`, {
            method: 'POST',
            body: datos,
          });
          const cuerpo = (await respuesta.json().catch(() => ({}))) as RespuestaDeSubida;
          if (respuesta.ok && cuerpo.ok === true) {
            const base =
              cuerpo.repetido === true
                ? 'Ese registro ya estaba hecho.'
                : (subida.mensajeExito ?? 'Registrado con su soporte.');
            resultado = {
              ok: true,
              message:
                cuerpo.sinDocumentoValidado === true
                  ? `${base} Quedó marcado sin documento de cobro validado.`
                  : base,
              ...(cuerpo.repetido === true ? { repeated: true } : {}),
            };
          } else {
            resultado = {
              ok: false,
              message: cuerpo.mensaje ?? 'No se pudo subir el archivo. Inténtalo de nuevo.',
              ...(cuerpo.campo !== undefined ? { field: cuerpo.campo } : {}),
            };
          }
        }
      } else if (accion !== undefined) {
        datos.delete('archivo');
        resultado = await accion(ESTADO_INICIAL, datos);
      } else {
        resultado = { ok: false, message: MENSAJE_GENERICO };
      }
    } catch {
      resultado = { ok: false, message: 'No se pudo enviar. Revisa tu conexión e inténtalo de nuevo.' };
    } finally {
      enVuelo.current = false;
      setPendiente(false);
    }
    setEstado(resultado);
    if (resultado.ok) {
      // Remonta los campos (vacíos) y renueva la clave: el siguiente envío es otra solicitud.
      setGeneracion((g) => g + 1);
      setClave(nuevaClave());
      router.refresh();
    } else {
      enfocar(form, resultado.field);
    }
  };

  return (
    <form
      className={styles['formulario']}
      onSubmit={enviar}
      aria-label={titulo ?? boton}
      aria-busy={pendiente}
      data-testid={testid}
    >
      {titulo !== undefined && <h4 className={styles['formularioTitulo']}>{titulo}</h4>}
      <input type="hidden" name="idempotencyKey" value={clave} readOnly />
      {ocultos !== undefined &&
        Object.entries(ocultos).map(([nombre, valor]) => (
          <input key={nombre} type="hidden" name={nombre} value={String(valor)} readOnly />
        ))}
      <div key={generacion} className={styles['campos']}>
        {children}
        {subida !== undefined && (
          <label>
            {subida.etiquetaArchivo ?? (subida.requerido ? 'Archivo de soporte' : 'Soporte (opcional)')}
            <input
              type="file"
              name="archivo"
              accept={ACEPTA_EVIDENCIA}
              {...(subida.requerido ? { required: true } : {})}
            />
          </label>
        )}
      </div>
      <div className={styles['acciones']}>
        <button
          type="submit"
          className={variante === 'pri' ? 'btn pri' : 'btn'}
          disabled={pendiente || clave === ''}
        >
          {boton}
        </button>
        {pendiente && <span className={styles['itemMeta']}>Enviando…</span>}
      </div>
      <div aria-live="polite" data-testid={`${testid}-resultado`}>
        {estado !== undefined &&
          (estado.ok ? (
            <p className={styles['exito']} role="status" data-ok="true">
              {estado.message}
            </p>
          ) : (
            <p className={styles['error']} role="alert" data-ok="false" data-codigo={estado.code ?? ''}>
              {estado.message}
            </p>
          ))}
      </div>
    </form>
  );
}
