import { stemRu, tokenize } from './stem-ru.js';

/** Расстояние Левенштейна с отсечкой: дальше max считать незачем. */
export function levenshtein(a, b, max = 2) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Триграммы слова — для подбора кандидатов на исправление опечатки. */
export function trigrams(word) {
  const out = [];
  for (let i = 0; i + 3 <= word.length; i++) out.push(word.slice(i, i + 3));
  return [...new Set(out)];
}

/** Построен ли поисковый индекс (иначе откатываемся на works_fts). */
export function hasSearchIndex(db) {
  const row = db.prepare(
    `SELECT COUNT(*) FROM sqlite_master WHERE name IN ('works_search','search_vocab','vocab_trigram','search_synonyms')`
  ).pluck().get();
  return row === 4;
}

function prepare(db) {
  return {
    known: db.prepare('SELECT df FROM search_vocab WHERE term = ?').pluck(),
    prefix: db.prepare('SELECT term FROM search_vocab WHERE term LIKE ? LIMIT 1').pluck(),
    synonyms: db.prepare('SELECT alias FROM search_synonyms WHERE term = ?').pluck(),
    candidates: db.prepare(
      `SELECT v.term, s.df FROM vocab_trigram v JOIN search_vocab s ON s.term = v.term
       WHERE vocab_trigram MATCH ? LIMIT 400`
    ),
  };
}

/**
 * Подбор замены для слова, которого нет в словаре: кандидаты берутся по
 * общим триграммам, затем отбираются по расстоянию Левенштейна ≤ 2.
 * Из равных по расстоянию побеждает более частотный термин.
 */
export function correctTerm(q, term) {
  if (term.length < 4) return null;
  const grams = trigrams(term);
  if (!grams.length) return null;
  const match = grams.map((g) => `"${g.replace(/"/g, '')}"`).join(' OR ');

  let rows;
  try {
    rows = q.candidates.all(match);
  } catch {
    return null;
  }

  let best = null;
  for (const row of rows) {
    const dist = levenshtein(term, row.term, 2);
    if (dist > 2) continue;
    // правка не должна перекраивать короткое слово целиком
    if (dist > Math.floor(term.length / 3) + 1) continue;
    if (!best || dist < best.dist || (dist === best.dist && row.df > best.df)) {
      best = { term: row.term, dist, df: row.df };
    }
  }
  return best;
}

/**
 * Собирает выражение FTS5 из пользовательского запроса.
 *
 * Каждое слово превращается в группу вариантов, объединённых через OR:
 *   стем* — падежные формы («гидроизоляции» → «гидроизоляц*»);
 *   исправленный термин — если слова нет в словаре («металических»);
 *   синонимы — «демонтаж» → «разборк», «снят».
 * Группы соединяются через AND: все слова запроса должны быть в норме.
 *
 * Возвращает { match, terms }, где terms — расшифровка для интерфейса.
 */
export function buildQuery(db, input) {
  const q = prepare(db);
  const groups = [];
  const explain = [];

  for (const token of tokenize(input)) {
    const stem = stemRu(token);
    // Исходное слово в запрос НЕ добавляем: стеммер только срезает суффикс,
    // поэтому стем всегда префикс слова и «стем*» уже покрывает «слово*».
    // Лишний вариант ничего не добавляет к отзыву, зато удваивает вес термина
    // в bm25 и переставляет выдачу — из-за чего «гидроизоляция» и
    // «гидроизоляции» давали разные первые двадцать норм.
    const variants = new Set([stem]);

    const known = q.known.get(stem) !== undefined || q.prefix.get(`${stem}%`) !== undefined;
    let corrected = null;
    if (!known) {
      corrected = correctTerm(q, stem);
      if (corrected) variants.add(corrected.term);
    }

    const synonyms = [];
    for (const base of [stem, corrected?.term].filter(Boolean)) {
      for (const alias of q.synonyms.all(base)) {
        variants.add(alias);
        synonyms.push(alias);
      }
    }

    groups.push([...variants].map((v) => `"${v.replace(/"/g, '')}"*`).join(' OR '));
    explain.push({
      token,
      stem,
      corrected: corrected ? corrected.term : null,
      synonyms,
      known,
    });
  }

  if (!groups.length) return { match: null, terms: explain };
  return { match: groups.map((g) => `(${g})`).join(' AND '), terms: explain };
}

