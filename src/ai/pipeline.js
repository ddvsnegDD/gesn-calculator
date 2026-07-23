import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aiConfig, createClient } from './config.js';
import { TOOL_SCHEMAS, executeTool } from './tools.js';
import { parseVedomost, flattenItems } from './parse-vedomost.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const RUNS_DIR = path.join(here, '../../runs');
const SYSTEM_PROMPT = fs.readFileSync(path.join(here, 'prompts/match-system.md'), 'utf8');

const BATCH_SIZE = 6;          // позиций за вызов (ТЗ: 5-8)
const MAX_TOOL_CALLS = 50;     // потолок tool-вызовов на батч (6 позиций × ~5 вызовов + запас)
const BATCH_TIMEOUT_MS = 180_000;

/** Пишет одну строку JSONL в лог прогона. */
function makeLogger(runId) {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  const file = path.join(RUNS_DIR, `${runId}.jsonl`);
  const stream = fs.createWriteStream(file, { flags: 'a' });
  return {
    file,
    write: (event) => stream.write(JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n'),
    close: () => new Promise((r) => stream.end(r)),
  };
}

/** Достаёт JSON-массив позиций из ответа модели (снимает ```json-обёртку). */
export function parseModelJson(text) {
  if (!text) return null;
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // иногда модель оборачивает в объект { items: [...] }, иногда даёт голый массив
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.items)) return parsed.items;
    return null;
  } catch {
    // последняя попытка: выдрать первый [...]-блок
    const arr = s.match(/\[[\s\S]*\]/);
    if (arr) { try { return JSON.parse(arr[0]); } catch { /* пусто */ } }
    return null;
  }
}

/**
 * Приводит ответ модели к инвариантам, не зависящим от того, как модель
 * поняла промт: matched/uncertain без кандидата понижается до uncertain с
 * пометкой (не выдумываем норму), а лишние поля у out_of_scope убираются.
 */
export function sanitizeItem(item) {
  const out = { ...item };
  const hasCandidate = Array.isArray(out.candidates) && out.candidates.length > 0;
  if ((out.status === 'matched' || out.status === 'uncertain') && !hasCandidate) {
    out.status = 'uncertain';
    out.candidates = [];
    out.notes = `${out.notes ? out.notes + ' ' : ''}[норма не найдена — требует ручного подбора]`;
  }
  if (out.status === 'out_of_scope') delete out.candidates;
  return out;
}

const addUsage = (acc, u) => {
  if (!u) return;
  acc.prompt_tokens += u.prompt_tokens ?? 0;
  acc.completion_tokens += u.completion_tokens ?? 0;
  acc.total_tokens += u.total_tokens ?? 0;
};

/** Прогоняет один батч позиций через модель с tool use. */
async function runBatch(client, db, log, { model, vedomostContext, batch, batchIndex }) {
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `Контекст всей ведомости (для понимания, что это за смета в целом):\n` +
        `${JSON.stringify(vedomostContext, null, 2)}\n\n` +
        `Подбери нормы ГЭСН для СЛЕДУЮЩИХ ${batch.length} позиций. Для каждой сверяй ` +
        `состав работ через get_norm_details. Верни JSON с полем items — массивом ` +
        `по одному объекту на позицию строго в описанном формате:\n` +
        `${JSON.stringify(batch, null, 2)}`,
    },
  ];

  let toolCallCount = 0;
  const deadline = Date.now() + BATCH_TIMEOUT_MS;

  for (let round = 0; ; round++) {
    if (Date.now() > deadline) throw new Error(`таймаут батча ${batchIndex} (${BATCH_TIMEOUT_MS} мс)`);

    // Достигнут потолок вызовов — не роняем батч, а требуем финальный ответ
    // без инструментов из того, что уже собрано. tool_choice:
    //   round 0 — 'required': без принуждения модель отвечает по памяти и
    //     галлюцинирует коды (проверено — выдавала несуществующий 10-01-056-04);
    //   лимит достигнут — 'none': инструменты недоступны, только ответ;
    //   иначе — 'auto': даём завершить, когда данных набрано.
    const forceFinish = toolCallCount >= MAX_TOOL_CALLS;
    const response = await client.chat.completions.create({
      model,
      messages,
      tools: TOOL_SCHEMAS,
      tool_choice: forceFinish ? 'none' : round === 0 ? 'required' : 'auto',
    });
    addUsage(usage, response.usage);
    const message = response.choices?.[0]?.message;
    log.write({ type: 'assistant', batch: batchIndex, round, content: message?.content ?? null, tool_calls: message?.tool_calls ?? null, forced_finish: forceFinish || undefined });

    const toolCalls = message?.tool_calls ?? [];
    if (!toolCalls.length) {
      const items = parseModelJson(message?.content);
      if (!items) throw new Error(`батч ${batchIndex}: не удалось разобрать JSON ответа модели`);
      return { items, usage, toolCalls: toolCallCount, hitLimit: forceFinish };
    }

    messages.push(message);
    for (const call of toolCalls) {
      toolCallCount++;
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* пустые аргументы */ }
      const result = executeTool(db, call.function.name, args);
      log.write({ type: 'tool', batch: batchIndex, round, name: call.function.name, args, result_summary: summarize(result) });
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
}

