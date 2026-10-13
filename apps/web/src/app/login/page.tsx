import { authProvider } from '@/lib/session';
import FormularioLogin from './FormularioLogin';

// El proveedor se lee del entorno en cada petición (nunca se fija al compilar).
export const dynamic = 'force-dynamic';

/**
 * UI-01 · Acceso.
 *
 * En desarrollo (`AUTH_PROVIDER=dev`) se elige un usuario ya sembrado. Con cualquier otro proveedor, o sin
 * configurar en producción, NO se muestra el formulario (fail-closed): solo un aviso. Con OIDC este bloque se
 * sustituirá por el flujo de Google Workspace, sin que cambie nada del resto del sistema.
 */
export default function LoginPage() {
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

          <div className="eyebrow">Acceso</div>
          <h1 style={{ fontSize: 34 }}>Bienvenido de nuevo</h1>
          <p className="sub">
            Continúa a TCL KOL OS para gestionar campañas, fuentes y briefs en un solo lugar.
          </p>

          {authProvider() === 'dev' ? (
            <FormularioLogin />
          ) : (
            <div className="aviso error" style={{ marginTop: 28 }}>
              <strong>Acceso no disponible</strong>
              Proveedor de identidad no configurado.
            </div>
          )}
        </div>
        <div className="login-right">
          <div className="login-ribbon" />
          <div className="login-ribbon second" />
          <div className="login-statement">
            <div className="login-eyebrow">TCL KOL OS</div>
            <h2>
              Menos fricción,
              <br />
              <span>más claridad operativa</span>
            </h2>
            <p className="sub">Fuentes, preguntas, evidencia y revisión conectadas en un mismo flujo.</p>
          </div>
        </div>
      </div>
    </main>
  );
}
