-- Схема БД сметного калькулятора ГЭСН-2022.
-- Основа — раздел 3 ТЗ. Все таблицы и колонки ТЗ сохранены дословно.
-- Отступления от ТЗ помечены комментарием «ОТСТУПЛЕНИЕ» и вызваны тем,
-- что реальные данные не помещаются в исходную схему (см. README раздела
-- «Расхождения ТЗ и данных»). Каждое отступление — аддитивное: колонки ТЗ
-- на месте, добавлены только те поля, без которых данные теряются молча.

-- Единая таблица норм по всем 5 базам ГЭСН
CREATE TABLE works (
  id INTEGER PRIMARY KEY,
  base_type TEXT NOT NULL,        -- 'ГЭСН' | 'ГЭСНм' | 'ГЭСНмр' | 'ГЭСНп' | 'ГЭСНр'
  code TEXT NOT NULL,             -- напр. '01-01-001-01'
  collection_code TEXT,           -- код Сборника
  collection_name TEXT,
  section_path TEXT,              -- 'Раздел > Подраздел > Таблица' текстом, для поиска/отображения
  name_full TEXT NOT NULL,        -- NameGroup.BeginName + Work.EndName, склеенные
  measure_unit TEXT,
  content_text TEXT,              -- состав работ (Content/Item.Text через \n), справочно
  nr_code TEXT,                   -- код пункта приказа НР из NrSp/ReasonItem/@Nr, напр. 'Пр/812-012.0'
  sp_code TEXT,                   -- код пункта приказа СП из NrSp/ReasonItem/@Sp, напр. 'Пр/774-012.0'
  -- ОТСТУПЛЕНИЕ 1: у 4 033 норм (12 в ГЭСН, 4 021 в ГЭСНм) внутри <NrSp>
  -- несколько <ReasonItem> — норма допускает разные виды работ, выбор за
  -- сметчиком. В nr_code/sp_code кладём ПЕРВЫЙ элемент как значение по
  -- умолчанию, все варианты — в work_nrsp_items, а здесь ставим флаг, чтобы
  -- движок потребовал выбор вместо тихой подстановки первого попавшегося.
  nrsp_ambiguous INTEGER NOT NULL DEFAULT 0,
  UNIQUE(base_type, code)
);
CREATE INDEX idx_works_code ON works(code);
CREATE VIRTUAL TABLE works_fts USING fts5(name_full, content=works, content_rowid=id);

-- ОТСТУПЛЕНИЕ 1 (продолжение): все варианты НР/СП нормы, включая единственный.
CREATE TABLE work_nrsp_items (
  work_id INTEGER NOT NULL REFERENCES works(id),
  ord INTEGER NOT NULL,           -- порядок в XML, 0 = тот, что попал в works.nr_code
  nr_code TEXT,
  sp_code TEXT,
  PRIMARY KEY (work_id, ord)
);

-- Нормы расхода ресурсов на единицу работы
CREATE TABLE work_resources (
  id INTEGER PRIMARY KEY,
  work_id INTEGER NOT NULL REFERENCES works(id),
  resource_code TEXT NOT NULL,
  resource_type TEXT NOT NULL,    -- 'labor' | 'machine' | 'material' | 'equipment' | 'abstract_material'
  -- ОТСТУПЛЕНИЕ 2: в ТЗ `quantity REAL NOT NULL`, но в данных 14 474 ресурса
  -- несут Quantity="П" («по проекту») вместо числа — расход не задан нормой и
  -- берётся из проектных данных. NOT NULL снят; для таких строк quantity=NULL,
  -- а quantity_note='П'. Движок обязан требовать ввод расхода, а не считать 0.
  quantity REAL,                  -- норма расхода на ед. измерения работы
  quantity_note TEXT,             -- 'П' = расход по проекту (иначе NULL)
  end_name TEXT,                  -- напр. 'Средний разряд работы 3,8'
  measure_unit TEXT,
  is_abstract INTEGER DEFAULT 0,  -- 1 = источник <AbstractResource> (основной/неучтённый материал)
  tg_codes TEXT                   -- @TechnologyGroups абстрактного ресурса (через ';')
);
CREATE INDEX idx_wr_work ON work_resources(work_id);
CREATE INDEX idx_wr_resource ON work_resources(resource_code);

-- Материалы и оборудование (из ФСБЦ_Мат&Оборуд.xml)
CREATE TABLE materials (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT,                  -- 'Материал' | 'Оборудование'
  measure_unit TEXT,
  cost REAL,                      -- розничная цена
  opt_cost REAL                   -- оптовая цена
);

