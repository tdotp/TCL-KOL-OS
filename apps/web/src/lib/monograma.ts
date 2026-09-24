/** Iniciales para el monograma de una campaña o persona — "Rediseño TV" → "RT". */
export function monogramaIniciales(nombre: string): string {
  const partes = nombre.trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return '—';
  if (partes.length === 1) return partes[0]!.slice(0, 2).toUpperCase();
  return `${partes[0]![0]}${partes[1]![0]}`.toUpperCase();
}

const PALETA = ['red', 'wine', 'green', 'blue', 'amber', 'purple'] as const;
export type ColorMonograma = (typeof PALETA)[number];

/**
 * Color determinista a partir de un id real (nunca aleatorio ni por índice
 * de fila, para que el mismo registro tenga siempre el mismo color entre
 * pantallas). Solo variedad visual — no codifica ningún significado.
 */
export function monogramaColor(seed: string): ColorMonograma {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return PALETA[hash % PALETA.length]!;
}
