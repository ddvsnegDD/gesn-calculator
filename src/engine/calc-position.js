/**
 * Расчёт одной позиции сметы — раздел 5 ТЗ.
 *
 * Функция чистая относительно БД: все обращения к справочникам идут через
 * подготовленные запросы, ничего не кэшируется между вызовами, состояние не
 * хранится. Всё, чего нет в данных, отдаётся флагом, а не подставляется
 * значением по умолчанию.
 */

import { compareUnits } from './units.js';

/** Территория → колонка норматива НР в work_type_norms. */
const TERRITORY_COLUMN = {
  'Территория': 'overhead_territory_pct',
  'МПРКС': 'overhead_mprks_pct',
  'РКС': 'overhead_rks_pct',
};

export const FLAGS = {
  NEEDS_TARIFF: 'требует_уточнения_тарифа',
  MAIN_MATERIAL_NOT_SELECTED: 'основной_материал_не_выбран',
  QUANTITY_BY_PROJECT: 'расход_по_проекту_не_задан',
  NRSP_AMBIGUOUS: 'требует_выбора_норматива',
  NRSP_MISSING: 'норматив_не_найден',
  PRICE_MISSING: 'цена_не_найдена',
  UNIT_MISMATCH: 'единицы_измерения_не_совпадают',
  POSITION_UNIT_MISMATCH: 'единицы_позиции_не_совпадают',
};

/** Округление до 6 знаков — снимает артефакты двоичной арифметики. */
const r6 = (x) => (x === null || x === undefined ? null : Math.round(x * 1e6) / 1e6);
/** Денежное округление до копейки. */
const r2 = (x) => (x === null || x === undefined ? null : Math.round(x * 100) / 100);

/**
 * Текущая цена ресурса по сплит-форме (формула из 4.4 ТЗ):
 * готовая цена из колонки 8, иначе базисная × индекс группы ГОСР.
 * Если ни того, ни другого — null, ресурс уйдёт с флагом «цена не найдена».
 */
export function currentPrice(row) {
  if (!row) return { price: null, basis: null, index: null, source: 'нет в сплит-форме' };
  if (row.current_price !== null && row.current_price !== undefined) {
    return { price: row.current_price, basis: row.base_price ?? null, index: null, source: 'прямая цена' };
  }
  if (row.base_price !== null && row.index_value !== null &&
      row.base_price !== undefined && row.index_value !== undefined) {
    return {
      price: r6(row.base_price * row.index_value),
      basis: row.base_price,
      index: row.index_value,
      source: 'базисная × индекс',
    };
  }
  return { price: null, basis: row.base_price ?? null, index: row.index_value ?? null, source: 'цена не вычислима' };
}

function prepare(db) {
  return {
    work: db.prepare('SELECT * FROM works WHERE base_type = ? AND code = ?'),
    resources: db.prepare('SELECT * FROM work_resources WHERE work_id = ? ORDER BY id'),
    nrspItems: db.prepare('SELECT * FROM work_nrsp_items WHERE work_id = ? ORDER BY ord'),
    price: db.prepare('SELECT * FROM price_period_resources WHERE period_id = ? AND resource_code = ?'),
    tariff: db.prepare('SELECT * FROM labor_tariff_rates WHERE period_id = ? AND resource_code = ?'),
    machine: db.prepare('SELECT * FROM machines WHERE code = ?'),
    material: db.prepare('SELECT * FROM materials WHERE code = ?'),
    norm: db.prepare('SELECT * FROM work_type_norms WHERE match_key = ?'),
    period: db.prepare('SELECT * FROM price_periods WHERE id = ?'),
  };
}

/** 'Пр/812-021.0' → '21.0'; суффикс Гранд-Сметы ('-1') отбрасывается. */
export function nrspKey(code) {
  if (!code) return null;
  const m = String(code).match(/^Пр\/(?:812|774)-(\d+)\.(\d+)/);
  if (!m) return null;
  return `${Number(m[1])}.${m[2]}`;
}

