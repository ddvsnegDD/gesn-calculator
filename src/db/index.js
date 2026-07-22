import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const DB_PATH = process.env.GESN_DB || path.join(here, '../../gesn2022.db');

/** Каталог с исходными XML/XLSX. Имена файлов внутри — фактические, с пробелами. */
export const DATA_DIR =
  process.env.GESN_DATA ||
  path.join(here, '../../data/ФСНБ-2022 (приказ Минстроя России от 15.05.2026 года № 301пр)');

export function openDb(file = DB_PATH) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  return db;
}

/** Создаёт БД с нуля по schema.sql. Существующий файл удаляется. */
export function createDb(file = DB_PATH) {
  for (const f of [file, `${file}-wal`, `${file}-shm`]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  const db = openDb(file);
  db.exec(fs.readFileSync(path.join(here, 'schema.sql'), 'utf8'));
  return db;
}

/**
 * Транзакция вокруг асинхронной работы.
 * db.transaction() из better-sqlite3 не принимает async-функции, а импортёры
 * пишут в БД по мере потокового разбора файла — поэтому явные BEGIN/COMMIT.
 */
export async function withTransaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = await fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Запущен ли модуль напрямую (`node src/…/x.js`).
 * Сравнивать import.meta.url с process.argv[1] напрямую нельзя: путь проекта
 * содержит пробелы и кириллицу, которые в URL процентно-кодируются.
 */
export function isMain(metaUrl) {
  return process.argv[1] ? metaUrl === pathToFileURL(process.argv[1]).href : false;
}

export function logImport(db, source, rowsLoaded, startedAt, note = null) {
  db.prepare(
    `INSERT INTO import_log (source, rows_loaded, started_at, finished_at, note)
     VALUES (?, ?, ?, ?, ?)`
  ).run(source, rowsLoaded, startedAt, new Date().toISOString(), note);
}
