import fs from 'node:fs';
import { SaxesParser } from 'saxes';

/**
 * Потоковый обход XML: файлы до 84 МБ, DOM не строим.
 *
 * Вызывает handlers.open(name, attrs, stack) и handlers.close(name, stack),
 * где stack — массив имён открытых элементов от корня, БЕЗ текущего.
 * handlers.text(chunk, stack) — для элементов с текстовым содержимым.
 *
 * BOM (все файлы ФСНБ — UTF-8 с BOM) снимается до передачи парсеру:
 * saxes считает BOM в начале документа ошибкой.
 */
export async function parseXmlFile(filePath, handlers) {
  const parser = new SaxesParser({ fragment: false });
  const stack = [];
  let failure = null;

  parser.on('error', (err) => {
    failure = err;
  });
  parser.on('opentag', (node) => {
    if (handlers.open) handlers.open(node.name, node.attributes, stack);
    if (!node.isSelfClosing) stack.push(node.name);
    else if (handlers.close) handlers.close(node.name, stack);
  });
  parser.on('closetag', (node) => {
    if (node.isSelfClosing) return; // уже обработан в opentag
    stack.pop();
    if (handlers.close) handlers.close(node.name, stack);
  });
  if (handlers.text) {
    parser.on('text', (t) => handlers.text(t, stack));
  }

  const stream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 1 << 20 });
  let first = true;
  for await (let chunk of stream) {
    if (first) {
      if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1);
      first = false;
    }
    parser.write(chunk);
    if (failure) throw failure;
  }
  parser.close();
  if (failure) throw failure;
}

/** Число из атрибута XML; '' и отсутствие → null. */
export function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}
