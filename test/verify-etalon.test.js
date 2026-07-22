import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { verifyEtalon } from '../src/verify/verify-etalon.js';

const db = openDb();
const { verified } = await verifyEtalon(db);

/**
 * Приёмочный критерий MVP (раздел 8 ТЗ): позиции 1.1 и 1.4 воспроизводятся
 * по слоям 1-3. Известные расхождения — только замена материала, сделанная
 * сметчиком вручную в самом эталоне (рубероид обнулён и заменён плёнкой).
 */
const SUBSTITUTED = ['12.1.02.06-0022', '12.1.01.03-0033'];

test('обе верификационные позиции разобраны из эталона', () => {
  assert.equal(verified.length, 2);
  assert.equal(verified[0].etalon.code, 'ГЭСН27-04-001-01');
  assert.equal(verified[1].etalon.code, 'ГЭСН12-01-015-03');
});

test('позиция 1.1 сходится полностью по всем трём слоям', () => {
  const bad = verified[0].checks.filter((c) => c.status !== 'СОШЛОСЬ');
  assert.deepEqual(bad.map((c) => c.item), []);
});

test('слой 2 (базисные цены) и слой 3 (НР/СП) сходятся в обеих позициях', () => {
  for (const v of verified) {
    const bad = v.checks.filter((c) => c.layer !== 1 && c.status !== 'СОШЛОСЬ');
    assert.deepEqual(bad.map((c) => c.item), [], `позиция ${v.etalon.no}`);
  }
});

test('в слое 1 расходятся только вручную заменённые материалы', () => {
  for (const v of verified) {
    const bad = v.checks.filter((c) => c.layer === 1 && c.status !== 'СОШЛОСЬ');
    for (const c of bad) {
      assert.ok(
        SUBSTITUTED.some((code) => c.item.includes(code)),
        `неожиданное расхождение слоя 1 в позиции ${v.etalon.no}: ${c.item}`
      );
    }
  }
});

test.after(() => db.close());
