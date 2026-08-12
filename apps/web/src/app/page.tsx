/**
 * Página de verificación del Sprint 0.
 *
 * Existe para demostrar que el cableado funciona: la aplicación web consume
 * `packages/domain` y las reglas de negocio se ejecutan de verdad.
 * Se reemplaza por el inicio operativo (UI-02) en el Sprint 1.
 */

import { TRANSITIONS, actionsFor, allowedTransitions } from '@tcl-kol-os/domain';
import type { Role, User } from '@tcl-kol-os/domain';

const DEMO_USER: User = {
  id: 'usr-demo',
  email: 'demo@smartpr.co',
  name: 'Usuario piloto',
  organizationId: 'org-smartpr',
  role: 'admin',
  status: 'activo',
};

const card: React.CSSProperties = {
  background: '#fff',
  border: '1px solid #dfe3e8',
  borderRadius: 8,
  padding: 20,
  marginBottom: 16,
};

export default function Home() {
  const roles: Role[] = ['admin', 'director', 'consultor', 'analista', 'legal', 'cliente'];

  return (
    <main style={{ maxWidth: 820, margin: '0 auto', padding: '40px 24px' }}>
      <h1 style={{ fontSize: 26, marginBottom: 4 }}>TCL KOL OS</h1>
      <p style={{ color: '#5c6570', marginTop: 0 }}>
        Sprint 0 — base del repositorio. El dominio está cableado y ejecutándose.
      </p>

      <div style={card}>
        <h2 style={{ fontSize: 14, textTransform: 'uppercase', color: '#5c6570', letterSpacing: '.05em' }}>
          Máquina de estados del brief
        </h2>
        <p style={{ margin: '0 0 8px' }}>
          <strong>{TRANSITIONS.length}</strong> transiciones declaradas, cada una con rol y guardas.
        </p>
        <p style={{ margin: 0, fontSize: 14 }}>
          Desde <code>internal_review</code>, un <strong>director</strong> puede ir a:{' '}
          <code>{allowedTransitions('internal_review', { ...DEMO_USER, role: 'director' }).join(', ')}</code>
        </p>
        <p style={{ margin: '4px 0 0', fontSize: 14 }}>
          Un <strong>consultor</strong>, en cambio:{' '}
          <code>
            {allowedTransitions('internal_review', { ...DEMO_USER, role: 'consultor' }).join(', ') ||
              '(ninguna)'}
          </code>{' '}
          — no puede aprobar internamente.
        </p>
      </div>

      <div style={card}>
        <h2 style={{ fontSize: 14, textTransform: 'uppercase', color: '#5c6570', letterSpacing: '.05em' }}>
          Permisos por rol
        </h2>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <tbody>
            {roles.map((role) => (
              <tr key={role} style={{ borderBottom: '1px solid #dfe3e8' }}>
                <td style={{ padding: '7px 0', fontWeight: 600, width: 110 }}>{role}</td>
                <td style={{ padding: '7px 0', color: '#5c6570' }}>{actionsFor(role).length} acciones</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p style={{ fontSize: 13, color: '#5c6570' }}>
        Próximo incremento: Sprint 1 — identidad, organizaciones y campañas (épicas E2 y E3).
      </p>
    </main>
  );
}
