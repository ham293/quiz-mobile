/**
 * 核心逻辑单元测试（Node 下直接跑，存储层自动降级为内存实现）：
 *   node --test tests/
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import * as M from '../web/js/models.js';
import * as EB from '../web/js/ebbinghaus.js';
import * as ST from '../web/js/stats.js';
import * as P from '../web/js/practice.js';
import * as repo from '../web/js/bank.js';
import * as db from '../web/js/db.js';
import { addDays, todayStr } from '../web/js/dates.js';

/* ------------------------------------------------------------- models */

test('sha1Hex 与已知向量一致', () => {
  assert.equal(M.sha1Hex('abc'), 'a9993e364706816aba3e25717850c26c9cd0d89d');
  assert.equal(M.sha1Hex(''), 'da39a3ee5e6b4b0d3255bfef95601890afd80709');
  assert.equal(M.sha1Hex('中文').length, 40);
});

test('题干归一化与 qid 去重', () => {
  const a = M.makeQid('  下列 说法 正确 的是（ ）。');
  const b = M.makeQid('下列说法正确的是()。');
  assert.equal(a, b, '空白与标点差异应视为同一题');
  assert.notEqual(a, M.makeQid('另一道题。'));
});

test('答案归一化', () => {
  assert.equal(M.normalizeChoice('ba'), 'AB');
  assert.equal(M.normalizeChoice('D、A、C'), 'ACD');
  assert.equal(M.normalizeJudge('√'), '正确');
  assert.equal(M.normalizeJudge('错'), '错误');
  assert.equal(M.normalizeJudge('T'), '正确');
  assert.equal(M.normalizeJudge('maybe'), '');
});

test('年份与知识点提取', () => {
  assert.equal(M.extractYear('2019年与2021年'), 2019);
  assert.equal(M.extractYear('没有年份'), null);
  assert.equal(M.extractTopic('【第一章 计算机】关于…'), '第一章 计算机');
  assert.equal(M.extractTopic('（经济法）关于…'), '经济法');
});

test('makeQuestion 补全派生字段', () => {
  const q = M.makeQuestion({ stem: '2020年的测试题', qtype: '多选', options: { a: '甲', b: '乙' }, answer: 'ba' });
  assert.equal(q.qtype, '多选');
  assert.deepEqual(Object.keys(q.options), ['A', 'B']);
  assert.equal(q.answer, 'AB');
  assert.equal(q.year, 2020);
  assert.equal(q.qid.length, 16);
  assert.equal(q.source, 'auto');
});

test('答案判定：单选/多选/判断', () => {
  const single = M.makeQuestion({ stem: 's', qtype: '单选', options: { A: 'x', B: 'y' }, answer: 'B' });
  assert.equal(M.checkAnswer(single, 'b'), true);
  assert.equal(M.checkAnswer(single, 'A'), false);

  const multi = M.makeQuestion({ stem: 'm', qtype: '多选', options: { A: 'x', B: 'y', C: 'z' }, answer: 'AB' });
  assert.equal(M.checkAnswer(multi, 'BA'), true);
  assert.equal(M.checkAnswer(multi, 'A'), false);

  const judge = M.makeQuestion({ stem: 'j', qtype: '判断', answer: '√' });
  assert.equal(judge.answer, '正确');
  assert.equal(M.checkAnswer(judge, '对'), true);
  assert.equal(M.checkAnswer(judge, 'T'), true);
  assert.equal(M.checkAnswer(judge, '错误'), false);

  const judgeAb = M.makeQuestion({ stem: 'j2', qtype: '判断', options: { A: '正确', B: '错误' }, answer: 'B' });
  assert.equal(judgeAb.answer, '错误');
  assert.equal(M.checkAnswer(judgeAb, 'B'), true);
  assert.equal(M.checkAnswer(judgeAb, '正确'), false);
});

test('输入校验：单选不允许两个字母', () => {
  const single = M.makeQuestion({ stem: 's', qtype: '单选', options: { A: 'x', B: 'y' }, answer: 'A' });
  assert.equal(M.validateInput(single, 'AB').ok, false);
  assert.equal(M.validateInput(single, 'A').ok, true);
  assert.equal(M.validateInput(single, '你').ok, false);
  assert.equal(M.validateInput(single, '').ok, false);
  const multi = M.makeQuestion({ stem: 'm', qtype: '多选', options: { A: 'x', B: 'y' }, answer: 'AB' });
  assert.equal(M.validateInput(multi, 'ab').value, 'AB');
});

