import { openDb, isMain } from '../db/index.js';

const fmt = (n) => (n === null || n === undefined ? '—' : n.toLocaleString('ru-RU'));

/** Отчёт контрольной точки 1: что реально легло в БД после импорта. */
export function reportImport(db) {
  const out = [];
  const say = (s = '') => out.push(s);

  say('=== КОЛИЧЕСТВО ЗАПИСЕЙ ПО ТАБЛИЦАМ ===');
  const expected = {
    works: 56192,
    materials: 45437,
    machines: 1732,
    coefficients: 2165,
    labor_tariff_rates: 186,
  };
  const tables = [
    'works', 'work_resources', 'work_nrsp_items', 'materials', 'machines',
    'technology_groups', 'tg_work_links', 'coefficients', 'price_periods',
    'labor_tariff_rates', 'price_period_resources', 'work_type_norms',
  ];
  for (const t of tables) {
    const n = db.prepare(`SELECT COUNT(*) FROM ${t}`).pluck().get();
    const exp = expected[t];
    const mark = exp === undefined ? '' : n === exp ? `  ← ожидалось ${fmt(exp)} ✅` : `  ← ОЖИДАЛОСЬ ${fmt(exp)} ❌`;
    say(`  ${t.padEnd(24)} ${String(fmt(n)).padStart(9)}${mark}`);
  }
  const tgGroups = db.prepare('SELECT COUNT(DISTINCT tg_code) FROM technology_groups').pluck().get();
  const tgLinkGroups = db.prepare('SELECT COUNT(DISTINCT tg_code) FROM tg_work_links').pluck().get();
  say(`  ${'└ групп в Ключах ТГ'.padEnd(24)} ${String(fmt(tgLinkGroups)).padStart(9)}  ← ожидалось 6 710 ${tgLinkGroups === 6710 ? '✅' : '❌'}`);
  say(`  ${'└ групп с материалами'.padEnd(24)} ${String(fmt(tgGroups)).padStart(9)}  из 6 710; остальные 1 653 объявлены в «База ТГ.xml» пустыми`);
  const emptyTg = db.prepare(
    `SELECT COUNT(DISTINCT l.work_code) AS works, COUNT(DISTINCT l.tg_code) AS tgs
     FROM tg_work_links l
     WHERE NOT EXISTS (SELECT 1 FROM technology_groups g WHERE g.tg_code = l.tg_code)`
  ).get();
  say(`     └ ${fmt(emptyTg.tgs)} пустых групп затрагивают ${fmt(emptyTg.works)} норм — для них список кандидатов пуст,`);
  say(`       основной материал придётся задавать кодом вручную`);

  say('');
  say('=== ЗАПОЛНЕННОСТЬ nr_code / sp_code ===');
  const nrsp = db.prepare(
    `SELECT base_type, COUNT(*) AS total,
            SUM(nr_code IS NOT NULL) AS with_nr,
            SUM(sp_code IS NOT NULL) AS with_sp,
            SUM(nrsp_ambiguous) AS ambiguous
     FROM works GROUP BY base_type ORDER BY base_type`
  ).all();
  say('  база       работ    с nr_code    с sp_code   несколько вариантов');
  for (const r of nrsp) {
    const pct = ((r.with_nr / r.total) * 100).toFixed(2);
    say(`  ${r.base_type.padEnd(8)} ${String(fmt(r.total)).padStart(7)} ${(pct + '%').padStart(11)} ${(((r.with_sp / r.total) * 100).toFixed(2) + '%').padStart(12)} ${String(fmt(r.ambiguous)).padStart(16)}`);
  }
  const all = db.prepare(
    `SELECT COUNT(*) AS total, SUM(nr_code IS NOT NULL) AS with_nr, SUM(nrsp_ambiguous) AS amb FROM works`
  ).get();
  say(`  ИТОГО    ${String(fmt(all.total)).padStart(7)} ${(((all.with_nr / all.total) * 100).toFixed(2) + '%').padStart(11)} ${''.padStart(12)} ${String(fmt(all.amb)).padStart(16)}`);

  say('');
  say('=== АБСТРАКТНЫЕ РЕСУРСЫ И РАСХОД «ПО ПРОЕКТУ» ===');
  const abs = db.prepare(
    `SELECT SUM(is_abstract) AS abstract,
            SUM(quantity_note = 'П') AS by_project,
            SUM(is_abstract = 1 AND quantity_note = 'П') AS abstract_by_project,
            SUM(tg_codes IS NOT NULL) AS with_tg
     FROM work_resources`
  ).get();
  say(`  work_resources с is_abstract=1        ${String(fmt(abs.abstract)).padStart(8)}  ${abs.abstract > 0 ? '✅ > 0' : '❌'}`);
  say(`  из них с заполненным tg_codes         ${String(fmt(abs.with_tg)).padStart(8)}`);
  say(`  ресурсов с расходом «П» (по проекту)  ${String(fmt(abs.by_project)).padStart(8)}`);
  say(`  └ из них абстрактных                  ${String(fmt(abs.abstract_by_project)).padStart(8)}`);
  const byType = db.prepare(
    `SELECT resource_type, COUNT(*) AS n FROM work_resources GROUP BY resource_type ORDER BY n DESC`
  ).all();
  say('  по типам ресурса:');
  for (const r of byType) say(`    ${r.resource_type.padEnd(20)} ${String(fmt(r.n)).padStart(8)}`);

  say('');
  say('=== НОРМА ГЭСН 12-01-015-03 (сверка с ТЗ) ===');
  const work = db.prepare(`SELECT * FROM works WHERE base_type='ГЭСН' AND code='12-01-015-03'`).get();
  say(`  ${work.code}  «${work.name_full}»`);
  say(`  ед. изм.: ${work.measure_unit} | сборник ${work.collection_code} «${work.collection_name}»`);
  say(`  nr_code = ${work.nr_code}   sp_code = ${work.sp_code}   (несколько вариантов: ${work.nrsp_ambiguous ? 'да' : 'нет'})`);
  say(`  состав работ: ${work.content_text}`);
  say('  ресурсы:');
  const res = db.prepare(`SELECT * FROM work_resources WHERE work_id=? ORDER BY id`).all(work.id);
  for (const r of res) {
    const q = r.quantity === null ? `«${r.quantity_note}»` : String(r.quantity);
    say(
      `    ${r.resource_code.padEnd(18)} ${r.resource_type.padEnd(18)} ${q.padStart(8)} ${(r.measure_unit ?? '').padEnd(7)}` +
        ` ${r.is_abstract ? '[абстр. ТГ ' + r.tg_codes + '] ' : ''}${r.end_name ?? ''}`
    );
  }

  say('');
  say('=== ТАРИФНАЯ СТАВКА 4-100-060 ===');
  for (const p of db.prepare('SELECT * FROM price_periods').all()) {
    const rate = db.prepare(
      `SELECT * FROM labor_tariff_rates WHERE period_id=? AND resource_code='4-100-060'`
    ).get(p.id);
    say(`  период #${p.id}: ${p.region}, ${p.quarter} кв. ${p.year}`);
    say(`    4-100-060 «${rate?.name ?? '—'}» = ${rate ? rate.rate_per_hour : '—'} руб/чел.-ч`);
  }

  say('');
  say('=== КОДЫ ИЗ work_resources, НЕ НАЙДЕННЫЕ НИ В ОДНОМ СПРАВОЧНИКЕ ===');
  const orphanSql = `
    SELECT wr.resource_code AS code, COUNT(*) AS uses,
           MIN(wr.end_name) AS sample_name, MIN(wr.resource_type) AS type
    FROM work_resources wr
    WHERE wr.is_abstract = 0
      AND NOT EXISTS (SELECT 1 FROM materials m WHERE m.code = wr.resource_code)
      AND NOT EXISTS (SELECT 1 FROM machines mc WHERE mc.code = wr.resource_code)
      AND NOT EXISTS (SELECT 1 FROM labor_tariff_rates lt WHERE lt.resource_code = wr.resource_code)
    GROUP BY wr.resource_code ORDER BY uses DESC`;
  const orphans = db.prepare(orphanSql).all();
  const orphanUses = orphans.reduce((s, r) => s + r.uses, 0);
  say(`  уникальных кодов: ${fmt(orphans.length)}, суммарно вхождений: ${fmt(orphanUses)}` +
      ` (из ${fmt(db.prepare('SELECT COUNT(*) FROM work_resources WHERE is_abstract=0').pluck().get())} неабстрактных)`);
  say('  первые 20:');
  for (const r of orphans.slice(0, 20)) {
    say(`    ${r.code.padEnd(18)} вхождений ${String(fmt(r.uses)).padStart(7)}  тип=${r.type.padEnd(10)} ${r.sample_name ?? ''}`);
  }

  say('');
  say('  абстрактные коды (это коды ГРУПП КСР, их и не должно быть в справочнике цен):');
  const absOrphan = db.prepare(
    `SELECT COUNT(DISTINCT resource_code) AS codes, COUNT(*) AS uses FROM work_resources WHERE is_abstract=1`
  ).get();
  say(`    уникальных ${fmt(absOrphan.codes)}, вхождений ${fmt(absOrphan.uses)} — подбираются через technology_groups`);

  say('');
  say('=== МАТЧИНГ НОРМАТИВОВ НР/СП ===');
  const matched = db.prepare(
    `SELECT COUNT(*) AS total,
            SUM(EXISTS (SELECT 1 FROM work_type_norms n
                        WHERE n.match_key = replace(substr(w.nr_code, 8), '0', '') OR n.match_key = ltrim(substr(w.nr_code, 8), '0'))) AS naive
     FROM works w WHERE w.nr_code IS NOT NULL`
  ).get();
  const keyed = db.prepare(
    `SELECT w.base_type, COUNT(*) AS total,
            SUM(n.id IS NOT NULL) AS matched
     FROM works w
     LEFT JOIN work_type_norms n ON n.match_key = ltrim(substr(w.nr_code, 8), '0')
     GROUP BY w.base_type ORDER BY w.base_type`
  ).all();
  say('  база       работ   найден норматив НР');
  for (const r of keyed) {
    const pct = ((r.matched / r.total) * 100).toFixed(2);
    say(`  ${r.base_type.padEnd(8)} ${String(fmt(r.total)).padStart(7)} ${(pct + '%').padStart(12)}   ${r.matched === r.total ? '✅' : '⚠ ' + fmt(r.total - r.matched) + ' без норматива'}`);
  }
  void matched;
  const unmatched = db.prepare(
    `SELECT w.nr_code, COUNT(*) AS n, MIN(w.base_type) AS base_type
     FROM works w
     LEFT JOIN work_type_norms n ON n.match_key = ltrim(substr(w.nr_code, 8), '0')
     WHERE n.id IS NULL AND w.nr_code IS NOT NULL
     GROUP BY w.nr_code ORDER BY n DESC`
  ).all();
  if (unmatched.length) {
    say('  коды без норматива в CSV:');
    for (const r of unmatched) say(`    ${r.nr_code}  (${r.base_type}, работ: ${fmt(r.n)})`);
  }

  say('');
  say('=== ТЕХГРУППЫ ВЕРИФИКАЦИОННЫХ НОРМ ===');
  for (const [base, code] of [['ГЭСН', '27-04-001-01'], ['ГЭСН', '12-01-015-03']]) {
    const rows = db.prepare(
      `SELECT wr.resource_code, wr.end_name, wr.tg_codes, wr.quantity, wr.quantity_note,
              (SELECT COUNT(*) FROM technology_groups g WHERE g.tg_code = wr.tg_codes) AS candidates
       FROM work_resources wr
       JOIN works w ON w.id = wr.work_id
       WHERE w.base_type = ? AND w.code = ? AND wr.is_abstract = 1`
    ).all(base, code);
    for (const r of rows) {
      const q = r.quantity === null ? `расход «${r.quantity_note}» (по проекту)` : `расход ${r.quantity}`;
      say(`  ${base}${code}: ${r.resource_code} «${r.end_name}» ТГ ${r.tg_codes} → кандидатов ${fmt(r.candidates)}, ${q}`);
    }
  }

  return out.join('\n');
}

if (isMain(import.meta.url)) {
  const db = openDb();
  console.log(reportImport(db));
  db.close();
}
