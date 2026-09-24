'use client';

import { useActionState, useState } from 'react';
import { descartarPreguntaLocal, responderPreguntaLocal } from '@/lib/actions';
import { ControlDeFecha } from '@/components/ControlDeFecha';

interface CampoCatalogo {
  key: string;
  label: string;
  section: string;
  description: string;
  criticidad: string;
  nivel: string;
  valueType: string;
  valoresPermitidos?: readonly string[] | undefined;
}

interface Pregunta {
  id: string;
  campaignId: string;
  briefVersionId: string | null;
  key: string;
  label: string;
  campaignProductId: string | null;
  question: string;
  reason: string;
  criticidad: string;
  status: 'pendiente' | 'respondida' | 'descartada';
  answer: string | null;
  answerValue: unknown;
  answeredBy: string | null;
  answeredByName: string | null;
  answeredAt: string | null;
  createdAt: string;
  campo: CampoCatalogo | undefined;
}

const ETIQUETA_ESTADO: Record<string, string> = {
  pendiente: 'pendiente',
  respondida: 'respondida',
  descartada: 'descartada',
};

/** Construye el control correcto según `valueType` — nunca un textarea genérico para todo (§5.3). */
function ControlDeRespuesta({
  campo,
  onChange,
}: {
  campo: CampoCatalogo | undefined;
  onChange: (v: unknown) => void;
}) {
  const tipo = campo?.valueType ?? 'texto';

  if (tipo === 'enum' && campo?.valoresPermitidos) {
    return (
      <select onChange={(e) => onChange(e.target.value)} defaultValue="">
        <option value="" disabled>
          Elija un valor…
        </option>
        {campo.valoresPermitidos.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    );
  }

  if (tipo === 'numero') {
    return <input type="number" onChange={(e) => onChange(Number(e.target.value))} />;
  }

  if (tipo === 'lista') {
    return (
      <input
        placeholder="Un valor por línea, o separados por coma"
        onChange={(e) =>
          onChange(
            e.target.value
              .split(/[\n,]/)
              .map((v) => v.trim())
              .filter((v) => v !== ''),
          )
        }
      />
    );
  }

  if (tipo === 'lista_objetos') {
    return (
      <input
        placeholder="Descripción (queda como un mandatorio de categoría 'mensaje')"
        onChange={(e) => onChange([{ categoria: 'mensaje', descripcion: e.target.value }])}
      />
    );
  }

  if (tipo === 'fecha') {
    return <ControlDeFecha onChange={onChange} />;
  }

  return <input placeholder="Escribir la respuesta…" onChange={(e) => onChange(e.target.value)} />;
}

/**
 * Rediseño: cada pregunta local es un hilo de chat propio — el sistema
 * "pregunta" en un mensaje (nunca inventa: siempre dice por qué), y la
 * persona responde o descarta desde una barra anclada abajo, como en esta
 * conversación. Misma lógica y las mismas dos acciones de servidor de
 * siempre (`responderPreguntaLocal`, `descartarPreguntaLocal`) — solo cambia
 * la forma de tarjeta-formulario a hilo conversacional.
 */
function FilaPregunta({ pregunta, campaignId }: { pregunta: Pregunta; campaignId: string }) {
  const [respuestaEstado, responder, respondiendo] = useActionState(responderPreguntaLocal, {});
  const [descarteEstado, descartar, descartando] = useActionState(descartarPreguntaLocal, {});
  const [answerValue, setAnswerValue] = useState<unknown>(undefined);
  const [mostrarDescarte, setMostrarDescarte] = useState(false);

  return (
    <div className="card question-thread-card" style={{ marginBottom: 12, padding: 16 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
        <div className="row" style={{ gap: 4 }}>
          <strong style={{ fontSize: 13.5 }}>{pregunta.label}</strong>
          {pregunta.criticidad === 'critico' && <span className="pill bad">crítica</span>}
          {pregunta.criticidad === 'claim' && <span className="pill curso">claim</span>}
          {pregunta.campaignProductId !== null && (
            <span className="pill neutro">producto {pregunta.campaignProductId.slice(0, 8)}</span>
          )}
          <span className={`pill ${pregunta.status === 'pendiente' ? 'neutro' : pregunta.status === 'respondida' ? 'ok' : 'warn'}`}>
            {ETIQUETA_ESTADO[pregunta.status]}
          </span>
        </div>
        <span className="mono" style={{ fontSize: 10.5, color: 'var(--muted)' }}>
          {pregunta.key}
        </span>
      </div>

      <div className="chat-hilo" style={{ maxHeight: 'none', padding: 0 }}>
        {/* El sistema "pregunta" — nunca inventa: siempre explica de dónde sale la duda. */}
        <div className="chat-msg sistema">
          <div className="chat-avatar">OS</div>
          <div style={{ flex: 1 }}>
            <div className="chat-bubble">
              <div className="chat-texto">{pregunta.question}</div>
            </div>
            <p className="sub" style={{ margin: '4px 0 0', fontSize: 11.5 }}>
              Por qué se generó: {pregunta.reason}
            </p>
          </div>
        </div>

        {pregunta.status !== 'pendiente' && (
          <div className="chat-msg propio">
            <div className="chat-avatar">{(pregunta.answeredByName ?? '?').slice(0, 2).toUpperCase()}</div>
            <div style={{ flex: 1 }}>
              <div className="chat-bubble">
                <div className="chat-meta">
                  <strong>{pregunta.answeredByName ?? 'alguien'}</strong> ·{' '}
                  {pregunta.answeredAt !== null && new Date(pregunta.answeredAt).toLocaleString('es-CO')}
                </div>
                <div className="chat-texto">
                  {pregunta.status === 'respondida'
                    ? (pregunta.answer ?? '—')
                    : `Descartada — ${pregunta.answer ?? 'sin justificación registrada'}`}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {pregunta.status === 'pendiente' &&
        (!mostrarDescarte ? (
          <form action={responder} className="chat-input-bar">
            <input type="hidden" name="questionId" value={pregunta.id} />
            <input type="hidden" name="campaignId" value={campaignId} />
            <input
              type="hidden"
              name="answerValue"
              value={answerValue === undefined ? '' : JSON.stringify(answerValue)}
            />
            <ControlDeRespuesta campo={pregunta.campo} onChange={setAnswerValue} />
            <button className="btn pri" type="submit" disabled={respondiendo || answerValue === undefined}>
              {respondiendo ? 'Guardando…' : 'Responder'}
            </button>
            <button type="button" className="btn" onClick={() => setMostrarDescarte(true)}>
              Descartar
            </button>
            {respuestaEstado.error !== undefined && (
              <div style={{ color: 'var(--bad)', fontSize: 12, width: '100%' }}>{respuestaEstado.error}</div>
            )}
          </form>
        ) : (
          <div className="inline-form">
            <form action={descartar}>
              <input type="hidden" name="questionId" value={pregunta.id} />
              <input type="hidden" name="campaignId" value={campaignId} />
              <div className="fld" style={{ marginBottom: 8 }}>
                <input name="justificacion" placeholder="¿Por qué se descarta? (obligatorio)" required />
              </div>
              <div className="row">
                <button className="btn pri" type="submit" disabled={descartando}>
                  {descartando ? 'Descartando…' : 'Confirmar descarte'}
                </button>
                <button type="button" className="btn" onClick={() => setMostrarDescarte(false)}>
                  Cancelar
                </button>
              </div>
              {descarteEstado.error !== undefined && (
                <div style={{ color: 'var(--bad)', fontSize: 12, marginTop: 6 }}>{descarteEstado.error}</div>
              )}
            </form>
          </div>
        ))}
    </div>
  );
}

export function TablaPreguntas({
  preguntas,
  campaignId,
  productos,
  filtroStatus,
  filtroProducto,
  editable,
}: {
  preguntas: Pregunta[];
  campaignId: string;
  productos: { id: string; model: string }[];
  filtroStatus?: string | undefined;
  filtroProducto?: string | undefined;
  editable: boolean;
}) {
  return (
    <div>
      <div className="row" style={{ gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {(['pendiente', 'respondida', 'descartada'] as const).map((s) => (
          <a
            key={s}
            href={`/campanas/${campaignId}/brief/editar?panel=preguntas&status=${s}${filtroProducto ? `&producto=${filtroProducto}` : ''}`}
            className={`pill ${filtroStatus === s ? 'curso' : 'neutro'}`}
          >
            {ETIQUETA_ESTADO[s]}
          </a>
        ))}
        <a
          href={`/campanas/${campaignId}/brief/editar?panel=preguntas`}
          className={`pill ${filtroStatus === undefined ? 'curso' : 'neutro'}`}
        >
          todas
        </a>
        {productos.length > 1 && (
          <>
            <span style={{ color: 'var(--muted)' }}>·</span>
            {productos.map((p) => (
              <a
                key={p.id}
                href={`/campanas/${campaignId}/brief/editar?panel=preguntas&producto=${p.id}${filtroStatus ? `&status=${filtroStatus}` : ''}`}
                className={`pill ${filtroProducto === p.id ? 'curso' : 'neutro'}`}
              >
                {p.model}
              </a>
            ))}
          </>
        )}
      </div>

      {preguntas.length === 0 ? (
        <p className="vacio">No hay preguntas con este filtro.</p>
      ) : (
        preguntas.map((p) => <FilaPregunta key={p.id} pregunta={p} campaignId={campaignId} />)
      )}

      {!editable && (
        <p className="sub">
          Solo puede consultar las preguntas; responderlas es una acción del equipo interno.
        </p>
      )}
    </div>
  );
}
