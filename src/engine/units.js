/**
 * Детерминированная проверка единиц измерения позиции (задача 1 доработок).
 *
 * Баг, который это закрывает: единица КП «м²», единица нормы «100 м²» —
 * визуально «та же», и модель не считает их расхождением. Объём КП (91)
 * берётся как есть на норму «100 м²» → завышение в 100 раз. Проверка должна
 * быть в коде и не зависеть от мнения модели.
 *
 * Тот же класс дефекта, что т/кг внутри нормы на этапе 4 (занижение в 1000
 * раз). Там защита в движке на уровне ресурса стоит; здесь — на уровне объёма
 * позиции.
 *
 * Правило: нормализуем множитель (100, 1000) и базовую единицу; при ЛЮБОМ
 * расхождении (множитель или база) — несовпадение, молча не пересчитываем.
 * Блокировку принимает вызывающий код; здесь только детекция.
 */

/** Синонимы базовых единиц → канон. Кириллица/латиница, точки, регистр сняты. */
const BASE_SYNONYMS = new Map([
  ['м2', 'м2'], ['м²', 'м2'], ['квм', 'м2'], ['кв.м', 'м2'], ['кв.м.', 'м2'], ['m2', 'м2'],
  ['м3', 'м3'], ['м³', 'м3'], ['куб.м', 'м3'], ['куб.м.', 'м3'], ['m3', 'м3'],
  ['м', 'м'], ['мп', 'м'], ['м.п.', 'м'], ['пог.м', 'м'], ['пм', 'м'], ['мпог', 'м'],
  ['шт', 'шт'], ['штук', 'шт'], ['шт.', 'шт'],
  ['т', 'т'], ['тн', 'т'], ['тонн', 'т'],
  ['кг', 'кг'],
  ['компл', 'компл'], ['комп', 'компл'], ['комплект', 'компл'],
]);

/**
 * Разбирает единицу на { factor, base }.
 *   «100 м2»        → { factor: 100,  base: 'м2' }
 *   «1000 м»        → { factor: 1000, base: 'м' }
 *   «м.п.»          → { factor: 1,    base: 'м' }
 *   «100 отверстий» → { factor: 100,  base: 'отверстий' }
 * Ведущий множитель — только степень десятки (1/10/100/1000), как в ГЭСН.
 */
export function parseUnit(raw) {
  if (raw === null || raw === undefined) return { factor: null, base: null, raw };
  let s = String(raw).trim().toLowerCase().replace(/\s+/g, ' ');
  let factor = 1;
  const m = s.match(/^(\d+)\s+(.+)$/);
  if (m) { factor = Number(m[1]); s = m[2].trim(); }
  // канон базовой единицы: сначала точное совпадение по словарю, иначе — как есть
  const compact = s.replace(/\s/g, '');
  const base = BASE_SYNONYMS.get(compact) ?? BASE_SYNONYMS.get(s) ?? s;
  return { factor, base, raw };
}

/**
 * Сравнивает единицу из КП с единицей нормы.
 * @returns {{match, factorQuote, factorNorm, baseQuote, baseNorm, ratio, reason}}
 *   match === true  — единицы совпадают, объём КП можно брать как есть;
 *   match === false — расхождение, объём нужно вводить в единицах нормы.
 *   ratio — во сколько раз норма крупнее КП по множителю (norm/quote), если
 *           базы совпали (для подсказки пересчёта).
 */
export function compareUnits(quoteUnit, normUnit) {
  const q = parseUnit(quoteUnit);
  const n = parseUnit(normUnit);

  // единицы неизвестны — не блокируем (нечего сравнивать), но и не подтверждаем
  if (!q.base || !n.base) {
    return { match: null, factorQuote: q.factor, factorNorm: n.factor, baseQuote: q.base, baseNorm: n.base, ratio: null, reason: 'единица не распознана' };
  }

  const sameBase = q.base === n.base;
  const sameFactor = q.factor === n.factor;
  const match = sameBase && sameFactor;

  let reason = null;
  if (!sameBase) reason = `разные единицы: «${q.base}» ≠ «${n.base}»`;
  else if (!sameFactor) reason = `кратность: «${quoteUnit}» ↔ «${normUnit}» (в ${n.factor / q.factor} раз)`;

  return {
    match,
    factorQuote: q.factor,
    factorNorm: n.factor,
    baseQuote: q.base,
    baseNorm: n.base,
    ratio: sameBase ? n.factor / q.factor : null,
    reason,
  };
}
