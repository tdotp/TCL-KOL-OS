import { redirect } from 'next/navigation';
import { listProducts } from '@tcl-kol-os/db';
import { Encabezado } from '@/components/Encabezado';
import { currentUser } from '@/lib/session';
import { FormularioCampana } from './FormularioCampana';

export const dynamic = 'force-dynamic';

/** UI-04 · Nueva campaña, con varios productos (DEC-016). */
export default async function NuevaCampanaPage() {
  const user = await currentUser();
  if (user === undefined) redirect('/login');

  const productos = await listProducts();

  return (
    <>
      <Encabezado user={user} />
      <main style={{ maxWidth: 720 }}>
        <h1>Nueva campaña</h1>
        <p className="sub">
          Una campaña puede cubrir varios productos: una línea con gamas, productos complementarios o una
          campaña de temporada.
        </p>
        <FormularioCampana productos={productos} />
      </main>
    </>
  );
}
