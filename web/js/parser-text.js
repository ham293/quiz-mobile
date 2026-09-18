/**
 * parser-text.js —— 纯文本行 → 结构化题目（切题 / 答案 / 选项 / 噪声 / 日志）
 *
 * 本模块是 Python 版 `刷题程序/quiz/parser.py` 的 JS 重写，规则与其逐条对齐；
 * 不依赖任何浏览器 API（可在 Node 里直接 import 测试），不引入任何第三方库，
 * 也不 import 尚未存在的模块（models.js / config.js 的常量与工具函数在本文件内自实现）。
 *
 * ## 输入
 * `lines` = `[{ page, line, para, text }, ...]`（extract.js 的产物）
 *   - page：PDF 页码（从 1 开始）；docx / txt 为 0
 *   - line：PDF 页内行号；docx / txt 为段落序号（均从 1 开始）
 *   - para：docx / txt 段落序号（从 1 开始）；PDF 为 0
 *
 * ## 输出
 * `{ questions, skipped, errors, warnings, totalUnits, noiseRemoved, summary() }`，
 * 详见 parseLines() 的 JSDoc。
 *
 * ## 规则总表（与 Python 版一致）
 * 1. 切题：新题起始行 =
 *    `1.` `1、` `1）` `1)` `1．` `(1)` `（1）` `第1题` `第 1 题` 等阿拉伯数字编号，
 *    `一、` `十一、` 等中文数字编号（后面紧跟选项字母时不算题号），
 *    或行首题型标记（`【单选题】` `（判断题）` `【多选】5.`）；
 *    题号与题型标记都从题干里删除。`2024年`、`1.5倍` 不会被误判为题号。
 * 2. 题型判定顺序：显式题型标记 > 判断题特征（答案为 正确/错误/√/×，或选项就是 A.正确 B.错误）
 *    > 选项 ≥2 个（答案 ≥2 个字母 = 多选，否则单选）> 无选项但答案是字母（判单选/多选 + warning）
 *    > 题干含 论述/试述/请论述/阐述/结合实际/谈谈你的看法/分析 判论述，否则判简答。
 * 3. 答案提取（提取后必须从题干里删除答案文本）：
 *    - 题干括号内：`（D）` `(ABC)` `（ D ）` `（√）` `（正确）`（中英文括号都支持）；
 *      括号内必须是 1~6 个选项字母，或 √/×/正确/错误 才算答案；空括号 `（  ）` 保留在题干、不算答案。
 *    - 单独一行：`答案：D` `答案:D` `参考答案：ABC` `【答案】D` `正确答案：D` `答案 ABCD`
 *      `答案 √` `答案：正确`，以及「答案：」后换行取值。
 *    - 与最后一个选项同一行结尾：`… D.新时代  答案：D`。
 * 4. 解析提取：行首 `解析：` / `答案解析：` / `【解析】` / `分析：` / `解答：` / 单独一行「解析」；
 *    多行解析累计到下一题 / 下一选项 / 结束，保留换行。行内只认「解析」族，避免截断题干。
 * 5. 噪声清理：空白行只计入 noiseRemoved；页码行（`- 1 -`、`第 2 页`、`3/20`、`第 1 页 共 2 页`、纯数字行）、
 *    推广语行（`全部资料电子版` / `公众号` / `扫码关注` / `免费领取` / `关注公众号` / `更多资料` / `客服` / `QQ群` …）、
 *    分隔线（`----` `====` `****`）、题型章节标题行（`一、单项选择题`）逐条记入 skipped，
 *    字段固定 {page, line, content, reason}，reason 为中文。
 * 6. 选项切分容错：分行选项、挤在一行的 `A.甲B.乙C.丙D.丁`（字母 lookahead + 前置约束
 *    `(?<![A-Za-z0-9])`，保证 `CAD`、`维生素 A 缺乏`、`GDP增长` 不被误切）、题干行内选项、
 *    选项续行（下一行无字母前缀则追加到上一个选项）；字母重复/乱序/不连续按最后一次为准并记 warnings。
 * 7. 异常与跳过：
 *    errors（字段固定 {time, bank, page, line, reason, raw}）
 *      1) 题干为空、或完全无法判定题型 → 记 errors 且【丢弃】该题，不进 questions
 *      2) 选择/多选题有选项但答案缺失 → 记 errors，该题【保留】，另在 warnings 补一句汇总
 *      3) 判断题答案缺失或无法归一化成 正确/错误 → 记 errors，该题【保留】
 *      4) 单行解析出现意外异常 → 记 errors，不中断整体解析
 *    warnings：选项字母重复/乱序/不连续、选择题缺少选项、答案缺失提示与末尾汇总。
 * 8. 位置/年份/知识点：location 与 year/topic 由 makeQuestion() 统一给出
 *    （year 取题干里最早的四位年份，topic 取 `【】` 或中文括号内的主题词）。
 * 9. qid = sha1(normalizeStem(stem)).slice(0, 16)，用本文件内的同步 sha1（浏览器 / Node 均可用，
 *    不用异步的 crypto.subtle）。
 *
 * ## 与 Python 版的两处有意差异（其余逐条一致）
 * - 推广语噪声判定增加保护：一行若本身是一个新题起始（带题号/行首题型标记）就不按推广语跳过，
 *   避免题干里恰好出现「客服」等词时整题被吞掉。
 * - 行内题型标记行也会记入该题 raw（Python 版在已有题目时不记该行），使 raw 更完整。
 */

/* ================================================================
 * 0. 错误类型
 * ================================================================ */

/**
 * 解析相关错误（中文消息，面向用户）。
 * parseLines() 内部不抛它：坏行会落进结果对象的 errors 里，保证解析不中断。
 */
export class ParseError extends Error {
  /**
   * @param {string} [message] 中文错误消息
   */
  constructor(message = '解析失败') {
    super(message);
    this.name = 'ParseError';
    this.message = message;
  }
}

/* ================================================================
 * 1. 常量（题型 / 字母 / 噪声词 / 标点）
 * ================================================================ */

/** 单选题 */
export const QT_SINGLE = '单选';
/** 多选题 */
export const QT_MULTI = '多选';
/** 判断题 */
export const QT_JUDGE = '判断';
/** 简答题 */
export const QT_SHORT = '简答';
/** 论述题 */
export const QT_ESSAY = '论述';
/** 题型展示顺序（summary 里按此顺序统计） */
export const QUESTION_TYPES = [QT_SINGLE, QT_MULTI, QT_JUDGE, QT_SHORT, QT_ESSAY];

/** 需要主观作答的题型（答案可能是自由文本） */
export const SUBJECTIVE_TYPES = [QT_SHORT, QT_ESSAY];

/** 选项字母（与 Python 版 config.OPTION_LETTERS 一致；切分正则只用 A~H） */
export const OPTION_LETTERS = 'ABCDEFGHIJ';

/** 题型中文别名 → 标准题型（与 Python 版 config.TYPE_ALIASES 一致） */
const TYPE_ALIASES = new Map([
  ['单选', QT_SINGLE], ['单选题', QT_SINGLE], ['单项选择题', QT_SINGLE],
  ['多选', QT_MULTI], ['多选题', QT_MULTI], ['多项选择题', QT_MULTI],
  ['判断', QT_JUDGE], ['判断题', QT_JUDGE], ['是非题', QT_JUDGE],
  ['简答', QT_SHORT], ['简答题', QT_SHORT], ['填空', QT_SHORT], ['填空题', QT_SHORT],
  ['论述', QT_ESSAY], ['论述题', QT_ESSAY], ['问答题', QT_ESSAY], ['分析题', QT_ESSAY],
]);

