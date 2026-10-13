'use client';

import { useActionState, useEffect, useState } from 'react';
import {
  crearComentarioDeCampo,
  obtenerComentariosDeCampo,
  reabrirComentarioDeCampo,
  resolverComentarioDeCampo,
} from '@/lib/actions';
import type { ComentarioDeCampo } from '@tcl-kol-os/db';

function iniciales(nombre: string): string {
  const partes = nombre.trim().split(/\s+/);
  const primeras = partes.slice(0, 2).map((p) => p[0] ?? '');
  return primeras.join('').toUpperCase() || '?';
}

/**
 * E7-6 · Conversación interna de un campo, como un hilo de chat (rediseño):
 * cada comentario es un mensaje con avatar y burbuja, respuesta anclada
 * abajo — mismo componente, misma lógica de datos que antes, solo la forma
 * cambia. Nunca se monta para el rol `cliente` — `CampoEditable` solo la
 * ofrece cuando `conteoAbiertos` llega como número, y el editor
 * (`editar/page.tsx`) ya redirige a `cliente` antes de llegar ahí
 * (Sprint 5, Fase B/D).
 */
export function PanelComentarios({
  versionId,
  fieldKey,
  campaignProductId,
}: {
  versionId: string;
  fieldKey: string;
  campaignProductId: string | undefined;
}) {
  const [comentarios, setComentarios] = useState<readonly ComentarioDeCampo[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [contenido, setContenido] = useState('');
  const [estadoCrear, crear, creando] = useActionState(crearComentarioDeCampo, {});
  const [estadoResolver, resolver] = useActionState(resolverComentarioDeCampo, {});
  const [estadoReabrir, reabrir] = useActionState(reabrirComentarioDeCampo, {});

  const recargar = () => {
    obtenerComentariosDeCampo(versionId, fieldKey).then((r) => {
      if (r.error !== undefined) setError(r.error);
      else setComentarios(r.comentarios ?? []);
    });
  };

  useEffect(recargar, [versionId, fieldKey, estadoCrear, estadoResolver, estadoReabrir]);

  const raices = (comentarios ?? []).filter((c) => c.parentCommentId === undefined);
  const respuestasDe = (id: string) => (comentarios ?? []).filter((c) => c.parentCommentId === id);

  return (
    <div
      style={{
        marginTop: 8,
        padding: 10,
        background: 'var(--panel)',
        border: '1px solid var(--line)',
        borderRadius: 10,
      }}
    >
      {error !== undefined && (
        <p style={{ color: 'var(--bad)', fontSize: 12.5, margin: '0 0 6px' }}>{error}</p>
      )}

      {comentarios === undefined ? (
        <p className="sub" style={{ margin: 0 }}>
          Cargando…
        </p>
      ) : raices.length === 0 ? (
        <p className="sub" style={{ margin: 0 }}>
          Sin comentarios todavía — el primer mensaje empieza la conversación.
        </p>
      ) : (
        <div className="chat-hilo" style={{ maxHeight: 320 }}>
          {raices.map((c) => (
            <div key={c.id}>
              <FilaComentario
                comentario={c}
                versionId={versionId}
                onResolver={resolver}
                onReabrir={reabrir}
              />
              {respuestasDe(c.id).map((r) => (
                <div key={r.id} style={{ marginLeft: 30 }}>
                  <FilaComentario
                    comentario={r}
                    versionId={versionId}
                    onResolver={resolver}
                    onReabrir={reabrir}
                  />
                </div>
              ))}
              <form
                action={crear}
                className="chat-input-bar"
                style={{ marginLeft: 30, marginTop: 4, borderTop: 'none', paddingTop: 0 }}
              >
                <input type="hidden" name="versionId" value={versionId} />
                <input type="hidden" name="fieldKey" value={fieldKey} />
                {campaignProductId !== undefined && (
                  <input type="hidden" name="campaignProductId" value={campaignProductId} />
                )}
                <input type="hidden" name="parentCommentId" value={c.id} />
                <input
                  name="content"
                  placeholder="Responder…"
                  style={{ fontSize: 12.5, padding: '6px 10px' }}
                />
                <button className="btn" type="submit" style={{ fontSize: 11.5, padding: '5px 12px' }}>
                  Responder
                </button>
              </form>
            </div>
          ))}
        </div>
      )}

      <form action={crear} className="chat-input-bar" onSubmit={() => setContenido('')}>
        <input type="hidden" name="versionId" value={versionId} />
        <input type="hidden" name="fieldKey" value={fieldKey} />
        {campaignProductId !== undefined && (
          <input type="hidden" name="campaignProductId" value={campaignProductId} />
        )}
        <input
          name="content"
          value={contenido}
          onChange={(e) => setContenido(e.target.value)}
          placeholder="Escribir un comentario…"
        />
        <button className="btn pri" type="submit" disabled={creando}>
          {creando ? '…' : 'Comentar'}
        </button>
      </form>
      {estadoCrear.error !== undefined && (
        <p style={{ color: 'var(--bad)', fontSize: 11.5, marginTop: 4 }}>{estadoCrear.error}</p>
      )}
    </div>
  );
}

function FilaComentario({
  comentario,
  versionId,
  onResolver,
  onReabrir,
}: {
  comentario: ComentarioDeCampo;
  versionId: string;
  onResolver: (formData: FormData) => void;
  onReabrir: (formData: FormData) => void;
}) {
  const esRaiz = comentario.parentCommentId === undefined;
  return (
    <div className={`chat-msg ${esRaiz ? '' : 'respuesta'}`}>
      <div className="chat-avatar">{iniciales(comentario.authorName)}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="chat-bubble">
          <div className="chat-meta">
            <strong>{comentario.authorName}</strong> ·{' '}
            {new Date(comentario.createdAt).toLocaleString('es-CO')}
            {esRaiz && (
              <span
                className={`pill ${comentario.status === 'resuelto' ? 'ok' : 'warn'}`}
                style={{ marginLeft: 6, fontSize: 9.5, padding: '1px 7px' }}
              >
                {comentario.status}
              </span>
            )}
          </div>
          <div className="chat-texto">{comentario.content}</div>
        </div>
        {esRaiz && (
          <form action={comentario.status === 'abierto' ? onResolver : onReabrir} style={{ marginTop: 4 }}>
            <input type="hidden" name="versionId" value={versionId} />
            <input type="hidden" name="commentId" value={comentario.id} />
            <button className="btn" type="submit" style={{ fontSize: 11, padding: '3px 10px' }}>
              {comentario.status === 'abierto' ? 'Resolver' : 'Reabrir'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
