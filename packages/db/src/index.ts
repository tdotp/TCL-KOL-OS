/**
 * @tcl-kol-os/db
 *
 * Acceso a datos. Aplica las políticas de `@tcl-kol-os/domain`; nunca las
 * redefine (ADR-008).
 */

export * from './client.ts';
export * from './audit.ts';
export * from './campaigns.ts';
export * from './users.ts';
export * from './storage.ts';
export * from './sources.ts';
export * from './search.ts';
export * from './extraction.ts';
export * from './brief-version.ts';
export * from './transitions.ts';
export * from './manual.ts';
export * from './brief-fields.ts';
export * from './local-questions.ts';
export * from './comments.ts';
export * from './client-review.ts';
export * from './versioning.ts';
export * from './proposed-actions.ts';
export * from './brief-representations.ts';
export * from './brief-workspace.ts';
export * from './influencers.ts';
export * from './campaign-influencers.ts';
export { migrate } from './migrate.ts';
