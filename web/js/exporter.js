/**
 * exporter.js —— 题目导出（HTML / PDF），供手机端「刷题助手」在浏览器与 Capacitor APK 内使用。
 *
 * 为什么不用 window.print() 生成 PDF？
 *   Android WebView 里没有 window.print()，而且 jsPDF 内置字体不含中文字形，
 *   把中文直接交给 jsPDF 会输出乱码或空白。因此这里统一走：
 *     自建 DOM 页面 → html2canvas 渲染成图片 → jsPDF.addImage 拼成分页 PDF。
 *   图片里的中文由系统字体（Android 的 Noto Sans CJK / 桌面端的苹方、雅黑）绘制，不会乱码。
 *
 * 分页切片策略（renderPdf 的核心）：
 *   1. 把导出文档挂到一个「屏幕外但已渲染」的固定定位容器里（left:-10000px，宽 794px = A4@96dpi）；
 *   2. 先把 DOM 块（页头 + 每道题）按高度切成若干「渲染段」（segment），段高上限 1600 CSS px，
 *      保证 scale=2 时 canvas 高度不超过 ~3200 设备像素，避免手机 WebView 显存/内存爆掉；
 *   3. 每段单独 html2canvas 成一张长图，再按「题目边界优先」的方式切成若干「切片」（tile）贴到 PDF：
 *      · 优先在块边界处切（切点取自渲染段内各块的 offsetTop + offsetHeight），所以不会把一行字切两半；
 *      · 一页剩余空间放不下下一个块时先换页，再试一次；
 *      · 单个块本身就超过一整页高度时，才按整页高度硬切（内容不会丢，下一页接着显示）。
 *   4. 切片用 canvas 重绘成独立图片再 addImage，避免整段长图被重复嵌入 PDF 造成体积膨胀。
 *
 * 本模块必须能在 Node 里 import（buildExportHtml 是纯字符串生成，可直接单测）；
 * 只有 renderPdf / exportPdf / downloadBlob 会触碰 window / document。
 */

/** PDF 页面宽度（CSS px，A4 在 96dpi 下的宽度） */
const PAGE_WIDTH_PX = 794;
/** 页面四周留白（CSS px）：上下 40px，左右同样留 40px 以免文字贴边 */
const PAGE_MARGIN_PX = 40;
/** CSS px → pt 的换算比例（96dpi → 72dpi） */
const PT_PER_PX = 0.75;
/** A4 尺寸（pt） */
const A4_WIDTH_PT = 595.28;
const A4_HEIGHT_PT = 841.89;
/** 正文区域（扣除页边距） */
const CONTENT_WIDTH_PT = A4_WIDTH_PT - 2 * PAGE_MARGIN_PX * PT_PER_PX;
const CONTENT_HEIGHT_PT = A4_HEIGHT_PT - 2 * PAGE_MARGIN_PX * PT_PER_PX;
const MARGIN_PT = PAGE_MARGIN_PX * PT_PER_PX;
/** 图片宽度占满正文宽度时的换算：1 CSS px 对应多少 pt（所有渲染段宽度固定，因此全局一致） */
const PT_PER_CSS_PX = CONTENT_WIDTH_PT / PAGE_WIDTH_PX;
/** 一页正文最多能容纳多少 CSS px 高的图片 */
const PAGE_CONTENT_CSS_PX = CONTENT_HEIGHT_PT / PT_PER_CSS_PX;
/** 单个渲染段的 CSS px 高度上限（控制 canvas 体积） */
const MAX_SEGMENT_CSS_PX = 1600;
/** canvas 最长边上限（设备像素），超过就降低 scale */
const MAX_CANVAS_PX = 8000;
/** html2canvas 渲染倍率（高分屏清晰度） */
const RENDER_SCALE = 2;
/** 切片最小高度：页底剩余空间小于它就换页，避免贴出一条很窄的碎块 */
const MIN_TILE_CSS_PX = 24;
/** JPEG 质量：兼顾清晰度与 PDF 体积 */
const JPEG_QUALITY = 0.92;
/** 题型展示顺序 */
const QTYPES = ['单选', '多选', '判断', '简答', '论述', '填空', '其他'];
/** 默认文件名/标题 */
const DEFAULT_TITLE = '题目导出';
/** 缺字段时的占位符 */
const DASH = '—';

/** 导出流程中的自定义错误（由 UI 捕获后提示用户，不抛裸异常） */
export class ExportError extends Error {
  /**
   * @param {string} message 中文错误信息
   */
  constructor(message) {
    super(message);
    this.name = 'ExportError';
  }
}

