#!/usr/bin/env node
// Verifica que TypeScript y Python lean exactamente el mismo catálogo de
// campos del brief (Sprint 4, cierre — corrección 4).
//
// No compara dos catálogos derivados por separado: ambos lados leen el mismo
// archivo, `docs/product/brief-schema/brief-catalog.json`. Lo que esta
// verificación prueba es que los dos LECTORES —`catalogoDelBrief()` en TS,
// `campos_extraibles()` en Python, que además cruza el catálogo contra el
// JSON Schema real— llegan al mismo resultado: mismas 41 claves, sin
// faltantes ni sobrantes, criticidad y nivel idénticos.
//
// Uso:  node --experimental-strip-types scripts/verificar-catalogo.mjs

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = dirname(dirname(fileURLToPath(import.meta.url)));

async function catalogoTypeScript() {
  const { catalogoDelBrief } = await import(join(RAIZ, 'packages/domain/src/brief-catalog.ts'));
  return catalogoDelBrief().map((c) => ({ key: c.key, criticidad: c.criticidad, nivel: c.nivel }));
}

function catalogoPython() {
  const venvPython = join(RAIZ, 'services/ai-worker/.venv/bin/python3');
  const python = existsSync(venvPython) ? venvPython : 'python3';

  const resultado = spawnSync(python, ['-m', 'app.brief_schema', '--volcar-catalogo'], {
    cwd: join(RAIZ, 'services/ai-worker'),
    env: { ...process.env, PYTHONPATH: '.' },
    encoding: 'utf8',
  });

  if (resultado.status !== 0) {
    throw new Error(
      `python -m app.brief_schema --volcar-catalogo falló (código ${resultado.status}):\n${resultado.stderr}`,
    );
  }
  return JSON.parse(resultado.stdout);
}

function comparar(ts, py) {
  const porClaveTs = new Map(ts.map((c) => [c.key, c]));
  const porClavePy = new Map(py.map((c) => [c.key, c]));

  const soloEnTs = [...porClaveTs.keys()].filter((k) => !porClavePy.has(k));
  const soloEnPy = [...porClavePy.keys()].filter((k) => !porClaveTs.has(k));

  const divergentes = [];
  for (const [key, campoTs] of porClaveTs) {
    const campoPy = porClavePy.get(key);
    if (!campoPy) continue;
    if (campoTs.criticidad !== campoPy.criticidad || campoTs.nivel !== campoPy.nivel) {
      divergentes.push({ key, ts: campoTs, py: campoPy });
    }
  }

  return { soloEnTs, soloEnPy, divergentes };
}

async function main() {
  const ts = await catalogoTypeScript();
  const py = catalogoPython();

  console.log(`TypeScript: ${ts.length} campos. Python: ${py.length} campos.`);

  const { soloEnTs, soloEnPy, divergentes } = comparar(ts, py);
  let falla = false;

  if (ts.length !== 41 || py.length !== 41) {
    falla = true;
    console.error(`Se esperaban 41 campos (DEC-021) en cada lado.`);
  }
  if (soloEnTs.length > 0) {
    falla = true;
    console.error(`Claves solo en TypeScript: ${soloEnTs.join(', ')}`);
  }
  if (soloEnPy.length > 0) {
    falla = true;
    console.error(`Claves solo en Python: ${soloEnPy.join(', ')}`);
  }
  if (divergentes.length > 0) {
    falla = true;
    console.error('Criticidad o nivel no coinciden:');
    for (const d of divergentes) {
      console.error(`  ${d.key}: TS=${JSON.stringify(d.ts)} vs Python=${JSON.stringify(d.py)}`);
    }
  }

  if (falla) {
    console.error('\nEl catálogo de TypeScript y el de Python no coinciden.');
    process.exit(1);
  }

  console.log('El catálogo coincide: mismas 41 claves, misma criticidad, mismo nivel.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