/**
 * Расчёт позиции.
 *
 * @param {Database} db
 * @param {object} input
 *   base_type, work_code, quantity — что и в каком объёме считаем;
 *   period_id — период сплит-формы (расчёт всегда привязан к периоду);
 *   territory_type — 'Территория' | 'МПРКС' | 'РКС', влияет только на НР;
 *   main_materials — { abstract_code: fsbc_code } выбор основных материалов;
 *   main_material_quantities — { abstract_code: расход } для ресурсов с «П»;
 *   resource_quantities — { resource_code: расход } для обычных ресурсов с «П»;
 *   material_substitutions — { код_из_нормы: { code, quantity? } } замена учтённого
 *     материала на другой (обычная операция сметчика: норма несёт рубероид, а по
 *     проекту кладётся плёнка). Расход по умолчанию сохраняется нормативный;
 *     quantity: 0 просто исключает материал из расчёта;
 *   options.vat — начислить НДС 20% на итог;
 *   options.norm_coefficient — множитель к расходам всех ресурсов нормы;
 *   options.nr_code / options.sp_code — выбор норматива, если вариантов несколько.
 */
export function calcPosition(db, input) {
  const q = prepare(db);
  const {
    base_type,
    work_code,
    quantity,
    period_id,
    territory_type = 'Территория',
    main_materials = {},
    main_material_quantities = {},
    resource_quantities = {},
    material_substitutions = {},
    quote_unit,             // единица из КП/ведомости — для детерминированной сверки
    quantity_in_norm_units, // true, если объём уже задан в единицах нормы (сверку снимаем)
    options = {},
  } = input;

  const volume = Number(quantity);
  if (!Number.isFinite(volume)) throw new Error(`Некорректный объём: ${quantity}`);
  const kNorm = options.norm_coefficient === undefined || options.norm_coefficient === null
    ? 1
    : Number(options.norm_coefficient);
  if (!Number.isFinite(kNorm)) throw new Error(`Некорректный коэффициент к норме: ${options.norm_coefficient}`);

  const work = q.work.get(base_type, work_code);
  if (!work) throw new Error(`Норма не найдена: ${base_type} ${work_code}`);
  const period = q.period.get(period_id);
  if (!period) throw new Error(`Период не найден: id=${period_id}`);

  const territoryColumn = TERRITORY_COLUMN[territory_type];
  if (!territoryColumn) throw new Error(`Неизвестный тип территории: ${territory_type}`);

  const flags = new Set();

  // --- детерминированная сверка единицы позиции (задача 1 доработок) --------
  // Единицу из КП сверяем с единицей нормы В КОДЕ, не полагаясь на модель.
  // При расхождении (в т.ч. кратности «м²»/«100 м²») ставим флаг: объём должен
  // быть введён в единицах нормы, иначе позиция завышена/занижена в N раз.
  let unitCheck = null;
  if (quote_unit && !quantity_in_norm_units) {
    unitCheck = compareUnits(quote_unit, work.measure_unit);
    if (unitCheck.match === false) flags.add(FLAGS.POSITION_UNIT_MISMATCH);
  }
  const lines = [];
  let fotWorkers = 0;
  let fotDrivers = 0;
  const totals = { labor: 0, machines: 0, driversSalary: 0, materials: 0, mainMaterials: 0 };

  for (const res of q.resources.all(work.id)) {
    const line = buildLine(q, res, {
      volume,
      kNorm,
      period_id,
      main_materials,
      main_material_quantities,
      resource_quantities,
      material_substitutions,
      flags,
    });
    lines.push(line);

    if (line.line_cost !== null) {
      if (line.article === 'ОТ') { totals.labor += line.line_cost; fotWorkers += line.line_cost; }
      else if (line.article === 'ЭМ') {
        totals.machines += line.line_cost;
        totals.driversSalary += line.drivers_salary ?? 0;
        fotDrivers += line.drivers_salary ?? 0;
      } else if (line.article === 'М') totals.materials += line.line_cost;
      else if (line.article === 'ОМ') totals.mainMaterials += line.line_cost;
    }
  }

  // --- НР и СП: норматив по nr_code/sp_code самой нормы -------------------
  const nrspOptions = q.nrspItems.all(work.id);
  if (work.nrsp_ambiguous && !options.nr_code) flags.add(FLAGS.NRSP_AMBIGUOUS);

  const nrCode = options.nr_code ?? work.nr_code;
  const spCode = options.sp_code ?? work.sp_code;
  const nrNorm = q.norm.get(nrspKey(nrCode));
  const spNorm = q.norm.get(nrspKey(spCode));
  if (!nrNorm || !spNorm) flags.add(FLAGS.NRSP_MISSING);

  const fot = r6(fotWorkers + fotDrivers);
  const nrPct = nrNorm ? nrNorm[territoryColumn] : null;
  const spPct = spNorm ? spNorm.profit_pct : null;
  const overhead = nrPct === null || nrPct === undefined ? null : r2((fot * nrPct) / 100);
  const profit = spPct === null || spPct === undefined ? null : r2((fot * spPct) / 100);

  // --- Итоги ---------------------------------------------------------------
  const direct = r2(totals.labor + totals.machines + totals.materials + totals.mainMaterials);
  const totalNoVat = r2(direct + (overhead ?? 0) + (profit ?? 0));
  const vatRate = options.vat ? 0.2 : 0;
  const vat = options.vat ? r2(totalNoVat * vatRate) : 0;
  const total = r2(totalNoVat + vat);

  const perNormUnit = volume === 0 ? null : r2(total / volume);

  return {
    work: {
      base_type: work.base_type,
      code: work.code,
      name_full: work.name_full,
      measure_unit: work.measure_unit,
      collection_code: work.collection_code,
      collection_name: work.collection_name,
      section_path: work.section_path,
      content_text: work.content_text,
    },
    period: { id: period.id, region: period.region, year: period.year, quarter: period.quarter },
    input: { quantity: volume, territory_type, norm_coefficient: kNorm, vat: Boolean(options.vat) },
    unit_check: unitCheck,   // детерминированная сверка единицы КП с единицей нормы
    lines,
    totals: {
      labor: r2(totals.labor),                    // ОТ
      machines: r2(totals.machines),              // ЭМ (включая з/п машинистов)
      drivers_salary: r2(totals.driversSalary),   // ОТм — часть ЭМ, входит в ФОТ
      materials: r2(totals.materials),            // М
      main_materials: r2(totals.mainMaterials),   // основной материал
      direct_costs: direct,                       // ПЗ
      fot: r2(fot),                               // ФОТ = ОТ + ОТм
      overhead_pct: nrPct ?? null,
      overhead,                                   // НР
      profit_pct: spPct ?? null,
      profit,                                     // СП
      total_without_vat: totalNoVat,
      vat,
      total,
      per_norm_unit: perNormUnit,                 // на единицу измерения нормы
    },
    norms: {
      nr_code: nrCode,
      sp_code: spCode,
      nr_item_no: nrNorm?.item_no ?? null,
      sp_item_no: spNorm?.item_no ?? null,
      work_type_name: nrNorm?.work_type_name ?? spNorm?.work_type_name ?? null,
      territory_type,
      options: nrspOptions.map((o) => ({ nr_code: o.nr_code, sp_code: o.sp_code })),
      ambiguous: Boolean(work.nrsp_ambiguous),
    },
    flags: [...flags],
  };
}

