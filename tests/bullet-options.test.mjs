/**
 * 带项目符号的选项识别（回归测试）。
 *
 * 背景：用户题库是从 WPS 导出的双栏 PDF，选项行长得像 `• A. 鸦片战争`
 * （行首带圆点/方块/中圆点/短横线）。原来的选项正则要求行首就是字母，
 * 于是这些行全被当成题干文字 → 界面显示「A. 1840 / A. 鸦片战争」这种
 * 串在一起的怪东西，且选项按钮一个都没有。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseLines } from '../web/js/parser-text.js';

/** 把字符串数组变成解析器要的「文本行」结构 */
function linesOf(texts) {
  return texts.map((text, i) => ({ page: 1, line: i + 1, para: 0, text }));
}

test('行首项目符号的选项行能被识别（• ● · - 等）', () => {
  const parsed = parseLines(
    linesOf([
      '1、[2分] 近代中国半殖民地半封建社会的起点是（A）',
      '• A. 鸦片战争',
      '● B. 第二次鸦片战争',
      '· C. 中日甲午战争',
      '- D. 八国联军侵华战争',
      '正确答案：A',
      '2、[2分] 1860年洗劫和烧毁圆明园的侵略军是（C）',
      '• A. 日本侵略军',
      '• B. 俄国侵略军',
      '• C. 英法联军',
      '• D. 八国联军',
      '正确答案：C',
    ]),
    '项目符号选项',
  );

  assert.equal(parsed.questions.length, 2, `应解析出 2 题，实际 ${parsed.questions.length}`);
  const [q1, q2] = parsed.questions;

  assert.equal(q1.qtype, '单选');
  assert.deepEqual(Object.keys(q1.options), ['A', 'B', 'C', 'D'], `实际 ${JSON.stringify(q1.options)}`);
  assert.equal(q1.options.A, '鸦片战争');
  assert.equal(q1.options.D, '八国联军侵华战争');
  assert.equal(q1.answer, 'A');
  // 题干里不能残留选项文字
  assert.ok(!/鸦片战争|八国联军/.test(q1.stem), `题干混入了选项：${q1.stem}`);
  assert.ok(!/[•●·]/.test(q1.stem), `题干混入了项目符号：${q1.stem}`);

  assert.equal(q2.answer, 'C');
  assert.equal(q2.options.C, '英法联军');
  assert.ok(!/英法联军/.test(q2.stem), `题干混入了选项：${q2.stem}`);
});

test('没有项目符号的选项行同样正常（不会因为兼容而变松）', () => {
  const parsed = parseLines(
    linesOf([
      '1、题干一（ ）',
      'A. 甲',
      'B. 乙',
      'C. 丙',
      'D. 丁',
      '答案：B',
    ]),
    '普通选项',
  );
  assert.equal(parsed.questions.length, 1);
  assert.deepEqual(Object.keys(parsed.questions[0].options), ['A', 'B', 'C', 'D']);
  assert.equal(parsed.questions[0].answer, 'B');
});

test('兼容项目符号不会误伤正文里的字母（CAD / GDP 等）', () => {
  const parsed = parseLines(
    linesOf([
      '1、下列关于 CAD 与 GDP 的说法正确的是（ ）',
      '• A. CAD 是计算机辅助设计',
      '• B. GDP 是国内生产总值',
      '答案：A',
    ]),
    '正文含英文缩写',
  );
  assert.equal(parsed.questions.length, 1);
  const q = parsed.questions[0];
  assert.deepEqual(Object.keys(q.options), ['A', 'B'], `实际 ${JSON.stringify(q.options)}`);
  assert.ok(q.stem.includes('CAD') && q.stem.includes('GDP'), `题干应保留原文：${q.stem}`);
});
