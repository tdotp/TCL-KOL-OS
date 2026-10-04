'use client';

import { useActionState, useRef, useState } from 'react';
import { cargarFuente } from '@/lib/actions';

export function FormularioFuente({ campaignId }: { campaignId: string }) {
  const [estado, accion, enviando] = useActionState(cargarFuente, {});
  const [nombre, setNombre] = useState('');
  const [pesoMb, setPesoMb] = useState<number | undefined>(undefined);
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <form
      ref={formRef}
      action={async (fd) => {
        await accion(fd);
        formRef.current?.reset();
        setNombre('');
        setPesoMb(undefined);
      }}
      className="card source-upload-card"
    >
      {estado.error !== undefined && (
        <div className="aviso error"><strong>No se pudo cargar el archivo</strong>{estado.error}</div>
      )}
      {estado.ok === true && (
        <div className="aviso success"><strong>Archivo cargado</strong>{estado.aviso ?? 'El procesamiento continúa en segundo plano.'}</div>
      )}

      <div className="upload-zone" onClick={() => inputRef.current?.click()} role="button" tabIndex={0}>
        <div className="upload-float" aria-hidden="true"><span>↥</span></div>
        <h2>Subir fuentes</h2>
        <p>PPT, fichas técnicas, briefs, documentos e imágenes de referencia.</p>
        <button className="btn pri" type="button" onClick={(e) => { e.stopPropagation(); inputRef.current?.click(); }}>
          Elegir archivo
        </button>
        <small>PDF, PPTX, DOCX, MD, PNG o JPG · hasta 50 MB</small>
        <input
          ref={inputRef}
          id="archivo"
          name="archivo"
          type="file"
          required
          className="sr-file-input"
          accept=".md,.markdown,.pdf,.pptx,.docx,.xlsx,.csv,.png,.jpg,.jpeg"
          onChange={(e) => {
            const f = e.target.files?.[0];
            setNombre(f?.name ?? '');
            setPesoMb(f === undefined ? undefined : Math.round((f.size / 1024 / 1024) * 10) / 10);
          }}
        />
      </div>

      <div className="source-upload-footer">
        <div className="fld source-type-field">
          <label htmlFor="tipo">Tipo de fuente</label>
          <select id="tipo" name="tipo" defaultValue="ppt_global">
            <option value="ppt_global">PPT de campaña (TCL China)</option>
            <option value="ficha_tecnica">Ficha técnica</option>
            <option value="brief_cliente">Brief del cliente</option>
            <option value="imagen">Imagen de referencia</option>
            <option value="otro">Otro</option>
          </select>
        </div>
        <input type="hidden" name="campaignId" value={campaignId} />
        <div className="selected-file-copy">
          {nombre === '' ? (
            <span>Ningún archivo seleccionado</span>
          ) : (
            <><strong>{nombre}</strong><span>{pesoMb !== undefined ? `${pesoMb} MB` : ''}</span></>
          )}
        </div>
        <button className="btn pri" type="submit" disabled={enviando || nombre === ''}>
          {enviando ? 'Cargando…' : 'Cargar fuente →'}
        </button>
      </div>
    </form>
  );
}
