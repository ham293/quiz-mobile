/**
 * ai.js —— 用大模型（OpenAI 兼容的 /chat/completions 接口）识别题库文件里的题目。
 *
 * 设计约束（与 docs/接口约定.md 一致）：
 *  1. **纯逻辑模块**：本模块不碰 window / document，可被 Node 直接 import 与单测；
 *  2. **网络层可注入**：所有请求都经过 `requestFn(payload)`，默认实现是 defaultRequest，
 *     单测里注入假函数即可跑通完整流程（不发任何网络请求）；
 *  3. **离线优先**：只有用户主动点「用 AI 识别题库」才会联网，其余功能全离线；
 *  4. **不泄露 Key**：API Key 只存 localStorage，不写进代码、日志、题库数据或错误详情。
 *
 * 主流程：
 *   文本行 → chunkLines() 切块 → buildMessages() 组提示词 → requestFn() 请求
 *          → parseAiQuestions() 解析 JSON → models.makeQuestion() 规范化 → 按 qid 去重。
 *
 * 【CapacitorHttp 的坑】安卓 WebView 里 fetch 直连第三方接口会被 CORS 拦掉，
 * 官方解法是启用 CapacitorHttp 全局补丁；但那个补丁会把**本地资源请求**也接管，
 * 导致 vendor 下的 pdf.js / cmaps 等本地文件加载异常（本项目踩过）。
 * 所以这里只做**显式调用**：`CapacitorHttp.post({...})`，不开任何全局补丁。
 */

import {
  QT_ESSAY,
  QT_JUDGE,
  QT_MULTI,
  QT_SHORT,
  QT_SINGLE,
  QUESTION_TYPES,
  makeQuestion,
  normalizeChoice,
  normalizeJudge,
} from './models.js';

/* ------------------------------------------------------------------ *
 * 常量与预设
 * ------------------------------------------------------------------ */

/** 内置服务商预设（都是 OpenAI 兼容接口，只填 Key 就能用） */
export const AI_PROVIDERS = [
  { id: 'zhipu', name: '智谱 GLM-4-Flash（免费额度）', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys', free: true },
  { id: 'moonshot', name: 'Kimi（月之暗面）', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', keyUrl: 'https://platform.moonshot.cn/console/api-keys' },
  { id: 'doubao', name: '豆包（火山方舟）', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-pro-32k', keyUrl: 'https://console.volcengine.com/ark' },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', keyUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'siliconflow', name: '硅基流动 SiliconFlow（有免费模型）', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct', keyUrl: 'https://cloud.siliconflow.cn/account/ak', free: true },
  { id: 'custom', name: '自定义（OpenAI 兼容接口）', baseUrl: '', model: '' },
];

/** localStorage 存储键 */
export const AI_SETTINGS_KEY = 'quiz.aiSettings';

/** 默认分块字符数（一个块 ≈ 一次请求；太大容易超时/超上下文，太小费额度） */
export const DEFAULT_CHUNK_CHARS = 6000;

/** 单次请求超时（毫秒） */
export const AI_TIMEOUT_MS = 45000;

/** 分块字符数的允许范围 */
const MIN_CHUNK_CHARS = 1000;
const MAX_CHUNK_CHARS = 50000;

/** 选项最多到 H（与 models.OPTION_LETTERS 的 A~J 兼容，AI 一般最多给到 F） */
const OPTION_LETTERS_AI = 'ABCDEFGH';

/** 一行文本看起来是「一道新题的开头」：1. / （1） / 一、 / 第 3 题 … */
const QUESTION_START_RE = /^\s*(?:[（(]\s*\d{1,3}\s*[）)]|\d{1,3}\s*[.、．)）:：]|[一二三四五六七八九十]{1,3}\s*[、.．)）]|第\s*\d{1,3}\s*[题問])/;

/* ------------------------------------------------------------------ *
 * 错误类型
 * ------------------------------------------------------------------ */

/**
 * AI 环节的业务错误：message 是**给用户看的中文文案**，code 供程序判断。
 * code 取值：auth（Key 无效）/ rate（限流或额度用尽）/ timeout / network /
 *   bad_request / bad_response / empty / nokey（没配置）/ aborted（用户取消）。
 */
export class AiError extends Error {
  /**
   * @param {string} message 面向用户的中文提示
   * @param {string} [code] 错误分类
   * @param {string} [detail] 服务商原文（截断 200 字，用于排查）
   */
  constructor(message, code = 'unknown', detail = '') {
    super(message);
    this.name = 'AiError';
    this.code = code;
    this.detail = String(detail || '').slice(0, 200);
  }
}

/**
 * 取错误的可读文本。
 * @param {unknown} err
 * @returns {string}
 */
function msgOf(err) {
  if (err && err.message) return String(err.message);
  return String(err || '未知错误');
}

/** 等待若干毫秒（重试退避用；单测里把 retryDelayMs 传 0 即可跳过） */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ *
 * 设置读写（localStorage；Node 单测环境自动退回内存存储）
 * ------------------------------------------------------------------ */

/** Node / 无 localStorage 环境下的兜底内存存储（保证纯逻辑可测） */
const memoryStore = new Map();

/**
 * 读一个键：优先 localStorage，取不到就用内存兜底。
 * @param {string} key
 * @returns {string|null}
 */
function storageGet(key) {
  try {
    const ls = globalThis.localStorage;
    if (ls && typeof ls.getItem === 'function') return ls.getItem(key);
  } catch {
    /* 隐私模式等场景会抛错，忽略 */
  }
  return memoryStore.has(key) ? memoryStore.get(key) : null;
}

/**
 * 写一个键（含内存兜底）。
 * @param {string} key
 * @param {string} value
 */
function storageSet(key, value) {
  try {
    const ls = globalThis.localStorage;
    if (ls && typeof ls.setItem === 'function') {
      ls.setItem(key, value);
      return;
    }
  } catch {
    /* 存不进 localStorage（配额满/隐私模式）时退回内存 */
  }
  memoryStore.set(key, value);
}

/**
 * 删除一个键（含内存兜底）。
 * @param {string} key
 */
function storageRemove(key) {
  try {
    const ls = globalThis.localStorage;
    if (ls && typeof ls.removeItem === 'function') {
      ls.removeItem(key);
      return;
    }
  } catch {
    /* 忽略 */
  }
  memoryStore.delete(key);
}

/**
 * 取内置服务商预设。
 * @param {string} id
 * @returns {object|null}
 */
export function findProvider(id) {
  return AI_PROVIDERS.find((p) => p.id === id) || null;
}

/**
 * 把任意输入收敛到合法的分块字符数。
 * @param {unknown} value
 * @returns {number}
 */
function clampChunkChars(value) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CHUNK_CHARS;
  return Math.min(MAX_CHUNK_CHARS, Math.max(MIN_CHUNK_CHARS, n));
}

/**
 * 出厂默认设置（默认选中第一个免费服务商，但 Key 为空 → 未配置）。
 * @returns {{provider:string, baseUrl:string, model:string, apiKey:string, enabled:boolean, chunkChars:number, autoExplain:boolean}}
 */
