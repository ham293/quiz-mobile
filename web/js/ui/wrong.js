/**
 * 错题本 / 收藏本页：按题型分组浏览、展开详情、错题重练与导出 PDF。
 *
 * 数据形态：
 *   - 错题记录 = Question 全部字段 + wrong_count / correct_streak / stage / next_review / added_at …
 *   - 收藏记录 = Question 全部字段 + added_at
 * 两个页面结构一致，只有「元信息行」和「导出的 wrongInfo」不同。
 */

import { explainQuestion, isAiConfigured } from '../ai.js';
import { navigate, setAction, setBackVisible, state } from '../app.js';
import * as repo from '../bank.js';
import * as eb from '../ebbinghaus.js';
import * as P from '../practice.js';
import * as stats from '../stats.js';
import { fileStamp, humanDue } from '../dates.js';
import { locationText, sortedOptions } from '../models.js';
import { closeSheet, el, emptyState, escapeHtml, kv, loading, mount, openSheet, toast } from './common.js';

/* ------------------------------------------------------------ 公共小工具 */

/**
 * 当前题库名（state.bankName 优先，兜底取题库对象里的 name）。
 * @returns {string}
 */
function currentBankName() {
  return state.bankName || (state.bank && state.bank.name) || '';
}

/**
 * 题干截断（列表里只显示前 max 个字符，完整题干在详情弹层里看）。
 * @param {unknown} text
 * @param {number} [max]
 * @returns {string}
 */