/**
 * 页眉页脚 / 推广语关键字（命中即跳过整行）。
 * 在 Python 版 config.NOISE_KEYWORDS 基础上，按需求补入「公众号」「客服」两个更宽的关键词。
 */
export const NOISE_KEYWORDS = [
  '全部资料电子版', '电子版在公众号', '公众号：', '公众号:', '公众号',
  '微信公众号', '扫码关注', '扫码领取', '更多资料', '关注公众号',
  '免费领取', 'QQ群', 'qq群', '微信搜', '资料下载', '内部资料',
  '版权所有', '翻版必究', '更多题库', '添加客服', '咨询客服', '客服',
];

/** 答案 / 解析取值时需要从两端去掉的标点与空白（对应 Python 的 _PUNCT_TRIM） */
const PUNCT_TRIM = '。．.；;：:、,，)）]】 \t\u3000';

/** summary() 里的来源类型中文名 */
const SOURCE_TYPE_CN = { pdf: 'PDF 文档(.pdf)', docx: 'Word 文档(.docx)', txt: '文本文件' };

/* ================================================================
 * 2. 正则表
 * 正则集中在文件顶部，每条都注明意图，便于题库格式变动时集中调整。
 * ================================================================ */

/** 正则元字符转义（题型别名组合成正则串时使用） */
const escapeRe = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---- 题型标记 ---------------------------------------------------------------
// 别名按长度倒序排列，保证「多项选择题」优先于「多选」匹配
const ALIAS_KEYS_DESC = [...TYPE_ALIASES.keys()].sort((a, b) => b.length - a.length);
const TYPE_ALIAS_ALT = ALIAS_KEYS_DESC.map(escapeRe).join('|');
/** 括号包裹的题型标记：`【单选题】` / `[多选]` / `（判断题）`，可出现在行内任意位置 */
const TYPE_MARK_BRACKET_RE = new RegExp(`[【\\[（(]\\s*(${TYPE_ALIAS_ALT})\\s*[】\\]）)]`);
// 行首裸题型标记：只接受以「题」结尾的别名（单项选择题 / 多选题 / 判断题…），
// 避免把「判断下列说法是否正确」这类题干里的「判断」误认成题型标记
const BARE_ALIAS_ALT = ALIAS_KEYS_DESC.filter((a) => a.endsWith('题')).map(escapeRe).join('|');
/** 行首裸题型标记 */
const TYPE_MARK_BARE_RE = new RegExp(`^(${BARE_ALIAS_ALT})\\s*[:：.、．]?\\s*`);

// ---- 题号（新题起始）--------------------------------------------------------
// 「1.」「1、」「1）」「1)」「1．」等阿拉伯数字编号。
// 只有「小数点分隔符」后面才禁止紧跟数字（避免把「1.5倍」当成题号）；
// 顿号/括号分隔符后面允许跟数字 —— 否则「2、1949年新中国成立…」这种
// 题号后直接接年份的题目会被漏掉（实测用户题库里就有）。
const QNUM_ARABIC_RE = /^\s*\d{1,3}\s*(?:[、)）]\s*|[.．](?!\d)\s*)/;
/** 「(1)」「（1）」 */
const QNUM_PAREN_RE = /^\s*[(（]\s*\d{1,3}\s*[)）]\s*/;
/** 「第1题」「第 1 题」 */
const QNUM_DI_RE = /^\s*第\s*\d{1,3}\s*题\s*[.、．:：)）]?\s*/;
/** 中文数字编号「一、」「十二、」（调用处再排除后面紧跟选项字母的情况） */
const QNUM_CN_RE = /^\s*[一二三四五六七八九十百]{1,3}\s*[、.．)）]\s*/;
/**
 * 选项行的项目符号（很多题库导出 PDF 时选项前面带圆点/方块）：
 *   `• A. 鸦片战争`、`● B. 第二次鸦片战争`、`· C. 中日甲午战争`、`- D. 八国联军侵华战争`
 * 用户实测的题库正是这种 —— 不做兼容的话整行选项都识别不出来，会被当成题干文字。
 */
const OPTION_BULLET_SRC = '[•●○◦▪▫‣·∙※＊*+\\-–—]\\s*';
/** 行首选项字母（允许前面有项目符号）：用于中文数字编号的谨慎排除 */
const OPTION_AT_START_RE = new RegExp(`^\\s*(?:${OPTION_BULLET_SRC})?[A-H]\\s*[.、．)）:：\\s]`);
/** 行首选项字母（严格版：不含项目符号，用于需要"必须以字母开头"的判断） */
const OPTION_LETTER_AT_START_RE = /^\s*[A-H]\s*[.、．)）:：\s]/;

// ---- 答案 -------------------------------------------------------------------
// 题干括号内答案：括号内容必须「只含 1~6 个选项字母」或「√ × 正确 错误 对 错 是 否」才算答案；
// 「（ ）」空括号不算答案（保留在题干里，由「答案缺失」检查统一处理）
const BRACKET_ANSWER_RE = /[(（]\s*([A-H]{1,6}|√|✓|×|✗|正确|错误|对的|错的|不对|对|错|是|否)\s*[)）]/;
/** 空答案括号：`（ ）` / `( )` */
const EMPTY_BRACKET_RE = /[(（]\s*[)）]/;
// 答案标识：`答案` / `参考答案` / `正确答案` / `标准答案` / `【答案】`
const ANS_KEY_SRC = '(?:【\\s*(?:参考|正确|标准)?\\s*答\\s*案\\s*】|(?:参考|正确|标准)?\\s*答\\s*案)';
/** 独立答案行：`答案：D`、`答案:D`、`参考答案：ABC`、`【答案】D`、`答案 ABCD` */
const ANSWER_LINE_RE = new RegExp(`^\\s*${ANS_KEY_SRC}\\s*[:：、.．]?\\s*(.*)$`);
// 行内答案（紧随题干/最后一个选项之后）：`… 答案：D`。
// 要求「答案」前是空白 / 标点 / 答案字符，避免误伤题干里的「答案是什么」这类表述
const INLINE_ANSWER_MARK_RE = new RegExp(
  `(?:^|(?<=[\\s）)。；;，,、\\]：:√×A-Ha-h]))${ANS_KEY_SRC}\\s*[:：、.．]?`,
);

// ---- 解析（explanation）----------------------------------------------------
/** 行首解析前缀：`解析：`、`答案解析：`、`【解析】`、`分析：`、`解答：`（冒号必需） */
const EXPL_PREFIX_RE = /^\s*(?:【\s*(?:答案)?解析\s*】|(?:答案解析|答案分析|解析|分析|解答|点评)\s*[:：])\s*(.*)$/;
/** 单独一行的解析标题：`解析` / `答案解析` / `解答` / `点评`（内容在后续行） */
const EXPL_HEADING_RE = /^\s*(?:答案解析|答案分析|解析|解答|点评)\s*$/;
// 行内解析标记：只认「解析」族（不认 分析/解答，避免把题干里的「…，分析：」截断成解析）；
// 前面的字符必须是空白 / 标点 / 答案字符
const INLINE_EXPL_MARK_RE = new RegExp(
  '(?:^|(?<=[\\s）)。；;，,、\\]：:√×A-Ha-h]))'
  + '(?:【\\s*(?:答案)?解析\\s*】|(?:答案解析|答案分析|解析|点评)\\s*[:：])',
);

