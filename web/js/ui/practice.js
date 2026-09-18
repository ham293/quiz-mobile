/** 练习页：模式选择 / 答题会话 / 练习报告 */

import { explainQuestion, isAiConfigured, loadAiSettings } from '../ai.js';
import { goBack, loadBank, navigate, setAction, setBackVisible, state } from '../app.js';
import * as repo from '../bank.js';
import * as eb from '../ebbinghaus.js';
import * as P from '../practice.js';
import * as stats from '../stats.js';
import { actionSheet, confirmDialog, el, emptyState, mount, toast } from './common.js';

/** 当前题的交互状态 */
let view = { selected: [], answered: null, revealed: false, note: '' };

/* ------------------------------------------------------------ 模式选择 */

/**
 * 练习首页：选择题库与练习模式。
 * @param {HTMLElement} root
 */
export async function renderPractice(root) {
  setAction(null);
  setBackVisible(state.stack.length > 0);

  if (!state.bank) {
    mount(root, emptyState('📚', '还没有选择题库', {
      label: '去选题库',
      onClick: () => navigate('banks', {}, { push: false }),
    }));
    return;
  }

  const bank = state.bank;
  const wrongRecords = await repo.loadWrong(bank.name);
  const favorites = await repo.loadFavorites(bank.name);
  const due = eb.dueCount(wrongRecords);
  const types = P.typeOptions(bank);

  const children = [
    el('div.card', {}, [
      el('h3.card-title', { text: '📖 ' + bank.name }),
      el('div.row.wrap.mt8', {}, [
        el('span.pill', { text: `${bank.questions.length} 题` }),
        el('span.pill.bad', { text: `错题 ${wrongRecords.length}` }),
        el('span.pill.warn', { text: `收藏 ${favorites.length}` }),
        due ? el('span.pill.ok', { text: `今日到期 ${due}` }) : null,
      ]),
      el('p.card-sub.mt8', { text: bank.fileName ? `来源：${bank.fileName}` : '来源：手动导入' }),
    ]),
    el('h2.card-title', { text: '选择练习方式' }),
  ];

  const modeBtn = (label, hint, mode, qtype = '', disabled = false) =>
    el('button.btn.block.mb8', {
      type: 'button',
      disabled,
      style: { justifyContent: 'space-between', minHeight: '52px' },
      onclick: () => begin(mode, qtype),
    }, [
      el('span', { text: label }),
      el('span.tiny.muted', { text: hint }),
    ]);

  children.push(modeBtn('顺序练习', '按题库原顺序', 'order'));
  children.push(modeBtn('随机练习', '打乱顺序', 'random'));
  children.push(modeBtn(`错题重练${wrongRecords.length ? `（${wrongRecords.length}）` : ''}`, '按错误次数排序', 'wrong', '', !wrongRecords.length));
  children.push(modeBtn(`收藏题目练习${favorites.length ? `（${favorites.length}）` : ''}`, '只练收藏的题', 'favorite', '', !favorites.length));
  children.push(modeBtn(`今日艾宾浩斯复习${due ? `（${due}）` : ''}`, '只复习今天到期的错题', 'due', '', !due));
  children.push(modeBtn('题型专项练习', types.slice(1).map((t) => t.value).join('/') + '/全部', 'type'));

  mount(root, ...children);
}

/** 题型专项：先选题型，再选方式 */
async function beginTypeMode() {
  const bank = state.bank;
  const types = P.typeOptions(bank);
  const qtype = await actionSheet({
    title: '选择题型',
    items: types.map((t) => ({ label: t.label, value: t.value })),
  });
  if (qtype === null) return;
  const mode = await actionSheet({
    title: '选择练习方式',
    items: [
      { label: '不分类，直接顺序练习', value: 'typeOrder' },
      { label: '不分类，直接随机练习', value: 'typeRandom' },
      { label: '按时间顺序练习（题干年份升序，无年份放最后）', value: 'typeYear' },
    ],
  });
  if (!mode) return;
  begin(mode, qtype);
}