function defaultSettings() {
  const first = AI_PROVIDERS[0];
  return {
    provider: first.id,
    baseUrl: first.baseUrl,
    model: first.model,
    apiKey: '',
    enabled: true,
    chunkChars: DEFAULT_CHUNK_CHARS,
    /** 答错且原题没有解析时，是否自动用 AI 生成讲解（会消耗额度，默认关） */
    autoExplain: false,
  };
}

/**
 * 读取 AI 设置（带默认值与字段清洗；任何异常都不会抛出）。
 * @returns {{provider:string, baseUrl:string, model:string, apiKey:string, enabled:boolean, chunkChars:number}}
 */
export function loadAiSettings() {
  const base = defaultSettings();
  const raw = storageGet(AI_SETTINGS_KEY);
  if (!raw) return base;

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn('[ai] 本地 AI 设置不是合法 JSON，已按默认值处理：', err);
    return base;
  }
  if (!parsed || typeof parsed !== 'object') return base;

  const provider = findProvider(parsed.provider) ? String(parsed.provider) : base.provider;
  const preset = findProvider(provider);
  const pick = (value, fallback) => (typeof value === 'string' && value.trim() ? value.trim() : fallback);

  return {
    provider,
    baseUrl: pick(parsed.baseUrl, preset ? preset.baseUrl : ''),
    model: pick(parsed.model, preset ? preset.model : ''),
    apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey.trim() : '',
    enabled: parsed.enabled !== false,
    chunkChars: clampChunkChars(parsed.chunkChars),
    autoExplain: parsed.autoExplain === true,
  };
}

/**
 * 合并保存 AI 设置，返回保存后的完整对象。
 * 换服务商（patch.provider）且没同时给 baseUrl/model 时，自动带出该预设的默认值。
 * @param {object} [patch] 要覆盖的字段
 * @returns {{provider:string, baseUrl:string, model:string, apiKey:string, enabled:boolean, chunkChars:number, autoExplain:boolean}}
 */
export function saveAiSettings(patch = {}) {
  const next = { ...loadAiSettings() };

  if (patch.provider !== undefined && findProvider(patch.provider)) {
    next.provider = String(patch.provider);
    const preset = findProvider(next.provider);
    if (patch.baseUrl === undefined) next.baseUrl = preset ? preset.baseUrl : next.baseUrl;
    if (patch.model === undefined) next.model = preset ? preset.model : next.model;
  }
  if (patch.baseUrl !== undefined) next.baseUrl = String(patch.baseUrl || '').trim();
  if (patch.model !== undefined) next.model = String(patch.model || '').trim();
  if (patch.apiKey !== undefined) next.apiKey = String(patch.apiKey || '').trim();
  if (patch.enabled !== undefined) next.enabled = patch.enabled !== false;
  if (patch.chunkChars !== undefined) next.chunkChars = clampChunkChars(patch.chunkChars);
  if (patch.autoExplain !== undefined) next.autoExplain = patch.autoExplain === true;

  storageSet(AI_SETTINGS_KEY, JSON.stringify(next));
  return next;
}

/**
 * 清除 AI 配置（含 API Key），返回默认设置。
 * @returns {{provider:string, baseUrl:string, model:string, apiKey:string, enabled:boolean, chunkChars:number}}
 */
export function clearAiSettings() {
  storageRemove(AI_SETTINGS_KEY);
  return defaultSettings();
}

/**
 * 是否已配置到「可以发请求」的程度：Key、接口地址、模型名都不能为空。
 * @param {object} [settings] 不传则读取本地设置
 * @returns {boolean}
 */
export function isAiConfigured(settings = loadAiSettings()) {
  const s = settings || {};
  return !!(
    String(s.apiKey || '').trim() &&
    String(s.baseUrl || '').trim() &&
    String(s.model || '').trim()
  );
}

/**
 * Key 打码：只保留前 4 位与后 4 位，中间固定 8 个星号（不泄露真实长度）。
 * 长度 ≤ 8 时整体打码；空值返回空串。
 * @param {string} key
 * @returns {string}
 */
export function maskKey(key) {
  const s = String(key || '').trim();
  if (!s) return '';
  if (s.length <= 8) return '*'.repeat(s.length);
  return `${s.slice(0, 4)}********${s.slice(-4)}`;
}

/* ------------------------------------------------------------------ *
 * 切块
 * ------------------------------------------------------------------ */

/**
 * 取一行文本（兼容 {text} 行结构与纯字符串）。
 * @param {string|{text?:string}} line
 * @returns {string}
 */
function lineText(line) {
  if (typeof line === 'string') return line;
  if (line && typeof line.text === 'string') return line.text;
  return line === null || line === undefined ? '' : String(line);
}

/**
 * 把文本行切成若干块（每块单独发一次请求）。
 *
 * 规则：
 *  - 按**字符数**累加，超过 maxChars 就换一块（单行本身超长时也至少独占一块，不截断）；
 *  - 已经累到 60% 预算后，若遇到「看起来是新题开头」的行（1. / （2）/ 三、/ 第 5 题），
 *    就在那里切开 —— 尽量不让一道题被劈成两半；
 *  - 相邻块之间保留 overlapLines 行重叠，边界处的题干与选项不会丢；
 *    重叠部分识别出的重复题目由 qid 去重兜底。
 *
 * 注意：maxChars 有 200 字的下限（再小就没有意义，只会白白多花请求机会）。
 *
 * @param {Array<string|{text:string}>} lines 文本行（extract.js 的产物或纯字符串数组）
 * @param {{maxChars?:number, overlapLines?:number}} [opts]
 * @returns {Array<{from:number, to:number, text:string}>} from/to 为 lines 的**闭区间下标**
 */
export function chunkLines(lines, { maxChars = DEFAULT_CHUNK_CHARS, overlapLines = 2 } = {}) {
  const list = Array.isArray(lines) ? lines : [];
  const chunks = [];
  if (!list.length) return chunks;

  const limit = Math.max(200, Math.trunc(Number(maxChars)) || DEFAULT_CHUNK_CHARS);
  const overlap = Math.max(0, Math.trunc(Number(overlapLines)) || 0);
  const softLimit = Math.floor(limit * 0.6);

  let start = 0;
  let guard = 0;
  while (start < list.length && guard < 10000) {
    guard += 1;
    let end = start;
    let chars = 0;
    let boundary = -1;

    while (end < list.length) {
      const text = lineText(list[end]);
      const len = text.length + 1; // +1 为换行符
      const isQuestionStart = end > start && QUESTION_START_RE.test(text);
      if (end > start && chars + len > limit) break;
      if (isQuestionStart && chars >= softLimit) boundary = end;
      chars += len;
      end += 1;
    }

    let cut = end;
    // 只有在「因为超预算而被迫换块」时才为了对齐题目边界提前收尾；
    // 如果已经读到文件末尾（剩余内容本来就装得下），就不再为对齐多切一刀，省一次请求。
    if (end < list.length && boundary > start) cut = boundary;

    const parts = [];
    for (let i = start; i < cut; i += 1) parts.push(lineText(list[i]));
    chunks.push({ from: start, to: cut - 1, text: parts.join('\n') });

    if (cut >= list.length) break;
    start = Math.max(start + 1, cut - overlap);
  }
  return chunks;
}

