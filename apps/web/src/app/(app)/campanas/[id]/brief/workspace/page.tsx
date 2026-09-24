import { notFound, redirect } from 'next/navigation';
import { obtenerBriefWorkspace } from '@tcl-kol-os/db';
import { currentUser } from '@/lib/session';
import { WorkspaceGuiado } from './WorkspaceGuiado';

export const dynamic = 'force-dynamic';

/**
 * Sprint 6, Fase C — Brief Workspace guiado.
 *
 * Existe detrás de `BRIEF_WORKSPACE_V2` (§3.5 del pedido): con la bandera
 * apagada, esta ruta reenvía al editor estructurado de siempre — nunca un
 * 404, nunca una pantalla a medias. La ruta anterior (`/brief/editar`) no
 * se toca ni se retira; esta es una superficie nueva encima del mismo
 * `obtenerBriefWorkspace`, nunca una segunda fuente de datos.
 */
function briefWorkspaceV2Activo(): boolean {
  return process.env['BRIEF_WORKSPACE_V2'] === 'true';
}

export default async function BriefWorkspaceGuiadoPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (user === undefined) redirect('/login');

  const { id } = await params;

  if (!briefWorkspaceV2Activo()) redirect(`/campanas/${id}/brief/editar`);
  // La experiencia guiada resuelve preguntas locales — un artefacto interno
  // de construcción del brief. El cliente sigue teniendo su propia pantalla
  // de solo lectura y decisión (`VistaCliente`, Fase D de Sprint 5), sin
  // cambios.
  if (user.role === 'cliente') redirect(`/campanas/${id}/brief`);

  const resultado = await obtenerBriefWorkspace(user, id);
  if (!resultado.ok) notFound();

  const workspace = resultado.value;
  if (workspace.version === undefined) {
    // Sin ninguna versión todavía: no hay nada que completar de forma
    // guiada — la pantalla real para arrancar (fuentes o brief a mano)
    // sigue siendo `/brief`.
    redirect(`/campanas/${id}/brief`);
  }

  return (
    <div className="content" style={{ maxWidth: 760 }}>
      <p className="sub" style={{ marginBottom: 4 }}>
        <a href={`/campanas/${id}/brief`}>← {workspace.campaign.name}</a>
      </p>
      <h1>Completar el brief</h1>
      <p className="sub">
        Una tarea a la vez, en lenguaje sencillo. Esto no reemplaza el brief estructurado — lo construye.
      </p>

      <WorkspaceGuiado campaignId={id} workspace={workspace} />
    </div>
  );
}
