import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { compareUnits, parseUnit } from '../src/engine/units.js';
import { calcPosition } from '../src/engine/calc-position.js';
import { calcEstimate } from '../src/engine/estimate.js';

const db = openDb();
const PERIOD = db.prepare('SELECT id FROM price_periods ORDER BY id LIMIT 1').pluck().get();

test('parseUnit выделяет множитель и базу', () => {
  assert.deepEqual(parseUnit('100 м2'), { factor: 100, base: 'м2', raw: '100 м2' });
  assert.deepEqual(parseUnit('м.п.'), { factor: 1, base: 'м', raw: 'м.п.' });
  assert.deepEqual(parseUnit('1000 м'), { factor: 1000, base: 'м', raw: '1000 м' });
});

test('compareUnits: кратность «м2» vs «100 м2» — расхождение', () => {
  const r = compareUnits('м2', '100 м2');
  assert.equal(r.match, false);
  assert.equal(r.ratio, 100);
});

test('compareUnits: одинаковые единицы совпадают', () => {
  assert.equal(compareUnits('шт', 'шт').match, true);
  assert.equal(compareUnits('т', 'т').match, true);
});

test('compareUnits: разные базы — расхождение', () => {
  assert.equal(compareUnits('шт', '100 отверстий').match, false);
  assert.equal(compareUnits('м.п.', '100 м2').match, false);
});

// Регрессия задачи 1: четыре позиции «Гранита», где КП «м2», норма «100 м2».
// Объём КП как есть (91) на «100 м2» = завышение в 100 раз — движок обязан
// поставить флаг, а свод — заблокировать, не выдавая молчаливый результат.
const UNIT_MISMATCH_POSITIONS = [
  { item_no: '1.2', base_type: 'ГЭСНр', code: '63-03-001-02', qty: 91 },
  { item_no: '1.4', base_type: 'ГЭСН', code: '11-01-004-05', qty: 91 },
  { item_no: '1.5', base_type: 'ГЭСН', code: '11-01-031-07', qty: 59.5 },
  { item_no: '1.11', base_type: 'ГЭСН', code: '15-04-045-01', qty: 91 },
];

test('calcPosition ставит флаг единиц при КП «м2» на норму «100 м2»', () => {
  for (const p of UNIT_MISMATCH_POSITIONS) {
    const r = calcPosition(db, {
      base_type: p.base_type, work_code: p.code, quantity: p.qty, period_id: PERIOD, quote_unit: 'м2',
    });
    assert.equal(r.work.measure_unit, '100 м2', `${p.item_no}: норма в 100 м2`);
    assert.ok(r.flags.includes('единицы_позиции_не_совпадают'), `${p.item_no}: флаг`);
    assert.equal(r.unit_check.match, false);
    assert.equal(r.unit_check.ratio, 100);
  }
});

test('свод блокирует все 4 позиции с неверными объёмами КП, ничего не считает молча', () => {
  const est = calcEstimate(db, UNIT_MISMATCH_POSITIONS.map((p) => ({
    base_type: p.base_type, work_code: p.code, quantity: p.qty, period_id: PERIOD,
    item_no: p.item_no, quote_unit: 'м2', market_total: 100000,
  })));
  assert.equal(est.position_count, 0, 'ничего не посчитано');
  assert.equal(est.blocked.length, 4, 'все 4 заблокированы');
  for (const b of est.blocked) assert.match(b.reason, /кратность/);
});

test('с объёмом в единицах нормы (0.91) позиция считается', () => {
  const est = calcEstimate(db, [{
    base_type: 'ГЭСНр', work_code: '63-03-001-02', quantity: 0.91, period_id: PERIOD,
    item_no: '1.2', quote_unit: 'м2', quantity_in_norm_units: true, market_total: 270270,
  }]);
  assert.equal(est.position_count, 1);
  assert.equal(est.blocked.length, 0);
  assert.ok(est.lines[0].totals.total > 0);
});

test('предохранитель: расхождение норматива и КП больше порядка — предупреждение', () => {
  // норма в правильных единицах, но КП завышен искусственно в 100 раз
  const est = calcEstimate(db, [{
    base_type: 'ГЭСН', work_code: '12-01-015-03', quantity: 1, period_id: PERIOD,
    quote_unit: '100 м2', market_total: 999999999,
  }]);
  assert.equal(est.position_count, 1);
  assert.ok(est.lines[0].magnitude_warning, 'предупреждение о порядке величины');
});

test.after(() => db.close());
