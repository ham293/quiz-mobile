/**
 * 日期工具：全部以 'YYYY-MM-DD' 字符串在存储层流转，比较用字符串比较即可。
 */

/** @returns {string} 今天 'YYYY-MM-DD' */
export function todayStr() {
  return dateToStr(new Date());
}

/**
 * @param {Date} d
 * @returns {string} 'YYYY-MM-DD'（本地时区）
 */
export function dateToStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * @param {string} s 'YYYY-MM-DD'
 * @returns {Date|null}
 */
export function strToDate(s) {
  if (!s || typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 日期加天数。
 * @param {string} s 'YYYY-MM-DD'
 * @param {number} days
 * @returns {string}
 */
export function addDays(s, days) {
  const d = strToDate(s) || new Date();
  d.setDate(d.getDate() + Number(days || 0));
  return dateToStr(d);
}

/**
 * 两个日期相差天数（a - b）。
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function daysBetween(a, b) {
  const da = strToDate(a);
  const db = strToDate(b);
  if (!da || !db) return 0;
  return Math.round((da.getTime() - db.getTime()) / 86400000);
}

/** @returns {string} 'YYYY-MM-DD HH:MM:SS' */
export function nowStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${dateToStr(d)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 友好显示：今天/明天/昨天/逾期 N 天。
 * @param {string} s 'YYYY-MM-DD'
 * @param {string} [today]
 * @returns {string}
 */
export function humanDue(s, today = todayStr()) {
  if (!s) return '未安排';
  const diff = daysBetween(s, today);
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff === -1) return '昨天（逾期 1 天）';
  if (diff < 0) return `${s}（逾期 ${-diff} 天）`;
  return s;
}

/** 文件名安全化的时间戳，如 20260917_201530 */
export function fileStamp() {
  return nowStr().replace(/[-: ]/g, '').replace(/^(\d{8})(\d{6})$/, '$1_$2');
}
