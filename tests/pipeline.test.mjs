/**
 * 全链路集成测试：真实读取示例题库文件 → 文本行 → 切题 → 入库 → 练习 → 统计。
 *
 * docx 走 mammoth 的 Node API（浏览器走 mammoth.browser，同一份文本），
 * PDF 走 pdf.js 的 legacy 构建（浏览器走 ESM build），
 * 中间的行聚合算法复用 extract.js 里导出的纯函数，确保两端行为一致。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { groupTextItemsIntoLines, rawTextToLines } from '../web/js/extract.js';
import { parseLines } from '../web/js/parser-text.js';
import * as repo from '../web/js/bank.js';
import * as db from '../web/js/db.js';
import * as EB from '../web/js/ebbinghaus.js';
import * as ST from '../web/js/stats.js';
import * as P from '../web/js/practice.js';

const FIXTURES = new URL('./fixtures/', import.meta.url);
const DOCX = fileURLToPath(new URL('sample-questions.docx', FIXTURES));
const PDF = fileURLToPath(new URL('sample-questions.pdf', FIXTURES));

/** 用 mammoth 的 Node 构建读取 docx 文本（与浏览器 extractRawText 等价） */
async function docxLines() {
  const mammoth = await import('mammoth');
  const result = await mammoth.extractRawText({ path: DOCX });
  return rawTextToLines(result.value);
}

/** 用 pdf.js legacy 构建按 y 坐标聚合行（与浏览器同一算法） */
async function pdfLines() {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(readFileSync(PDF));
  // 中文 PDF 多为非嵌入 CID 字体：必须提供 cmaps，否则每页取到 0 个文本项。
  // Node 下 pdf.js 用 fs 直接读路径，因此这里传本地目录路径（浏览器里传 http URL）。
  // 目录路径必须以 / 结尾（pdf.js 会校验）
  const cmapUrl = fileURLToPath(new URL('../web/vendor/cmaps/', import.meta.url)) + '/';
  const standardFontDataUrl = fileURLToPath(new URL('../web/vendor/standard_fonts/', import.meta.url)) + '/';
  const doc = await pdfjs.getDocument({
    data,
    useSystemFonts: false,
    cMapUrl: cmapUrl,
    cMapPacked: true,
    standardFontDataUrl,
  }).promise;
  const lines = [];
  for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
    const page = await doc.getPage(pageNo);
    const content = await page.getTextContent();
    const pageLineTexts = groupTextItemsIntoLines(content.items);
    pageLineTexts.forEach((text, i) => {
      lines.push({ page: pageNo, line: i + 1, para: 0, text });
    });
  }
  return { lines, pages: doc.numPages };
}

test('docx 全链路：68 行 → 14 道题，题型/答案/段落号正确', async () => {
  const lines = await docxLines();
  assert.equal(lines.length, 68, '去掉空白行后应有 68 行');
  assert.equal(lines[0].page, 0);
  assert.equal(lines[0].para, lines[0].line, 'docx 的 para 与 line 应为段落序号');

  const parsed = parseLines(lines, '示例题库');
  assert.equal(parsed.questions.length, 14, `应解析出 14 题，实际 ${parsed.questions.length}`);

  const types = {};
  for (const q of parsed.questions) types[q.qtype] = (types[q.qtype] || 0) + 1;
  assert.deepEqual(types, { 单选: 3, 多选: 3, 判断: 5, 简答: 2, 论述: 1 });

  // 括号内答案
  const q1 = parsed.questions[0];
  assert.equal(q1.answer, 'D');
  assert.ok(!q1.stem.includes('（D）'), '答案文本应从题干删除');
  assert.deepEqual(Object.keys(q1.options), ['A', 'B', 'C', 'D']);
  assert.equal(q1.para > 0, true);

  // 一行挤 4 个选项
  const packed = parsed.questions.find((q) => Object.values(q.options).some((t) => t.includes('全面加强党的领导')));
  assert.ok(packed, '应能看到被切开的挤在一行的选项');
  assert.equal(Object.keys(packed.options).length, 4);
  assert.equal(packed.answer, 'ABCD');

  // 判断题归一化
  const judge = parsed.questions.find((q) => q.qtype === '判断');
  assert.ok(['正确', '错误'].includes(judge.answer));

  // 简答题有参考答案
  const short = parsed.questions.find((q) => q.qtype === '简答');
  assert.ok(short.answer.length > 10);

  // 噪声与异常
  assert.ok(parsed.skipped.length >= 5, '页眉推广语、页码、章节标题应被跳过');
  assert.ok(parsed.skipped.every((s) => 'page' in s && 'line' in s && 'content' in s && 'reason' in s));
  assert.equal(parsed.errors.length, 1, '空题干坏题应记 1 条异常');
  assert.ok(parsed.errors[0].raw.length > 0);
  assert.match(parsed.summary(), /成功解析题目：14 道/);
});

