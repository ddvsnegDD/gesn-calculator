/**
 * Стеммер русского языка (алгоритм Snowball «Russian»).
 *
 * Нужен, чтобы «гидроизоляции» и «гидроизоляция», «гранита» и «гранитных»
 * попадали в один индексный термин. Реализован без зависимостей: библиотека
 * ради одной функции в проект не тянется.
 *
 * Алгоритм работает по областям слова:
 *   RV — часть слова после первой гласной;
 *   R1 — после первой пары «гласная + согласная»;
 *   R2 — то же внутри R1.
 * Окончания снимаются только если попадают в свою область.
 */

const VOWELS = new Set(['а', 'е', 'и', 'о', 'у', 'ы', 'э', 'ю', 'я']);

// Порядок внутри группы важен: сначала пробуем длинные окончания.
const PERFECTIVE_GERUND_1 = ['вшись', 'вши', 'в'];              // только после «а» или «я»
const PERFECTIVE_GERUND_2 = ['ывшись', 'ившись', 'ывши', 'ивши', 'ыв', 'ив'];
const ADJECTIVE = [
  'ыми', 'ими', 'его', 'ого', 'ему', 'ому', 'ее', 'ие', 'ые', 'ое', 'ей', 'ий', 'ый', 'ой',
  'ем', 'им', 'ым', 'ом', 'их', 'ых', 'ую', 'юю', 'ая', 'яя', 'ою', 'ею',
];
const PARTICIPLE_1 = ['ющ', 'вш', 'нн', 'ем', 'щ'];             // только после «а» или «я»
const PARTICIPLE_2 = ['ующ', 'ывш', 'ивш'];
const REFLEXIVE = ['ся', 'сь'];
const VERB_1 = [
  'ейте', 'уйте', 'нно', 'ете', 'йте', 'ешь', 'ла', 'на', 'ли', 'ем', 'ло', 'но', 'ет',
  'ют', 'ны', 'ть', 'й', 'л', 'н',
];
const VERB_2 = [
  'ившись', 'ывшись', 'уйте', 'ейте', 'ила', 'ыла', 'ена', 'ите', 'или', 'ыли', 'ило', 'ыло',
  'ено', 'ует', 'уют', 'ены', 'ить', 'ыть', 'ишь', 'ей', 'уй', 'ил', 'ыл', 'им', 'ым', 'ен',
  'ят', 'ит', 'ыт', 'ую', 'ю',
];
const NOUN = [
  'иями', 'ями', 'ами', 'иях', 'иям', 'ием', 'ией', 'ых', 'ях', 'ям', 'ам', 'ом', 'ах',
  'ев', 'ов', 'ие', 'ье', 'еи', 'ии', 'ей', 'ой', 'ий', 'ем', 'ия', 'ья', 'ию', 'ью',
  'а', 'е', 'и', 'й', 'о', 'у', 'ы', 'ь', 'ю', 'я',
];
const SUPERLATIVE = ['ейше', 'ейш'];
const DERIVATIONAL = ['ость', 'ост'];

/** Ищет первое подходящее окончание из списка в пределах области. */
function findEnding(word, region, endings) {
  for (const e of endings) {
    if (word.endsWith(e) && word.length - e.length >= region) return e;
  }
  return null;
}

function regions(word) {
  let rv = word.length;
  for (let i = 0; i < word.length; i++) {
    if (VOWELS.has(word[i])) { rv = i + 1; break; }
  }
  let r1 = word.length;
  for (let i = 1; i < word.length; i++) {
    if (!VOWELS.has(word[i]) && VOWELS.has(word[i - 1])) { r1 = i + 1; break; }
  }
  let r2 = word.length;
  for (let i = r1 + 1; i < word.length; i++) {
    if (!VOWELS.has(word[i]) && VOWELS.has(word[i - 1])) { r2 = i + 1; break; }
  }
  return { rv, r1, r2 };
}