// ---- 选项 -------------------------------------------------------------------
// 选项 token：单个大写字母 A~H + 分隔符（. 、 ． ) ） : ：）或空白。
// 负向后行断言 (?<![A-Za-z0-9]) 保证「CAD」「GDP增长」这类英文串里的字母不会被误切；
// 命名组 sep 记录是否使用了明确分隔符（纯空格的选项组更容易误判，另做限制）;
// 行首还允许一个项目符号（• ● · …）——题库导出 PDF 时选项常带圆点。
const OPTION_TOKEN_RE = new RegExp(
  `(?<![A-Za-z0-9])(?:${OPTION_BULLET_SRC})?([A-H])(?:(?<sep>[.、．)）:：])\\s*|[ \\t\\u3000]+)`,
);

// ---- 噪声 -------------------------------------------------------------------
/** 纯分隔线：---- / ==== / **** / ~~~~ 等 */
const SEPARATOR_RE = /^\s*[-—–_=*·~]{3,}\s*$/;
/** 页码装饰行：`- 1 -` */
const PAGE_NUMBER_DECOR_RE = /^\s*[-—–]\s*\d{1,4}\s*[-—–]\s*$/;
/** 页码的通用形态：纯数字、`第2页`、`3/20` */
const PAGE_NUMBER_RE = /^[\s\-—–_=*·.]*(?:第?\s*\d{1,4}\s*(?:页|\/[0-9]{1,4})?)[\s\-—–_=*·.]*$/;
/** 页码的完整形态：「第 1 页 共 2 页」「第1页/共2页」 */
const EXTRA_PAGE_RE = /^\s*第?\s*\d{1,4}\s*页\s*(?:[/共]\s*共?\s*\d{1,4}\s*页?)?\s*$/;
/**
 * 只有分值标注的行（考试卷常见）：「（共计280分）」「[2分]」「共20分」「本大题共30分」
 * 这类行不是题目，之前会被当成一道题干（用户实测出现过题干为「（共计280分）」的题）。
 */
const SCORE_ONLY_RE = /^[（(【\[]?\s*(?:共\s*计?|总\s*计?|每题|本大题|本卷|小计)?\s*\d{1,3}\s*分\s*[）)】\]]?[。.．]?$/;

// ---- 答案取值 ---------------------------------------------------------------
// 可归一化为判断题答案的字面量（不含 1/0/Y/N 等歧义形态，避免与选项字母冲突）
const JUDGE_VALUE_RE = /^(?:正确|错误|对|错|是|否|对的|错的|正确的|错误的|不对|√|✓|×|✗|v|V|x|X|t|T|f|F)$/;
/** 纯选择题答案：1~6 个字母（可带括号） */
const CHOICE_ALL_RE = /^[(（]?\s*([A-Ha-h]{1,6})\s*[)）]?$/;
/** 选择题答案（带分隔）：A、B / A,B / A B / A/B */
const CHOICE_SEP_RE = /^[A-Ha-h](?:\s*[、,，/\s]\s*[A-Ha-h]){1,5}$/;
/** 行首字母 token（形如「D。故选D」） */
const LEADING_LETTER_RE = /^([A-Ha-h]{1,6})(?![A-Za-z0-9])/;

/** 论述题特征词（无选项时的启发式判定） */
const ESSAY_HINT_RE = /论述|试述|请论述|阐述|结合实际|谈谈你的看法|分析/;

/* ================================================================
 * 3. 归一化与生成 qid 的工具（models.js 到位前在本文件内自实现）
 * ================================================================ */

/** 题干归一化时要去掉的空白与标点（对应 Python 版 models._NORM_STRIP_RE） */
const NORM_STRIP_RE = /[\s\u3000，。、,.;；:：（）()【】\[\]「」『』？?！!·\-—_]+/g;
/** 四位年份 */
const YEAR_RE = /(?<!\d)((?:19|20)\d{2})(?!\d)/g;
/** 知识点：优先 `【】`（≤20 字），其次中文括号主题词（≤10 字） */
const TOPIC_RE = /[【\[]([^】\]]{1,20})[】\]]|（([^）]{1,10})）/;

const JUDGE_TRUE = new Set(['正确', '对', '是', 'T', 'TRUE', 'Y', 'YES', '√', '✓', 'V', '1', '对的', '正确的']);
const JUDGE_FALSE = new Set(['错误', '错', '否', '不对', '不是', 'F', 'FALSE', 'N', 'NO', '×', 'X', '✗', '0', '错的', '错误的']);

/**
 * 题干归一化：去掉空白与标点，用于去重与生成 qid。
 * @param {string} stem 题干
 * @returns {string} 归一化后的题干
 */
export function normalizeStem(stem) {
  return String(stem ?? '').replace(NORM_STRIP_RE, '');
}

/**
 * 把选择题答案统一成去重、升序的大写字母串，例如 `ba` → `AB`。
 * @param {string} raw 原始答案
 * @returns {string} 归一化后的字母串（不含 A~J 之外的字符时返回空串）
 */
export function normalizeChoice(raw) {
  const letters = [...String(raw ?? '').toUpperCase()].filter((c) => OPTION_LETTERS.includes(c));
  const seen = [];
  for (const c of letters) if (!seen.includes(c)) seen.push(c);
  return seen.sort((a, b) => OPTION_LETTERS.indexOf(a) - OPTION_LETTERS.indexOf(b)).join('');
}

/**
 * 把判断题答案统一成「正确」或「错误」。
 * @param {string} raw 原始答案（√ / × / 对 / 错 / T / F …）
 * @returns {string} 「正确」「错误」或空串（无法归一化）
 */
export function normalizeJudge(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  const upper = text.toUpperCase().replace(/\s+/g, '');
  if (JUDGE_TRUE.has(upper) || JUDGE_TRUE.has(text)) return '正确';
  if (JUDGE_FALSE.has(upper) || JUDGE_FALSE.has(text)) return '错误';
  return '';
}

/**
 * 从题干提取年份（用于「按时间顺序练习」），取最早出现的四位年份。
 * @param {string} text 题干
 * @returns {number|null} 年份，没有则返回 null
 */
export function extractYear(text) {
  const years = [];
  const re = new RegExp(YEAR_RE.source, 'g');
  let m = re.exec(String(text ?? ''));
  while (m !== null) {
    years.push(Number(m[1]));
    m = re.exec(String(text ?? ''));
  }
  return years.length ? Math.min(...years) : null;
}

/**
 * 提取知识点：优先题干中的 `【】`，其次中文括号内的主题词。
 * @param {string} text 题干
 * @returns {string} 知识点，没有则返回空串
 */
export function extractTopic(text) {
  const m = TOPIC_RE.exec(String(text ?? ''));
  if (!m) return '';
  return String(m[1] || m[2] || '').trim();
}

/* ----------------------------------------------------------------
 * 同步 sha1（浏览器与 Node 都可用；不用异步的 crypto.subtle）
 * ---------------------------------------------------------------- */

/**
 * 字符串 → UTF-8 字节数组（含代理对处理）。
 * @param {string} text 任意字符串
 * @returns {number[]} 字节数组
 */
function utf8Bytes(text) {
  const out = [];
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1); // 代理对 → 一个四字节码点
      const cp = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      i += 1;
    } else {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return out;
}

/**
 * 同步计算 sha1 十六进制摘要（约 40 行，浏览器 / Node 通用）。
 * @param {string} message 待摘要文本（UTF-8 编码）
 * @returns {string} 40 位小写十六进制摘要
 */
