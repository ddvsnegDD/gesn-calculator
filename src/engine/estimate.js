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
  const blocked = [];     // разные базовые единицы — нужна геометрия, не считаем
  const autoConverted = []; // пересчитано по кратности — считаем, но выносим на подтверждение
  let hasMarket = false;

  for (const pos of positions) {
    try {
      const result = calcPosition(db, pos);
      const t = result.totals;
      const uc = result.unit_check;

      // Блокируем только когда базовые единицы разные (шт/отверстий, м.п./м²) —
      // пересчёт требует геометрии от человека. Кратность (м²/100 м²) движок
      // пересчитал сам, такую позицию считаем, но помечаем для подтверждения.
      if (uc && uc.kind === 'base') {
        blocked.push({
          item_no: pos.item_no ?? null,
          code: `${result.work.base_type}${result.work.code}`,
          quote_unit: uc.baseQuote ?? pos.quote_unit,
          norm_unit: result.work.measure_unit,
          reason: uc.reason,
        });
        continue;
      }
      if (uc && uc.auto_converted) {
        autoConverted.push({
          item_no: pos.item_no ?? null,
          code: `${result.work.base_type}${result.work.code}`,
          quote_unit: pos.quote_unit,
          norm_unit: result.work.measure_unit,
          ratio: uc.ratio,
          from: uc.original_quantity,
          to: uc.converted_quantity,
        });
      }

      // Предохранитель: норматив расходится с ценой КП больше чем на порядок —
      // почти всегда это ошибка единиц, а не реальное сравнение.
      let magnitudeWarning = null;
      if (pos.market_total != null && t.total > 0) {
        const ratio = pos.market_total / t.total;
        if (ratio > 10 || ratio < 0.1) {
          magnitudeWarning = `норматив и цена КП расходятся в ${(ratio >= 1 ? ratio : 1 / ratio).toFixed(0)} раз — вероятна ошибка единиц`;
        }
      }

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
        magnitude_warning: magnitudeWarning,
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

  return { lines, totals, market, errors, blocked, auto_converted: autoConverted, position_count: lines.length };
}