/** «Гидроизоляции» → «гидроизоляц», «гранитных» → «гранит». */
export function stemRu(input) {
  return normalizeStem(stemBase(input));
}

function stemBase(input) {
  let word = String(input).toLowerCase().replace(/ё/g, 'е');
  if (word.length < 3) return word;
  if (!/^[а-я]+$/.test(word)) return word; // латиница, цифры, коды — как есть

  const { rv, r2 } = regions(word);
  const cut = (ending) => { word = word.slice(0, word.length - ending.length); };
  // окончание из группы «после а/я» допустимо, только если перед ним стоит а или я
  const afterAYa = (ending) => {
    const i = word.length - ending.length - 1;
    return i >= 0 && (word[i] === 'а' || word[i] === 'я');
  };

  // --- шаг 1 ---------------------------------------------------------------
  let done = false;
  let ending = findEnding(word, rv, PERFECTIVE_GERUND_1);
  if (ending && afterAYa(ending)) { cut(ending); done = true; }
  if (!done) {
    ending = findEnding(word, rv, PERFECTIVE_GERUND_2);
    if (ending) { cut(ending); done = true; }
  }
  if (!done) {
    const refl = findEnding(word, rv, REFLEXIVE);
    if (refl) cut(refl);

    // ADJECTIVAL = ADJECTIVE, возможно с причастным суффиксом перед ним
    ending = findEnding(word, rv, ADJECTIVE);
    if (ending) {
      cut(ending);
      let part = findEnding(word, rv, PARTICIPLE_1);
      if (part && afterAYa(part)) cut(part);
      else {
        part = findEnding(word, rv, PARTICIPLE_2);
        if (part) cut(part);
      }
      done = true;
    }
    if (!done) {
      ending = findEnding(word, rv, VERB_1);
      if (ending && afterAYa(ending)) { cut(ending); done = true; }
      if (!done) {
        ending = findEnding(word, rv, VERB_2);
        if (ending) { cut(ending); done = true; }
      }
    }
    if (!done) {
      ending = findEnding(word, rv, NOUN);
      if (ending) cut(ending);
    }
  }

  // --- шаг 2: «и» в RV -----------------------------------------------------
  if (word.endsWith('и') && word.length - 1 >= rv) cut('и');

  // --- шаг 3: словообразовательный суффикс в R2 ----------------------------
  const der = findEnding(word, r2, DERIVATIONAL);
  if (der) cut(der);

  // --- шаг 4: «нн» → «н», превосходная степень, мягкий знак ----------------
  if (word.endsWith('нн')) cut('н');
  else {
    const sup = findEnding(word, rv, SUPERLATIVE);
    if (sup) {
      cut(sup);
      if (word.endsWith('нн')) cut('н');
    } else if (word.endsWith('ь')) cut('ь');
  }

  return word;
}

/**
 * Беглая гласная: «стяжка» → «стяжек», «перегородка» → «перегородок»,
 * «доска» → «досок». Snowball такие пары не сводит, и запрос «стяжки»
 * не находил норму «Устройство и разборка стяжек». Гласную перед конечной
 * «к» убираем, если до неё осталось хотя бы три буквы — иначе пострадают
 * короткие слова вроде «блок» и «сок».
 *
 * Правило применяется одинаково при индексации и в запросе, поэтому даже
 * там, где результат выглядит непривычно («поток» → «потк»), обе стороны
 * получают одну и ту же основу.
 */
export function normalizeStem(stem) {
  return /^[а-я]{3,}[еоё]к$/.test(stem) ? `${stem.slice(0, -2)}к` : stem;
}

/** Разбивает текст на токены поиска: слова и числовые коды. */
export function tokenize(text) {
  return String(text)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^0-9a-zа-я]+/i)
    .filter((t) => t.length >= 2);
}

/** Строка → строка стеммированных токенов (то, что кладётся в индекс). */
export function stemText(text) {
  return tokenize(text).map(stemRu).join(' ');
}
