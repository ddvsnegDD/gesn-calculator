import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { stemRu, normalizeStem } from '../src/search/stem-ru.js';
import { searchWorks, buildQuery, levenshtein, trigrams, hasSearchIndex } from '../src/search/query.js';

const db = openDb();

const found = (q) => searchWorks(db, q, 20).works;
const names = (q) => found(q).map((w) => w.name_full.toLowerCase());

test('поисковый индекс построен', () => {
  assert.ok(hasSearchIndex(db), 'запустите npm run index');
  assert.ok(db.prepare('SELECT COUNT(*) FROM search_vocab').pluck().get() > 10000);
});

test('стеммер сводит падежные формы к одной основе', () => {
  assert.equal(stemRu('устройства'), stemRu('устройство'));
  assert.equal(stemRu('бетона'), stemRu('бетонных'));
  assert.equal(stemRu('гидроизоляции'), stemRu('гидроизоляцию'));
  assert.equal(stemRu('12'), '12');            // цифры не трогаем
  assert.equal(stemRu('ПВХ'.toLowerCase()), 'пвх');
});

test('levenshtein и триграммы', () => {
  assert.equal(levenshtein('металическ', 'металлическ'), 1);
  assert.equal(levenshtein('кот', 'собака', 2), 3);       // отсечка
  assert.deepEqual(trigrams('абвг'), ['абв', 'бвг']);
});

test('провал 1: опечатка «металических» находит металлические конструкции', () => {
  const hits = names('металических конструкций');
  assert.ok(hits.length > 0, 'ничего не найдено');
  assert.ok(hits.some((n) => n.includes('металлическ')), `нет металлических: ${hits[0]}`);
  const { terms } = buildQuery(db, 'металических');
  assert.equal(terms[0].corrected, 'металлическ');
});

test('провал 2: падежная форма «гранита» находит гранитные работы', () => {
  assert.ok(names('гранита').length > 0);
  assert.ok(names('гидроизоляции').length > 0);
  // родительный падеж даёт те же нормы, что и именительный
  const a = new Set(found('гидроизоляция').map((w) => w.code));
  const b = found('гидроизоляции').map((w) => w.code);
  assert.ok(b.some((code) => a.has(code)), 'падежные формы дают разные результаты');
});

test('провал 3: синоним «демонтаж» находит нормы со словом «разборка»', () => {
  const hits = names('демонтаж перегородок');
  assert.ok(hits.length > 0, 'ничего не найдено');
  assert.ok(hits.some((n) => n.includes('разборка')), `нет разборки: ${hits[0]}`);
  const { terms } = buildQuery(db, 'демонтаж');
  assert.ok(terms[0].synonyms.includes(stemRu('разборка')));
});

test('точный поиск по коду не сломан', () => {
  const hits = found('12-01-015-03');
  assert.ok(hits.some((w) => w.base_type === 'ГЭСН' && w.code === '12-01-015-03'));
  assert.ok(hits.some((w) => w.base_type === 'ГЭСНм' && w.code === '12-01-015-03'));
});

test('осмысленный запрос из названия по-прежнему находит норму', () => {
  const hits = found('устройство пароизоляции');
  assert.ok(hits.some((w) => w.code === '12-01-015-03'));
});

test('мусорный запрос не роняет поиск и не выдумывает результаты', () => {
  assert.deepEqual(searchWorks(db, 'ыыыжщщ').works, []);
  assert.deepEqual(searchWorks(db, '"((*').works, []);
  assert.deepEqual(searchWorks(db, 'a').works, []);
});

test('беглая гласная: «стяжки» находит норму со «стяжек»', () => {
  assert.equal(stemRu('стяжки'), stemRu('стяжек'));
  assert.equal(stemRu('перегородки'), stemRu('перегородок'));
  assert.equal(stemRu('доски'), stemRu('досок'));
  // короткие слова правило не трогает
  assert.equal(normalizeStem('блок'), 'блок');
  assert.equal(normalizeStem('сок'), 'сок');

  const hits = names('демонтаж стяжки');
  assert.ok(hits.length > 0, 'ничего не найдено');
  assert.ok(hits.some((n) => n.includes('стяжек')), `нет стяжек: ${hits[0]}`);
});

test('переранжирование поднимает совпадения по слову над совпадениями по основе', () => {
  // «гранит» стеммируется в «гран», из-за чего в выдачу попадает
  // «гранулирование»; наверху должны быть гранитные работы
  const top = names('гранит').slice(0, 3);
  assert.ok(top.length > 0);
  assert.ok(top.every((n) => n.includes('гранит')), `в топе не гранит: ${top.join(' | ')}`);
});

test('синоним «окраска» находит «окрашивание»', () => {
  const hits = names('окраска потолков');
  assert.ok(hits.some((n) => n.includes('окрашивание') || n.includes('окраска')));
});

test.after(() => db.close());
