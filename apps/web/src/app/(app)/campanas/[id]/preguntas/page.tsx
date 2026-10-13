import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/session';
import { desviarClienteDeRutaLegada } from '@/lib/tcl-guard';

/**
 * @deprecated Ruta legada: se conserva solo como redirect a `brief/editar?panel=preguntas`. No añadir lógica aquí.
 *
 * Preguntas locales se fusionó dentro del Brief Workspace (rediseño v2) —
 * ya no es una pantalla propia. Esta ruta se conserva como redirect para no
 * romper enlaces guardados; reenvía al panel de preguntas del editor con los
 * mismos filtros.
 */
export default async function PreguntasRedirectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const user = await currentUser();
  if (user === undefined) redirect('/login');
  const { id } = await params;
  // Cliente TCL: a su equivalente de `/tcl` (o 404) ANTES de cualquier redirección interna.
  desviarClienteDeRutaLegada(user, { tipo: 'brief', id });
  const query = new URLSearchParams();
  query.set('panel', 'preguntas');

  const { status, producto, error } = await searchParams;
  if (status !== undefined) query.set('status', status);
  if (producto !== undefined) query.set('producto', producto);
  if (error !== undefined) query.set('error', error);

  redirect(`/campanas/${id}/brief/editar?${query.toString()}`);
}
