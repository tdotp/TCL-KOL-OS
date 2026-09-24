import { redirect } from 'next/navigation';

/**
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
  const { id } = await params;
  const query = new URLSearchParams();
  query.set('panel', 'preguntas');

  const { status, producto, error } = await searchParams;
  if (status !== undefined) query.set('status', status);
  if (producto !== undefined) query.set('producto', producto);
  if (error !== undefined) query.set('error', error);

  redirect(`/campanas/${id}/brief/editar?${query.toString()}`);
}
