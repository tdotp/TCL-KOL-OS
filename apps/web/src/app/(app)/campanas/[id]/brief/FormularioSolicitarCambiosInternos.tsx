'use client';

import { useActionState, useState } from 'react';
import { solicitarCambiosInternosDeCampana } from '@/lib/actions';

/** Fase C · «solicitar cambios internos» exige motivo — nunca un botón sin más. */
export function FormularioSolicitarCambiosInternos({
  versionId,
  campaignId,
}: {
  versionId: string;
  campaignId: string;
}) {
  const [abierto, setAbierto] = useState(false);
  const [estado, accion, enviando] = useActionState(solicitarCambiosInternosDeCampana, {});

  if (!abierto) {
    return (
      <button type="button" className="btn" style={{ width: '100%' }} onClick={() => setAbierto(true)}>
        Solicitar cambios internos
      </button>
    );
  }

  return (
    <form action={accion} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <input type="hidden" name="versionId" value={versionId} />
      <input type="hidden" name="campaignId" value={campaignId} />
      <input
        name="motivo"
        placeholder="¿Qué falta corregir? (obligatorio)"
        required
        style={{ padding: '4px 6px', minWidth: 260 }}
      />
      <button className="btn pri" type="submit" disabled={enviando}>
        {enviando ? 'Enviando…' : 'Confirmar'}
      </button>
      <button type="button" className="btn" onClick={() => setAbierto(false)}>
        Cancelar
      </button>
      {estado.error !== undefined && (
        <span style={{ color: 'var(--bad)', fontSize: 12 }}>{estado.error}</span>
      )}
    </form>
  );
}
