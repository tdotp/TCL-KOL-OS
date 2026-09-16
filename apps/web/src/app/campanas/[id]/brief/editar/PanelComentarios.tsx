'use client';

import { useActionState, useEffect, useState } from 'react';
import {
  crearComentarioDeCampo,
  obtenerComentariosDeCampo,
  reabrirComentarioDeCampo,
  resolverComentarioDeCampo,
} from '@/lib/actions';
import type { ComentarioDeCampo } from '@tcl-kol-os/db';

/**
 * E7-6 · Conversación interna de un campo. Nunca se monta para el rol
 * `cliente` — `CampoEditable` solo la ofrece cuando `conteoAbiertos` llega
 * como número, y el editor (`editar/page.tsx`) ya redirige a `cliente` antes
 * de llegar ahí (Sprint 5, Fase B/D).
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
    <div style={{ marginTop: 8, padding: 8, background: 'var(--chip)', borderRadius: 6, fontSize: 13 }}>
      {error !== undefined && <p style={{ color: 'var(--bad)' }}>{error}</p>}
      {comentarios === undefined ? (
        <p className="sub">Cargando…</p>
      ) : raices.length === 0 ? (
        <p className="sub" style={{ margin: 0 }}>
          Sin comentarios todavía.
        </p>
      ) : (
        raices.map((c) => (
          <div key={c.id} style={{ padding: '6px 0', borderTop: '1px solid var(--line)' }}>
            <FilaComentario comentario={c} versionId={versionId} onResolver={resolver} onReabrir={reabrir} />
            {respuestasDe(c.id).map((r) => (
              <div key={r.id} style={{ marginLeft: 16, marginTop: 6 }}>
                <FilaComentario
                  comentario={r}
                  versionId={versionId}
                  onResolver={resolver}
                  onReabrir={reabrir}
                />
              </div>
            ))}
            <form action={crear} style={{ marginLeft: 16, marginTop: 6, display: 'flex', gap: 4 }}>
              <input type="hidden" name="versionId" value={versionId} />
              <input type="hidden" name="fieldKey" value={fieldKey} />
              {campaignProductId !== undefined && (
                <input type="hidden" name="campaignProductId" value={campaignProductId} />
              )}
              <input type="hidden" name="parentCommentId" value={c.id} />
              <input
                name="content"
                placeholder="Responder…"
                style={{ flex: 1, padding: '3px 6px', fontSize: 12 }}
              />
              <button className="btn" type="submit" style={{ fontSize: 11, padding: '2px 6px' }}>
                Responder
              </button>
            </form>
          </div>
        ))
      )}

      <form
        action={crear}
        style={{ marginTop: 8, display: 'flex', gap: 4 }}
        onSubmit={() => setContenido('')}
      >
        <input type="hidden" name="versionId" value={versionId} />
        <input type="hidden" name="fieldKey" value={fieldKey} />
        {campaignProductId !== undefined && (
          <input type="hidden" name="campaignProductId" value={campaignProductId} />
        )}
        <input
          name="content"
          value={contenido}
          onChange={(e) => setContenido(e.target.value)}
          placeholder="Nuevo comentario…"
          style={{ flex: 1, padding: '4px 6px', fontSize: 12 }}
        />
        <button className="btn pri" type="submit" disabled={creando} style={{ fontSize: 12 }}>
          {creando ? '…' : 'Comentar'}
        </button>
      </form>
      {estadoCrear.error !== undefined && (
        <p style={{ color: 'var(--bad)', fontSize: 11, marginTop: 4 }}>{estadoCrear.error}</p>
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
  return (
    <div>
      <span style={{ fontWeight: 600 }}>{comentario.authorName}</span>{' '}
      <span style={{ color: 'var(--muted)' }}>{new Date(comentario.createdAt).toLocaleString('es-CO')}</span>{' '}
      {comentario.parentCommentId === undefined && (
        <span className={`pill ${comentario.status === 'resuelto' ? 'ok' : 'warn'}`} style={{ fontSize: 10 }}>
          {comentario.status}
        </span>
      )}
      <p style={{ margin: '2px 0' }}>{comentario.content}</p>
      {comentario.parentCommentId === undefined && (
        <form action={comentario.status === 'abierto' ? onResolver : onReabrir} style={{ display: 'inline' }}>
          <input type="hidden" name="versionId" value={versionId} />
          <input type="hidden" name="commentId" value={comentario.id} />
          <button className="btn" type="submit" style={{ fontSize: 11, padding: '2px 6px' }}>
            {comentario.status === 'abierto' ? 'Resolver' : 'Reabrir'}
          </button>
        </form>
      )}
    </div>
  );
}
