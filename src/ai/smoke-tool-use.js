import { aiConfig, createClient, describeConfig } from './config.js';
import { isMain } from '../db/index.js';

/**
 * Шаг 0 ТЗ этапа 5: smoke-тест function calling через прокси neuroapi.
 *
 * Агрегаторы транслируют tool use между форматами провайдеров, и для
 * не-OpenAI моделей это ломается по-разному: теряются tool_calls, приходит
 * текст вместо структурированного вызова, не принимается роль "tool".
 * Пайплайн на непроверенном звене не строим — сначала убеждаемся, что
 * конкретная модель через конкретный прокси отдаёт корректный tool_call
 * и принимает результат инструмента.
 *
 * Проверяются четыре вещи:
 *   1. модель вообще отвечает (эндпоинт и ключ рабочие);
 *   2. на запрос, требующий инструмента, приходит tool_call, а не текст;
 *   3. аргументы tool_call — валидный JSON с ожидаемым полем;
 *   4. модель принимает ответ роли "tool" и делает из него финальный вывод.
 */

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_norms',
      description:
        'Поиск сметных норм ГЭСН по текстовому запросу. Возвращает список найденных норм с кодами.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Поисковый запрос терминологией ГЭСН, например «устройство пароизоляции»',
          },
        },
        required: ['query'],
      },
    },
  },
];

/** Заглушка инструмента: фиксированный ответ, реальный поиск здесь не нужен. */
function fakeSearchNorms(args) {
  return {
    query: args?.query ?? null,
    results: [
      { base_type: 'ГЭСН', code: '12-01-015-03', name: 'Устройство пароизоляции: прокладочной в один слой', unit: '100 м2' },
    ],
  };
}

const check = (ok, text) => ({ ok, text });

export async function runSmokeTest({ model = aiConfig.model, log = console.log } = {}) {
  const checks = [];
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const addUsage = (u) => {
    if (!u) return;
    usage.prompt_tokens += u.prompt_tokens ?? 0;
    usage.completion_tokens += u.completion_tokens ?? 0;
    usage.total_tokens += u.total_tokens ?? 0;
  };

  const client = await createClient();
  const messages = [
    {
      role: 'system',
      content: 'Ты инженер-сметчик. Для подбора норм ГЭСН обязательно используй инструмент search_norms, не отвечай по памяти.',
    },
    { role: 'user', content: 'Найди норму ГЭСН на устройство пароизоляции прокладочной в один слой.' },
  ];

  // --- 1-2. запрос, требующий инструмента ---------------------------------
  const first = await client.chat.completions.create({
    model,
    messages,
    tools: TOOLS,
    tool_choice: 'auto',
  });
  addUsage(first.usage);

  const message = first.choices?.[0]?.message;
  checks.push(check(Boolean(message), '1. Модель ответила через прокси'));

  const toolCalls = message?.tool_calls ?? [];
  checks.push(check(
    toolCalls.length > 0,
    `2. Пришёл tool_call, а не текст${toolCalls.length ? '' : ` (получено: ${JSON.stringify(message?.content ?? '').slice(0, 160)})`}`
  ));
  if (!toolCalls.length) return { ok: false, checks, usage, model };

  // --- 3. аргументы разбираются ------------------------------------------
  const call = toolCalls[0];
  let args = null;
  let parseError = null;
  try {
    args = JSON.parse(call.function.arguments);
  } catch (err) {
    parseError = err.message;
  }
  checks.push(check(
    args !== null && typeof args.query === 'string' && args.query.length > 0,
    `3. Аргументы — валидный JSON с полем query` +
      (parseError ? ` (ошибка разбора: ${parseError})` : ` → ${JSON.stringify(args)}`)
  ));
  checks.push(check(
    call.function.name === 'search_norms',
    `3a. Имя инструмента сохранилось: ${call.function.name}`
  ));

  // --- 4. модель принимает результат инструмента ---------------------------
  messages.push(message);
  messages.push({
    role: 'tool',
    tool_call_id: call.id,
    content: JSON.stringify(fakeSearchNorms(args)),
  });

  const second = await client.chat.completions.create({ model, messages, tools: TOOLS });
  addUsage(second.usage);
  const finalText = second.choices?.[0]?.message?.content ?? '';
  checks.push(check(
    finalText.includes('12-01-015-03'),
    `4. Модель приняла результат роли "tool" и использовала его` +
      (finalText ? ` → «${finalText.replace(/\s+/g, ' ').slice(0, 180)}»` : ' (пустой ответ)')
  ));

  const ok = checks.every((c) => c.ok);
  void log;
  return { ok, checks, usage, model, finalText };
}

if (isMain(import.meta.url)) {
  const model = process.argv[2] || aiConfig.model;
  console.log('Конфигурация:', JSON.stringify(describeConfig(), null, 2));
  console.log(`\nSmoke-тест tool use, модель: ${model}\n`);
  try {
    const result = await runSmokeTest({ model });
    for (const c of result.checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.text}`);
    console.log(`\nТокены: prompt ${result.usage.prompt_tokens}, completion ${result.usage.completion_tokens},` +
      ` всего ${result.usage.total_tokens}`);
    console.log(result.ok
      ? '\nИТОГ: tool use через прокси работает — можно строить пайплайн.'
      : '\nИТОГ: tool use нестабилен. Смените AI_MODEL и повторите; если ни одна модель не проходит — нужен fallback-режим без native tool use (раздел 2 ТЗ).');
    process.exitCode = result.ok ? 0 : 1;
  } catch (err) {
    console.error(`\n❌ Не удалось выполнить запрос: ${err.message}`);
    process.exitCode = 1;
  }
}
