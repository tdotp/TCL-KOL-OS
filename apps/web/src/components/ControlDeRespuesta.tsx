'use client';

import { ControlDeFecha } from '@/components/ControlDeFecha';

export interface CampoCatalogoParaControl {
  readonly valueType: string;
  readonly valoresPermitidos?: readonly string[] | undefined;
}

/**
 * Construye el control correcto según `valueType` — nunca un textarea
 * genérico para todo (§5.3). Vivía solo dentro de `TablaPreguntas.tsx`; se
 * extrajo (Sprint 6, Fase C) para que el workspace guiado use exactamente el
 * mismo control por cada tipo de respuesta, en vez de reimplementarlo.
 */
export function ControlDeRespuesta({
  campo,
  onChange,
}: {
  campo: CampoCatalogoParaControl | undefined;
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
