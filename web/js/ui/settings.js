/**
 * 设置相关子页面：设置主页 / 解析日志 / 手动补录 / 关于。
 *
 * 约定：
 *  - 四个页面都是子页面，进入时显示返回按钮、清空右上角操作按钮；
 *  - 所有数据访问都包在 try/catch 里，失败只 toast 中文提示，绝不让页面白屏；
 *  - 用户数据一律走 el()/textContent 渲染，不用 innerHTML 拼接，避免 XSS。
 */

import { navigate, reloadCurrentBank, reparseCurrentBank, setAction, setBackVisible, state } from '../app.js';
import * as repo from '../bank.js';
import { APP_NAME, APP_VERSION } from '../config.js';
import * as db from '../db.js';
import * as eb from '../ebbinghaus.js';
import {
  QUESTION_TYPES,
  QT_JUDGE,
  QT_MULTI,
  QT_SINGLE,
  SOURCE_MANUAL,
  locationText,
  makeQuestion,
  normalizeChoice,
  normalizeJudge,
} from '../models.js';
import { confirmDialog, el, emptyState, kv, loading, mount, sectionTitle, toast } from './common.js';

/** 日志/列表最多展示的条数（超出提示已省略） */
const ROW_LIMIT = 20;
/** 选项最多 10 个（与 models.OPTION_LETTERS 的 A~J 对齐） */
const MAX_OPTION_ROWS = 10;
/** 选项文本行首的字母前缀，如 `A.` `A、` `（A）`，提交时清理掉 */
const OPTION_PREFIX_RE = /^\s*[（(]?\s*[A-Ja-j]\s*[）).、．,，:：]\s*/;

/* ------------------------------------------------------------ 小工具 */

/**
 * 取错误的可读文本。
 * @param {unknown} err
 * @returns {string}
 */
function msgOf(err) {
  if (err && err.message) return String(err.message);
  return String(err || '未知错误');
}

/**
 * 压缩空白并截断长文本，用于列表里的一行预览。
 * @param {unknown} text
 * @param {number} max
 * @returns {string}
 */
