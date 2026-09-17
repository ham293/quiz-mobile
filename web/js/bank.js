/**
 * 题库仓库：导入、多题库隔离、错题本、收藏本、统计、日志、手动补录。
 * 所有数据按题库名隔离存储（见 db.js 的对象仓库说明）。
 */

import * as db from './db.js';
import * as eb from './ebbinghaus.js';
import { SOURCE_MANUAL, makeQuestion, normalizeStem } from './models.js';
import { nowStr, todayStr } from './dates.js';

/* ------------------------------------------------------------ 题库列表 */

/**
 * 题库列表（含统计计数），按最近使用时间倒序。
 * @returns {Promise<Array<object>>}
 */
export async function listBanks() {
  const banks = await db.getAll('banks');
  const wrong = await db.getAll('wrong');
  const favs = await db.getAll('favorites');
  const wrongMap = new Map();
  const favMap = new Map();
  for (const r of wrong) wrongMap.set(r.bankName, (wrongMap.get(r.bankName) || 0) + 1);
  for (const r of favs) favMap.set(r.bankName, (favMap.get(r.bankName) || 0) + 1);
  return banks
    .map((b) => ({
      name: b.name,
      fileName: b.fileName || '',
      fileType: b.fileType || '',
      questionCount: (b.questions || []).length,
      manualCount: (b.questions || []).filter((q) => q.source === SOURCE_MANUAL).length,
      wrongCount: wrongMap.get(b.name) || 0,
      favoriteCount: favMap.get(b.name) || 0,
      importedAt: b.importedAt || '',
      lastUsed: b.lastUsed || '',
      meta: b.meta || {},
    }))
    .sort((a, b) => String(b.lastUsed || '').localeCompare(String(a.lastUsed || '')));
}

/**
 * 取一个题库（完整对象，含题目数组）。
 * @param {string} name
 * @returns {Promise<object|undefined>}
 */
export async function getBank(name) {
  return db.get('banks', name);
}

/**
 * 保存题库。
 * @param {object} bank
 */
export async function saveBank(bank) {
  bank.updatedAt = nowStr();
  await db.put('banks', bank);
  return bank;
}

/**
 * 用解析结果导入（或覆盖）一个题库。
 * @param {string} name 题库名
 * @param {{questions: object[], errors?: object[], skipped?: object[], warnings?: string[], totalUnits?: number, noiseRemoved?: number}} parsed
 * @param {{fileName?: string, fileType?: string}} [meta]
 * @returns {Promise<object>} bank
 */
export async function importParsed(name, parsed, meta = {}) {
  const old = await getBank(name);
  const bank = {
    name,
    fileName: meta.fileName || (old && old.fileName) || '',
    fileType: meta.fileType || (old && old.fileType) || '',
    importedAt: (old && old.importedAt) || nowStr(),
    updatedAt: nowStr(),
    lastUsed: nowStr(),
    questions: parsed.questions || [],
    meta: {
      totalUnits: parsed.totalUnits || 0,
      noiseRemoved: parsed.noiseRemoved || 0,
      errorCount: (parsed.errors || []).length,
      skippedCount: (parsed.skipped || []).length,
      warnings: (parsed.warnings || []).slice(0, 20),
    },
  };
  await saveBank(bank);
  await saveLogs(name, { errors: parsed.errors || [], skipped: parsed.skipped || [] });
  // 首次导入时初始化统计，保证题库隔离文件齐全
  if (!(await db.get('stats', name))) {
    await saveStats(name, newStats(name));
  }
  return bank;
}

/**
 * 删除题库（连同错题本/收藏本/统计/日志）。
 * @param {string} name
 */
export async function deleteBank(name) {
  await db.remove('banks', name);
  for (const r of await db.getAll('wrong')) if (r.bankName === name) await db.remove('wrong', [r.bankName, r.qid]);
  for (const r of await db.getAll('favorites')) if (r.bankName === name) await db.remove('favorites', [r.bankName, r.qid]);
  await db.remove('stats', name);
  await db.remove('logs', [name, 'errors']);
  await db.remove('logs', [name, 'skipped']);
}

