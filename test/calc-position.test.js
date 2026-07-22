import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { calcPosition, nrspKey, currentPrice, FLAGS } from '../src/engine/calc-position.js';
import { formatPosition } from '../src/engine/format.js';

const db = openDb();
const PERIOD = db.prepare('SELECT id FROM price_periods ORDER BY id LIMIT 1').pluck().get();

/** Расход из эталонной ЛСР «Монолит 2025» — слой 1 сверки (раздел 8 ТЗ). */
const ETALON = {
  '27-04-001-01': {
    volume: 4.5131,
    // код → расход на объём
    quantities: {
      '1-100-23': 64.98864,
      '2': 62.641828 / 13.88 * 13.88, // ОТм по эталону, см. отдельную проверку
      '91.01.02-004': 7.988187,
      '91.06.05-011': 19.361199,
      '91.08.03-030': 31.952748,
      '91.13.01-038': 3.339694,
      '01.7.03.01-0001': 22.5655,
    },
    driversHours: 62.641828,
    basePrices: { '91.01.02-004': 1933, '91.08.03-030': 2391.6, '91.13.01-038': 1043.14, '01.7.03.01-0001': 35.71 },
    mainMaterial: { abstract: '02.3.01.02', code: '02.3.01.02-1118', quantity: 110, total: 496.441, base: 565.2 },
    nr: { code: 'Пр/812-021.0', pct: 147 },
    sp: { code: 'Пр/774-021.0', pct: 134 },
  },
  '12-01-015-03': {
    volume: 48.9941,
    quantities: {
      '1-100-32': 340.019054,
      '91.05.01-017': 3.919528,
      '91.05.05-015': 2.449705,
      '91.08.04-021': 20.087581,
      '91.14.02-001': 3.919528,
      '01.2.03.03': 2.449705,
    },
    driversHours: 10.288761,
    basePrices: { '91.08.04-021': 95.25, '12.1.02.06-0022': 43.73 },
    nr: { code: 'Пр/812-012.0', pct: 109 },
    sp: { code: 'Пр/774-012.0', pct: 57 },
  },
};

const lineOf = (res, code) => res.lines.find((l) => l.resource_code === code);
const round6 = (x) => Math.round(x * 1e6) / 1e6;

test('nrspKey отбрасывает префикс приказа и суффикс Гранд-Сметы', () => {
  assert.equal(nrspKey('Пр/812-021.0'), '21.0');
  assert.equal(nrspKey('Пр/812-021.0-1'), '21.0');   // формат из выгрузки Гранд-Сметы
  assert.equal(nrspKey('Пр/774-012.0'), '12.0');
  assert.equal(nrspKey('Пр/812-104.1'), '104.1');
  assert.equal(nrspKey(null), null);
});

test('currentPrice: прямая цена приоритетнее индекса, иначе базисная × индекс', () => {
  assert.equal(currentPrice({ current_price: 100, base_price: 50, index_value: 1.5 }).price, 100);
  assert.equal(currentPrice({ current_price: null, base_price: 50, index_value: 1.5 }).price, 75);
  assert.equal(currentPrice({ current_price: null, base_price: 50, index_value: null }).price, null);
  assert.equal(currentPrice(null).price, null);
});

