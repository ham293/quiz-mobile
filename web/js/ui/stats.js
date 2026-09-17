/**
 * 统计页：某个题库的累计练习统计（练习次数 / 正确率 / 题型 / 模式 / 薄弱知识点 / 最近练习）。
 *
 * 数据来源：repo.loadStats(bankName) → stats.libraryReport(library)。
 * 本页只做展示，不写数据；缺失字段由 libraryReport 兜底为 0 / 空数组。
 */

import { navigate, setAction, setBackVisible, state } from '../app.js';
import * as repo from '../bank.js';
import * as S from '../stats.js';
import { el, emptyState, mount, pct, toast } from './common.js';

/** 正确率低于该值时进度条标红 */
const LOW_ACCURACY = 60;

/**
 * 统计数字块（stat-grid 里的一个格子）。
 * @param {string} num 主数字
 * @param {string} label 说明文案
 * @returns {HTMLElement}
 */
function statBox(num, label) {
  return el('div.stat-box', {}, [
    el('div.num', { text: num }),
    el('div.lbl', { text: label }),
  ]);
}

/**
 * 正确率进度条：宽度 = 正确率百分比，低于 60% 用红色。
 * @param {number} accuracy 正确率（0~100）
 * @returns {HTMLElement}
 */
function accuracyBar(accuracy) {
  const value = Math.max(0, Math.min(100, Number(accuracy) || 0));
  return el('div.bar', {}, [
    el('i', {
      style: {
        width: `${value}%`,
        background: value < LOW_ACCURACY ? 'var(--bad)' : 'var(--primary)',
      },
    }),
  ]);
}

/**
 * 列表条目：一行主标题 + 一行说明。
 * @param {string} title
 * @param {string} sub
 * @param {string} [indexText] 左侧序号（可选）
 * @returns {HTMLElement}
 */
function infoItem(title, sub, indexText = '') {
  return el('div.list-item', {}, [
    indexText ? el('span.idx', { text: indexText }) : null,
    el('div.grow', {}, [
      el('div.small.bold.pre-wrap', { text: title }),
      el('div.tiny.muted.mt8', { text: sub }),
    ]),
  ]);
}

/**
 * 统计页面。
 * @param {HTMLElement} root
 * @param {object} [params]
 * @returns {Promise<void>}
 */
export async function renderStats(root, params = {}) {
  setAction(null);
  setBackVisible(state.stack.length > 0);

  if (!state.bank) {
    mount(root, emptyState('📊', '还没有选择题库', {
      label: '去选题库',
      onClick: () => navigate('banks', {}, { push: false }),
    }));
    return;
  }

  const name = state.bankName || (state.bank && state.bank.name) || '';
  let report = null;
  try {
    const library = await repo.loadStats(name);
    report = S.libraryReport(library);
  } catch (err) {
    console.warn('读取统计失败', err);
    toast('读取统计失败：' + (err && err.message ? err.message : err), 3200);
    mount(root, emptyState('📊', '统计读取失败，请稍后重试'));
    return;
  }

  const children = [];

  /* --- 卡片 1：本次/累计概览 --- */
  children.push(
    el('div.card', {}, [
      el('h3.card-title', { text: '本次/累计概览' }),
      el('p.card-sub', { text: `题库：${name}` }),
      el('div.stat-grid.mt12', {}, [
        statBox(String(report.sessions), '累计练习次数'),
        statBox(String(report.totalAnswered), '累计答题数'),
        statBox(pct(report.accuracy), '总正确率'),
        statBox(pct(report.bestAccuracy), '最佳正确率'),
      ]),
    ]),
  );

  /* --- 卡片 2：各题型正确率 --- */
  const typeCard = el('div.card', {}, [el('h3.card-title', { text: '各题型正确率' })]);
  if (!report.byType.length) {
    typeCard.appendChild(el('p.card-sub', { text: '还没有练习记录' }));
  }
  for (const row of report.byType) {
    typeCard.appendChild(
      el('div.bar-row', {}, [
        el('div.row.between', {}, [
          el('span.small.bold', { text: `${row.type}题` }),
          el('span.tiny.muted', { text: `答题 ${row.answered} · 正确率 ${pct(row.accuracy)}` }),
        ]),
        accuracyBar(row.accuracy),
      ]),
    );
  }
  children.push(typeCard);

  /* --- 卡片 3：各模式练习分布 --- */
  const modeCard = el('div.card', {}, [el('h3.card-title', { text: '各模式练习分布' })]);
  if (!report.byMode.length) {
    modeCard.appendChild(el('p.card-sub', { text: '还没有练习记录' }));
  }
  for (const row of report.byMode) {
    modeCard.appendChild(
      infoItem(row.mode || '未命名模式', `练习 ${row.sessions} 次 · 答题 ${row.answered} · 正确率 ${pct(row.accuracy)}`),
    );
  }
  children.push(modeCard);

  /* --- 卡片 4：薄弱知识点 Top5 --- */
  const weak = report.weak.slice(0, 5);
  const weakCard = el('div.card', {}, [el('h3.card-title', { text: `薄弱知识点 Top${weak.length || 5}` })]);
  if (!weak.length) {
    weakCard.appendChild(el('p.card-sub', { text: '暂无明显薄弱知识点，保持住！' }));
  }
  weak.forEach((row, i) => {
    weakCard.appendChild(
      infoItem(row.topic || '未分类', `错误 ${row.wrong} 次 · 答题 ${row.answered} 题`, String(i + 1)),
    );
  });
  children.push(weakCard);

  /* --- 卡片 5：最近练习 --- */
  const recent = report.recent.slice(0, 10);
  const recentCard = el('div.card', {}, [el('h3.card-title', { text: '最近练习' })]);
  if (!recent.length) {
    recentCard.appendChild(el('p.card-sub', { text: '还没有练习记录' }));
  }
  for (const row of recent) {
    recentCard.appendChild(
      infoItem(
        row.mode || '未命名模式',
        `${row.at || '—'} · 答题 ${row.answered} · 正确 ${row.correct} · 正确率 ${pct(row.accuracy)}`,
      ),
    );
  }
  children.push(recentCard);

  children.push(
    el('button.btn.primary.block.mt8', {
      type: 'button',
      text: '开始练习',
      onclick: () => navigate('practice', {}, { push: false }),
    }),
  );

  mount(root, ...children);
}
