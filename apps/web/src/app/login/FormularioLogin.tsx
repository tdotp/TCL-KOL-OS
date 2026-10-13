'use client';

import { useActionState } from 'react';
import { iniciarSesion } from '@/lib/actions';

/** Formulario de acceso en modo desarrollo (`AUTH_PROVIDER=dev`): elige un usuario ya sembrado. */
export default function FormularioLogin() {
  const [estado, accion, enviando] = useActionState(iniciarSesion, {});

  return (
    <>
      <form action={accion} style={{ marginTop: 28 }}>
        {estado.error !== undefined && (
          <div className="aviso error">
            <strong>No se pudo iniciar sesión</strong>
            {estado.error}
          </div>
        )}

        <div className="fld">
          <label htmlFor="email">Correo corporativo</label>
          <select id="email" name="email" defaultValue="gerardo@smartpr.co">
            <option value="gerardo@smartpr.co">gerardo@smartpr.co — admin (SmartPR)</option>
            <option value="director@smartpr.co">director@smartpr.co — director (SmartPR)</option>
            <option value="consultor@smartpr.co">consultor@smartpr.co — consultor (SmartPR)</option>
            <option value="marena@tcl.com">marena@tcl.com — cliente (TCL Colombia)</option>
            <option value="ajeno@otraagencia.co">ajeno@otraagencia.co — admin (otra agencia)</option>
          </select>
        </div>

        <button className="btn pri" type="submit" disabled={enviando} style={{ width: '100%' }}>
          {enviando ? 'Entrando…' : 'Entrar →'}
        </button>
      </form>
      <p className="sub" style={{ fontSize: 12.5, marginTop: 20 }}>
        Proveedor de identidad en modo desarrollo. El usuario debe existir previamente en la base:
        autenticarse verifica quién eres, no concede acceso por sí solo.
      </p>
    </>
  );
}
