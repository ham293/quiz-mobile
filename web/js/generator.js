/**
 * generator.js —— 「知识点自动出题」核心逻辑（**纯规则、完全离线、不调用任何 AI 接口**）。
 *
 * 输入：用户上传/粘贴的知识点文本行（复用 extract.js 抽出的 `{page,line,para,text}` 行）。
 * 输出：填空 / 选择 / 判断题数组（每个都是 models.makeQuestion() 规范化后的 Question），
 *      每题都带参考答案与出处（原句）。
 *
 * 设计原则（见 docs/接口约定.md）：
 *   1. **纯函数、零依赖**：只 import ./models.js，不碰 window/document，可在 Node 下直接单测；
 *   2. **宁缺毋滥**：挖空、干扰项都有质量门槛，凑不出 3 个合适干扰项的选择题直接不生成；
 *   3. **可复现**：随机只用于「选项打乱」和「干扰项挑选」，全部走种子随机数（opts.seed），
 *      同一份输入 + 同一个 seed 必然得到完全相同的题目；
 *   4. **题型约定**：填空/选择都用 QT_SINGLE（题干含 `____`，练习页照常判对错），
 *      填空题的 options 只有正确项一项（`{A: 正确词}`、`answer:'A'`）；
 *      判断题用 QT_JUDGE（answer = '正确'/'错误'）。
 */

import { QT_JUDGE, QT_SINGLE, makeQuestion, normalizeStem } from './models.js';

/* ------------------------------------------------------------------ *
 * 题型常量
 * ------------------------------------------------------------------ */

/** 填空题 */
export const GEN_FILL = 'fill';
/** 选择题 */
export const GEN_CHOICE = 'choice';
/** 判断题 */
export const GEN_JUDGE = 'judge';

/** 全部题型（即默认值，顺序也是同分时的优先级） */
export const GEN_TYPES = [GEN_FILL, GEN_CHOICE, GEN_JUDGE];

/** 题型中文名 */
export const GEN_TYPE_LABELS = { fill: '填空', choice: '选择', judge: '判断' };

/* ------------------------------------------------------------------ *
 * 质量门槛常量
 * ------------------------------------------------------------------ */

/** 题干里表示空格占位的符号 */
const BLANK = '____';
/** 默认随机种子（固定值 → 默认完全可复现） */
const DEFAULT_SEED = 20240101;
/** 一句话至少多少个字才考虑出题（含标点，去空白后计） */
const MIN_SENTENCE_CHARS = 12;
/** 挖空之后，句子里剩下的字数至少要这么多，否则题目信息量不足 */
const MIN_REST_CHARS = 8;
/** 被挖词最大字数 */
const MAX_BLANK_CHARS = 12;
/** 被挖词最长不能超过整句长度的这个比例 */
const BLANK_MAX_RATIO = 0.4;
/** 选择题的选项个数（1 正确 + 3 干扰） */
const CHOICE_OPTION_COUNT = 4;
/** 干扰项与正确答案的字数差上限（第一优先级的同类干扰项） */
const DISTRACTOR_LEN_TOLERANCE = 3;
/** 重复出现这么多行、且短于阈值的文本，视为页眉页脚 */
const REPEAT_HEADER_MIN = 3;
const REPEAT_HEADER_MAX_CHARS = 30;

/** 知识点类别优先级：quote > term > name > number > en */
const KIND_PRIORITY = { quote: 4, term: 3, name: 2, number: 1, en: 0 };

/* ------------------------------------------------------------------ *
 * 噪声 / 标题识别
 * ------------------------------------------------------------------ */

/** 推广语（题库资料里常见，绝不该拿来出题） */
const PROMO_RE = /公众号|扫码|点击|关注|加群|欢迎订阅|微信搜|小红书/;
/** 「解析：」「答案：」这类答案行 */
const ANSWER_LINE_RE = /^(?:解析|答案|参考答案|答|解答|出处)\s*[:：]/;
/** 章节标题样式 */
const HEADING_PREFIX_RE =
  /^(?:第[一二三四五六七八九十百零\d]+[章节讲部分单元篇课]|[一二三四五六七八九十]+[、.．]|[（(][一二三四五六七八九十\d]+[)）]|[①②③④⑤⑥⑦⑧⑨⑩]|\d+[、.．])/;
/** 行首项目符号 / 编号 */
const BULLET_RE = /^[\s·•●○▪◦◆■□▶►※★☆*+>》」』\-–—~]+/;
/** 行首序号（1. / 一、/（2）/①）。后面紧跟数字或英文字母的不算（避免把「3.14」拆坏） */
const LEAD_NUMBERING_RE =
  /^(?:\d{1,3}[、.．)）]|[（(]\d{1,3}[)）]|[一二三四五六七八九十]+[、.．]|[（(][一二三四五六七八九十]+[)）]|[①②③④⑤⑥⑦⑧⑨⑩]+)(?=\s|[\u4e00-\u9fa5\u3000（）()《》“”【】]|$)/;
/** 判断句的特征词（判断题只挑含这些词或数字的句子） */
const JUDGE_HINT_RE = /[0-9]|是|不是|属于|不属于|必须|可以|有|没有/;
/** 断言句里「不能被改动」的位置（避免把「但是/凡是」改出病句） */
const COPULA_BLOCK_BEFORE = new Set(['但', '凡', '或', '若', '如', '是', '不', '要', '总', '就', '还', '也', '单']);

/* ------------------------------------------------------------------ *
 * 术语词典（可选的「边界矫正」小词典）
 * ------------------------------------------------------------------ */

/**
 * 常用术语小词典：中文没有空格，纯规则难以判断词边界
 * （例如「中国新民主主义革命」若只按后缀截取，可能截成「国新民主主义革命」）。
 * 命中词典时以词典为准，并优先于规则结果；词典之外仍由后缀规则兜底。
 */
