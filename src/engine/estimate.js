import { calcPosition } from './calc-position.js';

/**
 * Многопозиционная смета (раздел 6 ТЗ этапа 5): контейнер над движком
 * расчёта одной позиции. Массив подтверждённых позиций → расчёт каждой
 * существующим calc-position → свод по статьям и итог.
 *
 * Сохранения между сессиями нет (v2) — смета живёт в памяти/в экспорте.
 */

const r2 = (x) => (x === null || x === undefined ? null : Math.round(x * 100) / 100);

/**
 * @param db
 * @param positions — массив входов calcPosition (base_type, work_code,
 *   quantity, period_id, ... плюс необязательные метаданные: item_no, name,
 *   market_total для сравнения с КП).
 */
export function calcEstimate(db, positions) {
  const lines = [];
  const totals = {
    labor: 0, machines: 0, drivers_salary: 0, materials: 0, main_materials: 0,
    direct_costs: 0, fot: 0, overhead: 0, profit: 0, total_without_vat: 0, vat: 0, total: 0,
    market_total: 0,
  };
  const errors = [];
  let hasMarket = false;

  for (const pos of positions) {
    try {
      const result = calcPosition(db, pos);
      const t = result.totals;
      lines.push({
        item_no: pos.item_no ?? null,
        vedomost_name: pos.name ?? null,
        base_type: result.work.base_type,
        code: result.work.code,
        name: result.work.name_full,
        measure_unit: result.work.measure_unit,
        quantity: result.input.quantity,
        totals: t,
        market_total: pos.market_total ?? null,
        flags: result.flags,
        nr_code: result.norms.nr_code,
        sp_code: result.norms.sp_code,
      });
      for (const k of ['labor', 'machines', 'drivers_salary', 'materials', 'main_materials',
        'direct_costs', 'fot', 'overhead', 'profit', 'total_without_vat', 'vat', 'total']) {
        totals[k] += t[k] ?? 0;
      }
      if (pos.market_total != null) { totals.market_total += pos.market_total; hasMarket = true; }
    } catch (err) {
      errors.push({ item_no: pos.item_no ?? null, code: pos.work_code, error: err.message });
    }
  }

  for (const k of Object.keys(totals)) totals[k] = r2(totals[k]);

  const market = hasMarket
    ? {
        market_total: totals.market_total,
        normative_total: totals.total,
        delta_rub: r2(totals.market_total - totals.total),
        delta_pct: totals.total ? r2(((totals.market_total - totals.total) / totals.total) * 100) : null,
      }
    : null;

  return { lines, totals, market, errors, position_count: lines.length };
}