/** 标记题库为"最近使用" */
export async function touchBank(name) {
  const bank = await getBank(name);
  if (!bank) return;
  bank.lastUsed = nowStr();
  await saveBank(bank);
}

/** 最近使用的题库名 */
export async function lastUsedBankName() {
  const banks = await listBanks();
  return banks.length ? banks[0].name : '';
}

/* ------------------------------------------------------------ 错题本 */

/**
 * @param {string} name
 * @returns {Promise<object[]>}
 */
export async function loadWrong(name) {
  const all = await db.getAll('wrong');
  return all.filter((r) => r.bankName === name).map(({ bankName, ...rest }) => rest);
}

/**
 * 整体覆盖保存错题本。
 * @param {string} name
 * @param {object[]} records
 */
export async function saveWrong(name, records) {
  for (const r of await db.getAll('wrong')) if (r.bankName === name) await db.remove('wrong', [r.bankName, r.qid]);
  await db.bulkPut('wrong', (records || []).map((r) => ({ ...r, bankName: name })));
}

/**
 * @param {string} name
 * @returns {Promise<number>}
 */
export async function wrongTotal(name) {
  return (await loadWrong(name)).length;
}

/**
 * 写入一次作答结果到错题本（含艾宾浩斯调度）。
 * @param {string} name 题库名
 * @param {object} question
 * @param {boolean} correct
 * @returns {Promise<{status: string, message: string, record?: object}>}
 *   status: 'added' | 'updated' | 'graduated' | 'none'
 */
export async function recordPracticeResult(name, question, correct) {
  const records = await loadWrong(name);
  const idx = records.findIndex((r) => r.qid === question.qid);
  if (correct) {
    if (idx < 0) return { status: 'none', message: '' };
    const { record, graduated } = eb.markCorrect(records[idx]);
    if (graduated) {
      records.splice(idx, 1);
      await saveWrong(name, records);
      return { status: 'graduated', message: '🎉 已连续答对 7 次，移出错题本！' };
    }
    records[idx] = record;
    await saveWrong(name, records);
    return {
      status: 'updated',
      record,
      message: `📈 错题进度：连续答对 ${record.correct_streak}/7，下次复习 ${record.next_review}`,
    };
  }
  if (idx < 0) {
    const record = eb.newRecord(question);
    records.push(record);
    await saveWrong(name, records);
    return { status: 'added', record, message: '📌 已加入错题本' };
  }
  const record = eb.markWrong(records[idx]);
  records[idx] = record;
  await saveWrong(name, records);
  return {
    status: 'updated',
    record,
    message: `📌 错题本已更新（错误 ${record.wrong_count} 次，阶段重置为 0）`,
  };
}

/* ------------------------------------------------------------ 收藏本 */

/**
 * @param {string} name
 * @returns {Promise<object[]>}
 */
export async function loadFavorites(name) {
  const all = await db.getAll('favorites');
  return all.filter((r) => r.bankName === name).map(({ bankName, ...rest }) => rest);
}

/**
 * @param {string} name
 * @param {object[]} records
 */
export async function saveFavorites(name, records) {
  for (const r of await db.getAll('favorites')) if (r.bankName === name) await db.remove('favorites', [r.bankName, r.qid]);
  await db.bulkPut('favorites', (records || []).map((r) => ({ ...r, bankName: name })));
}

/**
 * @param {string} name
 * @param {string} qid
 * @returns {Promise<boolean>}
 */
export async function isFavorite(name, qid) {
  return !!(await db.get('favorites', [name, qid]));
}

/**
 * 收藏/取消收藏。
 * @param {string} name
 * @param {object} question
 * @returns {Promise<boolean>} 操作后是否已收藏
 */