test('位置描述', () => {
  assert.equal(M.locationText(M.makeQuestion({ stem: 'a', page: 2, line: 5 })), '第 2 页第 5 行');
  assert.equal(M.locationText(M.makeQuestion({ stem: 'a', para: 7 })), '第 7 段');
  assert.equal(M.locationText(M.makeQuestion({ stem: 'a', source: 'manual' })), '手动补录');
});

/* -------------------------------------------------------- ebbinghaus */

test('艾宾浩斯：连续答对 7 次移出，间隔序列正确', () => {
  const q = M.makeQuestion({ stem: '错题', qtype: '单选', answer: 'A' });
  const base = '2026-03-01';
  let rec = EB.newRecord(q, base);
  assert.equal(rec.stage, 0);
  assert.equal(rec.next_review, base);
  assert.equal(rec.wrong_count, 1);
  assert.equal(EB.isDue(rec, base), true);

  const expected = [['2026-03-02', 1], ['2026-03-03', 2], ['2026-03-05', 3], ['2026-03-08', 4], ['2026-03-16', 5], ['2026-03-31', 6]];
  for (const [date, stage] of expected) {
    const r = EB.markCorrect(rec, base);
    rec = r.record;
    assert.equal(rec.stage, stage);
    assert.equal(rec.next_review, date);
    assert.equal(r.graduated, false);
  }
  const last = EB.markCorrect(rec, base);
  assert.equal(last.record.correct_streak, 7);
  assert.equal(last.graduated, true, '第 7 次连对应毕业');
});

test('艾宾浩斯：答错清零阶段与连对', () => {
  const q = M.makeQuestion({ stem: 'x', qtype: '单选', answer: 'A' });
  let rec = EB.newRecord(q, '2026-03-01');
  rec = EB.markCorrect(rec, '2026-03-01').record;
  rec = EB.markCorrect(rec, '2026-03-01').record;
  assert.equal(rec.stage, 2);
  const wrong = EB.markWrong(rec, '2026-03-05');
  assert.equal(wrong.stage, 0);
  assert.equal(wrong.correct_streak, 0);
  assert.equal(wrong.wrong_count, 2);
  assert.equal(wrong.next_review, '2026-03-05');
});

test('到期筛选与排序', () => {
  const today = '2026-03-10';
  const mk = (over) => ({ qid: over.qid, qtype: '单选', stage: 0, wrong_count: 1, next_review: today, added_at: '', ...over });
  const list = [
    mk({ qid: 'A', stage: 0, next_review: today, wrong_count: 1 }),
    mk({ qid: 'B', stage: 0, next_review: '2026-03-07', wrong_count: 1 }),
    mk({ qid: 'C', stage: 2, next_review: '2026-03-07', wrong_count: 9 }),
    mk({ qid: 'D', stage: 1, next_review: '2026-03-20', wrong_count: 5 }),
    mk({ qid: 'E', stage: 0, next_review: '', wrong_count: 1 }),
  ];
  const due = EB.dueRecords(list, today).map((r) => r.qid).sort();
  assert.deepEqual(due, ['A', 'B', 'C', 'E'], '未到期的 D 应被剔除');
  assert.equal(EB.dueCount(list, today), 4);
  assert.deepEqual(EB.sortDue(EB.dueRecords(list, today), today).map((r) => r.qid), ['E', 'B', 'A', 'C']);
  assert.deepEqual(EB.sortForRetry(list).map((r) => r.qid), ['C', 'D', 'A', 'B', 'E']);
});

test('按题型分组与进度文案', () => {
  const recs = [
    { qtype: '单选', qid: '1' }, { qtype: '判断', qid: '2' }, { qtype: '单选', qid: '3' },
  ];
  const grouped = EB.groupByType(recs);
  assert.deepEqual(Object.keys(grouped), ['单选', '判断']);
  assert.equal(grouped['单选'].length, 2);
  assert.match(EB.stageProgress({ stage: 3, correct_streak: 2 }), /阶段 3\/6 · 连续答对 2\/7/);
});

/* -------------------------------------------------------------- stats */

