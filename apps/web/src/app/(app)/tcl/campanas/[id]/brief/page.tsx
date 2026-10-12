import { obtenerBriefParaTcl } from '@tcl-kol-os/db';
import { TITULO_SECCION } from '@tcl-kol-os/domain';
import { cargarCampanaTcl, valorOr404 } from '@/lib/tcl-server';
import { agruparPorBloque, formatearFecha, nombreDeProducto } from '@/lib/tcl-ui';
import { CabeceraTcl, VacioTcl } from '../../../CabeceraTcl';

export const dynamic = 'force-dynamic';

const NOMBRE_DE_IDIOMA = { es: 'Español', en: 'English' } as const;

/** Brief aprobado vigente, por lista blanca de campos (ES y, si hay representación vigente, EN). */
export default async function TclBriefPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, campana } = await cargarCampanaTcl(id);
  const brief = valorOr404(await obtenerBriefParaTcl(user, campana.id));
  const representaciones = brief?.representaciones.filter((r) => r.campos.length > 0) ?? [];

  return (
    <div className="content content-wide ui-enter" data-testid="tcl-brief">
      <CabeceraTcl
        campana={campana}
        activa="brief"
        titulo="Brief"
        {...(brief === null
          ? {}
          : { descripcion: `Versión ${brief.version} aprobada el ${formatearFecha(brief.aprobadoEl)}.` })}
      />
      {brief === null || representaciones.length === 0 ? (
        <VacioTcl
          titulo="Brief pendiente de aprobación"
          texto="Cuando SmartPR apruebe el brief de la campaña lo verás aquí."
        />
      ) : (
        representaciones.map((r) => (
          <section key={r.idioma} className="card" aria-labelledby={`brief-${r.idioma}`} lang={r.idioma}>
            <h2 id={`brief-${r.idioma}`}>{NOMBRE_DE_IDIOMA[r.idioma]}</h2>
            {agruparPorBloque(r.campos).map((g) => (
              <div key={g.bloque}>
                <h3>{(TITULO_SECCION as Readonly<Record<string, string>>)[g.bloque] ?? g.bloque}</h3>
                <dl>
                  {g.campos.map((c, i) => (
                    <div key={`${c.clave}-${i}`} data-testid="campo-brief">
                      <dt>
                        {c.etiqueta}
                        {c.producto === null ? '' : ` — ${nombreDeProducto(c.producto) ?? 'Producto'}`}
                      </dt>
                      <dd>
                        {c.texto !== null ? (
                          c.texto
                        ) : (
                          <ul>
                            {(c.items ?? []).map((it, j) => (
                              <li key={j}>{it}</li>
                            ))}
                          </ul>
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </section>
        ))
      )}
    </div>
  );
}