const TERM_DICT = [...new Set([
  // 历史政治
  '太平天国运动', '五四运动', '辛亥革命', '新民主主义革命', '旧民主主义革命', '新文化运动',
  '洋务运动', '戊戌变法', '义和团运动', '北伐战争', '抗日战争', '鸦片战争', '甲午中日战争',
  '解放战争', '土地改革', '改革开放', '十一届三中全会', '一国两制', '社会主义', '资本主义',
  '帝国主义', '封建主义', '马克思主义', '列宁主义', '毛泽东思想', '邓小平理论',
  '三个代表重要思想', '科学发展观', '中国特色社会主义', '社会主义市场经济', '人民代表大会',
  '政治协商会议', '民族区域自治', '五年计划', '一带一路', '脱贫攻坚', '乡村振兴',
  '供给侧结构性改革', '共产主义', '无产阶级', '资产阶级', '生产力', '生产关系', '经济基础',
  '上层建筑', '唯物史观', '剩余价值学说', '实践是检验真理的唯一标准',
  // 条约 / 文件
  '南京条约', '辛丑条约', '马关条约', '北京条约', '天津条约', '人权宣言', '独立宣言',
  '共产党宣言', '联合国宪章', '中华人民共和国宪法',
  // 制度 / 文化
  '科举制度', '郡县制', '分封制', '宗法制', '井田制', '均田制', '三省六部制', '君主立宪制',
  '民主集中制', '儒家思想', '道家思想', '法家思想', '墨家思想', '白话文', '诗经', '楚辞',
  // 科技
  '光合作用', '细胞分裂', '生态系统', '能量守恒定律', '万有引力定律', '相对论', '量子力学',
  '元素周期律', '达尔文进化论', '血液循环', '免疫系统', '神经系统', '消化系统', '呼吸系统',
])];

/** 人名 / 地名 / 机构小词典（kind = 'name'） */
const NAME_DICT = [...new Set([
  '毛泽东', '周恩来', '邓小平', '朱德', '刘少奇', '孙中山', '李大钊', '陈独秀', '林则徐',
  '洪秀全', '康有为', '梁启超', '鲁迅', '胡适', '蔡元培', '李鸿章', '曾国藩', '蒋介石',
  '张学良', '袁隆平', '钱学森', '邓稼先', '华罗庚', '陈景润', '屠呦呦', '马克思', '恩格斯',
  '列宁', '斯大林', '华盛顿', '林肯', '罗斯福', '拿破仑', '牛顿', '爱因斯坦', '达尔文',
  '居里夫人', '爱迪生', '中国共产党', '国民党', '共青团', '联合国', '欧盟', '世界贸易组织',
  '中华人民共和国', '中国人民解放军', '中国科学院', '中国社会科学院',
  '北京大学', '清华大学', '复旦大学', '浙江大学', '国务院', '全国人民代表大会',
  '延安', '井冈山', '瑞金', '遵义', '南京', '广州', '武汉', '西安', '黄河', '长江',
])];

/* ------------------------------------------------------------------ *
 * 通用小工具
 * ------------------------------------------------------------------ */

/** 去掉空白后的文本（长度统计一律以它为准，避免「1851 年」被空格撑大） */
function compact(text) {
  return String(text == null ? '' : text).replace(/\s+/g, '');
}

/** 去空白后的长度 */
function compactLen(text) {
  return compact(text).length;
}