test('统计：会话累计、报告与薄弱知识点', async () => {
  const session = ST.newSession('顺序练习', '测试题库');
  const q1 = M.makeQuestion({ stem: '【第一章】题一', qtype: '单选', options: { A: 'x', B: 'y' }, answer: 'A' });
  const q2 = M.makeQuestion({ stem: '题二', qtype: '多选', options: { A: 'x', B: 'y' }, answer: 'AB' });
  ST.recordAnswer(session, q1, true, 'A');
  ST.recordAnswer(session, q2, false, 'A');
  ST.finishSession(session);
  session.wrongBookTotal = 3;

  assert.equal(session.answered, 2);
  assert.equal(session.correct, 1);
  assert.equal(ST.accuracy(session), 50);
  const report = ST.summarize(session);
  assert.equal(report.wrongItems.length, 1);
  assert.equal(report.wrongBookTotal, 3);
  assert.equal(report.weakPoints[0].topic, '多选');
  assert.match(ST.summaryText(session), /本次答题 2 题/);

  const lib = repo.newStats('测试题库');
  ST.mergeIntoLibrary(lib, session);
  ST.mergeIntoLibrary(lib, session);
  assert.equal(lib.sessions, 2);
  assert.equal(lib.totalAnswered, 4);
  assert.equal(lib.bestAccuracy, 50);
  const libReport = ST.libraryReport(lib);
  assert.equal(libReport.accuracy, 50);
  assert.equal(libReport.byType.length, 2);
  assert.equal(libReport.recent.length, 2);
});

/* ----------------------------------------------------------- practice */

test('取题：8 种模式', () => {
  const bank = {
    name: 'B',
    questions: [
      M.makeQuestion({ stem: '2019年单选', qtype: '单选', options: { A: 'x', B: 'y' }, answer: 'A' }),
      M.makeQuestion({ stem: '多选无年份', qtype: '多选', options: { A: 'x', B: 'y' }, answer: 'AB' }),
      M.makeQuestion({ stem: '2021年判断', qtype: '判断', answer: '正确' }),
    ],
  };
  const wrongRecords = [{ ...bank.questions[0], wrong_count: 3, stage: 1, next_review: todayStr(), bankName: 'B' }];
  const favoriteRecords = [{ ...bank.questions[1], bankName: 'B', added_at: '' }];

  assert.equal(P.pickQuestions({ bank, mode: 'order' }).length, 3);
  assert.equal(P.pickQuestions({ bank, mode: 'random' }).length, 3);
  assert.equal(P.pickQuestions({ bank, mode: 'wrong', wrongRecords }).length, 1);
  assert.equal(P.pickQuestions({ bank, mode: 'favorite', favoriteRecords }).length, 1);
  assert.equal(P.pickQuestions({ bank, mode: 'due', wrongRecords }).length, 1);
  assert.equal(P.pickQuestions({ bank, mode: 'typeOrder', qtype: '判断' }).length, 1);
  assert.equal(P.pickQuestions({ bank, mode: 'typeRandom', qtype: '单选' })[0].qtype, '单选');

  const byYear = P.pickQuestions({ bank, mode: 'typeYear' });
  assert.deepEqual(byYear.map((q) => q.year), [2019, 2021, null], '有年份升序、无年份最后');
});

test('取题：错题/收藏记录里的元数据被剥离', () => {
  const rec = { qid: 'x', stem: 's', qtype: '单选', answer: 'A', wrong_count: 2, stage: 1, next_review: '2026-01-01', bankName: 'B' };
  const [q] = P.pickQuestions({ bank: { name: 'B', questions: [] }, mode: 'wrong', wrongRecords: [rec] });
  assert.equal(q.wrong_count, undefined);
  assert.equal(q.bankName, undefined);
  assert.equal(q.stem, 's');
});

test('判定与提示', () => {
  const q = M.makeQuestion({ stem: 's', qtype: '多选', options: { A: 'x', B: 'y', C: 'z' }, answer: 'AB' });
  assert.equal(P.judge(q, 'AB').correct, true);
  assert.equal(P.judge(q, ['A', 'B']).correct, true);
  assert.equal(P.judge(q, 'C').correct, false);
  assert.equal(P.judge(q, 'Q').ok, false);
  assert.match(P.inputHint(q), /多选/);
  assert.equal(P.isSubjective(M.makeQuestion({ stem: 's', qtype: '简答' })), true);
  assert.equal(P.modeName('due'), '今日艾宾浩斯复习');
  assert.ok(P.typeOptions({ questions: [q] })[0].label.includes('全部题型'));
});

/* --------------------------------------------------------------- bank */

test('存储层：内存降级模式', async () => {
  assert.equal(db.isMemoryMode(), true, 'Node 下应自动降级为内存实现');
  await db.put('meta', { key: 'k', value: 1 });
  assert.deepEqual(await db.get('meta', 'k'), { key: 'k', value: 1 });
});

