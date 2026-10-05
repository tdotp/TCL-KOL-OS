/**
 * Servidor HTTP falso local para probar clientes del worker (solo pruebas).
 */
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Manejador = (req: IncomingMessage, res: ServerResponse, cuerpo: string, n: number) => void;

export interface Servidor {
  readonly url: string;
  readonly peticiones: { metodo: string; ruta: string; cuerpo: unknown }[];
  cerrar(): Promise<void>;
}

const abiertos: Servidor[] = [];

export async function servidor(manejador: Manejador): Promise<Servidor> {
  const peticiones: Servidor['peticiones'] = [];
  const http: Server = createServer((req, res) => {
    const partes: Buffer[] = [];
    req.on('data', (c: Buffer) => partes.push(c));
    req.on('end', () => {
      const cuerpo = Buffer.concat(partes).toString('utf8');
      let json: unknown = cuerpo;
      try {
        json = JSON.parse(cuerpo);
      } catch {
        /* se deja el texto */
      }
      peticiones.push({ metodo: req.method ?? '', ruta: req.url ?? '', cuerpo: json });
      manejador(req, res, cuerpo, peticiones.length);
    });
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const { port } = http.address() as AddressInfo;
  const s: Servidor = {
    url: `http://127.0.0.1:${port}`,
    peticiones,
    cerrar: () =>
      new Promise<void>((r) => {
        http.closeAllConnections();
        http.close(() => r());
      }),
  };
  abiertos.push(s);
  return s;
}

/** Cierra los servidores abiertos (úselo en `afterEach`). */
export async function cerrarServidores(): Promise<void> {
  await Promise.all(abiertos.splice(0).map((s) => s.cerrar()));
}

export function responder(
  res: ServerResponse,
  status: number,
  cuerpo: unknown,
  cabeceras: Record<string, string> = {},
): void {
  res.writeHead(status, { 'content-type': 'application/json', ...cabeceras });
  res.end(typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo));
}
