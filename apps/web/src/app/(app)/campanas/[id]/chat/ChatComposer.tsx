'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import type { VistaDeAdjunto } from '@tcl-kol-os/db';
import { enviarMensajeDeChat } from '@/lib/chat-actions';
import {
  ACEPTA_ADJUNTOS,
  MAX_ADJUNTOS_POR_MENSAJE,
  MAX_CARACTERES_DEL_MENSAJE,
  nuevoClientMessageId,
} from './etiquetas';
import styles from './chat.module.css';

interface Subida {
  readonly clave: string;
  readonly nombre: string;
}

interface IntentoDeEnvio {
  readonly id: string;
  readonly texto: string;
  readonly fuentes: string;
}

const SONDEO_DE_ADJUNTOS_MS = 2_000;
const TOPE_DE_SONDEOS = 150; // ~5 minutos

/**
 * Cuadro de redacción del chat.
 *
 *  · Enter envía; Shift+Enter inserta un salto de línea (no durante la composición con IME).
 *  · Idempotencia: cada redacción tiene un `clientMessageId`; un reintento del MISMO contenido
 *    (p. ej. tras un fallo de red) reutiliza la clave y el servidor no duplica el mensaje. La
 *    clave se renueva solo tras un envío correcto (o si la persona cambia el contenido).
 *  · Adjuntos: se suben por la ruta HTTP de adjuntos (no por una server action, que limita el
 *    cuerpo a 1 MB) y pasan a ser fuentes de la campaña; el chip muestra su estado de
 *    procesamiento y se actualiza solo. Al enviar viajan solo sus ids; el servidor los verifica.
 */
