'use client';

import { useActionState, useState } from 'react';
import { descartarPreguntaLocal, responderPreguntaLocal } from '@/lib/actions';

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

const TIPOS_PRECISION = [
  { valor: 'exacta', texto: 'Fecha exacta' },
  { valor: 'mes', texto: 'Solo el mes' },
  { valor: 'rango', texto: 'Un rango' },
  { valor: 'aproximada', texto: 'Aproximada' },
  { valor: 'pendiente_confirmar', texto: 'Pendiente de confirmar' },
];

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
      <select onChange={(e) => onChange(e.target.value)} defaultValue="" style={{ padding: '4px 6px' }}>
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
    return (
      <input
        type="number"
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ padding: '4px 6px' }}
      />
    );
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
        style={{ padding: '4px 6px', width: '100%' }}
      />
    );
  }

  if (tipo === 'lista_objetos') {
    return (
      <input
        placeholder="Descripción (queda como un mandatorio de categoría 'mensaje')"
        onChange={(e) => onChange([{ categoria: 'mensaje', descripcion: e.target.value }])}
        style={{ padding: '4px 6px', width: '100%' }}
      />
    );
  }

  if (tipo === 'fecha') {
    return <ControlDeFecha onChange={onChange} />;
  }

  return (
    <input
      placeholder="Respuesta"
      onChange={(e) => onChange(e.target.value)}
      style={{ padding: '4px 6px', width: '100%' }}
    />
  );
}

function ControlDeFecha({ onChange }: { onChange: (v: unknown) => void }) {
  const [tipoPrecision, setTipoPrecision] = useState('exacta');
  const [fecha, setFecha] = useState('');
  const [inicio, setInicio] = useState('');
  const [fin, setFin] = useState('');

  const emitir = (t: string, f: string, i: string, fn: string) => {
    if (t === 'rango') onChange({ tipo: t, inicio: i, fin: fn, textoOriginal: `${i} – ${fn}` });
    else onChange({ tipo: t, fecha: f, textoOriginal: f });
  };

  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
      <select
        value={tipoPrecision}
        onChange={(e) => {
          setTipoPrecision(e.target.value);
          emitir(e.target.value, fecha, inicio, fin);
        }}
        style={{ padding: '4px 6px' }}
      >
        {TIPOS_PRECISION.map((t) => (
          <option key={t.valor} value={t.valor}>
            {t.texto}
          </option>
        ))}
      </select>
      {tipoPrecision === 'rango' ? (
        <>
          <input
            type="date"
            onChange={(e) => {
              setInicio(e.target.value);
              emitir(tipoPrecision, fecha, e.target.value, fin);
            }}
          />
          <span>a</span>
          <input
            type="date"
            onChange={(e) => {
              setFin(e.target.value);
              emitir(tipoPrecision, fecha, inicio, e.target.value);
            }}
          />
        </>
      ) : (
        <input
          type={tipoPrecision === 'mes' ? 'month' : 'date'}
          onChange={(e) => {
            setFecha(e.target.value);
            emitir(tipoPrecision, e.target.value, inicio, fin);
          }}
        />
      )}
    </div>
  );
}

