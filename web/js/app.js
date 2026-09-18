/**
 * 应用入口：路由、全局状态、题库导入流程。
 */

// 必须最先执行：补齐旧 WebView 缺失的现代 API（pdf.js 依赖 Promise.withResolvers 等）
import './polyfills.js';

import { APP_NAME, APP_VERSION } from './config.js';
import * as repo from './bank.js';
import { extractLines } from './extract.js';
import { parseLines } from './parser-text.js';
import { closeSheet, confirmDialog, el, loading, mount, openSheet, toast } from './ui/common.js';

/* ------------------------------------------------ 导入诊断（原始文本行） */

/** 最近一次导入的原始文本行（前 300 行），用于排查分栏/切题问题 */
const importDebug = { fileName: '', total: 0, lines: [] };

/**
 * 记录最近一次导入的原始文本行。
 * @param {string} fileName
 * @param {Array<{page:number,line:number,text:string}>} lines
 */
function rememberImportDebug(fileName, lines) {
  importDebug.fileName = String(fileName || '');
  importDebug.total = Array.isArray(lines) ? lines.length : 0;
  importDebug.lines = Array.isArray(lines) ? lines.slice(0, 300) : [];
}

/**
 * 取最近一次导入的原始文本行（供「解析日志」页展示/复制）。
 * @returns {{fileName:string, total:number, lines:Array, text:string}}
 */
export function getImportDebug() {
  const text = importDebug.lines
    .map((l) => `p${l.page}:${l.line}\t${l.text}`)
    .join('\n');
  return { ...importDebug, text };
}

/** 屏幕路由表 */
const ROUTES = {
  banks: { mod: () => import('./ui/banks.js'), fn: 'renderBanks', title: '题库', tab: 'banks' },
  practice: { mod: () => import('./ui/practice.js'), fn: 'renderPractice', title: '练习', tab: 'practice' },
  session: { mod: () => import('./ui/practice.js'), fn: 'renderSession', title: '练习中', tab: 'practice' },
  report: { mod: () => import('./ui/practice.js'), fn: 'renderReport', title: '练习报告', tab: 'practice' },
  generate: { mod: () => import('./ui/generate.js'), fn: 'renderGenerate', title: '知识点出题', tab: 'practice' },
  wrong: { mod: () => import('./ui/wrong.js'), fn: 'renderWrong', title: '错题本', tab: 'wrong' },
  favorites: { mod: () => import('./ui/wrong.js'), fn: 'renderFavorites', title: '收藏本', tab: 'wrong' },
  stats: { mod: () => import('./ui/stats.js'), fn: 'renderStats', title: '统计', tab: 'stats' },
  settings: { mod: () => import('./ui/settings.js'), fn: 'renderSettings', title: '设置', tab: 'settings' },
  ai: { mod: () => import('./ui/ai-settings.js'), fn: 'renderAiSettings', title: 'AI 识别设置', tab: 'settings' },
  logs: { mod: () => import('./ui/settings.js'), fn: 'renderLogs', title: '解析日志', tab: 'settings' },
  manual: { mod: () => import('./ui/settings.js'), fn: 'renderManual', title: '手动补录', tab: 'settings' },
  about: { mod: () => import('./ui/settings.js'), fn: 'renderAbout', title: '关于', tab: 'settings' },
  selftest: { mod: () => import('./ui/selftest.js'), fn: 'renderSelfTest', title: '机器自检', tab: 'settings' },
};

/** 全局状态 */
export const state = {
  /** @type {string} 当前题库名 */
  bankName: '',
  /** @type {object|null} 当前题库对象（含 questions） */
  bank: null,
  /** @type {object|null} 正在进行的练习会话 */
  session: null,
  /** @type {object[]} 当前练习的题目 */
  questions: [],
  /** @type {number} 当前题序号（从 0 开始） */
  index: 0,
  /** 屏幕栈，用于返回 */
  stack: [],
  screen: 'banks',
  params: {},
};

/* ------------------------------------------------------------ 顶栏控制 */

/** @param {string} text */
export function setTitle(text) {
  document.getElementById('title').textContent = text;
}

