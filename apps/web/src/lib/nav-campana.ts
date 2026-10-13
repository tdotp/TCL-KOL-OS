import { type Action, type Role, roleCan } from '@tcl-kol-os/domain';

/** Sección activa de la navegación de campaña. */
export type SeccionCampana =
  'resumen' | 'fuentes' | 'brief' | 'editar' | 'asistente' | 'contenido' | 'operacion';

export type EnlaceCampana = {
  seccion: SeccionCampana;
  etiqueta: string;
  /** Ruta relativa a `/campanas/{id}` (vacía = resumen). */
  ruta: string;
  accion: Action;
  testid?: string;
};

/** Orden canónico y permiso que gobierna cada enlace (la UI solo MUESTRA lo que el servidor ya permite). */
const ENLACES: readonly EnlaceCampana[] = [
  { seccion: 'resumen', etiqueta: 'Resumen', ruta: '', accion: 'campaign:read' },
  { seccion: 'fuentes', etiqueta: 'Fuentes', ruta: '/fuentes', accion: 'source:read' },
  { seccion: 'brief', etiqueta: 'Brief', ruta: '/brief', accion: 'brief:read' },
  { seccion: 'editar', etiqueta: 'Editar', ruta: '/brief/editar', accion: 'brief:edit' },
  {
    seccion: 'asistente',
    etiqueta: 'Asistente',
    ruta: '/chat',
    accion: 'chat:write',
    testid: 'chat-nav-link',
  },
  {
    seccion: 'contenido',
    etiqueta: 'Contenido',
    ruta: '/contenido',
    accion: 'deliverable:read',
    testid: 'contenido-nav-link',
  },
  {
    seccion: 'operacion',
    etiqueta: 'Operación',
    ruta: '/operacion',
    accion: 'operations:read',
    testid: 'operacion-nav-link',
  },
];

/** Enlaces de la navegación de campaña que el rol puede ver, en orden canónico. */
export function enlacesDeCampana(role: Role): readonly EnlaceCampana[] {
  return ENLACES.filter((e) => roleCan(role, e.accion));
}
