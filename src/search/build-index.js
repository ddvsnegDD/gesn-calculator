import { openDb, isMain, logImport } from '../db/index.js';
import { stemRu, tokenize } from './stem-ru.js';
import { SYNONYM_GROUPS } from './synonyms.js';

export const SEARCH_SCHEMA = `
-- Поисковый индекс наименований норм. В текст кладётся и стем, и исходное
-- слово: стеммер Snowball местами «перебарщивает» («гранит» → «гран»), и
-- хранение обеих форм вместе с префиксным поиском закрывает промахи в обе
-- стороны, не заставляя угадывать нужную длину основы.
DROP TABLE IF EXISTS works_search;
CREATE VIRTUAL TABLE works_search USING fts5(
  text,
  tokenize = "unicode61 remove_diacritics 2"
);

-- Словарь индексных терминов: по нему исправляются опечатки.
DROP TABLE IF EXISTS search_vocab;
CREATE TABLE search_vocab (
  term TEXT PRIMARY KEY,
  df INTEGER NOT NULL          -- в скольких нормах встречается
);

-- Триграммный индекс словаря — быстрый подбор кандидатов на опечатку.
DROP TABLE IF EXISTS vocab_trigram;
CREATE VIRTUAL TABLE vocab_trigram USING fts5(term, tokenize = 'trigram');

-- Синонимы сметной терминологии. Таблица пополняется вручную:
-- INSERT INTO search_synonyms (term, alias) VALUES ('разборка', 'демонтаж');
DROP TABLE IF EXISTS search_synonyms;
CREATE TABLE search_synonyms (
  term TEXT NOT NULL,          -- то, что вводит пользователь (стем)
  alias TEXT NOT NULL,         -- то, что искать дополнительно (стем)
  source TEXT,                 -- 'seed' | 'manual'
  PRIMARY KEY (term, alias)
);
`;

/** Стем + исходное слово, без повторов — то, что попадёт в индекс. */
export function indexTerms(text) {
  const out = [];
  for (const token of tokenize(text)) {
    const stem = stemRu(token);
    out.push(stem);
    if (stem !== token) out.push(token);
  }
  return out;
}

/**
 * Строит поисковый индекс по наименованиям норм: FTS-таблицу со стемами,
 * словарь терминов, триграммный индекс словаря и словарь синонимов.
 * Запускается отдельно от импорта — переиндексация занимает пару секунд.
 */
export function buildSearchIndex(db) {
  const startedAt = new Date().toISOString();
  db.exec(SEARCH_SCHEMA);

  const works = db.prepare('SELECT id, name_full, collection_name FROM works').all();
  const insDoc = db.prepare('INSERT INTO works_search (rowid, text) VALUES (?, ?)');
  const df = new Map();

  db.transaction(() => {
    for (const w of works) {
      const terms = indexTerms(`${w.name_full} ${w.collection_name ?? ''}`);
      insDoc.run(w.id, terms.join(' '));
      for (const t of new Set(terms)) df.set(t, (df.get(t) ?? 0) + 1);
    }
  })();

  const insVocab = db.prepare('INSERT OR REPLACE INTO search_vocab (term, df) VALUES (?, ?)');
  const insTrigram = db.prepare('INSERT INTO vocab_trigram (term) VALUES (?)');
  db.transaction(() => {
    for (const [term, count] of df) {
      // однобуквенные и совсем редкие обрывки в словарь опечаток не нужны
      if (term.length < 3) continue;
      insVocab.run(term, count);
      insTrigram.run(term);
    }
  })();

  const insSyn = db.prepare(
    `INSERT OR IGNORE INTO search_synonyms (term, alias, source) VALUES (?, ?, 'seed')`
  );
  let synonyms = 0;
  db.transaction(() => {
    for (const group of SYNONYM_GROUPS) {
      const stems = group.map((phrase) => tokenize(phrase).map(stemRu));
      for (let i = 0; i < stems.length; i++) {
        for (let j = 0; j < stems.length; j++) {
          if (i === j) continue;
          // синонимы задаются по первому значимому слову фразы
          const a = stems[i][stems[i].length - 1];
          const b = stems[j][stems[j].length - 1];
          if (a && b && a !== b) { insSyn.run(a, b); synonyms++; }
        }
      }
    }
  })();

  const stats = {
    documents: works.length,
    vocabulary: db.prepare('SELECT COUNT(*) FROM search_vocab').pluck().get(),
    synonyms: db.prepare('SELECT COUNT(*) FROM search_synonyms').pluck().get(),
  };
  void synonyms;
  logImport(db, 'search-index', stats.documents, startedAt,
    `словарь ${stats.vocabulary}, синонимов ${stats.synonyms}`);
  return stats;
}

if (isMain(import.meta.url)) {
  const db = openDb();
  const stats = buildSearchIndex(db);
  console.log(`Поисковый индекс построен: норм ${stats.documents.toLocaleString('ru-RU')},` +
    ` словарь ${stats.vocabulary.toLocaleString('ru-RU')} терминов, синонимов ${stats.synonyms}`);
  db.close();
}
