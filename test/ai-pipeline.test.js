import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { parseModelJson } from '../src/ai/pipeline.js';
import { executeTool, TOOL_SCHEMAS } from '../src/ai/tools.js';
import { searchMaterials } from '../src/search/materials.js';

const db = openDb();

// Пайплайн-тесты не ходят в сеть: проверяются чистые функции (разбор ответа,
// инструменты поверх БД, поиск материалов). Сам прогон модели — в отчёте
// контрольной точки, а не в CI (стоит токенов и требует ключа).

test('parseModelJson: голый массив, обёртка items, ```json-блок', () => {
  assert.deepEqual(parseModelJson('[{"item_no":"1.1"}]'), [{ item_no: '1.1' }]);
  assert.deepEqual(parseModelJson('{"items":[{"item_no":"1.2"}]}'), [{ item_no: '1.2' }]);
  assert.deepEqual(
    parseModelJson('```json\n[{"item_no":"1.3","status":"matched"}]\n```'),
    [{ item_no: '1.3', status: 'matched' }]
  );
  // текст вокруг JSON-массива
  assert.deepEqual(parseModelJson('Вот результат:\n[{"item_no":"1.4"}]\nГотово'), [{ item_no: '1.4' }]);
  assert.equal(parseModelJson('совсем не json'), null);
  assert.equal(parseModelJson(''), null);
});

test('схемы инструментов валидны для function calling', () => {
  const names = TOOL_SCHEMAS.map((t) => t.function.name);
  assert.deepEqual(names.sort(), ['get_norm_details', 'search_materials', 'search_norms']);
  for (const t of TOOL_SCHEMAS) {
    assert.equal(t.type, 'function');
    assert.ok(t.function.parameters.required.length > 0);
  }
});

test('search_norms возвращает нормы и фильтрует по base_type', () => {
  const r = executeTool(db, 'search_norms', { query: 'устройство пароизоляции' });
  assert.ok(r.norms.some((n) => n.code === '12-01-015-03' && n.base_type === 'ГЭСН'));

  const filtered = executeTool(db, 'search_norms', { query: '12-01-015-03', base_type: 'ГЭСНм' });
  assert.ok(filtered.norms.every((n) => n.base_type === 'ГЭСНм'));
});

test('get_norm_details даёт состав работ и ресурсы', () => {
  const d = executeTool(db, 'get_norm_details', { base_type: 'ГЭСН', code: '12-01-015-03' });
  assert.equal(d.measure_unit, '100 м2');
  assert.equal(d.nr_code, 'Пр/812-012.0');
  assert.ok(d.content.includes('пароизоляц') || d.content.includes('изоляц'));
  assert.ok(d.resources.some((r) => r.abstract));       // абстрактная мастика
  assert.ok(d.resources.some((r) => r.type === 'machine'));
});

test('get_norm_details по несуществующей норме возвращает error, а не бросает', () => {
  const d = executeTool(db, 'get_norm_details', { base_type: 'ГЭСН', code: 'нет-такой' });
  assert.ok(d.error);
});

test('search_materials находит по обобщённому названию, игнорируя стоп-слова', () => {
  const r = executeTool(db, 'search_materials', { query: 'мастика гидроизоляционная' });
  assert.ok(r.materials.length > 0);
  assert.ok(r.materials[0].name.toLowerCase().includes('мастик'));

  // «для» и «из» не должны раздувать выдачу мусором на первое место
  const epoxy = searchMaterials(db, 'клей на эпоксидной основе', 5).materials;
  assert.ok(epoxy.some((m) => m.name.toLowerCase().includes('эпоксид')));
});

test('неизвестный инструмент возвращает error', () => {
  assert.ok(executeTool(db, 'нет_такого', {}).error);
});

test.after(() => db.close());
