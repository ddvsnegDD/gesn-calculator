import ExcelJS from 'exceljs';
import { isMain } from '../db/index.js';

/**
 * Парсер ведомости подрядчика в свободной форме (компонент 1 ТЗ этапа 5).
 * Без AI: извлекает структуру позиций из xlsx до передачи модели.
 *
 * Ориентиры разметки (наблюдение на Гранит.xlsx, но захардкоженных номеров
 * строк нет — всё ищется по содержимому):
 *   - строка заголовков: «№ п/п | Наименование | Ед. изм. | Кол-во |
 *     За единицу | Всего» — находим по совпадению этих подписей;
 *   - секция: строка, где в колонке № стоит целое число, а рядом название
 *     без единицы и количества («1 Работы», «2 Материалы», «3 УСН»);
 *   - позиция: номер вида «1.7», наименование, ед., кол-во, цены;
 *   - итоги: «Итого:», «Всего по разделу:» — не позиции.
 */

/** Значение ячейки: формулы отдаются как {result}, richText — как склейка. */
function cellValue(cell) {
  const v = cell?.value;
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') {
    if ('result' in v) return v.result;
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return v.text;
    if ('hyperlink' in v) return v.text ?? v.hyperlink;
  }
  return v;
}

const text = (cell) => {
  const v = cellValue(cell);
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s === '' ? null : s;
};

const number = (cell) => {
  const v = cellValue(cell);
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/\s/g, '').replace(',', '.'));
  return Number.isNaN(n) ? null : n;
};

const rowValues = (row, width) => {
  const out = [];
  for (let i = 1; i <= width; i++) out.push(text(row.getCell(i)));
  return out;
};

// Подписи колонок, по которым узнаём строку заголовков.
const HEADER_MARKERS = {
  no: [/№\s*п\/?п/i, /^№$/],
  name: [/наименование/i],
  unit: [/ед[.\s]*изм/i, /единиц/i],
  qty: [/кол[-\s]*во/i, /количество/i],
  unit_price: [/за\s*единиц/i, /цена/i],
  total: [/всего/i, /сумма/i, /стоимость/i],
};

const isPositionNo = (s) => s !== null && /^\d+(\.\d+)+$/.test(s);
const isSectionNo = (s) => s !== null && /^\d+$/.test(s);
// Без \b: в JS-регэкспе \w не включает кириллицу даже с флагом u, поэтому
// граница слова между «о» и «:» не срабатывает и «Итого:» не матчится.
// Якорим по началу строки и допускаем любой не-буквенный хвост.
const isTotalRow = (cells) =>
  cells.some((c) => c && /^(итого|всего по разделу|итого по|всего)(?![а-яё])/i.test(c));

/** Находит строку заголовков и раскладку колонок по её содержимому. */
function findHeader(rows, width) {
  for (let r = 0; r < Math.min(rows.length, 30); r++) {
    const cells = rowValues(rows[r], width);
    const map = {};
    for (const [field, patterns] of Object.entries(HEADER_MARKERS)) {
      for (let c = 0; c < cells.length; c++) {
        if (cells[c] && patterns.some((re) => re.test(cells[c]))) { map[field] = c; break; }
      }
    }
    // минимально достаточный набор: номер, наименование и хотя бы количество или цена
    if (map.no !== undefined && map.name !== undefined && (map.qty !== undefined || map.total !== undefined)) {
      return { rowIndex: r, columns: map };
    }
  }
  return null;
}

