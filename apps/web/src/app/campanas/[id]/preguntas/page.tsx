import { notFound, redirect } from 'next/navigation';
import { getCampaign, listarPreguntas, versionesDelBrief } from '@tcl-kol-os/db';
import { campoDelCatalogo } from '@tcl-kol-os/domain';
import { Encabezado } from '@/components/Encabezado';
import { currentUser } from '@/lib/session';
import { generarPreguntasDeBrief } from '@/lib/actions';
import { TablaPreguntas } from './TablaPreguntas';

export const dynamic = 'force-dynamic';

/**
 * UI-09 · Preguntas locales (Épica E6, completa).
 *
 * `generarPreguntasDeBrief` está aquí en el servidor porque no necesita
 * feedback inline (redirige y revalida); responder y descartar sí lo
 * necesitan —cada campo exige un control distinto según su `valueType`— y
 * viven en `TablaPreguntas.tsx`, del lado cliente.
 */
export default async function PreguntasPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ status?: string; producto?: string; error?: string }>;
}) {
  const user = await currentUser();
  if (user === undefined) redirect('/login');

  const { id } = await params;
  const { status, producto, error } = await searchParams;

  const campana = await getCampaign(user, id);
  if (!campana.ok) notFound();

  const filtro: { status?: 'pendiente' | 'respondida' | 'descartada'; campaignProductId?: string } = {};
  if (status === 'pendiente' || status === 'respondida' || status === 'descartada') filtro.status = status;
  if (producto !== undefined && producto !== '') filtro.campaignProductId = producto;

  const preguntas = await listarPreguntas(user, id, filtro);
  const lista = preguntas.ok ? preguntas.value : [];

  const versiones = await versionesDelBrief(user, id);
  const versionActual = versiones.ok ? versiones.value[0] : undefined;

  // Cada pregunta trae su definición canónica (tipo de valor, opciones si es
  // enum) para que el formulario de respuesta nunca sea un único textarea
  // genérico — el control que se muestra depende del campo real (§5.3).
  const preguntasConCampo = lista.map((p) => ({
    ...p,
    createdAt: p.createdAt.toISOString(),
    answeredAt: p.answeredAt?.toISOString() ?? null,
    campo: campoDelCatalogo(p.key),
  }));

  const productos = campana.value.productos;

  return (
    <>
      <Encabezado user={user} />
      <main>
        <p className="sub" style={{ marginBottom: 4 }}>
          <a href={`/campanas/${id}/brief`}>← Volver al brief</a>
        </p>
        <h1>Preguntas locales</h1>
        <p className="sub">
          Un campo del brief que el sistema no pudo llenar solo, con el motivo por el que quedó
          pendiente. Cada pregunta se responde con autor y fecha, o se descarta con justificación.
        </p>

        {error !== undefined && (
          <div className="aviso error">
            <strong>No se pudo completar la acción</strong>
            {decodeURIComponent(error)}
          </div>
        )}

        {user.role !== 'cliente' && versionActual !== undefined && (
          <form action={generarPreguntasDeBrief} style={{ marginBottom: 16 }}>
            <input type="hidden" name="campaignId" value={id} />
            <input type="hidden" name="versionId" value={versionActual.id} />
            <button className="btn" type="submit">
              Generar preguntas de lo que falte
            </button>
          </form>
        )}

        <TablaPreguntas
          preguntas={preguntasConCampo}
          campaignId={id}
          productos={productos.map((p) => ({ id: p.id, model: p.model }))}
          filtroStatus={filtro.status}
          filtroProducto={filtro.campaignProductId}
          editable={user.role !== 'cliente'}
        />
      </main>
    </>
  );
}
