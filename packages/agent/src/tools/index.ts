/** Barrel del registro de tools (el principal reexporta lo que necesite desde `src/index.ts`). */
export { createToolRegistry, huellaDelCatalogo } from './registry.ts';
export type { FichaDeTool, OpcionesDelRegistro, ToolRegistryConFichas } from './registry.ts';
export { CATALOGO_V1 } from './catalog/index.ts';
export { CLASIFICACIONES, MANIFIESTO_DE_DB, clasificacionDe } from './manifest.ts';
export type { ClasificacionDeExport } from './manifest.ts';
export type { AnyToolDefinition, ToolDefinition } from './types.ts';
export { MAX_EFECTOS_POR_RUN, MAX_LECTURAS_POR_RUN } from './executor.ts';
