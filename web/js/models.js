/**
 * 题目模型：题型常量、答案归一化与判定、年份/知识点提取。
 * Question 是普通对象（可直接存 IndexedDB），本模块全部为纯函数。
 */

export const QT_SINGLE = '单选';
export const QT_MULTI = '多选';
export const QT_JUDGE = '判断';
export const QT_SHORT = '简答';
export const QT_ESSAY = '论述';

/** 题型顺序 */
export const QUESTION_TYPES = [QT_SINGLE, QT_MULTI, QT_JUDGE, QT_SHORT, QT_ESSAY];
export const TYPE_ORDER = Object.fromEntries(QUESTION_TYPES.map((t, i) => [t, i]));

/** 主观题（无标准答案，由用户自评） */
export const SUBJECTIVE_TYPES = [QT_SHORT, QT_ESSAY];

export const SOURCE_AUTO = 'auto';
export const SOURCE_MANUAL = 'manual';

export const OPTION_LETTERS = 'ABCDEFGHIJ';

/** 去除空白与标点，用于题干去重 */
const STRIP_RE = /[\s\u3000，。、,.;；:：（）()【】\[\]「」『』？?！!·\-—_]+/g;
const YEAR_RE = /(?<!\d)((?:19|20)\d{2})(?!\d)/;
const TOPIC_RE = /[【\[]([^】\]]{1,20})[】\]]|（([^）]{1,10})）/;

const JUDGE_TRUE = new Set(['正确', '对', '是', 'T', 'TRUE', 'Y', 'YES', '√', '✓', 'V', '1', '对的', '正确的']);
const JUDGE_FALSE = new Set(['错误', '错', '否', '不对', '不是', 'F', 'FALSE', 'N', 'NO', '×', 'X', '✗', '0', '错的', '错误的']);

/* ------------------------------------------------------------------ SHA-1 */

/** UTF-8 编码 */
function utf8Bytes(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const c2 = str.charCodeAt(++i);
      const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
  }
  return out;
}

/**
 * 同步 SHA-1（浏览器与 Node 都可用，不依赖 crypto.subtle）。
 * @param {string} str
 * @returns {string} 40 位十六进制
 */
