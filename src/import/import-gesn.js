import path from 'node:path';
import { DATA_DIR, logImport, withTransaction } from '../db/index.js';
import { parseXmlFile } from './lib/xml-stream.js';

export const GESN_FILES = ['ГЭСН.xml', 'ГЭСНм.xml', 'ГЭСНмр.xml', 'ГЭСНп.xml', 'ГЭСНр.xml'];

/**
 * Классификатор ресурса. Согласно 4.6 ТЗ тип определяется ПОСЛЕ загрузки
 * справочников: сначала machines, затем materials, всё остальное — труд.
 */
function buildClassifier(db) {
  const machines = new Set(db.prepare('SELECT code FROM machines').pluck().all());
  const materials = new Map(
    db.prepare('SELECT code, category FROM materials').all().map((r) => [r.code, r.category])
  );
  return (code) => {
    if (machines.has(code)) return 'machine';
    const cat = materials.get(code);
    if (cat === 'Оборудование') return 'equipment';
    if (cat !== undefined) return 'material';
    return 'labor';
  };
}

/**
 * Пять файлов ГЭСН → works + work_resources + work_nrsp_items (раздел 4.1 ТЗ).
 *
 * Особенности данных, проверенные до написания импортёра:
 *  - Quantity может быть 'П' («по проекту») вместо числа — 14 474 ресурса.
 *    Такие строки грузим с quantity=NULL и quantity_note='П'.
 *  - <NrSp> может содержать несколько <ReasonItem> (4 033 нормы). Первый идёт
 *    в works.nr_code/sp_code, все — в work_nrsp_items, ставится nrsp_ambiguous=1.
 *  - <AbstractResource> — основной/неучтённый материал, обязателен к импорту.
 */
export async function importGesn(db, dataDir = DATA_DIR, files = GESN_FILES) {
  const classify = buildClassifier(db);

  const insWork = db.prepare(
    `INSERT INTO works (base_type, code, collection_code, collection_name, section_path,
       name_full, measure_unit, content_text, nr_code, sp_code, nrsp_ambiguous)
     VALUES (@base_type, @code, @collection_code, @collection_name, @section_path,
       @name_full, @measure_unit, @content_text, @nr_code, @sp_code, @nrsp_ambiguous)`
  );
  const insRes = db.prepare(
    `INSERT INTO work_resources (work_id, resource_code, resource_type, quantity,
       quantity_note, end_name, measure_unit, is_abstract, tg_codes)
     VALUES (@work_id, @resource_code, @resource_type, @quantity,
       @quantity_note, @end_name, @measure_unit, @is_abstract, @tg_codes)`
  );
  const insNrSp = db.prepare(
    `INSERT INTO work_nrsp_items (work_id, ord, nr_code, sp_code) VALUES (?, ?, ?, ?)`
  );

  const totals = { works: 0, resources: 0, abstract: 0, byProject: 0, ambiguous: 0, noNrSp: 0 };

  for (const file of files) {
    const startedAt = new Date().toISOString();
    let baseType = null;
    const sections = []; // стек {name, type, code}
    let beginName = null;
    let work = null; // текущая работа
    let fileWorks = 0;

    const flushWork = () => {
      if (!work) return;
      const first = work.nrsp[0] ?? null;
      const info = insWork.run({
        base_type: baseType,
        code: work.code,
        collection_code: work.collection_code,
        collection_name: work.collection_name,
        section_path: work.section_path,
        name_full: work.name_full,
        measure_unit: work.measure_unit,
        content_text: work.content.length ? work.content.join('\n') : null,
        nr_code: first?.nr ?? null,
        sp_code: first?.sp ?? null,
        nrsp_ambiguous: work.nrsp.length > 1 ? 1 : 0,
      });
      const workId = info.lastInsertRowid;
      for (const r of work.resources) {
        insRes.run({ ...r, work_id: workId });
      }
      work.nrsp.forEach((item, i) => insNrSp.run(workId, i, item.nr, item.sp));

      totals.works++;
      fileWorks++;
      totals.resources += work.resources.length;
      totals.abstract += work.resources.filter((r) => r.is_abstract).length;
      totals.byProject += work.resources.filter((r) => r.quantity_note === 'П').length;
      if (work.nrsp.length > 1) totals.ambiguous++;
      if (work.nrsp.length === 0) totals.noNrSp++;
      work = null;
    };

    await withTransaction(db, async () => {
      await parseXmlFile(path.join(dataDir, file), {
        open(name, attrs) {
          switch (name) {
            case 'base':
              baseType = attrs.BaseType ?? null;
              break;
            case 'Section':
              sections.push({ name: attrs.Name ?? '', type: attrs.Type ?? '', code: attrs.Code ?? null });
              break;
            case 'NameGroup':
              beginName = attrs.BeginName ?? '';
              break;
            case 'Work': {
              flushWork();
              const collection = sections[0] ?? null;
              const endName = attrs.EndName ?? '';
              work = {
                code: attrs.Code,
                collection_code: collection?.code ?? null,
                collection_name: collection?.name ?? null,
                section_path: sections.map((s) => s.name).join(' > '),
                name_full: [beginName, endName].filter(Boolean).join(' '),
                measure_unit: attrs.MeasureUnit ?? null,
                content: [],
                resources: [],
                nrsp: [],
              };
              break;
            }
            case 'Item':
              if (work && attrs.Text) work.content.push(attrs.Text);
              break;
            case 'Resource': {
              if (!work) break;
              const isByProject = attrs.Quantity === 'П';
              work.resources.push({
                resource_code: attrs.Code,
                resource_type: classify(attrs.Code),
                quantity: isByProject ? null : Number(attrs.Quantity),
                quantity_note: isByProject ? 'П' : null,
                end_name: attrs.EndName ?? null,
                measure_unit: attrs.MeasureUnit ?? null,
                is_abstract: 0,
                tg_codes: null,
              });
              break;
            }
            case 'AbstractResource': {
              if (!work) break;
              const isByProject = attrs.Quantity === 'П';
              work.resources.push({
                resource_code: attrs.Code,
                resource_type: 'abstract_material',
                quantity: isByProject ? null : Number(attrs.Quantity),
                quantity_note: isByProject ? 'П' : null,
                end_name: attrs.Name ?? null,
                measure_unit: attrs.MeasureUnit ?? null,
                is_abstract: 1,
                tg_codes: attrs.TechnologyGroups ?? null,
              });
              break;
            }
            case 'ReasonItem':
              if (work) work.nrsp.push({ nr: attrs.Nr ?? null, sp: attrs.Sp ?? null });
              break;
          }
        },
        close(name) {
          if (name === 'Section') sections.pop();
          else if (name === 'Work') flushWork();
          else if (name === 'NameGroup') beginName = null;
        },
      });
      flushWork();
    });


    logImport(db, file, fileWorks, startedAt, `${baseType}: работ`);
  }

  db.exec(`INSERT INTO works_fts(works_fts) VALUES('rebuild')`);
  return totals;
}
