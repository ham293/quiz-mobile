/**
 * 练习统计：单次练习会话（session）与题库累计统计（library）。
 * 纯逻辑、无 DOM；UI 负责渲染，这里同时提供文本版报告便于分享。
 */

import { QUESTION_TYPES, TYPE_ORDER, knowledgePoint } from './models.js';
import { nowStr } from './dates.js';

/**
 * 新建一次练习会话。
 * @param {string} mode 模式名（如 '顺序练习'）
 * @param {string} bankName
 * @returns {object}
 */
export function newSession(mode, bankName) {
  return {
    mode: mode || '',
    bankName: bankName || '',
    startedAt: nowStr(),
    finishedAt: '',
    answered: 0,
    correct: 0,
    wrongItems: [],
    typeStats: {},
    weakRaw: [],
    answeredQids: [],
    wrongBookTotal: 0,
  };
}

/**
 * 记录一次作答。
 * @param {object} session
 * @param {object} question
 * @param {boolean} correct
 * @param {string} userAnswer
 * @returns {object} session
 */
export function recordAnswer(session, question, correct, userAnswer = '') {
  session.answered = Number(session.answered || 0) + 1;
  if (correct) session.correct = Number(session.correct || 0) + 1;
  const t = question.qtype || '单选';
  if (!session.typeStats[t]) session.typeStats[t] = { answered: 0, correct: 0 };
  session.typeStats[t].answered += 1;
  if (correct) session.typeStats[t].correct += 1;
  if (!session.answeredQids.includes(question.qid)) session.answeredQids.push(question.qid);
  if (!correct) {
    session.wrongItems.push({
      qid: question.qid,
      stem: question.stem,
      qtype: t,
      answer: question.answer || '',
      userAnswer: userAnswer || '',
      explanation: question.explanation || '',
      location: question.page || question.line || question.para
        ? `第 ${question.page || 1} 页第 ${question.line || question.para} 行`
        : '位置未记录',
    });
  }
  session.weakRaw.push({ qid: question.qid, qtype: t, topic: knowledgePoint(question), correct: !!correct });
  return session;
}

/**
 * 结束会话。
 * @param {object} session
 * @returns {object}
 */
export function finishSession(session) {
  session.finishedAt = nowStr();
  return session;
}

/**
 * 正确率（0~100，保留一位小数）。
 * @param {{answered?:number, correct?:number, totalAnswered?:number, totalCorrect?:number}} x
 * @returns {number}
 */
export function accuracy(x) {
  if (!x) return 0;
  const answered = Number(x.answered ?? x.totalAnswered ?? 0);
  const correct = Number(x.correct ?? x.totalCorrect ?? 0);
  if (!answered) return 0;
  return Math.round((correct / answered) * 1000) / 10;
}

/**
 * 薄弱知识点：按错误次数降序。
 * @param {object} session
 * @param {number} top
 * @returns {Array<{topic:string, wrong:number, answered:number, accuracy:number}>}
 */
export function weakPoints(session, top = 5) {
  const map = new Map();
  for (const row of session.weakRaw || []) {
    const key = row.topic || row.qtype || '未分类';
    if (!map.has(key)) map.set(key, { topic: key, wrong: 0, answered: 0, right: 0 });
    const item = map.get(key);
    item.answered += 1;
    if (row.correct) item.right += 1;
    else item.wrong += 1;
  }
  return [...map.values()]
    .filter((x) => x.wrong > 0)
    .map((x) => ({ ...x, accuracy: x.answered ? Math.round((x.right / x.answered) * 1000) / 10 : 0 }))
    .sort((a, b) => b.wrong - a.wrong || b.answered - a.answered)
    .slice(0, top);
}

/**
 * 本次练习报告（结构化）。
 * @param {object} session
 * @returns {object}
 */
export function summarize(session) {
  return {
    mode: session.mode,
    bankName: session.bankName,
    startedAt: session.startedAt,
    finishedAt: session.finishedAt,
    answered: Number(session.answered || 0),
    correct: Number(session.correct || 0),
    accuracy: accuracy(session),
    wrongItems: session.wrongItems || [],
    wrongBookTotal: Number(session.wrongBookTotal || 0),
    typeStats: session.typeStats || {},
    weakPoints: weakPoints(session, 5),
  };
}

/**
 * 文本版报告（用于分享/复制）。
 * @param {object} session
 * @returns {string}
 */
