/**
 * Sesión de usuario.
 *
 * Épica E2. El proveedor de identidad es conmutable:
 *
 *   AUTH_PROVIDER=dev   → selección de usuario sembrado, solo para desarrollo (opt-in explícito)
 *   AUTH_PROVIDER=oidc  → Google Workspace (requiere credenciales reales; aún no implementado)
 *   sin definir         → `dev` fuera de producción; en producción `oidc` (el acceso dev NUNCA se
 *                         activa por omisión: fail-closed)
 *
 * En ambos casos la sesión resultante es la misma: una cookie firmada con el ID
 * del usuario. El resto del sistema no sabe —ni le importa— cómo se autenticó.
 *
 * El usuario debe existir previamente en la base: el proveedor de identidad
 * verifica quién eres, no te da acceso. Un correo desconocido no entra ni con
 * OIDC válido (E2-1).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import type { User } from '@tcl-kol-os/domain';
import { findUserById } from '@tcl-kol-os/db';

const COOKIE = 'tclkolos_session';
const MAX_AGE_SECONDS = 60 * 60 * 8;

export type AuthProvider = 'dev' | 'oidc';

export function authProvider(): AuthProvider {
  const configurado = process.env['AUTH_PROVIDER'];
  if (configurado === 'dev' || configurado === 'oidc') return configurado;
  // Sin configurar (o con un valor desconocido): el acceso por selección de usuario solo existe fuera de
  // producción. En producción se cae a `oidc`, que no está implementado ⇒ nadie inicia sesión.
  return process.env['NODE_ENV'] === 'production' ? 'oidc' : 'dev';
}

function secret(): string {
  const value = process.env['SESSION_SECRET'];
  if (value === undefined || value.trim() === '') {
    if (process.env['NODE_ENV'] === 'production') {
      throw new Error('SESSION_SECRET es obligatorio en producción.');
    }
    return 'desarrollo-inseguro-no-usar-en-produccion';
  }
  if (process.env['NODE_ENV'] === 'production' && value.trim().length < 16) {
    throw new Error('SESSION_SECRET debe tener al menos 16 caracteres en producción.');
  }
  return value;
}

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url');
}

function verify(payload: string, firma: string): boolean {
  const esperada = Buffer.from(sign(payload));
  const recibida = Buffer.from(firma);
  // Comparación en tiempo constante: una comparación normal filtra información
  // sobre cuántos caracteres coinciden.
  if (esperada.length !== recibida.length) return false;
  return timingSafeEqual(esperada, recibida);
}

/** Crea el valor de cookie firmado. La expiración va dentro de la firma. */
export function buildSessionValue(userId: string): string {
  const expira = Date.now() + MAX_AGE_SECONDS * 1000;
  const payload = `${userId}.${expira}`;
  return `${payload}.${sign(payload)}`;
}

function parseSessionValue(value: string): string | undefined {
  const partes = value.split('.');
  if (partes.length !== 3) return undefined;
  const [userId, expiraStr, firma] = partes as [string, string, string];

  if (!verify(`${userId}.${expiraStr}`, firma)) return undefined;

  const expira = Number(expiraStr);
  if (!Number.isFinite(expira) || Date.now() > expira) return undefined;

  return userId;
}

/** Usuario de la petición actual, o `undefined` si no hay sesión válida. */
export async function currentUser(): Promise<User | undefined> {
  const store = await cookies();
  const cookie = store.get(COOKIE);
  if (cookie === undefined) return undefined;

  const userId = parseSessionValue(cookie.value);
  if (userId === undefined) return undefined;

  const user = await findUserById(userId);
  // Un usuario desactivado después de iniciar sesión pierde el acceso de
  // inmediato: no se espera a que expire la cookie.
  if (user === undefined || user.status !== 'activo') return undefined;

  return user;
}

export const SESSION_COOKIE = COOKIE;
export const SESSION_MAX_AGE = MAX_AGE_SECONDS;
