/**
 * parser-text.js 单元测试
 *
 * 运行：cd "D:\ds haness\quiz-mobile" && node --test tests/parser-text.test.mjs
 * 说明：全部用例只依赖纯逻辑模块（不碰 DOM），sha1 与 Node 内置 crypto 对拍。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  ParseError,
  parseLines,
  sha1Hex,
  normalizeStem,
  normalizeChoice,
  normalizeJudge,
  extractYear,
  extractTopic,
  makeQid,
  makeQuestion,
  QUESTION_TYPES,
} from '../web/js/parser-text.js';

/**
 * 构造 docx/txt 风格的题目行（page=0，line=para=序号从 1 开始）。
 * @param {...string} texts 每行文本
 * @returns {Array<object>} 题目行数组
 */
function L(...texts) {
  return texts.map((text, i) => ({ page: 0, line: i + 1, para: i + 1, text }));
}

/**
 * 构造 PDF 风格的题目行（page 固定，line = 页内行号，para=0）。
 * @param {number} page 页码
 * @param {...string} texts 每行文本
 * @returns {Array<object>} 题目行数组
 */
function P(page, ...texts) {
  return texts.map((text, i) => ({ page, line: i + 1, para: 0, text }));
}

/* ================================================================
 * sha1 与归一化工具
 * ================================================================ */

test('sha1Hex：同步实现与标准向量、Node crypto 一致（含中文与代理对）', () => {
  assert.equal(sha1Hex(''), 'da39a3ee5e6b4b0d3255bfef95601890afd80709');
  assert.equal(sha1Hex('abc'), 'a9993e364706816aba3e25717850c26c9cd0d89d');
  const sample = '第二章 中国的首都是（B） A.北京 B.上海';
  assert.equal(sha1Hex(sample), createHash('sha1').update(sample, 'utf8').digest('hex'));
  assert.equal(sha1Hex('题干🙂emoji'), createHash('sha1').update('题干🙂emoji', 'utf8').digest('hex'));
  assert.equal(sha1Hex('题干🙂emoji').length, 40);
});

test('normalizeChoice / normalizeJudge / normalizeStem 归一化', () => {
  assert.equal(normalizeChoice('ba'), 'AB');
  assert.equal(normalizeChoice('A、C、B'), 'ABC');
  assert.equal(normalizeChoice('D'), 'D');
  assert.equal(normalizeChoice('正确'), '');
  assert.equal(normalizeJudge('√'), '正确');
  assert.equal(normalizeJudge('×'), '错误');
  assert.equal(normalizeJudge('对'), '正确');
  assert.equal(normalizeJudge('T'), '正确');
  assert.equal(normalizeJudge('也许'), '');
  assert.equal(normalizeStem('中国的 首都，是（ ）'), '中国的首都是');
  assert.equal(QUESTION_TYPES.length, 5);
});

test('normalizeStem 去重：同题干不同空白/标点 → 同一 qid', () => {
  const a = parseLines(L('1. 中国的 首都 是（A）', 'A.北京', 'B.上海'));
  const b = parseLines(L('9. 中国的首都是（A）', 'A.北京', 'B.上海'));
  assert.equal(a.questions.length, 1);
  assert.equal(b.questions.length, 1);
  assert.equal(a.questions[0].qid, b.questions[0].qid);
  assert.equal(a.questions[0].qid.length, 16);
  assert.equal(makeQid('中国的 首都 是', {}), sha1Hex('中国的首都是').slice(0, 16));
  assert.equal(makeQid('', { A: '甲', B: '乙' }), sha1Hex('甲乙').slice(0, 16));
});

test('ParseError：Error 子类，默认中文消息', () => {
  const err = new ParseError();
  assert.ok(err instanceof Error);
  assert.ok(err instanceof ParseError);
  assert.equal(err.name, 'ParseError');
  assert.equal(err.message, '解析失败');
  assert.equal(new ParseError('自定义消息').message, '自定义消息');
});

/* ================================================================
 * 切题与题型判定
 * ================================================================ */

