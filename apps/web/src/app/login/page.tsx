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
    <main className="login-page">
      <div className="login-wrap card">
        <div className="login-left">
          <div className="shell-brand" style={{ marginBottom: 40 }}>
            <div className="shell-brand-mark">
              <span />
              <span />
            </div>
            <div>
              <div className="shell-brand-title">TCL KOL OS</div>
              <div className="shell-brand-sub">by SmartPR</div>
            </div>
          </div>

          <h1 style={{ fontSize: 34 }}>Bienvenido</h1>
          <p className="sub">Plataforma interna de SmartPR para coordinar campañas KOL de TCL.</p>

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
        </div>
        <div className="login-right">
          <div className="login-ribbon" />
          <div className="login-ribbon second" />
          <div className="login-statement">
            <div className="login-eyebrow">TCL KOL OS</div>
            <h2>
              Campañas KOL,
              <br />
              <span>de fuente a brief aprobado</span>
            </h2>
            <p className="sub">
              Extracción con evidencia, revisión por rol y un historial que nunca se reescribe.
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
