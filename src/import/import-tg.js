import path from 'node:path';
import { DATA_DIR, logImport, withTransaction } from '../db/index.js';
import { parseXmlFile } from './lib/xml-stream.js';

export const TG_BASE_FILE = 'База ТГ.xml';
export const TG_KEYS_FILE = 'Ключи перехода ТГ.xml';

/**
 * База ТГ.xml → technology_groups: TechnologyGroup/@Code → список Resource/@Code.
 * Проверено: 6 710 групп, 65 475 вхождений ресурсов.
 * INSERT OR IGNORE — один и тот же материал может встречаться в группе дважды.
 */
export async function importTechnologyGroups(db, dataDir = DATA_DIR) {
  const startedAt = new Date().toISOString();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO technology_groups (tg_code, resource_code) VALUES (?, ?)`
  );
  let tg = null;
  let count = 0;
  let groups = 0;

  await withTransaction(db, async () => {
    await parseXmlFile(path.join(dataDir, TG_BASE_FILE), {
      open(name, attrs) {
        if (name === 'TechnologyGroup') {
          tg = attrs.Code;
          groups++;
        } else if (name === 'Resource' && tg) {
          insert.run(tg, attrs.Code);
          count++;
        }
      },
      close(name) {
        if (name === 'TechnologyGroup') tg = null;
      },
    });
  });

  logImport(db, TG_BASE_FILE, count, startedAt, `групп: ${groups}`);
  return { groups, links: count };
}

/**
 * Ключи перехода ТГ.xml → tg_work_links.
 * Обход TechnologyGroup/@Code > Work[@Code,@BaseType] > AbstractResource.
 * Проверено: 6 710 групп, 36 033 Work — ровно столько же AbstractResource
 * содержится в пяти файлах норм, то есть привязка полная.
 */
export async function importTgWorkLinks(db, dataDir = DATA_DIR) {
  const startedAt = new Date().toISOString();
  const insert = db.prepare(
    `INSERT INTO tg_work_links (tg_code, work_code, base_type, abstract_resource_code,
       abstract_resource_name, measure_unit)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  let tg = null;
  let work = null;
  let count = 0;

  await withTransaction(db, async () => {
    await parseXmlFile(path.join(dataDir, TG_KEYS_FILE), {
      open(name, attrs) {
        if (name === 'TechnologyGroup') tg = attrs.Code;
        else if (name === 'Work') work = { code: attrs.Code, baseType: attrs.BaseType };
        else if (name === 'AbstractResource' && tg && work) {
          insert.run(tg, work.code, work.baseType, attrs.Code, attrs.Name ?? null, attrs.MeasureUnit ?? null);
          count++;
        }
      },
      close(name) {
        if (name === 'TechnologyGroup') tg = null;
        else if (name === 'Work') work = null;
      },
    });
  });

  logImport(db, TG_KEYS_FILE, count, startedAt);
  return count;
}
