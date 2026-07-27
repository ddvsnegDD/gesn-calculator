import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { calcPosition, VAT_RATE } from '../src/engine/calc-position.js';
import { calcEstimate } from '../src/engine/estimate.js';

const db = openDb();
const PERIOD = db.prepare('SELECT id FROM price_periods ORDER BY id LIMIT 1').pluck().get();
const round2 = (x) => Math.round(x * 100) / 100;

// --- Задача 2: НДС 22%, без двойного счёта, база сравнения без НДС ---------

test('ставка НДС — 22% (с 01.01.2026)', () => {
  assert.equal(VAT_RATE, 0.22);
});

test('смета: позиции без НДС, НДС начисляется на итог отдельной строкой', () => {
  const pos = [
    { base_type: 'ГЭСН', work_code: '12-01-015-03', quantity: 1, period_id: PERIOD },
    { base_type: 'ГЭСН', work_code: '27-04-001-01', quantity: 1, period_id: PERIOD,
      main_materials: { '02.3.01.02': '02.3.01.02-1118' }, main_material_quantities: { '02.3.01.02': 110 } },
  ];
  const noVat = calcEstimate(db, pos, { vat: false });
  const withVat = calcEstimate(db, pos, { vat: true });

  assert.equal(noVat.vat_applied, false);
  assert.equal(noVat.totals.vat, 0);
  assert.equal(noVat.prices_include_vat, false);

  // база (без НДС) одинакова — НДС не зашит в цены, двойного счёта нет
  assert.equal(noVat.totals.total_without_vat, withVat.totals.total_without_vat);
  // НДС ровно 22% от итога без НДС
  assert.equal(withVat.totals.vat, round2(withVat.totals.total_without_vat * 0.22));
  assert.equal(withVat.totals.total, round2(withVat.totals.total_without_vat + withVat.totals.vat));
});

test('сравнение с КП ведётся без НДС (like-for-like), НДС не искажает знак', () => {
  const pos = [{ base_type: 'ГЭСН', work_code: '12-01-015-03', quantity: 1, period_id: PERIOD, market_total: 20000 }];
  const noVat = calcEstimate(db, pos, { vat: false });
  const withVat = calcEstimate(db, pos, { vat: true });
  // норматив в сравнении — без НДС в обоих случаях
  assert.equal(noVat.market.normative_total, noVat.totals.total_without_vat);
  assert.equal(withVat.market.normative_total, withVat.totals.total_without_vat);
  assert.equal(noVat.market.delta_rub, withVat.market.delta_rub);
});

// --- Задача 3: ОТм входит в ФОТ (база НР/СП) — закрепить -------------------

test('ОТм (оплата труда машинистов) входит в ФОТ и в базу НР/СП', () => {
  // 12-01-015-03 содержит машины с DriverCode → ненулевой ОТм
  const r = calcPosition(db, { base_type: 'ГЭСН', work_code: '12-01-015-03', quantity: 1, period_id: PERIOD });
  assert.ok(r.totals.drivers_salary > 0, 'ОТм ненулевой');
  // ФОТ = ОТ рабочих + ОТм машинистов
  assert.equal(r.totals.fot, round2(r.totals.labor + r.totals.drivers_salary));
  // НР и СП считаются от ФОТ (включающего ОТм)
  assert.equal(r.totals.overhead, round2((r.totals.fot * r.totals.overhead_pct) / 100));
  assert.equal(r.totals.profit, round2((r.totals.fot * r.totals.profit_pct) / 100));
  // без ОТм база была бы меньше — проверяем, что ОТм реально в базе
  const fotBezOtm = r.totals.labor;
  assert.ok(r.totals.fot > fotBezOtm, 'ФОТ с ОТм больше, чем только ОТ рабочих');
});

test.after(() => db.close());
