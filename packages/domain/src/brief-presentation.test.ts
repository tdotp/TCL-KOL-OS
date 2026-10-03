/**
 * Sprint 6, Checkpoint 2 — funciones puras de presentación del workspace.
 *
 * `mensajeResponsabilidad` cubre estados que `obtenerBriefWorkspace` no
 * siempre puede ejercitar de punta a punta (p. ej. `superseded` nunca es la
 * versión "actual" de una campaña — el hijo que la reemplaza siempre tiene
 * un número mayor, así que `versionesDelBrief(...)[0]` nunca la devuelve
 * como vigente). Probarla aquí, como función pura, es la forma honesta de
 * cubrir esas ramas sin fingir un estado que la integración no alcanza.
 */

import { describe, expect, it } from 'vitest';
import { humanoDeEvento, humanoDeRevisionCampo, mensajeResponsabilidad } from './brief-presentation';

describe('mensajeResponsabilidad', () => {
  it('aprobado: inmutable', () => {
    expect(mensajeResponsabilidad({ status: 'approved', criticalPending: 0, decisionsPending: 0 })).toBe(
      'Esta versión está aprobada y es inmutable.',
    );
  });

  it('cancelado', () => {
    expect(mensajeResponsabilidad({ status: 'cancelled', criticalPending: 0, decisionsPending: 0 })).toBe(
      'Esta versión fue cancelada.',
    );
  });

  it('reemplazado, con el número de la versión siguiente', () => {
    expect(
      mensajeResponsabilidad({
        status: 'superseded',
        criticalPending: 0,
        decisionsPending: 0,
        siguienteVersionNumero: 2,
      }),
    ).toBe('Esta versión fue reemplazada por la versión 2.');
  });

  it('reemplazado, sin el número disponible', () => {
    expect(mensajeResponsabilidad({ status: 'superseded', criticalPending: 0, decisionsPending: 0 })).toBe(
      'Esta versión fue reemplazada por una versión más reciente.',
    );
  });

  it('client_review es un estado heredado: lo cierra Dirección de SmartPR', () => {
    const msg = mensajeResponsabilidad({ status: 'client_review', criticalPending: 0, decisionsPending: 0 });
    expect(msg).toContain('heredada');
    expect(msg).toContain('Dirección de SmartPR');
  });

  it('client_changes_requested es un estado heredado: lo retoma SmartPR', () => {
    const msg = mensajeResponsabilidad({
      status: 'client_changes_requested',
      criticalPending: 0,
      decisionsPending: 0,
    });
    expect(msg).toContain('heredada');
    expect(msg).toContain('SmartPR');
  });

  it('pendiente de Dirección en revisión interna', () => {
    expect(
      mensajeResponsabilidad({ status: 'internal_review', criticalPending: 0, decisionsPending: 0 }),
    ).toBe('Pendiente de aprobación por Dirección.');
  });

  it('cambios internos solicitados', () => {
    expect(
      mensajeResponsabilidad({
        status: 'internal_changes_requested',
        criticalPending: 3,
        decisionsPending: 3,
      }),
    ).toBe('Se solicitaron cambios internos — quedan por resolver antes de reenviar.');
  });

  it('decisiones críticas pendientes en borrador, singular', () => {
    expect(mensajeResponsabilidad({ status: 'draft', criticalPending: 1, decisionsPending: 1 })).toBe(
      'Tienes 1 decisión crítica pendiente.',
    );
  });

  it('decisiones críticas pendientes en borrador, plural', () => {
    expect(mensajeResponsabilidad({ status: 'draft', criticalPending: 3, decisionsPending: 5 })).toBe(
      'Tienes 3 decisiones críticas pendientes.',
    );
  });

  it('sin críticas pero con preguntas por resolver', () => {
    expect(mensajeResponsabilidad({ status: 'draft', criticalPending: 0, decisionsPending: 2 })).toBe(
      'Quedan 2 pregunta(s) por resolver antes de enviar a revisión interna.',
    );
  });

  it('todo al día', () => {
    expect(mensajeResponsabilidad({ status: 'draft', criticalPending: 0, decisionsPending: 0 })).toBe(
      'Sin pendientes — puede enviarse a revisión interna.',
    );
  });
});

describe('humanoDeEvento', () => {
  it('traduce brief.transition con el estado destino y el motivo', () => {
    const evento = humanoDeEvento('brief.transition', { to: 'internal_review', motivo: 'Listo' });
    expect(evento.tipo).toBe('Cambió el estado a «revisión interna»');
    expect(evento.detalle).toBe('Listo');
  });

  it('traduce question.discard con la justificación', () => {
    const evento = humanoDeEvento('question.discard', { justificacion: 'No aplica para esta campaña.' });
    expect(evento.tipo).toBe('Descartó una pregunta local');
    expect(evento.detalle).toBe('No aplica para esta campaña.');
  });

  it('nunca falla ante una acción desconocida — la muestra en vez de ocultar el evento', () => {
    const evento = humanoDeEvento('algo.nuevo', {});
    expect(evento.tipo).toBe('algo · nuevo');
  });
});

describe('humanoDeRevisionCampo', () => {
  it('traduce las seis acciones conocidas', () => {
    expect(humanoDeRevisionCampo('correct')).toBe('Corrigió el valor del campo');
    expect(humanoDeRevisionCampo('confirm')).toBe('Confirmó el campo tal como estaba');
    expect(humanoDeRevisionCampo('declare_exception')).toBe('Declaró una excepción para este producto');
  });

  it('nunca falla ante una acción desconocida', () => {
    expect(humanoDeRevisionCampo('algo_nuevo')).toBe('algo_nuevo');
  });
});