/** Короткая сводка результата инструмента для лога (не весь массив). */
function summarize(result) {
  if (result?.error) return { error: result.error };
  if (result?.norms) return { count: result.count, first: result.norms[0]?.code };
  if (result?.materials) return { count: result.count, first: result.materials[0]?.code };
  if (result?.code) return { code: result.code, resources: result.resources?.length };
  return {};
}

/**
 * Прогон подбора по одному листу ведомости.
 * Позиции идут батчами; сбой батча не роняет прогон — его позиции получают
 * status "error" и помечаются в результате, остальные батчи продолжаются.
 */
export async function runMatching(db, sheet, { model = aiConfig.model, batchSize = BATCH_SIZE, runId } = {}) {
  const id = runId || `${new Date().toISOString().replace(/[:.]/g, '-')}_${sheet.sheet}`;
  const log = makeLogger(id);
  const client = await createClient();

  const items = flattenItems(sheet);
  const vedomostContext = {
    sheet: sheet.sheet,
    sections: sheet.sections.map((s) => ({ name: s.name, positions: s.items.length })),
    totals: sheet.totals,
  };

  log.write({ type: 'run_start', run_id: id, model, sheet: sheet.sheet, items: items.length });

  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const byNo = new Map();
  let totalToolCalls = 0;

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchIndex = Math.floor(i / batchSize);
    try {
      const res = await runBatch(client, db, log, { model, vedomostContext, batch, batchIndex });
      addUsage(usage, res.usage);
      totalToolCalls += res.toolCalls;
      for (const item of res.items) byNo.set(String(item.item_no), sanitizeItem(item));
    } catch (err) {
      log.write({ type: 'batch_error', batch: batchIndex, error: err.message, items: batch.map((b) => b.no) });
      for (const b of batch) {
        byNo.set(String(b.no), { item_no: b.no, status: 'error', notes: `Сбой батча: ${err.message}` });
      }
    }
  }

  // сшиваем результат модели с исходными данными позиции, сохраняя порядок
  const results = items.map((item) => {
    const match = byNo.get(String(item.no)) ?? { item_no: item.no, status: 'error', notes: 'Позиция не вернулась из модели' };
    return { ...match, source: item };
  });

  log.write({ type: 'run_end', usage, tool_calls: totalToolCalls, matched: results.filter((r) => r.status === 'matched').length });
  await log.close();

  return { runId: id, logFile: log.file, sheet: sheet.sheet, model, results, usage, toolCalls: totalToolCalls };
}

/** Удобная обёртка: разобрать xlsx и прогнать выбранный лист. */
export async function runMatchingFromFile(db, filePath, { sheetName, ...opts } = {}) {
  const { sheets } = await parseVedomost(filePath);
  const sheet = sheetName ? sheets.find((s) => s.sheet === sheetName) : sheets[0];
  if (!sheet) throw new Error(`Лист «${sheetName}» не найден в файле`);
  return runMatching(db, sheet, opts);
}