/**
 * @typedef {Object} ExportItem
 * @property {string} [stem] 题干
 * @property {string} [qtype] 题型（单选/多选/判断/简答/论述）
 * @property {Object<string,string>|string[]} [options] 选项，键为字母
 * @property {string} [answer] 答案
 * @property {string} [explanation] 解析
 * @property {number} [wrong_count] 错误次数（错题记录扩展字段）
 * @property {number} [correct_streak] 连续答对次数
 * @property {number} [stage] 复习阶段
 * @property {string} [next_review] 下次复习日期 YYYY-MM-DD
 */

/**
 * @typedef {Object} ExportOptions
 * @property {string} [title] 标题，如《示例题库》错题本
 * @property {string} [subtitle] 副标题
 * @property {boolean} [wrongInfo] 是否附上错题复习信息
 * @property {string} [exportedAt] 导出时间文本，不传则取当前时间
 * @property {string} [fileName] PDF 文件名（仅 exportPdf/renderPdf 使用）
 */

/* ============================ 纯逻辑工具 ============================ */

/**
 * HTML 转义（& < > "），所有文本输出前都必须过一遍。
 * @param {unknown} value 任意值
 * @returns {string} 转义后的字符串
 */
function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 先转义，再把换行转成 `<br>`（保留题干/解析里的换行）。
 * @param {unknown} value 任意值
 * @returns {string} 可直接嵌入 HTML 的文本
 */
function multiline(value) {
  return esc(value).replace(/\r\n|\r|\n/g, '<br>');
}

/**
 * 取字符串字段并去首尾空白。
 * @param {unknown} value 原始值
 * @returns {string} 文本
 */
