/**
 * Export del dashboard TCL (V2 · Fase 9).
 *
 *   GET /api/tcl/campanas/[id]/export?formato=csv|json
 *
 * Serializa EXACTAMENTE la misma proyección que muestra la interfaz (`exportarCampanaParaTcl`): ninguna consulta
 * propia. Seguridad (no hay middleware: la ruta se protege sola):
 *  · sesión (`currentUser`, releída de la base); sin sesión, rol distinto de `cliente`, campaña ajena, no visible,
 *    inexistente, id mal formado o formato desconocido ⇒ el MISMO 404 (no se revela qué existe);
 *  · cabeceras: tipo y nombre de archivo de la proyección (saneado), `attachment`, `nosniff`, `private, no-store`;
 *  · cualquier error inesperado ⇒ 500 genérico, sin trazas ni detalles.
 */

import { exportarCampanaParaTcl } from '@tcl-kol-os/db';
import { currentUser } from '../../../../../../lib/session.ts';
import { nombreDeArchivoSeguro } from '../../../../../../lib/tcl-rutas.ts';
import { esUuidTcl } from '../../../../../../lib/tcl-ui.ts';

export const dynamic = 'force-dynamic';

const CABECERAS_BASE = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
} as const;

function noEncontrado(): Response {
  return Response.json(
    { ok: false, codigo: 'RESOURCE_NOT_FOUND', mensaje: 'No encontramos ese elemento.' },
    { status: 404, headers: CABECERAS_BASE },
  );
}

export async function GET(
  request: Request,
  contexto: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await contexto.params;
    const user = await currentUser();
    if (user === undefined || user.role !== 'cliente' || !esUuidTcl(id)) return noEncontrado();

    const formato = new URL(request.url).searchParams.get('formato') ?? '';
    if (formato !== 'csv' && formato !== 'json') return noEncontrado();

    const resultado = await exportarCampanaParaTcl(user, id, formato);
    if (!resultado.ok) return noEncontrado();

    const { contenido, contentType, nombreDeArchivo } = resultado.value;
    return new Response(contenido, {
      status: 200,
      headers: {
        ...CABECERAS_BASE,
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${nombreDeArchivoSeguro(nombreDeArchivo)}"`,
      },
    });
  } catch (error) {
    console.error('[tcl-export] GET', error instanceof Error ? error.name : typeof error);
    return Response.json(
      { ok: false, codigo: 'INTERNAL', mensaje: 'No pudimos generar la exportación. Inténtalo de nuevo.' },
      { status: 500, headers: CABECERAS_BASE },
    );
  }
}
