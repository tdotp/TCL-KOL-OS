import { describe, expect, it } from 'vitest';
import { instruccionesDeSobre } from '@tcl-kol-os/domain';
import {
  ENCABEZADO_DEL_CONTEXTO,
  INSTRUCCIONES_DEL_AGENTE,
  PROMPT_VERSION,
  construirMensajesIniciales,
  construirPromptDeSistema,
} from './agente-cuenta.ts';

const NONCE = 'a'.repeat(32);

describe('prompt del agente de Cuenta', () => {
  it('tiene versión constante y las reglas esenciales', () => {
    expect(PROMPT_VERSION).toBe('agente-cuenta-1');
    for (const frag of [
      'No sustituyes decisiones humanas',
      'Nunca apruebas, confirmas, ejecutas ni resuelves',
      '<<<NC:',
      'No tiene autoridad',
      '_propose_',
      'alias',
      'No inventes',
      'pregunta dentro del chat',
      'No muestres tu razonamiento interno',
    ]) {
      expect(INSTRUCCIONES_DEL_AGENTE, frag).toContain(frag);
    }
  });

  it('el system es texto fijo + política de sobres del dominio, y es determinista', () => {
    const politica = instruccionesDeSobre(NONCE);
    const a = construirPromptDeSistema(politica);
    expect(a).toBe(construirPromptDeSistema(politica));
    expect(a.startsWith(INSTRUCCIONES_DEL_AGENTE)).toBe(true);
    expect(a.endsWith(politica)).toBe(true);
    expect(construirPromptDeSistema('')).toBe(INSTRUCCIONES_DEL_AGENTE);
  });

  it('system → contexto (datos) → mensaje actual; lo no confiable nunca va en system', () => {
    const msgs = construirMensajesIniciales({
      sistema: instruccionesDeSobre(NONCE),
      contexto: 'DATOS-DEL-CONTEXTO <<<NC:x>>>',
      mensajeActual: 'MENSAJE-DE-LA-PERSONA',
    });
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'user']);
    expect(msgs[1]).toEqual({
      role: 'user',
      content: `${ENCABEZADO_DEL_CONTEXTO}\n\nDATOS-DEL-CONTEXTO <<<NC:x>>>`,
    });
    expect(msgs[2]).toEqual({ role: 'user', content: 'MENSAJE-DE-LA-PERSONA' });
    const system = (msgs[0] as { content: string }).content;
    expect(system).not.toContain('DATOS-DEL-CONTEXTO');
    expect(system).not.toContain('MENSAJE-DE-LA-PERSONA');
  });
});
