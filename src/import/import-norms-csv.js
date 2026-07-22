import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logImport } from '../db/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const NORMS_CSV = path.join(here, '../../work_type_norms.csv');

/** Разбор CSV с кавычками: в файле есть поля вида "Сборник 1, кроме отделов 5,6". */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * Нормализация номера пункта приказа к ключу матчинга.
 *
 * В нормах код выглядит как 'Пр/812-021.0' (в выгрузке Гранд-Сметы бывает
 * суффикс — 'Пр/812-021.0-1' — он отбрасывается). В CSV тот же пункт записан
 * как '21.0' или просто '21'. Приводим к общему виду '21.0'.
 *
 * Числовая часть у Nr и Sp одной нормы всегда совпадает (проверено на всех
 * 64 753 записях ReasonItem в пяти файлах), поэтому одного ключа достаточно:
 * префикс 812/774 лишь указывает, из какой колонки CSV брать процент, а эту
 * колонку движок и так выбирает по смыслу (НР или СП).
 */
export function normalizeNormKey(raw) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s) return null;
  const m = s.match(/^Пр\/(?:812|774)-([0-9]+(?:\.[0-9]+)?)/);
  if (m) s = m[1];
  const parts = s.split('.');
  const head = parts[0];
  if (!/^\d+$/.test(head)) return s; // напр. '104доп' — остаётся как есть
  const num = String(Number(head));
  return parts.length > 1 ? `${num}.${parts[1]}` : `${num}.0`;
}

/** work_type_norms.csv → work_type_norms (шаг 8 раздела 4.6 ТЗ). */
export function importNormsCsv(db, file = NORMS_CSV) {
  const startedAt = new Date().toISOString();
  const rows = parseCsv(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  const header = rows[0].map((h) => h.trim());
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));

  const required = ['item_no', 'work_type_name', 'profit_pct', 'overhead_territory_pct'];
  for (const col of required) {
    if (!(col in idx)) throw new Error(`В ${path.basename(file)} нет колонки ${col}`);
  }

  const insert = db.prepare(
    `INSERT INTO work_type_norms (item_no, match_key, work_type_name, section, base_type,
       collection_codes, sbornik_note, profit_pct, overhead_territory_pct,
       overhead_mprks_pct, overhead_rks_pct, needs_manual_review)
     VALUES (@item_no, @match_key, @work_type_name, @section, @base_type,
       @collection_codes, @sbornik_note, @profit_pct, @overhead_territory_pct,
       @overhead_mprks_pct, @overhead_rks_pct, @needs_manual_review)`
  );
  const numOrNull = (v) => {
    const s = (v ?? '').trim();
    if (!s) return null;
    const n = Number(s.replace(',', '.'));
    return Number.isNaN(n) ? null : n;
  };

  let count = 0;
  db.transaction(() => {
    for (const r of rows.slice(1)) {
      if (!r.length || !(r[idx.item_no] ?? '').trim()) continue;
      insert.run({
        item_no: r[idx.item_no].trim(),
        match_key: normalizeNormKey(r[idx.item_no]),
        work_type_name: (r[idx.work_type_name] ?? '').trim(),
        section: (r[idx.section] ?? '').trim() || null,
        base_type: (r[idx.base_type] ?? '').trim() || null,
        collection_codes: (r[idx.collection_codes] ?? '').trim() || null,
        sbornik_note: (r[idx.sbornik_note] ?? '').trim() || null,
        profit_pct: numOrNull(r[idx.profit_pct]),
        overhead_territory_pct: numOrNull(r[idx.overhead_territory_pct]),
        overhead_mprks_pct: numOrNull(r[idx.overhead_mprks_pct]),
        overhead_rks_pct: numOrNull(r[idx.overhead_rks_pct]),
        needs_manual_review: /^true$/i.test((r[idx.needs_manual_review] ?? '').trim()) ? 1 : 0,
      });
      count++;
    }
  })();

  logImport(db, path.basename(file), count, startedAt);
  return count;
}