export async function toggleFavorite(name, question) {
  const existing = await db.get('favorites', [name, question.qid]);
  if (existing) {
    await db.remove('favorites', [name, question.qid]);
    return false;
  }
  await db.put('favorites', { ...question, bankName: name, added_at: nowStr() });
  return true;
}

/**
 * @param {string} name
 * @returns {Promise<number>}
 */
export async function favoriteTotal(name) {
  return (await loadFavorites(name)).length;
}

/* ------------------------------------------------------------ 统计 */

/**
 * @param {string} name
 * @returns {Promise<object>}
 */
export async function loadStats(name) {
  const data = await db.get('stats', name);
  return data || newStats(name);
}

/**
 * @param {string} name
 * @param {object} data
 */
export async function saveStats(name, data) {
  await db.put('stats', { ...data, bankName: name, updatedAt: nowStr() });
  return data;
}

/**
 * 新建统计对象。
 * @param {string} [bankName]
 * @returns {object}
 */
export function newStats(bankName = '') {
  return {
    bankName,
    createdAt: nowStr(),
    updatedAt: nowStr(),
    sessions: 0,
    totalAnswered: 0,
    totalCorrect: 0,
    bestAccuracy: 0,
    byMode: {},
    byType: {},
    recent: [],
    weakPoints: {},
  };
}

/* ------------------------------------------------------------ 日志 */

/**
 * 保存解析异常日志与跳过行日志。
 * @param {string} name
 * @param {{errors?: object[], skipped?: object[]}} payload
 */
export async function saveLogs(name, payload = {}) {
  await db.put('logs', { bankName: name, kind: 'errors', items: payload.errors || [] });
  await db.put('logs', { bankName: name, kind: 'skipped', items: payload.skipped || [] });
}

/**
 * @param {string} name
 * @param {'errors'|'skipped'} kind
 * @returns {Promise<object[]>}
 */
export async function loadLogs(name, kind) {
  const row = await db.get('logs', [name, kind]);
  return (row && row.items) || [];
}

/* ------------------------------------------------------------ 手动补录 */

/**
 * @param {string} name
 * @returns {Promise<object[]>}
 */
export async function loadManual(name) {
  const bank = await getBank(name);
  if (!bank) return [];
  return (bank.questions || []).filter((q) => q.source === SOURCE_MANUAL);
}

/**
 * 新增/覆盖一道补录题（按题干去重），并写入题库。
 * @param {string} name
 * @param {object} question
 * @returns {Promise<{added: boolean, message: string, question: object}>}
 */
export async function addManual(name, question) {
  const bank = await getBank(name);
  if (!bank) return { added: false, message: '题库不存在', question };
  const q = makeQuestion({ ...question, source: SOURCE_MANUAL });
  const key = normalizeStem(q.stem);
  const idx = (bank.questions || []).findIndex((x) => normalizeStem(x.stem) === key);
  let added = true;
  let message = '';
  if (idx >= 0) {
    bank.questions[idx] = q;
    added = false;
    message = '该题干已存在，已用新内容覆盖原补录题。';
  } else {
    bank.questions.push(q);
    message = `补录成功，当前题库共 ${bank.questions.length} 道题。`;
  }
  await saveBank(bank);
  return { added, message, question: q };
}

/**
 * 删除第 index 道补录题（index 为补录题在题库中的序号）。
 * @param {string} name
 * @param {number} index
 * @returns {Promise<boolean>}
 */
export async function deleteManualAt(name, index) {
  const bank = await getBank(name);
  if (!bank) return false;
  const manualIdx = [];
  (bank.questions || []).forEach((q, i) => {
    if (q.source === SOURCE_MANUAL) manualIdx.push(i);
  });
  const target = manualIdx[index];
  if (target === undefined) return false;
  bank.questions.splice(target, 1);
  await saveBank(bank);
  return true;
}
