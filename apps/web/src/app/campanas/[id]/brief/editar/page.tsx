import { notFound, redirect } from 'next/navigation';
import { getCampaign, listarPreguntas, verCamposDeVersion, versionesDelBrief } from '@tcl-kol-os/db';
import { campoDelCatalogo } from '@tcl-kol-os/domain';
import { Encabezado } from '@/components/Encabezado';
import { currentUser } from '@/lib/session';
import { EditorBrief } from './EditorBrief';

export const dynamic = 'force-dynamic';

/** Los diez bloques canónicos de D0-05 §2.1, en el orden en que se navegan. */
const ORDEN_DE_SECCIONES = [
  'contexto',
  'objetivo',
  'target_audiencia',
  'problema_insight',
  'marca_producto',
  'mandatorios',
  'mensaje_principal',
  'accion_kpis',
  'entregable_creativo',
  'practico',
];

const TITULO_SECCION: Record<string, string> = {
  contexto: 'Contexto',
  objetivo: 'Objetivo',
  target_audiencia: 'Audiencia objetivo',
  problema_insight: 'Problema e insight',
  marca_producto: 'Marca y producto',
  mandatorios: 'Mandatorios',
  mensaje_principal: 'Mensaje principal',
  accion_kpis: 'Acción y KPIs',
  entregable_creativo: 'Entregable creativo',
  practico: 'Datos prácticos',
};

/**
 * UI-10 · Editor estructurado del brief (Épica E7).
 *
 * Navega por los diez bloques canónicos, no por la lista plana de 41 claves
 * técnicas — esas quedan disponibles como información secundaria, nunca como
 * la experiencia principal (sección 6 del pedido). La validación contra el
 * esquema no se reimplementa aquí: el botón de "Enviar a revisión interna"
 * llama a la misma `transicionarBrief` de siempre, y lo que el dominio
 * rechace se muestra tal cual (ADR-008).
 */
export default async function EditorBriefPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (user === undefined) redirect('/login');
  if (user.role === 'cliente') redirect(`/campanas/${(await params).id}/brief`);

  const { id } = await params;

  const campana = await getCampaign(user, id);
  if (!campana.ok) notFound();

  const versiones = await versionesDelBrief(user, id);
  const ultima = versiones.ok ? versiones.value[0] : undefined;
  if (ultima === undefined) redirect(`/campanas/${id}/brief`);

  const camposResultado = await verCamposDeVersion(user, ultima.id);
  const campos = camposResultado.ok ? camposResultado.value : [];

  const preguntas = await listarPreguntas(user, id, { status: 'pendiente' });
  const preguntasCriticas = preguntas.ok ? preguntas.value.filter((p) => p.criticidad === 'critico') : [];

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

  return (
    <>
      <Encabezado user={user} />
      <main>
        <p className="sub" style={{ marginBottom: 4 }}>
          <a href={`/campanas/${id}/brief`}>← Volver a la extracción</a>
        </p>
        <h1>Editor del brief</h1>
        <p className="sub">
          {campana.value.campaign.name} · versión {ultima.version} · estado{' '}
          <span className="pill">{ultima.status}</span>
        </p>

        <EditorBrief
          campaignId={id}
          versionId={ultima.id}
          estadoVersion={ultima.status}
          secciones={secciones}
          productos={campana.value.productos.map((p) => ({ id: p.id, model: p.model, rol: p.rol }))}
          preguntasCriticasPendientes={preguntasCriticas.length}
        />
      </main>
    </>
  );
}
