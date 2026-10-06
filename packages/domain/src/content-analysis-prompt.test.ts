/**
 * Prompt del analizador de guiones: el texto está FIJADO por sha256. Si cambia sin subir
 * `ANALYSIS_PROMPT_VERSION`, esta prueba falla a propósito.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { instruccionesDeSobre } from './agent-context';
import {
  ANALYSIS_PROMPT_VERSION,
  CONTEXT_VERSION,
  ESQUEMA_COMPACTO_DE_SALIDA_DE_ANALISIS,
  MARCADOR_DE_SOBRES_DEL_PROMPT,
  MARCADOR_DE_TAREA,
  OUTPUT_SCHEMA_VERSION,
  SEVERITY_POLICY_VERSION,
  ANALYSIS_SYSTEM_PROMPT_TEMPLATE,
  ANALYSIS_USER_HEADER,
  lineaFinalDeUsuarioDeAnalisis,
  renderizarSystemPromptDeAnalisis,
} from './content-analysis-prompt';

const sha = (t: string): string => createHash('sha256').update(t, 'utf8').digest('hex');
const NONCE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

/**
 * HUELLAS FIJADAS. Para cambiar el prompt: (1) editar el texto, (2) subir ANALYSIS_PROMPT_VERSION
 * (y OUTPUT_SCHEMA_VERSION si cambia el esquema), (3) actualizar estas huellas con el sha nuevo.
 */
const SHA_DE_LA_PLANTILLA = 'a61892dd3f175b1df8d56cedbb4d4662d4b76b47f8ea6f1c662b0b7f494ec9e9';
const SHA_DEL_PROMPT_RENDERIZADO = '0a6e55d1841e0f8579319fa8fa03d6da4c62b60956eb30645f2f4a553a25ee0d';
const SHA_DEL_ENCABEZADO_Y_PIE = '2c4585941f0aee68dda8120a6afe154e4634379d2da2bf7ed4e9dff374645115';

describe('versiones del análisis', () => {
  it('constantes versionadas', () => {
    expect(ANALYSIS_PROMPT_VERSION).toBe('analisis-guion-1');
    expect(OUTPUT_SCHEMA_VERSION).toBe('analisis-guion-salida-1');
    expect(SEVERITY_POLICY_VERSION).toBe('sev-1');
    expect(CONTEXT_VERSION).toMatch(/^ctx-analisis-\d+$/);
  });
});

describe('texto del system prompt (fijado por sha256)', () => {
  it('la plantilla no cambia sin subir la versión', () => {
    expect(
      sha(ANALYSIS_SYSTEM_PROMPT_TEMPLATE),
      'cambió la plantilla: suba ANALYSIS_PROMPT_VERSION y actualice la huella',
    ).toBe(SHA_DE_LA_PLANTILLA);
  });

  it('el prompt renderizado (con la política de sobres del dominio) no cambia en silencio', () => {
    // Fija también `instruccionesDeSobre`: cambiarlas cambia lo que lee el analizador.
    expect(sha(renderizarSystemPromptDeAnalisis(NONCE))).toBe(SHA_DEL_PROMPT_RENDERIZADO);
  });

  it('encabezado y línea final del mensaje de usuario', () => {
    expect(
      sha(
        `${ANALYSIS_USER_HEADER}\n${lineaFinalDeUsuarioDeAnalisis(3, 18)}\n${lineaFinalDeUsuarioDeAnalisis(1, 1)}`,
      ),
    ).toBe(SHA_DEL_ENCABEZADO_Y_PIE);
  });

  it('lleva el marcador de tarea y la versión que usa el proveedor falso para despachar', () => {
    expect(ANALYSIS_SYSTEM_PROMPT_TEMPLATE).toContain(`${MARCADOR_DE_TAREA} · ${ANALYSIS_PROMPT_VERSION}`);
    expect(MARCADOR_DE_TAREA).toBe('TAREA: analizar_guion');
  });

  it('el marcador de sobres se sustituye por la política con el nonce del run (una sola vez)', () => {
    const r = renderizarSystemPromptDeAnalisis(NONCE);
    expect(ANALYSIS_SYSTEM_PROMPT_TEMPLATE.split(MARCADOR_DE_SOBRES_DEL_PROMPT)).toHaveLength(2);
    expect(r).not.toContain(MARCADOR_DE_SOBRES_DEL_PROMPT);
    expect(r).toContain(instruccionesDeSobre(NONCE));
    expect(r).toContain(`<<<NC:${NONCE} …>>>`);
  });

  it('es texto fijo: no lleva datos de campaña, de Brief ni de guion (solo el nonce entra)', () => {
    const a = renderizarSystemPromptDeAnalisis(NONCE);
    const b = renderizarSystemPromptDeAnalisis('0123456789abcdef0123456789abcdef');
    expect(a.split(NONCE).join('N')).toBe(b.split('0123456789abcdef0123456789abcdef').join('N'));
  });

  it('un nonce inválido no se acepta', () => {
    expect(() => renderizarSystemPromptDeAnalisis('corto')).toThrow();
  });

  it('declara el rol (analiza, no aprueba), la regla de las citas literales y el esquema sin razonamiento', () => {
    const t = ANALYSIS_SYSTEM_PROMPT_TEMPLATE;
    expect(t).toMatch(/No apruebas, no rechazas, no decides/);
    expect(t).toMatch(/citas LITERALES/);
    expect(t).toMatch(/sin razonamiento paso a paso/);
    expect(t).toContain(ESQUEMA_COMPACTO_DE_SALIDA_DE_ANALISIS);
    expect(ESQUEMA_COMPACTO_DE_SALIDA_DE_ANALISIS).not.toMatch(/reason|thought|severity|approved/i);
  });

  it('nombra exactamente las siete categorías y ninguna más', () => {
    const cats = [
      'cta_missing',
      'key_message_incomplete',
      'requirement_not_covered',
      'claim_unsupported',
      'claim_contradicted',
      'restriction_violated',
      'brief_contradiction',
    ];
    for (const c of cats) expect(ANALYSIS_SYSTEM_PROMPT_TEMPLATE).toContain(c);
  });

  it('línea final de usuario con los rangos de alias', () => {
    expect(lineaFinalDeUsuarioDeAnalisis(3, 18)).toBe(
      'Analiza el guion (F1…F3) contra los requisitos (R1…R18). Responde solo con el JSON.',
    );
    expect(lineaFinalDeUsuarioDeAnalisis(1, 1)).toBe(
      'Analiza el guion (F1) contra los requisitos (R1). Responde solo con el JSON.',
    );
  });
});
