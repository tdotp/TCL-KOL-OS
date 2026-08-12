import { notFound, redirect } from 'next/navigation';
import { getCampaign, listSources } from '@tcl-kol-os/db';
import { Encabezado } from '@/components/Encabezado';
import { currentUser } from '@/lib/session';
import { FormularioFuente } from './FormularioFuente';
import { TablaFuentes } from './TablaFuentes';

export const dynamic = 'force-dynamic';

/**
 * UI-06 · Carga de fuentes y UI-07 · Estado de procesamiento.
 *
 * Van juntas a propósito: quien acaba de cargar un archivo quiere ver en qué va,
 * y separarlo en dos pantallas obligaría a navegar para saberlo.
 */
export default async function FuentesPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (user === undefined) redirect('/login');

  const { id } = await params;

  const campana = await getCampaign(user, id);
  if (!campana.ok) notFound();

  const fuentes = await listSources(user, id);
  const filas = fuentes.ok ? fuentes.value : [];

  return (
    <>
      <Encabezado user={user} />
      <main>
        <p className="sub" style={{ marginBottom: 4 }}>
          <a href={`/campanas/${id}`}>← {campana.value.campaign.name}</a>
        </p>
        <h1>Fuentes</h1>
        <p className="sub">
          El material que alimenta el brief: PPT de TCL China, fichas técnicas y briefs del cliente.
        </p>

        {user.role !== 'cliente' && <FormularioFuente campaignId={id} />}

        <TablaFuentes campaignId={id} fuentes={filas} />
      </main>
    </>
  );
}