test('单选：答案在括号内，答案文本从题干中删除', () => {
  const r = parseLines(L('1. 中华人民共和国的首都是（B）', 'A. 上海', 'B. 北京', 'C. 广州', 'D. 深圳'));
  assert.equal(r.questions.length, 1);
  assert.equal(r.errors.length, 0);
  const q = r.questions[0];
  assert.equal(q.qtype, '单选');
  assert.equal(q.stem, '中华人民共和国的首都是');
  assert.equal(q.answer, 'B');
  assert.deepEqual(Object.keys(q.options), ['A', 'B', 'C', 'D']);
  assert.equal(q.options.B, '北京');
  assert.equal(q.qid.length, 16);
});

test('空括号不算答案：答案来自独立行，解析单独提取并保留换行', () => {
  const r = parseLines(L(
    '2. 下列属于基本原则的是（ ）',
    'A. 甲原则',
    'B. 乙原则',
    '答案：A',
    '解析：甲原则是基本原则。',
    '解析的补充说明。',
  ));
  assert.equal(r.questions.length, 1);
  const q = r.questions[0];
  assert.equal(q.stem, '下列属于基本原则的是（ ）');
  assert.equal(q.answer, 'A');
  assert.equal(q.qtype, '单选');
  assert.equal(q.explanation, '甲原则是基本原则。\n解析的补充说明。');
  assert.equal(r.errors.length, 0);
});

test('多选：一行挤 4 个选项要切成 4 项', () => {
  const r = parseLines(L('3. 下列属于新发展理念的有（ ）A.新思想B.新举措C.新格局D.新时代', '答案：ACD'));
  const q = r.questions[0];
  assert.equal(q.qtype, '多选');
  assert.deepEqual(q.options, { A: '新思想', B: '新举措', C: '新格局', D: '新时代' });
  assert.equal(q.answer, 'ACD');
  assert.equal(q.stem, '下列属于新发展理念的有（ ）');
});

test('选项跨行续行合并到上一个选项', () => {
  const r = parseLines(L('4. 题干（ ）', 'A. 第一项开头', '第一项的续行内容', 'B. 第二项', '答案：A'));
  const q = r.questions[0];
  assert.equal(q.options.A, '第一项开头\n第一项的续行内容');
  assert.equal(q.options.B, '第二项');
  assert.equal(q.answer, 'A');
});

test('CAD / GDP增长 / 维生素 A / 1.5倍 / 2024年 不被误切、不误判题号', () => {
  const r1 = parseLines(L('5. 关于 CAD 软件与 GDP增长 的说法正确的是（ ）', 'A. 甲', 'B. 乙', '答案：A'));
  assert.equal(r1.questions.length, 1);
  assert.equal(r1.questions[0].stem, '关于 CAD 软件与 GDP增长 的说法正确的是（ ）');
  assert.deepEqual(Object.keys(r1.questions[0].options), ['A', 'B']);

  const r2 = parseLines(L('6. 维生素 A 缺乏会导致夜盲症（ ）', 'A. 正确', 'B. 错误', '答案：A'));
  assert.equal(r2.questions[0].stem, '维生素 A 缺乏会导致夜盲症（ ）');
  assert.equal(r2.questions[0].qtype, '判断');
  assert.equal(r2.questions[0].answer, '正确');
  assert.equal(Object.keys(r2.questions[0].options).length, 2);

  const r3 = parseLines(L('7. 某物增长率是 1.5倍，2024年数据如下（ ）', 'A. 甲', 'B. 乙', '答案：B'));
  assert.equal(r3.questions.length, 1);
  assert.equal(r3.questions[0].stem, '某物增长率是 1.5倍，2024年数据如下（ ）');
  assert.equal(r3.questions[0].answer, 'B');
});

test('五种题型：显式标记优先于启发式', () => {
  const r = parseLines(L(
    '1.【单选题】属于新思想的是（ ）A.甲 B.乙 答案：A',
    '2.（多选题）属于新思想的是（ ）A.甲 B.乙 C.丙 答案：AB',
    '3.【判断题】新思想是正确的（ ）答案：正确',
    '4.简答题 请简述基本原则。',
    '5.论述题 试述基本原则的历史意义。',
  ));
  assert.equal(r.questions.length, 5);
  assert.deepEqual(r.questions.map((q) => q.qtype), ['单选', '多选', '判断', '简答', '论述']);
  assert.equal(r.errors.length, 0);
});

