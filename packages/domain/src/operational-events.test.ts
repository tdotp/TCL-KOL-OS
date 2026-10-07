import { describe, expect, it } from 'vitest';
import { ROLES } from './types';
import { roleCan } from './permissions';
import {
  CREATION_EVENT_TYPE,
  EVENT_TYPES_REQUIRING_DATE,
  EVIDENCE_KINDS,
  NOTE_EVENT_TYPES,
  OPERATIONAL_EVENT_EDGES,
  OPERATIONAL_EVENT_TYPES,
  OPERATIONAL_SUBJECT_TYPES,
  OPERATIONS_CAPABILITY_ACTIONS,
  OPERATIONS_CAPABILITY_ROLES,
  canTransitionOperationalSubject,
  capabilityForEventType,
  classifyIdempotency,
  eventTypesForTransition,
  initialStatusesOf,
  isCreationEventType,
  FECHA_ISO_MAXIMA,
  FECHA_ISO_MINIMA,
  esClaveDeIdempotenciaValida,
  isIsoDate,
  isNoteEventType,
  isStaleTransition,
  isValidOperationalEdge,
  manageActionForSubject,
  readActionForSubject,
  tieneCaracteresNoValidos,
  roleMayRecordEvent,
  statusesOf,
  statusesProducedBy,
  subjectTypeOfEventType,
  validateOperationalEventRequest,
  type OperationalEventType,
} from './operational-events';

const AHORA = new Date('2026-10-07T12:00:00Z');
const base = {
  subjectType: 'shipment',
  idempotencyKey: 'clave-0001',
  origin: 'ui',
} as const;

describe('lista cerrada de eventos', () => {
  it('son exactamente los 16 del freeze', () => {
    expect([...OPERATIONAL_EVENT_TYPES].sort()).toEqual(
      [
        'billing.registered',
        'billing.rejected',
        'billing.validated',
        'billing.voided',
        'evidence.attached',
        'payment.applicability_set',
        'payment.cancelled',
        'payment.correction_noted',
        'payment.reported',
        'shipment.cancelled',
        'shipment.created',
        'shipment.delivered',
        'shipment.failed',
        'shipment.prepared',
        'shipment.returned',
        'shipment.shipped',
      ].sort(),
    );
  });

  it('cada tipo con to_status produce estados concretos; las notas ninguno', () => {
    for (const tipo of OPERATIONAL_EVENT_TYPES) {
      const produce = statusesProducedBy(tipo);
      if (isNoteEventType(tipo)) expect(produce).toEqual([]);
      else expect(produce.length).toBeGreaterThan(0);
    }
    expect(NOTE_EVENT_TYPES).toEqual(['payment.correction_noted', 'evidence.attached']);
    expect(statusesProducedBy('shipment.delivered')).toEqual(['delivered']);
    expect([...statusesProducedBy('payment.applicability_set')].sort()).toEqual([
      'not_applicable',
      'pending',
    ]);
  });

  it('cada tipo pertenece a un sujeto (evidence.attached, a cualquiera)', () => {
    expect(subjectTypeOfEventType('shipment.shipped')).toBe('shipment');
    expect(subjectTypeOfEventType('billing.voided')).toBe('billing_document');
    expect(subjectTypeOfEventType('payment.reported')).toBe('payment_obligation');
    expect(subjectTypeOfEventType('evidence.attached')).toBeUndefined();
  });

  it('exactamente un evento de creación por sujeto, y es el declarado', () => {
    for (const sujeto of OPERATIONAL_SUBJECT_TYPES) {
      const creadores = OPERATIONAL_EVENT_TYPES.filter(
        (t) => subjectTypeOfEventType(t) === sujeto && isCreationEventType(t),
      );
      expect(creadores).toEqual([CREATION_EVENT_TYPE[sujeto]]);
    }
    expect(initialStatusesOf('shipment')).toEqual(['pending']);
    expect(initialStatusesOf('billing_document')).toEqual(['registered']);
    expect([...initialStatusesOf('payment_obligation')].sort()).toEqual(['not_applicable', 'pending']);
  });
});