test('ГЭСН27-04-001-01 на объём 4.5131 — ресурсная часть, базисные цены, НР/СП', () => {
  const e = ETALON['27-04-001-01'];
  const res = calcPosition(db, {
    base_type: 'ГЭСН',
    work_code: '27-04-001-01',
    quantity: e.volume,
    period_id: PERIOD,
    territory_type: 'Территория',
    main_materials: { [e.mainMaterial.abstract]: e.mainMaterial.code },
    main_material_quantities: { [e.mainMaterial.abstract]: e.mainMaterial.quantity },
  });
  console.log('\n' + formatPosition(res) + '\n');

  // слой 1 — расходы, допуск 0 после округления до 6 знаков
  for (const [code, expected] of Object.entries(e.quantities)) {
    if (code === '2') continue; // проверяется отдельно как ОТм
    assert.equal(lineOf(res, code).quantity_total, round6(expected), `расход ${code}`);
  }
  assert.equal(lineOf(res, '2').quantity_total, e.driversHours, 'чел.-ч машинистов («голый» код 2)');

  // основной материал: выбранный код, расход и базисная цена
  const main = lineOf(res, e.mainMaterial.abstract);
  assert.equal(main.selected_code, e.mainMaterial.code);
  assert.equal(main.quantity_total, round6(e.mainMaterial.total));
  assert.equal(main.base_price, e.mainMaterial.base);

  // слой 2 — базисные цены на 01.01.2022, допуск 0.01 руб
  for (const [code, base] of Object.entries(e.basePrices)) {
    assert.ok(Math.abs(lineOf(res, code).base_price - base) <= 0.01, `базисная цена ${code}`);
  }

  // слой 3 — коды и проценты НР/СП
  assert.equal(res.norms.nr_code, e.nr.code);
  assert.equal(res.norms.sp_code, e.sp.code);
  assert.equal(res.totals.overhead_pct, e.nr.pct);
  assert.equal(res.totals.profit_pct, e.sp.pct);

  // структурные инварианты
  assert.equal(res.totals.fot, round2(res.totals.labor + res.totals.drivers_salary));
  assert.equal(res.totals.overhead, round2((res.totals.fot * e.nr.pct) / 100));
  assert.equal(res.totals.profit, round2((res.totals.fot * e.sp.pct) / 100));
  assert.deepEqual(res.flags, []);
});

test('ГЭСН12-01-015-03 на объём 48.9941 — ресурсная часть, базисные цены, НР/СП', () => {
  const e = ETALON['12-01-015-03'];
  const res = calcPosition(db, {
    base_type: 'ГЭСН',
    work_code: '12-01-015-03',
    quantity: e.volume,
    period_id: PERIOD,
    territory_type: 'Территория',
  });
  console.log('\n' + formatPosition(res) + '\n');

  for (const [code, expected] of Object.entries(e.quantities)) {
    assert.equal(lineOf(res, code).quantity_total, round6(expected), `расход ${code}`);
  }
  assert.equal(lineOf(res, '2').quantity_total, e.driversHours, 'чел.-ч машинистов');
  for (const [code, base] of Object.entries(e.basePrices)) {
    assert.ok(Math.abs(lineOf(res, code).base_price - base) <= 0.01, `базисная цена ${code}`);
  }
  assert.equal(res.norms.nr_code, e.nr.code);
  assert.equal(res.totals.overhead_pct, e.nr.pct);
  assert.equal(res.totals.profit_pct, e.sp.pct);

  // основной материал не выбран — считаем без него, но с явным флагом
  assert.ok(res.flags.includes(FLAGS.MAIN_MATERIAL_NOT_SELECTED));
  assert.equal(res.totals.main_materials, 0);
  assert.equal(lineOf(res, '01.2.03.03').line_cost, null);
});

test('«голый» код 2 не тарифицируется повторно, но остаётся справочной строкой', () => {
  const res = calcPosition(db, {
    base_type: 'ГЭСН', work_code: '12-01-015-03', quantity: 1, period_id: PERIOD,
  });
  const l = lineOf(res, '2');
  assert.equal(l.line_cost, 0, 'з/п машинистов уже в цене маш.-часа');
  assert.equal(l.article, 'справочно');
  assert.equal(l.quantity_total, 0.21);
  // при этом ФОТ машинистов не нулевой — он приходит из строк машин
  assert.ok(res.totals.drivers_salary > 0);
});

test('з/п машиниста = тариф(DriverCode) × LabourMach × маш.-ч и входит в ФОТ', () => {
  const res = calcPosition(db, {
    base_type: 'ГЭСН', work_code: '12-01-015-03', quantity: 1, period_id: PERIOD,
  });
  const crane = lineOf(res, '91.05.01-017');
  const machine = db.prepare('SELECT * FROM machines WHERE code = ?').get('91.05.01-017');
  const rate = db.prepare('SELECT rate_per_hour FROM labor_tariff_rates WHERE period_id=? AND resource_code=?')
    .pluck().get(PERIOD, machine.driver_code);

  assert.equal(crane.driver_code, machine.driver_code);
  assert.equal(crane.salary_part, round6(rate * machine.labour_mach));
  assert.equal(crane.price, round6(crane.machine_price + crane.salary_part));
  assert.equal(crane.drivers_salary, round2(crane.quantity_total * crane.salary_part));

  // котёл битумный: LabourMach = 0, машиниста нет — з/п не начисляется
  const boiler = lineOf(res, '91.08.04-021');
  assert.equal(boiler.drivers_salary, 0);

  const sum = res.lines.filter((l) => l.article === 'ЭМ').reduce((s, l) => s + (l.drivers_salary ?? 0), 0);
  assert.equal(res.totals.drivers_salary, round2(sum));
  assert.equal(res.totals.fot, round2(res.totals.labor + res.totals.drivers_salary));
});