/** 开始练习 */
async function begin(mode, qtype = '') {
  if (mode === 'type') return beginTypeMode();
  const bank = state.bank;
  const wrongRecords = await repo.loadWrong(bank.name);
  const favorites = await repo.loadFavorites(bank.name);
  const questions = P.pickQuestions({ bank, mode, qtype, wrongRecords, favoriteRecords: favorites });
  if (!questions.length) {
    toast('该模式下没有可练习的题目');
    return;
  }
  state.questions = questions;
  state.index = 0;
  state.wrongRecords = wrongRecords;
  state.currentMode = mode;
  state.currentQtype = qtype;
  state.session = stats.newSession(P.modeName(mode) + (qtype ? `·${qtype}` : ''), bank.name);
  await navigate('session');
}

/* -------------------------------------------------------------- 答题 */

/**
 * 答题界面。
 * @param {HTMLElement} root
 */
export async function renderSession(root) {
  if (!state.session) {
    mount(root, emptyState('✍️', '没有正在进行的练习'));
    return;
  }
  if (state.index >= state.questions.length) {
    await finishSession();
    return;
  }

  const q = state.questions[state.index];
  const total = state.questions.length;
  const idx = state.index + 1;
  view = { selected: [], answered: null, revealed: false, note: '' };

  const wrongRec = (state.wrongRecords || []).find((r) => r.qid === q.qid);
  const exitSession = async () => {
    const ok = await confirmDialog({ title: '退出本次练习？', message: '已作答的记录会保留在统计里。', okText: '退出', danger: true });
    if (ok) await finishSession();
  };
  setAction({ label: '退出', onClick: exitSession });
  setBackVisible(true);
  document.getElementById('btn-back').onclick = exitSession;

  const progress = el('i');
  const selected = new Set();
  const optionNodes = new Map();
  /** 无选项兜底时的手写答案输入框 */
  let typedInput = null;

  const optionEntries = P.isSubjective(q)
    ? []
    : (Object.keys(q.options || {}).length ? Object.entries(q.options).sort((a, b) => a[0].localeCompare(b[0])) : []);

  const feedbackBox = el('div.hidden');
  const actions = el('div.bottom-actions');
  const optionsWrap = el('div');

  const header = el('div', {}, [
    el('div.q-head', {}, [
      el('div.row', {}, [
        el('span.pill', { text: `${q.qtype}题` }),
        wrongRec ? el('span.pill.bad', { text: eb.stageProgress(wrongRec) }) : null,
        q.source === 'manual' ? el('span.pill.gray', { text: '补录' }) : null,
      ]),
      el('span.small.muted', { text: `${idx}/${total}` }),
    ]),
    el('div.progressbar', {}, [progress]),
  ]);

  const card = el('div.card', {}, [
    el('div.q-stem', { text: q.stem }),
    optionsWrap,
  ]);

  mount(root, header, card, feedbackBox, actions);
  progress.style.width = `${(idx / total) * 100}%`;

  /* --- 选项渲染 --- */
  function buildOptions() {
    optionsWrap.textContent = '';
    optionNodes.clear();

    if (P.isSubjective(q)) {
      optionsWrap.appendChild(
        el('button.btn.block.mt12', {
          type: 'button',
          text: view.revealed ? '重新查看参考答案' : '查看参考答案',
          onclick: () => {
            view.revealed = true;
            revealReference();
          },
        }),
      );
      if (view.revealed) revealReference();
      else renderBottomActions();
      return;
    }

    const entries = optionEntries.length
      ? optionEntries
      : (q.qtype === '判断' ? [['正确', '正确'], ['错误', '错误']] : []);

    // 兜底：客观题却一个选项都没解析出来（题库排版特殊）时，
    // 给一个手写答案输入框，绝不能让用户无题可答（以前的死路问题）
    if (!entries.length) {
      const input = el('input', {
        type: 'text',
        placeholder: '例：A（多选连写，如 ABD）',
        style: { marginTop: '12px' },
        onkeydown: (e) => {
          if (e.key === 'Enter') submitTyped();
        },
      });
      optionsWrap.appendChild(
        el('div.field.mt12', {}, [
          el('label', { text: '这道题没解析出选项，请直接输入答案' }),
          input,
        ]),
      );
      optionsWrap.appendChild(
        el('p.tiny.muted', { text: '（常见于排版特殊的 PDF；也可以到「设置 → 手动补录」里把这题补全）' }),
      );
      typedInput = input;
      renderBottomActions();
      return;
    }

    for (const [letter, text] of entries) {
      const node = el('div.option', {
        onclick: () => toggleOption(letter),
      }, [
        el('span.letter', { text: entries.length === 2 && q.qtype === '判断' ? (letter === '正确' ? '√' : '×') : letter }),
        el('span.text', { text }),
      ]);
      optionNodes.set(letter, node);
      optionsWrap.appendChild(node);
    }
    renderBottomActions();
  }

  /** 手动输入的答案提交（无选项兜底） */
  function submitTyped() {
    if (!typedInput || view.answered) return;
    const raw = String(typedInput.value || '').trim();
    if (!raw) {
      toast('请先输入答案');
      return;
    }
    selected.clear();
    for (const ch of raw.toUpperCase()) {
      if (raw.length === 1 && ch === 'T') selected.add('正确');
      else if (raw.length === 1 && ch === 'F') selected.add('错误');
      else selected.add(ch);
    }
    submitObjective();
  }

  /** 显示参考答案（主观题） */
  function revealReference() {
    feedbackBox.textContent = '';
    feedbackBox.className = 'feedback';
    feedbackBox.appendChild(el('div.fb-title', { text: '参考答案' }));
    feedbackBox.appendChild(el('div.pre-wrap', { text: P.answerText(q) }));
    if (q.explanation) {
      feedbackBox.appendChild(el('div.mt8.bold.small', { text: '解析' }));
      feedbackBox.appendChild(el('div.pre-wrap.small', { text: q.explanation }));
    }
    feedbackBox.appendChild(el('p.tiny.muted.mt8', { text: '自评一下：真的掌握了吗？' }));
    renderBottomActions();
  }

  /** 底部按钮 */
  function renderBottomActions() {
    actions.textContent = '';
    if (view.answered) {
      actions.appendChild(el('button.btn.primary.block', { type: 'button', text: '下一题 →', onclick: nextQuestion }));
      if (!P.isSubjective(q)) {
        actions.appendChild(el('button.btn', { type: 'button', text: '收藏', onclick: () => toggleFavorite() }));
      }
      return;
    }
    if (P.isSubjective(q)) {
      actions.appendChild(el('button.btn.bad.grow', { type: 'button', text: '我不会', onclick: () => submitSubjective(false) }));
      actions.appendChild(el('button.btn.ok.grow', { type: 'button', text: '我会了', onclick: () => submitSubjective(true) }));
      return;
    }
    // 无选项兜底：提交按钮用输入框里的内容
    if (typedInput) {
      actions.appendChild(el('button.btn.primary.grow', { type: 'button', text: '提交答案', onclick: () => submitTyped() }));
      actions.appendChild(el('button.btn', { type: 'button', text: '收藏', onclick: () => toggleFavorite() }));
      return;
    }
    // 单选/判断题点选即提交，不需要提交按钮；多选题需要手动提交
    if (q.qtype === '多选') {
      actions.appendChild(
        el('button.btn.primary.block', {
          type: 'button',
          text: '提交答案',
          disabled: true,
          onclick: () => submitObjective(),
        }),
      );
    }
    actions.appendChild(el('button.btn', { type: 'button', text: '收藏', onclick: () => toggleFavorite() }));
  }

  /** 点选选项 */
  function toggleOption(letter) {
    if (view.answered) return;
    const multi = q.qtype === '多选';
    if (!multi && optionEntries.length && optionEntries[0][0] !== '正确') {
      // 单选/判断题：点选即提交
      selected.clear();
      selected.add(letter);
      paintSelection();
      submitObjective();
      return;
    }
    if (multi) {
      if (selected.has(letter)) selected.delete(letter);
      else selected.add(letter);
      paintSelection();
      const btn = actions.querySelector('button.btn.primary');
      if (btn) btn.disabled = selected.size === 0;
      return;
    }
    // 判断题（无选项）或兜底
    selected.clear();
    selected.add(letter);
    paintSelection();
    submitObjective();
  }

  function paintSelection() {
    for (const [letter, node] of optionNodes) {
      node.classList.toggle('selected', selected.has(letter));
    }
  }

  /* --- AI 讲解（原题没有解析时） --- */

  /** 设置里是否开了「错题自动讲解」 */
  function aiAutoExplain() {
    try {
      return loadAiSettings().autoExplain === true;
    } catch {
      return false;
    }
  }

  /** 渲染讲解区域：没有解析时显示灰色提示 + 「AI 讲解」按钮 */
  function renderExplainSlot(slot, message = '') {
    slot.textContent = '';
    if (q.explanation) {
      slot.appendChild(el('div', {}, [el('b', { text: '解析：' }), el('span.pre-wrap', { text: q.explanation })]));
      return;
    }
    slot.appendChild(el('div.muted', { text: message || '（原题没有解析）' }));
    if (!isAiConfigured()) {
      slot.appendChild(el('div.tiny.muted.mt8', { text: '想让它讲解？到「设置 → AI 识别设置」填一个 API Key 即可（智谱 GLM-4-Flash 免费）。' }));
      return;
    }
    const btn = el('button.btn.sm.mt8', {
      type: 'button',
      text: '🤖 AI 讲解',
      onclick: () => generateExplanation(slot),
    });
    slot.appendChild(btn);
  }

  /**
   * 调 AI 生成讲解，成功后就地替换文案并缓存进题库/错题本。
   * @param {HTMLElement} slot
   * @param {{silent?:boolean}} [opts] silent=true 时失败只 toast（自动讲解场景）
   */
  async function generateExplanation(slot, opts = {}) {
    const btn = slot.querySelector('button');
    if (btn) {
      btn.disabled = true;
      btn.textContent = '正在生成…';
    }
    const res = await explainQuestion(q);
    if (!res.ok) {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '🤖 AI 讲解';
      }
      toast(res.message || '生成失败', 3200);
      return;
    }
    q.explanation = res.explanation;
    try {
      await repo.updateQuestionExplanation(state.bankName, q.qid, res.explanation);
    } catch (err) {
      console.warn('[practice] 缓存解析失败（不影响本次显示）：', err);
    }
    renderExplainSlot(slot);
    if (!opts.silent) toast('已生成解析并保存');
  }

  /* --- 提交判定 --- */
  function applyResult(correct, value) {
    view.answered = { correct, value };
    for (const [letter, node] of optionNodes) {
      node.classList.remove('selected');
      const target = correct
        ? String(q.answer || '').toUpperCase().includes(letter)
        : selected.has(letter);
      if (target) node.classList.add(correct ? 'correct' : 'wrong');
    }
    feedbackBox.textContent = '';
    feedbackBox.className = `feedback ${correct ? 'ok' : 'bad'}`;
    feedbackBox.appendChild(el('div.fb-title', { text: correct ? '✅ 回答正确' : '❌ 回答错误' }));
    if (!correct || true) {
      feedbackBox.appendChild(el('div.small', {}, [
        el('b', { text: '正确答案：' }),
        el('span', { text: P.answerText(q) }),
      ]));
    }
    if (q.explanation) {
      feedbackBox.appendChild(el('div.mt8.small', {}, [
        el('b', { text: '解析：' }),
        el('span.pre-wrap', { text: q.explanation }),
      ]));
    } else {
      // 很多题库文件只写「正确答案：A」，没有解析段落 —— 给用户一个用 AI 现场讲解的入口
      const explainSlot = el('div.mt8.small');
      feedbackBox.appendChild(explainSlot);
      renderExplainSlot(explainSlot);
      // 开了「错题自动讲解」且答错 → 自动生成一次（失败只 toast，不打断）
      if (!correct && aiAutoExplain()) {
        void generateExplanation(explainSlot, { silent: true });
      }
    }
    if (view.note) feedbackBox.appendChild(el('div.small.mt8', { text: view.note }));
    renderBottomActions();
  }

  async function submitObjective() {
    if (view.answered) return;
    const value = [...selected].sort().join('');
    if (!value) {
      toast('请先选择答案');
      return;
    }
    const r = P.judge(q, value);
    if (!r.ok) {
      toast(r.message || '输入不合法');
      return;
    }
    await afterAnswer(r.correct, value);
    applyResult(r.correct, value);
  }

  async function submitSubjective(correct) {
    if (view.answered) return;
    await afterAnswer(correct, correct ? '我会了' : '我不会');
    applyResult(correct, correct ? '我会了' : '我不会');
  }

  /** 写统计 + 错题本 */
  async function afterAnswer(correct, value) {
    stats.recordAnswer(state.session, q, correct, value);
    const res = await repo.recordPracticeResult(state.bankName, q, correct);
    view.note = res.message || '';
    if (!correct) {
      const rec = (await repo.loadWrong(state.bankName)).find((x) => x.qid === q.qid);
      if (rec) state.wrongRecords = [...(state.wrongRecords || []).filter((x) => x.qid !== q.qid), rec];
    }
  }

  /** 收藏 */
  async function toggleFavorite() {
    const nowFav = await repo.toggleFavorite(state.bankName, q);
    toast(nowFav ? '⭐ 已加入收藏本' : '已取消收藏');
  }

  /** 下一题 */
  function nextQuestion() {
    state.index += 1;
    renderSession(root);
  }

  buildOptions();
}

