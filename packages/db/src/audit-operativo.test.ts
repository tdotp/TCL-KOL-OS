import { describe, expect, it } from 'vitest';
import { esAccionOperativa, sanitizeMetadataOperativa } from './audit.ts';

const ID = '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

describe('auditoría operativa: allowlist estricta (Fase 8, DEC-013/DEC-049)', () => {
  it('reconoce las acciones operativas y de PII por prefijo', () => {
    for (const a of [
      'pii.reveal',
      'shipment.transition',
      'payment.report',
      'billing.validate',
      'agreement.version',
    ]) {
      expect(esAccionOperativa(a), a).toBe(true);
    }
    expect(esAccionOperativa('script_version.approve')).toBe(false);
    expect(esAccionOperativa('kpi_measurement.recorded')).toBe(false);
  });

  it('conserva ids, estados, versiones, conteos y nombres de campo', () => {
    const m = sanitizeMetadataOperativa({
      shipmentId: ID,
      campaign_influencer_id: ID,
      fromStatus: 'pending',
      toStatus: 'prepared',
      version: 3,
      replayed: false,
      fields: ['address', 'phone'],
    });
    expect(m).toEqual({
      shipmentId: ID,
      campaign_influencer_id: ID,
      fromStatus: 'pending',
      toStatus: 'prepared',
      version: 3,
      replayed: false,
      fields: ['address', 'phone'],
    });
  });

  it('redacta cualquier clave fuera de la lista, aunque parezca inocua (montos, notas, referencias, archivos)', () => {
    const m = sanitizeMetadataOperativa({
      amount: 1500000,
      note: 'enviar a Calle 10 # 5-20',
      externalReference: 'TRX-99',
      filename: 'cedula-valentina.pdf',
      address: 'Calle 10',
      phone: '3001234567',
      documentId: '1020304050',
    });
    expect(Object.values(m).every((v) => v === '[redactado]')).toBe(true);
  });

  it('redacta valores con forma de dato personal en claves permitidas y ids que no son UUID', () => {
    const m = sanitizeMetadataOperativa({
      status: 'Calle 10 # 5-20 apto 3',
      kind: 'x'.repeat(200),
      subjectId: '1020304050',
      fields: ['3001234567'],
      toStatus: { nested: 'a' },
    });
    expect(Object.values(m).every((v) => v === '[redactado]')).toBe(true);
  });
});