function text(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

/**
 * 取数值字段，非法值回落为默认值。
 * @param {unknown} value 原始值
 * @param {number} [fallback] 默认值
 * @returns {number} 数值
 */
function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 从记录里读数值字段，同时兼容 snake_case 与 camelCase。
 * @param {Object} item 记录
 * @param {string[]} keys 候选键名
 * @param {number} fallback 默认值
 * @returns {number} 数值
 */
function pickNum(item, keys, fallback) {
  for (const key of keys) {
    if (item && item[key] !== undefined && item[key] !== null && item[key] !== '') {
      return num(item[key], fallback);
    }
  }
  return fallback;
}

/**
 * 题型原文（去空白，缺省为占位符）。
 * @param {unknown} qtype 题型
 * @returns {string} 题型原文
 */
function qtypeRaw(qtype) {
  return text(qtype) || DASH;
}

/**
 * 题型展示名：`单选` → `单选题`；缺失时为 `—`。
 * @param {unknown} qtype 题型
 * @returns {string} 展示名
 */
function qtypeLabel(qtype) {
  const raw = qtypeRaw(qtype);
  if (raw === DASH) return DASH;
  return raw.endsWith('题') ? raw : `${raw}题`;
}

/**
 * 题型排序：按约定顺序，未知题型排后面并按字典序。
 * @param {string} a 题型 a
 * @param {string} b 题型 b
 * @returns {number} 排序值
 */
function compareQtype(a, b) {
  const ia = QTYPES.indexOf(a);
  const ib = QTYPES.indexOf(b);
  const ra = ia === -1 ? QTYPES.length : ia;
  const rb = ib === -1 ? QTYPES.length : ib;
  if (ra !== rb) return ra - rb;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 归一化选项：支持 `{A:'…', B:'…'}` 与 `['…','…']`，按字母升序返回。
 * @param {unknown} options 选项
 * @returns {{letter: string, text: string}[]} 排序后的选项列表
 */
function normalizeOptions(options) {
  /** @type {{letter: string, text: string}[]} */
  const list = [];
  if (Array.isArray(options)) {
    options.forEach((value, index) => {
      list.push({ letter: String.fromCharCode(65 + index), text: text(value) || DASH });
    });
  } else if (options && typeof options === 'object') {
    for (const key of Object.keys(options)) {
      const letter = text(key).toUpperCase();
      if (!letter) continue;
      list.push({ letter, text: text(options[key]) || DASH });
    }
  }
  list.sort((a, b) => (a.letter < b.letter ? -1 : a.letter > b.letter ? 1 : 0));
  return list;
}

/**
 * 错题复习信息行：`错误次数：N　连续答对：M　复习阶段：S　下次复习：YYYY-MM-DD`。
 * @param {Object} item 错题记录
 * @returns {string} 已转义的 HTML 文本
 */
function wrongLine(item) {
  const wrongCount = pickNum(item, ['wrong_count', 'wrongCount'], 0);
  const streak = pickNum(item, ['correct_streak', 'correctStreak'], 0);
  const stage = pickNum(item, ['stage'], 0);
  const nextReview = text(item && (item.next_review ?? item.nextReview)) || DASH;
  return (
    `错误次数：${esc(wrongCount)}　连续答对：${esc(streak)}` +
    `　复习阶段：${esc(stage)}　下次复习：${esc(nextReview)}`
  );
}

/**
 * 本地时间文本（不依赖浏览器 API，Node 也可用）。
 * @param {Date} [date] 时间
 * @returns {string} `YYYY-MM-DD HH:mm:ss`
 */
function formatNow(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ` +
    `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`
  );
}

/**
 * 生成默认 PDF 文件名：标题（去掉非法字符）+ 时间戳。
 * @param {string} [title] 标题
 * @returns {string} 形如 `示例题库错题本_20260917201000.pdf`
 */
export function buildFileName(title = '') {
  const base =
    text(title)
      .replace(/[\\/:*?"<>|\s]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || DEFAULT_TITLE;
  const stamp = formatNow().replace(/[-: ]/g, '');
  return `${base}_${stamp}.pdf`;
}

/* ============================ HTML 生成（纯函数） ============================ */

/** 导出文档样式：白底黑字、固定 794px 宽、只用 html2canvas 稳定支持的简单布局 */
const EXPORT_CSS = `
html.quiz-exp-doc, body.quiz-exp-doc { margin: 0; padding: 0; background: #ffffff; color: #000000; }
.quiz-exp-root {
  width: 794px;
  box-sizing: border-box;
  padding: 32px 28px;
  background: #ffffff;
  color: #000000;
  font-family: -apple-system, "PingFang SC", "Noto Sans CJK SC", sans-serif;
  font-size: 15px;
  line-height: 1.6;
  word-wrap: break-word;
  overflow-wrap: break-word;
  text-align: left;
}
.quiz-exp-root--flush { padding-top: 0; }
.quiz-exp-title { margin: 0 0 10px; font-size: 21px; line-height: 1.4; font-weight: 700; text-align: center; }
.quiz-exp-sub { margin: 0 0 8px; font-size: 14px; line-height: 1.6; text-align: center; color: #333333; }
.quiz-exp-meta { margin: 0 0 8px; font-size: 13px; line-height: 1.6; color: #333333; }
.quiz-exp-stats {
  margin: 0;
  padding: 0 0 10px;
  list-style: none;
  font-size: 13px;
  line-height: 1.6;
  color: #333333;
  border-bottom: 1.5px solid #000000;
}
.quiz-exp-stats li { display: inline-block; margin: 0 18px 0 0; }
.quiz-exp-list { margin: 0; padding: 0; list-style: none; }
.quiz-exp-item { margin: 0; padding: 0 0 14px; }
.quiz-exp-sep { height: 0; margin: 0 0 14px; border-top: 1px solid #c8c8c8; }
.quiz-exp-stem { margin: 0 0 6px; font-weight: 700; }
.quiz-exp-opt { margin: 0 0 2px; padding-left: 18px; }
.quiz-exp-answer { margin: 6px 0 2px; font-weight: 700; }
.quiz-exp-expl { margin: 0; }
.quiz-exp-wrong { margin: 6px 0 0; font-size: 13px; color: #333333; }
.quiz-exp-empty { margin: 0; padding: 24px 0; text-align: center; color: #666666; }
`;

/**
 * 生成单题 HTML。分隔线放在题目内部（而不是用 `+`/`:first-child` 选择器），
 * 这样每个块的高度是自包含的，切片渲染时高度与首次测量完全一致。
 * @param {ExportItem} item 题目或错题记录
 * @param {number} index 序号（从 0 开始）
 * @param {boolean} wrongInfo 是否附错题信息
 * @returns {string} HTML 片段
 */
function buildItemHtml(item, index, wrongInfo) {
  const record = item && typeof item === 'object' ? item : {};
  const parts = ['<li class="quiz-exp-item">'];
  if (index > 0) parts.push('<div class="quiz-exp-sep"></div>');
  parts.push(
    `<p class="quiz-exp-stem">${index + 1}.【${esc(qtypeLabel(record.qtype))}】${multiline(record.stem) || DASH}</p>`,
  );
  for (const opt of normalizeOptions(record.options)) {
    parts.push(`<p class="quiz-exp-opt">${esc(opt.letter)}. ${multiline(opt.text)}</p>`);
  }
  parts.push(`<p class="quiz-exp-answer">答案：${esc(text(record.answer) || DASH)}</p>`);
  parts.push(`<p class="quiz-exp-expl">解析：${multiline(record.explanation) || '（无）'}</p>`);
  if (wrongInfo) parts.push(`<p class="quiz-exp-wrong">${wrongLine(record)}</p>`);
  parts.push('</li>');
  return parts.join('');
}

/**
 * 按题型统计（只列数量 > 0 的题型）。
 * @param {ExportItem[]} items 题目列表
 * @returns {string} `<li>` 片段
 */
function buildStatsHtml(items) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const item of items) {
    const key = qtypeRaw(item && item.qtype);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.keys()]
    .sort(compareQtype)
    .map((key) => `<li>${esc(qtypeLabel(key))} ${counts.get(key)} 题</li>`)
    .join('');
}

/**
 * 生成完整导出 HTML 文档（**纯字符串生成，不访问 DOM，可在 Node 里单测**）。
 * 结构：标题 / 副标题 / 导出时间 + 总题数 + 题型统计 / 逐题（题干、选项、答案、解析、错题信息）。
 * @param {ExportItem[]} items 题目或错题记录列表
 * @param {ExportOptions} [opts] 导出选项
 * @returns {string} 完整 HTML 文本
 */
export function buildExportHtml(items, opts = {}) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const list = Array.isArray(items) ? items : [];
  const title = text(options.title) || DEFAULT_TITLE;
  const subtitle = text(options.subtitle);
  const wrongInfo = Boolean(options.wrongInfo);
  const exportedAt = text(options.exportedAt) || formatNow();

  const head = [];
  head.push(`<h1 class="quiz-exp-title">${esc(title)}</h1>`);
  if (subtitle) head.push(`<p class="quiz-exp-sub">${esc(subtitle)}</p>`);
  head.push(
    `<p class="quiz-exp-meta">导出时间：${esc(exportedAt)}　总题数：${list.length} 题</p>`,
  );
  head.push(`<ul class="quiz-exp-stats">${buildStatsHtml(list)}</ul>`);

  const body = list.length
    ? `<ul class="quiz-exp-list">${list.map((item, i) => buildItemHtml(item, i, wrongInfo)).join('')}</ul>`
    : '<p class="quiz-exp-empty">（暂无题目）</p>';

  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN" class="quiz-exp-doc">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(title)}</title>`,
    `<style>${EXPORT_CSS}</style>`,
    '</head>',
    '<body class="quiz-exp-doc">',
    '<div class="quiz-exp-root">',
    '<header>',
    ...head,
    '</header>',
    body,
    '</div>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/**
 * 导出 HTML 文本（与 `buildExportHtml` 等价，保留文档约定的接口名）。
 * @param {ExportItem[]} items 题目列表
 * @param {ExportOptions} [opts] 导出选项
 * @returns {Promise<string>} 完整 HTML 文本
 */
export async function exportHtml(items, opts = {}) {
  return buildExportHtml(items, opts);
}

/* ============================ 运行时依赖与 DOM 工具 ============================ */

/**
 * 检查浏览器运行时依赖（vendor 目录里的两个 UMD 库）。
 * @returns {{jsPDF: Function, html2canvas: Function}} 构造函数
 * @throws {ExportError} 依赖未加载时抛出
 */
function ensureRuntimeDeps() {
  const jsPDFCtor = globalThis.jspdf && globalThis.jspdf.jsPDF ? globalThis.jspdf.jsPDF : globalThis.jsPDF;
  const html2canvas = globalThis.html2canvas;
  if (typeof jsPDFCtor !== 'function' || typeof html2canvas !== 'function') {
    throw new ExportError('导出组件未加载：请确认 web/vendor 下的 jspdf/html2canvas 已就位');
  }
  return { jsPDF: jsPDFCtor, html2canvas };
}

/**
 * 等待下一帧（连续两帧，确保布局与绘制都已完成）。
 * 注意：页面被切到后台时 WebView 可能完全暂停 requestAnimationFrame，
 * 因此这里叠加一层定时器兜底，避免导出流程被无限挂起。
 * @param {number} [timeoutMs] 兜底等待上限（毫秒）
 * @returns {Promise<void>} 完成信号
 */
function nextFrame(timeoutMs = 250) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => requestAnimationFrame(finish));
      setTimeout(finish, Math.max(0, timeoutMs));
    } else {
      setTimeout(finish, 0);
    }
  });
}

/**
 * 等待字体就绪，避免渲染到 fallback 字体后再切换导致排版抖动。
 * 同样加超时兜底：某些 WebView 的 `document.fonts.ready` 可能长期不 resolve。
 * @param {number} [timeoutMs] 兜底等待上限（毫秒）
 * @returns {Promise<void>} 完成信号
 */
async function waitForFonts(timeoutMs = 3000) {
  try {
    if (typeof document !== 'undefined' && document.fonts && document.fonts.ready) {
      await Promise.race([
        document.fonts.ready,
        new Promise((resolve) => setTimeout(resolve, Math.max(0, timeoutMs))),
      ]);
    }
  } catch (err) {
    console.warn('导出：等待字体就绪失败（继续渲染）', err);
  }
}

/**
 * 离屏容器的统一样式：已渲染但不显示在屏幕上，宽度固定 A4。
 * @returns {string} style 属性值
 */
function offscreenStyle() {
  return 'position:fixed;left:-10000px;top:0;width:794px;background:#ffffff;z-index:-1;';
}

/**
 * 把导出文档挂到离屏容器：只取 `#quiz-exp-root` 子树与 `<style>`，
 * 并用 `html.quiz-exp-doc` / `body.quiz-exp-doc` 限定全局规则，避免污染宿主页面样式。
 * @param {string} html buildExportHtml 的输出
 * @returns {{container: HTMLElement, root: HTMLElement, css: string}} 挂载结果
 * @throws {ExportError} 宿主环境或模板异常时抛出
 */
function mountStage(html) {
  if (typeof document === 'undefined' || !document.body) {
    throw new ExportError('当前环境不支持导出：缺少 DOM');
  }
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const sourceRoot = parsed.querySelector('.quiz-exp-root');
  if (!sourceRoot) throw new ExportError('导出失败：导出模板结构异常（缺少 .quiz-exp-root）');

  const css = [...parsed.querySelectorAll('style')].map((el) => el.textContent || '').join('\n');
  const container = document.createElement('div');
  container.setAttribute('data-quiz-export-stage', '1');
  container.setAttribute('style', offscreenStyle());
  const styleEl = document.createElement('style');
  styleEl.textContent = css;
  container.appendChild(styleEl);
  container.appendChild(document.importNode(sourceRoot, true));
  document.body.appendChild(container);
  return { container, root: /** @type {HTMLElement} */ (container.querySelector('.quiz-exp-root')), css };
}

/**
 * 取元素相对某基准元素顶部的偏移与高度（CSS px）。
 * @param {HTMLElement} el 元素
 * @param {number} baseTop 基准顶部坐标
 * @returns {{top: number, height: number}} 偏移与高度
 */
function offsetOf(el, baseTop) {
  const rect = el.getBoundingClientRect();
  return { top: rect.top - baseTop, height: rect.height };
}

/**
 * 收集可切片块：页头 / 空态提示等直接子元素，以及题目列表里的每一道题。
 * 每道题都是独立的块，切片时才能保证不会把一行字切两半。
 * @param {HTMLElement} root 导出根元素
 * @returns {HTMLElement[]} 块元素（按文档顺序）
 */
function collectBlocks(root) {
  /** @type {HTMLElement[]} */
  const blocks = [];
  for (const child of [...root.children]) {
    const el = /** @type {HTMLElement} */ (child);
    if (el.classList.contains('quiz-exp-list')) {
      for (const item of [...el.children]) blocks.push(/** @type {HTMLElement} */ (item));
    } else {
      blocks.push(el);
    }
  }
  return blocks;
}

/**
 * 把块克隆进渲染容器：`<li>` 题目会重新包进 `ul.quiz-exp-list`，其余块（页头等）直接挂载。
 * @param {HTMLElement} root 渲染用的 `.quiz-exp-root`
 * @param {HTMLElement[]} nodes 块列表
 * @returns {void}
 */
function appendBlocks(root, nodes) {
  let list = null;
  for (const node of nodes) {
    const isItem = node.tagName === 'LI' && node.parentElement && node.parentElement.classList.contains('quiz-exp-list');
    if (isItem) {
      if (!list) {
        list = document.createElement('ul');
        list.className = 'quiz-exp-list';
        root.appendChild(list);
      }
      list.appendChild(node.cloneNode(true));
      continue;
    }
    list = null;
    root.appendChild(node.cloneNode(true));
  }
}

/**
 * 把块列表按高度上限切成渲染段（保证单次 html2canvas 的 canvas 不会过大）。
 * @param {HTMLElement[]} blocks 块元素（页头 + 题目）
 * @param {number[]} heights 各块高度（CSS px）
 * @param {number} maxCss 单段高度上限
 * @returns {{nodes: HTMLElement[], heightCss: number}[]} 渲染段列表
 */
function splitSegments(blocks, heights, maxCss) {
  /** @type {{nodes: HTMLElement[], heightCss: number}[]} */
  const segments = [];
  let current = [];
  let height = 0;
  for (let i = 0; i < blocks.length; i += 1) {
    const h = heights[i] || 0;
    if (current.length && height + h > maxCss) {
      segments.push({ nodes: current, heightCss: height });
      current = [];
      height = 0;
    }
    current.push(blocks[i]);
    height += h;
  }
  if (current.length) segments.push({ nodes: current, heightCss: height });
  return segments;
}

/**
 * 依据段高选择 html2canvas 倍率：优先 2 倍，必要时降到 1 倍以限制 canvas 体积。
 * @param {number} heightCss 段高（CSS px）
 * @returns {number} 渲染倍率
 */
function chooseScale(heightCss) {
  const safe = Math.max(1, heightCss);
  return Math.max(1, Math.min(RENDER_SCALE, MAX_CANVAS_PX / safe));
}

/**
 * 渲染一个段并测量其内部块边界。
 * @param {{html2canvas: Function}} deps 运行时依赖
 * @param {{css: string, nodes: HTMLElement[], flushTop: boolean}} seg 段内容
 * @returns {Promise<{canvas: HTMLCanvasElement, scale: number, heightCss: number, boundaries: number[]}>} 渲染结果
 */
async function renderSegment(deps, seg) {
  const wrap = document.createElement('div');
  wrap.setAttribute('data-quiz-export-segment', '1');
  wrap.setAttribute('style', offscreenStyle());
  const styleEl = document.createElement('style');
  styleEl.textContent = seg.css;
  const root = document.createElement('div');
  root.className = seg.flushTop ? 'quiz-exp-root quiz-exp-root--flush' : 'quiz-exp-root';
  appendBlocks(root, seg.nodes);
  wrap.appendChild(styleEl);
  wrap.appendChild(root);
  document.body.appendChild(wrap);

  try {
    await nextFrame();
    const rootRect = root.getBoundingClientRect();
    const boundaries = [0];
    let heightCss = rootRect.height;
    const blocks = collectBlocks(root);
    if (blocks.length) {
      // 末块底边即内容底边：忽略容器底部内边距，避免段尾多出一小块空白切片
      heightCss = 0;
      for (const block of blocks) {
        const { top, height } = offsetOf(block, rootRect.top);
        const bottom = top + height;
        heightCss = Math.max(heightCss, bottom);
        if (bottom > 0) boundaries.push(Math.round(bottom * 100) / 100);
      }
    }
    boundaries.push(Math.round(heightCss * 100) / 100);
    const unique = [...new Set(boundaries)].sort((a, b) => a - b);

    const scale = chooseScale(heightCss);
    const canvas = await deps.html2canvas(root, {
      scale,
      backgroundColor: '#ffffff',
      logging: false,
      useCORS: true,
      windowWidth: PAGE_WIDTH_PX,
    });
    return { canvas, scale, heightCss, boundaries: unique };
  } finally {
    wrap.remove();
  }
}

/**
 * 把长图的一段切片重绘成独立 canvas 并贴到 PDF 指定位置。
 * @param {Object} pdf jsPDF 实例
 * @param {HTMLCanvasElement} source 整段长图
 * @param {Object} tile 切片参数
 * @param {number} tile.ySrcPx 源图起始像素（设备像素，向下取整）
 * @param {number} tile.hSrcPx 切片高度（设备像素）
 * @param {number} tile.yPt 目标页 y 坐标（pt）
 * @param {number} tile.hPt 目标高度（pt）
 * @returns {void}
 */
function addTile(pdf, source, tile) {
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = tile.hSrcPx;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // 用负偏移直接裁出切片，避免参数写错导致缩放
  ctx.drawImage(source, 0, -tile.ySrcPx);
  const data = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  pdf.addImage(data, 'JPEG', MARGIN_PT, tile.yPt, CONTENT_WIDTH_PT, tile.hPt);
}

/**
 * 渲染 PDF：自建 DOM → html2canvas → jsPDF 分页拼接（需在浏览器里运行）。
 * @param {ExportItem[]} items 题目或错题记录列表
 * @param {ExportOptions} [opts] 导出选项
 * @returns {Promise<{blob: Blob, pages: number, fileName: string}>} PDF 内容与页数
 * @throws {ExportError} 依赖未加载或 DOM 异常时抛出
 */
export async function renderPdf(items, opts = {}) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const deps = ensureRuntimeDeps(); // 先检查依赖，错误信息更明确
  const html = buildExportHtml(items, options);
  const stage = mountStage(html);

  try {
    await waitForFonts();
    await nextFrame();

    // 第一遍：在原始 DOM 上量出各块高度，用于切段
    const stageRect = stage.root.getBoundingClientRect();
    const blocks = collectBlocks(stage.root);
    const metrics = blocks.map((el) => offsetOf(el, stageRect.top));
    const segments = splitSegments(blocks, metrics.map((m) => m.height), MAX_SEGMENT_CSS_PX);

    const pdf = new deps.jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4', compress: true });
    let cursorCss = 0; // 当前页已用高度（换算成 CSS px）

    for (let s = 0; s < segments.length; s += 1) {
      const segment = segments[s];
      const { canvas, heightCss, boundaries } = await renderSegment(deps, {
        css: stage.css,
        nodes: segment.nodes,
        flushTop: s > 0, // 续接段去掉顶部内边距，避免页中出现空白
      });
      const devicePxPerCss = canvas.width / PAGE_WIDTH_PX;
      let posCss = 0;

      while (posCss < heightCss - 0.5) {
        const remain = PAGE_CONTENT_CSS_PX - cursorCss;
        // 找出「不超过剩余空间」的最后一个块边界（= 不切断文字）
        let cut = -1;
        let nextBoundary = heightCss;
        for (const b of boundaries) {
          if (b <= posCss + 0.5) continue;
          if (b - posCss <= remain + 0.5) cut = b;
          else {
            nextBoundary = b;
            break;
          }
        }
        if (cut < 0) {
          const needCss = nextBoundary - posCss;
          // 页底空间太小 / 下一个块放不下：先换页再试
          if (cursorCss > 0.5 && (remain < MIN_TILE_CSS_PX || needCss <= PAGE_CONTENT_CSS_PX + 0.5)) {
            pdf.addPage();
            cursorCss = 0;
            continue;
          }
          // 单个块本身就超过一整页：按整页高度硬切，内容不丢，下一页接着画
          cut = Math.min(heightCss, posCss + remain);
        }

        const tileCss = cut - posCss;
        if (tileCss <= 0.5) break;
        const ySrcPx = Math.floor(posCss * devicePxPerCss);
        const hSrcPx = Math.max(1, Math.ceil(cut * devicePxPerCss) - ySrcPx);
        addTile(pdf, canvas, {
          ySrcPx,
          hSrcPx,
          yPt: MARGIN_PT + cursorCss * PT_PER_CSS_PX,
          hPt: tileCss * PT_PER_CSS_PX,
        });
        cursorCss += tileCss;
        posCss = cut;
        // 段内还有剩余时，剩余空间已放不下下一个块，直接换页
        if (posCss < heightCss - 0.5 && cursorCss >= PAGE_CONTENT_CSS_PX - 0.5) {
          pdf.addPage();
          cursorCss = 0;
        }
      }
    }

    const pages = pdf.getNumberOfPages();
    const blob = pdf.output('blob');
    return { blob, pages, fileName: text(options.fileName) || buildFileName(options.title) };
  } finally {
    stage.container.remove();
  }
}

/* ============================ 保存 / 下载 ============================ */

/**
 * 浏览器下载：`URL.createObjectURL` + `<a download>`，稍后回收对象 URL。
 * @param {Blob} blob 文件内容
 * @param {string} fileName 文件名
 * @returns {boolean} 是否已触发下载
 * @throws {ExportError} 环境不支持下载时抛出
 */
export function downloadBlob(blob, fileName) {
  if (!blob) throw new ExportError('导出失败：文件内容为空');
  const canObjectUrl = typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';
  if (!canObjectUrl) throw new ExportError('当前环境不支持浏览器下载（URL.createObjectURL 不可用）');
  const url = URL.createObjectURL(blob);
  if (typeof document === 'undefined' || !document.body) {
    try {
      URL.revokeObjectURL(url);
    } catch (err) {
      console.warn('导出：释放临时地址失败', err);
    }
    throw new ExportError('当前环境不支持浏览器下载（缺少 DOM）');
  }
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName || 'export.pdf';
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  try {
    a.click();
  } finally {
    // 立刻 revoke 可能让部分 WebView 取消下载，延迟回收
    setTimeout(() => {
      try {
        a.remove();
      } catch (err) {
        console.warn('导出：移除下载链接触发失败', err);
      }
      try {
        URL.revokeObjectURL(url);
      } catch (err) {
        console.warn('导出：回收临时地址失败', err);
      }
    }, 2000);
  }
  return true;
}

/**
 * 是否运行在 Capacitor 原生环境（APK 内）。
 * @returns {boolean} 原生环境为 true
 */
function isNativePlatform() {
  try {
    return Boolean(globalThis.Capacitor && globalThis.Capacitor.isNativePlatform && globalThis.Capacitor.isNativePlatform());
  } catch (err) {
    console.warn('导出：检测 Capacitor 环境失败（按浏览器处理）', err);
    return false;
  }
}

/**
 * Blob → base64（去掉 dataURL 前缀），优先用 FileReader。
 * @param {Blob} blob 文件内容
 * @returns {Promise<string>} base64 字符串
 */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    if (typeof FileReader === 'undefined') {
      reject(new ExportError('当前环境不支持读取文件内容（缺少 FileReader）'));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new ExportError('读取导出内容失败'));
    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.includes(',') ? result.slice(result.indexOf(',') + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

/**
 * Capacitor 环境保存：写文件到手机目录 + 调起系统分享，任一步失败返回 null 由调用方降级。
 * @param {Blob} blob PDF 内容
 * @param {string} fileName 文件名
 * @param {ExportOptions} options 导出选项
 * @returns {Promise<{savedAs: string, path: string, uri: string}|null>} 保存结果，失败为 null
 */
async function saveInNativeApp(blob, fileName, options) {
  let filesystem = null;
  try {
    filesystem = await import('@capacitor/filesystem');
  } catch (err) {
    console.warn('导出：@capacitor/filesystem 不可用，降级为浏览器下载', err);
    return null;
  }
  let base64 = '';
  try {
    base64 = await blobToBase64(blob);
  } catch (err) {
    console.warn('导出：读取 PDF 内容失败，降级为浏览器下载', err);
    return null;
  }

  const Directory = filesystem.Directory || {};
  // Android 11+ 对公共「文档」目录写入有限制，失败时退回应用缓存目录（分享仍可用）
  const targets = [
    { directory: Directory.Documents, label: '手机「文档」目录' },
    { directory: Directory.Cache, label: '应用缓存目录' },
  ];
  let written = null;
  for (const target of targets) {
    if (!target.directory) continue;
    try {
      const res = await filesystem.Filesystem.writeFile({
        path: fileName,
        data: base64,
        directory: target.directory,
        recursive: true,
      });
      written = { uri: res && res.uri ? res.uri : '', path: fileName, label: target.label };
      break;
    } catch (err) {
      console.warn(`导出：写入${target.label}失败，尝试下一个位置`, err);
    }
  }
  if (!written) return null;

  let shared = false;
  try {
    const share = await import('@capacitor/share');
    if (share && share.Share && typeof share.Share.share === 'function') {
      await share.Share.share({
        title: text(options.title) || DEFAULT_TITLE,
        text: `${text(options.title) || DEFAULT_TITLE}（PDF）`,
        url: written.uri,
        dialogTitle: '分享导出的 PDF',
      });
      shared = true;
    }
  } catch (err) {
    // 用户取消分享也会走到这里，文件其实已经保存成功，只记录不报错
    console.warn('导出：调起系统分享失败（文件已保存）', err);
  }

  return {
    savedAs: shared
      ? `已保存到${written.label}并打开系统分享：${fileName}`
      : `已保存到${written.label}：${fileName}`,
    path: written.path,
    uri: written.uri,
  };
}

/**
 * 导出 PDF：浏览器触发下载；Capacitor 环境写文件 + 分享（失败逐级降级为下载）。
 * @param {ExportItem[]} items 题目或错题记录列表
 * @param {ExportOptions} [opts] 导出选项
 * @returns {Promise<{blob: Blob, pages: number, savedAs: string, fileName: string, path?: string, uri?: string}>} 导出结果
 */
export async function exportPdf(items, opts = {}) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const { blob, pages, fileName } = await renderPdf(items, options);

  if (isNativePlatform()) {
    const native = await saveInNativeApp(blob, fileName, options);
    if (native) return { blob, pages, fileName, ...native };
    console.warn('导出：设备保存不可用，改用浏览器下载');
  }

  downloadBlob(blob, fileName);
  return { blob, pages, fileName, savedAs: '已下载到浏览器下载目录' };
}

export default { ExportError, buildExportHtml, exportHtml, renderPdf, exportPdf, downloadBlob, buildFileName };