test('无题号/无标记时的启发式：论述特征词 vs 简答', () => {
  const r = parseLines(L(
    '6. 试述改革开放的伟大历史意义。',
    '7. 简述改革开放的主要成就。',
    '8. 结合实际谈谈你的看法。',
    '9. 关于客服的说法是什么。',
  ));
  assert.deepEqual(r.questions.map((q) => q.qtype), ['论述', '简答', '论述', '简答']);
  assert.equal(r.questions.length, 4);
});

test('题号形态：中文数字 / 第 3 题 / (4) / 1．', () => {
  const r = parseLines(L(
    '一、第一道题（ ）A.甲 B.乙 答案：A',
    '第 3 题 第三道题（ ）A.甲 B.乙 答案：B',
    '(4) 第四道题（ ）A.甲 B.乙 答案：A',
    '1．第五道题（ ）A.甲 B.乙 答案：B',
  ));
  assert.equal(r.questions.length, 4);
  assert.deepEqual(r.questions.map((q) => q.stem), ['第一道题（ ）', '第三道题（ ）', '第四道题（ ）', '第五道题（ ）']);
  assert.deepEqual(r.questions.map((q) => q.answer), ['A', 'B', 'A', 'B']);
  assert.equal(r.errors.length, 0);
});

test('中文数字题号后紧跟选项字母时不算题号', () => {
  const r = parseLines(L('1. 题干（ ）', '一、A. 甲 B. 乙', '答案：A'));
  assert.equal(r.questions.length, 1);
  // 「一、A. 甲 B. 乙」不是新题，也不会被当作选项行之外的新题号
  assert.equal(r.questions[0].stem.startsWith('题干'), true);
});

/* ================================================================
 * 答案提取与归一化
 * ================================================================ */

test('判断题：括号 √ / 独立行 √ / A.正确 B.错误 + 答案：B 均归一化', () => {
  const r = parseLines(L(
    '3. 地球是圆的（√）',
    '4. 水的沸点是100摄氏度',
    '答案：√',
    '5. 太阳从西边升起（ ）',
    'A. 正确',
    'B. 错误',
    '答案：B',
  ));
  assert.equal(r.questions.length, 3);
  assert.deepEqual(r.questions.map((q) => q.qtype), ['判断', '判断', '判断']);
  assert.deepEqual(r.questions.map((q) => q.answer), ['正确', '正确', '错误']);
  assert.equal(r.questions[0].stem, '地球是圆的');
  assert.equal(r.errors.length, 0);
});

test('答案与最后一个选项同一行结尾 / 行内答案 + 行内解析', () => {
  const r = parseLines(L('1. 题干（ ）', 'A. 甲', 'B. 乙', 'C. 丙', 'D.新时代  答案：D'));
  assert.equal(r.questions[0].answer, 'D');
  assert.equal(r.questions[0].options.D, '新时代');
  assert.equal(Object.keys(r.questions[0].options).length, 4);

  const r2 = parseLines(L('2. 题干（ ）A.甲 B.乙 答案：AB 解析：甲和乙都正确。'));
  assert.equal(r2.questions[0].answer, 'AB');
  assert.equal(r2.questions[0].qtype, '多选');
  assert.equal(r2.questions[0].explanation, '甲和乙都正确。');
});

test('「答案：」后换行取值；主观题多行答案保留原文', () => {
  const r = parseLines(L('1. 题干（ ）', 'A. 甲', 'B. 乙', '答案：', 'B'));
  assert.equal(r.questions.length, 1);
  assert.equal(r.questions[0].answer, 'B');
  assert.equal(r.questions[0].qtype, '单选');

  const r2 = parseLines(L('2.【简答题】请简述基本原则。', '答案：坚持党的领导，', '坚持以人民为中心。'));
  assert.equal(r2.questions[0].qtype, '简答');
  assert.equal(r2.questions[0].answer, '坚持党的领导，\n坚持以人民为中心。');
});

/* ================================================================
 * 噪声、异常与跳过
 * ================================================================ */