/** Одна строка расчёта: ресурс → расход → цена → сумма. */
function buildLine(q, res, ctx) {
  const { volume, kNorm, period_id, main_material_quantities, resource_quantities, material_substitutions, flags } = ctx;

  // Замена учтённого материала на другой (не касается труда, машин и
  // абстрактных ресурсов — у последних выбор идёт через main_materials).
  const subst = res.is_abstract ? undefined : material_substitutions[res.resource_code];
  if (subst && res.resource_type !== 'material' && res.resource_type !== 'equipment') {
    throw new Error(
      `Заменять можно только материалы и оборудование, а ${res.resource_code} — ${res.resource_type}`
    );
  }

  const line = {
    resource_code: res.resource_code,
    name: res.end_name,
    measure_unit: res.measure_unit,
    resource_type: res.resource_type,
    is_abstract: Boolean(res.is_abstract),
    tg_codes: res.tg_codes,
    quantity_per_unit: null,   // расход на единицу нормы (с коэффициентом)
    quantity_total: null,      // расход на объём
    base_price: null,
    index_value: null,
    price: null,               // цена в текущем уровне
    line_cost: null,
    drivers_salary: null,      // ОТм внутри строки машины
    article: null,             // ОТ | ЭМ | М | ОМ | справочно
    note: null,
  };

  // --- расход --------------------------------------------------------------
  // Приоритет: расход из замены → расход, заданный пользователем → норма.
  // Пользовательский расход перекрывает норму всегда, а не только когда в
  // норме стоит «П»: у основного материала единица измерения выбранной марки
  // часто отличается от единицы абстрактного ресурса, и расход приходится
  // задавать заново.
  const override = res.is_abstract
    ? main_material_quantities[res.resource_code]
    : resource_quantities[res.resource_code];

  let perUnit;
  if (subst && subst.quantity !== undefined && subst.quantity !== null) perUnit = Number(subst.quantity);
  else if (override !== undefined && override !== null) {
    perUnit = Number(override);
    line.note = res.quantity === null
      ? 'расход задан пользователем (в норме «П»)'
      : `расход задан пользователем (в норме ${res.quantity} ${res.measure_unit ?? ''})`.trim();
  } else perUnit = res.quantity;

  if (perUnit === null || perUnit === undefined || Number.isNaN(perUnit)) {
    flags.add(FLAGS.QUANTITY_BY_PROJECT);
    line.note = 'расход по проекту не задан';
    line.article = res.is_abstract ? 'ОМ' : articleOf(res.resource_type);
    return line;
  }
  line.quantity_per_unit = r6(perUnit * kNorm);
  line.quantity_total = r6(line.quantity_per_unit * volume);

  // --- цена и сумма --------------------------------------------------------
  switch (res.resource_type) {
    case 'labor':
      return laborLine(q, res, line, ctx);
    case 'machine':
      return machineLine(q, res, line, ctx);
    case 'abstract_material':
      return mainMaterialLine(q, res, line, ctx);
    default: {
      line.article = articleOf(res.resource_type);
      const code = subst ? subst.code : res.resource_code;
      if (subst) {
        line.selected_code = subst.code;
        line.substituted = true;
        line.note = `замена материала ${res.resource_code} → ${subst.code}` +
          (subst.quantity !== undefined && subst.quantity !== null ? `, расход задан пользователем` : '');
      }
      const mat = q.material.get(code);
      if (subst) line.selected_name = mat?.name ?? null;
      if (mat) {
        if (!line.name || subst) line.name = subst ? line.name : (line.name ?? mat.name);
        if (subst || !line.measure_unit) line.measure_unit = mat.measure_unit ?? line.measure_unit;
      }
      applyPrice(line, currentPrice(q.price.get(period_id, code)), flags);
      return line;
    }
  }
}

