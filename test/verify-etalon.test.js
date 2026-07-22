import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { verifyEtalon } from '../src/verify/verify-etalon.js';

const db = openDb();
const { verified } = await verifyEtalon(db);

/**
 * Приёмочный критерий MVP (раздел 8 ТЗ): позиции 1.1 и 1.4 воспроизводятся
 * по слоям 1-3. Замена материала, сделанная сметчиком в эталоне (рубероид →
 * плёнка), читается из ЛСР и подаётся движку как вход.
 */
test('обе верификационные позиции разобраны из эталона', () => {
  assert.equal(verified.length, 2);
  assert.equal(verified[0].etalon.code, 'ГЭСН27-04-001-01');
  assert.equal(verified[1].etalon.code, 'ГЭСН12-01-015-03');
});

test('расхождений нет ни в одной позиции ни в одном слое', () => {
  for (const v of verified) {
    const bad = v.checks.filter((c) => c.status !== 'СОШЛОСЬ');
    assert.deepEqual(bad.map((c) => `${c.item}: эталон ${c.etalon}, движок ${c.engine}`), [],
      `позиция ${v.etalon.no}`);
  }
});

test('каждый слой реально проверен, а не пуст', () => {
  for (const v of verified) {
    for (const layer of [1, 2, 3]) {
      assert.ok(v.checks.some((c) => c.layer === layer), `позиция ${v.etalon.no}, слой ${layer}`);
    }
  }
});

test('замена материала в 1.4 распознана и учтена', () => {
  const pos = verified[1];
  const line = pos.result.lines.find((l) => l.resource_code === '12.1.02.06-0022');
  assert.equal(line.selected_code, '12.1.01.03-0033');
  assert.equal(line.quantity_total, 5634.3215);
  assert.equal(line.base_price, 86.59);
  assert.ok(line.line_cost > 0);
});

test.after(() => db.close());
