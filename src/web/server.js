import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import ExcelJS from 'exceljs';
import { openDb, isMain } from '../db/index.js';
import { calcPosition } from '../engine/calc-position.js';
import { importSplitForm } from '../import/import-split-form.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Экранирование запроса для FTS5: пользователь пишет обычный текст, не синтаксис. */
function ftsQuery(q) {
  const tokens = q
    .toLowerCase()
    .split(/[^0-9a-zа-яё]+/i)
    .filter((t) => t.length >= 2)
    .map((t) => `"${t}"*`);
  return tokens.join(' AND ');
}

const looksLikeCode = (q) => /^[А-Яа-яA-Za-z]*[\s-]*\d{2}[-.]\d/.test(q.trim());

export function createApp(db) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(here, 'public')));

  const upload = multer({
    dest: path.join(os.tmpdir(), 'gesn-uploads'),
    limits: { fileSize: 100 * 1024 * 1024 },
  });

  const wrap = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  };

  // --- периоды сплит-формы -------------------------------------------------
  app.get('/api/periods', wrap(async (req, res) => {
    const periods = db.prepare(
      `SELECT p.*,
              (SELECT COUNT(*) FROM labor_tariff_rates t WHERE t.period_id = p.id) AS tariffs,
              (SELECT COUNT(*) FROM price_period_resources r WHERE r.period_id = p.id) AS resources
       FROM price_periods p ORDER BY p.year DESC, p.quarter DESC`
    ).all();
    res.json({ periods });
  }));

  app.post('/api/periods', upload.single('file'), wrap(async (req, res) => {
    if (!req.file) throw new Error('Файл сплит-формы не передан');
    try {
      const result = await importSplitForm(db, req.file.path, req.file.originalname);
      res.json(result);
    } finally {
      fs.unlink(req.file.path, () => {});
    }
  }));

  // --- поиск расценок ------------------------------------------------------
  app.get('/api/search', wrap(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    if (q.length < 2) return res.json({ works: [] });

    const byCode = db.prepare(
      `SELECT base_type, code, name_full, measure_unit, collection_code, collection_name
       FROM works WHERE code = ? OR code LIKE ? ORDER BY base_type, code LIMIT 50`
    ).all(q, `${q.replace(/^ГЭСН[а-я]*/i, '')}%`);

    let byName = [];
    if (byCode.length < 50) {
      const match = ftsQuery(q);
      if (match) {
        byName = db.prepare(
          `SELECT w.base_type, w.code, w.name_full, w.measure_unit, w.collection_code, w.collection_name
           FROM works_fts f JOIN works w ON w.id = f.rowid
           WHERE works_fts MATCH ? ORDER BY rank LIMIT ?`
        ).all(match, 50 - byCode.length);
      }
    }

    const seen = new Set(byCode.map((w) => `${w.base_type}${w.code}`));
    const works = [...byCode];
    for (const w of byName) {
      const key = `${w.base_type}${w.code}`;
      if (!seen.has(key)) { seen.add(key); works.push(w); }
    }
    res.json({ works });
  }));

  // --- карточка расценки: состав + кандидаты на основной материал ----------
  app.get('/api/work/:base/:code', wrap(async (req, res) => {
    const { base, code } = req.params;
    const periodId = Number(req.query.period_id) || null;

    const work = db.prepare('SELECT * FROM works WHERE base_type = ? AND code = ?').get(base, code);
    if (!work) throw new Error(`Норма не найдена: ${base} ${code}`);

    const resources = db.prepare(
      `SELECT wr.*,
              COALESCE(m.name, mc.name) AS ref_name,
              COALESCE(m.measure_unit, mc.measure_unit) AS ref_unit
       FROM work_resources wr
       LEFT JOIN materials m ON m.code = wr.resource_code
       LEFT JOIN machines mc ON mc.code = wr.resource_code
       WHERE wr.work_id = ? ORDER BY wr.id`
    ).all(work.id);

    const candidatesFor = db.prepare(
      `SELECT g.resource_code AS code, m.name, m.measure_unit,
              p.base_price, p.current_price, p.index_value
       FROM technology_groups g
       JOIN materials m ON m.code = g.resource_code
       LEFT JOIN price_period_resources p ON p.resource_code = g.resource_code AND p.period_id = ?
       WHERE g.tg_code = ? ORDER BY m.name LIMIT 300`
    );

    const abstracts = resources
      .filter((r) => r.is_abstract)
      .map((r) => {
        const tgCodes = (r.tg_codes ?? '').split(';').map((s) => s.trim()).filter(Boolean);
        const candidates = [];
        const seen = new Set();
        for (const tg of tgCodes) {
          for (const c of candidatesFor.all(periodId, tg)) {
            if (seen.has(c.code)) continue;
            seen.add(c.code);
            candidates.push({
              ...c,
              price: c.current_price ?? (c.base_price !== null && c.index_value !== null
                ? Math.round(c.base_price * c.index_value * 1e6) / 1e6
                : null),
            });
          }
        }
        return {
          code: r.resource_code,
          name: r.end_name,
          measure_unit: r.measure_unit,
          quantity: r.quantity,
          quantity_note: r.quantity_note,
          tg_codes: tgCodes,
          candidates,
        };
      });

    const nrspOptions = db.prepare('SELECT * FROM work_nrsp_items WHERE work_id = ? ORDER BY ord').all(work.id);
    const normFor = db.prepare('SELECT * FROM work_type_norms WHERE match_key = ?');
    const options = nrspOptions.map((o) => {
      const key = (o.nr_code ?? '').replace(/^Пр\/(?:812|774)-/, '').replace(/^0+/, '');
      const norm = normFor.get(key);
      return { nr_code: o.nr_code, sp_code: o.sp_code, work_type_name: norm?.work_type_name ?? null };
    });

    res.json({ work, resources, abstracts, nrsp: { ambiguous: Boolean(work.nrsp_ambiguous), options } });
  }));

  // --- расчёт --------------------------------------------------------------
  app.post('/api/calc', wrap(async (req, res) => {
    const { market_price_per_unit, ...input } = req.body ?? {};
    const result = calcPosition(db, input);
    result.market = buildMarketComparison(result, market_price_per_unit);
    res.json(result);
  }));

  // --- экспорт в Excel -----------------------------------------------------
  app.post('/api/export', wrap(async (req, res) => {
    const { market_price_per_unit, ...input } = req.body ?? {};
    const result = calcPosition(db, input);
    result.market = buildMarketComparison(result, market_price_per_unit);
    const buffer = await buildWorkbook(result);
    const name = `Расчёт_${result.work.base_type}${result.work.code}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.send(Buffer.from(buffer));
  }));

  return app;
}

/** Сравнение нормативной стоимости с рыночной ценой из КП (раздел 7 ТЗ). */
export function buildMarketComparison(result, marketPricePerUnit) {
  const price = Number(marketPricePerUnit);
  if (!Number.isFinite(price) || price <= 0) return null;
  const marketTotal = Math.round(price * result.input.quantity * 100) / 100;
  const normative = result.totals.total;
  const delta = Math.round((marketTotal - normative) * 100) / 100;
  return {
    price_per_unit: price,
    measure_unit: result.work.measure_unit,
    market_total: marketTotal,
    normative_total: normative,
    normative_per_unit: result.totals.per_norm_unit,
    delta_rub: delta,
    delta_pct: normative ? Math.round((delta / normative) * 10000) / 100 : null,
  };
}

async function buildWorkbook(result) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Расчёт');
  const bold = { bold: true };

  ws.columns = [
    { width: 24 }, { width: 52 }, { width: 9 }, { width: 12 },
    { width: 14 }, { width: 13 }, { width: 15 },
  ];

  ws.addRow([`${result.work.base_type}${result.work.code}`, result.work.name_full]).font = bold;
  ws.addRow(['Ед. изм.', result.work.measure_unit, 'Объём', result.input.quantity]);
  ws.addRow(['Период цен', `${result.period.region}, ${result.period.quarter} кв. ${result.period.year}`]);
  ws.addRow(['Территория', result.input.territory_type, 'К норме', result.input.norm_coefficient,
    'НДС', result.input.vat ? '20%' : 'нет']);
  ws.addRow([]);

  const head = ws.addRow(['Код', 'Наименование', 'Ед.', 'На единицу', 'На объём', 'Цена, руб', 'Сумма, руб']);
  head.font = bold;

  for (const l of result.lines) {
    ws.addRow([
      l.selected_code ? `${l.resource_code} → ${l.selected_code}` : l.resource_code,
      l.selected_name ?? l.name ?? '',
      l.measure_unit ?? '',
      l.quantity_per_unit,
      l.quantity_total,
      l.price,
      l.line_cost,
    ]);
    if (l.note) ws.addRow(['', l.note]).font = { italic: true, size: 9 };
  }

  ws.addRow([]);
  const t = result.totals;
  const totals = [
    ['Оплата труда рабочих (ОТ)', t.labor],
    ['Эксплуатация машин (ЭМ)', t.machines],
    ['в том числе з/п машинистов (ОТм)', t.drivers_salary],
    ['Материалы (М)', t.materials],
    ['Основной материал', t.main_materials],
    ['Прямые затраты (ПЗ)', t.direct_costs],
    ['ФОТ (ОТ + ОТм)', t.fot],
    [`Накладные расходы, ${t.overhead_pct ?? '—'}%`, t.overhead],
    [`Сметная прибыль, ${t.profit_pct ?? '—'}%`, t.profit],
    ['Итого без НДС', t.total_without_vat],
  ];
  if (result.input.vat) totals.push(['НДС 20%', t.vat]);
  totals.push(['ВСЕГО ПО ПОЗИЦИИ', t.total]);
  totals.push([`на единицу нормы (${result.work.measure_unit})`, t.per_norm_unit]);
  for (const [label, value] of totals) {
    const row = ws.addRow(['', label, '', '', '', '', value]);
    if (/ВСЕГО|Прямые|ФОТ/.test(label)) row.font = bold;
  }

  if (result.market) {
    ws.addRow([]);
    ws.addRow(['СРАВНЕНИЕ С РЫНКОМ']).font = bold;
    ws.addRow(['', 'Норматив', '', '', '', '', result.market.normative_total]);
    ws.addRow(['', `Рыночная (${result.market.price_per_unit} руб за ${result.market.measure_unit})`,
      '', '', '', '', result.market.market_total]);
    ws.addRow(['', 'Разница, руб', '', '', '', '', result.market.delta_rub]);
    ws.addRow(['', 'Разница, %', '', '', '', '', result.market.delta_pct]);
  }

  ws.addRow([]);
  ws.addRow(['КОДЫ ДЛЯ ГРАНД-СМЕТЫ']).font = bold;
  ws.addRow(['Расценка', `${result.work.base_type}${result.work.code}`]);
  const materials = result.lines
    .filter((l) => l.selected_code || (l.article === 'М' && l.line_cost !== null))
    .map((l) => l.selected_code ?? l.resource_code);
  if (materials.length) ws.addRow(['Материалы', materials.join(', ')]);
  ws.addRow(['НР', `${result.norms.nr_code ?? '—'}${result.norms.nr_item_no ? ` (п. ${result.norms.nr_item_no})` : ''}`]);
  ws.addRow(['СП', `${result.norms.sp_code ?? '—'}${result.norms.sp_item_no ? ` (п. ${result.norms.sp_item_no})` : ''}`]);
  if (result.flags.length) ws.addRow(['Флаги', result.flags.join(', ')]);

  return wb.xlsx.writeBuffer();
}

if (isMain(import.meta.url)) {
  const db = openDb();
  const port = Number(process.env.PORT) || 3000;
  createApp(db).listen(port, () => {
    console.log(`Калькулятор ГЭСН: http://localhost:${port}`);
  });
}