const looksLikeCode = (s) => /\d{2}[-.]\d/.test(s);

/**
 * Поднимает нормы, в наименовании которых встретилось слово запроса целиком,
 * над теми, что совпали только по укороченной основе. bm25 об этом не знает:
 * в индексе лежат основы, и «гранулирование» для основы «гран» так же валидно,
 * как «гранитный».
 */
function rerank(rows, terms) {
  const tokens = terms.map((t) => t.token).filter((t) => t.length >= 3);
  if (!tokens.length) return rows;
  return rows
    .map((row) => {
      const name = row.name_full.toLowerCase().replace(/ё/g, 'е');
      const words = name.split(/[^0-9a-zа-я]+/i);
      let bonus = 0;
      for (const token of tokens) {
        if (words.some((w) => w.startsWith(token))) bonus += 2;
        else if (words.some((w) => token.startsWith(w) && w.length >= 4)) bonus += 1;
      }
      return { row, score: row.rank - bonus };
    })
    .sort((a, b) => a.score - b.score)
    .map((x) => x.row);
}

/**
 * Поиск норм: точное и префиксное совпадение по коду плюс полнотекстовый
 * поиск по наименованию со стеммингом, опечатками и синонимами.
 */
export function searchWorks(db, input, limit = 50) {
  const raw = String(input ?? '').trim();
  if (raw.length < 2) return { works: [], terms: [] };

  const works = [];
  const seen = new Set();
  const push = (rows) => {
    for (const w of rows) {
      const key = `${w.base_type}${w.code}`;
      if (seen.has(key)) continue;
      seen.add(key);
      works.push(w);
    }
  };

  if (looksLikeCode(raw)) {
    const bare = raw.replace(/^ГЭСН[а-я]*/i, '').trim();
    push(db.prepare(
      `SELECT base_type, code, name_full, measure_unit, collection_code, collection_name
       FROM works WHERE code = ? OR code LIKE ? ORDER BY base_type, code LIMIT ?`
    ).all(bare, `${bare}%`, limit));
  }

  if (!hasSearchIndex(db)) {
    // индекс не построен — работаем на базовом works_fts из схемы ТЗ
    const tokens = tokenize(raw).map((t) => `"${t}"*`).join(' AND ');
    if (tokens && works.length < limit) {
      try {
        push(db.prepare(
          `SELECT w.base_type, w.code, w.name_full, w.measure_unit, w.collection_code, w.collection_name
           FROM works_fts f JOIN works w ON w.id = f.rowid
           WHERE works_fts MATCH ? ORDER BY rank LIMIT ?`
        ).all(tokens, limit - works.length));
      } catch { /* пустой результат лучше падения */ }
    }
    return { works, terms: [], degraded: true };
  }

  const { match, terms } = buildQuery(db, raw);
  if (match && works.length < limit) {
    let rows = [];
    try {
      // берём с запасом: bm25 ранжирует по основам, а основа из-за
      // «перестеммливания» ловит и посторонние слова («гранит» → «гран» →
      // «гранулирование»). Ниже поднимаем те нормы, где встретилось само
      // слово запроса, а не только его основа.
      rows = db.prepare(
        `SELECT w.base_type, w.code, w.name_full, w.measure_unit,
                w.collection_code, w.collection_name, bm25(works_search) AS rank
         FROM works_search s JOIN works w ON w.id = s.rowid
         WHERE works_search MATCH ? ORDER BY rank LIMIT ?`
      ).all(match, (limit - works.length) * 4);
    } catch (err) {
      // некорректное выражение FTS не должно ронять поиск
      rows = [];
      void err;
    }
    push(rerank(rows, terms).slice(0, limit - works.length));
  }

  return { works, terms };
}
