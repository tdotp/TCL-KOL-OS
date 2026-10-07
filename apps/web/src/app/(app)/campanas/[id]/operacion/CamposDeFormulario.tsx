'use client';

import { useState } from 'react';
import { AVISO_NOTAS_SIN_PII } from '@/lib/operacion-comun';
import { MODO_DE_ACUERDO } from './etiquetas';
import styles from './operacion.module.css';

/** Nota libre opcional con el aviso fijo de no escribir datos personales. */
export function CampoNota({
  nombre = 'note',
  etiqueta = 'Nota (opcional)',
}: {
  nombre?: string;
  etiqueta?: string;
}) {
  return (
    <label style={{ gridColumn: '1 / -1' }}>
      {etiqueta}
      <textarea name={nombre} maxLength={2000} rows={2} />
      <span className={styles['itemMeta']} data-testid="aviso-notas-sin-pii">
        {AVISO_NOTAS_SIN_PII}
      </span>
    </label>
  );
}

/** Aviso fijo de no escribir datos personales en un texto libre (motivos, notas). */
export function AvisoSinPii() {
  return (
    <p
      className={styles['itemMeta']}
      style={{ gridColumn: '1 / -1', margin: 0 }}
      data-testid="aviso-notas-sin-pii"
    >
      {AVISO_NOTAS_SIN_PII}
    </p>
  );
}

export interface OpcionDeProducto {
  readonly id: string;
  readonly nombre: string;
}

interface Fila {
  readonly k: number;
  readonly producto: string;
  readonly cantidad: string;
}

/** Filas producto/cantidad (campos repetidos y alineados que lee el servidor). */
export function FilasDeProducto({
  productos,
  campoProducto,
  campoCantidad,
  rotulo,
  inicial,
}: {
  productos: readonly OpcionDeProducto[];
  campoProducto: string;
  campoCantidad: string;
  rotulo: string;
  inicial?: readonly { readonly id: string; readonly cantidad: number }[];
}) {
  const [filas, setFilas] = useState<readonly Fila[]>(() =>
    inicial !== undefined && inicial.length > 0
      ? inicial.map((f, i) => ({ k: i, producto: f.id, cantidad: String(f.cantidad) }))
      : [{ k: 0, producto: '', cantidad: '' }],
  );
  const [siguiente, setSiguiente] = useState(filas.length);

  if (productos.length === 0) {
    return (
      <p className={styles['aviso']} style={{ gridColumn: '1 / -1' }} data-testid="sin-productos-asignados">
        Este influencer no tiene productos asignados en la campaña: asígnalos antes de {rotulo}.
      </p>
    );
  }

  const cambiar = (k: number, parte: Partial<Fila>) =>
    setFilas((actual) => actual.map((f) => (f.k === k ? { ...f, ...parte } : f)));

  return (
    <fieldset
      style={{ gridColumn: '1 / -1', border: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}
    >
      <legend className={styles['subtitulo']}>{rotulo}</legend>
      {filas.map((f, i) => (
        <div key={f.k} className={styles['fila2']} data-testid="fila-producto">
          <label>
            Producto
            <select
              name={campoProducto}
              value={f.producto}
              onChange={(e) => cambiar(f.k, { producto: e.target.value })}
            >
              <option value="">Elige un producto</option>
              {productos.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nombre}
                </option>
              ))}
            </select>
          </label>
          <label>
            Cantidad
            <input
              type="number"
              name={campoCantidad}
              min={1}
              step={1}
              inputMode="numeric"
              value={f.cantidad}
              onChange={(e) => cambiar(f.k, { cantidad: e.target.value })}
            />
          </label>
          <button
            type="button"
            className="btn"
            aria-label={`Quitar producto ${i + 1}`}
            disabled={filas.length === 1}
            onClick={() => setFilas((actual) => actual.filter((x) => x.k !== f.k))}
          >
            Quitar
          </button>
        </div>
      ))}
      <div className={styles['acciones']}>
        <button
          type="button"
          className="btn"
          onClick={() => {
            setFilas((actual) => [...actual, { k: siguiente, producto: '', cantidad: '' }]);
            setSiguiente((n) => n + 1);
          }}
        >
          Agregar producto
        </button>
      </div>
    </fieldset>
  );
}

export interface TerminosIniciales {
  readonly modo: string;
  readonly feeAmount?: string | null | undefined;
  readonly feeCurrency?: string | null | undefined;
  readonly startsOn?: string | null | undefined;
  readonly endsOn?: string | null | undefined;
  readonly conditions?: string | null | undefined;
  readonly compromisos?: readonly { readonly id: string; readonly cantidad: number }[];
}

/**
 * Términos del acuerdo (crear y versión nueva). Barter ⇒ no se piden monto ni moneda y se muestra «Pago: no
 * aplica»; fee ⇒ sin compromisos de producto; mixto ⇒ ambos.
 */
export function TerminosDeAcuerdo({
  productos,
  mostrarMonto,
  inicial,
}: {
  productos: readonly OpcionDeProducto[];
  mostrarMonto: boolean;
  inicial?: TerminosIniciales;
}) {
  const [modo, setModo] = useState(inicial?.modo ?? 'fee');
  return (
    <>
      <label>
        Modo de compensación
        <select name="compensationType" value={modo} onChange={(e) => setModo(e.target.value)}>
          {Object.entries(MODO_DE_ACUERDO).map(([valor, etiqueta]) => (
            <option key={valor} value={valor}>
              {etiqueta}
            </option>
          ))}
        </select>
      </label>
      {modo === 'barter' ? (
        <p className={styles['aviso']} data-testid="pago-no-aplica">
          Pago: no aplica
        </p>
      ) : (
        mostrarMonto && (
          <>
            <label>
              Monto del fee
              <input
                type="text"
                name="feeAmount"
                inputMode="decimal"
                autoComplete="off"
                placeholder="1500000.00"
                defaultValue={inicial?.feeAmount ?? ''}
              />
            </label>
            <label>
              Moneda (3 letras)
              <input
                type="text"
                name="feeCurrency"
                maxLength={3}
                autoComplete="off"
                placeholder="COP"
                defaultValue={inicial?.feeCurrency ?? 'COP'}
              />
            </label>
          </>
        )
      )}
      <label>
        Inicio de la vigencia
        <input type="date" name="startsOn" defaultValue={inicial?.startsOn ?? ''} />
      </label>
      <label>
        Fin de la vigencia
        <input type="date" name="endsOn" defaultValue={inicial?.endsOn ?? ''} />
      </label>
      <label style={{ gridColumn: '1 / -1' }}>
        Condiciones
        <textarea name="conditions" maxLength={4000} rows={3} defaultValue={inicial?.conditions ?? ''} />
      </label>
      {modo !== 'fee' && (
        <FilasDeProducto
          productos={productos}
          campoProducto="commitmentProductId"
          campoCantidad="commitmentQuantity"
          rotulo="Productos comprometidos"
          {...(inicial?.compromisos !== undefined ? { inicial: inicial.compromisos } : {})}
        />
      )}
    </>
  );
}