export function sha1Hex(message) {
  const bytes = utf8Bytes(String(message ?? ''));
  const bitLength = bytes.length * 8;
  // 补位：0x80 + 若干 0，使长度 ≡ 56 (mod 64)，末尾追加 64 位大端长度
  const data = bytes.slice();
  data.push(0x80);
  while (data.length % 64 !== 56) data.push(0);
  const hi = Math.floor(bitLength / 4294967296);
  const lo = bitLength >>> 0;
  for (const v of [hi, lo]) data.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);

  let h0 = 0x67452301; let h1 = 0xefcdab89; let h2 = 0x98badcfe; let h3 = 0x10325476; let h4 = 0xc3d2e1f0;
  const w = new Array(80);
  for (let offset = 0; offset < data.length; offset += 64) {
    for (let j = 0; j < 16; j += 1) {
      const p = offset + j * 4;
      w[j] = (data[p] << 24) | (data[p + 1] << 16) | (data[p + 2] << 8) | data[p + 3];
    }
    for (let j = 16; j < 80; j += 1) {
      const v = w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16];
      w[j] = (v << 1) | (v >>> 31);
    }
    let a = h0; let b = h1; let c = h2; let d = h3; let e = h4;
    for (let j = 0; j < 80; j += 1) {
      let f; let k;
      if (j < 20) { f = (b & c) | (~b & d); k = 0x5a827999; } else if (j < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; } else if (j < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; } else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const temp = (((a << 5) | (a >>> 27)) + f + e + k + w[j]) | 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = temp | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  return [h0, h1, h2, h3, h4].map((v) => (v >>> 0).toString(16).padStart(8, '0')).join('');
}

/**
 * 生成题目稳定 id：sha1(normalizeStem(stem)).slice(0, 16)；题干为空时退回选项文本。
 * @param {string} stem 题干
 * @param {Record<string, string>} [options] 选项（题干为空时的兜底）
 * @returns {string} 16 位 qid
 */
export function makeQid(stem, options = {}) {
  let base = normalizeStem(stem);
  if (!base) base = normalizeStem(Object.values(options || {}).join(''));
  return sha1Hex(base).slice(0, 16);
}

/**
 * 组装一道题目对象（可直接存 IndexedDB）。
 * @param {{stem:string, qtype:string, options?:Record<string,string>, answer?:string,
 *   explanation?:string, source?:string, page?:number, line?:number, para?:number, raw?:string}} input 题目字段
 * @returns {object} Question：qid/stem/qtype/options/answer/explanation/source/page/line/para/year/topic/raw
 */
export function makeQuestion(input = {}) {
  const stem = String(input.stem ?? '').trim();
  const options = { ...(input.options || {}) };
  const qtype = input.qtype || QT_SINGLE;
  const question = {
    qid: '',
    stem,
    qtype,
    options,
    answer: String(input.answer ?? '').trim(),
    explanation: String(input.explanation ?? '').trim(),
    source: input.source || 'auto',
    page: toInt(input.page),
    line: toInt(input.line),
    para: toInt(input.para),
    year: extractYear(stem),
    topic: extractTopic(stem),
    raw: String(input.raw ?? '').trim() || stem,
  };
  if (qtype === QT_JUDGE) question.answer = normalizeJudge(question.answer) || question.answer;
  else if (qtype === QT_SINGLE || qtype === QT_MULTI) question.answer = normalizeChoice(question.answer) || question.answer;
  question.qid = makeQid(stem, options);
  return question;
}

/* ================================================================
 * 4. 小工具
 * ================================================================ */

/**
 * 转成整数（非法值一律为 0）。
 * @param {unknown} value 任意值
 * @returns {number} 整数
 */
function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/**
 * 安全转字符串（对象 toString 抛异常时返回空串，避免兜底逻辑自己崩掉）。
 * @param {unknown} value 任意值
 * @returns {string} 文本
 */
function safeText(value) {
  try {
    return value === null || value === undefined ? '' : String(value);
  } catch (err) {
    return '';
  }
}

/**
 * 清洗单行文本：去掉不换行空格 / BOM / 零宽字符与回车；保留内部换行与制表符。
 * @param {unknown} text 原始文本
 * @returns {string} 清洗后的文本
 */
function cleanText(text) {
  let s = safeText(text);
  s = s.replace(/\u00a0/g, ' ').replace(/[\ufeff\u200b\u200e\u200f\r]/g, '');
  return s;
}

/**
 * 与 storage.nowStr() 一致的日志时间格式。
 * @returns {string} `YYYY-MM-DD HH:MM:SS`
 */
function nowStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 人类可读的位置描述，用于 warnings 文案。
 * @param {number} page 页码
 * @param {number} line 行号
 * @param {number} para 段落号
 * @returns {string} 位置描述
 */
function posLabel(page, line, para) {
  if (page) return `第${page}页第${line}行`;
  if (para) return `第${para}段`;
  if (line) return `第${line}行`;
  return '未知位置';
}

/**
 * 构造一条 errors 记录（字段固定：time/bank/page/line/reason/raw）。
 * @param {string} bank 题库名
 * @param {number} page 页码
 * @param {number} line 行号
 * @param {string} reason 中文原因
 * @param {string} raw 该题原始全文
 * @returns {{time:string,bank:string,page:number,line:number,reason:string,raw:string}} 记录
 */
function makeErr(bank, page, line, reason, raw) {
  return {
    time: nowStr(),
    bank: bank || '',
    page: toInt(page),
    line: toInt(line),
    reason: reason || '',
    raw: safeText(raw),
  };
}

/**
 * 构造一条 skipped 记录（字段固定：page/line/content/reason）。
 * @param {number} page 页码
 * @param {number} line 行号
 * @param {string} content 该行内容
 * @param {string} reason 中文原因
 * @returns {{page:number,line:number,content:string,reason:string}} 记录
 */
function makeSkip(page, line, content, reason) {
  return { page: toInt(page), line: toInt(line), content: content || '', reason };
}

/**
 * 去掉字符串两端的指定字符集合（对应 Python 的 str.strip(chars)）。
 * @param {string} text 文本
 * @param {string} chars 要去掉的字符集合
 * @returns {string} 结果
 */
function trimChars(text, chars) {
  const set = new Set([...chars]);
  let start = 0;
  let end = text.length;
  while (start < end && set.has(text[start])) start += 1;
  while (end > start && set.has(text[end - 1])) end -= 1;
  return text.slice(start, end);
}

/**
 * 该字符串是否是「正确/错误」类答案字面量。
 * @param {string} value 待判断文本
 * @returns {boolean} 是则 true
 */
function isJudgeValue(value) {
  return JUDGE_VALUE_RE.test(String(value ?? '').trim());
}

/**
 * 从「答案」后面的文本里解析出标准答案。
 * 依次尝试：纯字母串 → 带分隔符的字母串 → 判断题字面量 → 行首字母 token（如「D。故选D」）。
 * @param {string} value 「答案」标记后面的文本
 * @returns {string} 归一化答案；解析不出来返回空串（调用方按「答案缺失」处理）
 */
function parseAnswerValue(value) {
  let v = String(value ?? '').trim();
  if (!v) return '';
  v = trimChars(v, PUNCT_TRIM);
  if (!v) return '';
  let m = CHOICE_ALL_RE.exec(v);
  if (m) return normalizeChoice(m[1]);
  if (CHOICE_SEP_RE.test(v)) {
    const letters = normalizeChoice(v);
    if (letters && letters.length <= 6) return letters;
  }
  if (v.length <= 4 && isJudgeValue(v)) return normalizeJudge(v);
  m = LEADING_LETTER_RE.exec(v);
  if (m) return normalizeChoice(m[1]);
  return '';
}

/**
 * 选项本身就是「正确/错误」（如 A.正确 B.错误）时，该题是判断题。
 * @param {Record<string,string>} options 选项表
 * @returns {boolean} 是判断题选项则 true
 */
