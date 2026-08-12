import { notFound, redirect } from 'next/navigation';
import { getFragments, listSources } from '@tcl-kol-os/db';
import { Encabezado } from '@/components/Encabezado';
import { currentUser } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * Fragmentos extraídos de una fuente.
 *
 * Antesala de UI-11 (evidencias): aquí se comprueba que cada fragmento conserva
 * su ubicación exacta. Sin esa localización no se puede citar una evidencia
 * verificable (§9.4), y sin evidencia el umbral de §15 es inalcanzable.
 */
export default async function FragmentosPage({
  params,
}: {
  params: Promise<{ id: string; sourceId: string }>;
}) {
  const user = await currentUser();
  if (user === undefined) redirect('/login');

  const { id, sourceId } = await params;

  const fuentes = await listSources(user, id);
  if (!fuentes.ok) notFound();

  const fuente = fuentes.value.find((f) => f.id === sourceId);
  if (fuente === undefined) notFound();

  const fragmentos = await getFragments(user, sourceId);
  if (!fragmentos.ok) notFound();

  const ubicaciones = new Set(fragmentos.value.map((f) => (f.slide !== null ? `d${f.slide}` : `p${f.page}`)));

  return (
    <>
      <Encabezado user={user} />
      <main>
        <p className="sub" style={{ marginBottom: 4 }}>
          <a href={`/campanas/${id}/fuentes`}>← Fuentes</a>
        </p>
        <h1>{fuente.filename}</h1>
        <p className="sub">
          {fragmentos.value.length} fragmento(s) · {ubicaciones.size} ubicación(es) distinta(s)
        </p>

        <div className="card">
          <h2>Fragmentos extraídos</h2>
          <table>
            <thead>
              <tr>
                <th style={{ width: 110 }}>Ubicación</th>
                <th style={{ width: 150 }}>Sección</th>
                <th>Texto</th>
              </tr>
            </thead>
            <tbody>
              {fragmentos.value.map((f) => (
                <tr key={f.id}>
                  <td>
                    <span className="pill info">
                      {f.slide !== null ? `diapositiva ${f.slide}` : `página ${f.page}`}
                    </span>
                    {f.metadata['origen'] === 'notas' && (
                      <div style={{ marginTop: 4 }}>
                        <span className="pill">notas</span>
                      </div>
                    )}
                    {f.metadata['origen'] === 'tabla' && (
                      <div style={{ marginTop: 4 }}>
                        <span className="pill">tabla</span>
                      </div>
                    )}
                  </td>
                  <td style={{ color: 'var(--muted)', fontSize: 13 }}>{f.section ?? '—'}</td>
                  <td style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>
                    {f.text.length > 400 ? `${f.text.slice(0, 400)}…` : f.text}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </>
  );
}
