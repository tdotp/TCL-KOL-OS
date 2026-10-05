'use client';

import { useEffect, useRef } from 'react';

/**
 * Mantiene el hilo anclado abajo cuando llega algo nuevo, SALVO que la persona haya subido
 * a releer: entonces no le mueve la pantalla. `clave` cambia cuando hay contenido nuevo.
 */
export function AutoScroll({ clave }: { clave: string }) {
  const ancla = useRef<HTMLDivElement>(null);
  const pegado = useRef(true);

  useEffect(() => {
    const contenedor = ancla.current?.parentElement;
    if (contenedor === null || contenedor === undefined) return;
    const alDesplazar = () => {
      pegado.current = contenedor.scrollHeight - contenedor.scrollTop - contenedor.clientHeight < 96;
    };
    contenedor.addEventListener('scroll', alDesplazar, { passive: true });
    return () => contenedor.removeEventListener('scroll', alDesplazar);
  }, []);

  useEffect(() => {
    const contenedor = ancla.current?.parentElement;
    if (contenedor === null || contenedor === undefined || !pegado.current) return;
    contenedor.scrollTop = contenedor.scrollHeight;
  }, [clave]);

  return <div ref={ancla} aria-hidden="true" />;
}
