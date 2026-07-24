import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, isMain } from '../db/index.js';
import { aiConfig, aiEnabled, aiDisabledReason } from './config.js';
import { runMatchingFromFile } from './pipeline.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = path.join(here, '../../data/Гранит.xlsx');

const STATUS_MARK = {
  matched: '✅', uncertain: '❓', out_of_scope: '⛔', included_in: '↪', error: '⚠',
};


if (isMain(import.meta.url)) {
  if (!aiEnabled()) {
    console.error(aiDisabledReason());
    process.exit(1);
  }
  const file = process.argv[2] || DEFAULT_FILE;
  const sheetName = process.argv[3] || 'Гранит';

  console.log(`Прогон подбора: ${path.basename(file)}, лист «${sheetName}», модель ${aiConfig.model}\n`);
  const db = openDb();
  try {
    const run = await runMatchingFromFile(db, file, { sheetName });
    console.log(`Лог прогона: ${run.logFile}\n`);
    console.log('№     Статус         Позиция КП                                  Кандидат');
    console.log('─'.repeat(96));
    for (const r of run.results) {
      const cand = r.candidates?.[0];
      const codeStr = cand ? `${cand.base_type} ${cand.code} (${cand.confidence})` : (r.included_in ? `→ ${r.included_in.item_no}` : '');
      const um = cand?.unit_mismatch ? ` [ед: ${cand.unit_mismatch.quote_unit}/${cand.unit_mismatch.norm_unit}]` : '';
      console.log(
        `${String(r.item_no).padEnd(5)} ${STATUS_MARK[r.status] ?? '?'} ${String(r.status).padEnd(12)} ` +
        `${(r.source.name ?? '').slice(0, 42).padEnd(42)} ${codeStr}${um}`
      );
    }
    console.log('\nСводка по статусам:');
    const counts = {};
    for (const r of run.results) counts[r.status] = (counts[r.status] ?? 0) + 1;
    for (const [st, n] of Object.entries(counts)) console.log(`  ${STATUS_MARK[st] ?? '?'} ${st}: ${n}`);
    console.log(`\nСтоимость прогона (по балансу кабинета neuroapi):`);
    if (run.cost.usd != null) {
      console.log(`  списано: $${run.cost.usd.toFixed(5)}` +
        (run.cost.rub != null ? ` ≈ ${run.cost.rub} ₽ (курс ${run.cost.rate})` : ' (для рублей задайте AI_USD_RUB в .env)'));
      console.log(`  баланс: $${run.cost.balance_before_usd?.toFixed(4)} → $${run.cost.balance_after_usd?.toFixed(4)}`);
    } else {
      console.log('  не удалось получить баланс кабинета (эндпоинт биллинга недоступен)');
    }
    const u = run.usage;
    const inShare = u.total_tokens ? ((u.prompt_tokens / u.total_tokens) * 100).toFixed(1) : '—';
    console.log(`Токены (справочно, счётчик прокси недостоверен):`);
    console.log(`  prompt (вход) ${u.prompt_tokens.toLocaleString('ru-RU')} — ${inShare}% от всего`);
    console.log(`  completion (выход) ${u.completion_tokens.toLocaleString('ru-RU')}`);
    console.log(`  всего ${u.total_tokens.toLocaleString('ru-RU')}`);
    console.log(`Tool-вызовов: ${run.toolCalls}`);
  } catch (err) {
    console.error(`\n❌ ${err.message}`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}