/** @param {boolean} visible */
export function setBackVisible(visible) {
  document.getElementById('btn-back').classList.toggle('hidden', !visible);
}

/**
 * 设置右上角操作按钮。
 * @param {{label?:string, onClick?:Function}|null} action
 */
export function setAction(action) {
  const btn = document.getElementById('btn-action');
  if (!action) {
    btn.classList.add('hidden');
    btn.onclick = null;
    return;
  }
  btn.textContent = action.label || '⋯';
  btn.onclick = action.onClick || null;
  btn.classList.remove('hidden');
}

/* -------------------------------------------------------------- 路由 */

/**
 * 切换屏幕。
 * @param {string} screen
 * @param {object} [params]
 * @param {{push?:boolean}} [opts] push=false 表示替换当前屏（不增加返回层级）
 */
export async function navigate(screen, params = {}, opts = {}) {
  const route = ROUTES[screen];
  if (!route) {
    toast(`未知页面：${screen}`);
    return;
  }
  if (opts.push !== false && state.screen) {
    state.stack.push({ screen: state.screen, params: state.params });
  }
  state.screen = screen;
  state.params = params || {};

  setTitle(route.title);
  setBackVisible(state.stack.length > 0);
  setAction(null);
  for (const tab of document.querySelectorAll('#tabbar .tab')) {
    tab.classList.toggle('active', tab.dataset.screen === route.tab);
  }

  const root = document.getElementById('screen');
  loading(false);
  try {
    const mod = await route.mod();
    mount(root, el('div'));
    await mod[route.fn](root, state.params);
    window.scrollTo({ top: 0 });
  } catch (err) {
    console.error(err);
    mount(root, el('div.card', {}, [
      el('h3.card-title', { text: '页面加载失败' }),
      el('p.card-sub.pre-wrap', { text: String(err && err.message ? err.message : err) }),
    ]));
  }
}

/** 返回上一屏 */
export async function goBack() {
  const prev = state.stack.pop();
  if (!prev) {
    await navigate('banks', {}, { push: false });
    return;
  }
  state.screen = '';
  await navigate(prev.screen, prev.params, { push: false });
}

/* -------------------------------------------------------- 题库状态 */

/**
 * 载入题库到全局状态。
 * @param {string} name
 * @returns {Promise<object|null>}
 */
export async function loadBank(name) {
  const bank = await repo.getBank(name);
  if (!bank) {
    state.bankName = '';
    state.bank = null;
    return null;
  }
  state.bankName = name;
  state.bank = bank;
  await repo.touchBank(name);
  return bank;
}

/** 重新载入当前题库（补录/删除题目后刷新） */
export async function reloadCurrentBank() {
  if (state.bankName) await loadBank(state.bankName);
  return state.bank;
}

/* ------------------------------------------------------------ 导入 */

/** 触发系统文件选择，返回 File 或 null */
export function pickFile() {
  return new Promise((resolve) => {
    const input = document.getElementById('file-input');
    input.value = '';
    const onChange = () => {
      input.removeEventListener('change', onChange);
      resolve(input.files && input.files[0] ? input.files[0] : null);
    };
    input.addEventListener('change', onChange);
    input.click();
  });
}

/**
 * 导入/解析失败时弹出**可复制**的详情。
 * 以前只用 toast，几秒后就消失了，用户根本来不及看或截图，排查只能靠猜。
 * @param {string} title
 * @param {string} detail
 */
