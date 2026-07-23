import { stemRu, tokenize } from './stem-ru.js';

/**
 * Поиск по справочнику материалов ФСБЦ (новый примитив для сценария Б:
 * сопоставление материалов КП подрядчика с кодами ФСБЦ).
 *
 * Отдельно от поиска норм: у материалов свой корпус (45 437 записей), а
 * запросы — торговые названия («Гранит Articshok Silver», «эпоксидный клей
 * Litokol»), где важны и латиница с цифрами (марки), и русские слова.
 * FTS-таблицы под материалы нет, поэтому идём по LIKE, но с той же основой,
 * что и поиск норм: стемминг каждого слова + ранжирование по числу
 * совпавших слов и по тому, встретилось ли слово целиком.
 */
// Частотные слова, которые сами по себе ничего не сужают: в торговых
// названиях КП их полно, а в ФСБЦ они матчат что угодно.
const STOPWORDS = new Set([
  'для', 'под', 'из', 'на', 'по', 'при', 'без', 'над', 'от', 'до', 'со', 'об',
  'все', 'весь', 'вся', 'всех', 'тип', 'вид', 'шт', 'кг', 'мм', 'см', 'готовый',
]);

export function searchMaterials(db, input, limit = 20) {
  const raw = String(input ?? '').trim();
  if (raw.length < 2) return { materials: [] };

  // Латиница/цифры (марки, артикулы) — как есть; русские слова — по основе.
  // Стоп-слова и обрывки короче 3 букв в матчинг не идут.
  const terms = tokenize(raw)
    .filter((t) => !STOPWORDS.has(t) && t.length >= 3)
    .map((t) => (/[a-z0-9]/i.test(t) ? t : stemRu(t)));
  if (!terms.length) return { materials: [] };

  // Двухуровневый отбор кандидатов. Слепой `LIKE ... OR ... LIMIT` отсекал бы
  // строки по табличному порядку до ранжирования и терял релевантные (частые
  // слова вроде «основ» набивают лимит первыми попавшимися). Поэтому сначала
  // берём строки, где есть ВСЕ слова запроса (их мало, они точные), затем
  // добираем по любому слову до общего потолка.
  const likeParams = terms.map((t) => `%${t}%`);
  const rowsByCode = new Map();
  const collect = (sql, params) => {
    for (const row of db.prepare(sql).all(...params)) rowsByCode.set(row.code, row);
  };
  const cols = 'code, name, category, measure_unit, cost, opt_cost';
  if (terms.length > 1) {
    const andWhere = terms.map(() => 'lower(name) LIKE ?').join(' AND ');
    collect(`SELECT ${cols} FROM materials WHERE ${andWhere} LIMIT 400`, likeParams);
  }
  const orWhere = terms.map(() => 'lower(name) LIKE ?').join(' OR ');
  collect(`SELECT ${cols} FROM materials WHERE ${orWhere} LIMIT 2000`, likeParams);
  const rows = [...rowsByCode.values()];

  const lc = (s) => String(s).toLowerCase().replace(/ё/g, 'е');
  const scored = rows.map((row) => {
    const name = lc(row.name);
    const words = name.split(/[^0-9a-zа-я]+/i);
    let covered = 0;   // сколько РАЗНЫХ слов запроса нашлось (главное)
    let quality = 0;   // как именно нашлись — для тонкой сортировки
    for (const term of terms) {
      if (words.some((w) => w === term)) { covered++; quality += 3; }
      else if (words.some((w) => w.startsWith(term))) { covered++; quality += 2; }
      else if (name.includes(term)) { covered++; quality += 1; }
    }
    return { row, covered, quality };
  });

  // Сначала по числу совпавших слов запроса, затем по качеству совпадения,
  // затем более короткое (обычно более общее) название выше.
  scored.sort((a, b) =>
    b.covered - a.covered || b.quality - a.quality || a.row.name.length - b.row.name.length);
  return { materials: scored.slice(0, limit).map((s) => s.row) };
}
