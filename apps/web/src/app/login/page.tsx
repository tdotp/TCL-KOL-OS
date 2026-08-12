'use client';

import { useActionState } from 'react';
import { iniciarSesion } from '@/lib/actions';

/**
 * UI-01 · Acceso.
 *
 * En desarrollo se elige un usuario ya sembrado. Con `AUTH_PROVIDER=oidc` este
 * formulario se sustituye por el flujo de Google Workspace, sin que cambie nada
 * del resto del sistema.
 */
export default function LoginPage() {
  const [estado, accion, enviando] = useActionState(iniciarSesion, {});

  return (
    <main style={{ maxWidth: 420, paddingTop: 80 }}>
      <h1>TCL KOL OS</h1>
      <p className="sub">Plataforma interna de SmartPR</p>

      <form action={accion} className="card">
        <h2>Iniciar sesión</h2>

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

        <button className="btn pri" type="submit" disabled={enviando}>
          {enviando ? 'Entrando…' : 'Entrar'}
        </button>
      </form>

      <p className="sub" style={{ fontSize: 13 }}>
        Proveedor de identidad en modo desarrollo. El usuario debe existir previamente en la base:
        autenticarse verifica quién eres, no concede acceso por sí solo.
      </p>
    </main>
  );
}
