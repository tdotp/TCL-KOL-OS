/**
 * @tcl-kol-os/agent
 *
 * Agente de Cuenta (V2 · Fase 6). Orquesta casos de uso existentes de
 * `@tcl-kol-os/db`; las reglas de negocio viven en `@tcl-kol-os/domain`/db (ADR-008).
 */
export * from './contracts.ts';
export * from './model/index.ts';
export * from './prompts/index.ts';
export * from './runtime/index.ts';
export * from './tools/index.ts';
