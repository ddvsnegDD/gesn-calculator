import { searchWorks } from '../search/query.js';
import { searchMaterials } from '../search/materials.js';

/**
 * Инструменты AI-пайплайна — тонкие обёртки поверх существующего кода
 * (поиск норм, карточка нормы, поиск материалов). Схемы в формате OpenAI
 * function calling; исполнение — через executeTool.
 */

export const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'search_norms',
      description:
        'Поиск сметных норм ГЭСН-2022 по названию работы. Возвращает до 20 норм с кодом, названием, единицей и сборником. Запрос формулируй терминологией ГЭСН.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Поисковый запрос, напр. «устройство пароизоляции» или «разборка ограждений»' },
          base_type: {
            type: 'string',
            enum: ['ГЭСН', 'ГЭСНм', 'ГЭСНмр', 'ГЭСНп', 'ГЭСНр'],
            description: 'Необязательно: ограничить одной базой норм',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_norm_details',
      description:
        'Состав нормы ГЭСН для сверки: название, единица измерения, состав работ (Content), коды НР/СП, сводка ресурсов и абстрактные (основные) материалы. Вызывай перед выбором нормы. Полный поресурсный список запрашивай только при необходимости через full_resources=true.',
      parameters: {
        type: 'object',
        properties: {
          base_type: { type: 'string', enum: ['ГЭСН', 'ГЭСНм', 'ГЭСНмр', 'ГЭСНп', 'ГЭСНр'] },
          code: { type: 'string', description: 'Код нормы, напр. «15-01-038-01»' },
          full_resources: { type: 'boolean', description: 'Вернуть полный поресурсный состав (по умолчанию — только сводка)' },
        },
        required: ['base_type', 'code'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_materials',
      description:
        'Поиск материала в справочнике цен ФСБЦ по названию. Для сопоставления материалов из КП подрядчика с кодами ФСБЦ.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Название материала, напр. «мастика гидроизоляционная»' },
        },
        required: ['query'],
      },
    },
  },
];

/**
 * Состав нормы для сверки моделью. По умолчанию — компактно: название,
 * единица, состав работ (Content), НР/СП, СВОДКА ресурсов (число по типам) и
 * список абстрактных материалов. Полный поресурсный список (десятки строк на
 * норму) отдаётся только при full=true — он редко нужен для решения «подходит
 * ли норма», а на каждом раунде пересылается обратно и раздувает вход.
 */
function normDetails(db, baseType, code, full = false) {
  const work = db.prepare('SELECT * FROM works WHERE base_type = ? AND code = ?').get(baseType, code);
  if (!work) return { error: `Норма ${baseType} ${code} не найдена` };

  const resources = db.prepare(
    `SELECT wr.resource_code, wr.resource_type, wr.quantity, wr.quantity_note,
            wr.measure_unit, wr.is_abstract, wr.end_name,
            COALESCE(m.name, mc.name) AS ref_name
     FROM work_resources wr
     LEFT JOIN materials m ON m.code = wr.resource_code
     LEFT JOIN machines mc ON mc.code = wr.resource_code
     WHERE wr.work_id = ? ORDER BY wr.id`
  ).all(work.id);

  const base = {
    base_type: work.base_type,
    code: work.code,
    name: work.name_full,
    measure_unit: work.measure_unit,
    collection: work.collection_name,
    content: work.content_text,     // состав работ — главное для сверки
    nr_code: work.nr_code,
    sp_code: work.sp_code,
  };

  const abstracts = resources
    .filter((r) => r.is_abstract)
    .map((r) => ({ code: r.resource_code, name: r.end_name, unit: r.measure_unit }));
  const counts = resources.reduce((acc, r) => { acc[r.resource_type] = (acc[r.resource_type] ?? 0) + 1; return acc; }, {});

  if (!full) {
    return { ...base, resource_summary: counts, main_materials: abstracts };
  }
  return {
    ...base,
    resources: resources.map((r) => ({
      code: r.resource_code, type: r.resource_type, name: r.ref_name ?? r.end_name,
      quantity: r.quantity_note === 'П' ? 'по проекту' : r.quantity,
      unit: r.measure_unit, abstract: Boolean(r.is_abstract),
    })),
  };
}

/** Выполняет вызов инструмента по имени. Возвращает объект для сериализации. */
export function executeTool(db, name, args) {
  switch (name) {
    case 'search_norms': {
      const { works } = searchWorks(db, args.query ?? '', 20);
      const filtered = args.base_type ? works.filter((w) => w.base_type === args.base_type) : works;
      return {
        query: args.query,
        count: filtered.length,
        norms: filtered.map((w) => ({
          base_type: w.base_type, code: w.code, name: w.name_full,
          unit: w.measure_unit, collection: w.collection_name,
        })),
      };
    }
    case 'get_norm_details':
      return normDetails(db, args.base_type, args.code, Boolean(args.full_resources));
    case 'search_materials': {
      const { materials } = searchMaterials(db, args.query ?? '', 15);
      return {
        query: args.query,
        count: materials.length,
        materials: materials.map((m) => ({
          code: m.code, name: m.name, unit: m.measure_unit, category: m.category,
        })),
      };
    }
    default:
      return { error: `Неизвестный инструмент: ${name}` };
  }
}
