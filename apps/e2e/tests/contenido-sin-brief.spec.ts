import { expect, test } from '@playwright/test';
import {
  TEXTO_SEMBRADO,
  contarAuditoriaDeCampana,
  escenarioDeContenido,
  estadoDeVersion,
  limpiarContenido,
  registrarFuenteComoVersion,
  registrarGuionSembrado,
  revisionesDe,
  rutaDeContenido,
} from '../src/contenido';
import { login } from '../src/login';
import { gotoConReintento } from '../src/nav';

/**
 * E2E-20 — lo que falta para poder analizar: sin Brief aprobado no hay documento rector (aviso explícito,
 * análisis y revisión humana deshabilitados, nada se puede aprobar); con la fuente del guion todavía en
 * proceso (o fallida) el estado es explícito y el análisis está deshabilitado. En ningún caso se crea una
 * revisión ni se aprueba nada.
 */
test.describe.configure({ mode: 'serial' });
test.afterAll(async () => {
  await limpiarContenido();
});

test('E2E-20a — campaña sin Brief aprobado: aviso, análisis y revisión humana deshabilitados, nada aprobable', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const s = await escenarioDeContenido('e2e-20a-sin-brief', { conBrief: false });
  const { e, campaignId } = s;
  const { participacionId, deliverableId } = s.valentina;
  // El guion se puede subir y queda registrado (procesado), pero no hay contra qué revisarlo.
  const v1 = await registrarGuionSembrado(s, deliverableId, participacionId, TEXTO_SEMBRADO);

  await login(page, e.consultor.email);
  await gotoConReintento(page, rutaDeContenido(campaignId));
  const aviso = page.getByTestId('contenido-sin-brief');
  await expect(aviso).toBeVisible();
  await expect(aviso).toContainText('Todavía no existe un Brief aprobado');
  await expect(page.getByTestId('contenido-brief-rector')).toHaveCount(0);

  await gotoConReintento(page, rutaDeContenido(campaignId, participacionId, deliverableId));
  await expect(page.getByTestId('contenido-revision')).toHaveAttribute('data-vigencia', 'none');
  await expect(page.getByTestId('contenido-revision-ninguna')).toContainText(
    'Todavía no existe un Brief aprobado',
  );
  await expect(page.getByTestId('contenido-solicitar-analisis')).toBeDisabled();
  await expect(page.getByTestId('contenido-analisis-motivo')).toContainText('Brief aprobado');
  await expect(page.getByTestId('contenido-revision-humana-abrir')).toBeDisabled();
  await expect(page.getByTestId('contenido-sin-brief-revision')).toBeVisible();
  // Subir y comentar siguen disponibles; aprobar no.
  await expect(page.getByTestId('contenido-subir-form')).toBeVisible();
  await expect(page.getByTestId('contenido-aprobar')).toHaveCount(0);

  // El director tampoco puede aprobar: hay bloqueos explícitos y ningún botón.
  await login(page, e.director.email);
  await gotoConReintento(page, rutaDeContenido(campaignId, participacionId, deliverableId));
  await expect(page.getByTestId('contenido-aprobacion')).toHaveAttribute('data-elegible', 'false');
  await expect(page.getByTestId('contenido-aprobacion-bloqueos')).toContainText('Brief aprobado');
  await expect(page.getByTestId('contenido-aprobar')).toHaveCount(0);

  // Base: ni revisión, ni análisis, ni aprobación; la versión sigue recibida.
  expect(await revisionesDe(v1.versionId)).toHaveLength(0);
  expect(await estadoDeVersion(v1.versionId)).toBe('received');
  expect(await contarAuditoriaDeCampana(campaignId, 'script_version.approve')).toBe(0);
});

test('E2E-20b — fuente del guion en proceso o fallida: estado explícito y análisis deshabilitado', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const s = await escenarioDeContenido('e2e-20b-fuente-en-proceso');
  const { e, campaignId } = s;

  // En cola (Diego) y fallida (Valentina · Story): versiones registradas, sin texto que analizar.
  const vCola = await registrarFuenteComoVersion(
    s,
    s.diego.deliverableId,
    s.diego.participacionId,
    e.fuentes.enCola,
  );
  const vFallida = await registrarFuenteComoVersion(
    s,
    e.entregables.storyRios,
    s.valentina.participacionId,
    e.fuentes.fallida,
  );

  await login(page, e.consultor.email);
  await gotoConReintento(page, rutaDeContenido(campaignId));
  await expect(page.getByTestId('contenido-sin-brief')).toHaveCount(0);
  await expect(page.getByTestId('contenido-brief-rector')).toContainText(`Brief V${s.brief!.version}`);

  await gotoConReintento(page, rutaDeContenido(campaignId, s.diego.participacionId, s.diego.deliverableId));
  await expect(page.getByTestId('contenido-archivo-estado')).not.toHaveAttribute('data-estado', 'listo');
  await expect(page.getByTestId('contenido-archivo-procesando')).toBeVisible();
  await expect(page.getByTestId('contenido-solicitar-analisis')).toBeDisabled();
  await expect(page.getByTestId('contenido-analisis-motivo')).toContainText('cola de procesamiento');
  // La revisión humana (decisión de una persona) sí sigue disponible: no depende de la IA ni del texto.
  await expect(page.getByTestId('contenido-revision-humana-abrir')).toBeEnabled();

  await gotoConReintento(
    page,
    rutaDeContenido(campaignId, s.valentina.participacionId, e.entregables.storyRios),
  );
  await expect(page.getByTestId('contenido-solicitar-analisis')).toBeDisabled();
  await expect(page.getByTestId('contenido-analisis-motivo')).toContainText('Falló el procesamiento');

  for (const v of [vCola, vFallida]) {
    expect(await revisionesDe(v)).toHaveLength(0);
    expect(await estadoDeVersion(v)).toBe('received');
  }
});
