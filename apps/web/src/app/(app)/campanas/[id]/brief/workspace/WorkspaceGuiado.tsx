'use client';

import { useActionState, useEffect, useMemo, useState } from 'react';
import type { BriefWorkspace, WorkspaceTask } from '@tcl-kol-os/domain';
import { descartarPreguntaLocal, responderPreguntaLocal } from '@/lib/actions';
import { ControlDeRespuesta } from '@/components/ControlDeRespuesta';

const ETIQUETA_CRITICIDAD: Record<string, string> = {
  critico: 'crítico',
  claim: 'afirmación verificable',
  informativo: 'informativo',
};

/**
 * Sprint 6, Fase C — la experiencia guiada de completado.
 *
 * Una tarea a la vez, tomadas de `workspace.tasks` (preguntas locales
 * pendientes — la misma cola que ya alimenta `TablaPreguntas.tsx`). Cada
 * respuesta o descarte llama exactamente a las mismas server actions que ya
 * existían (`responderPreguntaLocal`, `descartarPreguntaLocal`) — este
 * componente nunca escribe en la base directamente ni reimplementa una
 * guarda de dominio. "Saltar" es puramente de esta sesión del navegador: no
 * cambia nada en el servidor, solo reordena qué se muestra primero.
 */
export function WorkspaceGuiado({
  campaignId,
  workspace,
}: {
  campaignId: string;
  workspace: BriefWorkspace;
}) {
  const [saltadas, setSaltadas] = useState<readonly string[]>([]);
  const [verTodas, setVerTodas] = useState(false);
  const [ultimaGuardada, setUltimaGuardada] = useState<string | undefined>(undefined);
  const [mostrarDescarte, setMostrarDescarte] = useState(false);

  const [estadoResponder, responder, respondiendo] = useActionState(responderPreguntaLocal, {});
  const [estadoDescartar, descartar, descartando] = useActionState(descartarPreguntaLocal, {});

  // Las saltadas se muestran al final, nunca desaparecen — "saltar" pospone,
  // no descarta (eso exige justificación, es una acción real del dominio).
  const cola = useMemo(() => {
    const pendientes = [...workspace.tasks];
    pendientes.sort(
      (a, b) => Number(saltadas.includes(a.questionId)) - Number(saltadas.includes(b.questionId)),
    );
    return pendientes;
  }, [workspace.tasks, saltadas]);

  const tarea: WorkspaceTask | undefined = cola[0];
  const producto = tarea?.campaignProductId
    ? workspace.products.find((p) => p.id === tarea.campaignProductId)
    : undefined;

  const [valor, setValor] = useState<unknown>(undefined);

  // La tarea al frente de la cola cambia sola cuando la respuesta anterior
  // se guarda (revalidación del servidor, no un "siguiente" manual) — sin
  // este efecto, el valor tecleado para la tarea previa quedaría pegado al
  // formulario de la tarea nueva.
  useEffect(() => {
    setValor(undefined);
    setMostrarDescarte(false);
  }, [tarea?.questionId]);

  const version = workspace.version!;

  return (
    <div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <strong style={{ fontSize: 20 }}>{workspace.progress.percentage}% completo</strong>
            <p className="sub" style={{ margin: '2px 0 0' }}>
              {workspace.progress.ready} de {workspace.progress.total} campos con dato
              {workspace.progress.decisionsPending > 0 &&
                ` · ${workspace.progress.decisionsPending} decisión(es) por resolver`}
            </p>
          </div>
          <div className="progreso" style={{ width: 120 }}>
            <span style={{ width: `${workspace.progress.percentage}%` }} />
          </div>
        </div>
        <div className="row" style={{ gap: 8, marginTop: 12 }}>
          <button type="button" className="btn" onClick={() => setVerTodas((v) => !v)}>
            {verTodas ? 'Ocultar pendientes' : 'Ver todos los pendientes'}
          </button>
          <a className="btn" href={`/campanas/${campaignId}/brief/editar?panel=preguntas`}>
            Preguntas locales
          </a>
          <a className="btn" href={`/campanas/${campaignId}/brief/editar`}>
            Abrir el brief
          </a>
        </div>
        {verTodas && (
          <ul style={{ marginTop: 12, paddingLeft: 18, fontSize: 13 }}>
            {cola.map((t) => (
              <li key={t.questionId} style={{ marginBottom: 4 }}>
                {t.label}
                {saltadas.includes(t.questionId) && <span className="pill neutro"> saltada</span>}
              </li>
            ))}
          </ul>
        )}
      </div>

      {ultimaGuardada !== undefined && (
        <div className="chat-msg" style={{ marginBottom: 12 }}>
          <div className="chat-avatar" style={{ background: 'var(--ok)' }}>
            ✓
          </div>
          <div className="chat-bubble" style={{ background: 'var(--ok-soft)' }}>
            <div className="chat-texto">Guardado: {ultimaGuardada}</div>
          </div>
        </div>
      )}

      {tarea === undefined ? (
        <div className="card">
          <h2>No quedan tareas pendientes</h2>
          <p className="sub">
            {workspace.progress.criticalPending > 0
              ? `Todavía faltan ${workspace.progress.criticalPending} campo(s) crítico(s) sin pregunta generada.`
              : 'Todo lo que el sistema pudo convertir en pregunta ya tiene respuesta o justificación.'}
          </p>
          <a className="btn pri" href={`/campanas/${campaignId}/brief/editar`}>
            Revisar el brief completo →
          </a>
        </div>
      ) : (
        <div className="card">
          <div className="chat-msg sistema" style={{ marginBottom: 14 }}>
            <div className="chat-avatar">IA</div>
            <div style={{ flex: 1 }}>
              <div className="chat-bubble">
                <div className="chat-texto">{tarea.question}</div>
              </div>
              <p className="sub" style={{ margin: '4px 0 0', fontSize: 12 }}>
                Por qué se pregunta: {tarea.reason}
              </p>
            </div>
          </div>

          <div className="row" style={{ gap: 6, marginBottom: 12 }}>
            <span className={`pill ${tarea.criticidad === 'critico' ? 'bad' : 'neutro'}`}>
              {ETIQUETA_CRITICIDAD[tarea.criticidad] ?? tarea.criticidad}
            </span>
            {producto !== undefined && <span className="pill curso">{producto.model}</span>}
            {tarea.requiereEvidencia && (
              <span className="pill warn">exige evidencia — no se puede resolver solo con texto</span>
            )}
          </div>

          {tarea.requiereEvidencia ? (
            <div className="aviso">
              <strong>Esto exige respaldo documental</strong>
              Es una afirmación verificable sobre el producto (§3.3) — respóndala desde el editor adjuntando o
              citando la fuente, o descártela si no aplica.
              <div className="row" style={{ gap: 8, marginTop: 8 }}>
                <a className="btn" href={`/campanas/${campaignId}/brief/editar`}>
                  Ir al editor →
                </a>
                <button type="button" className="btn" onClick={() => setMostrarDescarte(true)}>
                  No aplica
                </button>
              </div>
            </div>
          ) : !mostrarDescarte ? (
            <form
              action={responder}
              onSubmit={() => setUltimaGuardada(tarea.label)}
              className="chat-input-bar"
              style={{ borderTop: 'none', paddingTop: 0 }}
            >
              <input type="hidden" name="questionId" value={tarea.questionId} />
              <input type="hidden" name="campaignId" value={campaignId} />
              <input
                type="hidden"
                name="answerValue"
                value={valor === undefined ? '' : JSON.stringify(valor)}
              />
              <ControlDeRespuesta key={tarea.questionId} campo={tarea} onChange={setValor} />
              <button className="btn pri" type="submit" disabled={respondiendo || valor === undefined}>
                {respondiendo ? 'Guardando…' : 'Responder'}
              </button>
            </form>
          ) : null}

          {estadoResponder.error !== undefined && (
            <p style={{ color: 'var(--bad)', fontSize: 12.5, marginTop: 8 }}>{estadoResponder.error}</p>
          )}

          {!tarea.requiereEvidencia && (
            <div className="row" style={{ gap: 8, marginTop: 10 }}>
              <button
                type="button"
                className="btn"
                onClick={() =>
                  setSaltadas((s) => (s.includes(tarea.questionId) ? s : [...s, tarea.questionId]))
                }
                disabled={saltadas.includes(tarea.questionId)}
              >
                Saltar por ahora
              </button>
              <button type="button" className="btn" onClick={() => setMostrarDescarte((v) => !v)}>
                {mostrarDescarte ? 'Cancelar' : 'No aplica'}
              </button>
            </div>
          )}

          {mostrarDescarte && (
            <form action={descartar} className="inline-form" style={{ marginTop: 10 }}>
              <input type="hidden" name="questionId" value={tarea.questionId} />
              <input type="hidden" name="campaignId" value={campaignId} />
              <div className="fld" style={{ marginBottom: 8 }}>
                <input name="justificacion" placeholder="¿Por qué no aplica? (obligatorio)" required />
              </div>
              <button className="btn pri" type="submit" disabled={descartando}>
                {descartando ? 'Descartando…' : 'Confirmar que no aplica'}
              </button>
              {estadoDescartar.error !== undefined && (
                <p style={{ color: 'var(--bad)', fontSize: 12, marginTop: 6 }}>{estadoDescartar.error}</p>
              )}
            </form>
          )}
        </div>
      )}

      <p className="sub" style={{ marginTop: 16, fontSize: 12 }}>
        Versión {version.number} · estado <span className="mono">{version.status}</span>
        {workspace.nextResponsibleRole !== undefined &&
          ` · siguiente responsable: ${workspace.nextResponsibleRole}`}
      </p>
    </div>
  );
}