export function showErrorDetail(title, detail) {
  const text = String(detail || '（无详细信息）');
  const head = `App v${APP_VERSION}　（设置 → 关于 → 运行机器自检 可做完整检查）\n`;
  const body = el('div', {}, [
    el('h3.card-title', { text: title || '出错了' }),
    el('pre.pre-wrap.mono', {
      style: {
        maxHeight: '46vh',
        overflow: 'auto',
        background: 'var(--bg)',
        padding: '10px',
        borderRadius: '10px',
        fontSize: '12px',
        margin: '0',
      },
      text: head + text,
    }),
    el('div.mt12', {}, [
      el('button.btn.block', {
        type: 'button',
        text: '🔍 运行机器自检（看看设备解析链路是否正常）',
        onclick: () => {
          closeSheet();
          navigate('selftest');
        },
      }),
    ]),
    el('div.grid2.mt12', {}, [
      el('button.btn', { type: 'button', text: '知道了', onclick: () => closeSheet() }),
      el('button.btn.primary', {
        type: 'button',
        text: '复制这段信息',
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(head + text);
            toast('已复制，发给开发者即可定位');
          } catch {
            toast('复制失败，请长按上面的文字手动选择');
          }
        },
      }),
    ]),
  ]);
  openSheet(body);
}

/**
 * 导入题库文件（解析 → 保存 → 载入）。
 * @param {File} file
 * @param {{name?:string, overwrite?:boolean}} [opts]
 * @returns {Promise<object|null>} 导入后的题库对象
 */
export async function importFile(file, opts = {}) {
  if (!file) return null;
  const bankName = opts.name || file.name.replace(/\.[^.]+$/, '') || '未命名题库';
  const sizeText = file.size ? `（${(file.size / 1024 / 1024).toFixed(1)} MB）` : '';
  let cancelled = false;
  const showProgress = (text) => loading(text, {
    // 15 秒后才出现「取消」按钮：正常情况下用不到，卡住时用户能自己中断
    showCancelAfter: 15000,
    onCancel: () => {
      cancelled = true;
      loading('正在取消…（后台仍会收尾，可直接退出本页）');
    },
  });
  showProgress(`正在解析「${file.name}」${sizeText}…`);

  try {
    const { lines } = await extractLines(file, {
      onProgress: (info) => {
        if (cancelled) return;
        if (info && info.page && info.pages) {
          showProgress(`正在解析「${file.name}」…　第 ${info.page}/${info.pages} 页`);
        } else if (info && info.stage) {
          showProgress(`${info.stage}：${file.name}`);
        }
      },
    });
    if (cancelled) {
      showErrorDetail('已取消导入', '你取消了这次导入。如果解析过程一直不出结果，可以试试：\n· 先把文件另存到手机「文件 / 下载」目录再导入；\n· 用 WPS 把 PDF 另存为一份新的（去掉加密/压缩问题）再导入。');
      return null;
    }
    // 记住最近一次导入的原始文本行：出问题时可在「解析日志」页一键复制出来
    // （定位"分栏/切题哪里没对"最有效，只留前 300 行避免占内存）
    rememberImportDebug(file.name, lines);
    const parsed = parseLines(lines, bankName);
    if (!parsed.questions.length) {
      loading(false);
      showErrorDetail(
        '没有解析出题目',
        `文件「${file.name}」读到了 ${lines.length} 行文本，但一道题也没识别出来。\n\n` +
          '常见原因：\n' +
          '· 是扫描版/图片版 PDF（没有文字层），本程序不做 OCR；\n' +
          '· 题目格式比较特殊（例如选项没有 A/B/C/D 前缀、答案单独放在别处）。\n\n' +
          `解析统计：\n${typeof parsed.summary === 'function' ? parsed.summary() : JSON.stringify(parsed.warnings || [])}`,
      );
      return null;
    }
    if (!opts.overwrite) {
      const exist = await repo.getBank(bankName);
      if (exist) {
        loading(false);
        const ok = await confirmDialog({
          title: `题库「${bankName}」已存在`,
          message: `已有 ${exist.questions.length} 道题。覆盖后题目会更新，错题本与收藏本按题干保留。`,
          okText: '覆盖导入',
          danger: true,
        });
        if (!ok) return null;
        loading('正在解析…');
      }
    }
    await repo.importParsed(bankName, parsed, {
      fileName: file.name,
      fileType: (file.name.split('.').pop() || '').toLowerCase(),
    });
    await loadBank(bankName);
    const tips = [`导入成功：${parsed.questions.length} 道题`];
    if (parsed.errors.length) tips.push(`异常 ${parsed.errors.length} 条`);
    if (parsed.skipped.length) tips.push(`跳过 ${parsed.skipped.length} 行`);
    toast(tips.join('，'), 2600);
    return state.bank;
  } catch (err) {
    console.error(err);
    loading(false);
    // 详细错误用可复制的弹窗展示（toast 一闪而过，用户来不及截图）
    showErrorDetail('导入失败', err && err.message ? err.message : String(err));
    return null;
  } finally {
    loading(false);
  }
}

