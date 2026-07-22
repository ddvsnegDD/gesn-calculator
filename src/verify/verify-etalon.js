import path from 'node:path';
import { openDb, isMain, DATA_DIR } from '../db/index.js';
import { calcPosition, nrspKey } from '../engine/calc-position.js';
import { parseEtalon } from './parse-etalon.js';

export const ETALON_FILE = path.join(
  path.dirname(DATA_DIR),
  'Монолит 2025_Москва III квартал - ЛСР по Методике 2020 (РИМ).xlsx'
);

/** Позиции ЛСР, обязательные к сверке по разделу 8 ТЗ. */
export const VERIFIED_POSITIONS = ['1.1', '1.4'];

const TOLERANCE = {
  1: 0,      // ресурсная часть — точное совпадение после округления до 6 знаков
  2: 0.01,   // базисные цены на 01.01.2022, руб
  3: 0,      // коды и проценты НР/СП
};

const r6 = (x) => (x === null || x === undefined ? null : Math.round(x * 1e6) / 1e6);
const OK = 'СОШЛОСЬ';
const DIFF = 'РАСХОЖДЕНИЕ';
const ABSENT = 'НЕТ В ДВИЖКЕ';
const EXTRA = 'НЕТ В ЭТАЛОНЕ';

function compare(layer, item, etalon, engine, note = null) {
  const tol = TOLERANCE[layer];
  let status;
  let diff = null;
  if (etalon === null || etalon === undefined) status = EXTRA;
  else if (engine === null || engine === undefined) status = ABSENT;
  else if (typeof etalon === 'number' && typeof engine === 'number') {
    diff = r6(engine - etalon);
    status = Math.abs(diff) <= tol ? OK : DIFF;
  } else {
    status = String(etalon) === String(engine) ? OK : DIFF;
  }
  return { layer, item, etalon, engine, diff, status, note };
}

/**
 * Сверка одной позиции по трём слоям, не зависящим от периода цен
 * (раздел 8 ТЗ). Текущие цены НЕ сверяются: эталон в ценах III кв. 2024,
 * загруженная сплит-форма — II кв. 2026.
 */
export function verifyPosition(db, etalon, periodId) {
  // Расход основного материала в норме задан как «П» — берём его из эталона,
  // как если бы сметчик ввёл проектное значение. Это вход, а не подгонка.
  const mainMaterials = {};
  const mainQuantities = {};
  const abstractCodes = db
    .prepare(
      `SELECT wr.resource_code FROM work_resources wr JOIN works w ON w.id = wr.work_id
       WHERE w.base_type = ? AND w.code = ? AND wr.is_abstract = 1`
    )
    .pluck()
    .all(etalon.base_type, etalon.work_code);

  for (const sub of etalon.subpositions) {
    // подпозиция относится к абстрактному ресурсу, если её код начинается с его кода
    const owner = abstractCodes.find((c) => sub.code.startsWith(c));
    if (owner) {
      mainMaterials[owner] = sub.code;
      mainQuantities[owner] = sub.per_unit;
    }
  }

  const result = calcPosition(db, {
    base_type: etalon.base_type,
    work_code: etalon.work_code,
    quantity: etalon.quantity_total,
    period_id: periodId,
    territory_type: 'Территория',
    main_materials: mainMaterials,
    main_material_quantities: mainQuantities,
    options: { norm_coefficient: etalon.coefficient ?? 1 },
  });

  const byCode = new Map(result.lines.map((l) => [l.resource_code, l]));
  const checks = [];

  // ---- слой 1: ресурсная часть -------------------------------------------
  for (const res of etalon.resources) {
    const line = byCode.get(res.code);
    const zeroed = res.total === 0 && line && line.quantity_total > 0;
    checks.push(
      compare(1, `расход ${res.code} (${res.measure_unit ?? '—'})`, res.total, line ? line.quantity_total : null,
        zeroed ? 'в эталоне расход обнулён вручную — ресурс заменён другим материалом, в норме он присутствует' : null)
    );
    if (res.driver_code && line) {
      const hours = line.labour_mach === null || line.labour_mach === undefined
        ? null
        : r6(line.quantity_total * line.labour_mach);
      checks.push(compare(1, `ОТм ${res.code} → ${res.driver_code}, чел.-ч`, res.driver_hours, hours));
      checks.push(compare(3, `код машиниста для ${res.code}`, res.driver_code, line.driver_code ?? null));
    }
  }

  // подпозиции — выбранный основной материал
  for (const sub of etalon.subpositions) {
    const owner = abstractCodes.find((c) => sub.code.startsWith(c));
    const line = owner ? byCode.get(owner) : null;
    checks.push(
      compare(1, `расход основного материала ${sub.code}`, sub.total, line ? line.quantity_total : null,
        owner ? null : 'в норме нет абстрактного ресурса с таким кодом — вероятно, замена материала в эталоне')
    );
    if (line && sub.base_price !== null) {
      checks.push(compare(2, `базисная цена ${sub.code}`, sub.base_price, line.base_price));
    }
  }

  // суммарные чел.-ч машинистов = «голый» код 2 в норме
  if (etalon.totals.drivers_hours !== undefined) {
    const bare2 = byCode.get('2');
    checks.push(compare(1, 'ОТм всего, чел.-ч («голый» код 2)', etalon.totals.drivers_hours,
      bare2 ? bare2.quantity_total : null));
  }

  // ---- слой 2: базисные цены на 01.01.2022 --------------------------------
  for (const res of etalon.resources) {
    if (res.base_price === null) continue;
    const line = byCode.get(res.code);
    checks.push(compare(2, `базисная цена ${res.code}`, res.base_price, line ? line.base_price : null));
  }

  // ---- слой 3: коды и проценты НР/СП --------------------------------------
  for (const item of etalon.nrsp) {
    const isNr = item.code.startsWith('Пр/812');
    const engineCode = isNr ? result.norms.nr_code : result.norms.sp_code;
    const enginePct = isNr ? result.totals.overhead_pct : result.totals.profit_pct;
    checks.push(compare(3, `код ${isNr ? 'НР' : 'СП'}`, nrspKey(item.code), nrspKey(engineCode),
      `эталон: ${item.code}, движок: ${engineCode}`));
    checks.push(compare(3, `процент ${isNr ? 'НР' : 'СП'} (${item.name})`, item.pct, enginePct));
  }

  return { etalon, result, checks };
}