function judgeOptions(options) {
  const keys = Object.keys(options || {});
  if (!keys.length || keys.length > 4) return false;
  const norms = [];
  for (const key of keys) {
    const value = String(options[key] ?? '').trim();
    if (!value) return false;
    const norm = normalizeJudge(value);
    if (!norm) return false;
    norms.push(norm);
  }
  return new Set(norms).size === norms.length;
}

/**
 * 题型判定：显式标记 > 判断题特征 > 选项数量 > 无选项启发式。
 * @param {string} stem 题干
 * @param {Record<string,string>} options 选项
 * @param {string} answerToken 已提取到的答案
 * @param {string} explicit 显式题型标记映射出的题型（可为空串）
 * @returns {string} 题型（QT_*）
 */
function decideType(stem, options, answerToken, explicit) {
  if (QUESTION_TYPES.includes(explicit)) return explicit;
  if (judgeOptions(options)) return QT_JUDGE; // 选项就是「正确/错误」
  if (answerToken && !normalizeChoice(answerToken) && isJudgeValue(answerToken)) return QT_JUDGE;
  const optionCount = Object.keys(options).length;
  if (optionCount >= 2) return normalizeChoice(answerToken).length >= 2 ? QT_MULTI : QT_SINGLE;
  // 没有解析到选项、但答案就是选项字母：说明是选择题（选项在原文里丢了，由 warning 提示人工核对）
  const letters = normalizeChoice(answerToken);
  if (optionCount === 0 && letters) return letters.length >= 2 ? QT_MULTI : QT_SINGLE;
  if (optionCount === 1) return QT_SINGLE;
  // 无选项：含论述类关键词判论述，其余判简答
  return ESSAY_HINT_RE.test(String(stem ?? '')) ? QT_ESSAY : QT_SHORT;
}

/* ================================================================
 * 5. 行内文本处理
 * ================================================================ */

/** 正则 → 带 g 的副本缓存，供 findAll 反复使用（不修改原正则的 lastIndex） */
const GLOBAL_RE_CACHE = new Map();

/**
 * 取出一段文本里某个正则的全部匹配（等价 Python 的 finditer）。
 * @param {RegExp} re 原正则（不带 g 也可）
 * @param {string} text 待搜索文本
 * @returns {RegExpExecArray[]} 匹配数组（含 index / groups）
 */
function findAll(re, text) {
  let global = GLOBAL_RE_CACHE.get(re);
  if (!global) {
    global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    GLOBAL_RE_CACHE.set(re, global);
  }
  global.lastIndex = 0;
  const out = [];
  let m = global.exec(text);
  while (m !== null) {
    out.push(m);
    if (m[0].length === 0) global.lastIndex += 1; // 防空匹配死循环
    m = global.exec(text);
  }
  return out;
}

/**
 * 从一段文本中提取并删除「行内解析 / 行内答案 / 括号答案」。
 * 顺序：先切解析（解析之后的全部内容都算解析），再取答案，最后处理括号答案。
 * @param {string} text 待处理文本
 * @returns {{body:string, answer:string, explanation:string, missing:boolean}}
 *   body=剩余文本，answer=答案 token，explanation=解析文本，missing=是否出现空答案括号
 */
function extractMeta(text) {
  let body = String(text ?? '');
  let explanation = '';
  let m = INLINE_EXPL_MARK_RE.exec(body);
  if (m) {
    explanation = body.slice(m.index + m[0].length).trim();
    body = body.slice(0, m.index);
  }
  let answer = '';
  m = INLINE_ANSWER_MARK_RE.exec(body);
  if (m) {
    answer = parseAnswerValue(body.slice(m.index + m[0].length));
    body = body.slice(0, m.index);
  }
  let missing = false;
  m = BRACKET_ANSWER_RE.exec(body);
  if (m) {
    if (!answer) answer = parseAnswerValue(m[1]);
    body = `${body.slice(0, m.index)} ${body.slice(m.index + m[0].length)}`;
  } else if (!answer && EMPTY_BRACKET_RE.test(body)) {
    missing = true;
  }
  return { body, answer, explanation, missing };
}

/**
 * 从 matches[start] 起取一组「字母递增」的选项 token。
 * - 字母重复 / 乱序：立即停止（重复字母的整行新题由行首兜底逻辑另行处理）
 * - 没有明确分隔符（纯空格）的 token：只有字母仍连续（A、B、C…）时才接受，
 *   避免把正文里的「…维生素 A 缺乏…」「CAD 软件」误切成选项
 * @param {RegExpExecArray[]} matches 全部选项 token
 * @param {number} start 起始下标
 * @param {string} base 起始字母
 * @returns {RegExpExecArray[]} 保留的 token 组
 */
function truncateTokens(matches, start, base) {
  const baseIndex = Math.max(0, OPTION_LETTERS.indexOf(base));
  const kept = [matches[start]];
  for (let i = start + 1; i < matches.length; i += 1) {
    const token = matches[i];
    const letter = token[1];
    if (OPTION_LETTERS.indexOf(letter) <= OPTION_LETTERS.indexOf(kept[kept.length - 1][1])) break;
    if (token.groups.sep === undefined) {
      const letters = kept.map((t) => t[1]).concat(letter);
      if (letters.some((ch, idx) => OPTION_LETTERS.indexOf(ch) !== baseIndex + idx)) break;
    }
    kept.push(token);
  }
  return kept;
}

/**
 * 尝试把一段文本切成选项。
 * 规则：第一个 token 的字母要等于「期望的下一个字母」（乱序/重复时允许行首单 token 兜底）；
 * 有前缀（题干与选项同行）时必须至少 2 个选项且每个都带明确分隔符，
 * 否则「关于 A 类与 B 类的问题」这类正文会被误切。
 * @param {Unit} unit 当前题目装配体
 * @param {string} text 待切分文本
 * @returns {{prefix:string, frags:Array<[string,string]>}|null} 前缀与选项片段；无法判定返回 null
 */
function tryOptions(unit, text) {
  const body = String(text ?? '');
  const matches = findAll(OPTION_TOKEN_RE, body);
  if (!matches.length) return null;
  const expected = unit.nextLetter() || 'A';
  let index = matches.findIndex((m) => m[1] === expected);
  let base = expected;
  if (index === -1) {
    // 期望字母没出现：只在行首 token 时才接受（应对缺少题号、字母重复的新题）
    const first = matches[0];
    if (OPTION_LETTERS.includes(first[1]) && !body.slice(0, first.index).trim()) {
      index = 0;
      base = first[1];
    } else {
      return null;
    }
  }
  const tokens = truncateTokens(matches, index, base);
  const prefix = body.slice(0, tokens[0].index);
  if (prefix.trim()) {
    if (tokens.length < 2) return null;
    if (tokens.some((t) => t.groups.sep === undefined)) return null;
  }
  const frags = tokens.map((token, i) => {
    const end = i + 1 < tokens.length ? tokens[i + 1].index : body.length;
    return [token[1], body.slice(token.index + token[0].length, end).trim()];
  });
  return { prefix: prefix.trim(), frags };
}

/**
 * 纯页码行判定；题号行（如「12.」）不算页码。
 * @param {string} text 行文本
 * @returns {boolean} 是页码行则 true
 */
function isPageNoise(text) {
  for (const pattern of [QNUM_ARABIC_RE, QNUM_PAREN_RE, QNUM_DI_RE]) {
    if (pattern.test(text)) return false;
  }
  return PAGE_NUMBER_RE.test(text) || PAGE_NUMBER_DECOR_RE.test(text) || EXTRA_PAGE_RE.test(text);
}

