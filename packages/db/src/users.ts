/**
 * Usuarios, organizaciones y catálogo de producto.
 */

import type { Role, User } from '@tcl-kol-os/domain';
import { getPool } from './client.ts';

interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly organization_id: string;
  readonly role: Role;
  readonly status: 'activo' | 'inactivo';
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    organizationId: row.organization_id,
    role: row.role,
    status: row.status,
  };
}

/**
 * Busca el usuario por correo. Es el punto de entrada del login: solo un correo
 * previamente registrado puede iniciar sesión, sin importar el proveedor de
 * identidad (E2-1).
 */
export async function findUserByEmail(email: string): Promise<User | undefined> {
  const { rows } = await getPool().query<UserRow>(
    `SELECT id, email, name, organization_id, role, status FROM users WHERE email = $1`,
    [email],
  );
  const row = rows[0];
  return row === undefined ? undefined : toUser(row);
}

export async function findUserById(id: string): Promise<User | undefined> {
  const { rows } = await getPool().query<UserRow>(
    `SELECT id, email, name, organization_id, role, status FROM users WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  return row === undefined ? undefined : toUser(row);
}

export interface ProductRow {
  readonly id: string;
  readonly brand: string;
  readonly category: string;
  readonly model: string;
  readonly market: string | null;
}

/**
 * El catálogo de producto no está segmentado por organización: los productos de
 * TCL son los mismos para quien los comunica. Lo que sí es privado es la campaña
 * que los usa.
 */
export async function listProducts(): Promise<ProductRow[]> {
  const { rows } = await getPool().query<ProductRow>(
    `SELECT id, brand, category, model, market FROM products ORDER BY brand, model`,
  );
  return rows;
}
