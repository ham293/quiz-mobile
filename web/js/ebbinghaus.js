/**
 * 艾宾浩斯复习调度（纯函数，全部返回新对象，不修改入参）。
 *
 * 语义：
 *   答错 → wrong_count+1、连续答对清零、stage=0、下次复习=当天
 *   答对 → 连续答对+1、stage+1（不超过序列长度-1）、下次复习 = 今天 + 间隔[更新后的 stage]
 *   连续答对达到 GRADUATE_STREAK(7) → 返回 graduated=true，由调用方移出错题本
 */

import { EBBINGHAUS_INTERVALS, GRADUATE_STREAK } from './config.js';
import { addDays, daysBetween, nowStr, todayStr } from './dates.js';

/**
 * 新建错题记录。
 * @param {object} question
 * @param {string} [today]
 * @returns {object}
 */
export function newRecord(question, today = todayStr()) {
  const rec = { ...question };
  rec.wrong_count = 1;
  rec.correct_streak = 0;
  rec.stage = 0;
  rec.next_review = today;
  rec.added_at = nowStr();
  rec.last_wrong_at = rec.added_at;
  rec.last_answer_at = rec.added_at;
  return rec;
}

/**
 * 答错：错误次数+1，阶段与连续答对清零，当天复习。
 * @param {object} record
 * @param {string} [today]
 * @returns {object} 新记录
 */
export function markWrong(record, today = todayStr()) {
  const rec = { ...record };
  rec.wrong_count = Number(rec.wrong_count || 0) + 1;
  rec.correct_streak = 0;
  rec.stage = 0;
  rec.next_review = today;
  rec.last_wrong_at = nowStr();
  rec.last_answer_at = rec.last_wrong_at;
  return rec;
}

/**
 * 答对：连续答对+1，stage+1，按新 stage 的间隔安排下次复习。
 * @param {object} record
 * @param {string} [today]
 * @returns {{record: object, graduated: boolean}}
 */
export function markCorrect(record, today = todayStr()) {
  const rec = { ...record };
  const maxStage = EBBINGHAUS_INTERVALS.length - 1;
  rec.correct_streak = Number(rec.correct_streak || 0) + 1;
  rec.stage = Math.min(Number(rec.stage || 0) + 1, maxStage);
  const interval = EBBINGHAUS_INTERVALS[rec.stage] ?? 0;
  rec.next_review = addDays(today, interval);
  rec.last_answer_at = nowStr();
  return { record: rec, graduated: rec.correct_streak >= GRADUATE_STREAK };
}

/**
 * 是否到期（空 next_review 视为到期）。
 * @param {object} record
 * @param {string} [today]
 * @returns {boolean}
 */
export function isDue(record, today = todayStr()) {
  const due = record && record.next_review;
  if (!due) return true;
  return String(due).slice(0, 10) <= today;
}

/**
 * 只保留到期的记录。
 * @param {object[]} records
 * @param {string} [today]
 * @returns {object[]}
 */
export function dueRecords(records, today = todayStr()) {
  return (records || []).filter((r) => isDue(r, today));
}

/**
 * 到期记录排序：stage 小 → 逾期久 → 错误次数多。
 * 没有 next_review 的记录视为「逾期最久」，优先复习。
 * @param {object[]} records
 * @param {string} [today]
 * @returns {object[]}
 */
export function sortDue(records, today = todayStr()) {
  const overdue = (r) => (r && r.next_review ? -daysBetween(r.next_review, today) : Number.MAX_SAFE_INTEGER);
  return [...(records || [])].sort((a, b) => {
    const sa = Number(a.stage || 0);
    const sb = Number(b.stage || 0);
    if (sa !== sb) return sa - sb;
    const oa = overdue(a);
    const ob = overdue(b);
    if (oa !== ob) return ob - oa;
    return Number(b.wrong_count || 0) - Number(a.wrong_count || 0);
  });
}

/**
 * 错题重练排序：错误次数降序 → stage 升序 → 加入时间升序。
 * @param {object[]} records
 * @returns {object[]}
 */
export function sortForRetry(records) {
  return [...(records || [])].sort((a, b) => {
    const wa = Number(a.wrong_count || 0);
    const wb = Number(b.wrong_count || 0);
    if (wa !== wb) return wb - wa;
    const sa = Number(a.stage || 0);
    const sb = Number(b.stage || 0);
    if (sa !== sb) return sa - sb;
    return String(a.added_at || '').localeCompare(String(b.added_at || ''));
  });
}

/**
 * 到期数量。
 * @param {object[]} records
 * @param {string} [today]
 * @returns {number}
 */
export function dueCount(records, today = todayStr()) {
  return dueRecords(records, today).length;
}

/**
 * 按题型分组（保持试题型顺序）。
 * @param {object[]} records
 * @returns {Record<string, object[]>}
 */
export function groupByType(records) {
  const order = ['单选', '多选', '判断', '简答', '论述'];
  const out = {};
  for (const t of order) out[t] = [];
  for (const r of records || []) {
    const t = order.includes(r.qtype) ? r.qtype : '单选';
    out[t].push(r);
  }
  for (const t of Object.keys(out)) if (!out[t].length) delete out[t];
  return out;
}

/**
 * 复习进度描述，如「阶段 3/6 · 连续答对 2/7」。
 * @param {object} record
 * @returns {string}
 */
export function stageProgress(record) {
  const maxStage = EBBINGHAUS_INTERVALS.length - 1;
  return `阶段 ${Number(record.stage || 0)}/${maxStage} · 连续答对 ${Number(record.correct_streak || 0)}/${GRADUATE_STREAK}`;
}

/**
 * 下次复习提示，如「答对后 +4 天」。
 * @param {number} stage
 * @returns {string}
 */
export function nextReviewHint(stage) {
  const idx = Math.min(Number(stage || 0) + 1, EBBINGHAUS_INTERVALS.length - 1);
  return `答对后 +${EBBINGHAUS_INTERVALS[idx]} 天`;
}