/**
 * 命中页眉页脚 / 推广语关键字。
 * @param {string} text 行文本
 * @returns {boolean} 命中则 true
 */
function hasNoiseKeyword(text) {
  return NOISE_KEYWORDS.some((keyword) => text.includes(keyword));
}

/**
 * 去掉行首题号。
 * @param {string} text 行文本
 * @returns {{rest:string, matched:boolean}} 剩余文本与是否匹配到题号
 */
function stripNumbering(text) {
  for (const pattern of [QNUM_ARABIC_RE, QNUM_PAREN_RE, QNUM_DI_RE]) {
    const m = pattern.exec(text);
    if (m) return { rest: text.slice(m[0].length), matched: true };
  }
  const m = QNUM_CN_RE.exec(text);
  if (m) {
    const after = text.slice(m[0].length);
    // 中文数字编号要谨慎：后面紧跟选项字母（如「一、A. 甲」）时不当题号
    if (!OPTION_AT_START_RE.test(after)) return { rest: after, matched: true };
  }
  return { rest: text, matched: false };
}

/**
 * 去掉题型标记。
 * @param {string} text 行文本
 * @returns {{rest:string, explicit:string, atStart:boolean}} 剩余文本、题型、标记是否位于行首
 */
function stripTypeMarker(text) {
  const mb = TYPE_MARK_BRACKET_RE.exec(text);
  if (mb) {
    const rest = `${text.slice(0, mb.index)} ${text.slice(mb.index + mb[0].length)}`.trim();
    return { rest, explicit: TYPE_ALIASES.get(mb[1]) || '', atStart: mb.index === 0 };
  }
  const mo = TYPE_MARK_BARE_RE.exec(text);
  if (mo) return { rest: text.slice(mo[0].length).trim(), explicit: TYPE_ALIASES.get(mo[1]) || '', atStart: true };
  return { rest: text, explicit: '', atStart: false };
}

/**
 * 判断一行是否是一道新题的起始。
 * @param {string} text 行文本（已 trim）
 * @returns {{kind:'num'|'mark'|'inline', rest:string, explicit:string, markerOnly:boolean}|null}
 *   kind=num 带题号 / mark 行首题型标记 / inline 行内题型标记；
 *   markerOnly=true 表示这只是「一、单项选择题」这类纯标题（没有题干）；null 表示不是新题起始
 */
function matchStart(text) {
  const num = stripNumbering(text);
  const marked = stripTypeMarker(num.rest);
  if (num.matched) {
    return { kind: 'num', rest: marked.rest, explicit: marked.explicit, markerOnly: Boolean(marked.explicit) && !marked.rest.trim() };
  }
  if (!marked.explicit) return null;
  if (!marked.atStart) {
    // 题型标记出现在行内（不在行首）：只用于修正当前题的题型
    return { kind: 'inline', rest: marked.rest, explicit: marked.explicit, markerOnly: false };
  }
  // 「【多选】5. 题干」这种标记在前、题号在后的写法
  const again = stripNumbering(marked.rest);
  return { kind: 'mark', rest: again.rest, explicit: marked.explicit, markerOnly: !again.rest.trim() };
}

/* ================================================================
 * 6. 题目装配
 * ================================================================ */

/** 一道题的装配过程（题干 / 选项 / 答案 / 解析 分段累积） */
class Unit {
  /**
   * @param {{page?:number,line?:number,para?:number}} line 起始行的位置信息
   */
  constructor(line = {}) {
    this.page = toInt(line.page);
    this.line = toInt(line.line);
    this.para = toInt(line.para);
    this.explicitType = '';
    /** @type {string[]} 原始全文（逐行） */
    this.rawParts = [];
    /** @type {string[]} 题干分段 */
    this.stemParts = [];
    /** @type {Record<string,string>} 选项（保持插入顺序） */
    this.options = {};
    this.answerToken = '';
    this.answerText = '';
    /** @type {string[]} 解析分段 */
    this.explParts = [];
    /** @type {string[]} 该题的警告 */
    this.flags = [];
    this.lastAction = '';
    this.pendingAnswer = false;
  }

  /** @returns {string} 位置描述 */
  get position() { return posLabel(this.page, this.line, this.para); }

  /** @returns {string} 原始全文 */
  get raw() { return this.rawParts.join('\n').trim(); }

  /** @returns {string} 题干 */
  get stem() { return this.stemParts.filter((p) => p.trim()).join('\n').trim(); }

  /** @returns {string} 解析文本 */
  get explanation() { return this.explParts.join('\n').trim(); }

  /**
   * 记录原始文本。
   * @param {string} text 原始行文本
   * @returns {void}
   */
  addRaw(text) { this.rawParts.push(text); }

  /**
   * 下一个期望的选项字母（已收集字母之外最靠前的一个）。
   * @returns {string} 字母，用尽返回空串
   */
  nextLetter() {
    for (const letter of OPTION_LETTERS) {
      if (!Object.prototype.hasOwnProperty.call(this.options, letter)) return letter;
    }
    return '';
  }

  /**
   * 追加题干片段。
   * @param {string} text 文本
   * @returns {void}
   */
  addStem(text) {
    const value = String(text ?? '').trim();
    if (value) {
      this.stemParts.push(value);
      this.lastAction = 'stem';
    }
  }

  /**
   * 登记一个选项（字母重复按最后一次为准并记 warning）。
   * @param {string} letter 选项字母
   * @param {string} text 选项文本
   * @returns {void}
   */
  addOption(letter, text) {
    const key = String(letter ?? '').toUpperCase();
    const expected = this.nextLetter();
    if (Object.prototype.hasOwnProperty.call(this.options, key)) {
      this.flags.push(`${this.position}题选项字母 ${key} 重复，已按最后一次出现为准`);
    } else if (expected && key !== expected) {
      this.flags.push(`${this.position}题选项字母不连续（期望 ${expected}，实际 ${key}），已按出现顺序保留`);
    }
    this.options[key] = String(text ?? '').trim();
    this.lastAction = 'option';
  }

  /**
   * 选项续行：接到最后一个选项文本后面。
   * @param {string} text 续行文本
   * @returns {void}
   */
  appendLastOption(text) {
    const keys = Object.keys(this.options);
    if (!keys.length) return;
    const last = keys[keys.length - 1];
    this.options[last] = `${this.options[last]}\n${text}`.trim();
  }

  /**
   * 记录答案：token 为归一化前的标准答案，text 为原文（主观题答案用它）。
   * @param {string} token 答案 token
   * @param {string} [text] 答案原文
   * @returns {void}
   */
  setAnswer(token, text = '') {
    const value = String(token ?? '').trim();
    const original = String(text ?? '').trim();
    if (value) {
      if (!this.answerToken) this.answerToken = value;
      else if (this.answerToken !== value) {
        this.flags.push(`${this.position}题出现多个答案（${this.answerToken} / ${value}），以第一次为准`);
      }
    }
    if (original && !this.answerText) this.answerText = original;
    if (value || original) this.lastAction = 'answer';
  }

  /**
   * 多行主观题答案的续行。
   * @param {string} text 续行文本
   * @returns {void}
   */
  appendAnswer(text) {
    const value = String(text ?? '').trim();
    if (!value) return;
    this.answerText = this.answerText ? `${this.answerText}\n${value}`.trim() : value;
    this.lastAction = 'answer';
  }

  /**
   * 追加解析片段。
   * @param {string} text 解析文本
   * @returns {void}
   */
  addExpl(text) {
    const value = String(text ?? '').trim();
    if (value) this.explParts.push(value);
    this.lastAction = 'explanation';
  }
}

