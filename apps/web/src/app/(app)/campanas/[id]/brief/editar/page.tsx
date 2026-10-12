import { notFound, redirect } from 'next/navigation';
import {
  contarConversacionesAbiertas,
  getCampaign,
  listarPreguntas,
  verCamposDeVersion,
  versionesDelBrief,
} from '@tcl-kol-os/db';
import { campoDelCatalogo, type BriefStatus } from '@tcl-kol-os/domain';
import { currentUser } from '@/lib/session';
import { desviarClienteDeRutaLegada } from '@/lib/tcl-guard';
import { ORDEN_DE_SECCIONES, TITULO_SECCION } from '@/lib/brief-sections';
import { ESTADO_EN_ESPANOL } from '@/lib/brief-ui';
import { monogramaColor, monogramaIniciales } from '@/lib/monograma';
import { EditorBrief } from './EditorBrief';

export const dynamic = 'force-dynamic';

export default async function EditorBriefPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ panel?: string; status?: string; producto?: string; error?: string }>;
}) {
  const user = await currentUser();
  if (user === undefined) redirect('/login');
  // Cliente TCL: a su equivalente de `/tcl` (o 404) ANTES de cualquier cargador interno.
  desviarClienteDeRutaLegada(user, { tipo: 'brief', id: (await params).id });
  if (user.role === 'cliente') redirect(`/campanas/${(await params).id}/brief`);

  const { id } = await params;
  const { panel, status, producto, error } = await searchParams;

  const campana = await getCampaign(user, id);
  if (!campana.ok) notFound();

  const versiones = await versionesDelBrief(user, id);
  const ultima = versiones.ok ? versiones.value[0] : undefined;
  if (ultima === undefined) redirect(`/campanas/${id}/brief`);

  const camposResultado = await verCamposDeVersion(user, ultima.id);
  const campos = camposResultado.ok ? camposResultado.value : [];

  const filtroPreguntas: { status?: 'pendiente' | 'respondida' | 'descartada'; campaignProductId?: string } = {};
  if (status === 'pendiente' || status === 'respondida' || status === 'descartada') filtroPreguntas.status = status;
  if (producto !== undefined && producto !== '') filtroPreguntas.campaignProductId = producto;

  const [preguntasPendientesResultado, preguntasFiltradasResultado] = await Promise.all([
    listarPreguntas(user, id, { status: 'pendiente' }),
    listarPreguntas(user, id, filtroPreguntas),
  ]);
  const preguntasCriticasPendientes = preguntasPendientesResultado.ok
    ? preguntasPendientesResultado.value.filter((p) => p.criticidad === 'critico').length
    : 0;
  const preguntasPendientesTotal = preguntasPendientesResultado.ok ? preguntasPendientesResultado.value.length : 0;
  const preguntas = (preguntasFiltradasResultado.ok ? preguntasFiltradasResultado.value : []).map((p) => ({
    ...p,
    createdAt: p.createdAt.toISOString(),
    answeredAt: p.answeredAt?.toISOString() ?? null,
    campo: campoDelCatalogo(p.key),
  }));

  const conteos = await contarConversacionesAbiertas(user, ultima.id);
  const conteosComentarios = conteos.ok ? conteos.value : {};

  const camposConCatalogo = campos.map((c) => {
    const catalogo = campoDelCatalogo(c.key);
    return {
      ...c,
      label: catalogo?.label ?? c.key,
      section: catalogo?.section ?? 'practico',
      description: catalogo?.description ?? '',
      valueType: catalogo?.valueType ?? 'texto',
      valoresPermitidos: catalogo?.valoresPermitidos,
      nivel: catalogo?.nivel ?? 'campana',
    };
  });

  const secciones = ORDEN_DE_SECCIONES.filter((s) => camposConCatalogo.some((c) => c.section === s)).map((s) => ({
    id: s,
    titulo: TITULO_SECCION[s] ?? s,
    campos: camposConCatalogo.filter((c) => c.section === s),
  }));

  const productos = campana.value.productos.map((p) => ({ id: p.id, model: p.model, rol: p.rol }));

  return (
    <div className="content content-workspace ui-enter">
      <a className="back-link" href={`/campanas/${id}/brief`}>← Volver al brief</a>

      <header className="brief-editor-header">
        <span className={`monogram lg ${monogramaColor(id)}`}>{monogramaIniciales(campana.value.campaign.name)}</span>
        <div>
          <div className="eyebrow">Brief workspace</div>
          <h1>{campana.value.campaign.name}</h1>
          <p>Versión {ultima.version} · <span className="status-inline">{ESTADO_EN_ESPANOL[ultima.status as BriefStatus] ?? ultima.status}</span></p>
        </div>
        <div className="brief-editor-header-actions">
          <a className="btn" href={`/campanas/${id}/fuentes`}>Fuentes</a>
          <a className="btn" href={`/campanas/${id}/brief`}>Revisión</a>
        </div>
      </header>

      {error !== undefined && (
        <div className="aviso error"><strong>No se pudo completar la acción</strong>{decodeURIComponent(error)}</div>
      )}

      <EditorBrief
        campaignId={id}
        versionId={ultima.id}
        estadoVersion={ultima.status}
        secciones={secciones}
        productos={productos}
        preguntasCriticasPendientes={preguntasCriticasPendientes}
        preguntasPendientesTotal={preguntasPendientesTotal}
        conteosComentarios={conteosComentarios}
        preguntas={preguntas}
        filtroPreguntasStatus={filtroPreguntas.status}
        filtroPreguntasProducto={filtroPreguntas.campaignProductId}
        panelInicial={panel === 'preguntas' ? 'preguntas' : undefined}
      />
    </div>
  );
}