/** Разбирает один лист. Бросает, если строка заголовков не найдена. */
export function parseSheet(worksheet) {
  const width = Math.max(worksheet.columnCount, 6);
  const rows = [];
  worksheet.eachRow({ includeEmpty: false }, (row) => rows.push(row));

  const header = findHeader(rows, width);
  if (!header) {
    throw new Error(
      `Лист «${worksheet.name}»: не найдена строка заголовков ` +
        `(«№ п/п», «Наименование», «Ед. изм.», «Кол-во», «Всего»). ` +
        `Проверьте файл — структура листа не распознана.`
    );
  }

  const col = header.columns;
  const get = (cells, field) => (col[field] !== undefined ? cells[col[field]] : null);

  const sections = [];
  let current = null;
  const orphanItems = []; // позиции до первой секции
  let totals = null;

  for (let r = header.rowIndex + 1; r < rows.length; r++) {
    const cells = rowValues(rows[r], width);
    if (cells.every((c) => c === null)) continue;

    const no = get(cells, 'no');
    const name = get(cells, 'name');

    // строка итогов
    if (isTotalRow(cells)) {
      const total = number(rows[r].getCell((col.total ?? col.unit_price ?? width - 1) + 1));
      if (/всего по разделу/i.test(cells.join(' '))) totals = { grand_total: total };
      else if (current) current.subtotal = total;
      continue;
    }

    // секция: целочисленный номер, есть название, нет количества и цены
    if (isSectionNo(no) && name && get(cells, 'qty') === null && get(cells, 'unit_price') === null) {
      current = { no, name, items: [] };
      sections.push(current);
      continue;
    }

    // позиция
    if (isPositionNo(no)) {
      const item = {
        no,
        name,
        unit: get(cells, 'unit'),
        qty: number(rows[r].getCell((col.qty ?? -1) + 1)),
        unit_price: col.unit_price !== undefined ? number(rows[r].getCell(col.unit_price + 1)) : null,
        total: col.total !== undefined ? number(rows[r].getCell(col.total + 1)) : null,
      };
      if (current) current.items.push(item);
      else orphanItems.push(item);
      continue;
    }
    // всё остальное (сводки внизу, пустые подписи) пропускаем как не-позиции
  }

  if (orphanItems.length) {
    sections.unshift({ no: null, name: null, items: orphanItems });
  }

  return {
    sheet: worksheet.name,
    header_row: header.rowIndex + 1,
    columns: col,
    sections,
    totals,
  };
}

/** Разбирает все листы файла. Возвращает { sheets: [...], errors: [...] }. */
export async function parseVedomost(filePath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);

  const sheets = [];
  const errors = [];
  for (const ws of wb.worksheets) {
    try {
      sheets.push(parseSheet(ws));
    } catch (err) {
      // не тихо пропускаем лист, а честно возвращаем ошибку (раздел 3 ТЗ)
      errors.push({ sheet: ws.name, error: err.message });
    }
  }
  if (!sheets.length && errors.length) {
    throw new Error(errors.map((e) => e.error).join('\n'));
  }
  return { sheets, errors };
}

/** Плоский список позиций листа — вход для AI-пайплайна. */
export function flattenItems(sheet) {
  const items = [];
  for (const section of sheet.sections) {
    for (const item of section.items) {
      items.push({ ...item, section: section.name });
    }
  }
  return items;
}

if (isMain(import.meta.url)) {
  const file = process.argv[2] || 'data/Гранит.xlsx';
  const { sheets, errors } = await parseVedomost(file);
  for (const s of sheets) {
    console.log(`\n===== ЛИСТ «${s.sheet}» (заголовки в строке ${s.header_row}) =====`);
    for (const section of s.sections) {
      console.log(`\n  [${section.no ?? '—'}] ${section.name ?? '(без секции)'} — позиций ${section.items.length}` +
        (section.subtotal != null ? `, итого ${section.subtotal.toLocaleString('ru-RU')}` : ''));
      for (const it of section.items) {
        console.log(`    ${(it.no ?? '').padEnd(6)} ${(it.name ?? '').slice(0, 52).padEnd(52)} ` +
          `${(it.unit ?? '').padEnd(5)} ${String(it.qty ?? '').padStart(7)} ` +
          `${String(it.unit_price ?? '').padStart(9)} ${String(it.total ?? '').padStart(11)}`);
      }
    }
    if (s.totals) console.log(`\n  ВСЕГО ПО РАЗДЕЛУ: ${s.totals.grand_total?.toLocaleString('ru-RU')}`);
  }
  for (const e of errors) console.log(`\n⚠ ${e.sheet}: ${e.error}`);
}