/**
 * 把切分出的选项片段登记到题目上（片段里可能还带行内答案/解析）。
 * @param {Unit} unit 题目装配体
 * @param {Array<[string,string]>} frags 选项片段
 * @returns {void}
 */
function addFrags(unit, frags) {
  for (const [letter, frag] of frags) {
    const meta = extractMeta(frag);
    if (meta.answer) unit.setAnswer(meta.answer, meta.answer);
    unit.addOption(letter, meta.body);
    if (meta.explanation) unit.addExpl(meta.explanation);
  }
}

/**
 * 去掉题干开头的分值标注：`[2分] 1943年…` → `1943年…`；`（2分）题干` → `题干`。
 * 只处理「行首且只有分值」的情况，避免误伤正文里的数字。
 * @param {string} text
 * @returns {string}
 */
function stripLeadingScore(text) {
  return String(text || '')
    .replace(/^\s*[[【（(]\s*(?:共\s*计?|总计?)?\s*\d{1,3}\s*分\s*[\]】）)]\s*/, '')
    .trim();
}

/**
 * 处理「题号所在行」的剩余文本：先取答案/解析，再切同行选项，最后剩下的当题干。
 * 注意 `（ ）` 这种空答案括号不算答案：它保留在题干里、答案仍为空，
 * 由后面的「答案缺失」检查统一记 errors。
 * @param {Unit} unit 题目装配体
 * @param {string} rest 去掉题号/题型标记后的文本
 * @returns {void}
 */
function fillStemLine(unit, rest) {
  const meta = extractMeta(rest);
  if (meta.answer) unit.setAnswer(meta.answer, meta.answer);
  if (meta.explanation) unit.addExpl(meta.explanation);
  let body = meta.body;
  const parsed = tryOptions(unit, body);
  if (parsed) {
    addFrags(unit, parsed.frags);
    body = parsed.prefix;
  }
  unit.addStem(body);
}

/**
 * 无法归类的行：按上一步的类型续接（解析 > 选项 > 题干 > 多行答案）。
 * @param {Unit} unit 题目装配体
 * @param {string} text 行文本
 * @returns {boolean} false 表示这一行确实无法归属（由调用方记入 skipped）
 */
function appendContinuation(unit, text) {
  if (unit.lastAction === 'explanation') { unit.addExpl(text); return true; }
  if (unit.lastAction === 'option' && Object.keys(unit.options).length) { unit.appendLastOption(text); return true; }
  if (unit.lastAction === 'stem') { unit.addStem(text); return true; }
  if (unit.lastAction === 'answer' && !Object.keys(unit.options).length) { unit.appendAnswer(text); return true; }
  return false;
}

/**
 * 处理一道题内部的普通行。
 * @param {Unit} unit 题目装配体
 * @param {string} text 行文本
 * @returns {boolean} false 表示无法归属该行
 */
function handleUnitLine(unit, text) {
  // 1) 上一行是「答案：」这种只有标识没有取值的行，先把本行当答案试一次
  if (unit.pendingAnswer) {
    unit.pendingAnswer = false;
    const value = parseAnswerValue(text);
    if (value) { unit.setAnswer(value, text); return true; }
  }
  // 2) 解析行（必须早于答案行判断，否则「答案解析：…」会被当成答案）
  let m = EXPL_PREFIX_RE.exec(text);
  if (m) { unit.addExpl(m[1]); return true; }
  if (EXPL_HEADING_RE.test(text)) { unit.lastAction = 'explanation'; return true; }
  // 3) 答案行
  m = ANSWER_LINE_RE.exec(text);
  if (m) {
    const meta = extractMeta(m[1]);
    const value = meta.answer || parseAnswerValue(meta.body);
    if (value || meta.body.trim()) unit.setAnswer(value, meta.body.trim() || value);
    else unit.pendingAnswer = true;
    if (meta.explanation) unit.addExpl(meta.explanation);
    return true;
  }
  // 4) 选项（含挤在一行的情况）
  const parsed = tryOptions(unit, text);
  if (parsed) {
    if (parsed.prefix) unit.addStem(parsed.prefix);
    addFrags(unit, parsed.frags);
    return true;
  }
  // 5) 续行
  return appendContinuation(unit, text);
}

/**
 * 收尾一道题：判题型、归答案、记错误/警告、入库。
 * @param {Unit} unit 题目装配体
 * @param {object} state 解析状态（questions/pendingErrors/warnings/qErrors）
 * @param {string} bank 题库名
 * @returns {void}
 */
function finalizeUnit(unit, state, bank) {
  const stem = unit.stem;
  const options = { ...unit.options };
  const explanation = unit.explanation;
  const raw = unit.raw;
  const optionKeys = Object.keys(options);
  const qtype = decideType(stem, options, unit.answerToken, unit.explicitType);

  // 题干为空 / 无法判定题型：记 errors 并丢弃（不进 questions）
  if (!stem) {
    state.pendingErrors.push(makeErr(bank, unit.page, unit.line, '题干为空或无法判定题型，已丢弃该题', raw));
    return;
  }

  let answer = unit.answerToken;
  if (qtype === QT_SINGLE || qtype === QT_MULTI) {
    answer = normalizeChoice(answer) || answer;
  } else if (qtype === QT_JUDGE) {
    if (answer && !isJudgeValue(answer)) {
      const letters = normalizeChoice(answer);
      let mapped = '';
      if (letters.length === 1 && optionKeys.length) mapped = normalizeJudge(options[letters] || '');
      if (mapped) answer = mapped;
    }
  } else {
    answer = unit.answerText || unit.answerToken; // 主观题：保留答案原文
  }

  const question = makeQuestion({
    stem,
    qtype,
    options,
    answer,
    explanation,
    source: 'auto',
    page: unit.page,
    line: unit.line,
    para: unit.para,
    raw,
  });

  /** @type {Array<object>} 该题的 errors */
  const records = [];
  if (qtype === QT_SINGLE || qtype === QT_MULTI) {
    if (!optionKeys.length) {
      state.warnings.push(`${unit.position}题「${stem.slice(0, 18)}」被判定为${qtype}题但没有解析到选项，请人工核对`);
    }
    if (optionKeys.length && !question.answer) {
      records.push(makeErr(bank, unit.page, unit.line, '选择题有选项但答案缺失，题目已保留', raw));
      state.warnings.push(`${unit.position}题「${stem.slice(0, 18)}」答案缺失，已保留题目（详见 errors）`);
    }
  }
  if (qtype === QT_JUDGE && (!question.answer || !isJudgeValue(question.answer))) {
    records.push(makeErr(bank, unit.page, unit.line, '判断题答案缺失或无法归一化，题目已保留', raw));
    state.warnings.push(`${unit.position}题「${stem.slice(0, 18)}」判断题答案缺失或无法归一化，已保留题目（详见 errors）`);
  }

  state.questions.push(question);
  if (records.length) state.qErrors.set(state.questions.length - 1, records);
  if (unit.flags.length) state.warnings.push(...unit.flags);
}

/**
 * 从行位置信息推断来源类型（summary 展示用）。
 * @param {Array<object>} lines 行列表
 * @returns {'pdf'|'docx'|'txt'} 来源类型
 */
function inferSourceType(lines) {
  try {
    if (lines.some((l) => l && typeof l === 'object' && toInt(l.page) > 0)) return 'pdf';
    if (lines.some((l) => l && typeof l === 'object' && toInt(l.para) > 0)) return 'docx';
  } catch (err) {
    return 'txt'; // 行对象的取值器抛异常时降级，绝不因此中断解析
  }
  return 'txt';
}

