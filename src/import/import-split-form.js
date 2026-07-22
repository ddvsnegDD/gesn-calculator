import path from 'node:path';
import ExcelJS from 'exceljs';
import { openDb, logImport, isMain } from '../db/index.js';

const SHEET = 'Сплит-форма';
const FIRST_DATA_ROW = 21; // 19 — заголовки, 20 — номера колонок 1..9

/** Значение ячейки: формулы отдаются как {formula, result}. */
function cellValue(row, i) {
  const v = row.getCell(i).value;
  if (v && typeof v === 'object') {
    if ('result' in v) return v.result;
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return v.text;
  }
  return v;
}

/** В файле пропуск обозначен дефисом; пустая строка и null — тоже пропуск. */
function numOrNull(v) {
  if (v === null || v === undefined || v === '-' || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/\s/g, '').replace(',', '.'));
  return Number.isNaN(n) ? null : n;
}

function textOrNull(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' || s === '-' ? null : s;
}

/** Год и квартал из заголовка листа либо из имени файла: «на 2 квартал 2026 года». */
export function parsePeriod(title, fileName) {
  for (const src of [title, fileName]) {
    if (!src) continue;
    const m = String(src).match(/на\s+(\d)\s*квартал[а-я]*\s+(\d{4})/i);
    if (m) return { quarter: Number(m[1]), year: Number(m[2]) };
  }
  return null;
}

/**
 * Сплит-форма → price_periods + labor_tariff_rates + price_period_resources
 * (раздел 4.4 ТЗ). Файл на 281 тыс. строк читается потоково.
 *
 * Разделение строк: единица 'чел.-ч' → тарифная ставка труда (колонка 8),
 * всё остальное → цена/индекс ресурса. '-' в любой колонке означает NULL.
 */
export async function importSplitForm(db, filePath) {
  const startedAt = new Date().toISOString();
  const fileName = path.basename(filePath);

  const reader = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {
    sharedStrings: 'cache',
    worksheets: 'emit',
    styles: 'ignore',
  });

  let periodId = null;
  let region = null;
  let subject = null;
  let sourceLetter = null;
  let title = null;
  let labor = 0;
  let resources = 0;
  let unpriceable = 0; // нет ни current_price, ни base×index — цену не вычислить

  const insPeriod = db.prepare(
    `INSERT INTO price_periods (region, year, quarter, source_letter, imported_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(region, year, quarter) DO UPDATE SET
       source_letter = excluded.source_letter, imported_at = excluded.imported_at
     RETURNING id`
  );
  const insLabor = db.prepare(
    `INSERT OR REPLACE INTO labor_tariff_rates (period_id, resource_code, name, rate_per_hour)
     VALUES (?, ?, ?, ?)`
  );
  const insRes = db.prepare(
    `INSERT OR REPLACE INTO price_period_resources (period_id, resource_code, gosr_group_no,
       gosr_group_name, base_price, current_price, index_value)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  let batch = [];
  const flush = db.transaction((rows) => {
    for (const r of rows) {
      if (r.kind === 'labor') insLabor.run(r.periodId, r.code, r.name, r.rate);
      else insRes.run(r.periodId, r.code, r.gosr, r.gosrName, r.base, r.current, r.index);
    }
  });

  for await (const ws of reader) {
    if (ws.name !== SHEET) continue;
    for await (const row of ws) {
      const n = row.number;

      if (n === 1) { title = textOrNull(cellValue(row, 1)); continue; }
      if (n === 2) { sourceLetter = textOrNull(cellValue(row, 7)); continue; }
      if (n === 4) { subject = textOrNull(cellValue(row, 7)); continue; }
      if (n === 5) { region = textOrNull(cellValue(row, 7)); continue; }
      if (n < FIRST_DATA_ROW) continue;

      if (periodId === null) {
        const period = parsePeriod(title, fileName);
        if (!period) {
          throw new Error(
            `Не удалось определить квартал и год ни из заголовка листа, ни из имени файла «${fileName}». ` +
              `Ожидался текст вида «на 2 квартал 2026 года».`
          );
        }
        const regionName = region || subject;
        if (!regionName) throw new Error('В файле не найдено наименование зоны/субъекта (строки 4-5).');
        periodId = insPeriod.get(regionName, period.year, period.quarter, sourceLetter, new Date().toISOString()).id;
        // повторный импорт того же периода перетирает прежние строки
        db.prepare('DELETE FROM labor_tariff_rates WHERE period_id = ?').run(periodId);
        db.prepare('DELETE FROM price_period_resources WHERE period_id = ?').run(periodId);
      }

      const code = textOrNull(cellValue(row, 1));
      if (!code) continue;
      const name = textOrNull(cellValue(row, 2));
      const unit = textOrNull(cellValue(row, 3));

      if (unit === 'чел.-ч') {
        const rate = numOrNull(cellValue(row, 8));
        if (rate === null) continue; // без ставки строка бесполезна
        batch.push({ kind: 'labor', periodId, code, name, rate });
        labor++;
      } else {
        const base = numOrNull(cellValue(row, 5));
        const current = numOrNull(cellValue(row, 8));
        const index = numOrNull(cellValue(row, 9));
        if (current === null && (base === null || index === null)) unpriceable++;
        batch.push({
          kind: 'res',
          periodId,
          code,
          gosr: numOrNull(cellValue(row, 6)),
          gosrName: textOrNull(cellValue(row, 7)),
          base,
          current,
          index,
        });
        resources++;
      }

      if (batch.length >= 5000) { flush(batch); batch = []; }
    }
  }
  if (batch.length) flush(batch);

  if (periodId === null) throw new Error(`В файле «${fileName}» не найден лист «${SHEET}» или он пуст.`);

  logImport(db, fileName, labor + resources, startedAt,
    `период ${periodId}: труд ${labor}, ресурсы ${resources}, без вычислимой цены ${unpriceable}`);
  return { periodId, region: region || subject, labor, resources, unpriceable };
}

if (isMain(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    console.error('Использование: node src/import/import-split-form.js <путь к сплит-форме.xlsx>');
    process.exit(1);
  }
  const db = openDb();
  const res = await importSplitForm(db, file);
  console.log(
    `Период #${res.periodId} (${res.region}): ставок труда ${res.labor}, ресурсов ${res.resources}` +
      (res.unpriceable ? `, из них без вычислимой цены ${res.unpriceable}` : '')
  );
  db.close();
}
