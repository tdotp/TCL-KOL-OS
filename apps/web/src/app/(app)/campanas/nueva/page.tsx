import { redirect } from 'next/navigation';
import { listProducts } from '@tcl-kol-os/db';
import { currentUser } from '@/lib/session';
import { FormularioCampana } from './FormularioCampana';

export const dynamic = 'force-dynamic';

/** Nueva campaña multiproducto sobre el dominio real. */
export default async function NuevaCampanaPage() {
  const user = await currentUser();
  if (user === undefined) redirect('/login');

  const productos = await listProducts();

  return (
    <div className="content content-wide ui-enter">
      <div className="page-head page-head-spacious">
        <div>
          <a className="back-link" href="/campanas">← Campañas</a>
          <div className="eyebrow" style={{ marginTop: 18 }}>Setup</div>
          <h1>Nueva campaña</h1>
          <p className="sub">Define lo esencial. Fuentes, preguntas y brief se trabajan después dentro de la campaña.</p>
        </div>
      </div>

      <div className="setup-stepper" aria-label="Flujo de creación">
        <div className="setup-step active"><span>1</span><strong>Datos</strong></div>
        <div className="setup-step"><span>2</span><strong>Fuentes</strong></div>
        <div className="setup-step"><span>3</span><strong>Brief</strong></div>
        <div className="setup-step"><span>4</span><strong>Revisión</strong></div>
      </div>

      <FormularioCampana productos={productos} />
    </div>
  );
}