test('页码/推广语/分隔线/章节标题被跳过，skipped 字段齐全', () => {
  const r = parseLines(P(
    1,
    '',
    '- 1 -',
    '第 1 页 共 2 页',
    '3/20',
    '12',
    '扫码关注公众号，免费领取全部资料电子版',
    '添加客服微信获取更多资料',
    '==========',
    '一、单项选择题',
    '1. 题干（ ）A.甲 B.乙 C.丙 D.丁 答案：A',
  ), '题库A');
  assert.equal(r.questions.length, 1);
  assert.equal(r.skipped.length, 8);
  // 页码 4 + 推广语 2 + 分隔线 1 + 空白行 1 = 8；题型标题行只进 skipped、不计噪声（与 Python 版一致）
  assert.equal(r.noiseRemoved, 8);
  assert.deepEqual(
    r.skipped.map((s) => s.reason),
    ['页码', '页码', '页码', '页码', '页眉页脚/推广语', '页眉页脚/推广语', '分隔线', '题型标题行'],
  );
  for (const s of r.skipped) {
    assert.deepEqual(Object.keys(s), ['page', 'line', 'content', 'reason']);
    assert.equal(typeof s.page, 'number');
    assert.equal(typeof s.line, 'number');
    assert.equal(typeof s.content, 'string');
    assert.equal(typeof s.reason, 'string');
  }
  assert.equal(r.skipped[0].page, 1);
  assert.equal(r.skipped[0].content, '- 1 -');
  assert.equal(r.skipped[4].content, '扫码关注公众号，免费领取全部资料电子版');
  // 章节标题行不产生空题干噪声
  assert.equal(r.errors.length, 0);
});

test('题目外文本与无法归属的孤行记入 skipped', () => {
  const r = parseLines(L(
    '这是题目开始前的说明文字',
    '1. 题干（ ）',
    'A. 甲',
    'B. 乙',
    '答案：A',
    '游离在题目之外的一行说明',
  ));
  assert.equal(r.questions.length, 1);
  assert.equal(r.skipped.length, 2);
  assert.equal(r.skipped[0].reason, '题目外文本');
  assert.equal(r.skipped[1].reason, '无法归属的孤行');
  assert.equal(r.skipped[0].line, 1);
  assert.equal(r.skipped[1].line, 6);
});