/* ------------------------------------------------------------------ *
 * 提示词
 * ------------------------------------------------------------------ */

/**
 * 系统提示词：要求模型只输出严格 JSON。
 * @returns {string}
 */
export function buildSystemPrompt() {
  return [
    '你是一个题库文本结构化助手。用户会给你一份题库文件里的文本片段（可能来自 Word / PDF 抽取，排版可能是乱的）。',
    '你的任务是：识别出其中的**题目**，并按要求输出**严格 JSON**，不要输出任何解释、前后缀或 Markdown 代码块以外的内容。',
    '',
    '输出格式（只输出这一个 JSON 对象）：',
    '{"questions":[{"stem":"题干","qtype":"单选","options":{"A":"","B":"","C":"","D":""},"answer":"","explanation":""}]}',
    '',
    '字段要求：',
    '1. stem：题干原文。必须去掉题号、分值标注（如「（2分）」「【5分】」）、页眉页脚、页码、试卷标题等与题目本身无关的内容。',
    '2. qtype：只能是「单选」「多选」「判断」「简答」「论述」之一。',
    '3. options：选项**必须**拆到一个对象里，键是大写字母 A、B、C、D…，值是选项正文（不要把「A.」写进值里）。',
    '   判断题、简答题、论述题没有选项时写空对象 {}。',
    '4. answer：选择题用字母（如 "A"、"ABD"，多选字母连写、不要分隔符）；判断题用「正确」或「错误」；',
    '   简答/论述题填参考答案要点。**原文里没有给出答案的就留空字符串**，不要自己编一个。',
    '5. explanation：原文里的答案解析，没有就留空。',
    '',
    '严格要求：',
    '· 只识别文本里**真实存在**的题目，绝对不要编造、改写或补充题目；',
    '· 跨片段的残缺内容（半截题干、只有选项没有题干）不要输出；',
    '· 文本里没有题目时输出 {"questions":[]}；',
    '· 只输出 JSON 本身，不要输出 markdown 说明、不要输出注释、不要输出多余文字。',
  ].join('\n');
}

/**
 * 组装一次请求的 messages。
 * @param {string} chunkText 文本块内容
 * @param {{typeHint?:string}} [opts] typeHint 为追加的题型/风格补充要求
 * @returns {Array<{role:string, content:string}>}
 */
export function buildMessages(chunkText, { typeHint = '' } = {}) {
  const hint = String(typeHint || '').trim();
  const user = [
    '以下是某份题库文件的文本片段，请识别其中的题目。',
    hint ? `补充要求：${hint}` : '',
    '',
    '--- 文本片段开始 ---',
    String(chunkText || ''),
    '--- 文本片段结束 ---',
  ]
    .filter((line) => line !== '')
    .join('\n');

  return [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: user },
  ];
}

/* ------------------------------------------------------------------ *
 * 解析模型返回
 * ------------------------------------------------------------------ */

/**
 * 从「可能夹带废话 / ```json 围栏」的返回文本里抠出 JSON 片段。
 * @param {string} rawText
 * @returns {string}
 */
