/** Текстовое представление расчёта позиции — для тестов, CLI и сверки с эталоном. */

const money = (x) => (x === null || x === undefined ? '—' : x.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const qty = (x) => (x === null || x === undefined ? '—' : String(x));

const ARTICLE_TITLE = {
  'ОТ': 'Оплата труда рабочих',
  'ЭМ': 'Эксплуатация машин',
  'М': 'Материалы',
  'ОМ': 'Основной (неучтённый) материал',
  'справочно': 'Справочно',
};

export function formatPosition(result) {
  const out = [];
  const say = (s = '') => out.push(s);
  const { work, period, input, lines, totals, norms, flags } = result;

  say(`${work.base_type}${work.code}  ${work.name_full}`);
  say(`Ед. изм.: ${work.measure_unit} | объём: ${input.quantity} | сборник ${work.collection_code} «${work.collection_name}»`);
  say(`Период цен: ${period.region}, ${period.quarter} кв. ${period.year} | территория: ${input.territory_type}` +
      ` | коэффициент к норме: ${input.norm_coefficient} | НДС: ${input.vat ? '20%' : 'нет'}`);
  say();

  const head = ['Код', 'Наименование', 'Ед.', 'На ед.', 'На объём', 'Цена', 'Сумма'];
  const rows = lines.map((l) => [
    l.resource_code + (l.selected_code ? ` → ${l.selected_code}` : ''),
    (l.selected_name ?? l.name ?? '').slice(0, 46),
    l.measure_unit ?? '',
    qty(l.quantity_per_unit),
    qty(l.quantity_total),
    money(l.price),
    money(l.line_cost),
  ]);

  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells, pad = ' ') =>
    cells.map((c, i) => (i <= 2 ? String(c).padEnd(widths[i], pad) : String(c).padStart(widths[i], pad))).join('  ');

  say(line(head));
  say(widths.map((w) => '─'.repeat(w)).join('  '));
  let lastArticle = null;
  lines.forEach((l, i) => {
    if (l.article !== lastArticle) {
      say(`· ${ARTICLE_TITLE[l.article] ?? l.article}`);
      lastArticle = l.article;
    }
    say(line(rows[i]));
    if (l.machine_price !== undefined && l.machine_price !== null) {
      say(`    └ цена маш.-ч: ${money(l.machine_price)} без з/п + ${money(l.salary_part)} з/п машиниста = ${money(l.price)}`);
    }
    if (l.driver_code) {
      say(`    └ ОТм: тариф ${l.driver_code} ${money(l.driver_rate)} руб/чел.-ч × ${l.labour_mach} чел.-ч на маш.-ч` +
          ` = ${money(l.salary_part)} руб/маш.-ч; на ${qty(l.quantity_total)} маш.-ч = ${money(l.drivers_salary)} руб`);
    }
    if (l.base_price !== null && l.index_value !== null) {
      // у машин индексируется цена БЕЗ з/п машиниста, её и показываем
      const indexed = l.machine_price ?? l.price ?? l.base_price * l.index_value;
      say(`    └ базисная ${money(l.base_price)} × индекс ${l.index_value} = ${money(indexed)}`);
    } else if (l.base_price !== null && l.price !== null) {
      say(`    └ базисная ${money(l.base_price)} на 01.01.2022; текущая цена задана в сплит-форме напрямую`);
    }
    if (l.note) say(`    └ ${l.note}`);
  });

  say();
  say('ИТОГИ');
  const t = [
    ['Оплата труда рабочих (ОТ)', totals.labor],
    ['Эксплуатация машин (ЭМ), в т.ч. з/п машинистов', totals.machines],
    ['  в том числе ОТм', totals.drivers_salary],
    ['Материалы (М)', totals.materials],
    ['Основной материал', totals.main_materials],
    ['ПРЯМЫЕ ЗАТРАТЫ (ПЗ)', totals.direct_costs],
    ['ФОТ (ОТ + ОТм)', totals.fot],
    [`Накладные расходы (${totals.overhead_pct ?? '—'}% от ФОТ)`, totals.overhead],
    [`Сметная прибыль (${totals.profit_pct ?? '—'}% от ФОТ)`, totals.profit],
    ['ИТОГО без НДС', totals.total_without_vat],
  ];
  if (input.vat) t.push(['НДС 20%', totals.vat]);
  t.push(['ВСЕГО ПО ПОЗИЦИИ', totals.total]);
  t.push([`  на единицу нормы (${work.measure_unit})`, totals.per_norm_unit]);
  const labelW = Math.max(...t.map(([l]) => l.length));
  for (const [label, value] of t) say(`  ${label.padEnd(labelW)}  ${money(value).padStart(14)}`);

  say();
  say('КОДЫ ДЛЯ ГРАНД-СМЕТЫ');
  say(`  расценка: ${work.base_type}${work.code}`);
  const materialCodes = lines.filter((l) => l.selected_code || (l.article === 'М' && l.line_cost !== null))
    .map((l) => l.selected_code ?? l.resource_code);
  if (materialCodes.length) say(`  материалы: ${materialCodes.join(', ')}`);
  say(`  НР: ${norms.nr_code}${norms.nr_item_no ? ` (п. ${norms.nr_item_no}, ${norms.work_type_name})` : ''}`);
  say(`  СП: ${norms.sp_code}${norms.sp_item_no ? ` (п. ${norms.sp_item_no})` : ''}`);
  if (norms.ambiguous) {
    say(`  ⚠ норма допускает несколько видов работ: ${norms.options.map((o) => o.nr_code).join(', ')}`);
  }
  if (flags.length) {
    say();
    say(`ФЛАГИ: ${flags.join(', ')}`);
  }
  return out.join('\n');
}