test('pdf 全链路：2 页 → 页码与行号落到每题上', async () => {
  const { lines, pages } = await pdfLines();
  assert.equal(pages, 2);
  assert.ok(lines.length >= 20, `PDF 应聚合出至少 20 行，实际 ${lines.length} 行`);

  const parsed = parseLines(lines, '示例题库PDF');
  assert.equal(parsed.questions.length, 6, `应解析出 6 题，实际 ${parsed.questions.length}`);
  assert.ok(parsed.questions.every((q) => q.page >= 1), 'PDF 每题都应记录页码');
  assert.ok(parsed.questions.every((q) => q.line >= 1), 'PDF 每题都应记录行号');
  assert.ok(parsed.questions.some((q) => q.page === 2), '应有第 2 页的题目');
  assert.equal(parsed.questions.find((q) => q.qtype === '多选').answer, 'ABCD');
  assert.equal(parsed.errors.length, 0);
});

test('端到端：导入 → 练习 → 错题本 → 艾宾浩斯 → 统计', async () => {
  await db.clearAll();
  const lines = await docxLines();
  const parsed = parseLines(lines, '端到端题库');
  const bank = await repo.importParsed('端到端题库', parsed, { fileName: 'sample-questions.docx', fileType: 'docx' });
  assert.equal(bank.questions.length, 14);

  const list = await repo.listBanks();
  assert.equal(list[0].questionCount, 14);
  assert.equal(list[0].fileName, 'sample-questions.docx');

  // 顺序练习，前两题故意答错
  const session = ST.newSession('顺序练习', '端到端题库');
  const questions = P.pickQuestions({ bank, mode: 'order' });
  assert.equal(questions.length, 14);
  for (const [i, q] of questions.entries()) {
    const wrong = i < 2;
    ST.recordAnswer(session, q, !wrong, wrong ? 'A' : '我会了');
    await repo.recordPracticeResult('端到端题库', q, !wrong);
  }
  ST.finishSession(session);
  session.wrongBookTotal = await repo.wrongTotal('端到端题库');
  assert.equal(session.answered, 14);
  assert.equal(session.wrongBookTotal, 2);

  const wrong = await repo.loadWrong('端到端题库');
  assert.equal(wrong.length, 2);
  assert.ok(EB.dueCount(wrong) === 2, '答错的题当天即到期');
  assert.deepEqual(P.pickQuestions({ bank, mode: 'due', wrongRecords: wrong }).length, 2);
  assert.equal(P.pickQuestions({ bank, mode: 'wrong', wrongRecords: EB.sortForRetry(wrong) }).length, 2);

  // 今日复习：连续答对 7 次后移出错题本
  const target = wrong[0];
  for (let i = 0; i < 7; i++) {
    const res = await repo.recordPracticeResult('端到端题库', target, true);
    if (i < 6) assert.equal(res.status, 'updated');
    else assert.equal(res.status, 'graduated');
  }
  assert.equal((await repo.wrongTotal('端到端题库')), 1);

  // 统计落盘并生成报告
  const library = await repo.loadStats('端到端题库');
  ST.mergeIntoLibrary(library, session);
  await repo.saveStats('端到端题库', library);
  const saved = await repo.loadStats('端到端题库');
  assert.equal(saved.sessions, 1);
  assert.equal(saved.totalAnswered, 14);
  const report = ST.libraryReport(saved);
  assert.equal(report.accuracy > 0, true);
  assert.ok(report.weak.length >= 1, '应有薄弱知识点');
  assert.match(ST.summaryText(session), /本次答题 14 题/);
});