/** 归一化空白（全角空格、零宽字符一并处理） */
function normalizeWhitespace(text) {
  return String(text == null ? '' : text)
    .replace(/\uFEFF/g, '')
    .replace(/\u200B/g, '')
    .replace(/[\t\u3000]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/** 去掉行首项目符号与编号 */
function stripBullets(text) {
  let out = String(text || '');
  for (let i = 0; i < 3; i += 1) {
    const next = out.replace(BULLET_RE, '').replace(LEAD_NUMBERING_RE, '').trimStart();
    if (next === out) break;
    out = next;
  }
  return out.trim();
}

/** 是否是页码 / 页脚行 */
function looksLikePageNumber(text) {
  const t = compact(text);
  if (!t) return true;
  if (/^\d{1,4}$/.test(t)) return true;
  if (/^[-–—]?\s*\d{1,4}\s*[-–—]?$/.test(t)) return true;
  if (/^第\s*\d+\s*页(?:\s*[\/共]\s*\d+\s*页?)?$/.test(t)) return true;
  if (/^page\s*\d+(?:\s*(?:of|\/)\s*\d+)?$/i.test(t)) return true;
  if (/^\d+\s*\/\s*\d+$/.test(t)) return true;
  return false;
}

/** 是否是目录 / 纯符号行 */
function looksLikeTocLine(text) {
  const t = compact(text);
  if (!t) return true;
  if (/^[\d.、,，。()（）【】\-–—/=·…]+$/.test(t)) return true;
  if (/^(?:目录|目\s*录|contents)$/i.test(t)) return true;
  if (/\.{3,}\s*\d+$/.test(t)) return true; // 「第一章 …… 3」目录行
  return false;
}

/**
 * 是否像「标题行」（章节名、短标题）。
 * 标题不是句子，没有独立信息量，只用来给后续句子当 topic。
 * @param {string} text
 * @returns {boolean}
 */
function looksLikeHeading(text) {
  const raw = String(text || '').trim();
  const t = compact(stripBullets(raw));
  if (!t) return false;
  if (/[。！？；]$/.test(raw)) return false; // 以句末标点结尾 → 是句子
  if (HEADING_PREFIX_RE.test(raw.replace(BULLET_RE, '')) && t.length <= 24) return true;
  // 短标题：没有逗号等句子标点，也没有系动词/助词
  if (t.length <= 16 && !/[，,、：:；;]/.test(raw) && !/[是了在为的有会能与]/.test(t)) return true;
  return false;
}

/** 把标题行清成纯标题文本（去编号，截断到 20 字） */
function cleanHeading(text) {
  const t = stripBullets(String(text || '')).replace(HEADING_PREFIX_RE, '').trim();
  return compact(t).length > 20 ? t.slice(0, 20) : t;
}

/**
 * 是否是应当跳过的噪声句（短句、目录、页码、推广语、答案行、选项行…）。
 * @param {string} text
 * @returns {boolean}
 */
function isNoiseSentence(text) {
  const raw = String(text || '').trim();
  if (!raw) return true;
  if (compactLen(raw) < MIN_SENTENCE_CHARS) return true;
  if (looksLikeTocLine(raw) || looksLikePageNumber(raw)) return true;
  if (PROMO_RE.test(raw)) return true;
  if (ANSWER_LINE_RE.test(raw.replace(BULLET_RE, ''))) return true;
  if (/^[A-Da-d][.、)）]\s*[\u4e00-\u9fa5]/.test(raw)) return true; // 「A．选项内容」
  if (/^[（(]?\s*\d+\s*[)）]\s*[\u4e00-\u9fa5]/.test(raw) && compactLen(raw) < MIN_SENTENCE_CHARS + 2) return true;
  return false;
}

/* ------------------------------------------------------------------ *
 * 切句
 * ------------------------------------------------------------------ */

/**
 * 把一行文本按句末标点切成句子（保留句末标点，便于还原原句）。
 * @param {string} text
 * @returns {string[]}
 */
function splitLineIntoSentences(text) {
  const out = [];
  let buf = '';
  for (const ch of String(text || '')) {
    buf += ch;
    if (ch === '。' || ch === '！' || ch === '？' || ch === '；' || ch === '!' || ch === '?' || ch === ';') {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/**
 * 把文本行切成人话句子（去页眉页脚/页码/编号，按 。！？；\n 切分，去空白与项目符号）。
 *
 * 行结构（与 docs/接口约定.md 一致）：
 *   - 传 `{page,line,para,text}`：句子沿用来源行的三个位置字段；
 *   - 传字符串：位置字段一律 0（没有来源信息）。
 *
 * @param {Array<{page?:number,line?:number,para?:number,text:string}|string>} lines 文本行
 * @returns {Array<{text:string, page:number, line:number, para:number}>} 句子数组（保持原文顺序）
 */
export function splitSentences(lines) {
  const list = Array.isArray(lines) ? lines : [];
  const rows = [];

  for (const raw of list) {
    const item = typeof raw === 'string' ? { text: raw } : (raw || {});
    const text = stripBullets(normalizeWhitespace(item.text));
    if (!text) continue;
    rows.push({
      text,
      page: Number(item.page) || 0,
      line: Number(item.line) || 0,
      para: Number(item.para) || 0,
    });
  }

  // 页眉页脚：同一行文本重复出现 ≥3 次且较短 → 整行丢弃
  const freq = new Map();
  for (const row of rows) {
    const key = compact(row.text);
    freq.set(key, (freq.get(key) || 0) + 1);
  }

  const out = [];
  for (const row of rows) {
    const key = compact(row.text);
    if ((freq.get(key) || 0) >= REPEAT_HEADER_MIN && key.length <= REPEAT_HEADER_MAX_CHARS) continue;
    if (looksLikePageNumber(row.text)) continue;
    for (const piece of splitLineIntoSentences(row.text)) {
      if (!piece) continue;
      out.push({ text: piece, page: row.page, line: row.line, para: row.para });
    }
  }
  return out;
}

/**
 * 把整段文本按行拆成「文本行」（供粘贴文本入口复用，规则与 extract.js 的 txt 解析一致：
 * line 用真实行号，空行不产出）。
 * @param {string} rawText 多行文本
 * @returns {Array<{page:number,line:number,para:number,text:string}>}
 */
export function textToLines(rawText) {
  const out = [];
  const pieces = String(rawText == null ? '' : rawText).split(/\r\n|\r|\n/);
  let lineNo = 0;
  for (const piece of pieces) {
    lineNo += 1;
    const text = stripBullets(normalizeWhitespace(piece));
    if (!text) continue;
    out.push({ page: 0, line: lineNo, para: 0, text });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 知识点提取
 * ------------------------------------------------------------------ */

/** 书名号 / 引号里的专有名称 */
const QUOTE_PATTERNS = [
  { re: /《([^》]{1,30})》/g, reason: '书名号内的专有名称' },
  { re: /「([^」]{1,30})」/g, reason: '引号内的专有名称' },
  { re: /『([^』]{1,30})』/g, reason: '引号内的专有名称' },
  { re: /“([^”]{1,30})”/g, reason: '引号内的专有名称' },
  { re: /"([^"]{1,30})"/g, reason: '引号内的专有名称' },
];

/** 数字类：年份/日期、百分比、比例、数量、纯数字 */
const NUMBER_PATTERNS = [
  { re: /(?<![\d.])(\d{3,4})\s*年(?:\s*\d{1,2}\s*月(?:\s*\d{1,2}\s*日)?)?/g, reason: '年份或日期' },
  { re: /(?<![\d.])(\d{1,2})\s*月\s*(\d{1,2})\s*日/g, reason: '日期' },
  { re: /\d+(?:\.\d+)?\s*[%％]/g, reason: '百分比' },
  { re: /\d+\s*[:：]\s*\d+/g, reason: '比例' },
  {
    re: /\d+(?:\.\d+)?\s*(?:万|亿|千|百|多|余)?\s*(?:人|年|岁|次|个|种|项|倍|米|千米|公里|吨|元|美元|条|部|篇|届|级|名|所|座|件|艘|架|万|亿|千|百)/g,
    reason: '数量',
  },
  { re: /\d{2,}(?:\.\d+)?/g, reason: '数字' },
];

/** 术语后缀（命中即认为是知识点术语，挖空时后缀通常留在句子里） */
const TERM_SUFFIXES = [
  '主义', '制度', '革命', '会议', '条约', '宣言', '思想', '政策', '方针', '路线', '纲领', '精神',
  '原则', '标准', '方略', '工程', '计划', '体系', '机制', '格局', '运动', '战争', '变法', '起义',
  '改革', '理论', '学说', '法案', '公约', '协定', '联盟', '学派',
];

/** 机构 / 地名后缀 */
const NAME_SUFFIXES = ['大学', '政府', '公司', '党', '国', '军', '部', '委', '院', '会', '省', '市', '县'];

/** 汉字连串 */
const HAN_RUN_RE = /[\u4e00-\u9fa5]{2,}/g;
/** 数词 + 量词（「一次」「一个」「三场」），截取术语时整体剥掉 */
const NUM_MEASURE_RE = /^[一二三四五六七八九十两几]+[次个种场届项名位件条份座]/;
/**
 * 术语「词干」里出现这些字，说明截到的是动宾短语而不是词
 * （「1895 年签订的条约」→ 词干「年签订的」含「的」→ 直接丢弃）。量词不算（「三个代表」合法）。
 */
const INTERNAL_BLOCK_CHARS = new Set([
  '的', '了', '是', '在', '为', '和', '与', '及', '对', '把', '被', '由', '使', '从', '就',
  '都', '也', '还', '又', '并', '则', '而', '且', '其', '此', '该', '这', '那', '将', '已',
]);
/** 英文缩写（WTO / GDP / APEC…） */
const EN_RE = /(?<![A-Za-z0-9])([A-Z][A-Z0-9]{1,5})(?![A-Za-z0-9])/g;
/** 人名：后面紧跟「提出/领导/创办…」这类动词的 2~4 字名词 */
const PERSON_RE =
  /([\u4e00-\u9fa5]{2,4})(?=(?:先生|同志|提出|领导|主持|创办|创建|发表|撰写|就任|当选|指挥|指出|牺牲|逝世))/g;

/** 术语前的虚词（截取术语时从头部剔除） */
const PARTICLE_CHARS = new Set([
  '的', '了', '在', '是', '为', '和', '与', '及', '对', '把', '被', '由', '使', '到', '从',
  '就', '都', '也', '还', '又', '并', '则', '而', '且', '其', '此', '该', '这', '那', '会',
  '能', '可', '要', '将', '已', '有', '以', '着', '过',
  // 量词/指示词：把它们剥掉才不会截出「一次伟大革命」这种半截话
  '次', '个', '种', '项', '些', '条', '场', '名', '位', '件', '份', '座',
]);

/** 后缀前最多再取几个字（术语总长上限见 MAX_BLANK_CHARS） */
const TERM_HEAD_MAX = 4;
/** 机构名后缀前最多再取几个字 */
const NAME_HEAD_MAX = 3;

/**
 * 常见的双字动词前缀：术语窗口若以它们开头，说明截到了上一个词
 * （「符合质量标准」→「质量标准」），截取时把它们剥掉。
 * 只影响规则截取，不影响词典命中。
 */
const VERB_PREFIXES = [
  '符合', '达到', '坚持', '实行', '进行', '完成', '实现', '推动', '促进', '标志', '成为',
  '构成', '属于', '包括', '建立', '提出', '采取', '采用', '使用', '具有', '形成', '发生',
  '出现', '发展', '提高', '加强', '保证', '表明', '说明', '反映', '决定', '影响', '要求',
  '需要', '依靠', '利用', '通过', '制定', '举行', '召开', '取得', '赢得', '结束', '开始',
  '沦为', '侵犯',
];

/**
 * 记录一条候选知识点（会校验 term 与下标是否真的对得上，防止正则分支产生错位）。
 * @param {Array} hits
 * @param {string} text 原句
 * @param {string} term 知识点文本
 * @param {string} kind 类别
 * @param {number} index 在句中的起始下标
 * @param {string} reason 命中原因
 * @param {number} weight 词典权重（词典命中 > 规则命中）
 */
function pushHit(hits, text, term, kind, index, reason, weight = 0) {
  if (!term || !Number.isInteger(index) || index < 0) return;
  if (text.slice(index, index + term.length) !== term) return;
  hits.push({ term, kind, index, reason, weight });
}

/**
 * 词干里是否含「动宾短语标记字」（见 INTERNAL_BLOCK_CHARS）。
 * @param {string} text 词干（后缀之前的部分）
 * @returns {boolean}
 */
function hasBlockChar(text) {
  for (const ch of text) {
    if (INTERNAL_BLOCK_CHARS.has(ch)) return true;
  }
  return false;
}

/** 两个候选是否在字符范围上重叠 */
function hitOverlaps(a, b) {
  return a.index < b.index + b.term.length && b.index < a.index + a.term.length;
}

/**
 * 词首是否处于「自然边界」：句首、前面是标点/空格/数字/字母，或前面是虚词。
 * 中文没有空格，靠这一条挡掉「标志着中国」被截成「志着中国」这类跨词误切。
 * @param {string} text 原句
 * @param {number} index 词首下标
 * @returns {boolean}
 */
function isBoundaryBefore(text, index) {
  if (index <= 0) return true;
  const prev = text[index - 1];
  if (!/[\u4e00-\u9fa5]/.test(prev)) return true;
  return PARTICLE_CHARS.has(prev);
}

/** 按「类别优先级 → 词典权重 → 长度」贪心去重叠 */
function dedupeHits(hits) {
  const sorted = hits.slice().sort((a, b) => {
    const p = KIND_PRIORITY[b.kind] - KIND_PRIORITY[a.kind];
    if (p) return p;
    if (b.weight !== a.weight) return b.weight - a.weight;
    if (b.term.length !== a.term.length) return b.term.length - a.term.length;
    return a.index - b.index;
  });
  const kept = [];
  for (const hit of sorted) {
    if (kept.some((k) => hitOverlaps(k, hit))) continue;
    kept.push(hit);
  }
  return kept.sort((a, b) => a.index - b.index || b.term.length - a.term.length);
}

/** 收集一句话里的全部候选知识点（内部结构，带 weight） */
function collectHits(text) {
  const hits = [];
  if (!text) return hits;

  // ① 书名号 / 引号
  for (const { re, reason } of QUOTE_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const inner = m[1];
      if (!inner) continue;
      if (/[。！？；，,;]/.test(inner)) continue; // 引号里含句子标点 → 不是术语
      pushHit(hits, text, inner, 'quote', m.index + m[0].indexOf(inner), reason, inner.length);
    }
  }

  // ② 词典（术语 / 人名地名机构）
  for (const [dict, kind] of [[TERM_DICT, 'term'], [NAME_DICT, 'name']]) {
    for (const entry of dict) {
      let from = 0;
      let at = text.indexOf(entry, from);
      while (at !== -1) {
        pushHit(hits, text, entry, kind, at, `命中常用${kind === 'term' ? '术语' : '专名'}词典`, entry.length);
        from = at + 1;
        at = text.indexOf(entry, from);
      }
    }
  }

  // ③ 数字 / 年份 / 比例
  for (const { re, reason } of NUMBER_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      pushHit(hits, text, m[0], 'number', m.index, reason);
    }
  }

  // ④ 术语后缀（「…主义 / …运动 / …条约」等）
  HAN_RUN_RE.lastIndex = 0;
  let run;
  while ((run = HAN_RUN_RE.exec(text)) !== null) {
    const body = run[0];
    for (const suffix of TERM_SUFFIXES) {
      let from = 0;
      let at = body.indexOf(suffix, from);
      while (at !== -1) {
        const end = at + suffix.length;
        let start = Math.max(0, at - TERM_HEAD_MAX);
        // 剥掉开头的虚词与「上一个词的动词」（截到上一个词是中文里最常见的错切）
        for (let step = 0; step < 4; step += 1) {
          if (end - start <= 3) break;
          if (PARTICLE_CHARS.has(body[start])) {
            start += 1;
            continue;
          }
          // 数词 + 量词（「一次」「一个」「三场」）整体剥掉
          const measure = NUM_MEASURE_RE.exec(body.slice(start));
          if (measure && end - start - measure[0].length >= 3) {
            start += measure[0].length;
            continue;
          }
          const verb = VERB_PREFIXES.find((v) => body.startsWith(v, start));
          if (verb && end - start - verb.length >= 3) {
            start += verb.length;
            continue;
          }
          break;
        }
        const term = body.slice(start, end);
        const head = body.slice(start, at);
        if (term.length >= 3 && term.length <= MAX_BLANK_CHARS && !hasBlockChar(head)) {
          pushHit(hits, text, term, 'term', run.index + start, `含术语后缀「${suffix}」`);
        }
        from = end;
        at = body.indexOf(suffix, from);
      }
    }
    // ⑤ 机构 / 地名后缀（国/党/会/市/大学… 极易跨词误切，必须过「词首边界」校验）
    for (const suffix of NAME_SUFFIXES) {
      let from = 0;
      let at = body.indexOf(suffix, from);
      while (at !== -1) {
        const end = at + suffix.length;
        let start = Math.max(0, at - NAME_HEAD_MAX);
        while (end - start > 2 && PARTICLE_CHARS.has(body[start])) start += 1;
        const term = body.slice(start, end);
        const absStart = run.index + start;
        if (term.length >= 2 && term.length <= MAX_BLANK_CHARS && isBoundaryBefore(text, absStart)) {
          pushHit(hits, text, term, 'name', absStart, `含机构/地名后缀「${suffix}」`);
        }
        from = end;
        at = body.indexOf(suffix, from);
      }
    }
  }

  // ⑥ 人名（「X 提出 / X 领导」这类）
  PERSON_RE.lastIndex = 0;
  let person;
  while ((person = PERSON_RE.exec(text)) !== null) {
    pushHit(hits, text, person[1], 'name', person.index, '人名 + 行为动词', person[1].length);
  }

  // ⑦ 英文缩写
  EN_RE.lastIndex = 0;
  let en;
  while ((en = EN_RE.exec(text)) !== null) {
    pushHit(hits, text, en[1], 'en', en.index, '英文缩写');
  }

  return dedupeHits(hits);
}

/**
 * 从一句话里找「可挖空的知识点」。
 *
 * kind 取值与判定顺序（重叠时优先级高的胜出，返回结果按出现位置排序）：
 *   - `quote`  书名号《》/ 引号「」『』“”"" 里的专有名称；
 *   - `term`   常用术语词典命中，或含 主义/制度/革命/…/学派 等后缀的词；
 *   - `name`   人名（后接「提出/领导」等动词）、地名、机构（含 党/国/军/部/委/院/会/省/市/县/大学/公司/政府）；
 *   - `number` 年份、日期、百分比、比例、数量、多位数；
 *   - `en`     英文缩写（WTO、GDP…）。
 *
 * @param {string} sentence 一句话
 * @returns {Array<{term:string, kind:string, index:number, reason:string}>} 候选知识点（index 为 term 在句中的起始下标）
 */
export function extractKeyTerms(sentence) {
  const text = String(sentence == null ? '' : sentence);
  if (!text.trim()) return [];
  return collectHits(text).map(({ term, kind, index, reason }) => ({ term, kind, index, reason }));
}

/* ------------------------------------------------------------------ *
 * 挖空
 * ------------------------------------------------------------------ */

/**
 * 计算某个知识点「实际被挖掉的部分」。
 * 术语后缀（主义/运动/条约…）通常留在题干里更自然：
 *   「中国爆发了太平天国运动」→ 挖掉「太平天国」，题干为「中国爆发了 ____ 运动」。
 * @param {{term:string, kind:string, index:number}} hit 候选知识点
 * @returns {{text:string, start:number, end:number}} 被挖词及其在句中的范围
 */
function blankOf(hit) {
  let text = hit.term;
  if (hit.kind === 'term') {
    for (const suffix of TERM_SUFFIXES) {
      if (text.length > suffix.length + 1 && text.endsWith(suffix)) {
        text = text.slice(0, text.length - suffix.length);
        break;
      }
    }
  }
  return { text, start: hit.index, end: hit.index + text.length };
}

/**
 * 挖空是否合格：被挖词 2~12 字（数字类可短）、不超过整句 40%、挖空后仍剩 ≥8 字。
 * @param {string} sentence 原句
 * @param {{text:string, kind?:string}} blank 被挖词
 * @returns {boolean}
 */
function canBlank(sentence, blank) {
  const sentenceLen = compactLen(sentence);
  const blankLen = compactLen(blank.text);
  if (blankLen < 1) return false;
  if (blankLen > MAX_BLANK_CHARS) return false;
  if (blankLen < 2 && blank.kind !== 'number') return false;
  if (sentenceLen <= 0) return false;
  if (blankLen > sentenceLen * BLANK_MAX_RATIO) return false;
  if (sentenceLen - blankLen < MIN_REST_CHARS) return false;
  return true;
}

/** 把被挖词替换成 `____`（中文里两侧补空格，遇到标点则不补） */
function replaceWithBlank(sentence, blank) {
  const before = sentence.slice(0, blank.start);
  const after = sentence.slice(blank.end);
  const PUNC = /[，。、；：！？（）()【】《》“”‘’「」『』…—·,.;:!?]/;
  const left = before && !/\s$/.test(before) && !PUNC.test(before.slice(-1)) ? ' ' : '';
  const right = after && !/^\s/.test(after) && !PUNC.test(after[0]) ? ' ' : '';
  return `${before}${left}${BLANK}${right}${after}`.replace(/ {2,}/g, ' ');
}

/** 按优先级挑一个「还没用过」的挖空位置 */
function pickBlank(item, usedBlanks) {
  const candidates = item.hits
    .map((hit) => ({ hit, blank: blankOf(hit) }))
    .filter((c) => canBlank(item.text, { ...c.blank, kind: c.hit.kind }))
    .sort((a, b) => {
      const p = KIND_PRIORITY[b.hit.kind] - KIND_PRIORITY[a.hit.kind];
      if (p) return p;
      if (b.hit.weight !== a.hit.weight) return b.hit.weight - a.hit.weight;
      if (b.blank.text.length !== a.blank.text.length) return b.blank.text.length - a.blank.text.length;
      return a.blank.start - b.blank.start;
    });
  for (const c of candidates) {
    if (usedBlanks.has(c.blank.start)) continue;
    return c;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 种子随机
 * ------------------------------------------------------------------ */

/**
 * mulberry32：小巧的种子随机数发生器（同一 seed → 同一序列，保证出题可复现）。
 * @param {number} seed 种子
 * @returns {() => number} 返回 [0,1) 随机数的函数
 */
function makeRng(seed) {
  let state = (Number(seed) >>> 0) || 1;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates 洗牌（不改原数组） */
function shuffle(list, rng) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 干扰项
 * ------------------------------------------------------------------ */

/**
 * 挑 3 个干扰项：
 *   ① 全文中 kind 相同、长度相近（±3 字）且不等于正确答案的知识点；
 *   ② 全文中其它任意知识点；
 *   ③ 仍凑不满 3 个 → 返回不足（调用方放弃这道选择题）。
 * 另外会剔掉「答案就写在题干里」和「与答案互为子串」的候选，避免送分题。
 * @param {Array<{text:string,kind:string,len:number}>} pool 全文知识点池
 * @param {string} correctText 正确答案
 * @param {string} kind 正确答案类别
 * @param {string} sentence 原句
 * @param {() => number} rng 种子随机
 * @returns {string[]} 干扰项（最多 3 个）
 */
function pickDistractors(pool, correctText, kind, sentence, rng) {
  const correctKey = normalizeStem(correctText);
  const correctLen = compactLen(correctText);
  const sentenceKey = compact(sentence);

  const usable = pool.filter((c) => {
    const key = normalizeStem(c.text);
    if (!key || key === correctKey) return false;
    if (key.includes(correctKey) || correctKey.includes(key)) return false; // 互为子串 → 太容易排除
    if (sentenceKey.includes(compact(c.text))) return false; // 答案已经在题干里 → 送分
    return true;
  });

  const sameKind = usable.filter((c) => c.kind === kind && Math.abs(c.len - correctLen) <= DISTRACTOR_LEN_TOLERANCE);

  const picked = [];
  const taken = new Set([correctKey]);
  const takeFrom = (list) => {
    for (const c of shuffle(list, rng)) {
      if (picked.length >= CHOICE_OPTION_COUNT - 1) return;
      const key = normalizeStem(c.text);
      if (taken.has(key)) continue;
      taken.add(key);
      picked.push(c.text);
    }
  };

  takeFrom(sameKind);
  if (picked.length < CHOICE_OPTION_COUNT - 1) takeFrom(usable);
  return picked;
}

/* ------------------------------------------------------------------ *
 * 判断题：改写句子
 * ------------------------------------------------------------------ */

/** 把数字格式化回「和原样一致的写法」（保留小数位） */
function formatNumber(value, sample) {
  if (String(sample).includes('.')) {
    return value.toFixed(String(sample).split('.')[1].length);
  }
  return String(Math.trunc(value));
}

/**
 * 改写句子使其成为错误陈述：
 *   ① 句中有数字/年份 → 改掉数字（年份 ±1~5、百分比 ±10、其他数字 ±1）；
 *   ② 否则加 / 删否定词（「是」→「不是」、「有」→「没有」、「必须」→「不必」…）。
 * @param {string} text 原句
 * @param {() => number} rng 种子随机
 * @returns {{text:string, note:string}|null} 改写结果；改不出来返回 null
 */
function mutateSentence(text, rng) {
  const hits = collectHits(text);
  const number = hits.filter((h) => h.kind === 'number').sort((a, b) => a.index - b.index)[0];

  // ① 改数字
  if (number) {
    const digits = /(\d+(?:\.\d+)?)/.exec(number.term);
    if (digits) {
      const sample = digits[1];
      const value = Number(sample);
      const isPercent = /[%％]/.test(number.term);
      const isYear = /^\d{3,4}\s*年/.test(number.term);
      let next;
      if (isYear) {
        const delta = 1 + Math.floor(rng() * 5); // 年份 ±1~5
        next = value + (rng() < 0.5 ? delta : -delta);
      } else if (isPercent) {
        next = value + (rng() < 0.5 ? 10 : -10); // 百分比 ±10
        if (next <= 0) next = value + 10;
      } else {
        next = value + (rng() < 0.5 ? 1 : -1); // 其它数字 ±1
        if (next < 0) next = value + 1;
      }
      if (next === value) next = value + 1;
      const at = number.index + digits.index;
      const mutated =
        text.slice(0, at) + formatNumber(next, sample) + text.slice(at + sample.length);
      if (mutated !== text) {
        return { text: mutated, note: `把「${sample}」改成了「${formatNumber(next, sample)}」` };
      }
    }
  }

  // ② 删否定词（原文含否定 → 删掉它，陈述变错）
  const removeRe = /不(?=是|属于|可以|必须|同|正确|相同)|没(?=有)/;
  const rm = removeRe.exec(text);
  if (rm) {
    return {
      text: text.slice(0, rm.index) + text.slice(rm.index + rm[0].length),
      note: `删去了原文中的「${rm[0]}」`,
    };
  }

  // ③ 加否定词（按关键词长短优先，避免「可以是」被误改）
  const ADD_RULES = [
    { word: '可以', replacement: '不可以' },
    { word: '必须', replacement: '不必' },
    { word: '属于', replacement: '不属于' },
    { word: '是', replacement: '不是', guard: true },
    { word: '有', replacement: '没有', guard: true },
  ];
  for (const rule of ADD_RULES) {
    let at = text.indexOf(rule.word);
    while (at !== -1) {
      const prev = at > 0 ? text[at - 1] : '';
      const blocked = rule.guard && COPULA_BLOCK_BEFORE.has(prev);
      if (!blocked) {
        const mutated = text.slice(0, at) + rule.replacement + text.slice(at + rule.word.length);
        return { text: mutated, note: `把「${rule.word}」改成了「${rule.replacement}」` };
      }
      at = text.indexOf(rule.word, at + 1);
    }
  }

  return null;
}

/* ------------------------------------------------------------------ *
 * 生成题目
 * ------------------------------------------------------------------ */

/** 参数兜底成整数 */
function clampInt(value, fallback, min, max) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 题型参数归一化（非法值忽略；空数组视为「全都要」） */
function normalizeTypes(types) {
  const list = Array.isArray(types) ? types.filter((t) => GEN_TYPES.includes(t)) : [];
  return list.length ? [...new Set(list)] : [...GEN_TYPES];
}

/** 出题顺序：先补「当前生成得最少」的题型，保证三种题型均衡 */
function orderTypes(types, produced) {
  return types.slice().sort((a, b) => produced[a] - produced[b] || GEN_TYPES.indexOf(a) - GEN_TYPES.indexOf(b));
}

/**
 * 生成填空 / 选择 / 判断题。
 *
 * @param {Array<{page?:number,line?:number,para?:number,text:string}|string>} lines 文本行（同 splitSentences 入参）
 * @param {object} [opts] 选项
 * @param {string[]} [opts.types] 要生成的题型，取值 GEN_FILL / GEN_CHOICE / GEN_JUDGE，默认三种全要
 * @param {number} [opts.count] 最多生成多少题，默认 50（上限 500）
 * @param {number} [opts.maxPerSentence] 每句最多出几题，默认 1（上限 5）
 * @param {number} [opts.seed] 随机种子（选项打乱与干扰项挑选），默认固定值 → 默认完全可复现
 * @returns {{questions:object[], sentences:number, skipped:number, warnings:string[], total:number, byType:object}}
 *   questions 中每一项都是 models.makeQuestion() 规范化后的 Question：
 *   qtype 为 QT_SINGLE（填空/选择）或 QT_JUDGE（判断），source='auto'，
 *   explanation 形如「出自原文：<原句>」，raw = 原句。
 *   sentences = 去噪后可用于出题的句子数（含因达到 count 上限而未处理的句子）；
 *   skipped = 被跳过的句子数（噪声句 + 没产出题目的句子，含达到 count 上限后未处理的句子）；
 *   total = 切分出的句子总数（= 噪声句 + sentences）；byType = 各题型实际生成数量。
 */
export function generateQuestions(lines, opts = {}) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const types = normalizeTypes(options.types);
  const count = clampInt(options.count, 50, 1, 500);
  const maxPerSentence = clampInt(options.maxPerSentence, 1, 1, 5);
  const seed = Number.isFinite(Number(options.seed)) ? Number(options.seed) : DEFAULT_SEED;
  const rng = makeRng(seed);

  const warnings = [];
  const questions = [];
  const byType = { fill: 0, choice: 0, judge: 0 };
  const seenQids = new Set();
  const counters = { noDistractor: 0, judgeMutateFailed: 0, dedupe: 0, unprocessed: 0, blankFound: 0 };

  const all = splitSentences(lines);
  const total = all.length;

  /* ① 去噪、记录标题上下文、抽取候选知识点 */
  const usable = [];
  let skipped = 0;
  let currentTopic = '';
  for (const sentence of all) {
    if (looksLikeHeading(sentence.text)) {
      currentTopic = cleanHeading(sentence.text);
      skipped += 1;
      continue;
    }
    if (isNoiseSentence(sentence.text)) {
      skipped += 1;
      continue;
    }
    usable.push({ ...sentence, topic: currentTopic, hits: collectHits(sentence.text) });
  }

  /* ② 全文知识点池（选择题干扰项来源） */
  const pool = [];
  const poolKeys = new Set();
  for (const item of usable) {
    for (const hit of item.hits) {
      const blank = blankOf(hit);
      const len = compactLen(blank.text);
      const minLen = hit.kind === 'number' ? 1 : 2;
      if (len < minLen || len > MAX_BLANK_CHARS) continue;
      const key = normalizeStem(blank.text);
      if (!key || poolKeys.has(key)) continue;
      poolKeys.add(key);
      pool.push({ text: blank.text, kind: hit.kind, len });
    }
  }

  if (!pool.length) {
    warnings.push('没有提取到可挖空的知识点：建议上传句子更完整的知识点（含年份、术语、书名号等）。');
  }

  /* ③ 逐句出题 */
  const judgeState = { count: 0 };

  const buildFill = (item, usedBlanks) => {
    const cand = pickBlank(item, usedBlanks);
    if (!cand) return null;
    counters.blankFound += 1;
    const question = makeQuestion({
      stem: replaceWithBlank(item.text, cand.blank),
      qtype: QT_SINGLE,
      options: { A: cand.blank.text },
      answer: 'A',
      explanation: `出自原文：${item.text}`,
      page: item.page,
      line: item.line,
      para: item.para,
      topic: item.topic,
      raw: item.text,
    });
    return { question, blankStart: cand.blank.start, type: GEN_FILL };
  };

  const buildChoice = (item, usedBlanks) => {
    const cand = pickBlank(item, usedBlanks);
    if (!cand) return null;
    counters.blankFound += 1;
    const correct = cand.blank.text;
    const distractors = pickDistractors(pool, correct, cand.hit.kind, item.text, rng);
    if (distractors.length < CHOICE_OPTION_COUNT - 1) {
      counters.noDistractor += 1;
      return null;
    }
    const shuffled = shuffle([correct, ...distractors], rng);
    const letters = ['A', 'B', 'C', 'D'];
    const optionObj = {};
    shuffled.forEach((text, i) => {
      optionObj[letters[i]] = text;
    });
    const answerLetter = letters[shuffled.indexOf(correct)];
    const question = makeQuestion({
      stem: replaceWithBlank(item.text, cand.blank),
      qtype: QT_SINGLE,
      options: optionObj,
      answer: answerLetter,
      explanation: `出自原文：${item.text}`,
      page: item.page,
      line: item.line,
      para: item.para,
      topic: item.topic,
      raw: item.text,
    });
    return { question, blankStart: cand.blank.start, type: GEN_CHOICE };
  };

  const buildJudge = (item, judgeUsed) => {
    // 同一句话只出一道判断题：否则会同时出现「X 是 Y」和「X 不是 Y」这种只差一个字的重复题
    if (judgeUsed) return null;
    if (!JUDGE_HINT_RE.test(item.text)) return null;
    const preferFalse = judgeState.count % 2 === 1; // 正确 / 错误 交替出
    if (preferFalse) {
      const mutated = mutateSentence(item.text, rng);
      if (mutated) {
        const question = makeQuestion({
          stem: mutated.text,
          qtype: QT_JUDGE,
          options: {},
          answer: '错误',
          explanation: `出自原文：${item.text}\n（本题改动：${mutated.note}）`,
          page: item.page,
          line: item.line,
          para: item.para,
          topic: item.topic,
          raw: item.text,
        });
        return { question, blankStart: -1, type: GEN_JUDGE };
      }
      counters.judgeMutateFailed += 1;
    }
    // 原句照抄 → 正确
    const question = makeQuestion({
      stem: item.text,
      qtype: QT_JUDGE,
      options: {},
      answer: '正确',
      explanation: `出自原文：${item.text}`,
      page: item.page,
      line: item.line,
      para: item.para,
      topic: item.topic,
      raw: item.text,
    });
    return { question, blankStart: -1, type: GEN_JUDGE };
  };

  for (const item of usable) {
    if (questions.length >= count) {
      counters.unprocessed += 1;
      skipped += 1;
      continue;
    }
    const usedBlanks = new Set();
    let judgeUsed = false;
    let made = 0;

    while (made < maxPerSentence && questions.length < count) {
      let accepted = null;
      for (const type of orderTypes(types, byType)) {
        let built = null;
        if (type === GEN_FILL) built = buildFill(item, usedBlanks);
        else if (type === GEN_CHOICE) built = buildChoice(item, usedBlanks);
        else built = buildJudge(item, judgeUsed);
        if (!built) continue;
        if (seenQids.has(built.question.qid)) {
          counters.dedupe += 1;
          continue;
        }
        accepted = built;
        break;
      }
      if (!accepted) break;
      seenQids.add(accepted.question.qid);
      questions.push(accepted.question);
      byType[accepted.type] += 1;
      if (accepted.type === GEN_JUDGE) {
        judgeState.count += 1;
        judgeUsed = true;
      } else if (accepted.blankStart >= 0) usedBlanks.add(accepted.blankStart);
      made += 1;
    }

    if (made === 0) skipped += 1;
  }

  /* ④ 汇总提示 */
  if (counters.unprocessed > 0) {
    warnings.push(`已达题数上限（${count} 题），还有 ${counters.unprocessed} 句未处理。`);
  }
  if (counters.noDistractor > 0) {
    warnings.push(
      `有 ${counters.noDistractor} 处知识点因找不到同类干扰项，没有生成选择题（避免出现一眼能排除的选项）。`,
    );
  }
  if (counters.judgeMutateFailed > 0) {
    warnings.push(`有 ${counters.judgeMutateFailed} 句无法改写为错误陈述，已改为「正确」判断题。`);
  }
  if (!questions.length && pool.length && counters.blankFound === 0) {
    warnings.push('提取到的知识点都不满足挖空条件（太短、太长或占全句比例过高），建议提供更完整的句子。');
  }

  return {
    questions,
    sentences: usable.length,
    skipped,
    warnings,
    total,
    byType,
  };
}

/**
 * 出题结果的中文摘要（页面与日志复用）。
 * @param {{questions:object[], sentences:number, skipped:number, total?:number}} result
 * @returns {string}
 */
export function summarizeGenerated(result) {
  const r = result || {};
  const list = Array.isArray(r.questions) ? r.questions : [];
  const byType = { fill: 0, choice: 0, judge: 0 };
  for (const q of list) {
    if (q.qtype === QT_JUDGE) byType.judge += 1;
    else if (Object.keys(q.options || {}).length > 1) byType.choice += 1;
    else byType.fill += 1;
  }
  return (
    `共 ${r.total || 0} 句，可用 ${r.sentences || 0} 句，生成 ${list.length} 题` +
    `（填空 ${byType.fill} / 选择 ${byType.choice} / 判断 ${byType.judge}），跳过 ${r.skipped || 0} 句`
  );
}
