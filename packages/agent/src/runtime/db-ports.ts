/**
 * ÚNICO punto por el que el runtime toca `@tcl-kol-os/db`.
 *
 * El runtime orquesta casos de uso existentes; no escribe SQL ni conoce tablas.
 * Concentrar los imports aquí hace auditable (y comprobable por un test estático)
 * qué puede llamar el runtime: lectura/estado del run, mensajes del chat, ledger de
 * modelo y ensamblado de contexto. NADA de aprobar/confirmar/ejecutar acciones.
 */
export {
  abandonarRunsCaducados,
  completarRun,
  confirmarCancelacionDeRun,
  ensamblarContexto,
  fallarRun,
  findUserById,
  iniciarRun,
  latidoRun,
  listarMensajes,
  obtenerMensaje,
  obtenerRun,
  publicarMensaje,
  registrarLlamadaDeModelo,
  reintentarRun,
} from '@tcl-kol-os/db';
export type {
  CitaDeRespuesta,
  ContextoEnsamblado,
  InformeDeEnsamblado,
  LlamadaDeModelo,
  MensajePublicado,
} from '@tcl-kol-os/db';
