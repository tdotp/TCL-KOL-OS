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
import { ORDEN_DE_SECCIONES, TITULO_SECCION } from '@/lib/brief-sections';
import { ESTADO_EN_ESPANOL } from '@/lib/brief-ui';
import { EditorBrief } from './EditorBrief';

export const dynamic = 'force-dynamic';

/**
 * UI-10 · Editor estructurado del brief (Épica E7) + UI-09 · Preguntas
 * locales (Épica E6), fusionadas en un único workspace: navega por los diez
 * bloques canónicos más un panel de preguntas pendientes, nunca por la lista
 * plana de 41 claves técnicas (sección 6 del pedido). La validación contra
 * el esquema no se reimplementa aquí: el botón de "Enviar a revisión
 * interna" llama a la misma `transicionarBrief` de siempre, y lo que el
 * dominio rechace se muestra tal cual (ADR-008).
 */
export default async function EditorBriefPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ panel?: string; status?: string; producto?: string; error?: string }>;
}) {
  const user = await currentUser();
  if (user === undefined) redirect('/login');
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

  const filtroPreguntas: { status?: 'pendiente' | 'respondida' | 'descartada'; campaignProductId?: string } =
    {};
  if (status === 'pendiente' || status === 'respondida' || status === 'descartada')
    filtroPreguntas.status = status;
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

  const secciones = ORDEN_DE_SECCIONES.filter((s) => camposConCatalogo.some((c) => c.section === s)).map(
    (s) => ({
      id: s,
      titulo: TITULO_SECCION[s] ?? s,
      campos: camposConCatalogo.filter((c) => c.section === s),
    }),
  );

  const productos = campana.value.productos.map((p) => ({ id: p.id, model: p.model, rol: p.rol }));

  return (
    <div className="content" style={{ maxWidth: 1280 }}>
      <p className="sub" style={{ marginBottom: 4 }}>
        <a href={`/campanas/${id}/brief`}>← Volver a la extracción</a>
      </p>
      <h1>Editor del brief</h1>
      <p className="sub">
        {campana.value.campaign.name} · versión {ultima.version} · estado{' '}
        <span className="pill">{ESTADO_EN_ESPANOL[ultima.status as BriefStatus] ?? ultima.status}</span>
      </p>

      {error !== undefined && (
        <div className="aviso error">
          <strong>No se pudo completar la acción</strong>
          {decodeURIComponent(error)}
        </div>
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
