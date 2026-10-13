import { describe, expect, it } from 'vitest';
import { ETAPAS, etapaDeStatus } from './brief-ui.ts';

describe('stepper del brief', () => {
  it('la etapa de revisión es interna (el cliente no revisa, DEC-042)', () => {
    expect(ETAPAS.map((e) => e.id)).toEqual(['fuentes', 'brief', 'revision_interna', 'aprobado']);
    expect(ETAPAS.find((e) => e.id === 'revision_interna')?.nombre).toBe('Revisión interna');
  });

  it.each([
    'internal_review',
    'internal_changes_requested',
    'client_review',
    'client_changes_requested',
  ] as const)('%s cae en la revisión interna', (estado) => {
    expect(etapaDeStatus(estado)).toBe('revision_interna');
  });

  it('el resto de estados conserva su etapa', () => {
    expect(etapaDeStatus(undefined)).toBe('fuentes');
    expect(etapaDeStatus('draft')).toBe('brief');
    expect(etapaDeStatus('extraction_review')).toBe('brief');
    expect(etapaDeStatus('approved')).toBe('aprobado');
    expect(etapaDeStatus('superseded')).toBe('aprobado');
  });
});
