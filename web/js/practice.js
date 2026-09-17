/**
 * 刷题逻辑：取题、判定、会话推进。纯逻辑（无 DOM），由 UI 层调用。
 */

import * as eb from './ebbinghaus.js';
import { QT_JUDGE, QT_MULTI, QT_SINGLE, SUBJECTIVE_TYPES, checkAnswer, validateInput } from './models.js';

/** 练习模式定义 */
export const MODES = {
  order: '顺序练习',
  random: '随机练习',
  wrong: '错题重练',
  favorite: '收藏题目练习',
  due: '今日艾宾浩斯复习',
  typeOrder: '题型专项·顺序练习',
  typeRandom: '题型专项·随机练习',
  typeYear: '题型专项·按时间顺序练习',
};

/** @param {string} mode @returns {string} */
export function modeName(mode) {
  return MODES[mode] || mode;
}

/**
 * Fisher–Yates 洗牌（返回新数组）。
 * @template T @param {T[]} arr @returns {T[]}
 */
export function shuffle(arr) {
  const out = [...(arr || [])];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * 按模式取题。
 * @param {object} opts
 * @param {object} opts.bank 题库对象（含 questions）
 * @param {string} opts.mode 模式 key
 * @param {string} [opts.qtype] 题型（题型专项用，空表示全部）
 * @param {object[]} [opts.wrongRecords]
 * @param {object[]} [opts.favoriteRecords]
 * @param {number} [opts.limit] 最多取多少题（0/undefined 不限制）
 * @returns {object[]} 题目数组
 */
export function pickQuestions({ bank, mode, qtype = '', wrongRecords = [], favoriteRecords = [], limit = 0 }) {
  const questions = (bank && bank.questions) || [];
  let list;
  switch (mode) {
    case 'wrong':
      list = eb.sortForRetry(wrongRecords).map((r) => stripMeta(r));
      break;
    case 'due':
      list = eb.sortDue(eb.dueRecords(wrongRecords)).map((r) => stripMeta(r));
      break;
    case 'favorite':
      list = favoriteRecords.map((r) => stripMeta(r));
      break;
    case 'typeRandom':
      list = shuffle(filterType(questions, qtype));
      break;
    case 'typeYear':
      list = filterType(questions, qtype).sort((a, b) => {
        const ya = a.year ? 1 : 0;
        const yb = b.year ? 1 : 0;
        if (ya !== yb) return yb - ya; // 有年份的排前面，无年份的放最后
        return (a.year || 0) - (b.year || 0);
      });
      break;
    case 'typeOrder':
      list = filterType(questions, qtype);
      break;
    case 'random':
      list = shuffle(questions);
      break;
    case 'order':
    default:
      list = [...questions];
  }
  if (limit && limit > 0) list = list.slice(0, limit);
  return list;
}

/** 去掉错题记录里的复习元数据，只留题目字段 */
function stripMeta(record) {
  const {
    bankName, wrong_count, correct_streak, stage, next_review,
    added_at, last_wrong_at, last_answer_at, ...question
  } = record;
  return question;
}

function filterType(questions, qtype) {
  return qtype ? questions.filter((q) => q.qtype === qtype) : [...questions];
}

/**
 * 题库内存在的题型及数量（供题型专项选择）。
 * @param {object} bank
 * @returns {Array<{value:string,label:string,count:number}>}
 */
export function typeOptions(bank) {
  const counts = {};
  for (const q of (bank && bank.questions) || []) counts[q.qtype] = (counts[q.qtype] || 0) + 1;
  const opts = [{ value: '', label: `全部题型（${(bank && bank.questions || []).length} 题）`, count: (bank && bank.questions || []).length }];
  for (const [t, n] of Object.entries(counts)) opts.push({ value: t, label: `${t}题（${n} 题）`, count: n });
  return opts;
}

/**
 * 是否主观题（简答/论述）。
 * @param {object} q
 * @returns {boolean}
 */
export function isSubjective(q) {
  return SUBJECTIVE_TYPES.includes(q.qtype);
}

/**
 * 输入提示文案。
 * @param {object} q
 * @returns {string}
 */
export function inputHint(q) {
  if (q.qtype === QT_JUDGE) return '请选择「正确」或「错误」';
  if (q.qtype === QT_MULTI) return '多选题：可选择多个选项（如 A、C、D）';
  if (q.qtype === QT_SINGLE) return '单选题：请选择一个选项';
  return '先看参考答案，再自评是否掌握';
}

/**
 * 判定作答。
 * @param {object} q
 * @param {string|string[]} userInput 字母串（如 'AB'）或判断题答案
 * @returns {{ok:boolean, correct:boolean, value:string, message:string}}
 */
export function judge(q, userInput) {
  const raw = Array.isArray(userInput) ? userInput.join('') : String(userInput || '');
  const v = validateInput(q, raw);
  if (!v.ok) return { ok: false, correct: false, value: '', message: '输入不合法，请重新作答' };
  return { ok: true, correct: checkAnswer(q, v.value), value: v.value, message: '' };
}

/**
 * 答案展示文本。
 * @param {object} q
 * @returns {string}
 */
export function answerText(q) {
  if (q.answer) return q.answer;
  if (q.explanation) return q.explanation;
  return '（无参考答案）';
}

/**
 * 练习进度描述。
 * @param {number} index 当前第几题（从 1 开始）
 * @param {number} total
 * @param {object} session
 * @returns {string}
 */
export function progressText(index, total, session) {
  const answered = Number((session && session.answered) || 0);
  const correct = Number((session && session.correct) || 0);
  return `${index}/${total}　已答 ${answered} · 正确 ${correct}`;
}

/**
 * 把题型专项的时间顺序取题结果整理成可选年份分组的展示文本。
 * @param {object[]} questions
 * @returns {string}
 */
export function yearSummary(questions) {
  const withYear = questions.filter((q) => q.year);
  const without = questions.length - withYear.length;
  if (!withYear.length) return `共 ${questions.length} 题（均未识别到年份）`;
  const years = [...new Set(withYear.map((q) => q.year))].sort((a, b) => a - b);
  return `共 ${questions.length} 题，年份 ${years[0]}~${years[years.length - 1]}（${years.length} 个年份），无年份 ${without} 题`;
}