test('空题干坏题进 errors 且不进 questions；答案缺失题保留并记 error/warning', () => {
  const r = parseLines(L('1.', '2. 有选项但没有答案的题（ ）', 'A. 甲', 'B. 乙'), '题库X');
  assert.equal(r.questions.length, 1);
  assert.equal(r.questions[0].qtype, '单选');
  assert.equal(r.questions[0].answer, '');
  assert.equal(r.errors.length, 2);
  assert.ok(r.errors.some((e) => e.reason.includes('题干为空')));
  assert.ok(r.errors.some((e) => e.reason.includes('答案缺失')));
  for (const e of r.errors) {
    assert.deepEqual(Object.keys(e), ['time', 'bank', 'page', 'line', 'reason', 'raw']);
    assert.equal(e.bank, '题库X');
    assert.match(e.time, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  }
  assert.equal(r.errors[0].raw, '1.'); // 被丢弃的坏题
  assert.equal(r.errors[1].raw, '2. 有选项但没有答案的题（ ）\nA. 甲\nB. 乙'); // 保留题的原始全文
  assert.ok(r.warnings.some((w) => w.includes('答案缺失')));
});

test('判断题答案无法归一化：保留题目并记 error', () => {
  const r = parseLines(L('1.【判断题】说法正确（ ）', 'A. 正确', 'B. 错误', '答案：C'));
  assert.equal(r.questions.length, 1);
  assert.equal(r.questions[0].qtype, '判断');
  assert.equal(r.questions[0].answer, 'C');
  assert.ok(r.errors.some((e) => e.reason.includes('判断题答案缺失或无法归一化')));
  assert.ok(r.warnings.some((w) => w.includes('判断题')));
});

test('选项字母重复：按最后一次为准并记 warning', () => {
  const r = parseLines(L('1. 题干（ ）', 'A. 甲', 'B. 乙', 'A. 甲（修正）', '答案：A'));
  assert.equal(r.questions.length, 1);
  assert.equal(r.questions[0].options.A, '甲（修正）');
  assert.equal(r.questions[0].options.B, '乙');
  assert.ok(r.warnings.some((w) => w.includes('重复')));
});

test('单行解析异常兜底：记 errors 且不影响其他题目', () => {
  const bad = { page: 0, line: 2, para: 2, get text() { throw new Error('坏数据'); } };
  const weird = { page: 0, line: 3, para: 3, text: { toString() { throw new Error('也不该崩'); } } };
  const r = parseLines([
    { page: 0, line: 1, para: 1, text: '1. 题干（ ）A.甲 B.乙 答案：A' },
    bad,
    weird,
    { page: 0, line: 4, para: 4, text: '2. 第二题（ ）A.甲 B.乙 答案：B' },
  ]);
  assert.equal(r.questions.length, 2);
  assert.equal(r.errors.length, 1);
  assert.ok(r.errors[0].reason.includes('单行解析失败'));
  assert.ok(r.errors[0].reason.includes('坏数据'));
  assert.equal(r.errors[0].line, 2);
  assert.equal(r.errors[0].page, 0);
  assert.equal(r.questions[1].answer, 'B');
  assert.equal(r.noiseRemoved, 1); // toString 抛异常的那行被安全降级成空行
});

/* ================================================================
 * 位置 / 年份 / 知识点 / summary / 纯函数
 * ================================================================ */

test('年份、知识点与位置字段', () => {
  const r = parseLines(L('1. 2024年与2019年的对比分析（ ）A.甲 B.乙 答案：A', '2.【第一章】基本原则（ ）A.甲 B.乙 答案：A'));
  assert.equal(r.questions[0].year, 2019);
  assert.equal(r.questions[1].year, null);
  assert.equal(r.questions[1].topic, '第一章');
  assert.equal(makeQuestion({ stem: '无年份题干' }).year, null);
  assert.equal(extractYear('2021年和1998年'), 1998);
  assert.equal(extractTopic('【第三章】题干'), '第三章');
  assert.equal(extractTopic('（第二章）题干'), '第二章');
  assert.equal(extractTopic('（ ）题干'), '');

  const p = parseLines(P(3, '1. 题干（ ）A.甲 B.乙 答案：A'));
  assert.equal(p.sourceType, 'pdf');
  assert.equal(p.questions[0].page, 3);
  assert.equal(p.questions[0].line, 1);
  assert.equal(p.questions[0].para, 0);

  const d = parseLines([{ page: 0, line: 5, para: 5, text: '1. 题干（ ）A.甲 B.乙 答案：A' }]);
  assert.equal(d.sourceType, 'docx');
  assert.equal(d.questions[0].para, 5);
  assert.equal(d.questions[0].line, 5);
});

test('summary() 输出包含总行数、题数与题型统计', () => {
  const r = parseLines(L('1. 题干（ ）A.甲 B.乙 答案：A', '2.【多选题】题干（ ）A.甲 B.乙 C.丙 答案：AB', '---', ''));
  const s = r.summary();
  assert.equal(typeof s, 'string');
  assert.equal(r.totalUnits, 4);
  assert.ok(s.includes('读取总行数：4 行'));
  assert.ok(s.includes('成功解析题目：2 道'));
  assert.ok(s.includes('单选题：1 道'));
  assert.ok(s.includes('多选题：1 道'));
  assert.ok(s.includes('跳过行数：1 行'));
  assert.ok(s.includes('噪声清理 2 行'));
  assert.ok(s.includes('解析异常：0 条'));
  assert.ok(s.includes('警告：0 条'));
  assert.ok(s.split('\n').length >= 6);
});

test('纯函数：不修改入参，重复解析结果一致', () => {
  const lines = L('1. 题干（ ）A.甲 B.乙 答案：A', '解析：因为甲。');
  const snapshot = JSON.stringify(lines);
  const first = parseLines(lines, 'B1');
  const second = parseLines(lines, 'B2');
  assert.equal(JSON.stringify(lines), snapshot);
  assert.deepEqual(first.questions, second.questions);
  assert.equal(first.questions[0].qid, second.questions[0].qid);
  assert.equal(first.errors.length, 0);
  assert.equal(first.questions[0].explanation, '因为甲。');
});
