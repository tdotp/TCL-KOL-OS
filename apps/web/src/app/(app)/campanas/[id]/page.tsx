import { notFound, redirect } from 'next/navigation';
import { getCampaign, listarPreguntas, verCamposDeVersion, versionesDelBrief } from '@tcl-kol-os/db';
import { allowedTransitions, type BriefStatus } from '@tcl-kol-os/domain';
import { currentUser } from '@/lib/session';
import { archivarCampana, crearBriefManualDeCampana } from '@/lib/actions';
import { ConfirmarAccion } from '@/components/ConfirmarAccion';
import { ESTADO_EN_ESPANOL, ETAPAS, TEXTO_DEL_BOTON, etapaDeStatus } from '@/lib/brief-ui';
import { monogramaColor, monogramaIniciales } from '@/lib/monograma';

export const dynamic = 'force-dynamic';

/**
 * UI-05 · Detalle de campaña.
 *
 * Una campaña de otra organización llega aquí como 404, igual que una que no
 * existe. Es deliberado: distinguirlas revelaría que el recurso existe (S-01).
 */
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

  const versiones = await versionesDelBrief(user, id);
  const versionActual = versiones.ok ? versiones.value[0] : undefined;

  const preguntas = await listarPreguntas(user, id, { status: 'pendiente' });
  const preguntasCriticasPendientes = preguntas.ok
    ? preguntas.value.filter((p) => p.criticidad === 'critico').length
    : 0;

  const campos = versionActual === undefined ? undefined : await verCamposDeVersion(user, versionActual.id);
  const listaCampos = campos !== undefined && campos.ok ? campos.value : [];
  const progresoBrief =
    listaCampos.length === 0 ? 0 : Math.round((listaCampos.filter((c) => c.status === 'found').length / listaCampos.length) * 100);

  const estadoBrief = versionActual?.status as BriefStatus | undefined;
  const etapaActual = etapaDeStatus(estadoBrief);
  const indiceEtapaActual = ETAPAS.findIndex((e) => e.id === etapaActual);

  const transicionesPosibles =
    versionActual !== undefined ? allowedTransitions(versionActual.status as BriefStatus, user) : [];
  const proximaTransicion = transicionesPosibles.find((t) => t in TEXTO_DEL_BOTON);

  // Próxima acción — un único enlace, prioridad: preguntas críticas > sin
  // versión todavía > siguiente transición permitida por el flujo real. Las
  // preguntas locales son un artefacto interno del editor: al cliente nunca
  // se le ofrece ese enlace (el editor lo redirige fuera de todos modos).
  const siguienteAccion =
    user.role !== 'cliente' && preguntasCriticasPendientes > 0
      ? {
          label: `Responder ${preguntasCriticasPendientes} pregunta(s) crítica(s)`,
          href: `/campanas/${campaign.id}/brief/editar?panel=preguntas`,
        }
      : versionActual === undefined
        ? { label: 'Cargar fuentes o iniciar el brief', href: `/campanas/${campaign.id}/fuentes` }
        : proximaTransicion !== undefined
          ? { label: TEXTO_DEL_BOTON[proximaTransicion]!, href: `/campanas/${campaign.id}/brief` }
          : undefined;

  return (
    <div className="content">
      <div className="campaign-header">
        <span className={`monogram lg ${monogramaColor(campaign.id)}`}>{monogramaIniciales(campaign.name)}</span>
        <div style={{ flex: 1 }}>
          <div className="row" style={{ gap: 8 }}>
            <span className={`pill ${campaign.status === 'activa' ? 'ok' : 'neutro'}`}>{campaign.status}</span>
            {campaign.category !== null && <span className="pill neutro">{campaign.category}</span>}
          </div>
          <h1 style={{ margin: '8px 0 4px' }}>{campaign.name}</h1>
          <p className="sub" style={{ margin: 0 }}>
            {campaign.market} · responsable {campaign.owner_name}
          </p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <a className="btn" href={`/campanas/${campaign.id}/fuentes`}>
            Fuentes
          </a>
          <a className="btn pri" href={`/campanas/${campaign.id}/brief`}>
            Abrir brief
          </a>
        </div>
      </div>

      <div className="stepper">
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
          <strong>Acción no permitida</strong>
          Tu rol no puede ejecutar esa acción sobre esta campaña.
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
          <strong>Revisar el reparto de presupuesto</strong>
          {avisoPresupuesto} Puede ser deliberado; se registra tal como se declaró.
        </div>
      )}

      <div className="grid-2">
        <div>
          <div className="card">
            <h2>Brief</h2>
            {versionActual === undefined ? (
              <>
                <p className="sub" style={{ marginTop: 0 }}>
                  Todavía no hay ninguna versión. Cargue fuentes y extraiga, o empiece el brief a mano — la
                  asistencia de IA nunca es requisito para avanzar.
                </p>
                <div className="row" style={{ gap: 8 }}>
                  <a className="btn" href={`/campanas/${campaign.id}/fuentes`}>
                    Ir a fuentes →
                  </a>
                  {user.role !== 'cliente' && (
                    <form action={crearBriefManualDeCampana}>
                      <input type="hidden" name="campaignId" value={campaign.id} />
                      <button className="btn pri" type="submit">
                        Empezar el brief a mano
                      </button>
                    </form>
                  )}
                </div>
              </>
            ) : (
              <div className="row" style={{ gap: 20, alignItems: 'center' }}>
                <div className="ring" style={{ background: `conic-gradient(var(--brand) 0 ${progresoBrief}%, var(--chip) ${progresoBrief}% 100%)` }}>
                  <div>
                    <strong>{progresoBrief}%</strong>
                    <span>campos con dato</span>
                  </div>
                </div>
                <p className="sub" style={{ margin: 0 }}>
                  Versión {versionActual.version} · estado{' '}
                  <span className="pill">
                    {ESTADO_EN_ESPANOL[versionActual.status as BriefStatus] ?? versionActual.status}
                  </span>
                  <br />
                  {listaCampos.filter((c) => c.status === 'found').length} / {listaCampos.length} campo(s) con
                  dato
                </p>
              </div>
            )}
          </div>

          <div className="card">
            <h2>Productos ({productos.length})</h2>
            <table>
              <thead>
                <tr>
                  <th>Producto</th>
                  <th>Categoría</th>
                  <th>Rol</th>
                  <th>Prioridad</th>
                  <th>% presupuesto</th>
                </tr>
              </thead>
              <tbody>
                {productos.map((p) => (
                  <tr key={p.id}>
                    <td style={{ fontWeight: 600 }}>{p.model}</td>
                    <td>{p.category}</td>
                    <td>
                      <span className={`pill ${p.rol === 'flagship' ? 'curso' : 'neutro'}`}>{p.rol}</span>
                    </td>
                    <td>{p.prioridad}</td>
                    <td>
                      {p.participacion_presupuesto === null
                        ? '—'
                        : `${Math.round(Number(p.participacion_presupuesto) * 100)}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card">
            <h2>Datos</h2>
            <table>
              <tbody>
                <tr>
                  <td style={{ color: 'var(--muted)', width: 180 }}>Identificador</td>
                  <td className="mono">{campaign.id}</td>
                </tr>
                <tr>
                  <td style={{ color: 'var(--muted)' }}>Fechas</td>
                  <td>
                    {campaign.start_date === null
                      ? '—'
                      : `${new Date(campaign.start_date).toLocaleDateString('es-CO')} → ${
                          campaign.end_date === null
                            ? '…'
                            : new Date(campaign.end_date).toLocaleDateString('es-CO')
                        }`}
                  </td>
                </tr>
                <tr>
                  <td style={{ color: 'var(--muted)' }}>Confidencialidad</td>
                  <td>
                    <span className="pill neutro">{campaign.confidentiality_level}</span>{' '}
                    <span className="pill neutro">visibilidad: {campaign.visibility}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <aside className="side-stack">
          {siguienteAccion !== undefined && (
            <div className="card side-card">
              <h3 className="section-title">Siguiente acción</h3>
              <div className="action-list">
                <div className="action-row primary">
                  <div className="action-ico">→</div>
                  <a href={siguienteAccion.href}>
                    <b>{siguienteAccion.label}</b>
                  </a>
                </div>
              </div>
            </div>
          )}

          <div className="card side-card">
            <h3 className="section-title">Fuentes</h3>
            <p className="sub" style={{ margin: '0 0 10px' }}>
              PPT de TCL China, fichas técnicas y briefs del cliente: el material del que sale el brief.
            </p>
            <a className="btn" href={`/campanas/${campaign.id}/fuentes`} style={{ width: '100%' }}>
              Ver y cargar fuentes
            </a>
          </div>

          {campaign.status === 'activa' && (
            <div className="card side-card">
              <h3 className="section-title">Archivar</h3>
              <p className="sub" style={{ margin: '0 0 10px' }}>
                No borra nada — solo la saca del listado activo.
              </p>
              <form action={archivarCampana}>
                <input type="hidden" name="id" value={campaign.id} />
                <ConfirmarAccion
                  etiqueta="Archivar campaña"
                  titulo={`¿Archivar "${campaign.name}"?`}
                  consecuencias={[
                    'La campaña deja de aparecer como activa en el listado.',
                    'Las fuentes, el brief y su historial se conservan — no se borra nada.',
                    'Para reactivarla habrá que hacerlo desde el mismo lugar.',
                  ]}
                  textoConfirmar="Sí, archivar"
                  peligro
                  className="btn"
                />
              </form>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
