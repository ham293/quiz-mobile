/**
 * 分栏检测的回归测试：双栏 PDF 不能被拼成串行文字。
 * 用 pdf.js 的 legacy 构建（Node 下可用）+ extract.js 导出的纯函数。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { groupTextItemsIntoLines, splitItemsByColumns } from '../web/js/extract.js';
import { parseLines } from '../web/js/parser-text.js';

const PDF = fileURLToPath(new URL('./fixtures/two-column.pdf', import.meta.url));
const CMAPS = fileURLToPath(new URL('../web/vendor/cmaps/', import.meta.url)) + '/';

async function pageItems() {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(readFileSync(PDF));
  const doc = await pdfjs.getDocument({
    data,
    useSystemFonts: false,
    cMapUrl: CMAPS,
    cMapPacked: true,
  }).promise;
  const page = await doc.getPage(1);
  const content = await page.getTextContent();
  return content.items;
}

test('双栏 PDF：按栏切开后各栏独立、不串行', async () => {
  const items = await pageItems();
  assert.ok(items.length > 20, `拿到文字项 ${items.length} 个`);

  // 不分栏：左右两栏同一横线的文字会被拼到一行（这就是用户遇到的串行问题）
  const naive = groupTextItemsIntoLines(items);
  const merged = (line) =>
    (line.includes('单选题') && line.includes('多选题')) ||
    (line.includes('1943年') && line.includes('洋务运动')) ||
    (line.includes('南京条约') && line.includes('抗日根据地'));
  const mergedNaive = naive.filter(merged);
  assert.ok(mergedNaive.length > 0, `不分栏时应当出现左右栏合并的行（实际前 3 行：${JSON.stringify(naive.slice(0, 3))}）`);

  // 分栏后：左栏、右栏分开读，串行消失
  const columns = splitItemsByColumns(items);
  assert.equal(columns.length, 2, '应识别出 2 栏');
  const texts = columns.map((col) => groupTextItemsIntoLines(col));
  const all = texts.flat();
  assert.equal(all.filter(merged).length, 0, `分栏后不应再有合并行（实际：${JSON.stringify(all.filter(merged))}）`);

  // 左栏应当从「一、单选题」开始，右栏从「二、多选题」开始
  assert.match(texts[0][0], /单选题/, `左栏首行：${texts[0][0]}`);
  assert.match(texts[1][0], /多选题/, `右栏首行：${texts[1][0]}`);

  // 选项行自成一行（不再混进题干）
  const optionLines = all.filter((l) => /^A\.\s*\S/.test(l));
  assert.ok(optionLines.length >= 2, `应有多行独立选项，实际 ${JSON.stringify(all.slice(0, 8))}`);
});

test('双栏 PDF：切题结果里题干不再带着别的题的文字', async () => {
  const columns = splitItemsByColumns(await pageItems());
  const lines = [];
  for (const col of columns) {
    groupTextItemsIntoLines(col)
      .map((t) => t.trim())
      .filter(Boolean)
      .forEach((text, i) => lines.push({ page: 1, line: i + 1, para: 0, text }));
  }
  const parsed = parseLines(lines, '双栏测试');
  assert.ok(parsed.questions.length >= 4, `应解析出至少 4 题，实际 ${parsed.questions.length}`);

  const withOptions = parsed.questions.filter((q) => Object.keys(q.options).length >= 2);
  assert.ok(withOptions.length >= 3, `应有选择题带上选项，实际 ${withOptions.length}`);
  // 题干里不应混入选项标记
  for (const q of withOptions) {
    assert.ok(!/A\.\s*\S+\s+B\./.test(q.stem), `题干混入了选项：${q.stem}`);
  }
});
