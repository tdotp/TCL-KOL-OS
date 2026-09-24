import { notFound, redirect } from 'next/navigation';
import {
  getCampaign,
  listSources,
  listarPreguntas,
  verCamposDeVersion,
  versionesDelBrief,
} from '@tcl-kol-os/db';
import { allowedTransitions, type BriefStatus } from '@tcl-kol-os/domain';
import { currentUser } from '@/lib/session';
import { archivarCampana, crearBriefManualDeCampana } from '@/lib/actions';
import { ConfirmarAccion } from '@/components/ConfirmarAccion';
import { ESTADO_EN_ESPANOL, ETAPAS, TEXTO_DEL_BOTON, etapaDeStatus } from '@/lib/brief-ui';
import { monogramaColor, monogramaIniciales } from '@/lib/monograma';

export const dynamic = 'force-dynamic';

function fecha(valor: Date | null): string {
  return valor === null
    ? '—'
    : new Date(valor).toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Sprint 6, Fase C — con la bandera apagada, ningún enlace nuevo aparece; el flujo anterior queda intacto. */
function briefWorkspaceV2Activo(): boolean {
  return process.env['BRIEF_WORKSPACE_V2'] === 'true';
}

/** Centro operativo de una campaña; todo lo mostrado proviene del estado real. */
export default async function DetalleCampanaPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await currentUser();
  if (user === undefined) redirect('/login');

  const { id } = await params;
  const { error } = await searchParams;

  const resultado = await getCampaign(user, id);
  if (!resultado.ok) notFound();
  const { campaign, productos, avisoPresupuesto } = resultado.value;

  const [versiones, fuentes] = await Promise.all([versionesDelBrief(user, id), listSources(user, id)]);
  const versionActual = versiones.ok ? versiones.value[0] : undefined;
  const filasFuentes = fuentes.ok ? fuentes.value : [];

  const preguntas = await listarPreguntas(user, id, { status: 'pendiente' });
  const preguntasCriticasPendientes = preguntas.ok
    ? preguntas.value.filter((p) => p.criticidad === 'critico').length
    : 0;

  const campos = versionActual === undefined ? undefined : await verCamposDeVersion(user, versionActual.id);
  const listaCampos = campos !== undefined && campos.ok ? campos.value : [];
  const encontrados = listaCampos.filter((c) => c.status === 'found').length;
  const progresoBrief = listaCampos.length === 0 ? 0 : Math.round((encontrados / listaCampos.length) * 100);

  const estadoBrief = versionActual?.status as BriefStatus | undefined;
  const etapaActual = etapaDeStatus(estadoBrief);
  const indiceEtapaActual = ETAPAS.findIndex((e) => e.id === etapaActual);
  const transicionesPosibles =
    versionActual !== undefined ? allowedTransitions(versionActual.status as BriefStatus, user) : [];
  const proximaTransicion = transicionesPosibles.find((t) => t in TEXTO_DEL_BOTON);

  const siguienteAccion =
    user.role !== 'cliente' && preguntasCriticasPendientes > 0
      ? {
          label: `Responder ${preguntasCriticasPendientes} pregunta${preguntasCriticasPendientes > 1 ? 's' : ''} crítica${preguntasCriticasPendientes > 1 ? 's' : ''}`,
          detalle: 'Bloquean el avance del brief',
          href: `/campanas/${campaign.id}/brief/editar?panel=preguntas`,
        }
      : versionActual === undefined
        ? user.role === 'cliente'
          ? undefined
          : {
              label: 'Preparar el brief',
              detalle: 'Carga fuentes o inicia una versión manual',
              href: `/campanas/${campaign.id}/fuentes`,
            }
        : proximaTransicion !== undefined
          ? {
              label: TEXTO_DEL_BOTON[proximaTransicion]!,
              detalle: ESTADO_EN_ESPANOL[versionActual.status as BriefStatus],
              href: `/campanas/${campaign.id}/brief`,
            }
          : undefined;

  const fuentesProcesadas = filasFuentes.filter((f) => f.status === 'procesado').length;
  const fuentesEnProceso = filasFuentes.filter(
    (f) => f.status === 'pendiente' || f.status === 'procesando',
  ).length;
  const fuentesFallidas = filasFuentes.filter((f) => f.status === 'fallido').length;

  return (
    <div className="content content-wide ui-enter">
      <a className="back-link" href="/campanas">
        ← Campañas
      </a>

      <header className="campaign-header campaign-header-large">
        <span className={`monogram xl ${monogramaColor(campaign.id)}`}>
          {monogramaIniciales(campaign.name)}
        </span>
        <div className="campaign-heading-copy">
          <div className="campaign-kickers">
            <span className={`status-dot ${campaign.status === 'activa' ? 'ok' : ''}`}>
              {campaign.status}
            </span>
            {campaign.category !== null && <span className="pill neutro">{campaign.category}</span>}
          </div>
          <h1>{campaign.name}</h1>
          <p>
            {campaign.market} · {campaign.owner_name}
          </p>
        </div>
        <div className="campaign-header-actions">
          <a className="btn" href={`/campanas/${campaign.id}/fuentes`}>
            Fuentes
          </a>
          <a className="btn pri" href={`/campanas/${campaign.id}/brief`}>
            Abrir brief →
          </a>
        </div>
      </header>

      <nav className="campaign-context-nav" aria-label="Secciones de campaña">
        <a className="active" href={`/campanas/${campaign.id}`}>
          Resumen
        </a>
        <a href={`/campanas/${campaign.id}/fuentes`}>
          Fuentes <span>{filasFuentes.length}</span>
        </a>
        <a href={`/campanas/${campaign.id}/brief`}>Brief</a>
        {user.role !== 'cliente' && <a href={`/campanas/${campaign.id}/brief/editar`}>Editar</a>}
      </nav>

      <div className="stepper campaign-stepper">
        {ETAPAS.map((etapa, i) => (
          <div
            key={etapa.id}
            className={`step ${i < indiceEtapaActual ? 'done' : i === indiceEtapaActual ? 'current' : ''}`}
          >
            <div className="step-num">{i < indiceEtapaActual ? '✓' : i + 1}</div>
            <div className="step-name">{etapa.nombre}</div>
          </div>
        ))}
      </div>

      {error === 'no_permitido' && (
        <div className="aviso error">
          <strong>Acción no permitida</strong>Tu rol no puede ejecutar esa acción sobre esta campaña.
        </div>
      )}
      {error !== undefined && error !== 'no_permitido' && (
        <div className="aviso error">
          <strong>No se pudo completar la acción</strong>
          {decodeURIComponent(error)}
        </div>
      )}
      {avisoPresupuesto !== undefined && (
        <div className="aviso">
          <strong>Revisar reparto de presupuesto</strong>
          {avisoPresupuesto}
        </div>
      )}

      <div className="grid-2 campaign-overview-layout">
        <div className="campaign-overview-main">
          <section className="card overview-card">
            <div className="overview-card-head">
              <div>
                <div className="eyebrow">Estado actual</div>
                <h2 className="plain-heading">Brief</h2>
                <p className="sub">Avance de la versión vigente y el trabajo que sigue.</p>
              </div>
              {versionActual !== undefined && (
                <span className="pill curso">
                  {ESTADO_EN_ESPANOL[versionActual.status as BriefStatus] ?? versionActual.status}
                </span>
              )}
            </div>

            {versionActual === undefined ? (
              <div className="brief-empty-inline">
                <div className="empty-state-mark">B</div>
                <div>
                  <strong>Todavía no hay una versión del brief.</strong>
                  <p>Carga fuentes y extrae contenido, o empieza el brief manualmente.</p>
                </div>
                {user.role !== 'cliente' && (
                  <form action={crearBriefManualDeCampana}>
                    <input type="hidden" name="campaignId" value={campaign.id} />
                    <button className="btn pri" type="submit">
                      Empezar a mano
                    </button>
                  </form>
                )}
              </div>
            ) : (
              <div className="overview-progress-grid">
                <div
                  className="ring ring-lg"
                  style={{
                    background: `conic-gradient(var(--brand) 0 ${progresoBrief}%, var(--chip) ${progresoBrief}% 100%)`,
                  }}
                >
                  <div>
                    <strong>{progresoBrief}%</strong>
                    <span>campos con dato</span>
                  </div>
                </div>
                <div className="overview-metrics">
                  <div>
                    <span>Versión</span>
                    <strong>v{versionActual.version}</strong>
                  </div>
                  <div>
                    <span>Campos</span>
                    <strong>
                      {encontrados} / {listaCampos.length}
                    </strong>
                  </div>
                  <div>
                    <span>Preguntas críticas</span>
                    <strong>{preguntasCriticasPendientes}</strong>
                  </div>
                </div>
                {briefWorkspaceV2Activo() && user.role !== 'cliente' && (
                  <a
                    className="btn"
                    href={`/campanas/${campaign.id}/brief/workspace`}
                    style={{ marginTop: 4 }}
                  >
                    Completar de forma guiada →
                  </a>
                )}
                {siguienteAccion !== undefined && (
                  <a className="next-action-card" href={siguienteAccion.href}>
                    <span className="next-action-icon">→</span>
                    <span>
                      <small>Siguiente acción</small>
                      <strong>{siguienteAccion.label}</strong>
                      <em>{siguienteAccion.detalle}</em>
                    </span>
                    <b>→</b>
                  </a>
                )}
              </div>
            )}
          </section>

          <section className="card campaign-data-card">
            <div className="eyebrow">Información</div>
            <h2 className="plain-heading">Datos de campaña</h2>
            <dl className="campaign-facts">
              <div>
                <dt>Mercado</dt>
                <dd>{campaign.market}</dd>
              </div>
              <div>
                <dt>Responsable</dt>
                <dd>{campaign.owner_name}</dd>
              </div>
              <div>
                <dt>Inicio</dt>
                <dd>{fecha(campaign.start_date)}</dd>
              </div>
              <div>
                <dt>Fin</dt>
                <dd>{fecha(campaign.end_date)}</dd>
              </div>
              <div>
                <dt>Confidencialidad</dt>
                <dd>{campaign.confidentiality_level}</dd>
              </div>
              <div>
                <dt>Visibilidad</dt>
                <dd>{campaign.visibility}</dd>
              </div>
            </dl>
          </section>

          <section className="card products-card">
            <div className="overview-card-head">
              <div>
                <div className="eyebrow">Scope</div>
                <h2 className="plain-heading">
                  Productos <span className="heading-count">{productos.length}</span>
                </h2>
              </div>
            </div>
            <div className="product-list-clean">
              {productos.map((p) => (
                <div className="product-row-clean" key={p.id}>
                  <span className="product-glyph" aria-hidden="true">
                    ▭
                  </span>
                  <div>
                    <strong>{p.model}</strong>
                    <span>
                      {p.brand} · {p.category}
                    </span>
                  </div>
                  <span className="product-role">{p.rol}</span>
                  <span className="product-priority">Prioridad {p.prioridad}</span>
                  <span className="product-budget">
                    {p.participacion_presupuesto === null
                      ? '—'
                      : `${Math.round(Number(p.participacion_presupuesto) * 100)}%`}
                  </span>
                </div>
              ))}
            </div>
          </section>
        </div>

        <aside className="side-stack campaign-overview-side">
          <section className="card side-card deadline-card">
            <div className="eyebrow">Fecha de cierre</div>
            <div className="side-big-value">{fecha(campaign.end_date)}</div>
            <p>Inicio · {fecha(campaign.start_date)}</p>
          </section>

          <section className="card side-card">
            <div className="side-card-head">
              <div>
                <div className="eyebrow">Fuentes</div>
                <h3 className="section-title">{filasFuentes.length} archivos</h3>
              </div>
              <a href={`/campanas/${campaign.id}/fuentes`}>Ver →</a>
            </div>
            <div className="source-summary-lines">
              <span>
                <i className="status-mark status-mark-ok" />
                {fuentesProcesadas} procesadas
              </span>
              <span>
                <i className="status-mark status-mark-neutral" />
                {fuentesEnProceso} en proceso
              </span>
              {fuentesFallidas > 0 && (
                <span>
                  <i className="status-mark status-mark-bad" />
                  {fuentesFallidas} con error
                </span>
              )}
            </div>
          </section>

          {siguienteAccion !== undefined && (
            <section className="card side-card">
              <div className="eyebrow">Prioridad</div>
              <h3 className="section-title">Siguiente acción</h3>
              <a className="action-row action-row-link" href={siguienteAccion.href}>
                <div className="action-ico">→</div>
                <div className="action-copy">
                  <b>{siguienteAccion.label}</b>
                  <span className="detalle">{siguienteAccion.detalle}</span>
                </div>
                <span className="action-arrow">→</span>
              </a>
            </section>
          )}

          {campaign.status === 'activa' && user.role !== 'cliente' && (
            <section className="card side-card archive-card">
              <div className="eyebrow">Administración</div>
              <h3 className="section-title">Archivar campaña</h3>
              <p>Conserva fuentes, brief e historial; solo sale del listado activo.</p>
              <form action={archivarCampana}>
                <input type="hidden" name="id" value={campaign.id} />
                <ConfirmarAccion
                  etiqueta="Archivar"
                  titulo={`¿Archivar "${campaign.name}"?`}
                  consecuencias={[
                    'La campaña deja de aparecer como activa en el listado.',
                    'Las fuentes, el brief y su historial se conservan.',
                    'Podrá reactivarse posteriormente.',
                  ]}
                  textoConfirmar="Sí, archivar"
                  peligro
                  className="btn"
                />
              </form>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