const articleOf = (type) =>
  type === 'labor' ? 'ОТ' : type === 'machine' ? 'ЭМ' : type === 'abstract_material' ? 'ОМ' : 'М';

function applyPrice(line, priceInfo, flags) {
  line.base_price = priceInfo.basis;
  line.index_value = priceInfo.index;
  line.price = priceInfo.price;
  if (line.price === null) {
    flags.add(FLAGS.PRICE_MISSING);
    line.note = line.note ? `${line.note}; ${priceInfo.source}` : priceInfo.source;
    return;
  }
  line.line_cost = r2(line.quantity_total * line.price);
}

/**
 * Труд рабочих. Три случая по разделу 5 ТЗ:
 *  - код с разрядом → тариф из сплит-формы, идёт в ФОТ;
 *  - «голый» код 2  → з/п машинистов уже сидит в цене маш.-часа, line_cost = 0,
 *                     строка остаётся справочной (количество чел.-ч);
 *  - «голый» код 1  → правило неизвестно, line_cost = NULL + флаг.
 */
function laborLine(q, res, line, ctx) {
  line.article = 'ОТ';

  if (res.resource_code === '2') {
    line.article = 'справочно';
    line.line_cost = 0;
    line.note = 'труд машинистов — учтён в цене маш.-часа через DriverCode, повторно не тарифицируется';
    return line;
  }
  if (res.resource_code === '1') {
    ctx.flags.add(FLAGS.NEEDS_TARIFF);
    line.line_cost = null;
    line.note = 'разряд не указан в норме — тариф требует уточнения';
    return line;
  }

  const tariff = q.tariff.get(ctx.period_id, res.resource_code);
  if (!tariff) {
    ctx.flags.add(FLAGS.NEEDS_TARIFF);
    line.note = 'тариф не найден в сплит-форме';
    return line;
  }
  line.price = tariff.rate_per_hour;
  line.name = line.name ?? tariff.name;
  line.measure_unit = line.measure_unit ?? 'чел.-ч';
  line.line_cost = r2(line.quantity_total * line.price);
  return line;
}