export function extractJsonText(rawText) {
  let s = String(rawText === null || rawText === undefined ? '' : rawText).trim();
  if (!s) return '';

  // ```json … ``` 围栏：优先取围栏里的内容
  const fence = /```[ \t]*[A-Za-z0-9_-]*[ \t]*\r?\n?([\s\S]*?)```/.exec(s);
  if (fence && fence[1].trim()) {
    s = fence[1].trim();
  } else {
    s = s.replace(/```[A-Za-z0-9_-]*/g, '').trim();
  }

  const firstBrace = s.indexOf('{');
  const lastBrace = s.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) return s.slice(firstBrace, lastBrace + 1);

  const firstBracket = s.indexOf('[');
  const lastBracket = s.lastIndexOf(']');
  if (firstBracket >= 0 && lastBracket > firstBracket) return s.slice(firstBracket, lastBracket + 1);

  return s;
}

/**
 * 把全角标点换成 ASCII（只在原文解析失败后作为兜底尝试）。
 * 逗号/冒号即便落在字符串里也不影响 JSON 合法性，所以整套替换是安全的；
 * 中文引号不替换（替换会把题干里的引号弄坏）。
 * @param {string} text
 * @returns {string}
 */
function sanitizeJsonPunctuation(text) {
  return String(text || '')
    .replace(/｛/g, '{')
    .replace(/｝/g, '}')
    .replace(/［/g, '[')
    .replace(/］/g, ']')
    .replace(/，/g, ',')
    .replace(/：/g, ':');
}

/**
 * 宽容地解析 JSON：原文 → 全角修正 → 去尾逗号 → 两者叠加。
 * @param {string} text
 * @returns {{ok:boolean, value:any}}
 */
function tryParseJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return { ok: false, value: null };
  const sanitized = sanitizeJsonPunctuation(raw);
  const noTrailing = raw.replace(/,\s*([}\]])/g, '$1');
  const candidates = [raw, sanitized, noTrailing, sanitizeJsonPunctuation(noTrailing)];
  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch {
      /* 换下一种写法 */
    }
  }
  return { ok: false, value: null };
}

/**
 * 取第一个非空字符串（兼容数组、数字；**不**用来拼选项）。
 * @param {...unknown} values
 * @returns {string}
 */
function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (Array.isArray(value)) {
      const parts = value
        .filter((v) => (typeof v === 'string' && v.trim()) || typeof v === 'number')
        .map((v) => String(v).trim())
        .filter(Boolean);
      if (parts.length) return parts.join('');
    }
  }
  return '';
}

/** 去掉选项文本行首的「A.」「（B）」等前缀（**必须**带分隔符，避免把「AA电池」截坏） */
function stripOptionPrefix(text) {
  return String(text === null || text === undefined ? '' : text)
    .replace(/^[（(]\s*[A-Ha-h]\s*[)）]\s*/, '')
    .replace(/^[A-Ha-h]\s*[.、．)）:：,，]\s*/, '')
    .replace(/^["'“”‘’「」『』]\s*/, '')
    .replace(/["'“”‘’「」『』]\s*$/, '')
    .trim();
}

/** 取 out 里第一个还没用掉的字母（A~H） */
function nextFreeLetter(out) {
  for (const letter of OPTION_LETTERS_AI) if (!out[letter]) return letter;
  return '';
}

/**
 * 把各种形态的选项统一成 `{A:'…', B:'…'}`（键一律大写 A~H）。
 * 支持：对象（{'A':'…'} / {'选项A':'…'} / {'1':'…'}）、数组（['…','…']）、
 * 以及一整段字符串（"A. 甲　B. 乙"）。
 * @param {unknown} raw
 * @returns {Record<string,string>}
 */
export function normalizeOptions(raw) {
  const out = {};
  if (raw === null || raw === undefined) return out;

  /** @param {string|null} letter @param {unknown} value */
  const assign = (letter, value) => {
    const text = stripOptionPrefix(value);
    if (!text) return;
    const L = letter && OPTION_LETTERS_AI.includes(letter) ? letter : nextFreeLetter(out);
    if (!L || out[L]) return;
    out[L] = text;
  };

  if (Array.isArray(raw)) {
    for (const value of raw) assign(null, value);
    return out;
  }
  if (typeof raw === 'string') {
    const pieces = raw.split(/(?=[A-Ha-h]\s*[.、．)）:：])/);
    if (pieces.length >= 2) {
      for (const piece of pieces) {
        const m = /^\s*([A-Ha-h])\s*[.、．)）:：]?\s*([\s\S]*)$/.exec(piece);
        if (m) assign(m[1].toUpperCase(), m[2]);
      }
    }
    return out;
  }
  if (typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) {
      const m = /([A-Ha-h])/.exec(String(key));
      assign(m ? m[1].toUpperCase() : null, value);
    }
  }
  return out;
}

/**
 * 题型归一：先按关键词认，认不出就按「有没有选项 / 答案长什么样」推断。
 * @param {string} raw 模型给的题型字段
 * @param {Record<string,string>} options
 * @param {string} answer
 * @returns {string} models 的 QT_* 之一
 */
export function normalizeAiType(raw, options = {}, answer = '') {
  const s = String(raw || '').trim().toLowerCase().replace(/[\s\u3000]/g, '');
  if (s) {
    if (QUESTION_TYPES.includes(String(raw).trim())) return String(raw).trim();
    if (/(多选|多项选择|不定项|multichoice|multi_choice|multiple)/.test(s)) return QT_MULTI;
    if (/(判断|对错|正误|truefalse|true_false|boolean)/.test(s)) return QT_JUDGE;
    if (/(简答|简述|填空|shortanswer|short_answer|blank|fill)/.test(s)) return QT_SHORT;
    if (/(论述|问答|essay|discuss)/.test(s)) return QT_ESSAY;
    if (/(单选|单项选择|选择|choice)/.test(s)) return QT_SINGLE;
  }

  const optionCount = Object.keys(options || {}).length;
  if (optionCount >= 2) return normalizeChoice(answer).length > 1 ? QT_MULTI : QT_SINGLE;
  if (normalizeJudge(answer)) return QT_JUDGE;
  return QT_SHORT;
}

/**
 * 从任意层级的返回值里找出题目数组（questions / data / data.questions / 顶层数组 / 单题对象 / {1:{…}}）。
 * @param {unknown} value
 * @param {number} [depth] 递归深度保护
 * @returns {unknown[]|null}
 */
export function unwrapQuestions(value, depth = 0) {
  if (depth > 4) return null;
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return null;

  for (const key of ['questions', 'data', 'items', 'list', 'result', 'questionList', 'question_list']) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const inner = value[key];
    if (Array.isArray(inner)) return inner;
    if (inner && typeof inner === 'object') {
      const nested = unwrapQuestions(inner, depth + 1);
      if (nested) return nested;
      const values = Object.values(inner);
      if (values.length && values.every((v) => v && typeof v === 'object' && !Array.isArray(v))) return values;
    }
  }
  if (typeof value.stem === 'string' || typeof value.question === 'string' || typeof value.title === 'string') {
    return [value];
  }
  return null;
}

/** 去掉答案文本的「答案：」「正确答案是」等前缀 */
function stripAnswerPrefix(text) {
  return String(text === null || text === undefined ? '' : text)
    .replace(/^\s*(?:参考|正确|标准|参考正确)?\s*答\s*案\s*[:：是为]*\s*/, '')
    .replace(/^\s*(?:选项|选择)\s*[:：]?\s*/, '')
    .trim();
}

/**
 * 解析模型返回的 JSON 文本 → 题目数组（题目已用 models.makeQuestion 规范化）。
 *
 * 健壮性：容忍 ```json 围栏、前后废话、中文全角标点、questions/data/顶层数组等形态；
 * 单题字段缺失只跳过这一条并计入 errors，**不会**整体失败；按 qid 在本批内去重。
 *
 * @param {string} rawText 模型返回的原始文本
 * @returns {{questions:object[], errors:string[]}}
 */
export function parseAiQuestions(rawText) {
  const errors = [];
  const questions = [];
  const text = String(rawText === null || rawText === undefined ? '' : rawText).trim();
  if (!text) return { questions, errors: ['模型返回内容为空'] };

  const jsonText = extractJsonText(text);
  const parsed = tryParseJson(jsonText);
  if (!parsed.ok) {
    errors.push(`模型返回的不是合法 JSON（原文前 200 字）：${text.slice(0, 200).replace(/\s+/g, ' ')}`);
    return { questions, errors };
  }

  const list = unwrapQuestions(parsed.value);
  if (!list) {
    errors.push('返回的 JSON 里没有找到题目数组（期望形如 {"questions":[...]}）。');
    return { questions, errors };
  }

  const seen = new Set();
  list.forEach((item, index) => {
    const n = index + 1;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`第 ${n} 条不是题目对象，已跳过`);
      return;
    }

    const stem = firstString(item.stem, item.question, item.title, item.content, item.text);
    if (!stem) {
      errors.push(`第 ${n} 条缺少题干，已跳过`);
      return;
    }

    const options = normalizeOptions(
      item.options !== undefined
        ? item.options
        : item.choices !== undefined
          ? item.choices
          : item.option !== undefined
            ? item.option
            : item.options_list,
    );
    const rawAnswer = firstString(
      item.answer,
      item.correct,
      item.correctAnswer,
      item.correct_answer,
      item.key,
      item.answers,
    );
    let answer = stripAnswerPrefix(rawAnswer);
    const qtype = normalizeAiType(firstString(item.qtype, item.type, item.questionType, item.question_type), options, answer);

    if (qtype === QT_JUDGE) {
      const byLetter = options[normalizeChoice(answer)] || '';
      answer = normalizeJudge(answer) || normalizeJudge(byLetter) || answer;
    } else if (qtype === QT_SINGLE || qtype === QT_MULTI) {
      answer = normalizeChoice(answer) || answer;
    }

    const explanation = firstString(item.explanation, item.analysis, item.parse, item.reason, item.comment);
    const q = makeQuestion({ stem, qtype, options, answer, explanation, raw: stem });

    // 大模型常把判断题写成「单选 + 无选项 + 答案正确」——按判断题收下更合理
    if ((q.qtype === QT_SINGLE || q.qtype === QT_MULTI) && Object.keys(q.options || {}).length < 2) {
      const judge = normalizeJudge(q.answer);
      if (judge) {
        q.qtype = QT_JUDGE;
        q.answer = judge;
        q.options = {};
      }
    }

    if (!q.stem) {
      errors.push(`第 ${n} 条题干为空，已跳过`);
      return;
    }
    if (seen.has(q.qid)) {
      errors.push(`第 ${n} 条与前面的题目重复，已跳过`);
      return;
    }
    seen.add(q.qid);
    questions.push(q);
  });

  return { questions, errors };
}

/* ------------------------------------------------------------------ *
 * 网络层
 * ------------------------------------------------------------------ */

/** 是否运行在 Capacitor 原生壳里（安卓 App） */
function isNativePlatform() {
  try {
    if (globalThis.Capacitor && typeof globalThis.Capacitor.isNativePlatform === 'function') {
      if (globalThis.Capacitor.isNativePlatform()) return true;
    }
  } catch {
    /* 忽略 */
  }
  try {
    const loc = globalThis.location;
    return !!loc && loc.protocol === 'https:' && loc.hostname === 'localhost';
  } catch {
    return false;
  }
}

/** CapacitorHttp 的加载缓存（非原生环境直接返回 null） */
let capacitorHttpPromise = null;

/**
 * 取 CapacitorHttp（**只做显式调用，不开全局补丁**）。
 *
 * 【踩坑记录】不能只写 `import('@capacitor/core')`：本项目是**没有打包器的静态网页**，
 * 浏览器不认裸模块名 `@capacitor/core`，这个 import 必然失败 → 退回 fetch → 被 CORS 拦
 * → 请求一直挂到超时（用户实测「第 1/6 块 …… 请求超时（超过 60 秒）」就是这个原因）。
 * 正确姿势：Capacitor 会把运行时和已注册插件注入到 `window.Capacitor`
 * （Android 侧 `Bridge.registerPlugin(CapacitorHttp.class)` 已确认注册），
 * 直接从全局对象取即可；npm 包那条路只作为有打包器时的兜底。
 * @returns {Promise<any|null>}
 */
async function loadCapacitorHttp() {
  // ① 原生壳注入的全局对象（APK 里走这条）
  try {
    const cap = globalThis.Capacitor;
    if (cap) {
      const direct = (cap.Plugins && cap.Plugins.CapacitorHttp) || cap.CapacitorHttp;
      if (direct && typeof direct.post === 'function') return direct;
      // ② 运行时没预先注册时，用它的 registerPlugin 显式创建一个转发到原生的代理
      if (typeof cap.registerPlugin === 'function') {
        try {
          const proxy = cap.registerPlugin('CapacitorHttp');
          if (proxy && typeof proxy.post === 'function') return proxy;
        } catch (err) {
          console.warn('[ai] registerPlugin("CapacitorHttp") 失败：', err);
        }
      }
    }
  } catch (err) {
    console.warn('[ai] 读取全局 CapacitorHttp 失败：', err);
  }

  // ③ 兜底：打包环境才可能解析的 npm 包（静态页面里会失败，失败就返回 null）
  if (!isNativePlatform()) return null;
  if (!capacitorHttpPromise) {
    capacitorHttpPromise = import(/* webpackIgnore: true */ '@capacitor/core')
      .then((mod) => (mod && mod.CapacitorHttp) || null)
      .catch((err) => {
        console.warn('[ai] 加载 @capacitor/core 失败（静态页面里属正常），改用 fetch：', err);
        return null;
      });
  }
  return capacitorHttpPromise;
}

/**
 * 供「机器自检」页使用：当前 AI 请求会走哪条通道、能不能用。
 * @returns {Promise<{ok:boolean, detail:string}>}
 */
export async function aiNetworkDiagnostic() {
  const native = isNativePlatform();
  const cap = globalThis.Capacitor || null;
  const plugin = cap && ((cap.Plugins && cap.Plugins.CapacitorHttp) || cap.CapacitorHttp);
  const http = await loadCapacitorHttp();
  if (http) {
    return { ok: true, detail: `原生通道可用（CapacitorHttp${plugin ? '（全局插件）' : '（registerPlugin 代理）'}）` };
  }
  if (native) {
    return {
      ok: false,
      detail: `原生壳里取不到 CapacitorHttp（window.Capacitor=${!!cap}），AI 请求会被跨域限制拦住`,
    };
  }
  return { ok: true, detail: '浏览器环境，使用 fetch（可能受服务商 CORS 限制）' };
}

/** 超时错误（中文文案固定，UI 直接展示） */
function timeoutError(ms) {
  return new AiError(`请求超时（超过 ${Math.round(ms / 1000)} 秒），请检查网络或用更小的分块。`, 'timeout');
}

/**
 * 给 promise 加超时（超时用业务错误，而不是裸的 TimeoutError）。
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T>}
 */
function raceWithTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(timeoutError(ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * 从服务商返回体里抠出「人话」的错误说明。
 * @param {unknown} detail
 * @returns {string}
 */
export function detailTextOf(detail) {
  if (!detail) return '';
  if (typeof detail === 'string') return detail.trim().slice(0, 200);
  if (typeof detail === 'object') {
    const err = detail.error;
    if (err && typeof err === 'object' && err.message) return String(err.message).slice(0, 200);
    if (typeof err === 'string') return err.slice(0, 200);
    if (typeof detail.message === 'string') return detail.message.slice(0, 200);
    try {
      return JSON.stringify(detail).slice(0, 200);
    } catch {
      return '';
    }
  }
  return String(detail).slice(0, 200);
}

/**
 * HTTP 状态码 → 中文 AiError。
 * @param {number} status
 * @param {unknown} [detail] 服务商原文（对象或字符串）
 * @returns {AiError}
 */
export function aiErrorFromHttp(status, detail = '') {
  const code =
    status === 401 || status === 403
      ? 'auth'
      : status === 429
        ? 'rate'
        : status === 408 || status === 504
          ? 'timeout'
          : status >= 500
            ? 'server'
            : 'bad_request';

  const text = detailTextOf(detail);
  const tail = text ? `（服务商说明：${text.slice(0, 120)}）` : '';
  let message;
  if (code === 'auth') message = `API Key 无效或没有权限${tail}`;
  else if (code === 'rate') message = `请求太频繁/额度用尽${tail}`;
  else if (code === 'timeout') message = `请求超时，请检查网络或用更小的分块${tail}`;
  else message = `AI 接口返回错误（HTTP ${status}）${tail}`;
  return new AiError(message, code, text);
}

/**
 * 解析返回体文本：不是 JSON 就把原文前 200 字带出来。
 * @param {string} text
 * @returns {any}
 */
export function parseResponseText(text) {
  const raw = String(text === null || text === undefined ? '' : text);
  if (!raw.trim()) throw new AiError('AI 接口返回了空内容，请稍后重试。', 'bad_response', '');
  try {
    return JSON.parse(raw);
  } catch {
    throw new AiError(
      `AI 接口返回的不是 JSON（原文前 200 字）：${raw.slice(0, 200).replace(/\s+/g, ' ')}`,
      'bad_response',
      raw.slice(0, 200),
    );
  }
}

/**
 * 把 CapacitorHttp 的 data（可能是对象，也可能是 JSON 字符串）统一成对象。
 * @param {unknown} data
 * @returns {any}
 */
function normalizeBody(data) {
  if (typeof data === 'string') return parseResponseText(data);
  if (data && typeof data === 'object') return data;
  throw new AiError('AI 接口返回了无法解析的内容。', 'bad_response', String(data === undefined ? '' : data));
}

/**
 * 组装一次请求的 payload（URL / 请求头 / 请求体）。
 * requestFn 收到的就是这个对象；测试里可以直接检查 payload.messages。
 * @param {{settings?:object, messages:object[], signal?:AbortSignal, temperature?:number, timeoutMs?:number, maxTokens?:number}} opts
 * @returns {{url:string, headers:object, body:object, messages:object[], model:string, provider:string, timeoutMs:number, signal:AbortSignal|null}}
 */
export function buildRequest({ settings, messages, signal = null, temperature = 0.1, timeoutMs = AI_TIMEOUT_MS, maxTokens = 0 } = {}) {
  const s = settings || loadAiSettings();
  const base = String(s.baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) {
    throw new AiError('还没有填写接口地址（Base URL），请先到「AI 识别设置」里配置。', 'nokey');
  }
  if (!String(s.model || '').trim()) {
    throw new AiError('还没有填写模型名，请先到「AI 识别设置」里配置。', 'nokey');
  }
  const url = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
  const body = {
    model: String(s.model).trim(),
    messages,
    temperature,
    response_format: { type: 'json_object' },
  };
  if (Number(maxTokens) > 0) body.max_tokens = Math.trunc(Number(maxTokens));

  return {
    url,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${String(s.apiKey || '').trim()}`,
    },
    body,
    messages,
    model: body.model,
    provider: String(s.provider || ''),
    timeoutMs: Number(timeoutMs) > 0 ? Number(timeoutMs) : AI_TIMEOUT_MS,
    signal,
  };
}

/**
 * 发一次请求（不重试、不改请求体）。
 * @param {object} payload buildRequest 的产物
 * @param {object} body 请求体（可能与 payload.body 不同：去掉 response_format 的版本）
 * @returns {Promise<any>} 解析后的返回体
 */
async function sendOnce(payload, body) {
  const url = payload.url;
  const timeoutMs = payload.timeoutMs;
  const signal = payload.signal || null;
  if (signal && signal.aborted) throw new AiError('识别已取消。', 'aborted');

  const CapacitorHttp = await loadCapacitorHttp();
  if (!CapacitorHttp && isNativePlatform()) {
    // 原生壳里拿不到原生网络通道 → 退回 fetch 会被 CORS 拦成"一直超时"，
    // 与其让用户白等，不如立刻说清楚（这条以前是静默降级，害用户等了 60 秒 × 好几块）
    throw new AiError(
      'APP 内的原生网络通道不可用（取不到 CapacitorHttp），直连 AI 服务商会被跨域限制拦住。' +
        '请把这条信息发给开发者；也可以先用「导入新题库」走本地规则解析。',
      'noplugin',
    );
  }
  if (CapacitorHttp) {
    let res;
    try {
      res = await raceWithTimeout(
        CapacitorHttp.post({
          url,
          headers: payload.headers,
          data: body,
          connectTimeout: timeoutMs,
          readTimeout: timeoutMs,
        }),
        timeoutMs,
      );
    } catch (err) {
      if (err instanceof AiError) throw err;
      throw new AiError(
        `网络请求失败：${msgOf(err)}。请检查手机网络与接口地址是否正确（个别服务商需要代理）。`,
        'network',
      );
    }
    const status = Number(res && res.status) || 0;
    if (status < 200 || status >= 300) throw aiErrorFromHttp(status, res && res.data);
    return normalizeBody(res && res.data);
  }

  // 浏览器 / Node：用 fetch（注意用独立的 AbortController，避免污染调用方的 signal）
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  if (controller && signal && typeof signal.addEventListener === 'function') {
    signal.addEventListener('abort', () => {
      try {
        controller.abort();
      } catch {
        /* 忽略 */
      }
    }, { once: true });
  }

  let response;
  try {
    response = await raceWithTimeout(
      fetch(url, {
        method: 'POST',
        headers: payload.headers,
        body: JSON.stringify(body),
        signal: controller ? controller.signal : undefined,
      }),
      timeoutMs,
    );
  } catch (err) {
    if (err instanceof AiError) throw err;
    if (signal && signal.aborted) throw new AiError('识别已取消。', 'aborted');
    throw new AiError(
      `网络请求失败：${msgOf(err)}。请检查手机网络与接口地址是否正确（个别服务商需要代理）。`,
      'network',
    );
  }

  const text = await response.text();
  if (!response.ok) throw aiErrorFromHttp(response.status, text);
  return parseResponseText(text);
}

/**
 * 默认网络层：原生（Capacitor）走 CapacitorHttp 绕开 CORS，浏览器走 fetch。
 * 若服务商不支持 `response_format: json_object`（返回 400），去掉该参数再试一次。
 * @param {object} payload buildRequest 的产物
 * @returns {Promise<any>} 服务商返回体（已 JSON 化）
 */
export async function defaultRequest(payload) {
  const body = { ...(payload && payload.body ? payload.body : {}) };
  try {
    return await sendOnce(payload, body);
  } catch (err) {
    if (body.response_format && err instanceof AiError && err.code === 'bad_request') {
      console.warn('[ai] 该服务商可能不支持 response_format，去掉该参数重试一次');
      const retryBody = { ...body };
      delete retryBody.response_format;
      return await sendOnce(payload, retryBody);
    }
    throw err;
  }
}

/**
 * 从返回体里取正文（兼容 OpenAI 标准结构、CapacitorHttp 包装、纯文本、多模态分段）。
 * @param {unknown} response
 * @returns {string}
 */
export function extractMessageContent(response) {
  const pick = (value) => {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object') return '';
    if (Array.isArray(value.choices) && value.choices.length) {
      const first = value.choices[0] || {};
      const message = first.message || {};
      const content = message.content !== undefined ? message.content : first.text;
      if (Array.isArray(content)) return content.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('');
      if (content !== undefined && content !== null) return String(content);
      if (first.delta && typeof first.delta.content === 'string') return first.delta.content;
      return '';
    }
    if (typeof value.content === 'string') return value.content;
    if (typeof value.output_text === 'string') return value.output_text;
    return '';
  };

  if (typeof response === 'string') return response;
  if (!response || typeof response !== 'object') return '';
  if (Array.isArray(response.choices)) return pick(response);

  // CapacitorHttp 的 {status, data} 包装
  if (Object.prototype.hasOwnProperty.call(response, 'data')) {
    const data = response.data;
    if (typeof data === 'string') {
      try {
        return pick(JSON.parse(data));
      } catch {
        return data;
      }
    }
    return pick(data);
  }
  return pick(response);
}

/**
 * 取返回体里的 token 用量（没有就返回 0）。
 * @param {unknown} response
 * @returns {{prompt:number, completion:number}}
 */
export function usageOf(response) {
  let body = response;
  if (body && typeof body === 'object' && !Array.isArray(body.choices) && body.data && typeof body.data === 'object') {
    body = body.data;
  }
  const usage = body && typeof body === 'object' ? body.usage : null;
  if (!usage || typeof usage !== 'object') return { prompt: 0, completion: 0 };
  return {
    prompt: Number(usage.prompt_tokens) || 0,
    completion: Number(usage.completion_tokens) || 0,
  };
}

/* ------------------------------------------------------------------ *
 * 识别主流程
 * ------------------------------------------------------------------ */

/**
 * 识别文本行里的题目（分块串行请求，带进度回调与失败重试）。
 *
 * @param {Array<string|{text:string}>} lines 文本行（extract.js 的产物）
 * @param {object} [opts]
 * @param {object} [opts.settings] AI 设置，默认 loadAiSettings()
 * @param {(info:object)=>void} [opts.onProgress] 进度回调
 *        info = { stage:'start'|'retry'|'ok'|'fail'|'done', index, total, from, to, done, failed, questions, attempt?, retries?, message? }
 * @param {AbortSignal} [opts.signal] 取消信号
 * @param {(payload:object)=>Promise<any>} [opts.requestFn] 网络层注入点（单测用），默认 defaultRequest
 * @param {number} [opts.retries=2] 每块最多重试几次（总尝试次数 = retries + 1）
 * @param {number} [opts.retryDelayMs=500] 重试前的等待（第 n 次重试等 n × delay）
 * @param {number} [opts.chunkChars] 覆盖设置里的分块字符数
 * @param {string} [opts.typeHint] 追加在提示词里的题型/风格要求
 * @returns {Promise<{questions:object[], chunks:{total:number,done:number,failed:number}, errors:string[], usage:{prompt:number,completion:number}}>}
 */
export async function recognizeQuestions(lines, opts = {}) {
  const settings = opts.settings || loadAiSettings();
  const requestFn = typeof opts.requestFn === 'function' ? opts.requestFn : defaultRequest;
  const retries = Math.max(0, Math.trunc(Number.isFinite(Number(opts.retries)) ? Number(opts.retries) : 2));
  const retryDelayMs = Math.max(0, Number.isFinite(Number(opts.retryDelayMs)) ? Number(opts.retryDelayMs) : 500);
  const maxChars = Number(opts.chunkChars) > 0 ? Number(opts.chunkChars) : Number(settings.chunkChars) || DEFAULT_CHUNK_CHARS;
  const chunks = chunkLines(lines, { maxChars });
  const signal = opts.signal || null;

  /** @type {{questions:object[], chunks:{total:number,done:number,failed:number}, errors:string[], usage:{prompt:number,completion:number}}} */
  const out = {
    questions: [],
    chunks: { total: chunks.length, done: 0, failed: 0 },
    errors: [],
    usage: { prompt: 0, completion: 0 },
  };

  /** 进度上报：回调抛错不影响主流程 */
  const report = (info) => {
    if (typeof opts.onProgress !== 'function') return;
    try {
      opts.onProgress(info);
    } catch (err) {
      console.warn('[ai] onProgress 回调出错（已忽略）：', err);
    }
  };
  const aborted = () => !!(signal && signal.aborted);

  if (!chunks.length) {
    report({ stage: 'done', index: 0, total: 0, done: 0, failed: 0, questions: 0 });
    return out;
  }

  // 开跑前先探一次连通性（用很小的请求 + 短超时）：
  // 网络不通 / Key 不对 / 模型名不存在时立刻报错，别让用户对着「第 1/6 块 超时」等下去。
  if (opts.preflight !== false && chunks.length > 1 && typeof opts.requestFn !== 'function') {
    report({ stage: 'preflight' });
    const probe = await testAiConnection(settings, { timeoutMs: 20000 });
    if (!probe.ok) {
      out.chunks.failed = chunks.length;
      out.errors.push(`连通性检查未通过：${probe.message}`);
      report({ stage: 'done', index: 0, total: chunks.length, done: 0, failed: chunks.length, questions: 0 });
      return out;
    }
  }

  if (!isAiConfigured(settings)) {
    out.errors.push('还没有配置 AI：缺少 API Key / 接口地址 / 模型名，请先到「设置 → AI 识别设置」里填写。');
    report({ stage: 'fail', index: 0, total: chunks.length, done: 0, failed: 0, questions: 0, message: out.errors[0] });
    return out;
  }

  const seen = new Set();

  for (let i = 0; i < chunks.length; i += 1) {
    if (aborted()) {
      out.errors.push(`已取消：还剩 ${chunks.length - i} 块没有识别。`);
      break;
    }
    const chunk = chunks[i];
    const baseInfo = {
      index: i + 1,
      total: chunks.length,
      from: chunk.from,
      to: chunk.to,
      done: out.chunks.done,
      failed: out.chunks.failed,
      questions: out.questions.length,
    };
    report({ ...baseInfo, stage: 'start' });

    let ok = false;
    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (aborted()) {
        lastError = new AiError('识别已取消。', 'aborted');
        break;
      }
      if (attempt > 0 && retryDelayMs > 0) await delay(retryDelayMs * attempt);
      try {
        const payload = buildRequest({
          settings,
          messages: buildMessages(chunk.text, { typeHint: opts.typeHint }),
          signal,
        });
        const response = await requestFn(payload);

        const usage = usageOf(response);
        out.usage.prompt += usage.prompt;
        out.usage.completion += usage.completion;

        const content = extractMessageContent(response);
        if (!String(content || '').trim()) {
          throw new AiError('模型没有返回任何内容，可能是分块太大或该模型不支持接口格式。', 'empty');
        }
        const parsed = parseAiQuestions(content);
        if (!parsed.questions.length && parsed.errors.length) {
          throw new AiError(parsed.errors[0], 'bad_response', content.slice(0, 200));
        }

        for (const q of parsed.questions) {
          if (seen.has(q.qid)) continue;
          seen.add(q.qid);
          out.questions.push(q);
        }
        for (const e of parsed.errors) out.errors.push(`第 ${i + 1}/${chunks.length} 块：${e}`);
        ok = true;
        break;
      } catch (err) {
        lastError = err;
        const code = err && err.code;
        // 配置/权限类错误重试没有意义
        if (code === 'auth' || code === 'nokey' || code === 'aborted') break;
        if (attempt < retries) {
          report({ ...baseInfo, stage: 'retry', attempt: attempt + 1, retries, message: msgOf(err) });
        }
      }
    }

    if (ok) {
      out.chunks.done += 1;
      report({ ...baseInfo, stage: 'ok', done: out.chunks.done, questions: out.questions.length });
      continue;
    }

    out.chunks.failed += 1;
    out.errors.push(`第 ${i + 1}/${chunks.length} 块识别失败：${msgOf(lastError)}`);
    report({ ...baseInfo, stage: 'fail', failed: out.chunks.failed, message: msgOf(lastError) });

    // Key/配置不对时后面的块必然也失败，直接停下，别浪费用户额度
    const code = lastError && lastError.code;
    if (code === 'auth' || code === 'nokey') {
      const rest = chunks.length - (i + 1);
      if (rest > 0) {
        out.chunks.failed += rest;
        out.errors.push(`已停止后续 ${rest} 块的识别（先修正 API Key / 接口配置再试）。`);
      }
      break;
    }

    // 一块都没成功就卡在第一块上（网络不通 / 超时 / 服务商拒绝）→ 再往下试也是白等，
    // 直接把错误交给用户（以前会 8 块 × 3 次 × 60 秒地磨，看起来像卡死）
    if (out.chunks.done === 0) {
      const rest = chunks.length - (i + 1);
      if (rest > 0) {
        out.chunks.failed += rest;
        out.errors.push(
          `第 1 块就没成功（${msgOf(lastError)}），已停止后续 ${rest} 块。` +
            '建议先到「AI 识别设置」点「测试连接」确认配置与网络。',
        );
      }
      break;
    }
  }

  report({
    stage: 'done',
    index: chunks.length,
    total: chunks.length,
    done: out.chunks.done,
    failed: out.chunks.failed,
    questions: out.questions.length,
  });
  return out;
}

/**
 * 用 AI 为一道题生成「讲解」（解析）。
 *
 * 场景：不少题库文件只写了「正确答案：A」，没有解析段落；答错时界面只能显示答案。
 * 这个函数让用户按需用 AI 生成一段简明讲解（生成后由调用方缓存进题库/错题本）。
 * **不抛异常**，统一返回结果对象。
 *
 * @param {object} question Question 对象（至少要有 stem；有 options/answer 更好）
 * @param {{settings?:object, requestFn?:Function, signal?:AbortSignal, timeoutMs?:number}} [opts]
 * @returns {Promise<{ok:boolean, explanation:string, message:string, cached:boolean}>}
 */
export async function explainQuestion(question, opts = {}) {
  const q = question || {};
  const existing = String(q.explanation || '').trim();
  if (existing) {
    // 已经有解析就不发请求，省额度
    return { ok: true, explanation: existing, message: '', cached: true };
  }

  const s = opts.settings || loadAiSettings();
  const fail = (message) => ({ ok: false, explanation: '', message: String(message), cached: false });

  if (!String(q.stem || '').trim()) return fail('这道题没有题干，无法生成讲解。');
  if (!String(s.apiKey || '').trim()) return fail('还没有配置 AI：请到「设置 → AI 识别设置」填写 API Key。');
  if (!String(s.baseUrl || '').trim() || !String(s.model || '').trim()) {
    return fail('AI 配置不完整：请到「设置 → AI 识别设置」补全接口地址与模型名。');
  }

  // 把题目内容整理成给模型看的文本
  const optionLines = Object.entries(q.options || {})
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    .map(([k, v]) => `${k}. ${v}`)
    .join('\n');
  const qtype = String(q.qtype || '');
  const userText = [
    `题型：${qtype}题`,
    `题干：${q.stem}`,
    optionLines ? `选项：\n${optionLines}` : '',
    q.answer ? `正确答案：${q.answer}` : '',
    '请只依据上面给出的题干与选项讲解，不要编造题干里没有的事实。',
  ]
    .filter(Boolean)
    .join('\n');

  const requestFn = typeof opts.requestFn === 'function' ? opts.requestFn : defaultRequest;
  try {
    const payload = buildRequest({
      settings: s,
      messages: [
        {
          role: 'system',
          content:
            '你是中国考试辅导老师。请用简明中文讲解这道题，要求：\n' +
            '1) 说清为什么正确答案成立；\n' +
            '2) 简要指出其他选项（或常见易错点）为什么不对；\n' +
            '3) 总字数不超过 120 字，不要用 Markdown 标题、不要说"根据题目"之类的废话；\n' +
            '4) 严格输出 JSON：{"explanation":"讲解内容"}，不要输出其它文字。',
        },
        { role: 'user', content: userText },
      ],
      signal: opts.signal || null,
      temperature: 0.2,
      maxTokens: 400,
      timeoutMs: Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : AI_TIMEOUT_MS,
    });
    const response = await requestFn(payload);
    const content = extractMessageContent(response);
    const text = pickExplanation(content);
    if (!text) {
      return fail('模型没有返回可用的讲解内容，可以再试一次或换一个模型。');
    }
    return { ok: true, explanation: text, message: '', cached: false };
  } catch (err) {
    return fail(msgOf(err));
  }
}

/**
 * 从模型回复里取出讲解文本（容忍 ```json 围栏 / 前后废话 / 直接给纯文本）。
 * @param {string} raw
 * @returns {string}
 */
function pickExplanation(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  // 先按 JSON 取
  let jsonText = text;
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) jsonText = fence[1].trim();
  const start = jsonText.indexOf('{');
  const end = jsonText.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(jsonText.slice(start, end + 1));
      const value = obj && (obj.explanation || obj.analysis || obj.text);
      if (typeof value === 'string' && value.trim()) return cleanExplanation(value);
    } catch {
      /* 落回纯文本 */
    }
  }
  // 不是 JSON 就把围栏/引号剥掉直接用
  return cleanExplanation(text.replace(/```[a-z]*|```/gi, '').replace(/^["'\s]+|["'\s]+$/g, ''));
}

/**
 * 清洗讲解文本：去多余空白、去掉模型爱加的“解析：”前缀、限长。
 * @param {string} value
 * @returns {string}
 */
function cleanExplanation(value) {
  let s = String(value || '').replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  s = s.replace(/^(解析|讲解|答案解析)\s*[:：]\s*/, '');
  if (s.length > 300) s = `${s.slice(0, 300)}…`;
  return s;
}

/**
 * 测试连接：发一条极短请求，验证 Key / 地址 / 模型名是否可用。
 * **不抛异常**，统一返回结果对象，方便 UI 直接展示。
 * @param {object} [settings] AI 设置，默认 loadAiSettings()
 * @param {{requestFn?:Function, signal?:AbortSignal}} [opts]
 * @returns {Promise<{ok:boolean, message:string, model:string, code:string, elapsedMs:number}>}
 */
export async function testAiConnection(settings, opts = {}) {
  const s = settings || loadAiSettings();
  const started = Date.now();
  const fail = (message, code = 'unknown') => ({
    ok: false,
    message: String(message),
    model: String(s.model || ''),
    code,
    elapsedMs: Date.now() - started,
  });

  if (!String(s.apiKey || '').trim()) return fail('请先填写 API Key。', 'nokey');
  if (!String(s.baseUrl || '').trim()) return fail('请先填写接口地址（Base URL）。', 'nokey');
  if (!String(s.model || '').trim()) return fail('请先填写模型名。', 'nokey');

  const requestFn = typeof opts.requestFn === 'function' ? opts.requestFn : defaultRequest;
  try {
    const payload = buildRequest({
      settings: s,
      messages: [
        { role: 'system', content: '你是连通性测试端点，只输出 JSON。' },
        { role: 'user', content: '连通性测试：请只回复 JSON {"ok":true}，不要输出其它内容。' },
      ],
      signal: opts.signal || null,
      temperature: 0,
      maxTokens: 32,
      // 允许调用方用更短的超时（开跑前的连通性探测走 20 秒，别让用户干等）
      timeoutMs: Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : AI_TIMEOUT_MS,
    });
    const response = await requestFn(payload);
    const content = extractMessageContent(response).trim();
    return {
      ok: true,
      message: content ? `连接成功（模型回复：${content.slice(0, 40)}）` : '连接成功',
      model: String(s.model),
      code: 'ok',
      elapsedMs: Date.now() - started,
    };
  } catch (err) {
    return fail(msgOf(err), (err && err.code) || 'unknown');
  }
}
