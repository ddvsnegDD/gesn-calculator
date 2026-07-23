import { aiConfig } from './config.js';

/**
 * Измерение стоимости прогона по балансу кабинета neuroapi (раздел 2 ТЗ,
 * уточнение после шага 0): счётчики токенов у прокси недостоверны и врут
 * по-разному от модели к модели, поэтому цену берём как разницу накопленного
 * расхода `total_usage` до и после прогона.
 *
 * neuroapi реализует OpenAI-совместимый биллинг:
 *   GET /v1/dashboard/billing/usage        → { total_usage } — расход в центах;
 *   GET /v1/dashboard/billing/subscription → { hard_limit_usd } — лимит.
 * Баланс = hard_limit_usd − total_usage/100; стоимость прогона = Δ total_usage.
 *
 * Важное свойство: total_usage обновляется с задержкой (~10-15 с), поэтому
 * замер «после» опрашивается с ретраями, пока значение не сдвинется.
 */

function billingRoot() {
  // baseURL вида https://neuroapi.host/v1 — биллинг тоже под /v1
  return aiConfig.baseURL.replace(/\/+$/, '');
}

async function getJson(path) {
  const res = await fetch(billingRoot() + path, {
    headers: { Authorization: `Bearer ${aiConfig.apiKey}` },
  });
  if (!res.ok) throw new Error(`биллинг ${path}: HTTP ${res.status}`);
  return res.json();
}

/** Накопленный расход в центах (или null, если эндпоинт недоступен). */
export async function getUsageCents() {
  try {
    const data = await getJson('/dashboard/billing/usage');
    return typeof data.total_usage === 'number' ? data.total_usage : null;
  } catch {
    return null;
  }
}

/** Лимит кабинета в долларах (или null). */
export async function getHardLimitUsd() {
  try {
    const data = await getJson('/dashboard/billing/subscription');
    return typeof data.hard_limit_usd === 'number' ? data.hard_limit_usd : null;
  } catch {
    return null;
  }
}

/** Снимок баланса на момент вызова: расход, лимит, остаток — всё в долларах. */
export async function snapshotBalance() {
  const [usageCents, hardLimit] = await Promise.all([getUsageCents(), getHardLimitUsd()]);
  return {
    at: new Date().toISOString(),
    usage_usd: usageCents === null ? null : usageCents / 100,
    limit_usd: hardLimit,
    balance_usd: usageCents === null || hardLimit === null ? null : hardLimit - usageCents / 100,
    _usageCents: usageCents,
  };
}

/**
 * Ждёт, пока total_usage сдвинется относительно baselineCents (расход учтён
 * биллингом с задержкой). Возвращает финальный снимок баланса.
 */
export async function waitForCharge(baselineCents, { attempts = 8, delayMs = 2500 } = {}) {
  if (baselineCents === null) return snapshotBalance();
  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    const cents = await getUsageCents();
    if (cents !== null && cents !== baselineCents) break;
  }
  return snapshotBalance();
}

/**
 * Стоимость прогона по двум снимкам баланса. Курс — только для справки в
 * рублях, задаётся через AI_USD_RUB (иначе рубли не считаются).
 */
export function runCost(before, after) {
  const usd =
    before?._usageCents != null && after?._usageCents != null
      ? (after._usageCents - before._usageCents) / 100
      : null;
  const rate = Number(process.env.AI_USD_RUB) || null;
  return {
    usd,
    rub: usd != null && rate ? Math.round(usd * rate * 100) / 100 : null,
    rate,
    balance_before_usd: before?.balance_usd ?? null,
    balance_after_usd: after?.balance_usd ?? null,
  };
}
