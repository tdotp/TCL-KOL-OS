export interface Cabecera {
  key: string;
  value: string;
}
export const CABECERAS_ESTATICAS: Cabecera[];
export const HSTS_MAX_AGE_POR_DEFECTO: number;
export const HASH_ESTILO_404_DE_NEXT: string;
export function generarNonce(): string;
export function construirCsp(o: { nonce: string; produccion: boolean; https: boolean }): string;
export function leerConfiguracionHsts(env: Record<string, string | undefined>): {
  habilitado: boolean;
  valor: string | null;
};
export function esBucleLocal(hostname: string): boolean;
export function hostnameDeCabeceraHost(host: string): string;
export function sirveSobreHttps(o: { protocolo: string; forwardedProto: string | null }): boolean;
export function cabecerasDeDocumento(o: {
  nonce: string;
  produccion: boolean;
  protocolo: string;
  forwardedProto: string | null;
  hostnames: string[];
  env: Record<string, string | undefined>;
}): Cabecera[];