describe('aristas', () => {
  it('todas las aristas son únicas y de un sujeto coherente', () => {
    const claves = OPERATIONAL_EVENT_EDGES.map((e) => `${e.eventType}|${e.from}|${e.to}`);
    expect(new Set(claves).size).toBe(claves.length);
    for (const e of OPERATIONAL_EVENT_EDGES) expect(subjectTypeOfEventType(e.eventType)).toBeDefined();
  });

  it('delivered solo se alcanza con shipment.delivered desde shipped', () => {
    expect(eventTypesForTransition('shipment', 'shipped', 'delivered')).toEqual(['shipment.delivered']);
    expect(eventTypesForTransition('shipment', 'prepared', 'delivered')).toEqual([]);
    expect(eventTypesForTransition('shipment', 'pending', 'delivered')).toEqual([]);
    expect(isValidOperationalEdge('shipment.prepared', 'pending', 'delivered')).toBe(false);
  });

  it('reported_paid es terminal; cancelled también', () => {
    for (const hacia of statusesOf('payment_obligation')) {
      expect(canTransitionOperationalSubject('payment_obligation', 'reported_paid', hacia)).toBe(false);
      expect(canTransitionOperationalSubject('payment_obligation', 'cancelled', hacia)).toBe(false);
    }
  });

  it('un tipo de evento no produce una arista de otro tipo', () => {
    expect(isValidOperationalEdge('billing.validated', 'registered', 'rejected')).toBe(false);
    expect(isValidOperationalEdge('shipment.created', null, 'pending')).toBe(true);
    expect(isValidOperationalEdge('shipment.created', 'pending', 'pending')).toBe(false);
  });
});

describe('capacidades y roles', () => {
  it('reportar el pago exige report_payment; el resto manage_ops', () => {
    for (const tipo of OPERATIONAL_EVENT_TYPES) {
      expect(capabilityForEventType(tipo)).toBe(
        tipo === 'payment.reported' ? 'report_payment' : 'manage_ops',
      );
    }
    expect(roleMayRecordEvent('operativo', 'payment.reported')).toBe(true);
    expect(roleMayRecordEvent('director', 'payment.reported')).toBe(false);
    expect(roleMayRecordEvent('director', 'billing.validated')).toBe(true);
    expect(roleMayRecordEvent('consultor', 'shipment.shipped')).toBe(false);
    expect(roleMayRecordEvent('cliente', 'shipment.shipped')).toBe(false);
  });

  it('PARIDAD con roleCan: cada capacidad espeja exactamente las acciones de permissions.ts', () => {
    for (const [capacidad, roles] of Object.entries(OPERATIONS_CAPABILITY_ROLES)) {
      const acciones = OPERATIONS_CAPABILITY_ACTIONS[capacidad as keyof typeof OPERATIONS_CAPABILITY_ROLES];
      for (const accion of acciones) {
        const quienes = ROLES.filter((r) => roleCan(r, accion));
        expect([...quienes].sort(), `${capacidad} ← ${accion}`).toEqual([...roles].sort());
      }
    }
  });

  it('la evidencia se lee con la capacidad de su sujeto', () => {
    expect(readActionForSubject('shipment')).toBe('shipment:read');
    expect(readActionForSubject('billing_document')).toBe('finance:read');
    expect(readActionForSubject('payment_obligation')).toBe('finance:read');
  });

  it('lista cerrada de tipos de evidencia', () => {
    expect(EVIDENCE_KINDS).toEqual([
      'guia',
      'cotizacion',
      'orden_compra',
      'cuenta_cobro',
      'comprobante',
      'soporte',
      'otro',
    ]);
  });
});

