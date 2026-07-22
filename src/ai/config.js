import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.join(here, '../../.env'), quiet: true });

/**
 * Конфигурация AI-слоя. Провайдер — neuroapi.host, OpenAI-совместимый
 * агрегатор, поэтому SDK берём `openai` с кастомным baseURL (см. раздел 2 ТЗ
 * этапа 5: `@anthropic-ai/sdk` с этим эндпоинтом несовместим).
 *
 * Ключ живёт только в .env, который в .gitignore. В логи, отчёты и ошибки
 * он не попадает: наружу отдаётся лишь факт наличия.
 */
export const aiConfig = {
  apiKey: process.env.AI_API_KEY || null,
  baseURL: process.env.AI_BASE_URL || 'https://neuroapi.host/v1',
  model: process.env.AI_MODEL || 'claude-sonnet-4-5',
};

export const aiEnabled = () => Boolean(aiConfig.apiKey);

/** Причина, по которой AI-функции недоступны — для показа в интерфейсе. */
export function aiDisabledReason() {
  if (aiConfig.apiKey) return null;
  return 'AI-функции отключены: не задан AI_API_KEY в .env (см. .env.example). ' +
    'Поиск, расчёт и экспорт работают без сети как раньше.';
}

/** Клиент OpenAI-SDK, направленный на прокси. Бросает, если ключа нет. */
export async function createClient() {
  if (!aiConfig.apiKey) throw new Error(aiDisabledReason());
  const { default: OpenAI } = await import('openai');
  return new OpenAI({ apiKey: aiConfig.apiKey, baseURL: aiConfig.baseURL });
}

/** Безопасное описание конфигурации: ключ маскируется. */
export function describeConfig() {
  return {
    baseURL: aiConfig.baseURL,
    model: aiConfig.model,
    apiKey: aiConfig.apiKey ? `задан (${aiConfig.apiKey.length} символов)` : 'не задан',
  };
}