export function sha1Hex(str) {
  const msg = utf8Bytes(String(str));
  const len = msg.length;
  const total = Math.ceil((len + 9) / 64) * 64;
  const buf = new Uint8Array(total);
  buf.set(msg);
  buf[len] = 0x80;
  const view = new DataView(buf.buffer);
  const bitLen = len * 8;
  view.setUint32(total - 8, Math.floor(bitLen / 4294967296));
  view.setUint32(total - 4, bitLen >>> 0);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);

  for (let i = 0; i < total; i += 64) {
    for (let j = 0; j < 16; j++) w[j] = view.getUint32(i + j * 4);
    for (let j = 16; j < 80; j++) {
      const v = w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16];
      w[j] = ((v << 1) | (v >>> 31)) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let j = 0; j < 80; j++) {
      let f;
      let k;
      if (j < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (j < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (j < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const tmp = ((((a << 5) | (a >>> 27)) + f + e + k + w[j]) >>> 0);
      e = d;
      d = c;
      c = ((b << 30) | (b >>> 2)) >>> 0;
      b = a;
      a = tmp;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map((x) => x.toString(16).padStart(8, '0')).join('');
}

/* --------------------------------------------------------------- 归一化 */

/**
 * 题干归一化（去空白与标点），用于去重与生成 qid。
 * @param {string} stem
 * @returns {string}
 */
export function normalizeStem(stem) {
  return String(stem || '').replace(STRIP_RE, '');
}

/**
 * 生成题目唯一 id。
 * @param {string} stem
 * @param {Record<string,string>} [options]
 * @returns {string} 16 位十六进制
 */
export function makeQid(stem, options) {
  let base = normalizeStem(stem);
  if (!base && options) base = normalizeStem(Object.values(options).join(''));
  return sha1Hex(base).slice(0, 16);
}

/**
 * 判断题答案/输入 → '正确' | '错误' | ''
 * @param {string} raw
 * @returns {string}
 */
export function normalizeJudge(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const up = s.toUpperCase().replace(/\s+/g, '');
  if (JUDGE_TRUE.has(up) || JUDGE_TRUE.has(s)) return '正确';
  if (JUDGE_FALSE.has(up) || JUDGE_FALSE.has(s)) return '错误';
  return '';
}

/**
 * 选择题答案 → 去重升序大写字母，如 'ba' → 'AB'
 * @param {string} raw
 * @returns {string}
 */
export function normalizeChoice(raw) {
  const letters = String(raw || '').toUpperCase().split('').filter((c) => OPTION_LETTERS.includes(c));
  const uniq = [...new Set(letters)];
  return uniq.sort((a, b) => OPTION_LETTERS.indexOf(a) - OPTION_LETTERS.indexOf(b)).join('');
}

/**
 * 提取题干年份（取最早出现的四位年份）。
 * @param {string} text
 * @returns {number|null}
 */
export function extractYear(text) {
  const m = YEAR_RE.exec(String(text || ''));
  const re = new RegExp(YEAR_RE.source, 'g');
  const all = [];
  let hit;
  while ((hit = re.exec(String(text || ''))) !== null) all.push(Number(hit[1]));
  if (m && all.length === 0) all.push(Number(m[1]));
  return all.length ? Math.min(...all) : null;
}

/**
 * 提取知识点：优先题干 【】 标记，其次中文括号主题词。
 * @param {string} text
 * @returns {string}
 */
export function extractTopic(text) {
  const m = TOPIC_RE.exec(String(text || ''));
  if (!m) return '';
  return (m[1] || m[2] || '').trim();
}

/* ---------------------------------------------------------------- 模型 */

/**
 * 规范化一道题（补全派生字段）。
 * @param {object} partial
 * @returns {object} Question
 */
export function makeQuestion(partial = {}) {
  const q = {
    qid: '',
    stem: String(partial.stem || '').trim(),
    qtype: partial.qtype && QUESTION_TYPES.includes(partial.qtype) ? partial.qtype : QT_SINGLE,
    options: {},
    answer: String(partial.answer || '').trim(),
    explanation: String(partial.explanation || '').trim(),
    source: partial.source === SOURCE_MANUAL ? SOURCE_MANUAL : SOURCE_AUTO,
    page: Number(partial.page) || 0,
    line: Number(partial.line) || 0,
    para: Number(partial.para) || 0,
    year: partial.year ?? null,
    topic: String(partial.topic || ''),
    raw: String(partial.raw || ''),
  };
  // 选项：只保留字母 A~J 的键，保持插入顺序
  const opts = partial.options || {};
  for (const key of Object.keys(opts)) {
    const letter = String(key).toUpperCase();
    if (OPTION_LETTERS.includes(letter) && String(opts[key] || '').trim()) {
      q.options[letter] = String(opts[key]).trim();
    }
  }
  if (q.qtype === QT_JUDGE) {
    // 判断题：答案可能是 正确/错误/√/×，也可能是 A/B —— 后者按选项文本映射
    let ans = normalizeJudge(q.answer);
    if (!ans && q.options[q.answer]) ans = normalizeJudge(q.options[q.answer]);
    q.answer = ans || q.answer;
  } else if (q.qtype === QT_SINGLE || q.qtype === QT_MULTI) {
    q.answer = normalizeChoice(q.answer) || q.answer;
  }
  if (!q.year) q.year = extractYear(q.stem);
  if (!q.topic) q.topic = extractTopic(q.stem);
  if (!q.qid) q.qid = makeQid(q.stem, q.options);
  if (!q.raw) q.raw = q.stem;
  return q;
}

/**
 * 选项按字母排序后的数组。
 * @param {object} q
 * @returns {[string,string][]}
 */
export function sortedOptions(q) {
  return Object.entries(q.options || {})
    .sort((a, b) => OPTION_LETTERS.indexOf(a[0]) - OPTION_LETTERS.indexOf(b[0]));
}

/**
 * 溯源位置描述。
 * @param {object} q
 * @returns {string}
 */
export function locationText(q) {
  if (q.page && q.line) return `第 ${q.page} 页第 ${q.line} 行`;
  if (q.page) return `第 ${q.page} 页`;
  if (q.para) return `第 ${q.para} 段`;
  if (q.line) return `第 ${q.line} 行`;
  return q.source === SOURCE_MANUAL ? '手动补录' : '位置未记录';
}

/**
 * 知识点（无主题词时退化为题型）。
 * @param {object} q
 * @returns {string}
 */
export function knowledgePoint(q) {
  return q.topic || q.qtype;
}

/**
 * 判断用户作答是否正确（主观题不走这里）。
 * @param {object} q
 * @param {string} userRaw
 * @returns {boolean}
 */
export function checkAnswer(q, userRaw) {
  const user = String(userRaw || '').trim();
  if (!user) return false;
  if (q.qtype === QT_JUDGE) {
    const norm = normalizeJudge(user);
    const target = normalizeJudge(q.answer) || q.answer;
    if (norm) return norm === target;
    // 判断题也可能给了 A/B 选项
    const letters = normalizeChoice(user);
    if (letters && q.options && Object.keys(q.options).length) {
      const mapped = q.options[letters] || '';
      return normalizeJudge(mapped) === target;
    }
    return false;
  }
  if (q.qtype === QT_SINGLE || q.qtype === QT_MULTI) {
    return normalizeChoice(user) === normalizeChoice(q.answer);
  }
  return user === q.answer;
}

/**
 * 校验并归一化输入。
 * @param {object} q
 * @param {string} raw
 * @returns {{ok: boolean, value: string}}
 */
export function validateInput(q, raw) {
  const s = String(raw || '').trim();
  if (!s) return { ok: false, value: '' };
  if (q.qtype === QT_JUDGE) {
    const norm = normalizeJudge(s);
    if (norm) return { ok: true, value: norm };
    const letters = normalizeChoice(s);
    if (letters && q.options[letters]) return { ok: true, value: letters };
    return { ok: false, value: '' };
  }
  if (q.qtype === QT_SINGLE || q.qtype === QT_MULTI) {
    const letters = normalizeChoice(s);
    if (!letters) return { ok: false, value: '' };
    const valid = Object.keys(q.options || {}).length ? Object.keys(q.options) : OPTION_LETTERS.split('');
    if (!letters.split('').every((c) => valid.includes(c))) return { ok: false, value: '' };
    if (q.qtype === QT_SINGLE && letters.length > 1) return { ok: false, value: '' };
    return { ok: true, value: letters };
  }
  return { ok: true, value: s };
}
