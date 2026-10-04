/**
 * @tcl-kol-os/domain
 *
 * Tipos, estados, permisos y reglas de negocio de TCL KOL OS.
 *
 * ADR-008: este paquete NO importa nada de `apps/` ni de `services/`.
 * La dependencia es unidireccional. Las transiciones de estado y las reglas de
 * permiso tienen una sola implementación, y vive aquí.
 */

export * from './types';
export * from './errors';
export * from './brief-states';
export * from './brief-catalog';
export * from './permissions';
export * from './file-validation';
export * from './ai-tasks';
export * from './field-values';
export * from './brief-presentation';
export * from './workspace';
export * from './proposed-actions';
