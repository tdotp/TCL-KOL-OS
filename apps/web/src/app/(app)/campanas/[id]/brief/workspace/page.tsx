import { notFound, redirect } from 'next/navigation';
import { obtenerBriefWorkspace } from '@tcl-kol-os/db';
import { currentUser } from '@/lib/session';
import { desviarClienteDeRutaLegada } from '@/lib/tcl-guard';
import { WorkspaceGuiado } from './WorkspaceGuiado';
import { RevisarBrief } from './RevisarBrief';
import { Actividad } from './Actividad';
import { WorkspaceNav, BannerResponsabilidad, type ModoWorkspace } from './WorkspaceNav';

export const dynamic = 'force-dynamic';

/**
 * Sprint 6 — Brief Workspace, con tres modos navegables por URL desde el
 * Checkpoint 2 (Completar / Revisar brief / Actividad), todos sobre el
 * mismo `obtenerBriefWorkspace` — ninguno vuelve a ensamblar el brief
 * desde React ni crea una proyección paralela.
 *
 * Existe detrás de `BRIEF_WORKSPACE_V2` (§3.5 del pedido original): con la
 * bandera apagada, esta ruta reenvía al editor estructurado de siempre —
 * nunca un 404, nunca una pantalla a medias. La ruta anterior
 * (`/brief/editar`) no se toca ni se retira.
 */
function briefWorkspaceV2Activo(): boolean {
  return process.env['BRIEF_WORKSPACE_V2'] === 'true';
}

const TITULOS: Record<ModoWorkspace, string> = {
  completar: 'Completar el brief',
  revisar: 'Revisar brief',
  actividad: 'Actividad',
};

const SUBTITULOS: Record<ModoWorkspace, string> = {
  completar:
    'Una tarea a la vez, en lenguaje sencillo. Esto no reemplaza el brief estructurado — lo construye.',
  revisar:
    'El brief como documento, organizado por los diez bloques canónicos — no como una tabla de base de datos.',
  actividad: 'Comentarios, cambios de campo y aprobaciones, derivados del historial real — nunca inventados.',
};

export default async function BriefWorkspaceGuiadoPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ modo?: string; producto?: string }>;
}) {
  const user = await currentUser();
  if (user === undefined) redirect('/login');
  // Cliente TCL: a su equivalente de `/tcl` (o 404) ANTES de cualquier cargador interno.
  desviarClienteDeRutaLegada(user, { tipo: 'brief', id: (await params).id });

  const { id } = await params;

  if (!briefWorkspaceV2Activo()) redirect(`/campanas/${id}/brief/editar`);
  // El workspace interno resuelve preguntas locales, comentarios y el historial de campo (artefactos internos).
  // El cliente nunca llega aquí: `desviarClienteDeRutaLegada` lo redirige antes de cualquier cargador.

  const { modo: modoCrudo, producto } = await searchParams;
  // Un modo inválido vuelve a "completar" — nunca un error ni una pantalla en blanco.
  const modo: ModoWorkspace = modoCrudo === 'revisar' || modoCrudo === 'actividad' ? modoCrudo : 'completar';

  const resultado = await obtenerBriefWorkspace(user, id);
  if (!resultado.ok) notFound();

  const workspace = resultado.value;
  if (workspace.version === undefined) {
    // Sin ninguna versión todavía: no hay nada que completar, revisar ni
    // auditar de forma guiada — la pantalla real para arrancar (fuentes o
    // brief a mano) sigue siendo `/brief`.
    redirect(`/campanas/${id}/brief`);
  }

  return (
    <div className="content" style={{ maxWidth: modo === 'completar' ? 760 : 1100 }}>
      <p className="sub" style={{ marginBottom: 4 }}>
        <a href={`/campanas/${id}/brief`}>← {workspace.campaign.name}</a>
      </p>
      <h1>{TITULOS[modo]}</h1>
      <p className="sub">{SUBTITULOS[modo]}</p>

      <WorkspaceNav campaignId={id} modo={modo} />
      <BannerResponsabilidad
        campaignId={id}
        responsibility={workspace.responsibility}
        allowedActions={workspace.allowedActions}
      />

      {modo === 'completar' && <WorkspaceGuiado campaignId={id} workspace={workspace} />}
      {modo === 'revisar' && (
        <RevisarBrief campaignId={id} workspace={workspace} productoActivoId={producto} />
      )}
      {modo === 'actividad' && <Actividad activity={workspace.activity} />}
    </div>
  );
}
