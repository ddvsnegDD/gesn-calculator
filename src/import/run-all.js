import fs from 'node:fs';
import path from 'node:path';
import { createDb, DATA_DIR, isMain } from '../db/index.js';
import { importMaterials, importMachines } from './import-fsbc.js';
import { importGesn } from './import-gesn.js';
import { importTechnologyGroups, importTgWorkLinks } from './import-tg.js';
import { importCoefficients } from './import-coefficients.js';
import { importNormsCsv } from './import-norms-csv.js';
import { importSplitForm } from './import-split-form.js';
import { buildSearchIndex } from '../search/build-index.js';

/** Ищет сплит-форму в data/ — имя меняется каждый квартал. */
function findSplitForm(dataRoot) {
  if (!fs.existsSync(dataRoot)) return null;
  const hit = fs.readdirSync(dataRoot).find((f) => /^Сплит-форма.*\.xlsx$/i.test(f) && !f.startsWith('~$'));
  return hit ? path.join(dataRoot, hit) : null;
}

const step = async (label, fn) => {
  const t0 = Date.now();
  process.stdout.write(`${label}... `);
  const res = await fn();
  console.log(`готово за ${((Date.now() - t0) / 1000).toFixed(1)} с`);
  return res;
};

/**
 * Полный импорт справочников в порядке раздела 4.6 ТЗ.
 * Порядок обязателен: resource_type в work_resources определяется по уже
 * загруженным materials/machines, поэтому нормы идут третьим шагом.
 */
export async function runAll({ dataDir = DATA_DIR, splitForm } = {}) {
  const db = createDb();
  const stats = {};

  stats.materials = await step('1/8 материалы и оборудование', () => importMaterials(db, dataDir));
  stats.machines = await step('2/8 машины и механизмы', () => importMachines(db, dataDir));
  stats.gesn = await step('3/8 нормы (5 файлов ГЭСН)', () => importGesn(db, dataDir));
  stats.tg = await step('4/8 технологические группы', () => importTechnologyGroups(db, dataDir));
  stats.tgLinks = await step('5/8 ключи перехода ТГ', () => importTgWorkLinks(db, dataDir));
  stats.coefficients = await step('6/8 поправочные коэффициенты', () => importCoefficients(db, dataDir));
  stats.norms = await step('8/8 нормативы НР и СП из CSV', () => importNormsCsv(db));
  stats.search = await step('поисковый индекс (стеммы, словарь, синонимы)', () => buildSearchIndex(db));

  const split = splitForm ?? findSplitForm(path.dirname(dataDir) === '.' ? dataDir : path.resolve(dataDir, '..'));
  if (split) {
    stats.split = await step(`7/8 сплит-форма (${path.basename(split)})`, () => importSplitForm(db, split));
  } else {
    console.log('7/8 сплит-форма — файл не найден, пропущено (загрузите через import-split-form.js)');
  }

  db.exec('ANALYZE');
  db.close();
  return stats;
}

if (isMain(import.meta.url)) {
  const t0 = Date.now();
  const stats = await runAll({ splitForm: process.argv[2] });
  console.log(`\nИмпорт завершён за ${((Date.now() - t0) / 1000).toFixed(1)} с`);
  console.log(JSON.stringify(stats, null, 2));
}