test('кран башенный в 12-01-015-03: цена маш.-ч и ОТм до копейки', () => {
  // Числа зафиксированы после ручной проверки по сплит-форме 2 кв. 2026:
  // тариф 4-100-060 = 982,04 руб/чел.-ч ровно, LabourMach = 1,
  // цена маш.-ч без з/п = 1 036,96 (в сплит-форме задана напрямую, индекса нет).
  const res = calcPosition(db, {
    base_type: 'ГЭСН', work_code: '12-01-015-03', quantity: 48.9941, period_id: PERIOD,
  });
  const crane = lineOf(res, '91.05.01-017');
  assert.equal(crane.driver_code, '4-100-060');
  assert.equal(crane.driver_rate, 982.04);
  assert.equal(crane.labour_mach, 1);
  assert.equal(crane.machine_price, 1036.96);
  assert.equal(crane.salary_part, 982.04);
  assert.equal(crane.price, 2019);
  assert.equal(crane.quantity_total, 3.919528);
  assert.equal(crane.line_cost, 7913.53);
  assert.equal(crane.drivers_salary, 3849.13);

  // сумма ОТм по всем машинам совпадает с агрегатом
  assert.equal(lineOf(res, '91.05.05-015').drivers_salary, 2405.71);
  assert.equal(lineOf(res, '91.14.02-001').drivers_salary, 2865.49);
  assert.equal(res.totals.drivers_salary, 9120.33);
});

test('«голый» код 1 не тарифицируется молча: line_cost = null и флаг', () => {
  const res = calcPosition(db, {
    base_type: 'ГЭСН', work_code: '01-01-129-11', quantity: 1, period_id: PERIOD,
  });
  const l = lineOf(res, '1');
  assert.equal(l.line_cost, null);
  assert.ok(res.flags.includes(FLAGS.NEEDS_TARIFF));
});

test('расход «П» без ввода пользователя не превращается в ноль', () => {
  const res = calcPosition(db, {
    base_type: 'ГЭСН', work_code: '27-04-001-01', quantity: 1, period_id: PERIOD,
    main_materials: { '02.3.01.02': '02.3.01.02-1118' },
  });
  const sand = lineOf(res, '02.3.01.02');
  assert.equal(sand.quantity_total, null);
  assert.equal(sand.line_cost, null);
  assert.ok(res.flags.includes(FLAGS.QUANTITY_BY_PROJECT));
});

test('несколько ReasonItem — норматив не подставляется молча', () => {
  const res = calcPosition(db, {
    base_type: 'ГЭСН', work_code: '27-02-010-01', quantity: 1, period_id: PERIOD,
  });
  assert.ok(res.flags.includes(FLAGS.NRSP_AMBIGUOUS));
  assert.ok(res.norms.options.length > 1);

  // явный выбор снимает флаг и меняет проценты
  const chosen = calcPosition(db, {
    base_type: 'ГЭСН', work_code: '27-02-010-01', quantity: 1, period_id: PERIOD,
    options: { nr_code: 'Пр/812-021.1', sp_code: 'Пр/774-021.1' },
  });
  assert.ok(!chosen.flags.includes(FLAGS.NRSP_AMBIGUOUS));
  assert.equal(chosen.norms.nr_code, 'Пр/812-021.1');
});

