import path from 'node:path';
import { DATA_DIR, logImport, withTransaction } from '../db/index.js';
import { parseXmlFile } from './lib/xml-stream.js';

export const COEFF_FILE = 'Рекомендуемая привязка поправочных коэффициентов к ФСНБ-2022 доп.18.xml';

/**
 * Файл поправочных коэффициентов → coefficients (п. 6 раздела 4.6 ТЗ).
 *
 * Ловушка, найденная при проверке файла: <Section> встречается в ДВУХ ролях —
 * как уровень иерархии классификатора и как ссылка на раздел внутри <Applys>
 * (`<Applys><Section code="02-01-01-012"/></Applys>`). В стек путей идут только
 * первые, иначе section_path загрязняется ссылками.
 *
 * Значения (<Value>) лежат текстом внутри Machine/Material/LaborCosts/
 * MachinistLaborCosts, названия — текстом в <Name>.
 */
export async function importCoefficients(db, dataDir = DATA_DIR) {
  const startedAt = new Date().toISOString();
  const insert = db.prepare(
    `INSERT OR REPLACE INTO coefficients (code, section_path, name, target, decree_use,
       machine_value, material_value, labor_costs_value, machinist_labor_costs_value)
     VALUES (@code, @section_path, @name, @target, @decree_use,
       @machine_value, @material_value, @labor_costs_value, @machinist_labor_costs_value)`
  );

  const sections = []; // {code, name}
  let coeff = null;
  let buf = '';
  let count = 0;

  const VALUE_FIELD = {
    Machine: 'machine_value',
    Material: 'material_value',
    LaborCosts: 'labor_costs_value',
    MachinistLaborCosts: 'machinist_labor_costs_value',
  };

  await withTransaction(db, async () => {
    await parseXmlFile(path.join(dataDir, COEFF_FILE), {
      open(name, attrs, stack) {
        buf = '';
        if (name === 'Section') {
          // ссылка внутри <Applys>, а не уровень иерархии
          if (stack.includes('Coefficient')) return;
          sections.push({ code: attrs.code ?? null, name: null });
        } else if (name === 'Coefficient') {
          coeff = {
            code: attrs.code,
            section_path: sections.map((s) => s.name).filter(Boolean).join(' > '),
            name: null,
            target: attrs.target ?? null,
            decree_use: attrs.decreeuse ?? null,
            machine_value: null,
            material_value: null,
            labor_costs_value: null,
            machinist_labor_costs_value: null,
          };
        }
      },
      text(chunk) {
        buf += chunk;
      },
      close(name, stack) {
        const parent = stack[stack.length - 1];
        if (name === 'Name') {
          const value = buf.trim();
          if (parent === 'Coefficient' && coeff) coeff.name = value;
          else if (parent === 'Section' && sections.length) sections[sections.length - 1].name = value;
        } else if (name === 'Value' && coeff && VALUE_FIELD[parent]) {
          const n = Number(buf.trim());
          if (!Number.isNaN(n)) coeff[VALUE_FIELD[parent]] = n;
        } else if (name === 'Coefficient' && coeff) {
          insert.run(coeff);
          count++;
          coeff = null;
        } else if (name === 'Section') {
          if (!stack.includes('Coefficient')) sections.pop();
        }
        buf = '';
      },
    });
  });

  logImport(db, COEFF_FILE, count, startedAt);
  return count;
}