export function ChatComposer({
  campaignId,
  bloqueado,
  motivoDeBloqueo,
  turnoActivo,
  maxAdjuntoMb,
}: {
  campaignId: string;
  /** La IA está apagada o no configurada: no se puede escribir. */
  bloqueado: boolean;
  motivoDeBloqueo: string | undefined;
  /** El asistente está respondiendo: se puede redactar pero no enviar hasta que termine. */
  turnoActivo: boolean;
  maxAdjuntoMb: number;
}) {
  const [texto, setTexto] = useState('');
  const [adjuntos, setAdjuntos] = useState<readonly VistaDeAdjunto[]>([]);
  const [subiendo, setSubiendo] = useState<readonly Subida[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [aviso, setAviso] = useState<string | undefined>(undefined);
  const [pendiente, iniciar] = useTransition();
  const area = useRef<HTMLTextAreaElement>(null);
  const entradaDeArchivo = useRef<HTMLInputElement>(null);
  const enVuelo = useRef(false);
  const ultimoIntento = useRef<IntentoDeEnvio | undefined>(undefined);

  const hayProcesando = adjuntos.some((a) => !a.terminal);

  // Sondeo del estado de procesamiento de los adjuntos hasta que todos terminen.
  useEffect(() => {
    if (!hayProcesando) return;
    let cancelado = false;
    let intentos = 0;
    const ids = adjuntos.filter((a) => !a.terminal).map((a) => a.sourceId);
    const t = setInterval(() => {
      intentos += 1;
      if (intentos > TOPE_DE_SONDEOS) {
        clearInterval(t);
        return;
      }
      void (async () => {
        try {
          const res = await fetch(
            `/api/campanas/${encodeURIComponent(campaignId)}/chat/adjuntos?ids=${ids.map(encodeURIComponent).join(',')}`,
            { credentials: 'same-origin', cache: 'no-store' },
          );
          if (!res.ok || cancelado) return;
          const json = (await res.json()) as { adjuntos?: VistaDeAdjunto[] };
          const nuevos = new Map((json.adjuntos ?? []).map((a) => [a.sourceId, a]));
          if (cancelado || nuevos.size === 0) return;
          setAdjuntos((actuales) => actuales.map((a) => nuevos.get(a.sourceId) ?? a));
        } catch {
          // Un fallo de red del sondeo no es un error para la persona: se reintenta.
        }
      })();
    }, SONDEO_DE_ADJUNTOS_MS);
    return () => {
      cancelado = true;
      clearInterval(t);
    };
    // Los ids a sondear salen del estado; basta reaccionar a que haya trabajo pendiente.
  }, [hayProcesando, campaignId, adjuntos.length]);

  async function subir(archivos: FileList | null) {
    if (archivos === null || archivos.length === 0) return;
    setError(undefined);
    setAviso(undefined);
    for (const archivo of Array.from(archivos)) {
      if (adjuntos.length + subiendo.length >= MAX_ADJUNTOS_POR_MENSAJE) {
        setError(`Un mensaje admite hasta ${MAX_ADJUNTOS_POR_MENSAJE} adjuntos.`);
        break;
      }
      if (archivo.size === 0) {
        setError(`«${archivo.name}» está vacío.`);
        continue;
      }
      if (archivo.size > maxAdjuntoMb * 1024 * 1024) {
        setError(`«${archivo.name}» pesa más de ${maxAdjuntoMb} MB, el límite para adjuntar en el chat.`);
        continue;
      }
      const clave = `${archivo.name}-${archivo.size}-${Date.now()}`;
      setSubiendo((s) => [...s, { clave, nombre: archivo.name }]);
      try {
        const cuerpo = new FormData();
        cuerpo.append('archivo', archivo);
        const res = await fetch(`/api/campanas/${encodeURIComponent(campaignId)}/chat/adjuntos`, {
          method: 'POST',
          body: cuerpo,
          credentials: 'same-origin',
        });
        const json = (await res.json().catch(() => undefined)) as
          { adjunto?: VistaDeAdjunto; duplicado?: boolean; aviso?: string; error?: string } | undefined;
        if (!res.ok || json?.adjunto === undefined) {
          setError(json?.error ?? `No se pudo subir «${archivo.name}».`);
        } else {
          const nuevo = json.adjunto;
          setAdjuntos((actuales) =>
            actuales.some((a) => a.sourceId === nuevo.sourceId) ? actuales : [...actuales, nuevo],
          );
          if (json.duplicado === true)
            setAviso(`«${archivo.name}» ya estaba en la campaña: se vinculó la existente.`);
          else if (json.aviso !== undefined && json.aviso !== '') setAviso(json.aviso);
        }
      } catch {
        setError(`No se pudo subir «${archivo.name}». Revisa tu conexión e inténtalo de nuevo.`);
      } finally {
        setSubiendo((s) => s.filter((x) => x.clave !== clave));
      }
    }
    if (entradaDeArchivo.current !== null) entradaDeArchivo.current.value = '';
  }

  function enviar() {
    if (enVuelo.current || bloqueado || turnoActivo) return;
    const contenido = texto.trim();
    if (contenido === '') {
      setError('Escribe un mensaje para el asistente.');
      return;
    }
    if (texto.length > MAX_CARACTERES_DEL_MENSAJE) {
      setError(`El mensaje excede ${MAX_CARACTERES_DEL_MENSAJE.toLocaleString('es-CO')} caracteres.`);
      return;
    }
    const ids = adjuntos.map((a) => a.sourceId);
    const huella = ids.join(',');
    // Mismo contenido que el intento anterior fallido: misma clave (idempotente). Otro: clave nueva.
    const previo = ultimoIntento.current;
    const id =
      previo !== undefined && previo.texto === texto && previo.fuentes === huella
        ? previo.id
        : nuevoClientMessageId();
    ultimoIntento.current = { id, texto, fuentes: huella };

    enVuelo.current = true;
    setError(undefined);
    iniciar(async () => {
      try {
        const r = await enviarMensajeDeChat(campaignId, id, texto, ids);
        if (r.ok) {
          setTexto('');
          setAdjuntos([]);
          setAviso(undefined);
          ultimoIntento.current = undefined; // la clave se renueva solo tras un envío correcto
          area.current?.focus();
        } else {
          setError(r.error);
        }
      } catch {
        setError('No se pudo enviar el mensaje. Revisa tu conexión e inténtalo de nuevo.');
      } finally {
        enVuelo.current = false;
      }
    });
  }

  const sinEspacio = adjuntos.length + subiendo.length >= MAX_ADJUNTOS_POR_MENSAJE;
  const puedeEnviar =
    !bloqueado && !turnoActivo && !pendiente && texto.trim() !== '' && subiendo.length === 0;
  const ayudaId = 'chat-composer-ayuda';

  return (
    <form
      className={styles.composer}
      data-testid="chat-composer"
      onSubmit={(e) => {
        e.preventDefault();
        enviar();
      }}
    >
      {(adjuntos.length > 0 || subiendo.length > 0) && (
        <ul
          className={styles.chips}
          aria-label="Adjuntos del mensaje"
          style={{ listStyle: 'none', padding: 0, margin: 0 }}
        >
          {adjuntos.map((a) => (
            <li
              key={a.sourceId}
              className={styles.chip}
              data-testid="chat-attach-chip"
              data-estado={a.estado}
            >
              <span className={styles.chipNombre} title={a.nombre}>
                {a.nombre}
              </span>
              <span
                className={styles.chipEstado}
                data-estado={a.estado}
                data-testid="chat-attach-chip-estado"
              >
                {a.etiquetaDeEstado}
              </span>
              <button
                type="button"
                className={styles.chipQuitar}
                aria-label={`Quitar «${a.nombre}» del mensaje`}
                onClick={() => setAdjuntos((actuales) => actuales.filter((x) => x.sourceId !== a.sourceId))}
                disabled={pendiente}
                data-testid="chat-attach-remove"
              >
                ×
              </button>
            </li>
          ))}
          {subiendo.map((s) => (
            <li key={s.clave} className={styles.chip} data-testid="chat-attach-uploading">
              <span className={styles.chipNombre} title={s.nombre}>
                {s.nombre}
              </span>
              <span className={styles.chipEstado}>Subiendo…</span>
            </li>
          ))}
        </ul>
      )}

      <div className={styles.composerFila}>
        <label className={styles.ocultoVisualmente} htmlFor="chat-input">
          Mensaje para el asistente
        </label>
        <textarea
          id="chat-input"
          ref={area}
          className={styles.entrada}
          rows={2}
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (puedeEnviar) enviar();
            }
          }}
          placeholder={
            bloqueado
              ? (motivoDeBloqueo ?? 'El asistente no está disponible.')
              : 'Escribe tu mensaje… (Enter envía, Shift+Enter agrega una línea)'
          }
          disabled={bloqueado}
          aria-describedby={ayudaId}
          data-testid="chat-input"
        />
        <button type="submit" className="btn pri" disabled={!puedeEnviar} data-testid="chat-send">
          {pendiente ? 'Enviando…' : 'Enviar'}
        </button>
      </div>

      <div className={styles.composerPie}>
        <span id={ayudaId}>
          {turnoActivo
            ? 'El asistente está respondiendo; podrás enviar cuando termine.'
            : 'El asistente puede equivocarse: revisa lo importante antes de confirmar una acción.'}
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
          {texto.length > MAX_CARACTERES_DEL_MENSAJE * 0.8 && (
            <span>
              {texto.length.toLocaleString('es-CO')} / {MAX_CARACTERES_DEL_MENSAJE.toLocaleString('es-CO')}
            </span>
          )}
          <label className={styles.adjuntar} aria-disabled={bloqueado || sinEspacio}>
            <span aria-hidden="true">+</span> Adjuntar archivo
            <input
              ref={entradaDeArchivo}
              type="file"
              multiple
              accept={ACEPTA_ADJUNTOS}
              className={styles.ocultoVisualmente}
              disabled={bloqueado || sinEspacio}
              onChange={(e) => void subir(e.target.files)}
              data-testid="chat-attach-input"
            />
          </label>
        </span>
      </div>

      {aviso !== undefined && (
        <p className={styles.nota} role="status" data-testid="chat-composer-aviso">
          {aviso}
        </p>
      )}
      {error !== undefined && (
        <p className={styles.error} role="alert" data-testid="chat-composer-error">
          {error}
        </p>
      )}
    </form>
  );
}