export function formatReport(verified) {
  const out = [];
  const say = (s = '') => out.push(s);
  const LAYER_TITLE = {
    1: 'СЛОЙ 1. РЕСУРСНАЯ ЧАСТЬ — чел.-ч, маш.-ч, расходы (допуск 0)',
    2: 'СЛОЙ 2. БАЗИСНЫЕ ЦЕНЫ НА 01.01.2022 (допуск 0.01 руб)',
    3: 'СЛОЙ 3. КОДЫ И ПРОЦЕНТЫ НР/СП (точное совпадение)',
  };
  const fmt = (x) => (x === null || x === undefined ? '—' : typeof x === 'number' ? String(x) : String(x));

  let totalOk = 0;
  let totalБад = 0;

  for (const { etalon, result, checks } of verified) {
    say('═'.repeat(104));
    say(`ПОЗИЦИЯ ${etalon.no} — ${etalon.code}, объём ${etalon.quantity_total} ${etalon.measure_unit}`);
    say(`${etalon.name}`);
    say(`Эталон в ценах: ${etalon.price_level} | движок в ценах: ${result.period.quarter} кв. ${result.period.year},` +
        ` ${result.period.region} — текущие цены НЕ сверяются`);
    say();

    for (const layer of [1, 2, 3]) {
      const rows = checks.filter((c) => c.layer === layer);
      if (!rows.length) continue;
      say(LAYER_TITLE[layer]);
      const w = {
        item: Math.max(20, ...rows.map((r) => r.item.length)),
        et: Math.max(6, ...rows.map((r) => fmt(r.etalon).length)),
        en: Math.max(6, ...rows.map((r) => fmt(r.engine).length)),
        d: Math.max(4, ...rows.map((r) => fmt(r.diff).length)),
      };
      say('  ' + 'показатель'.padEnd(w.item) + '  ' + 'эталон'.padStart(w.et) + '  ' + 'движок'.padStart(w.en) +
          '  ' + 'diff'.padStart(w.d) + '  статус');
      say('  ' + '─'.repeat(w.item) + '  ' + '─'.repeat(w.et) + '  ' + '─'.repeat(w.en) + '  ' + '─'.repeat(w.d) + '  ──────');
      for (const r of rows) {
        const mark = r.status === OK ? '✅' : '❌';
        say('  ' + r.item.padEnd(w.item) + '  ' + fmt(r.etalon).padStart(w.et) + '  ' + fmt(r.engine).padStart(w.en) +
            '  ' + fmt(r.diff).padStart(w.d) + '  ' + mark + ' ' + r.status);
        if (r.note) say('      └ ' + r.note);
        if (r.status === OK) totalOk++; else totalБад++;
      }
      say();
    }
    if (result.flags.length) say(`ФЛАГИ ДВИЖКА: ${result.flags.join(', ')}`);
    say();
  }

  say('═'.repeat(104));
  say(`ИТОГО: сошлось ${totalOk}, расхождений ${totalБад}`);
  return { text: out.join('\n'), ok: totalOk, bad: totalБад };
}

export async function verifyEtalon(db, { file = ETALON_FILE, periodId } = {}) {
  const period = periodId ?? db.prepare('SELECT id FROM price_periods ORDER BY id LIMIT 1').pluck().get();
  const positions = await parseEtalon(file, VERIFIED_POSITIONS);
  const verified = VERIFIED_POSITIONS.filter((no) => positions[no]).map((no) => verifyPosition(db, positions[no], period));
  return { verified, report: formatReport(verified) };
}

if (isMain(import.meta.url)) {
  const db = openDb();
  const { report } = await verifyEtalon(db);
  console.log(report.text);
  db.close();
  process.exitCode = report.bad === 0 ? 0 : 1;
}