export function summaryText(session) {
  const s = summarize(session);
  const lines = [];
  lines.push(`【${s.bankName}】${s.mode}`);
  lines.push(`本次答题 ${s.answered} 题，正确 ${s.correct} 题，正确率 ${s.accuracy}%`);
  lines.push(`当前错题本共 ${s.wrongBookTotal} 道`);
  if (s.wrongItems.length) {
    lines.push('答错题目：');
    s.wrongItems.forEach((w, i) => {
      lines.push(`  ${i + 1}. [${w.qtype}] ${String(w.stem).slice(0, 40)}（你的答案：${w.userAnswer || '—'}，正确答案：${w.answer || '—'}）`);
    });
  } else {
    lines.push('本次全部答对，很棒！');
  }
  if (s.weakPoints.length) {
    lines.push('薄弱知识点：');
    s.weakPoints.forEach((w) => lines.push(`  ${w.topic}：错 ${w.wrong} 题 / 共 ${w.answered} 题（正确率 ${w.accuracy}%）`));
  }
  return lines.join('\n');
}

/**
 * 把一次会话合并进题库累计统计。
 * @param {object} library
 * @param {object} session
 * @returns {object} library（原地更新并返回）
 */
export function mergeIntoLibrary(library, session) {
  const answered = Number(session.answered || 0);
  const correct = Number(session.correct || 0);
  const acc = accuracy(session);
  library.sessions = Number(library.sessions || 0) + 1;
  library.totalAnswered = Number(library.totalAnswered || 0) + answered;
  library.totalCorrect = Number(library.totalCorrect || 0) + correct;
  library.bestAccuracy = Math.max(Number(library.bestAccuracy || 0), acc);

  const mode = session.mode || '未命名模式';
  if (!library.byMode[mode]) library.byMode[mode] = { sessions: 0, answered: 0, correct: 0 };
  library.byMode[mode].sessions += 1;
  library.byMode[mode].answered += answered;
  library.byMode[mode].correct += correct;

  for (const [t, st] of Object.entries(session.typeStats || {})) {
    if (!library.byType[t]) library.byType[t] = { answered: 0, correct: 0 };
    library.byType[t].answered += st.answered;
    library.byType[t].correct += st.correct;
  }

  for (const w of weakPoints(session, 50)) {
    if (!library.weakPoints[w.topic]) library.weakPoints[w.topic] = { wrong: 0, answered: 0 };
    library.weakPoints[w.topic].wrong += w.wrong;
    library.weakPoints[w.topic].answered += w.answered;
  }

  library.recent.unshift({
    at: session.finishedAt || nowStr(),
    mode,
    answered,
    correct,
    accuracy: acc,
  });
  library.recent = library.recent.slice(0, 20);
  library.updatedAt = nowStr();
  return library;
}

/**
 * 累计统计总览（结构化，供 UI 渲染）。
 * @param {object} library
 * @returns {object}
 */
export function libraryReport(library) {
  const totalAnswered = Number(library.totalAnswered || 0);
  const totalCorrect = Number(library.totalCorrect || 0);
  const byType = Object.entries(library.byType || {})
    .map(([t, v]) => ({ type: t, ...v, accuracy: v.answered ? Math.round((v.correct / v.answered) * 1000) / 10 : 0 }))
    .sort((a, b) => (TYPE_ORDER[a.type] ?? 99) - (TYPE_ORDER[b.type] ?? 99));
  const byMode = Object.entries(library.byMode || {})
    .map(([m, v]) => ({ mode: m, ...v, accuracy: v.answered ? Math.round((v.correct / v.answered) * 1000) / 10 : 0 }))
    .sort((a, b) => b.sessions - a.sessions);
  const weak = Object.entries(library.weakPoints || {})
    .map(([topic, v]) => ({ topic, ...v }))
    .filter((x) => x.wrong > 0)
    .sort((a, b) => b.wrong - a.wrong)
    .slice(0, 5);
  return {
    bankName: library.bankName,
    sessions: Number(library.sessions || 0),
    totalAnswered,
    totalCorrect,
    accuracy: totalAnswered ? Math.round((totalCorrect / totalAnswered) * 1000) / 10 : 0,
    bestAccuracy: Number(library.bestAccuracy || 0),
    byType,
    byMode,
    weak,
    recent: (library.recent || []).slice(0, 10),
    types: QUESTION_TYPES,
  };
}
