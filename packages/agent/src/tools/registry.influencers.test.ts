/** Registro de tools · influencers (Influencer ≠ CampaignInfluencer) con aislamiento por campaña. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asociarInfluencerACampana, closePool, crearInfluencer } from '@tcl-kol-os/db';
import {
  type EscenarioDeChat,
  crearEscenarioDeChat,
  eliminarCampanaDePrueba,
  eliminarInfluencersDePrueba,
} from '@tcl-kol-os/db/test-utils';
import { abrirTurno, json, llamar, registro } from './test-support.ts';

const r = registro();
let e: EscenarioDeChat;
const personas: string[] = [];
let partA: string;
let partB: string;
const sufijo = Date.now().toString(36);

beforeAll(async () => {
  e = await crearEscenarioDeChat('Tools W2A influencers');
  const crear = async (nombre: string, campaignId: string) => {
    const c = await crearInfluencer(e.admin, {
      displayName: `${nombre} ${sufijo}`,
      cuentas: [{ platform: 'instagram', handle: `@${nombre.toLowerCase()}${sufijo}` }],
    });
    if (!c.ok) throw new Error(c.error.message);
    personas.push(c.value.influencer.id);
    const p = await asociarInfluencerACampana(e.admin, { campaignId, influencerId: c.value.influencer.id });
    if (!p.ok) throw new Error(p.error.message);
    return p.value.id;
  };
  partA = await crear('Valentina', e.campanaId);
  partB = await crear('Camilo', e.otraCampanaId);
});

afterAll(async () => {
  await eliminarCampanaDePrueba(e.campanas);
  await eliminarInfluencersDePrueba(personas);
  await closePool();
});

describe('tools de influencers', () => {
  it('lista las participaciones de LA campaña, con alias P y el contenido en sobre no confiable', async () => {
    const t = await abrirTurno(e.consultor, e.campanaId, 'quiénes participan');
    const x = await llamar(r, t, 'influencer_list_participants', {});
    expect(x.status).toBe('succeeded');
    const d = json(x);
    expect(d).toMatchObject({ total: 1, active: 1 });
    expect(d['participants']).toContain('Valentina');
    expect(d['participants']).not.toContain('Camilo');
    expect(t.referencias.listar().filter((a) => a.kind === 'campaign_influencer')).toHaveLength(1);
  });

  it('la participación de OTRA campaña (misma org) o el id del Influencer en vez de la participación → RESOURCE_NOT_FOUND', async () => {
    const t = await abrirTurno(e.consultor, e.campanaId, 'detalle');
    for (const tool of ['influencer_get_participation', 'influencer_get_origin']) {
      expect((await llamar(r, t, tool, { participationId: partB })).errorCode, tool).toBe(
        'RESOURCE_NOT_FOUND',
      );
      expect((await llamar(r, t, tool, { participationId: personas[0]! })).errorCode, tool).toBe(
        'RESOURCE_NOT_FOUND',
      );
    }
    const ok = await llamar(r, t, 'influencer_get_participation', { participationId: partA });
    expect(ok.status).toBe('succeeded');
    expect(json(ok)).toMatchObject({ status: 'activo', accounts: 1 });
    const origen = await llamar(r, t, 'influencer_get_origin', { participationId: partA });
    expect(json(origen)).toMatchObject({ fromSheet: false });
  });

  it('un admin de otra agencia no ve participaciones de esta', async () => {
    const t = await abrirTurno(e.ajeno, e.campanaAjenaId, 'detalle');
    expect((await llamar(r, t, 'influencer_get_participation', { participationId: partA })).errorCode).toBe(
      'RESOURCE_NOT_FOUND',
    );
    expect(json(await llamar(r, t, 'influencer_list_participants', {}))).toMatchObject({ total: 0 });
  });
});