-- Машины и механизмы (из ФСБЦ_Маш.xml)
CREATE TABLE machines (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  measure_unit TEXT,
  salary_mach REAL,               -- зарплата машиниста в составе маш.-часа (на 01.01.2022, справочно)
  labour_mach REAL,
  price_cost_without_salary REAL, -- стоимость маш.-часа без зарплаты
  with_relocation INTEGER,        -- bool
  driver_code TEXT,               -- NULL у 699 машин — у всех них labour_mach=0, з/п машиниста нет
  machinist_category REAL,
  electricity REAL,
  electricity_cost REAL
);

-- Технологические группы (взаимозаменяемые материалы)
CREATE TABLE technology_groups (
  tg_code TEXT NOT NULL,
  resource_code TEXT NOT NULL,    -- материал, входящий в группу замены
  PRIMARY KEY (tg_code, resource_code)
);

-- Привязка норм к технологическим группам
CREATE TABLE tg_work_links (
  tg_code TEXT NOT NULL,
  work_code TEXT NOT NULL,
  base_type TEXT NOT NULL,
  abstract_resource_code TEXT NOT NULL,
  abstract_resource_name TEXT,
  measure_unit TEXT
);
CREATE INDEX idx_tgwl_work ON tg_work_links(base_type, work_code);

-- Поправочные коэффициенты (справочно, подбор вручную; применение — v2)
CREATE TABLE coefficients (
  code TEXT PRIMARY KEY,
  section_path TEXT,
  name TEXT,
  target TEXT,                    -- 'Расход' и т.п.
  decree_use TEXT,
  machine_value REAL,
  material_value REAL,
  labor_costs_value REAL,
  machinist_labor_costs_value REAL
);

-- Периоды сплит-формы (версионирование — тарифы/индексы обновляются ЕЖЕКВАРТАЛЬНО)
CREATE TABLE price_periods (
  id INTEGER PRIMARY KEY,
  region TEXT NOT NULL,           -- напр. 'город Москва'
  year INTEGER NOT NULL,
  quarter INTEGER NOT NULL,       -- 1..4
  source_letter TEXT,             -- реквизиты письма Минстроя (справочно)
  imported_at TEXT NOT NULL,
  UNIQUE(region, year, quarter)
);

-- Тарифные ставки труда (из сплит-формы, строки с MeasureUnit='чел.-ч')
CREATE TABLE labor_tariff_rates (
  period_id INTEGER NOT NULL REFERENCES price_periods(id),
  resource_code TEXT NOT NULL,    -- '1-100-38', '4-100-050' и т.п.
  name TEXT,
  rate_per_hour REAL NOT NULL,    -- готовая ставка в текущем уровне цен периода
  PRIMARY KEY (period_id, resource_code)
);

-- Цены/индексы материалов и машин по группам ГОСР (из сплит-формы, все остальные строки)
CREATE TABLE price_period_resources (
  period_id INTEGER NOT NULL REFERENCES price_periods(id),
  resource_code TEXT NOT NULL,
  gosr_group_no INTEGER,
  gosr_group_name TEXT,
  base_price REAL,                -- цена на 01.01.2022 (колонка 5)
  current_price REAL,             -- готовая текущая цена (колонка 8), если задана напрямую
  index_value REAL,               -- индекс к группе ГОСР (колонка 9), если цена считается через индекс
  PRIMARY KEY (period_id, resource_code)
);
CREATE INDEX idx_ppr_period ON price_period_resources(period_id);

-- Нормативы НР (812/пр) и СП (774/пр) по видам работ
CREATE TABLE work_type_norms (
  id INTEGER PRIMARY KEY,
  item_no TEXT NOT NULL,          -- '1.1', '6.2', '104доп' — как в приложении к приказу
  -- ОТСТУПЛЕНИЕ 3: нормализованный ключ для матчинга с works.nr_code/sp_code.
  -- ТЗ (4.5) требует «нормализовать оба формата к единому ключу», но колонки
  -- под него не предусматривает — храним рядом, чтобы матчинг был индексируемым.
  match_key TEXT,                 -- '21.0', '104доп' — числовая часть nr_code/sp_code
  work_type_name TEXT NOT NULL,
  section TEXT,                   -- 'I'..'VI'
  base_type TEXT,
  collection_codes TEXT,          -- через ';', либо 'ALL'
  sbornik_note TEXT,
  profit_pct REAL,                -- норматив сметной прибыли, % от ФОТ (774/пр)
  overhead_territory_pct REAL,    -- норматив НР для Территории РФ, % от ФОТ (812/пр)
  overhead_mprks_pct REAL,        -- норматив НР для МПРКС
  overhead_rks_pct REAL,          -- норматив НР для РКС
  needs_manual_review INTEGER
);
CREATE INDEX idx_wtn_key ON work_type_norms(match_key);

-- Журнал импорта: что и когда загружалось, сколько строк
CREATE TABLE import_log (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  rows_loaded INTEGER,
  started_at TEXT,
  finished_at TEXT,
  note TEXT
);