/**
 * Машина: цена маш.-часа без з/п (через сплит-форму) + з/п машиниста,
 * пересчитанная на текущий период как rate(DriverCode) × LabourMach.
 * З/п машиниста показывается отдельной величиной (ОТм) и входит в ФОТ.
 */
function machineLine(q, res, line, ctx) {
  line.article = 'ЭМ';
  const machine = q.machine.get(res.resource_code);
  const priceInfo = currentPrice(q.price.get(ctx.period_id, res.resource_code));
  line.base_price = priceInfo.basis;
  line.index_value = priceInfo.index;
  if (machine && !line.name) line.name = machine.name;
  line.measure_unit = line.measure_unit ?? 'маш.-ч';

  let salaryPerHour = 0;
  if (machine && machine.driver_code) {
    const tariff = q.tariff.get(ctx.period_id, machine.driver_code);
    if (!tariff) {
      ctx.flags.add(FLAGS.NEEDS_TARIFF);
      line.note = `тариф машиниста ${machine.driver_code} не найден`;
    } else {
      salaryPerHour = r6(tariff.rate_per_hour * (machine.labour_mach ?? 0));
      line.driver_code = machine.driver_code;
      line.driver_rate = tariff.rate_per_hour;
      line.labour_mach = machine.labour_mach;
    }
  }

  if (priceInfo.price === null) {
    ctx.flags.add(FLAGS.PRICE_MISSING);
    line.note = line.note ? `${line.note}; ${priceInfo.source}` : priceInfo.source;
    return line;
  }

  line.machine_price = priceInfo.price;      // без з/п машиниста
  line.salary_part = salaryPerHour;          // з/п машиниста на 1 маш.-ч
  line.price = r6(priceInfo.price + salaryPerHour);
  line.line_cost = r2(line.quantity_total * line.price);
  line.drivers_salary = r2(line.quantity_total * salaryPerHour);
  return line;
}

/**
 * Основной («неучтённый») материал: конкретный код выбирает пользователь из
 * технологической группы. Пока не выбран — позиция считается без него с флагом.
 */
function mainMaterialLine(q, res, line, ctx) {
  line.article = 'ОМ';
  const chosen = ctx.main_materials[res.resource_code];
  if (!chosen) {
    ctx.flags.add(FLAGS.MAIN_MATERIAL_NOT_SELECTED);
    line.note = 'основной материал не выбран — в расчёт не включён';
    return line;
  }
  line.selected_code = chosen;
  const mat = q.material.get(chosen);
  const normUnit = res.measure_unit;
  const matUnit = mat?.measure_unit ?? null;
  if (mat) {
    line.selected_name = mat.name;
    line.measure_unit = matUnit ?? line.measure_unit;
  }

  // Технологическая группа объединяет взаимозаменяемые материалы, но единица
  // измерения у них сплошь и рядом другая, чем у абстрактного ресурса нормы
  // (в базе таких пар 32%: «т» → «шт», «м3» → «м» и т.п.). Перемножать норму
  // в тоннах на цену за килограмм нельзя, поэтому расход обязан задать
  // пользователь — уже в единицах выбранного материала.
  const unitsDiffer = Boolean(normUnit && matUnit && normUnit !== matUnit);
  const userSetQuantity = Object.prototype.hasOwnProperty.call(ctx.main_material_quantities, res.resource_code);
  if (unitsDiffer) {
    line.norm_measure_unit = normUnit;
    if (!userSetQuantity) {
      ctx.flags.add(FLAGS.UNIT_MISMATCH);
      line.quantity_per_unit = null;
      line.quantity_total = null;
      line.note = `в норме расход ${res.quantity ?? '—'} ${normUnit}, а материал считается в «${matUnit}» —` +
        ` задайте расход в ${matUnit}, пересчёт единиц система не выполняет`;
      return line;
    }
    line.note = `расход задан в «${matUnit}» (в норме — ${normUnit})`;
  }

  const priceInfo = currentPrice(q.price.get(ctx.period_id, chosen));
  applyPrice(line, priceInfo, ctx.flags);
  return line;
}