/**
 * 重新解析当前题库（保留错题本/收藏本/统计）。
 * @returns {Promise<boolean>}
 */
export async function reparseCurrentBank() {
  if (!state.bankName) {
    toast('请先选择题库');
    return false;
  }
  const ok = await confirmDialog({
    title: '重新解析题库',
    message: '请选择该题库的原始文件（.docx/.pdf）。错题本、收藏本、统计都会保留，手动补录题按题干自动保留。',
    okText: '选择文件',
  });
  if (!ok) return false;
  const file = await pickFile();
  if (!file) return false;
  const bank = await importFile(file, { name: state.bankName, overwrite: true });
  return !!bank;
}

/* ------------------------------------------------------------ 练习会话 */

/**
 * 开始一次练习。
 * @param {object[]} questions
 * @param {string} mode
 */
export function startSession(questions, mode) {
  state.questions = questions || [];
  state.index = 0;
  state.session = null;
  state.pendingMode = mode;
  return state.questions;
}

/**
 * 导入内置的示例题库（docx + pdf 各一份）。
 * 用途：出问题时先用它验证「解析链路是否正常」——
 *   示例题库能进来 → 说明程序没问题，是选中的文件格式特殊；
 *   示例题库也进不来 → 说明是这台手机的 WebView 兼容性问题。
 * @returns {Promise<string>} 结果摘要
 */
export async function importSamples() {
  // 文件名必须是 ASCII：中文文件名打进 APK 的 assets 里可能取不到（zip 条目不带 UTF-8 标记），
  // 中文题库名通过 opts.name 单独传。
  const samples = [
    { path: '../samples/sample-bank.docx', file: 'sample-bank.docx', name: '示例题库（Word 版）' },
    { path: '../samples/sample-bank.pdf', file: 'sample-bank.pdf', name: '示例题库（PDF 版）' },
  ];
  const results = [];
  loading('正在导入示例题库…');
  try {
    for (const item of samples) {
      const url = new URL(item.path, import.meta.url).href;
      try {
        const resp = await fetch(url);
        if (!resp.ok) {
          results.push(`${item.name}：读取失败(${resp.status})`);
          continue;
        }
        const blob = await resp.blob();
        const file = new File([blob], item.file, { type: blob.type || 'application/octet-stream' });
        const bank = await importFile(file, { overwrite: true, name: item.name });
        results.push(bank ? `${item.name}：${bank.questions.length} 题` : `${item.name}：未解析出题目`);
      } catch (err) {
        results.push(`${item.name}：${err && err.message ? err.message : err}`);
      }
    }
  } finally {
    loading(false);
  }
  const summary = results.join('；');
  toast(`示例题库导入结果 —— ${summary}`, 6000);
  return summary;
}

/* ------------------------------------------------------------ 启动 */

function bindShell() {
  // 用 onclick 赋值（而非 addEventListener），方便具体页面临时覆盖返回行为
  document.getElementById('btn-back').onclick = () => {
    goBack();
  };
  document.getElementById('tabbar').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    state.stack = [];
    navigate(tab.dataset.screen, {}, { push: false });
  });
}

async function boot() {
  bindShell();
  const last = await repo.lastUsedBankName();
  if (last) await loadBank(last);
  await navigate('banks', {}, { push: false });

  // 首次进入且没有题库时给个引导提示
  const banks = await repo.listBanks();
  if (!banks.length) {
    setTimeout(() => toast('还没有题库，点右上角「＋」导入 docx / pdf 文件', 3200), 600);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  boot().catch((err) => {
    console.error(err);
    toast('启动失败：' + (err && err.message ? err.message : err), 4000);
  });
});