function cut(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 导出文件名用的本地时间戳，如 `20260917-201000` */
function fileStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/**
 * 页码/行号位置描述（日志项没有 para，所以不复用 models.locationText）。
 * @param {{page?:number, line?:number}} item
 * @returns {string}
 */
function posText(item) {
  const page = Number(item && item.page) || 0;
  const line = Number(item && item.line) || 0;
  if (page && line) return `第${page}页第${line}行`;
  if (page) return `第${page}页`;
  if (line) return `第${line}行`;
  return '位置未记录';
}

/**
 * 读取全部题库概况（失败返回 0，不抛异常）。
 * @returns {Promise<{bankCount:number, questionCount:number}>}
 */
async function loadOverview() {
  try {
    const banks = await repo.listBanks();
    return {
      bankCount: banks.length,
      questionCount: banks.reduce((sum, b) => sum + Number(b.questionCount || 0), 0),
    };
  } catch (err) {
    console.warn('设置页：读取题库概况失败', err);
    return { bankCount: 0, questionCount: 0 };
  }
}

/**
 * 按顺序读取出题目的补录题（失败返回空数组）。
 * @param {string} name 题库名
 * @returns {Promise<object[]>}
 */
async function loadManualSafe(name) {
  try {
    return await repo.loadManual(name);
  } catch (err) {
    console.warn('设置页：读取补录题失败', err);
    toast('读取补录题失败：' + msgOf(err), 3000);
    return [];
  }
}

/**
 * 生成一行带右侧提示的整块按钮。
 * @param {string} label 按钮文字
 * @param {string} hint 右侧小字提示
 * @param {Function} onClick 点击回调
 * @param {string} [extraClass] 附加 class，如 '.bad'
 * @returns {HTMLElement}
 */
function blockButton(label, hint, onClick, extraClass = '') {
  return el(`button.btn${extraClass}.block.mb8`, {
    type: 'button',
    style: { justifyContent: 'space-between' },
    onclick: onClick,
  }, [
    el('span', { text: label }),
    hint ? el('span.tiny.muted', { text: hint }) : null,
  ]);
}

/**
 * 导出题库的错题本/收藏本 PDF（导出组件缺失或报错都只提示，不崩）。
 * @param {{name:string, records:object[], title:string, fileName:string}} opts
 * @returns {Promise<void>}
 */
async function exportBook(opts) {
  if (!opts.records.length) {
    toast('还没有可导出的记录');
    return;
  }
  loading('正在生成 PDF…');
  try {
    const exporter = await import('../exporter.js');
    if (!exporter || typeof exporter.exportPdf !== 'function') {
      throw new Error('导出组件未加载');
    }
    const res = await exporter.exportPdf(opts.records, {
      title: opts.title,
      wrongInfo: true,
      fileName: opts.fileName,
    });
    toast((res && res.savedAs) || '已导出');
  } catch (err) {
    console.warn('设置页：导出 PDF 失败', err);
    toast('导出失败：' + msgOf(err), 3200);
  } finally {
    loading(false);
  }
}

/**
 * 「手动补录的题目」卡片（设置页与补录页共用）。
 * @param {string} name 题库名
 * @param {object[]} questions 补录题数组，顺序即补录序号
 * @param {Function} refresh 删除成功后重新渲染当前页
 * @returns {HTMLElement}
 */
function manualCard(name, questions, refresh) {
  const card = el('div.card', {}, [
    el('h3.card-title', { text: `手动补录的题目（${questions.length}）` }),
  ]);

  if (!questions.length) {
    card.appendChild(el('p.card-sub', { text: '还没有补录题。被跳过的题目可以在这里手动补齐。' }));
    card.appendChild(
      el('button.btn.block.mt12', {
        type: 'button',
        text: '去手动补录',
        onclick: () => navigate('manual'),
      }),
    );
    return card;
  }

  questions.forEach((q, index) => {
    const del = el('button.btn.sm.bad', {
      type: 'button',
      text: '删除',
      onclick: async () => {
        const ok = await confirmDialog({
          title: '删除这道补录题？',
          message: cut(q.stem, 60) || '（无题干）',
          okText: '删除',
          danger: true,
        });
        if (!ok) return;
        try {
          const removed = await repo.deleteManualAt(name, index);
          if (!removed) {
            toast('没找到这道补录题，可能已被删除');
            return;
          }
          toast('已删除补录题');
          await reloadCurrentBank();
          await refresh();
        } catch (err) {
          console.warn('设置页：删除补录题失败', err);
          toast('删除失败：' + msgOf(err), 3200);
        }
      },
    });
    card.appendChild(
      el('div.list-item', {}, [
        el('span.idx', { text: String(index + 1) }),
        el('div.grow', {}, [
          el('div.small', { text: cut(q.stem, 80) || '（无题干）' }),
          el('div.tiny.muted.mt8', { text: `${q.qtype} · 答案 ${q.answer || '—'} · ${locationText(q)}` }),
        ]),
        del,
      ]),
    );
  });

  return card;
}

/**
 * 「应用信息」卡片。
 * @param {number} bankCount 题库数量
 * @param {number} questionCount 总题目数
 * @returns {HTMLElement}
 */
function appInfoCard(bankCount, questionCount) {
  return el('div.card', {}, [
    el('h3.card-title', { text: '应用信息' }),
    kv('应用', APP_NAME),
    kv('版本', `v${APP_VERSION}`),
    kv('题库数量', `${bankCount} 个`),
    kv('总题目数', `${questionCount} 题`),
    el('button.btn.block.mt12', { type: 'button', text: '关于', onclick: () => navigate('about') }),
  ]);
}

/* ------------------------------------------------------------ 设置主页 */

/**
 * 设置主页：当前题库概况、数据与维护、补录题列表、应用信息。
 * @param {HTMLElement} root
 * @param {object} [params]
 */
export async function renderSettings(root, params = {}) {
  setBackVisible(true);
  setAction(null);

  const name = state.bankName;
  const bank = state.bank;
  const children = [];

  if (!bank || !name) {
    children.push(
      emptyState('📚', '还没有选择题库', {
        label: '去选题库',
        onClick: () => navigate('banks', {}, { push: false }),
      }),
    );
    // 还没有题库时也要能配置 AI：首次使用常常是先配好 Key 再导入题库
    children.push(
      blockButton('🤖 AI 识别设置（可选）', '用大模型识别排版特殊的题库', () => navigate('ai')),
    );
  } else {
    let wrongRecords = [];
    let favorites = [];
    let manualQuestions = [];
    let errorLogs = [];
    try {
      wrongRecords = await repo.loadWrong(name);
      favorites = await repo.loadFavorites(name);
    } catch (err) {
      console.warn('设置页：读取错题本/收藏本失败', err);
      toast('读取错题本或收藏本失败：' + msgOf(err), 3000);
    }
    manualQuestions = await loadManualSafe(name);
    try {
      errorLogs = await repo.loadLogs(name, 'errors');
    } catch (err) {
      console.warn('设置页：读取解析日志失败', err);
    }

    const due = eb.dueCount(wrongRecords);

    /* --- 1. 当前题库卡片 --- */
    children.push(
      el('div.card', {}, [
        el('h3.card-title', { text: '📖 ' + name }),
        el('p.card-sub', { text: bank.fileName ? `来源文件：${bank.fileName}` : '来源文件：手动导入' }),
        el('div.row.wrap.mt8', {}, [
          el('span.pill', { text: (bank.fileType || '未知').toUpperCase() }),
          el('span.pill', { text: `${(bank.questions || []).length} 题` }),
          el('span.pill.bad', { text: `错题 ${wrongRecords.length}` }),
          el('span.pill.warn', { text: `收藏 ${favorites.length}` }),
          el('span.pill.gray', { text: `补录 ${manualQuestions.length}` }),
          due ? el('span.pill.ok', { text: `今日到期 ${due}` }) : null,
        ]),
        el('div.mt8', {}, [
          kv('导入时间', (bank.importedAt || '未知').slice(0, 16)),
          kv('最近使用', (bank.lastUsed || '未知').slice(0, 16)),
        ]),
      ]),
    );

    /* --- 2. 数据与维护 --- */
    children.push(sectionTitle('数据与维护'));

    children.push(
      blockButton('切换题库', '', () => navigate('banks', {}, { push: false })),
    );

    children.push(
      blockButton('重新解析源文件', '保留错题本/收藏本/统计', async () => {
        try {
          const ok = await reparseCurrentBank();
          if (!ok) return;
          await reloadCurrentBank();
          toast('已按新文件重新解析，补录题按题干自动保留');
          await renderSettings(root, params);
        } catch (err) {
          console.warn('设置页：重新解析失败', err);
          toast('重新解析失败：' + msgOf(err), 3200);
        }
      }),
    );

    children.push(
      blockButton('解析日志与跳过行', `异常 ${errorLogs.length} 条`, () => navigate('logs')),
    );

    children.push(
      blockButton('手动补录异常题', `已补录 ${manualQuestions.length} 题`, () => navigate('manual')),
    );

    // AI 识别是可选功能：入口放在数据与维护里，随时可开可关
    children.push(
      blockButton('🤖 AI 识别设置（可选）', '用大模型识别排版特殊的题库', () => navigate('ai')),
    );

    children.push(
      blockButton('导出错题本 PDF', `${wrongRecords.length} 条记录`, () =>
        exportBook({
          name,
          records: wrongRecords,
          title: `《${name}》错题本`,
          fileName: `错题本_${fileStamp()}.pdf`,
        }),
      ),
    );

    children.push(
      blockButton('导出收藏本 PDF', `${favorites.length} 条记录`, () =>
        exportBook({
          name,
          records: favorites,
          title: `《${name}》收藏本`,
          fileName: `收藏本_${fileStamp()}.pdf`,
        }),
      ),
    );

    children.push(
      blockButton('删除当前题库', '不可恢复', async () => {
        try {
          const ok = await confirmDialog({
            title: `删除题库「${name}」？`,
            message: '题库题目、错题本、收藏本、统计与解析日志会一并删除，且无法恢复。',
            okText: '删除',
            danger: true,
          });
          if (!ok) return;
          await repo.deleteBank(name);
          state.bank = null;
          state.bankName = '';
          state.questions = [];
          state.session = null;
          toast('已删除题库');
          await navigate('banks', {}, { push: false });
        } catch (err) {
          console.warn('设置页：删除题库失败', err);
          toast('删除失败：' + msgOf(err), 3200);
        }
      }, '.bad'),
    );

    /* --- 3. 手动补录的题目 --- */
    children.push(sectionTitle('手动补录的题目'));
    children.push(manualCard(name, manualQuestions, () => renderSettings(root, params)));
  }

  /* --- 4. 应用信息 --- */
  const overview = await loadOverview();
  children.push(sectionTitle('应用'));
  children.push(appInfoCard(overview.bankCount, overview.questionCount));

  mount(root, ...children);
}

/* ------------------------------------------------------ 解析日志与跳过行 */

/**
 * 解析日志页：解析异常与跳过行两块内容，用 chip 切换显示。
 * @param {HTMLElement} root
 * @param {object} [params]
 */
export async function renderLogs(root, params = {}) {
  setBackVisible(true);
  setAction(null);

  const name = state.bankName;
  if (!name) {
    mount(root, emptyState('🗂️', '还没有选择题库', {
      label: '去选题库',
      onClick: () => navigate('banks', {}, { push: false }),
    }));
    return;
  }

  let errors = [];
  let skipped = [];
  try {
    errors = await repo.loadLogs(name, 'errors');
    skipped = await repo.loadLogs(name, 'skipped');
  } catch (err) {
    console.warn('解析日志页：读取失败', err);
    toast('读取解析日志失败：' + msgOf(err), 3200);
  }

  /* --- 顶部说明 --- */
  const head = el('div.card', {}, [
    el('h3.card-title', { text: `《${name}》解析日志` }),
    el('p.card-sub.pre-wrap', {
      text: '异常题可在「手动补录」里补齐，补录后重新解析会自动保留（按题干比对）。',
    }),
    el('div.row.wrap.mt8', {}, [
      el('span.pill.bad', { text: `异常 ${errors.length} 条` }),
      el('span.pill.gray', { text: `跳过 ${skipped.length} 行` }),
    ]),
  ]);

  /* --- 异常行渲染 --- */
  const errorNode = (item, index) => el('div.list-item', {}, [
    el('span.idx', { text: String(index + 1) }),
    el('div.grow', {}, [
      el('div.bold.small', { text: `[${item.time || '时间未记录'}] ${posText(item)}` }),
      el('div.tiny.muted.mt8', { text: `原因：${item.reason || '未记录'}` }),
      item.raw ? el('div.pre-wrap.mono.mt8', { text: item.raw }) : null,
    ]),
  ]);

  /* --- 跳过行渲染 --- */
  const skippedNode = (item, index) => el('div.list-item', {}, [
    el('span.idx', { text: String(index + 1) }),
    el('div.grow', {}, [
      el('div.small', { text: posText(item) }),
      el('div.tiny.muted.mt8', { text: cut(item.content, 60) || '（空行）' }),
      el('div.tiny.muted', { text: `原因：${item.reason || '未记录'}` }),
    ]),
  ]);

  /**
   * 生成一个日志分区卡片。
   * @param {object[]} items
   * @param {(item:object, index:number)=>HTMLElement} renderItem
   * @param {string} emptyText
   * @returns {HTMLElement}
   */
  const logCard = (items, renderItem, emptyText) => {
    const card = el('div.card');
    if (!items.length) {
      card.appendChild(el('p.card-sub', { text: emptyText }));
      return card;
    }
    for (const [index, item] of items.slice(0, ROW_LIMIT).entries()) {
      card.appendChild(renderItem(item, index));
    }
    if (items.length > ROW_LIMIT) {
      card.appendChild(el('p.tiny.muted.mt8', { text: `其余 ${items.length - ROW_LIMIT} 条已省略` }));
    }
    return card;
  };

  const errorsBlock = el('div', {}, [
    sectionTitle(`解析异常（${errors.length}）`),
    logCard(errors, errorNode, '没有解析异常记录。'),
  ]);
  const skippedBlock = el('div', {}, [
    sectionTitle(`跳过行（${skipped.length}）`),
    logCard(skipped, skippedNode, '没有跳过行记录。'),
  ]);

  /* --- 切换用 chip --- */
  let filter = 'all';
  const chips = new Map();
  const paint = () => {
    errorsBlock.classList.toggle('hidden', filter === 'skipped');
    skippedBlock.classList.toggle('hidden', filter === 'errors');
    for (const [key, chip] of chips) chip.className = key === filter ? 'chip active' : 'chip';
  };
  const switchRow = el('div.chips.mt12');
  for (const [key, label] of [['all', '全部'], ['errors', `解析异常 ${errors.length}`], ['skipped', `跳过行 ${skipped.length}`]]) {
    const chip = el('button.chip', {
      type: 'button',
      text: label,
      onclick: () => {
        filter = key;
        paint();
      },
    });
    chips.set(key, chip);
    switchRow.appendChild(chip);
  }

  if (!errors.length && !skipped.length) {
    mount(root, head, el('div.card', {}, [el('p.card-sub', { text: '解析很干净，没有异常与跳过记录。' })]));
    return;
  }

  mount(root, head, switchRow, errorsBlock, skippedBlock);
  paint();
}

/* ------------------------------------------------------------ 手动补录 */

/**
 * 手动补录页：题型 → 题干 → 选项 → 答案 → 解析 → 保存，并列出已补录题。
 * @param {HTMLElement} root
 * @param {object} [params]
 */
export async function renderManual(root, params = {}) {
  setBackVisible(true);
  setAction(null);

  const name = state.bankName;
  if (!name) {
    mount(root, emptyState('✍️', '还没有选择题库，补录题需要加入一个题库', {
      label: '去选题库',
      onClick: () => navigate('banks', {}, { push: false }),
    }));
    return;
  }

  // 表单局部状态：切题型不丢用户已输入的内容
  let qtype = QT_SINGLE;
  let options = ['', '', '', ''];
  let judgeAnswer = '';

  /* --- 题型 chips --- */
  const typeChips = new Map();
  const typeRow = el('div.chips');
  for (const t of QUESTION_TYPES) {
    const chip = el('button.chip', {
      type: 'button',
      text: t,
      onclick: () => {
        qtype = t;
        paintForm();
      },
    });
    typeChips.set(t, chip);
    typeRow.appendChild(chip);
  }

  /* --- 题干 --- */
  const stemInput = el('textarea', { rows: 4, placeholder: '必填，可多行。例如：以下关于 XX 的说法正确的是（　）' });

  /* --- 选项行 --- */
  const optionsWrap = el('div');
  const buildOptionRows = () => {
    optionsWrap.textContent = '';
    options.forEach((value, i) => {
      const letter = String.fromCharCode(65 + i);
      const input = el('input', {
        type: 'text',
        value,
        placeholder: `${letter} 选项内容（也可直接粘贴「${letter}.内容」）`,
        oninput: (e) => {
          options[i] = e.target.value;
        },
      });
      optionsWrap.appendChild(
        el('div.row.mb8', {}, [
          el('span.idx.bold', { text: letter }),
          el('div.grow', {}, [input]),
          el('button.btn.sm', {
            type: 'button',
            text: '✕',
            onclick: () => {
              options.splice(i, 1);
              buildOptionRows();
            },
          }),
        ]),
      );
    });
    if (!options.length) optionsWrap.appendChild(el('p.tiny.muted', { text: '还没有选项，点下面「添加选项」' }));
  };
  buildOptionRows();

  const addOptionBtn = el('button.btn.sm', {
    type: 'button',
    text: '＋ 添加选项',
    onclick: () => {
      if (options.length >= MAX_OPTION_ROWS) {
        toast(`最多 ${MAX_OPTION_ROWS} 个选项`);
        return;
      }
      options.push('');
      buildOptionRows();
    },
  });

  const optionsField = el('div.field', {}, [
    el('label', { text: '选项（单选/多选/判断）' }),
    optionsWrap,
    el('div.row.mt8', {}, [addOptionBtn, el('span.tiny.muted', { text: '字母按 A、B、C… 自动命名' })]),
  ]);

  /* --- 答案：三种形态 --- */
  const choiceInput = el('input', { type: 'text', placeholder: '如 A，多选可填 ABD' });
  const choiceBlock = el('div', {}, [
    el('div.field', {}, [
      el('label', { text: '正确答案（字母）' }),
      choiceInput,
    ]),
    el('p.tiny.muted', { text: '必须在已填选项范围内；多选请把字母连写，如 ABD。' }),
  ]);

  const judgeChips = new Map();
  const judgeRow = el('div.chips');
  for (const value of ['正确', '错误']) {
    const chip = el('button.chip', {
      type: 'button',
      text: value,
      onclick: () => {
        judgeAnswer = judgeAnswer === value ? '' : value;
        paintForm();
      },
    });
    judgeChips.set(value, chip);
    judgeRow.appendChild(chip);
  }
  const judgeBlock = el('div.field', {}, [
    el('label', { text: '正确答案' }),
    judgeRow,
  ]);

  const textAnswerInput = el('textarea', { rows: 3, placeholder: '参考答案要点（可留空）' });
  const textBlock = el('div.field', {}, [
    el('label', { text: '参考答案（简答/论述，可留空）' }),
    textAnswerInput,
  ]);

  /* --- 解析 --- */
  const explainInput = el('textarea', { rows: 3, placeholder: '解析（可留空）' });

  /* --- 保存 --- */
  const saveBtn = el('button.btn.primary.block.mt12', { type: 'button', text: '保存补录', onclick: save });

  const formCard = el('div.card', {}, [
    el('h3.card-title', { text: `补录到《${name}》` }),
    el('p.card-sub', { text: '补录题与自动解析题完全平权：可练习、可统计、可进错题本与收藏本。' }),
    el('div.divider'),
    el('div.field', {}, [el('label', { text: '题型' }), typeRow]),
    el('div.field', {}, [el('label', { text: '题干' }), stemInput]),
    optionsField,
    choiceBlock,
    judgeBlock,
    textBlock,
    el('div.field', {}, [el('label', { text: '解析' }), explainInput]),
    saveBtn,
  ]);

  /** 题型/答案联动刷新 */
  function paintForm() {
    for (const [t, chip] of typeChips) chip.className = t === qtype ? 'chip active' : 'chip';
    const isChoice = qtype === QT_SINGLE || qtype === QT_MULTI;
    const isJudge = qtype === QT_JUDGE;
    choiceBlock.classList.toggle('hidden', !isChoice);
    judgeBlock.classList.toggle('hidden', !isJudge);
    textBlock.classList.toggle('hidden', isChoice || isJudge);
    for (const [value, chip] of judgeChips) {
      const selected = judgeAnswer === value;
      const base = value === '正确' ? 'ok' : 'bad';
      chip.className = selected ? `chip ${base}` : 'chip';
    }
  }

  /** 清理选项文本行首的字母前缀 */
  const cleanOption = (raw) => String(raw || '').replace(OPTION_PREFIX_RE, '').trim();

  /** 收集选项 → {A: '…', B: '…'} */
  function collectOptions() {
    const out = {};
    let letterIndex = 0;
    for (const raw of options) {
      const text = cleanOption(raw);
      if (!text) continue;
      out[String.fromCharCode(65 + letterIndex)] = text;
      letterIndex += 1;
    }
    return out;
  }

  /** 保存补录题 */
  async function save() {
    const stem = stemInput.value.trim();
    if (!stem) {
      toast('请填写题干');
      stemInput.focus();
      return;
    }

    const isChoice = qtype === QT_SINGLE || qtype === QT_MULTI;
    const isJudge = qtype === QT_JUDGE;
    const opts = isChoice || isJudge ? collectOptions() : {};
    let answer = '';

    if (isChoice) {
      if (Object.keys(opts).length < 2) {
        toast('单选/多选题至少需要 2 个选项');
        return;
      }
      answer = normalizeChoice(choiceInput.value);
      if (!answer) {
        toast('请填写正确答案字母，如 A 或 AB');
        choiceInput.focus();
        return;
      }
      const missing = answer.split('').find((c) => !opts[c]);
      if (missing) {
        toast(`答案 ${missing} 不在已填选项里`);
        return;
      }
      if (qtype === QT_SINGLE && answer.length > 1) {
        toast('单选题答案只能是一个字母');
        return;
      }
    } else if (isJudge) {
      answer = normalizeJudge(judgeAnswer);
      if (!answer) {
        toast('请选择「正确」或「错误」');
        return;
      }
    } else {
      answer = textAnswerInput.value.trim();
    }

    const question = makeQuestion({
      stem,
      qtype,
      options: opts,
      answer,
      explanation: explainInput.value.trim(),
      source: SOURCE_MANUAL,
    });

    saveBtn.disabled = true;
    try {
      const res = await repo.addManual(name, question);
      toast(`${(res && res.message) || '补录成功'} 补录题与自动解析题完全平权。`, 3200);
      await reloadCurrentBank();
      // 清空表单
      stemInput.value = '';
      explainInput.value = '';
      choiceInput.value = '';
      textAnswerInput.value = '';
      options = ['', '', '', ''];
      judgeAnswer = '';
      buildOptionRows();
      paintForm();
      await renderManual(root, params);
    } catch (err) {
      console.warn('手动补录：保存失败', err);
      toast('保存失败：' + msgOf(err), 3200);
    } finally {
      saveBtn.disabled = false;
    }
  }

  paintForm();

  const manualQuestions = await loadManualSafe(name);
  mount(
    root,
    formCard,
    sectionTitle('已补录的题目'),
    manualCard(name, manualQuestions, () => renderManual(root, params)),
  );
}

/* ---------------------------------------------------------------- 关于 */

/**
 * 关于页：应用信息、功能简介、数据存放说明与清空数据。
 * @param {HTMLElement} root
 * @param {object} [params]
 */
export async function renderAbout(root, params = {}) {
  setBackVisible(true);
  setAction(null);

  const overview = await loadOverview();

  const intro = [
    '导入 docx / pdf / txt 题库，自动切题、判题型、抽答案；',
    '8 种练习模式：顺序、随机、错题重练、收藏练习、今日艾宾浩斯复习、题型专项等；',
    '艾宾浩斯错题复习：答错入本按 [0,1,2,4,7,15,30] 天安排复习，连续答对 7 次移出错题本；',
    '错题本与收藏本随时回看，练习统计与薄弱知识点分析；',
    '错题本 / 收藏本可导出 PDF（含图片渲染，中文不乱码）。',
  ];

  const introCard = el('div.card', {}, [
    el('h3.card-title', { text: '功能简介' }),
    el('div', {}, intro.map((line) => el('p.card-sub.pre-wrap', { text: '· ' + line }))),
  ]);

  const dataCard = el('div.card', {}, [
    el('h3.card-title', { text: '数据存放说明' }),
    el('p.card-sub.pre-wrap', {
      text:
        '所有题库、错题本、收藏本、统计与解析日志都保存在本机浏览器的 IndexedDB（库名 quiz-mobile）里，' +
        '不会上传到任何服务器。卸载 App 或清除浏览器数据会一并清除，建议定期用「导出错题本 PDF」备份重点内容。',
    }),
    el('p.card-sub.pre-wrap.mt8', { text: '本应用完全离线运行，不联网、不上传任何数据。' }),
  ]);

  const dangerCard = el('div.card', {}, [
    el('h3.card-title', { text: '危险操作' }),
    el('p.card-sub', { text: '清空后题库、错题本、收藏本、统计与日志全部消失，无法恢复。' }),
    el('button.btn.bad.block.mt12', {
      type: 'button',
      text: '清空所有数据',
      onclick: async () => {
        const ok = await confirmDialog({
          title: '清空所有数据？',
          message: '题库、错题本、收藏本、统计与解析日志都会被删除，且无法恢复。建议先导出 PDF 备份。',
          okText: '清空',
          danger: true,
        });
        if (!ok) return;
        try {
          await db.clearAll();
          state.bank = null;
          state.bankName = '';
          state.questions = [];
          state.session = null;
          toast('已清空所有本地数据');
          await navigate('banks', {}, { push: false });
        } catch (err) {
          console.warn('关于页：清空数据失败', err);
          toast('清空失败：' + msgOf(err), 3200);
        }
      },
    }),
  ]);

  // 诊断信息：出问题时让用户能把这段直接发出来，省去来回猜
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '（未知环境）';
  const diagText = `App v${APP_VERSION}\nUA: ${ua}`;
  const diagCard = el('div.card', {}, [
    el('h3.card-title', { text: '诊断信息' }),
    el('p.card-sub', {
      text: '遇到「导入失败 / 解析异常」时，把下面这段连同屏幕上的报错文字一起发出来，就能快速定位。',
    }),
    el('div.mono.pre-wrap.mt8', { text: diagText }),
    el('div.grid2.mt12', {}, [
      el('button.btn', {
        type: 'button',
        text: '复制诊断信息',
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(diagText);
            toast('诊断信息已复制');
          } catch {
            toast('复制失败，请长按上面的文字手动选择');
          }
        },
      }),
      el('button.btn.primary', {
        type: 'button',
        text: '运行机器自检',
        onclick: () => navigate('selftest'),
      }),
    ]),
  ]);

  mount(
    root,
    el('div.card', {}, [
      el('h3.card-title', { text: `📱 ${APP_NAME}` }),
      el('p.card-sub', { text: `版本 v${APP_VERSION} · 纯离线刷题工具` }),
      el('div.mt8', {}, [
        kv('题库数量', `${overview.bankCount} 个`),
        kv('总题目数', `${overview.questionCount} 题`),
      ]),
    ]),
    introCard,
    dataCard,
    diagCard,
    dangerCard,
  );
}