function shortText(text, max = 60) {
  const s = String(text === null || text === undefined ? '' : text);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * 题型统计文本（PDF 副标题用），如「按题型统计：单选题 3 · 多选题 1」。
 * @param {object[]} records
 * @returns {string}
 */
function typeSummary(records) {
  const groups = eb.groupByType(records);
  const parts = Object.entries(groups).map(([type, list]) => `${type}题 ${list.length}`);
  return parts.length ? `按题型统计：${parts.join(' · ')}` : '暂无题目';
}

/**
 * 顶部「错题本 / 收藏本」互相切换的两个 chip。
 * @param {'wrong'|'favorites'} active
 * @returns {HTMLElement}
 */
function bookChips(active) {
  /**
   * @param {string} label
   * @param {'wrong'|'favorites'} target
   * @param {boolean} isActive
   */
  const chip = (label, target, isActive) =>
    el('button.chip' + (isActive ? '.active' : ''), {
      type: 'button',
      text: label,
      onclick: () => {
        if (isActive) return;
        if (target === 'wrong') navigate('wrong');
        else navigate('favorites', {}, { push: false });
      },
    });
  return el('div.chips.mb8', {}, [
    chip('📕 错题本', 'wrong', active === 'wrong'),
    chip('⭐ 收藏本', 'favorites', active === 'favorites'),
  ]);
}

/**
 * 收藏切换（错题本与收藏本共用）。
 * @param {Set<string>} favQids 当前页已收藏的 qid 集合（就地更新）
 * @param {Function|null} onChange 切换成功后的回调（收藏本页用它刷新列表）
 * @returns {(rec: object, btn: HTMLElement|null) => Promise<boolean>} 操作后是否已收藏
 */
function makeFavoriteToggle(favQids, onChange) {
  return async (rec, btn) => {
    try {
      const added = await repo.toggleFavorite(currentBankName(), rec);
      if (added) favQids.add(rec.qid);
      else favQids.delete(rec.qid);
      if (btn) btn.textContent = added ? '★ 已收藏' : '☆ 收藏';
      toast(added ? '⭐ 已加入收藏本' : '已取消收藏');
      if (typeof onChange === 'function') onChange();
      return added;
    } catch (err) {
      console.warn('收藏操作失败', err);
      toast('操作失败：' + (err && err.message ? err.message : err));
      return favQids.has(rec.qid);
    }
  };
}

/**
 * 快捷收藏按钮（列表条目右侧）。
 * @param {object} rec
 * @param {Set<string>} favQids
 * @param {Function} toggle
 * @returns {HTMLElement}
 */
function favoriteButton(rec, favQids, toggle) {
  const btn = el('button.btn.sm', {
    type: 'button',
    text: favQids.has(rec.qid) ? '★ 已收藏' : '☆ 收藏',
    onclick: (e) => {
      // 别冒泡到整行的展开手势
      if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
      toggle(rec, btn);
    },
  });
  return btn;
}

/**
 * 列表条目：序号 + 题干（截断）+ 元信息 + 正确答案 + 收藏按钮。
 * @param {object} rec 错题记录或收藏记录
 * @param {number} index 组内序号（从 0 开始）
 * @param {'wrong'|'favorites'} kind
 * @param {Set<string>} favQids
 * @param {Function} toggle 收藏切换函数
 * @returns {HTMLElement}
 */
function buildItem(rec, index, kind, favQids, toggle) {
  // 元信息用 innerHTML 拼粗体数字，所有数据字段都过 escapeHtml
  const meta = kind === 'wrong'
    ? `错误 <b>${escapeHtml(String(Number(rec.wrong_count || 0)))}</b> 次 · ` +
      `${escapeHtml(eb.stageProgress(rec))} · 下次复习：${escapeHtml(humanDue(rec.next_review))}`
    : `收藏于 ${escapeHtml(String(rec.added_at || '—'))}`;

  return el('div.list-item', {
    onclick: () => openDetail(rec, kind, favQids, toggle),
  }, [
    el('span.idx', { text: String(index + 1) }),
    el('div.grow', {}, [
      el('div.small.bold.pre-wrap', { text: shortText(rec.stem || '（无题干）') }),
      el('div.tiny.muted.mt8', { html: meta }),
      el('div.tiny.mt8', {}, [
        el('b', { text: '正确答案：' }),
        el('span', { text: rec.answer || '（无参考答案）' }),
      ]),
    ]),
    favoriteButton(rec, favQids, toggle),
  ]);
}

/**
 * 详情弹层：完整题干、选项（正确项高亮）、答案、解析、溯源位置与复习信息。
 * @param {object} rec
 * @param {'wrong'|'favorites'} kind
 * @param {Set<string>} favQids
 * @param {Function} toggle 收藏切换函数
 */
function openDetail(rec, kind, favQids, toggle) {
  const box = el('div', {}, [
    el('div.row.wrap', {}, [
      el('span.pill', { text: `${rec.qtype || '题目'}题` }),
      el('span.pill.gray', { text: locationText(rec) }),
      kind === 'wrong' ? el('span.pill.bad', { text: eb.stageProgress(rec) }) : null,
      rec.topic ? el('span.pill.warn', { text: rec.topic }) : null,
    ]),
    el('div.card-title.pre-wrap.mt8', { text: rec.stem || '（无题干）' }),
  ]);

  // 选项：正确答案所在的字母标绿
  const options = sortedOptions(rec);
  if (options.length) {
    const answer = String(rec.answer || '').toUpperCase();
    const wrap = el('div');
    for (const [letter, text] of options) {
      wrap.appendChild(el('div.option' + (answer.includes(letter) ? '.correct' : ''), {}, [
        el('span.letter', { text: letter }),
        el('span.text', { text }),
      ]));
    }
    box.appendChild(wrap);
  }

  box.appendChild(el('div.divider'));
  box.appendChild(kv('正确答案', rec.answer || '（无参考答案）'));
  // 解析区：原题没有解析时可以点「AI 讲解」现场生成，并缓存回题库/错题本
  const explainBox = el('div.mt8');
  box.appendChild(explainBox);
  renderExplain(explainBox, rec);
  box.appendChild(kv('溯源位置', locationText(rec)));

  if (kind === 'wrong') {
    box.appendChild(kv('错误次数', String(Number(rec.wrong_count || 0))));
    box.appendChild(kv('复习进度', eb.stageProgress(rec)));
    box.appendChild(kv('下次复习', humanDue(rec.next_review)));
    box.appendChild(kv('最近答错', rec.last_wrong_at || '—'));
  } else {
    box.appendChild(kv('收藏时间', rec.added_at || '—'));
  }

  box.appendChild(el('div.divider'));
  box.appendChild(el('button.btn.block.mb8', {
    type: 'button',
    text: favQids.has(rec.qid) ? '★ 取消收藏' : '☆ 收藏此题',
    onclick: async () => {
      await toggle(rec, null);
      closeSheet();
    },
  }));
  box.appendChild(el('button.btn.block', {
    type: 'button',
    text: '关闭',
    onclick: () => closeSheet(),
  }));

  openSheet(box);
}

/**
 * 详情里的解析区：有解析就显示；没有则给「AI 讲解」按钮（生成后缓存回题库/错题本）。
 * @param {HTMLElement} slot
 * @param {object} rec 错题/收藏记录
 */
function renderExplain(slot, rec) {
  slot.textContent = '';
  if (rec.explanation) {
    slot.appendChild(el('div.tiny.muted', { text: '解析' }));
    slot.appendChild(el('div.small.pre-wrap', { text: rec.explanation }));
    return;
  }
  slot.appendChild(el('div.tiny.muted', { text: '解析：原题没有（可让 AI 讲一下）' }));
  if (!isAiConfigured()) {
    slot.appendChild(el('div.tiny.muted.mt8', { text: '到「设置 → AI 识别设置」填一个 API Key 就能用（智谱 GLM-4-Flash 免费）。' }));
    return;
  }
  const btn = el('button.btn.sm.mt8', {
    type: 'button',
    text: '🤖 AI 讲解',
    onclick: async () => {
      btn.disabled = true;
      btn.textContent = '正在生成…';
      const res = await explainQuestion(rec);
      if (!res.ok) {
        btn.disabled = false;
        btn.textContent = '🤖 AI 讲解';
        toast(res.message || '生成失败', 3200);
        return;
      }
      rec.explanation = res.explanation;
      try {
        await repo.updateQuestionExplanation(state.bankName, rec.qid, res.explanation);
      } catch (err) {
        console.warn('[wrong] 缓存解析失败（不影响本次显示）：', err);
      }
      renderExplain(slot, rec);
      toast('已生成解析并保存');
    },
  });
  slot.appendChild(btn);
}

/* ------------------------------------------------------------ 练习入口 */

/**
 * 开始一次「错题重练 / 收藏题目练习」。
 * 会话初始化方式与 ui/practice.js 的 begin() 完全一致，保证答题页能正常接管。
 * @param {'wrong'|'favorite'} mode
 * @returns {Promise<void>}
 */
async function startPractice(mode) {
  const bank = state.bank;
  if (!bank) {
    toast('请先选择题库');
    return;
  }
  try {
    const wrongRecords = await repo.loadWrong(currentBankName());
    const favorites = await repo.loadFavorites(currentBankName());
    const questions = P.pickQuestions({ bank, mode, wrongRecords, favoriteRecords: favorites });
    if (!questions.length) {
      toast('该模式下没有可练习的题目');
      return;
    }
    state.questions = questions;
    state.index = 0;
    state.wrongRecords = wrongRecords;
    state.currentMode = mode;
    state.currentQtype = '';
    state.session = stats.newSession(P.modeName(mode), bank.name);
    await navigate('session');
  } catch (err) {
    console.warn('开始练习失败', err);
    toast('开始练习失败：' + (err && err.message ? err.message : err), 3200);
  }
}

/* ------------------------------------------------------------ 导出 PDF */

/**
 * 导出错题本 / 收藏本为 PDF。
 * exporter.js 可能尚未就绪（或 WebView 缺少 vendor 依赖），全部放在 try/catch 里。
 * @param {object[]} records
 * @param {'wrong'|'favorites'} kind
 * @returns {Promise<void>}
 */
async function exportRecords(records, kind) {
  if (!records.length) {
    toast('没有可导出的题目');
    return;
  }
  const name = currentBankName();
  const isWrong = kind === 'wrong';
  loading('正在生成 PDF…');
  try {
    const { exportPdf } = await import('../exporter.js');
    const res = await exportPdf(records, {
      title: `《${name}》${isWrong ? '错题本' : '收藏本'}`,
      subtitle: typeSummary(records),
      wrongInfo: isWrong,
      fileName: `${isWrong ? '错题本' : '收藏本'}_${fileStamp()}.pdf`,
    });
    toast((res && res.savedAs) || '已导出', 3000);
  } catch (err) {
    console.warn('导出 PDF 失败', err);
    toast('导出失败：' + (err && err.message ? err.message : err), 3200);
  } finally {
    loading(false);
  }
}

/* ------------------------------------------------------------ 错题本 */

/**
 * 错题本页面。
 * @param {HTMLElement} root
 * @param {object} [params]
 * @returns {Promise<void>}
 */
export async function renderWrong(root, params = {}) {
  setAction(null);
  setBackVisible(state.stack.length > 0);

  if (!state.bank) {
    mount(root, emptyState('📕', '还没有选择题库', {
      label: '去选题库',
      onClick: () => navigate('banks', {}, { push: false }),
    }));
    return;
  }

  const name = currentBankName();
  let records = [];
  /** @type {Set<string>} */
  let favQids = new Set();
  try {
    records = await repo.loadWrong(name);
    favQids = new Set((await repo.loadFavorites(name)).map((r) => r.qid));
  } catch (err) {
    console.warn('读取错题本失败', err);
    toast('读取错题本失败：' + (err && err.message ? err.message : err), 3200);
    mount(root, emptyState('📕', '读取错题本失败，请稍后重试'));
    return;
  }

  const due = eb.dueCount(records);
  const groups = eb.groupByType(records);
  const toggle = makeFavoriteToggle(favQids, null);

  const children = [
    bookChips('wrong'),
    el('div.card', {}, [
      el('h3.card-title', { text: `错题本 · ${name}` }),
      el('div.row.wrap.mt8', {}, [
        el('span.pill', { text: `总题数 ${records.length}` }),
        due ? el('span.pill.ok', { text: `今日到期 ${due}` }) : el('span.pill.gray', { text: '今日到期 0' }),
        ...Object.entries(groups).map(([type, list]) => el('span.pill.warn', { text: `${type} ${list.length}` })),
      ]),
      el('p.card-sub.mt8', { text: '按题型分组；点条目看完整题干与解析，连对 7 次自动移出错题本。' }),
    ]),
  ];

  if (!records.length) {
    children.push(emptyState('🎉', '错题本是空的，去练习吧', {
      label: '开始练习',
      onClick: () => navigate('practice', {}, { push: false }),
    }));
    mount(root, ...children);
    return;
  }

  children.push(
    el('div.grid2.mb8', {}, [
      el('button.btn.primary', { type: 'button', text: `错题重练（${records.length}）`, onclick: () => startPractice('wrong') }),
      el('button.btn', { type: 'button', text: '导出 PDF', onclick: () => exportRecords(records, 'wrong') }),
    ]),
  );

  for (const [type, list] of Object.entries(groups)) {
    const card = el('div.card', {}, [el('h3.card-title', { text: `${type}题（${list.length}）` })]);
    list.forEach((rec, i) => card.appendChild(buildItem(rec, i, 'wrong', favQids, toggle)));
    children.push(card);
  }

  mount(root, ...children);
}

/* ------------------------------------------------------------ 收藏本 */

/**
 * 收藏本页面。
 * @param {HTMLElement} root
 * @param {object} [params]
 * @returns {Promise<void>}
 */
export async function renderFavorites(root, params = {}) {
  setAction(null);
  setBackVisible(state.stack.length > 0);

  if (!state.bank) {
    mount(root, emptyState('⭐', '还没有选择题库', {
      label: '去选题库',
      onClick: () => navigate('banks', {}, { push: false }),
    }));
    return;
  }

  const name = currentBankName();
  let records = [];
  try {
    records = await repo.loadFavorites(name);
  } catch (err) {
    console.warn('读取收藏本失败', err);
    toast('读取收藏本失败：' + (err && err.message ? err.message : err), 3200);
    mount(root, emptyState('⭐', '读取收藏本失败，请稍后重试'));
    return;
  }

  const groups = eb.groupByType(records);
  // 本页所有记录都是已收藏；取消收藏后整页刷新，条目会立刻消失
  const favQids = new Set(records.map((r) => r.qid));
  const toggle = makeFavoriteToggle(favQids, () => renderFavorites(root, params));

  const children = [
    bookChips('favorites'),
    el('div.card', {}, [
      el('h3.card-title', { text: `收藏本 · ${name}` }),
      el('div.row.wrap.mt8', {}, [
        el('span.pill', { text: `总题数 ${records.length}` }),
        ...Object.entries(groups).map(([type, list]) => el('span.pill.warn', { text: `${type} ${list.length}` })),
      ]),
      el('p.card-sub.mt8', { text: '刷题时点「收藏」即可加入收藏本。' }),
    ]),
  ];

  if (!records.length) {
    children.push(emptyState('⭐', '收藏本是空的', {
      label: '开始练习',
      onClick: () => navigate('practice', {}, { push: false }),
    }));
    children.push(el('p.card-sub.center', { text: '刷题时点收藏即可加入收藏本' }));
    mount(root, ...children);
    return;
  }

  children.push(
    el('div.grid2.mb8', {}, [
      el('button.btn.primary', { type: 'button', text: `收藏题目练习（${records.length}）`, onclick: () => startPractice('favorite') }),
      el('button.btn', { type: 'button', text: '导出 PDF', onclick: () => exportRecords(records, 'favorites') }),
    ]),
  );

  for (const [type, list] of Object.entries(groups)) {
    const card = el('div.card', {}, [el('h3.card-title', { text: `${type}题（${list.length}）` })]);
    list.forEach((rec, i) => card.appendChild(buildItem(rec, i, 'favorites', favQids, toggle)));
    children.push(card);
  }

  mount(root, ...children);
}