test('题库：导入、隔离、错题本、收藏本、统计、日志、补录、删除', async () => {
  const name = '单元测试题库';
  await db.clearAll();

  const q1 = M.makeQuestion({ stem: '题一', qtype: '单选', options: { A: 'x', B: 'y' }, answer: 'A' });
  const q2 = M.makeQuestion({ stem: '题二', qtype: '判断', answer: '正确' });
  const parsed = {
    questions: [q1, q2],
    errors: [{ time: 't', bank: name, page: 1, line: 1, reason: 'r', raw: 'x' }],
    skipped: [{ page: 1, line: 2, content: '推广语', reason: '页眉页脚/推广语' }],
    warnings: ['w'],
    totalUnits: 10,
    noiseRemoved: 2,
  };
  const bank = await repo.importParsed(name, parsed, { fileName: 'a.docx', fileType: 'docx' });
  assert.equal(bank.questions.length, 2);

  const list = await repo.listBanks();
  assert.equal(list.length, 1);
  assert.equal(list[0].questionCount, 2);
  assert.equal(list[0].fileName, 'a.docx');

  assert.equal((await repo.loadLogs(name, 'errors')).length, 1);
  assert.equal((await repo.loadLogs(name, 'skipped')).length, 1);

  // 答错 → 进错题本；再答错 → 次数累加
  let res = await repo.recordPracticeResult(name, q1, false);
  assert.equal(res.status, 'added');
  res = await repo.recordPracticeResult(name, q1, false);
  assert.equal(res.status, 'updated');
  let wrong = await repo.loadWrong(name);
  assert.equal(wrong.length, 1);
  assert.equal(wrong[0].wrong_count, 2);
  assert.equal(wrong[0].stage, 0);
  assert.equal(wrong[0].bankName, undefined, '对外不应暴露 bankName');

  // 连续答对 7 次 → 移出
  for (let i = 0; i < 7; i++) res = await repo.recordPracticeResult(name, q1, true);
  assert.equal(res.status, 'graduated');
  assert.equal((await repo.loadWrong(name)).length, 0);

  // 收藏
  assert.equal(await repo.toggleFavorite(name, q2), true);
  assert.equal(await repo.isFavorite(name, q2.qid), true);
  assert.equal(await repo.favoriteTotal(name), 1);
  assert.equal(await repo.toggleFavorite(name, q2), false);
  assert.equal(await repo.favoriteTotal(name), 0);
  await repo.toggleFavorite(name, q2);

  // 统计落盘
  const lib = await repo.loadStats(name);
  assert.equal(lib.sessions, 0);
  lib.sessions = 1;
  lib.totalAnswered = 5;
  await repo.saveStats(name, lib);
  assert.equal((await repo.loadStats(name)).totalAnswered, 5);

  // 手动补录：新增 → 同题干覆盖 → 删除
  const manual = M.makeQuestion({ stem: '补录题（  ）', qtype: '单选', options: { A: 'x', B: 'y' }, answer: 'B', source: 'manual' });
  const add1 = await repo.addManual(name, manual);
  assert.equal(add1.added, true);
  assert.equal((await repo.getBank(name)).questions.length, 3);
  const dup = await repo.addManual(name, M.makeQuestion({ ...manual, stem: '补录题()', explanation: '改过' }));
  assert.equal(dup.added, false, '同题干应覆盖而非新增');
  assert.equal((await repo.getBank(name)).questions.length, 3);
  assert.equal((await repo.loadManual(name))[0].explanation, '改过');
  assert.equal(await repo.deleteManualAt(name, 0), true);
  assert.equal((await repo.getBank(name)).questions.length, 2);

  // 多题库隔离
  const other = await repo.importParsed('另一个题库', { questions: [M.makeQuestion({ stem: '别的题', qtype: '单选' })] });
  assert.equal(other.questions.length, 1);
  assert.equal((await repo.listBanks()).length, 2);
  assert.equal((await repo.loadWrong('另一个题库')).length, 0);
  assert.equal(await repo.favoriteTotal('另一个题库'), 0);
  assert.equal((await repo.loadLogs('另一个题库', 'errors')).length, 0);

  // 删除题库
  await repo.deleteBank(name);
  assert.equal(await repo.getBank(name), undefined);
  assert.equal((await repo.listBanks()).length, 1);
  assert.equal((await repo.loadFavorites(name)).length, 0);
});

test('日期工具', () => {
  assert.equal(addDays('2026-03-01', 15), '2026-03-16');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(todayStr().length, 10);
});
