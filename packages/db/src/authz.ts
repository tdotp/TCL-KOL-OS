/**
 * Comprobación de capacidad, en un solo sitio.
 *
 * Estaba copiada en `campaigns.ts` y en `sources.ts`, y las dos copias ya
 * habían empezado a separarse: una adjuntaba `details` con la acción y el rol y
 * la otra no. Eso es lo que hace peligrosa la duplicación en código de permisos
 * —no que sea repetitiva, sino que una de las copias se quede atrás sin que
 * nadie lo note—, así que vive aquí y se importa.
 *
 * La política —qué rol puede qué— sigue en `packages/domain/permissions.ts`.
 * Esto solo la aplica.
 */

import { roleCan, type Action, type Result, type User, err, ok } from '@tcl-kol-os/domain';

/**
 * ¿Puede este actor ejecutar esta acción?
 *
 * Se usa cuando **no hay un recurso concreto cuya existencia proteger**: crear,
 * listar, extraer. Cuando sí lo hay, la respuesta correcta ante un recurso
 * ajeno es `RESOURCE_NOT_FOUND` y no `FORBIDDEN_ROLE`: decir "no tienes
 * permiso" ya confirma que el recurso existe.
 */
export function assertCapability(actor: User, action: Action): Result<true> {
  if (actor.status !== 'activo') {
    return err({ code: 'FORBIDDEN_ROLE', message: 'El usuario no está activo.' });
  }
  if (!roleCan(actor.role, action)) {
    return err({
      code: 'FORBIDDEN_ROLE',
      message: `El rol ${actor.role} no puede ejecutar la acción ${action}.`,
      details: { action, role: actor.role },
    });
  }
  return ok(true);
}
