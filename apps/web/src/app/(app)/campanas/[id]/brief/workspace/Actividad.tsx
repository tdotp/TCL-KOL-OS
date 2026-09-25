'use client';

import { useMemo, useState } from 'react';
import type { WorkspaceActivityItem } from '@tcl-kol-os/domain';

type Filtro = 'todo' | 'comentarios' | 'cambios' | 'aprobaciones';

function iniciales(nombre: string | undefined): string {
  if (nombre === undefined) return '·';
  const partes = nombre.trim().split(/\s+/);
  return partes
    .slice(0, 2)
    .map((p) => p[0] ?? '')
    .join('')
    .toUpperCase();
}

/**
 * Solo clasifica para el filtro — nunca decide qué pasó (eso ya lo decidió
 * `obtenerBriefWorkspace`/`humanoDeEvento` en el servidor).
 */
function categoriaDe(item: WorkspaceActivityItem): Exclude<Filtro, 'todo'> | 'otros' {
  if (item.kind === 'comentario') return 'comentarios';
  if (item.kind === 'revision_campo') return 'cambios';
  if (item.tipo.startsWith('Cambió el estado')) return 'aprobaciones';
  return 'otros';
}

function valorCorto(valor: unknown): string {
  if (valor === null || valor === undefined || valor === '') return '— sin dato —';
  if (typeof valor === 'string') return valor.length > 60 ? `${valor.slice(0, 60)}…` : valor;
  const texto = JSON.stringify(valor);
  return texto.length > 60 ? `${texto.slice(0, 60)}…` : texto;
}

/**
 * Sprint 6, Checkpoint 2 §3.4 — línea de actividad derivada únicamente de
 * `activity` (ya construida en el servidor desde `audit_events`,
 * `brief_field_revisions` y `field_comments` reales). Este componente solo
 * filtra y da formato; nunca vuelve a consultar la base ni inventa un
 * evento que los datos no tengan.
 */
export function Actividad({ activity }: { activity: readonly WorkspaceActivityItem[] }) {
  const [filtro, setFiltro] = useState<Filtro>('todo');

  const visibles = useMemo(() => {
    if (filtro === 'todo') return activity;
    return activity.filter((a) => categoriaDe(a) === filtro);
  }, [activity, filtro]);

  const opciones: { id: Filtro; label: string }[] = [
    { id: 'todo', label: 'Todo' },
    { id: 'comentarios', label: 'Comentarios' },
    { id: 'cambios', label: 'Cambios' },
    { id: 'aprobaciones', label: 'Aprobaciones' },
  ];

  return (
    <div className="card">
      <div className="actividad-filtros">
        {opciones.map((o) => (
          <button
            key={o.id}
            type="button"
            className={`pill ${filtro === o.id ? 'curso' : 'neutro'}`}
            style={{ cursor: 'pointer', border: 'none' }}
            onClick={() => setFiltro(o.id)}
          >
            {o.label}
          </button>
        ))}
      </div>

      {visibles.length === 0 ? (
        <p className="vacio">Sin actividad para este filtro.</p>
      ) : (
        visibles.map((item) => (
          <div className="actividad-item" key={item.id}>
            <span className="avatar-circulo">{iniciales(item.actorName)}</span>
            <div>
              <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                <strong style={{ fontSize: 13 }}>{item.actorName ?? 'Sistema'}</strong>
                <span className="sub" style={{ margin: 0, fontSize: 12 }}>
                  {item.tipo}
                  {item.fieldLabel !== undefined && ` · ${item.fieldLabel}`}
                </span>
                {item.status !== undefined && (
                  <span className={`pill ${item.status === 'abierto' ? 'warn' : 'ok'}`}>{item.status}</span>
                )}
              </div>
              {item.detalle !== undefined && (
                <p className="sub" style={{ margin: '3px 0 0', fontSize: 12.5 }}>
                  {item.detalle}
                </p>
              )}
              {item.kind === 'revision_campo' && (
                <div className="actividad-cambio">
                  <span className="anterior">{valorCorto(item.valorAnterior)}</span>
                  <span>→</span>
                  <span>{valorCorto(item.valorNuevo)}</span>
                </div>
              )}
            </div>
            <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString('es-CO')}</time>
          </div>
        ))
      )}
    </div>
  );
}
