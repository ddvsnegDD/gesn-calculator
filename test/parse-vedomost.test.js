import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseVedomost, parseSheet, flattenItems } from '../src/ai/parse-vedomost.js';
import ExcelJS from 'exceljs';

const here = path.dirname(fileURLToPath(import.meta.url));
const GRANIT = path.join(here, '../data/Гранит.xlsx');

const parsed = await parseVedomost(GRANIT);
const sheet = (name) => parsed.sheets.find((s) => s.sheet === name);
const section = (sheetName, secName) => sheet(sheetName).sections.find((s) => s.name === secName);
const item = (sheetName, secName, no) => section(sheetName, secName).items.find((i) => i.no === no);

test('оба листа разобраны без ошибок', () => {
  assert.equal(parsed.errors.length, 0, JSON.stringify(parsed.errors));
  assert.deepEqual(parsed.sheets.map((s) => s.sheet), ['Гранит', 'Электрика']);
  for (const s of parsed.sheets) assert.equal(s.header_row, 4);
});

test('лист «Гранит»: секции и число позиций', () => {
  const names = sheet('Гранит').sections.map((s) => `${s.name}:${s.items.length}`);
  assert.deepEqual(names, ['Работы:14', 'Материалы:12', 'УСН:1']);
});

test('лист «Электрика»: секции и число позиций', () => {
  const names = sheet('Электрика').sections.map((s) => `${s.name}:${s.items.length}`);
  assert.deepEqual(names, ['Работы:10', 'Материалы:12', 'УСН:1']);
});

test('позиции извлечены с точными номерами, единицами и количествами', () => {
  const stupeni = item('Гранит', 'Работы', '1.7');
  assert.deepEqual(
    { name: stupeni.name, unit: stupeni.unit, qty: stupeni.qty, unit_price: stupeni.unit_price, total: stupeni.total },
    { name: 'Монтаж ступеней', unit: 'м.п.', qty: 28.5, unit_price: 11700, total: 333450 }
  );

  const demontazh = item('Гранит', 'Работы', '1.3');
  assert.equal(demontazh.name, 'Демонтаж металических ограждений с сохранением');
  assert.equal(demontazh.unit, 'шт');
  assert.equal(demontazh.qty, 6);

  const sverlenie = item('Гранит', 'Работы', '1.12');
  assert.equal(sverlenie.unit, 'шт');
  assert.equal(sverlenie.qty, 25);

  // дробные количества
  assert.equal(item('Гранит', 'Работы', '1.5').qty, 59.5);
  assert.equal(item('Гранит', 'Работы', '1.6').qty, 31.7);
});

test('материалы листа «Гранит»: первый и последний', () => {
  const granit = item('Гранит', 'Материалы', '2.1');
  assert.match(granit.name, /^Гранит Articshok Silver/);
  assert.equal(granit.qty, 91);
  assert.equal(granit.total, 2162160);

  const tualet = item('Гранит', 'Материалы', '2.12');
  assert.match(tualet.name, /био-туалета/);
  assert.equal(tualet.unit, 'комп');
});

test('УСН распознана как отдельная секция, а не позиция работ', () => {
  const usn = item('Гранит', 'УСН', '3.1');
  assert.match(usn.name, /УСН 8%/);
  assert.equal(usn.total, 700374.09);
});

test('итоги секций и раздела не попали в позиции', () => {
  // ни одна позиция не называется «Итого»
  for (const s of parsed.sheets) {
    for (const sec of s.sections) {
      assert.ok(!sec.items.some((i) => /итого|всего по разделу/i.test(i.name ?? '')));
    }
  }
  // подытоги секций прочитаны
  assert.equal(section('Гранит', 'Работы').subtotal, 2460405);
  assert.equal(section('Гранит', 'Материалы').subtotal, 2927088);
  assert.equal(sheet('Гранит').totals.grand_total, 6087867.09);
});

test('flattenItems даёт плоский список с секцией у каждой позиции', () => {
  const flat = flattenItems(sheet('Гранит'));
  assert.equal(flat.length, 14 + 12 + 1);
  assert.equal(flat[0].section, 'Работы');
  assert.equal(flat.find((i) => i.no === '2.1').section, 'Материалы');
});

test('лист без строки заголовков даёт внятную ошибку, а не тихо пропускается', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Мусор');
  ws.addRow(['просто', 'какие-то', 'данные']);
  ws.addRow([1, 2, 3]);
  assert.throws(() => parseSheet(ws), /не найдена строка заголовков/);
});

test('единицы вне ГЭСН сохранены как есть (для unit_mismatch в пайплайне)', () => {
  const units = new Set();
  for (const s of parsed.sheets) for (const it of flattenItems(s)) units.add(it.unit);
  for (const u of ['м.п.', 'комп', 'шт', 'м2', 'тн', 'кг']) assert.ok(units.has(u), `нет единицы ${u}`);
});
