import type { BriefWorkspace, WorkspaceSectionField } from '@tcl-kol-os/domain';
import { requiresEvidence } from '@tcl-kol-os/domain';

function valorLegible(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value))
    return value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(', ');
  if (typeof value === 'object' && 'textoOriginal' in (value as Record<string, unknown>)) {
    return String((value as Record<string, unknown>)['textoOriginal']);
  }
  return JSON.stringify(value);
}

function localizador(e: {
  page?: number | undefined;
  slide?: number | undefined;
  section?: string | undefined;
  linea?: number | undefined;
}): string {
  if (e.slide !== undefined) return `diapositiva ${e.slide}`;
  if (e.section !== undefined && e.section !== '')
    return e.linea !== undefined ? `${e.section} · línea ${e.linea}` : e.section;
  if (e.page !== undefined) return `página ${e.page}`;
  return 'sin ubicación';
}

/**
 * Selecciona qué fila mostrar para un campo `key` dado el producto activo —
 * mismo criterio que `EditorBrief.tsx` usa para editar (Sprint 5), aquí
 * solo para decidir qué renderizar en modo lectura. Presentación, no una
 * regla de dominio: nunca decide qué se puede guardar, solo qué se ve.
 */
function filaVisible(
  fields: readonly WorkspaceSectionField[],
  key: string,
  productoActivoId: string | undefined,
) {
  const filas = fields.filter((f) => f.key === key);
  if (filas.length === 1) return filas[0];
  // compartido_con_excepcion: si el producto activo tiene su propia
  // excepción, esa manda; si no, la compartida (campaignProductId undefined).
  const propia = filas.find((f) => f.campaignProductId === productoActivoId);
  return propia ?? filas.find((f) => f.campaignProductId === undefined) ?? filas[0];
}

function Badges({ campo }: { campo: WorkspaceSectionField }) {
  const badges: { texto: string; clase: string }[] = [];
  if (campo.status === 'conflict') badges.push({ texto: 'conflicto', clase: 'bad' });
  else if (campo.status === 'not_found') badges.push({ texto: 'pendiente', clase: 'neutro' });
  else {
    if (campo.reviewStatus === 'confirmed') badges.push({ texto: 'confirmado', clase: 'ok' });
    else if (campo.reviewStatus === 'pending') badges.push({ texto: 'sin confirmar', clase: 'warn' });
    if (campo.provenanceType === 'manual_local') badges.push({ texto: 'manual', clase: 'curso' });
    else if (campo.provenanceType === 'extracted') badges.push({ texto: 'extraído', clase: 'neutro' });
    if (campo.hasEvidence) badges.push({ texto: 'con evidencia', clase: 'ok' });
    else if (requiresEvidence(campo)) badges.push({ texto: 'necesita evidencia', clase: 'warn' });
  }
  return (
    <div className="row" style={{ gap: 4 }}>
      {badges.map((b) => (
        <span key={b.texto} className={`pill ${b.clase}`}>
          {b.texto}
        </span>
      ))}
    </div>
  );
}

/**
 * Sprint 6, Checkpoint 2 §3.3 — el brief como documento legible, no como
 * tabla de base de datos. Server component: navegar por sección y producto
 * es por ancla/URL, sin JavaScript; la evidencia se abre bajo demanda con
 * `<details>` nativo.
 */
export function RevisarBrief({
  campaignId,
  workspace,
  productoActivoId,
}: {
  campaignId: string;
  workspace: BriefWorkspace;
  productoActivoId: string | undefined;
}) {
  const version = workspace.version!;
  const multiproducto = workspace.products.length > 1;
  const activo = productoActivoId ?? workspace.products[0]?.id;

  return (
    <div>
      {!version.editable && (
        <div className="aviso">
          <strong>Solo lectura</strong>
          Esta versión está en estado <span className="mono">{version.status}</span> y no admite edición.
        </div>
      )}

      {multiproducto && (
        <nav className="revisar-producto-tabs" aria-label="Producto">
          {workspace.products.map((p) => (
            <a
              key={p.id}
              href={`/campanas/${campaignId}/brief/workspace?modo=revisar&producto=${p.id}`}
              className={`pill ${activo === p.id ? 'curso' : 'neutro'}`}
            >
              {p.model}
            </a>
          ))}
        </nav>
      )}

      {workspace.sections.length === 0 ? (
        <div className="card">
          <p className="vacio">Todavía no hay campos extraídos ni cargados en esta versión.</p>
        </div>
      ) : (
        workspace.sections.map((seccion) => {
          // Una sola fila por clave (evita repetir lo compartido una vez por producto).
          const clavesUnicas = [...new Set(seccion.fields.map((f) => f.key))];
          const filas = clavesUnicas
            .map((key) => filaVisible(seccion.fields, key, activo))
            .filter((f): f is WorkspaceSectionField => f !== undefined);

          return (
            <div className="card" key={seccion.id} id={`seccion-${seccion.id}`}>
              <h2 style={{ marginTop: 0 }}>
                {seccion.titulo}{' '}
                <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>
                  ({seccion.completos}/{seccion.total})
                </span>
              </h2>
              {filas.map((campo) => {
                const texto = valorLegible(campo.value);
                return (
                  <div className="revisar-campo" key={campo.key} id={`campo-${campo.key}`}>
                    <div className="revisar-campo-head">
                      <strong style={{ fontSize: 13.5 }}>{campo.label}</strong>
                      <Badges campo={campo} />
                    </div>
                    <p className={`revisar-campo-valor${texto === '' ? ' vacio' : ''}`}>
                      {texto === '' ? 'Pendiente — sin dato todavía.' : texto}
                    </p>
                    {campo.evidence.length > 0 && (
                      <details>
                        <summary>ver evidencia ({campo.evidence.length})</summary>
                        {campo.evidence.map((e, i) => (
                          <blockquote key={i}>
                            {e.quote}
                            <br />
                            <span className="muted">
                              — {e.filename}, {localizador(e)}
                            </span>
                          </blockquote>
                        ))}
                      </details>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })
      )}
    </div>
  );
}
