import ExcelJS from 'exceljs';

/**
 * Разбор эталонной ЛСР Гранд-Сметы (раздел 8 ТЗ).
 *
 * Разметка листа (строки 35-38 — шапка):
 *   1 № п/п | 2 обоснование | 3 наименование | 8 ед. изм. | 9 кол-во на единицу
 *   10 коэффициенты | 11 всего с учётом коэффициентов
 *   12 цена на единицу в базисном уровне | 13 индекс | 14 цена в текущем уровне
 *
 * Внутри позиции строки идут блоками ОТ(ЗТ) / ЭМ / М, причём з/п машинистов
 * вынесена отдельными строками с кодом 4-100-XX сразу под своей машиной —
 * их и привязываем к предыдущей машине.
 */

const cell = (row, i) => {
  const v = row.getCell(i).value;
  if (v && typeof v === 'object') {
    if ('result' in v) return v.result;
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return v.text;
  }
  return v;
};

const text = (row, i) => {
  const v = cell(row, i);
  return v === null || v === undefined ? null : String(v).trim() || null;
};

const number = (row, i) => {
  const v = cell(row, i);
  if (v === null || v === undefined || v === '' || v === '-') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/\s/g, '').replace(',', '.'));
  return Number.isNaN(n) ? null : n;
};

const isPositionNo = (s) => s !== null && /^\d+(\.\d+)*$/.test(s);
const isMachine = (code) => /^91\./.test(code);
const isDriverTariff = (code) => /^4-\d{3}-\d+$/.test(code);
const isNrSp = (code) => /^Пр\/(812|774)-/.test(code);

/**
 * Читает позиции ЛСР с заданными номерами (`['1.1', '1.4']`).
 * Возвращает { '1.1': {...}, ... } — по одной записи на номер.
 */
export async function parseEtalon(filePath, wantedNumbers) {
  const wanted = new Set(wantedNumbers);
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {
    sharedStrings: 'cache',
    worksheets: 'emit',
    styles: 'ignore',
  });

  const result = {};
  let current = null;   // позиция, которую сейчас наполняем
  let lastMachine = null;
  let priceLevel = null;

  for await (const ws of reader) {
    for await (const row of ws) {
      const no = text(row, 1);
      const code = text(row, 2);
      const name = text(row, 3);

      if (row.number === 26 && name) priceLevel = name;

      // начало новой позиции верхнего уровня: «1.1», «1.4», …
      if (isPositionNo(no) && code && /^ГЭСН/.test(code)) {
        if (current) result[current.no] = current;
        current = wanted.has(no)
          ? {
              no,
              code,
              base_type: code.match(/^ГЭСН[а-я]*/)[0],
              work_code: code.replace(/^ГЭСН[а-я]*/, ''),
              name,
              measure_unit: text(row, 8),
              quantity: number(row, 9),
              coefficient: number(row, 10),
              quantity_total: number(row, 11),
              resources: [],
              subpositions: [],
              nrsp: [],
              totals: {},
              price_level: priceLevel,
            }
          : null;
        lastMachine = null;
        continue;
      }

      if (!current) continue;

      // подпозиция «1.1.1» — выбранный основной материал (строка ФСБЦ-…)
      if (isPositionNo(no) && no.startsWith(`${current.no}.`) && code) {
        current.subpositions.push({
          no,
          code: code.replace(/^ФСБЦ-/, ''),
          name,
          measure_unit: text(row, 8),
          per_unit: number(row, 9),
          total: number(row, 11),
          base_price: number(row, 12),
          index: number(row, 13),
          current_price: number(row, 14),
        });
        continue;
      }

      // «Н» — строка неучтённого материала (абстрактный ресурс нормы)
      if (no === 'Н' && code) {
        current.resources.push({
          kind: 'abstract',
          code,
          name,
          measure_unit: text(row, 8),
          per_unit: number(row, 9),
          total: number(row, 11),
          base_price: number(row, 12),
          index: number(row, 13),
          current_price: number(row, 14),
        });
        continue;
      }

      if (code && isNrSp(code)) {
        current.nrsp.push({ code, name, pct: number(row, 11) ?? number(row, 9) });
        continue;
      }

      // итоговые строки блока
      if (!code && name) {
        if (/^ОТм\(ЗТм\)/.test(name)) current.totals.drivers_hours = number(row, 11);
        else if (/^Итого прямые затраты/.test(name)) current.totals.direct = number(row, 14);
        else if (/^ФОТ/.test(name)) current.totals.fot = number(row, 14);
        else if (/^Всего по позиции/.test(name)) {
          current.totals.total = number(row, 14);
          result[current.no] = current;
          current = null;
          lastMachine = null;
        }
        continue;
      }

      // строки-разделители блоков: «1 ОТ(ЗТ)», «2 ЭМ», «4 М»
      if (code && /^\d+$/.test(code) && name && /^(ОТ\(ЗТ\)|ЭМ|М|ЗТм)/.test(name)) continue;

      if (!code) continue;

      // з/п машиниста — отдельная строка под своей машиной
      if (isDriverTariff(code)) {
        if (lastMachine) {
          lastMachine.driver_code = code;
          lastMachine.driver_hours = number(row, 11);
          lastMachine.driver_rate = number(row, 14);
        }
        continue;
      }

      const res = {
        kind: isMachine(code) ? 'machine' : 'resource',
        code,
        name,
        measure_unit: text(row, 8),
        per_unit: number(row, 9),
        total: number(row, 11),
        base_price: number(row, 12),
        index: number(row, 13),
        current_price: number(row, 14),
      };
      current.resources.push(res);
      lastMachine = res.kind === 'machine' ? res : null;
    }
    break; // ЛСР — на первом листе
  }
  if (current) result[current.no] = current;
  return result;
}