describe('validateOperationalEventRequest', () => {
  it('acepta un envío preparado → enviado con fecha', () => {
    const r = validateOperationalEventRequest(
      {
        ...base,
        eventType: 'shipment.shipped',
        fromStatus: 'prepared',
        toStatus: 'shipped',
        happenedOn: '2026-10-06',
      },
      AHORA,
    );
    expect(r.ok).toBe(true);
  });

  it('rechaza cualquier origen distinto de ui (IA, chat, sistema)', () => {
    for (const origin of ['agent', 'chat', 'system', 'api', '']) {
      const r = validateOperationalEventRequest(
        { ...base, origin, eventType: 'shipment.prepared', fromStatus: 'pending', toStatus: 'prepared' },
        AHORA,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('FORBIDDEN_ROLE');
    }
  });

  it('rechaza tipos desconocidos y sujetos incoherentes', () => {
    expect(validateOperationalEventRequest({ ...base, eventType: 'shipment.exploded' }, AHORA).ok).toBe(
      false,
    );
    expect(
      validateOperationalEventRequest(
        {
          ...base,
          subjectType: 'billing_document',
          eventType: 'shipment.prepared',
          fromStatus: 'pending',
          toStatus: 'prepared',
        },
        AHORA,
      ).ok,
    ).toBe(false);
  });

  it('rechaza transiciones fuera del grafo con RESOURCE_CONFLICT', () => {
    const r = validateOperationalEventRequest(
      {
        ...base,
        eventType: 'shipment.delivered',
        fromStatus: 'prepared',
        toStatus: 'delivered',
        happenedOn: '2026-10-06',
      },
      AHORA,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('RESOURCE_CONFLICT');
  });

  it('exige fecha en enviado/entregado/pago y referencia en pago reportado', () => {
    for (const tipo of EVENT_TYPES_REQUIRING_DATE) {
      const desde = {
        'shipment.shipped': 'prepared',
        'shipment.delivered': 'shipped',
        'payment.reported': 'pending',
      }[tipo as 'shipment.shipped'];
      const hacia = {
        'shipment.shipped': 'shipped',
        'shipment.delivered': 'delivered',
        'payment.reported': 'reported_paid',
      }[tipo as 'shipment.shipped'];
      const sujeto = tipo.startsWith('payment') ? 'payment_obligation' : 'shipment';
      const sin = validateOperationalEventRequest(
        {
          ...base,
          subjectType: sujeto,
          eventType: tipo,
          fromStatus: desde,
          toStatus: hacia,
          externalReference: 'REF-1',
        },
        AHORA,
      );
      expect(sin.ok, tipo).toBe(false);
    }
    const sinRef = validateOperationalEventRequest(
      {
        ...base,
        subjectType: 'payment_obligation',
        eventType: 'payment.reported',
        fromStatus: 'pending',
        toStatus: 'reported_paid',
        happenedOn: '2026-10-06',
      },
      AHORA,
    );
    expect(sinRef.ok).toBe(false);
    const completo = validateOperationalEventRequest(
      {
        ...base,
        subjectType: 'payment_obligation',
        eventType: 'payment.reported',
        fromStatus: 'pending',
        toStatus: 'reported_paid',
        happenedOn: '2026-10-06',
        externalReference: 'TRX-889',
      },
      AHORA,
    );
    expect(completo.ok).toBe(true);
  });

  it('las notas no llevan estado; la fecha del hecho no está en el futuro', () => {
    const nota = validateOperationalEventRequest(
      { ...base, subjectType: 'payment_obligation', eventType: 'payment.correction_noted', note: ' ajuste ' },
      AHORA,
    );
    expect(nota.ok).toBe(true);
    if (nota.ok) expect(nota.value.note).toBe('ajuste');
    expect(
      validateOperationalEventRequest(
        {
          ...base,
          subjectType: 'payment_obligation',
          eventType: 'payment.correction_noted',
          toStatus: 'pending',
        },
        AHORA,
      ).ok,
    ).toBe(false);
    expect(
      validateOperationalEventRequest(
        {
          ...base,
          eventType: 'shipment.shipped',
          fromStatus: 'prepared',
          toStatus: 'shipped',
          happenedOn: '2026-10-20',
        },
        AHORA,
      ).ok,
    ).toBe(false);
  });

  it('valida la clave de idempotencia, la fecha y la longitud de la nota', () => {
    const tipo: OperationalEventType = 'shipment.prepared';
    const ok = { ...base, eventType: tipo, fromStatus: 'pending', toStatus: 'prepared' } as const;
    expect(validateOperationalEventRequest({ ...ok, idempotencyKey: '' }, AHORA).ok).toBe(false);
    expect(validateOperationalEventRequest({ ...ok, idempotencyKey: ' x ' }, AHORA).ok).toBe(false);
    expect(validateOperationalEventRequest({ ...ok, idempotencyKey: 'x'.repeat(201) }, AHORA).ok).toBe(false);
    expect(validateOperationalEventRequest({ ...ok, note: 'x'.repeat(2001) }, AHORA).ok).toBe(false);
    expect(validateOperationalEventRequest({ ...ok, happenedOn: '2026-02-30' }, AHORA).ok).toBe(false);
    expect(isIsoDate('2026-02-28')).toBe(true);
    expect(isIsoDate('2026-2-8')).toBe(false);
  });
});

describe('idempotencia y concurrencia', () => {
  it('misma clave: misma huella = replay; otra huella = conflicto', () => {
    expect(classifyIdempotency(undefined, 'h1')).toBe('new');
    expect(classifyIdempotency({ requestHash: 'h1' }, 'h1')).toBe('replay');
    expect(classifyIdempotency({ requestHash: 'h1' }, 'h2')).toBe('conflict');
  });

  it('expected_seq distinto del vigente es transición obsoleta', () => {
    expect(isStaleTransition(3, 3)).toBe(false);
    expect(isStaleTransition(2, 3)).toBe(true);
  });
});

describe('endurecimiento (FIX-B): fechas en rango, claves sin invisibles y capacidad de gestión', () => {
  it('isIsoDate rechaza 0000-01-01 y lo que Postgres no guarda, y acepta los límites', () => {
    for (const mala of [
      '0000-01-01',
      '0001-01-01',
      '1899-12-31',
      '2026-02-30',
      '2026-00-10',
      '',
      '2026-1-1',
    ]) {
      expect(isIsoDate(mala), mala).toBe(false);
    }
    expect(isIsoDate(FECHA_ISO_MINIMA)).toBe(true);
    expect(isIsoDate(FECHA_ISO_MAXIMA)).toBe(true);
    expect(isIsoDate('2026-02-28')).toBe(true);
    expect(isIsoDate('2028-02-29')).toBe(true);
  });

  it('tieneCaracteresNoValidos: NUL, control, invisibles y bidi; con multilinea tolera \\n \\r \\t', () => {
    for (const mala of ['a\u0000b', 'a\u200Bb', 'a\u202Eb', 'a\u0007b', 'a\u00ADb']) {
      expect(tieneCaracteresNoValidos(mala), JSON.stringify(mala)).toBe(true);
      expect(tieneCaracteresNoValidos(mala, true), JSON.stringify(mala)).toBe(true);
    }
    expect(tieneCaracteresNoValidos('a\nb\tc')).toBe(true);
    expect(tieneCaracteresNoValidos('a\nb\tc\r', true)).toBe(false);
    expect(tieneCaracteresNoValidos('Canción ñandú 😀')).toBe(false);
  });

  it('la clave de idempotencia rechaza bidi e invisibles además de control, espacios y exceso', () => {
    expect(esClaveDeIdempotenciaValida('envio-123:a')).toBe(true);
    for (const mala of ['', ' x', 'x ', 'a\u0000', 'k\u202E', 'k\u200B', 'x'.repeat(201), 5, null]) {
      expect(esClaveDeIdempotenciaValida(mala), JSON.stringify(mala)).toBe(false);
    }
    const r = validateOperationalEventRequest(
      {
        eventType: 'shipment.created',
        subjectType: 'shipment',
        toStatus: 'pending',
        idempotencyKey: 'clave\u202E',
      },
      new Date(),
    );
    expect(r.ok).toBe(false);
  });

  it('la capacidad de gestión del sujeto: envío ⇒ shipment:manage; cobro y pago ⇒ billing:manage', () => {
    expect(manageActionForSubject('shipment')).toBe('shipment:manage');
    expect(manageActionForSubject('billing_document')).toBe('billing:manage');
    expect(manageActionForSubject('payment_obligation')).toBe('billing:manage');
  });
});