/* ================================================================
 * 7. 对外接口
 * ================================================================ */

/**
 * 纯函数解析：把「题目行」列表解析成结构化题目集合。
 *
 * 不抛异常（单行坏数据只会进 `errors`），不修改入参，不依赖任何浏览器 API。
 * @param {Array<{page?:number,line?:number,para?:number,text?:string}>} lines 题目行（extract.js 的产物）
 * @param {string} [bankName] 题库名，写入 errors[].bank
 * @returns {{
 *   questions: object[],
 *   skipped: Array<{page:number,line:number,content:string,reason:string}>,
 *   errors: Array<{time:string,bank:string,page:number,line:number,reason:string,raw:string}>,
 *   warnings: string[],
 *   totalUnits: number,
 *   noiseRemoved: number,
 *   sourceType: string,
 *   summary: () => string
 * }} 解析结果（summary() 返回多行中文摘要）
 */
export function parseLines(lines, bankName = '') {
  const allLines = Array.isArray(lines) ? lines : [];
  const bank = bankName || '';
  const state = {
    questions: [],
    skipped: [],
    errors: [],
    warnings: [],
    pendingErrors: [],
    qErrors: new Map(),
    noiseRemoved: 0,
    totalUnits: allLines.length,
    sourceType: inferSourceType(allLines.filter((l) => l && typeof l === 'object')),
  };

  /** 关闭当前题（收尾入库） */
  let unit = null;
  const closeUnit = () => {
    if (unit) {
      finalizeUnit(unit, state, bank);
      unit = null;
    }
  };

  for (let i = 0; i < allLines.length; i += 1) {
    const record = allLines[i] && typeof allLines[i] === 'object' ? allLines[i] : {};
    let page = 0; let lineNo = i + 1; let para = 0; let text = '';
    try {
      page = toInt(record.page);
      lineNo = toInt(record.line) || i + 1;
      para = toInt(record.para);
      text = cleanText(record.text);
    } catch (err) {
      state.errors.push(makeErr(bank, 0, i + 1, `单行解析失败：${err && err.name ? err.name : 'Error'}: ${err && err.message ? err.message : err}`, ''));
      continue;
    }

    // 段落内可能含软换行（docx 的 <w:br/>）：按行拆开处理，位置信息沿用该段落
    for (const sub of text.split('\n')) {
      const stripped = sub.trim();
      try {
        // ---- 噪声：空白行只计数 ----
        if (!stripped) {
          state.noiseRemoved += 1;
          continue;
        }
        // ---- 噪声：纯页码行 ----
        if (isPageNoise(stripped)) {
          state.skipped.push(makeSkip(page, lineNo, stripped, '页码'));
          state.noiseRemoved += 1;
          continue;
        }
        // ---- 噪声：页眉页脚 / 推广语（本身是题干的行不按推广语跳过）----
        const start = matchStart(stripped);
        const isQuestionStart = start !== null && start.kind !== 'inline';
        if (hasNoiseKeyword(stripped) && !isQuestionStart) {
          state.skipped.push(makeSkip(page, lineNo, stripped, '页眉页脚/推广语'));
          state.noiseRemoved += 1;
          continue;
        }
        // ---- 噪声：分隔线 ----
        if (SEPARATOR_RE.test(stripped)) {
          state.skipped.push(makeSkip(page, lineNo, stripped, '分隔线'));
          state.noiseRemoved += 1;
          continue;
        }
        // ---- 噪声：纯分值标注行（「（共计280分）」「[2分]」等，不是题目）----
        if (SCORE_ONLY_RE.test(stripped)) {
          state.skipped.push(makeSkip(page, lineNo, stripped, '分值标注'));
          state.noiseRemoved += 1;
          continue;
        }

        if (start !== null) {
          const { kind, rest, explicit, markerOnly } = start;
          if (kind === 'inline') {
            // 行内题型标记：只修正题型，不切分新题
            if (unit === null) unit = new Unit(record);
            unit.addRaw(stripped);
            if (explicit && !unit.explicitType) unit.explicitType = explicit;
            if (rest && !appendContinuation(unit, rest)) unit.addStem(rest);
            continue;
          }
          closeUnit();
          // 「一、单项选择题」这类标题行，以及「一、单选题（共计280分）」这种
          // 只剩分值标注的标题行：记为 skipped，不产生空题干噪声
          if (markerOnly || SCORE_ONLY_RE.test(String(rest || '').trim())) {
            state.skipped.push(makeSkip(page, lineNo, stripped, '题型标题行'));
            continue;
          }
          unit = new Unit(record);
          unit.addRaw(stripped);
          unit.explicitType = explicit;
          // 题干开头的分值标注（如「1、[2分] 1943年…」）去掉
          fillStemLine(unit, stripLeadingScore(rest));
          continue;
        }

        // ---- 非起始行 ----
        if (unit === null) {
          state.skipped.push(makeSkip(page, lineNo, stripped, '题目外文本'));
          continue;
        }
        unit.addRaw(stripped);
        if (!handleUnitLine(unit, stripped)) {
          state.skipped.push(makeSkip(page, lineNo, stripped, '无法归属的孤行'));
        }
      } catch (err) {
        // 单行兜底：绝不因为一行坏数据中断整个解析
        state.errors.push(makeErr(
          bank,
          page,
          lineNo,
          `单行解析失败：${err && err.name ? err.name : 'Error'}: ${err && err.message ? err.message : err}`,
          sub,
        ));
      }
    }
  }
  closeUnit();

  // 错误汇总：先是被丢弃的题目，再是保留题目触发的 error
  state.errors.push(...state.pendingErrors);
  for (const records of state.qErrors.values()) state.errors.push(...records);

  const missing = state.errors.filter((e) => String(e.reason).includes('答案缺失')).length;
  if (missing) state.warnings.push(`共 ${missing} 道题答案缺失，题目已保留并记入 errors`);

  const result = {
    questions: state.questions,
    skipped: state.skipped,
    errors: state.errors,
    warnings: state.warnings,
    totalUnits: state.totalUnits,
    noiseRemoved: state.noiseRemoved,
    sourceType: state.sourceType,
  };

  /**
   * 多行中文摘要：总行数、成功题数、按题型统计、跳过行数、异常数、警告数。
   * @returns {string} 摘要文本
   */
  result.summary = () => {
    const out = [];
    out.push(`文件类型：${SOURCE_TYPE_CN[state.sourceType] || state.sourceType || '未知'}`);
    out.push(`读取总行数：${state.totalUnits} 行`);
    out.push(`成功解析题目：${state.questions.length} 道`);
    const counter = new Map();
    for (const q of state.questions) counter.set(q.qtype, (counter.get(q.qtype) || 0) + 1);
    if (counter.size) {
      for (const qtype of QUESTION_TYPES) {
        if (counter.get(qtype)) out.push(`    ${qtype}题：${counter.get(qtype)} 道`);
      }
      for (const [qtype, num] of counter) {
        if (!QUESTION_TYPES.includes(qtype)) out.push(`    ${qtype}题：${num} 道`);
      }
    } else {
      out.push('    （无）');
    }
    out.push(`跳过行数：${state.skipped.length} 行（其中噪声清理 ${state.noiseRemoved} 行）`);
    out.push(`解析异常：${state.errors.length} 条`);
    out.push(`警告：${state.warnings.length} 条`);
    for (const text of state.warnings.slice(0, 3)) out.push(`    ! ${text}`);
    if (state.warnings.length > 3) out.push(`    … 其余 ${state.warnings.length - 3} 条警告见 warnings`);
    return out.join('\n');
  };

  return result;
}
