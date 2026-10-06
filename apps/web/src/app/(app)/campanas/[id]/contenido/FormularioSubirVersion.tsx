'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ACEPTA_GUIONES } from './etiquetas';
import styles from './contenido.module.css';

interface RespuestaDeSubida {
  readonly ok?: boolean;
  readonly mensaje?: string;
  readonly codigo?: string;
  readonly resultado?: 'registrada' | 'ya_registrada';
  readonly archivoDuplicado?: boolean;
  readonly deliverableId?: string;
  readonly participacionId?: string;
  readonly version?: number;
  readonly aviso?: string;
}

/**
 * Sube el archivo de un guion como la versión SIGUIENTE del entregable. La subida va por el route
 * handler `POST /api/campanas/[id]/contenido/guiones` (las server actions de Next 15 limitan el cuerpo
 * a 1 MB). Nunca sobrescribe: un archivo nuevo es una versión nueva; el mismo archivo no crea otra.
 */
export function FormularioSubirVersion({
  campaignId,
  participacionId,
  deliverableId,
  maxMb,
}: {
  campaignId: string;
  participacionId: string;
  deliverableId: string;
  maxMb: number;
}) {
  const router = useRouter();
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [aviso, setAviso] = useState<string | undefined>(undefined);
  const enVuelo = useRef(false);
  const formulario = useRef<HTMLFormElement>(null);

  const enviar = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (enVuelo.current) return; // doble clic: una sola subida
    const entrada = formulario.current?.elements.namedItem('archivo');
    const archivo = entrada instanceof HTMLInputElement ? entrada.files?.[0] : undefined;
    if (archivo === undefined) {
      setError('Selecciona un archivo.');
      return;
    }
    if (archivo.size > maxMb * 1024 * 1024) {
      setError(`El archivo supera el límite de ${maxMb} MB.`);
      return;
    }
    enVuelo.current = true;
    setEnviando(true);
    setError(undefined);
    setAviso(undefined);
    try {
      const cuerpo = new FormData();
      cuerpo.set('archivo', archivo);
      cuerpo.set('participacionId', participacionId);
      cuerpo.set('deliverableId', deliverableId);
      const respuesta = await fetch(`/api/campanas/${campaignId}/contenido/guiones`, {
        method: 'POST',
        body: cuerpo,
      });
      const datos = (await respuesta.json().catch(() => ({}))) as RespuestaDeSubida;
      if (!respuesta.ok || datos.ok !== true) {
        setError(datos.mensaje ?? 'No se pudo subir el guion. Inténtalo de nuevo.');
        return;
      }
      formulario.current?.reset();
      if (datos.resultado === 'ya_registrada') {
        setAviso(
          `Ese archivo ya estaba registrado como la versión V${datos.version ?? ''}: no se creó otra.`,
        );
      } else if (datos.archivoDuplicado === true) {
        setAviso('El archivo ya existía en las fuentes de la campaña; se registró como una versión nueva.');
      }
      router.push(
        `/campanas/${campaignId}/contenido/${participacionId}/${deliverableId}${
          datos.version === undefined ? '' : `?v=${datos.version}`
        }`,
      );
      router.refresh();
    } catch {
      setError('No se pudo subir el guion. Revisa tu conexión e inténtalo de nuevo.');
    } finally {
      enVuelo.current = false;
      setEnviando(false);
    }
  };

  return (
    <form
      ref={formulario}
      className={styles['formulario']}
      onSubmit={enviar}
      data-testid="contenido-subir-form"
    >
      <label>
        Subir una versión nueva del guion
        <input
          type="file"
          name="archivo"
          accept={ACEPTA_GUIONES}
          required
          data-testid="contenido-subir-archivo"
        />
      </label>
      <p className={styles['nota']} style={{ margin: 0, fontSize: 12 }}>
        PDF, PPTX, DOCX, XLSX, CSV, MD o imagen · hasta {maxMb} MB. Es interno de SmartPR: nunca se
        sobrescribe una versión anterior.
      </p>
      <div className={styles['acciones']}>
        <button type="submit" className="btn pri" disabled={enviando} data-testid="contenido-subir-submit">
          {enviando ? 'Subiendo…' : 'Subir versión'}
        </button>
      </div>
      {error !== undefined && (
        <p className={styles['error']} role="alert" data-testid="contenido-subir-error">
          {error}
        </p>
      )}
      {aviso !== undefined && error === undefined && (
        <p className={styles['exito']} role="status" data-testid="contenido-subir-aviso">
          {aviso}
        </p>
      )}
    </form>
  );
}