/* -------------------------------------------------------------- 结束 */

/** 结束练习并进入报告页 */
async function finishSession() {
  const session = state.session;
  state.session = null;
  if (!session) {
    await navigate('practice', {}, { push: false });
    return;
  }
  stats.finishSession(session);
  session.wrongBookTotal = await repo.wrongTotal(state.bankName);
  try {
    const library = await repo.loadStats(state.bankName);
    stats.mergeIntoLibrary(library, session);
    await repo.saveStats(state.bankName, library);
  } catch (err) {
    console.warn('统计保存失败', err);
  }
  state.report = stats.summarize(session);
  document.getElementById('btn-back').onclick = () => goBack();
  await navigate('report');
}

/**
 * 练习报告。
 * @param {HTMLElement} root
 */
export async function renderReport(root) {
  const report = state.report;
  setAction(null);
  setBackVisible(false);
  if (!report) {
    mount(root, emptyState('📊', '没有练习报告'));
    return;
  }
  const children = [
    el('div.card', {}, [
      el('h3.card-title', { text: '本次练习报告' }),
      el('p.card-sub', { text: `${report.bankName} · ${report.mode}` }),
      el('div.stat-grid.mt12', {}, [
        el('div.stat-box', {}, [el('div.num', { text: String(report.answered) }), el('div.lbl', { text: '答题数' })]),
        el('div.stat-box', {}, [el('div.num', { text: String(report.correct) }), el('div.lbl', { text: '正确数' })]),
        el('div.stat-box', {}, [el('div.num', { text: `${report.accuracy}%` }), el('div.lbl', { text: '正确率' })]),
        el('div.stat-box', {}, [el('div.num', { text: String(report.wrongBookTotal) }), el('div.lbl', { text: '错题本总题数' })]),
      ]),
    ]),
  ];

  if (report.wrongItems.length) {
    const list = el('div.card', {}, [el('h3.card-title', { text: `答错题目（${report.wrongItems.length}）` })]);
    report.wrongItems.forEach((w, i) => {
      list.appendChild(
        el('div.list-item', {}, [
          el('span.idx', { text: String(i + 1) }),
          el('div.grow', {}, [
            el('div.small', { text: w.stem }),
            el('div.tiny.muted.mt8', { text: `你的答案 ${w.userAnswer || '—'} · 正确答案 ${w.answer || '—'}` }),
          ]),
        ]),
      );
    });
    children.push(list);
  }

  if (report.weakPoints.length) {
    const weak = el('div.card', {}, [el('h3.card-title', { text: '薄弱知识点' })]);
    for (const w of report.weakPoints) {
      weak.appendChild(
        el('div', {}, [
          el('div.row.between', {}, [
            el('span.small', { text: w.topic }),
            el('span.tiny.muted', { text: `错 ${w.wrong} / 共 ${w.answered}（${w.accuracy}%）` }),
          ]),
          el('div.bar-row', {}, [
            el('div.bar', {}, [el('i', { style: { width: `${100 - w.accuracy}%`, background: 'var(--bad)' } })]),
          ]),
        ]),
      );
    }
    children.push(weak);
  } else {
    children.push(el('div.card', {}, [el('p.card-sub', { text: '本次没有答错题，继续保持！' })]));
  }

  children.push(
    el('div.bottom-actions', {}, [
      el('button.btn.grow', { type: 'button', text: '再练一次', onclick: () => navigate('practice', {}, { push: false }) }),
      el('button.btn.primary.grow', {
        type: 'button',
        text: '看错题本',
        onclick: () => navigate('wrong', {}, { push: false }),
      }),
    ]),
  );

  mount(root, ...children);
}
