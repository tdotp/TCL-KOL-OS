'use client';

import { useState } from 'react';

const TIPOS_PRECISION = [
  { valor: 'exacta', texto: 'Fecha exacta' },
  { valor: 'mes', texto: 'Solo el mes' },
  { valor: 'rango', texto: 'Un rango' },
  { valor: 'aproximada', texto: 'Aproximada' },
  { valor: 'pendiente_confirmar', texto: 'Pendiente de confirmar' },
];

export interface PrecisedDateValue {
  tipo: string;
  fecha?: string;
  inicio?: string;
  fin?: string;
  textoOriginal?: string;
}

function valorInicial(value: unknown): { tipo: string; fecha: string; inicio: string; fin: string } {
  if (typeof value === 'object' && value !== null && 'tipo' in value) {
    const v = value as { tipo?: unknown; fecha?: unknown; inicio?: unknown; fin?: unknown };
    return {
      tipo: typeof v.tipo === 'string' ? v.tipo : 'exacta',
      fecha: typeof v.fecha === 'string' ? v.fecha : '',
      inicio: typeof v.inicio === 'string' ? v.inicio : '',
      fin: typeof v.fin === 'string' ? v.fin : '',
    };
  }
  return { tipo: 'exacta', fecha: '', inicio: '', fin: '' };
}

/**
 * Control de fecha con precisión (DEC-026): nunca un `<input type="text">`
 * genérico para un campo `valueType:'fecha'` — construye siempre el objeto
 * `PrecisedDate` correcto (`{tipo, fecha|inicio/fin, textoOriginal}`).
 *
 * Extraído de `TablaPreguntas.tsx` (E6) para que el editor manual de campos
 * (`CampoEditable.tsx`, E7) use exactamente el mismo control — antes eso
 * guardaba la fecha como texto plano (Sprint 5, Fase A, cierra DEC-026 y
 * E7-3 del cierre de Sprint 4).
 */
export function ControlDeFecha({
  valorInicialProp,
  onChange,
}: {
  valorInicialProp?: unknown;
  onChange: (v: PrecisedDateValue) => void;
}) {
  const inicial = valorInicial(valorInicialProp);
  const [tipoPrecision, setTipoPrecision] = useState(inicial.tipo);
  const [fecha, setFecha] = useState(inicial.fecha);
  const [inicio, setInicio] = useState(inicial.inicio);
  const [fin, setFin] = useState(inicial.fin);

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
            value={inicio}
            onChange={(e) => {
              setInicio(e.target.value);
              emitir(tipoPrecision, fecha, e.target.value, fin);
            }}
          />
          <span>a</span>
          <input
            type="date"
            value={fin}
            onChange={(e) => {
              setFin(e.target.value);
              emitir(tipoPrecision, fecha, inicio, e.target.value);
            }}
          />
        </>
      ) : (
        <input
          type={tipoPrecision === 'mes' ? 'month' : 'date'}
          value={fecha}
          onChange={(e) => {
            setFecha(e.target.value);
            emitir(tipoPrecision, e.target.value, inicio, fin);
          }}
        />
      )}
    </div>
  );
}