test('коэффициент к норме умножает расходы, НДС — итог', () => {
  const base = calcPosition(db, {
    base_type: 'ГЭСН', work_code: '12-01-015-03', quantity: 1, period_id: PERIOD,
  });
  const doubled = calcPosition(db, {
    base_type: 'ГЭСН', work_code: '12-01-015-03', quantity: 1, period_id: PERIOD,
    options: { norm_coefficient: 2 },
  });
  assert.equal(doubled.lines[0].quantity_total, round6(base.lines[0].quantity_total * 2));
  // суммы округляются построчно до копейки, поэтому удвоение расходов даёт ×2
  // с точностью до копейки на строку — так же считает и Гранд-Смета
  const lineCount = base.lines.filter((l) => l.line_cost !== null).length;
  assert.ok(
    Math.abs(doubled.totals.direct_costs - base.totals.direct_costs * 2) <= 0.01 * lineCount,
    `ПЗ при коэффициенте 2: ${doubled.totals.direct_costs} против ${base.totals.direct_costs * 2}`
  );

  const withVat = calcPosition(db, {
    base_type: 'ГЭСН', work_code: '12-01-015-03', quantity: 1, period_id: PERIOD,
    options: { vat: true },
  });
  assert.equal(withVat.totals.vat, round2(withVat.totals.total_without_vat * 0.2));
  assert.equal(withVat.totals.total, round2(withVat.totals.total_without_vat * 1.2));
});

test('территория влияет только на НР', () => {
  const mk = (territory_type) => calcPosition(db, {
    base_type: 'ГЭСН', work_code: '12-01-015-03', quantity: 1, period_id: PERIOD, territory_type,
  });
  const t = mk('Территория');
  const rks = mk('РКС');
  assert.equal(t.totals.direct_costs, rks.totals.direct_costs);
  assert.equal(t.totals.profit, rks.totals.profit);
  assert.ok(rks.totals.overhead_pct > t.totals.overhead_pct);
});

test('неизвестная норма и неизвестный период дают внятную ошибку', () => {
  assert.throws(() => calcPosition(db, { base_type: 'ГЭСН', work_code: 'нет-такой', quantity: 1, period_id: PERIOD }),
    /Норма не найдена/);
  assert.throws(() => calcPosition(db, { base_type: 'ГЭСН', work_code: '12-01-015-03', quantity: 1, period_id: 999 }),
    /Период не найден/);
});

function round2(x) {
  return Math.round(x * 100) / 100;
}

test.after(() => db.close());

test('замена материала: код, расход и цена берутся из замены', () => {
  const plain = calcPosition(db, {
    base_type: 'ГЭСН', work_code: '12-01-015-03', quantity: 1, period_id: PERIOD,
  });
  const swapped = calcPosition(db, {
    base_type: 'ГЭСН', work_code: '12-01-015-03', quantity: 1, period_id: PERIOD,
    material_substitutions: { '12.1.02.06-0022': { code: '12.1.01.03-0033', quantity: 115 } },
  });
  const before = lineOf(plain, '12.1.02.06-0022');
  const after = lineOf(swapped, '12.1.02.06-0022');

  assert.equal(before.selected_code, undefined);
  assert.equal(after.selected_code, '12.1.01.03-0033');
  assert.equal(after.quantity_total, 115);
  assert.notEqual(after.base_price, before.base_price);
  assert.equal(after.line_cost, round2(after.quantity_total * after.price));

  // без указания расхода сохраняется нормативный
  const keepQty = calcPosition(db, {
    base_type: 'ГЭСН', work_code: '12-01-015-03', quantity: 1, period_id: PERIOD,
    material_substitutions: { '12.1.02.06-0022': { code: '12.1.01.03-0033' } },
  });
  assert.equal(lineOf(keepQty, '12.1.02.06-0022').quantity_total, before.quantity_total);

  // расход 0 исключает материал из расчёта
  const dropped = calcPosition(db, {
    base_type: 'ГЭСН', work_code: '12-01-015-03', quantity: 1, period_id: PERIOD,
    material_substitutions: { '12.1.02.06-0022': { code: '12.1.01.03-0033', quantity: 0 } },
  });
  assert.equal(lineOf(dropped, '12.1.02.06-0022').line_cost, 0);
});

test('заменять труд и машины нельзя', () => {
  assert.throws(() => calcPosition(db, {
    base_type: 'ГЭСН', work_code: '12-01-015-03', quantity: 1, period_id: PERIOD,
    material_substitutions: { '91.05.01-017': { code: '12.1.01.03-0033' } },
  }), /Заменять можно только материалы/);
});
