'use client';

import { useActionState, useRef, useState } from 'react';
import { cargarFuente } from '@/lib/actions';

/**
 * UI-06 · Carga de fuentes.
 *
 * La validación real ocurre en el servidor leyendo los primeros bytes del
 * archivo: el `accept` del navegador es comodidad, no seguridad. Un ejecutable
 * renombrado a `.pdf` pasa este filtro y se rechaza en el servidor (caso S-05).
 */
export function FormularioFuente({ campaignId }: { campaignId: string }) {
  const [estado, accion, enviando] = useActionState(cargarFuente, {});
  const [nombre, setNombre] = useState<string>('');
  const [pesoMb, setPesoMb] = useState<number | undefined>(undefined);
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <form
      ref={formRef}
      action={async (fd) => {
        await accion(fd);
        formRef.current?.reset();
        setNombre('');
        setPesoMb(undefined);
      }}
      className="card"
    >
      <h2>Cargar fuente</h2>

      {estado.error !== undefined && (
        <div className="aviso error">
          <strong>No se pudo cargar el archivo</strong>
          {estado.error}
        </div>
      )}

      {estado.ok === true && (
        <div className="aviso" style={{ borderColor: 'var(--ok)', background: 'var(--ok-soft)' }}>
          <strong>Archivo cargado</strong>
          {estado.aviso ?? 'El procesamiento se ejecuta en segundo plano; puede seguir trabajando.'}
        </div>
      )}

      <div className="g2">
        <div className="fld">
          <label htmlFor="archivo">Archivo *</label>
          <input
            id="archivo"
            name="archivo"
            type="file"
            required
            accept=".pdf,.pptx,.docx,.png,.jpg,.jpeg"
            onChange={(e) => {
              const f = e.target.files?.[0];
              setNombre(f?.name ?? '');
              setPesoMb(f === undefined ? undefined : Math.round((f.size / 1024 / 1024) * 10) / 10);
            }}
          />
        </div>
        <div className="fld">
          <label htmlFor="tipo">Tipo de fuente</label>
          <select id="tipo" name="tipo" defaultValue="ppt_global">
            <option value="ppt_global">PPT de campaña (TCL China)</option>
            <option value="ficha_tecnica">Ficha técnica</option>
            <option value="brief_cliente">Brief del cliente</option>
            <option value="imagen">Imagen de referencia</option>
            <option value="otro">Otro</option>
          </select>
        </div>
      </div>

      <input type="hidden" name="campaignId" value={campaignId} />

      {nombre !== '' && (
        <p className="sub" style={{ marginBottom: 12 }}>
          {nombre}
          {pesoMb !== undefined && ` · ${pesoMb} MB`}
          {pesoMb !== undefined && pesoMb > 10 && ' · archivo grande, el procesamiento tomará unos segundos'}
        </p>
      )}

      <button className="btn pri" type="submit" disabled={enviando}>
        {enviando ? 'Cargando…' : 'Cargar'}
      </button>

      <p className="sub" style={{ marginTop: 12, marginBottom: 0, fontSize: 13 }}>
        PDF, PPTX, DOCX, PNG y JPG hasta 50 MB. El tipo se verifica por el contenido real del archivo, no por
        su extensión.
      </p>
    </form>
  );
}
