import { createClient, describeConfig, aiConfig } from './config.js';
import { isMain } from '../db/index.js';

/**
 * Список моделей, доступных по ключу.
 *
 * Документация neuroapi перечисляет только эндпоинты и приводит примеры
 * (`gpt-4-turbo`, `dall-e-3`), а каталог моделей зависит от тарифа. Вместо
 * угадывания идентификатора спрашиваем его у самого API: `/v1/models` —
 * часть OpenAI-совместимого контракта.
 */
export async function listModels() {
  const client = await createClient();
  const res = await client.models.list();
  const models = [];
  for await (const m of res) models.push(m.id);
  return models.sort();
}

/** Модели, пригодные для подбора норм: чат с function calling, не картинки. */
export function pickChatModels(ids) {
  const skip = /(dall-e|image|whisper|tts|embed|moder|rerank|audio|video|flux|midjourney|sora|kandinsky)/i;
  return ids.filter((id) => !skip.test(id));
}

if (isMain(import.meta.url)) {
  console.log('Конфигурация:', JSON.stringify(describeConfig(), null, 2));
  try {
    const all = await listModels();
    const chat = pickChatModels(all);
    console.log(`\nВсего моделей по ключу: ${all.length}, из них пригодных для чата: ${chat.length}\n`);

    const families = { Claude: /claude/i, GPT: /^(gpt|o[1-4])/i, Gemini: /gemini/i, 'Прочие': /.*/ };
    const shown = new Set();
    for (const [title, re] of Object.entries(families)) {
      const list = chat.filter((id) => !shown.has(id) && re.test(id));
      list.forEach((id) => shown.add(id));
      if (!list.length) continue;
      console.log(`  ${title}:`);
      for (const id of list) console.log(`    ${id}${id === aiConfig.model ? '   ← AI_MODEL в .env' : ''}`);
    }

    if (!chat.includes(aiConfig.model)) {
      console.log(`\n⚠ Модель «${aiConfig.model}» из .env отсутствует в списке — впишите в AI_MODEL один из идентификаторов выше.`);
    }
  } catch (err) {
    console.error(`\n❌ Не удалось получить список моделей: ${err.message}`);
    process.exitCode = 1;
  }
}
