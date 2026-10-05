/**
 * Lectura del entorno inyectable. El runtime y el cliente de modelo nunca tocan
 * `process.env` directamente: reciben un `EnvReader`, así las pruebas controlan el
 * entorno (kill-switch, URL del worker, límites) sin mutar el proceso.
 */
export type EnvReader = (nombre: string) => string | undefined;

/** Lector por defecto: el entorno real del proceso. */
export const envDelProceso: EnvReader = (nombre) => process.env[nombre];

/** Lector a partir de un objeto (pruebas). */
export function envDesdeObjeto(valores: Readonly<Record<string, string | undefined>>): EnvReader {
  return (nombre) => valores[nombre];
}

/** Entero positivo acotado; cualquier cosa inválida cae al valor por defecto. */
export function enteroDeEnv(
  env: EnvReader,
  nombre: string,
  porDefecto: number,
  { min = 1, max = Number.MAX_SAFE_INTEGER }: { min?: number; max?: number } = {},
): number {
  const crudo = env(nombre)?.trim();
  if (crudo === undefined || crudo === '' || !/^\d+$/.test(crudo)) return porDefecto;
  const n = Number(crudo);
  if (!Number.isSafeInteger(n)) return porDefecto;
  return Math.min(Math.max(n, min), max);
}
