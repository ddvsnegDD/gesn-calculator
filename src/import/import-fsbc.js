import path from 'node:path';
import { DATA_DIR, logImport, withTransaction } from '../db/index.js';
import { parseXmlFile, num } from './lib/xml-stream.js';

export const MATERIALS_FILE = 'ФСБЦ_Мат&Оборуд.xml';
export const MACHINES_FILE = 'ФСБЦ_Маш.xml';

/**
 * ФСБЦ_Мат&Оборуд.xml → materials (раздел 4.2 ТЗ).
 * Иерархия: ResourceCategory[@Type] > Section (Книга>Часть>Раздел>Группа) > Resource > Prices/Price.
 * Проверено на файле: 45 437 Resource, у каждого ровно один Price, Cost/OptCost заполнены всегда.
 */
export async function importMaterials(db, dataDir = DATA_DIR) {
  const startedAt = new Date().toISOString();
  const insert = db.prepare(
    `INSERT INTO materials (code, name, category, measure_unit, cost, opt_cost)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  let category = null;
  let current = null;
  let count = 0;

  await withTransaction(db, async () => {
    await parseXmlFile(path.join(dataDir, MATERIALS_FILE), {
      open(name, attrs) {
        if (name === 'ResourceCategory') category = attrs.Type ?? null;
        else if (name === 'Resource') {
          current = { code: attrs.Code, name: attrs.Name, unit: attrs.MeasureUnit ?? null };
        } else if (name === 'Price' && current) {
          insert.run(current.code, current.name, category, current.unit, num(attrs.Cost), num(attrs.OptCost));
          count++;
          current = null;
        }
      },
    });
  });

  logImport(db, MATERIALS_FILE, count, startedAt);
  return count;
}

/**
 * ФСБЦ_Маш.xml → machines (раздел 4.3 ТЗ).
 * Проверено: 1 732 машины, все с MeasureUnit='маш.-ч'. DriverCode есть у 1 033;
 * у остальных 699 LabourMach=0 и SalaryMach=0 — з/п машиниста у них отсутствует
 * как таковая, поэтому NULL в driver_code не создаёт неопределённости в расчёте.
 */
export async function importMachines(db, dataDir = DATA_DIR) {
  const startedAt = new Date().toISOString();
  const insert = db.prepare(
    `INSERT INTO machines (code, name, measure_unit, salary_mach, labour_mach,
       price_cost_without_salary, with_relocation, driver_code, machinist_category,
       electricity, electricity_cost)
     VALUES (@code, @name, @measure_unit, @salary_mach, @labour_mach,
       @price_cost_without_salary, @with_relocation, @driver_code, @machinist_category,
       @electricity, @electricity_cost)`
  );
  let current = null;
  let count = 0;

  const flush = () => {
    if (!current) return;
    insert.run(current);
    count++;
    current = null;
  };

  await withTransaction(db, async () => {
    await parseXmlFile(path.join(dataDir, MACHINES_FILE), {
      open(name, attrs) {
        if (name === 'Resource') {
          flush();
          current = {
            code: attrs.Code,
            name: attrs.Name,
            measure_unit: attrs.MeasureUnit ?? null,
            salary_mach: null,
            labour_mach: null,
            price_cost_without_salary: null,
            with_relocation: null,
            driver_code: null,
            machinist_category: null,
            electricity: null,
            electricity_cost: null,
          };
        } else if (name === 'Price' && current) {
          current.salary_mach = num(attrs.SalaryMach);
          current.labour_mach = num(attrs.LabourMach);
          current.price_cost_without_salary = num(attrs.PriceCostWithoutSalary);
          current.with_relocation = attrs.WithRelocation === 'true' ? 1 : 0;
          current.driver_code = attrs.DriverCode || null;
          current.machinist_category = num(attrs.MachinistCategory);
        } else if (name === 'Material' && current) {
          current.electricity = num(attrs.Electricity);
          current.electricity_cost = num(attrs.ElectricityCost);
        }
      },
    });
    flush();
  });

  logImport(db, MACHINES_FILE, count, startedAt);
  return count;
}
