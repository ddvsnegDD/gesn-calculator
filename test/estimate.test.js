import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { calcEstimate } from '../src/engine/estimate.js';

const db = openDb();
const PERIOD = db.prepare('SELECT id FROM price_periods ORDER BY id LIMIT 1').pluck().get();

test('свод суммирует статьи по позициям и итог', () => {
  const est = calcEstimate(db, [
    { base_type: 'ГЭСН', work_code: '12-01-015-03', quantity: 48.9941, period_id: PERIOD, item_no: '1.4' },
    { base_type: 'ГЭСН', work_code: '15-01-039-01', quantity: 0.285, period_id: PERIOD, item_no: '1.7' },
  ]);
  assert.equal(est.position_count, 2);
  assert.equal(est.errors.length, 0);
  // итог = сумма total по позициям
  const sum = est.lines.reduce((s, l) => s + l.totals.total, 0);
  assert.ok(Math.abs(est.totals.total - Math.round(sum * 100) / 100) < 0.02);
  // ПЗ/ФОТ/НР/СП присутствуют
  for (const k of ['direct_costs', 'fot', 'overhead', 'profit', 'total']) assert.ok(est.totals[k] > 0);
});

test('сравнение с КП: разница по сопоставленным позициям', () => {
  const est = calcEstimate(db, [
    { base_type: 'ГЭСН', work_code: '12-01-015-03', quantity: 48.9941, period_id: PERIOD, market_total: 900000 },
  ]);
  assert.ok(est.market);
  assert.equal(est.market.market_total, 900000);
  assert.equal(est.market.delta_rub, Math.round((900000 - est.totals.total) * 100) / 100);
});

test('позиция с ошибкой не роняет свод, попадает в errors', () => {
  const est = calcEstimate(db, [
    { base_type: 'ГЭСН', work_code: '12-01-015-03', quantity: 1, period_id: PERIOD },
    { base_type: 'ГЭСН', work_code: 'нет-такой', quantity: 1, period_id: PERIOD },
  ]);
  assert.equal(est.position_count, 1);
  assert.equal(est.errors.length, 1);
  assert.match(est.errors[0].error, /не найдена/);
});

test('без market_total сравнение отсутствует', () => {
  const est = calcEstimate(db, [{ base_type: 'ГЭСН', work_code: '12-01-015-03', quantity: 1, period_id: PERIOD }]);
  assert.equal(est.market, null);
});

test.after(() => db.close());
