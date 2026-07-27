import { calcPosition, VAT_RATE } from './calc-position.js';

/**
 * Многопозиционная смета (раздел 6 ТЗ этапа 5): контейнер над движком
 * расчёта одной позиции. Массив подтверждённых позиций → расчёт каждой
 * существующим calc-position → свод по статьям и итог.
 *
 * НДС: позиции считаются в ценах БЕЗ НДС (ФГИС ЦС публикует цены без НДС,
 * тариф труда — зарплата, НДС не облагается). НДС по ставке VAT_RATE (22%)
 * начисляется ОДИН раз на итог сметы отдельной строкой при options.vat —
 * в цены не зашит, двойного счёта нет.
 *
 * Сохранения между сессиями нет (v2) — смета живёт в памяти/в экспорте.
 */

const r2 = (x) => (x === null || x === undefined ? null : Math.round(x * 100) / 100);

/**
 * @param db
 * @param positions — массив входов calcPosition (base_type, work_code,
 *   quantity, period_id, ... плюс необязательные метаданные: item_no, name,
 *   market_total для сравнения с КП).
 * @param options.vat — начислить НДС 22% на итог сметы (по умолчанию нет).
 */
export function calcEstimate(db, positions, options = {}) {
  const applyVat = Boolean(options.vat);
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
      // позиции считаем строго без НДС — НДС начисляется на итог свода
      const result = calcPosition(db, { ...pos, options: { ...(pos.options ?? {}), vat: false } });
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
      // Мягче: норматив заметно ВЫШЕ КП — в контексте проверки сметы это
      // аномалия (обычно КП ≥ норматива), сигнал к переподбору нормы. Расчёт
      // не трогаем — это вопрос подбора, не арифметики.
      let magnitudeWarning = null;
      let rematchHint = null;
      if (pos.market_total != null && t.total > 0) {
        const kpToNorm = pos.market_total / t.total;
        if (kpToNorm > 10 || kpToNorm < 0.1) {
          magnitudeWarning = `норматив и цена КП расходятся в ${(kpToNorm >= 1 ? kpToNorm : 1 / kpToNorm).toFixed(0)} раз — вероятна ошибка единиц`;
        } else if (t.total > pos.market_total * 1.5) {
          rematchHint = `норматив в ${(t.total / pos.market_total).toFixed(1)} раза выше КП — проверьте подбор нормы (возможно, подобрана более трудоёмкая работа)`;
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
        rematch_hint: rematchHint,
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

  // НДС начисляется на итог сметы отдельной строкой (позиции — без НДС).
  // total_without_vat — сумма позиций без НДС; total — с НДС, если включён.
  totals.total_without_vat = totals.total;   // позиции считались без НДС
  totals.vat = applyVat ? r2(totals.total_without_vat * VAT_RATE) : 0;
  totals.total = r2(totals.total_without_vat + totals.vat);

  // Сравнение с КП ведём БЕЗ НДС (норматив без НДС vs цена КП): like-for-like.
  const market = hasMarket
    ? {
        market_total: totals.market_total,
        normative_total: totals.total_without_vat,
        delta_rub: r2(totals.market_total - totals.total_without_vat),
        delta_pct: totals.total_without_vat ? r2(((totals.market_total - totals.total_without_vat) / totals.total_without_vat) * 100) : null,
      }
    : null;

  return {
    lines, totals, market, errors, blocked, auto_converted: autoConverted,
    position_count: lines.length,
    vat_applied: applyVat, vat_rate: VAT_RATE, prices_include_vat: false,
  };
}
