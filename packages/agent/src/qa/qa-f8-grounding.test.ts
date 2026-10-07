/**
 * QA ADVERSARIAL F8 · el grounding de `kpi_target_register` deja pasar objetivos que la persona NO dictó (ataque 17).
 *
 * `verificarObjetivoDeKpiEnLaCita` (packages/agent/src/tools/grounding.ts) exige que la cita contenga la métrica y
 * «una cifra» igual al valor, pero no liga la cifra a la métrica, no entiende «mil»/«.000» y no verifica que el
 * comparador sea coherente con lo dicho. `kpi_target_register` es el ÚNICO write del agente y no pasa por HITL: el
 * valor que fija es el que luego decide si un KPI «se cumplió».
 *
 *  · ABIERTO (`it.fails`): hallazgos CONFIRMADOS. La única aserción que puede fallar es `expect(r.ok).toBe(false)`;
 *    las pruebas de control se corrieron volteando `it.fails` → `it` y `toBe(false)` → `toBe(true)`.
 *  · SEGURO (`it`): lo que el grounding SÍ rechaza.
 */
import { describe, expect, it } from 'vitest';
import { verificarObjetivoDeKpiEnLaCita } from '../tools/grounding.ts';

const verificar = (
  metric: string,
  targetValue: number,
  cita: string,
  comparator?: 'gte' | 'lte',
  otherLabel?: string,
) => verificarObjetivoDeKpiEnLaCita({ metric, otherLabel, targetValue, comparator, cita });

describe('ABIERTO P2 · el comparador no se contrasta con lo que dijo la persona', () => {
  it.fails(
    '«como máximo 100 vistas» sin comparator (gte por defecto) se rechaza: invertiría el objetivo',
    () => {
      const r = verificar('views', 100, 'como máximo 100 vistas', undefined);
      expect(r.ok).toBe(false);
    },
  );

  it.fails('«menos de 100 vistas es inaceptable» con gte se rechaza', () => {
    const r = verificar('views', 100, 'menos de 100 vistas es inaceptable', 'gte');
    expect(r.ok).toBe(false);
  });

  it.fails('«hasta el viernes» (una fecha) no cuenta como un tope superior para aceptar lte', () => {
    const r = verificar('views', 50000, 'Alcanzar 50.000 vistas hasta el viernes', 'lte');
    expect(r.ok).toBe(false);
  });
});

describe('ABIERTO P2 · la cifra se acepta en una lectura que la persona no quiso (factor 1000)', () => {
  it.fails('«50.000 vistas» (cincuenta mil) no admite el valor 50', () => {
    const r = verificar('views', 50, 'Alcanzar 50.000 vistas');
    expect(r.ok).toBe(false);
  });

  it.fails('«10 mil vistas» no admite el valor 10', () => {
    const r = verificar('views', 10, 'quiero 10 mil vistas');
    expect(r.ok).toBe(false);
  });
});

describe('ABIERTO P3 · la cifra no se liga a la métrica ni a la negación', () => {
  it.fails(
    'una cifra de OTRA cosa en la misma frase («alcance de 7 días, 70000 vistas») no vale para reach=7',
    () => {
      const r = verificar('reach', 7, 'alcance de 7 días, 70000 vistas');
      expect(r.ok).toBe(false);
    },
  );

  it.fails('«NO quiero 100 vistas, quiero 5000» no admite 100', () => {
    const r = verificar('views', 100, 'NO quiero 100 vistas, quiero 5000');
    expect(r.ok).toBe(false);
  });
});

describe('SEGURO · lo que el grounding SÍ rechaza', () => {
  it('cifra ausente, cifra mal escrita o parcial de otra cifra («2024» no respalda 20)', () => {
    expect(verificar('views', 1, 'quiero 100000 vistas').ok).toBe(false);
    expect(verificar('views', 20, 'quiero 2024 vistas').ok).toBe(false);
    expect(verificar('views', 7, 'quiero 100 vistas').ok).toBe(false);
  });

  it('métrica no nombrada (la cita habla de otra cosa) y etiqueta `other` ausente', () => {
    expect(verificar('views', 100, 'quiero 100 me gusta').ok).toBe(false);
    expect(verificar('other', 5, 'quiero 5 de algo', undefined, 'conversiones').ok).toBe(false);
    expect(verificar('other', 5, 'quiero 5 conversiones', undefined, 'conversiones').ok).toBe(true);
  });

  it('lte sin ninguna expresión de tope se rechaza; con «como máximo» se acepta', () => {
    expect(verificar('views', 100, 'quiero 100 vistas', 'lte').ok).toBe(false);
    expect(verificar('views', 100, 'como máximo 100 vistas', 'lte').ok).toBe(true);
  });

  it('«1.5 millones de vistas» no respalda el valor 5 ni 1 (sí 1500000)', () => {
    expect(verificar('views', 5, 'tiene 1.5 millones de vistas').ok).toBe(false);
    expect(verificar('views', 1, 'tiene 1.5 millones de vistas').ok).toBe(false);
    expect(verificar('views', 1500000, 'tiene 1.5 millones de vistas').ok).toBe(true);
  });

  it('el caso correcto pasa (control): «50.000 vistas» → 50000; «4,7%» → 4.7', () => {
    expect(verificar('views', 50000, 'Alcanzar 50.000 vistas').ok).toBe(true);
    expect(verificar('engagement_rate', 4.7, 'engagement de 4,7%').ok).toBe(true);
  });
});