function FilaPregunta({ pregunta, campaignId }: { pregunta: Pregunta; campaignId: string }) {
  const [respuestaEstado, responder, respondiendo] = useActionState(responderPreguntaLocal, {});
  const [descarteEstado, descartar, descartando] = useActionState(descartarPreguntaLocal, {});
  const [answerValue, setAnswerValue] = useState<unknown>(undefined);
  const [mostrarDescarte, setMostrarDescarte] = useState(false);

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <strong>{pregunta.label}</strong>{' '}
          {pregunta.criticidad === 'critico' && <span className="pill warn">crítico</span>}
          {pregunta.criticidad === 'claim' && <span className="pill info">claim</span>}
          {pregunta.campaignProductId !== null && (
            <span className="pill" style={{ marginLeft: 4 }}>
              producto {pregunta.campaignProductId.slice(0, 8)}
            </span>
          )}
          <span
            className={`pill ${pregunta.status === 'pendiente' ? '' : pregunta.status === 'respondida' ? 'ok' : 'warn'}`}
            style={{ marginLeft: 4 }}
          >
            {ETIQUETA_ESTADO[pregunta.status]}
          </span>
        </div>
        <span className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>
          {pregunta.key}
        </span>
      </div>

      <p style={{ margin: '8px 0 4px' }}>{pregunta.question}</p>
      <p className="sub" style={{ margin: 0 }}>
        Por qué se generó: {pregunta.reason}
      </p>

      {pregunta.status !== 'pendiente' ? (
        <p className="sub" style={{ marginTop: 8 }}>
          {pregunta.status === 'respondida' ? 'Respondida' : 'Descartada'} por{' '}
          <strong>{pregunta.answeredByName ?? 'alguien'}</strong> el{' '}
          {pregunta.answeredAt !== null && new Date(pregunta.answeredAt).toLocaleString('es-CO')}
          {pregunta.answer !== null && <> — {pregunta.answer}</>}
        </p>
      ) : (
        <>
          {!mostrarDescarte ? (
            <form action={responder} style={{ marginTop: 10 }}>
              <input type="hidden" name="questionId" value={pregunta.id} />
              <input type="hidden" name="campaignId" value={campaignId} />
              <input
                type="hidden"
                name="answerValue"
                value={answerValue === undefined ? '' : JSON.stringify(answerValue)}
              />
              <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <ControlDeRespuesta campo={pregunta.campo} onChange={setAnswerValue} />
                <button
                  className="btn pri"
                  type="submit"
                  disabled={respondiendo || answerValue === undefined}
                >
                  {respondiendo ? 'Guardando…' : 'Responder'}
                </button>
                <button type="button" className="btn" onClick={() => setMostrarDescarte(true)}>
                  Descartar
                </button>
              </div>
              {respuestaEstado.error !== undefined && (
                <div style={{ color: 'var(--bad)', fontSize: 12, marginTop: 4 }}>{respuestaEstado.error}</div>
              )}
            </form>
          ) : (
            <form action={descartar} style={{ marginTop: 10 }}>
              <input type="hidden" name="questionId" value={pregunta.id} />
              <input type="hidden" name="campaignId" value={campaignId} />
              <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                <input
                  name="justificacion"
                  placeholder="¿Por qué se descarta? (obligatorio)"
                  required
                  style={{ flex: 1, padding: '4px 6px' }}
                />
                <button className="btn" type="submit" disabled={descartando}>
                  {descartando ? 'Descartando…' : 'Confirmar descarte'}
                </button>
                <button type="button" className="btn" onClick={() => setMostrarDescarte(false)}>
                  Cancelar
                </button>
              </div>
              {descarteEstado.error !== undefined && (
                <div style={{ color: 'var(--bad)', fontSize: 12, marginTop: 4 }}>{descarteEstado.error}</div>
              )}
            </form>
          )}
        </>
      )}
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
            href={`/campanas/${campaignId}/preguntas?status=${s}${filtroProducto ? `&producto=${filtroProducto}` : ''}`}
            className={`pill ${filtroStatus === s ? 'ok' : ''}`}
          >
            {ETIQUETA_ESTADO[s]}
          </a>
        ))}
        <a
          href={`/campanas/${campaignId}/preguntas`}
          className={`pill ${filtroStatus === undefined ? 'ok' : ''}`}
        >
          todas
        </a>
        {productos.length > 1 && (
          <>
            <span style={{ color: 'var(--muted)' }}>·</span>
            {productos.map((p) => (
              <a
                key={p.id}
                href={`/campanas/${campaignId}/preguntas?producto=${p.id}${filtroStatus ? `&status=${filtroStatus}` : ''}`}
                className={`pill ${filtroProducto === p.id ? 'ok' : ''}`}
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
