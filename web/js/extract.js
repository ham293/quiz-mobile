/**
 * extract.js —— 把用户选中的文件抽成「文本行」数组，交给 parser-text.js 切题。
 *
 * 支持：.docx（mammoth） / .pdf（pdf.js） / .txt / .md
 * 环境：**浏览器 / Capacitor WebView**（本模块允许访问 window/document，但全部延迟到函数内部取用）。
 *
 * 产物统一为行结构（与 docs/接口约定.md 的「题目行」一致）：
 *   { page, line, para, text }
 *
 * 各格式的编号约定（务必与 parser-text.js 对齐）：
 *   ┌────────┬──────┬──────────────────────────┬──────────────────────┐
 *   │ 格式   │ page │ line                     │ para                 │
 *   ├────────┼──────┼──────────────────────────┼──────────────────────┤
 *   │ docx   │ 0    │ = para（非空段落顺序号） │ 非空段落序号，从 1 起 │
 *   │ pdf    │ 1 起 │ 该页内行号，从 1 起      │ 0                    │
 *   │ txt/md │ 0    │ 文件真实行号（含空行）   │ 0                    │
 *   └────────┴──────┴──────────────────────────┴──────────────────────┘
 *
 * 【不要改的坑】PDF 的 cMapUrl / standardFontDataUrl 必须指向 web/vendor 下
 * 由 scripts/copy-vendor.mjs 拷进来的 cmaps/ 与 standard_fonts/：
 * ReportLab / WPS / 方正 导出的中文 PDF 常用「非嵌入 CID 字体 + UniGB-UCS2-H 这类
 * CMap」，pdf.js 解析这种字体时必须去 cMapUrl 取 <CMap名>.bcmap；取不到就
 * translateFont 失败，该页 getTextContent() 会返回 **0 个 item**，从而被误判成
 * 「扫描版 PDF」。实测 tests/fixtures/sample-questions.pdf（2 页中文 PDF）：
 *   不给 cMapUrl → 每页 0 个 item、0 个字符；给了 cMapUrl → 第 1 页 16 行、第 2 页 8 行。
 */

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/** 支持的扩展名（顺序即优先级） */
const SUPPORTED_EXTENSIONS = ['.docx', '.pdf', '.txt', '.md'];

/** PDF 按 y 聚合行时的容差（PDF 用户单位，约 1.5pt），同一行内 item 的 y 波动小于它 */
const LINE_Y_TOLERANCE = 1.5;

/** 判定「扫描版 PDF」的阈值：全篇去空白后字符数少于它即认为没有可用文字层 */
const SCANNED_PDF_MIN_CHARS = 50;

/**
 * vendor 资源地址：用 `new URL('../vendor/xxx', import.meta.url)` 把**相对路径**
 * 解析成绝对 URL。extract.js 位于 web/js/ 下，所以 `../vendor/` 就是 web/vendor/。
 * - Capacitor Android：webDir 由本地服务器以 https://localhost 提供，
 *   解析结果是 https://localhost/vendor/pdf.worker.min.mjs，与页面同源，Worker 可用；
 * - 普通浏览器（含子目录部署、以及 http:// 本地调试）：同样能正确解析；
 * - 又因为 Worker 必须与页面同源，绝对 URL 比写死相对字符串更稳妥
 *   （相对字符串是相对 **HTML 文档** 解析的，一旦页面本身在子目录就会错位）。
 */
const PDF_LIB_URL = new URL('../vendor/pdf.min.mjs', import.meta.url).href;
const PDF_WORKER_URL = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
/**
 * legacy（兼容版）构建：转译过、不依赖较新语法/API，专门给旧 WebView 兜底。
 * 现代构建在个别 Android 机上会抛 InvalidPDFException / 莫名的 TypeError，
 * 遇到就自动换成这一份重试（见 extractPdf）。
 */
const PDF_LEGACY_LIB_URL = new URL('../vendor/pdf.legacy.min.mjs', import.meta.url).href;
const PDF_LEGACY_WORKER_URL = new URL('../vendor/pdf.worker.legacy.min.mjs', import.meta.url).href;
const PDF_CMAP_URL = new URL('../vendor/cmaps/', import.meta.url).href;
const PDF_STANDARD_FONTS_URL = new URL('../vendor/standard_fonts/', import.meta.url).href;
const MAMMOTH_URL = new URL('../vendor/mammoth.browser.min.js', import.meta.url).href;

/* ------------------------------------------------------------------ *
 * 错误类型
 * ------------------------------------------------------------------ */

/**
 * 抽取阶段的业务错误：message 是**给用户看的中文文案**（app.js 会直接 toast 出来），
 * 不含英文堆栈。原始异常只走 console.warn 便于排查。
 */
export class ExtractError extends Error {
  /** @param {string} message 面向用户的中文提示 */
  constructor(message) {
    super(message);
    this.name = 'ExtractError';
  }
}

/* ------------------------------------------------------------------ *
 * 公共 API
 * ------------------------------------------------------------------ */

/**
 * 按扩展名判断是否支持该文件（不看内容，纯文件名判断）。
 * @param {File|Blob|string} file 文件对象（需带 .name）或文件名字符串
 * @returns {boolean} 支持返回 true
 */
export function isSupported(file) {
  const ext = getExtension(resolveFileName(file, null));
  return SUPPORTED_EXTENSIONS.includes(ext);
}

/**
 * 抽取文本行。
 * @param {File|Blob} file 用户选择的文件；需具备 .arrayBuffer() / .text()，
 *        建议是 File（带 .name，用于判断格式）；Blob 可通过 opts.name 补文件名。
 * @param {{name?: string, [key: string]: any}} [opts] 可选参数
 *        - name: file 没有 .name 时用它判断格式（Blob 兼容）
 * @returns {Promise<{lines: Array<{page:number,line:number,para:number,text:string}>,
 *   kind: 'docx'|'pdf'|'txt', warnings: string[]}>}
 * @throws {ExtractError} 旧版 .doc、扫描版 PDF、缺依赖、文件损坏、格式不支持
 */
export async function extractLines(file, opts = {}) {
  if (!file || typeof file !== 'object') {
    throw new ExtractError('请选择要导入的文件。');
  }

  const warnings = [];
  const name = resolveFileName(file, opts?.name);
  const ext = getExtension(name);

  try {
    switch (ext) {
      case '.docx':
        return { lines: await extractDocx(file, warnings), kind: 'docx', warnings };

      case '.pdf':
        return { lines: await extractPdf(file, warnings), kind: 'pdf', warnings };

      case '.txt':
        return { lines: await extractPlainText(file, warnings), kind: 'txt', warnings };

      case '.md':
        warnings.push('Markdown 文件按纯文本处理（不解析标题/表格等语法）。');
        return { lines: await extractPlainText(file, warnings), kind: 'txt', warnings };

      case '.doc':
        // 旧版 Word 二进制格式，mammoth 只吃 .docx（OOXML zip）
        throw new ExtractError(
          '暂不支持 .doc 格式（旧版 Word 二进制文档），请用 Word 打开后另存为 .docx 再导入。',
        );

      default:
        throw new ExtractError(
          name
            ? `不支持的文件格式「${name}」，仅支持 .docx / .pdf / .txt / .md。`
            : '无法识别文件类型（文件没有扩展名），仅支持 .docx / .pdf / .txt / .md。',
        );
    }
  } catch (err) {
    // ExtractError 原样抛出；其它异常一律包成中文提示，绝不把英文堆栈暴露给用户
    if (err instanceof ExtractError) throw err;
    console.warn('[extract] 抽取失败（原始错误，仅用于排查）:', err);
    throw new ExtractError(friendlyMessageFor(err, name));
  }
}

/* ------------------------------------------------------------------ *
 * 通用小工具
 * ------------------------------------------------------------------ */

/**
 * 取文件名：优先 file.name，其次 opts.name，最后空串。
 * @param {File|Blob|string} file
 * @param {string|null|undefined} fallbackName
 * @returns {string}
 */
function resolveFileName(file, fallbackName) {
  if (typeof file === 'string') return file;
  const own = file && typeof file.name === 'string' ? file.name : '';
  if (own) return own;
  return typeof fallbackName === 'string' ? fallbackName : '';
}

/**
 * 取小写扩展名（含点），没有则返回空串。
 * @param {string} name
 * @returns {string}
 */
function getExtension(name) {
  const n = String(name || '');
  const dot = n.lastIndexOf('.');
  if (dot <= 0 || dot === n.length - 1) return '';
  return n.slice(dot).toLowerCase();
}

/**
 * 把非业务异常翻译成给用户看的中文文案。
 * @param {any} err
 * @param {string} name 文件名（用于兜底文案）
 * @returns {string}
 */
function friendlyMessageFor(err, name) {
  const raw = String(err && err.message ? err.message : err);
  if (/password/i.test(raw)) return '该 PDF 已加密，需要输入密码才能打开，请先解除密码保护再导入。';
  if (/Invalid PDF|InvalidPDF/i.test(raw)) return 'PDF 文件已损坏或不是有效的 PDF，无法解析。';
  if (/End-of-data|corrupt|Unexpected end/i.test(raw)) return '文件内容不完整或已损坏，无法解析。';
  if (/password|encrypted/i.test(raw)) return '文件已加密，无法解析。';
  return name ? `解析「${name}」失败：文件可能已损坏，或不是标准的该格式文件。` : '文件解析失败：文件可能已损坏。';
}

/* ------------------------------------------------------------------ *
 * docx
 * ------------------------------------------------------------------ */

/** mammoth 浏览器构建的加载缓存（失败时不缓存，允许重试） */
let mammothPromise = null;

/**
 * 取用 mammoth：优先用 index.html 已用 `<script>` 引入的全局对象；
 * 没有就自己注入 `<script src="../vendor/mammoth.browser.min.js">` 兜底
 * （这样即使 index.html 忘了加标签，导入 .docx 依然可用）。
 * 注意：全局变量一律**在函数里**取，不在模块顶层访问 window。
 * @returns {Promise<any>} mammoth 命名空间
 * @throws {ExtractError} 依赖未加载
 */
async function loadMammoth() {
  const existing = globalThis.mammoth;
  if (existing && typeof existing.extractRawText === 'function') return existing;

  if (!mammothPromise) {
    mammothPromise = injectScript(MAMMOTH_URL)
      .then(() => {
        const m = globalThis.mammoth;
        if (!m || typeof m.extractRawText !== 'function') {
          throw new ExtractError(
            '依赖未加载：Word 解析库（mammoth）加载后没有找到 mammoth.extractRawText，' +
              'vendor 文件可能不完整。请执行 `npm run vendor` 后重新打包 APK。',
          );
        }
        return m;
      })
      .catch((err) => {
        mammothPromise = null; // 允许下次重试
        if (err instanceof ExtractError) throw err;
        console.warn('[extract] 加载 mammoth 失败（原始错误）:', err);
        throw new ExtractError(
          '依赖未加载：Word 解析库（mammoth）读取失败，无法解析 .docx。' +
            '请确认 web/vendor/mammoth.browser.min.js 存在（执行 `npm run vendor` 重新生成），' +
            'APK 需要重新打包才能生效。',
        );
      });
  }
  return mammothPromise;
}

/**
 * 动态插入 <script> 并等它加载完（仅用于 UMD 第三方库）。
 * @param {string} url 脚本绝对地址
 * @returns {Promise<void>}
 */
function injectScript(url) {
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new ExtractError('当前环境没有 document，无法加载依赖脚本。'));
      return;
    }
    const el = document.createElement('script');
    el.src = url;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`脚本加载失败: ${url}`));
    document.head.appendChild(el);
  });
}

/**
 * 解析 .docx → 文本行。
 * 段落编号规则：**纯空白段落直接丢弃且不占用段号**，所以 para 是「非空段落」的顺序号
 * （从 1 开始，连续无空洞），line 与 para 相同；page 固定为 0。这样 parser-text.js
 * 拿到的段号是连续的，报异常日志时也不会出现空号。
 * @param {File|Blob} file
 * @param {string[]} warnings
 * @returns {Promise<Array<{page:number,line:number,para:number,text:string}>>}
 */
async function extractDocx(file, warnings) {
  const mammoth = await loadMammoth();

  const bytes = await readFileBytes(file, 'Word');
  // .docx 本质是 zip：开头必须是 PK。这样「把 .doc 改后缀」等情况能给出准确提示，
  // 而不是笼统地说「文件可能已损坏」。
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) {
    const { ascii, hex, guess } = sniffFileType(bytes);
    throw new ExtractError(
      `「${file && file.name ? file.name : '所选文件'}」的实际内容不是 .docx（开头是 ${hex}「${ascii}」${guess ? '，' + guess : ''}）。` +
        '.docx 必须是 Word 2007+ 的文档；旧版 .doc 请用 Word 打开后另存为 .docx。',
    );
  }
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

  let result;
  try {
    // 浏览器构建必须传 arrayBuffer（Node 构建才用 { path }）
    result = await mammoth.extractRawText({ arrayBuffer });
  } catch (err) {
    console.warn('[extract] mammoth.extractRawText 失败（原始错误）:', err);
    const name = (err && err.name) || 'Error';
    const msg = String((err && err.message) || err || '').slice(0, 100);
    throw new ExtractError(
      `Word 文档解析失败（${name}: ${msg}）。若确认是正常的 .docx，请把这段信息发给我定位。`,
    );
  }

  // mammoth 的提示信息（不支持的样式等）转成中文警告，供导入结果展示
  const messages = Array.isArray(result && result.messages) ? result.messages : [];
  for (const msg of messages) {
    const text = typeof msg === 'string' ? msg : msg && msg.message ? msg.message : '';
    if (text) warnings.push(`Word 解析提示：${text}`);
  }

  const raw = typeof (result && result.value) === 'string' ? result.value : '';
  const lines = rawTextToLines(raw);
  if (!lines.length) {
    throw new ExtractError(
      '这个 Word 文档里没有读到任何文字（可能是空文档，或内容全部在图片/文本框里，暂不支持）。',
    );
  }
  return lines;
}

/**
 * 把 mammoth 的纯文本切成行结构（**导出以便单测复用**，Node 下也是同一份逻辑）。
 * 归一化 CRLF/CR → LF，丢掉纯空白行，空行不占段号。
 * @param {string} raw 纯文本
 * @returns {Array<{page:number,line:number,para:number,text:string}>}
 */
export function rawTextToLines(raw) {
  const out = [];
  if (typeof raw !== 'string' || !raw) return out;
  let para = 0;
  for (const piece of raw.split(/\r\n|\r|\n/)) {
    const text = piece.trim();
    if (!text) continue; // 空行丢弃且不占段号
    para += 1;
    out.push({ page: 0, line: para, para, text });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * pdf
 * ------------------------------------------------------------------ */

/** pdf.js 模块的加载缓存（按构建版本分别缓存；失败时不缓存，允许重试） */
const pdfjsCache = new Map();

/**
 * 动态 import vendor 里的 pdf.js（ESM）。
 * 这里用 import() 而不是 <script>，是为了让 pdf.js 的 worker 机制正常工作；
 * 地址用 import.meta.url 解析，所以能随 web/ 一起搬到任意部署路径。
 * @param {'modern'|'legacy'} [variant] 用哪一份构建，默认 modern
 * @returns {Promise<any>} pdf.js 命名空间
 * @throws {ExtractError} 依赖未加载
 */
async function loadPdfLib(variant = 'modern') {
  const cached = pdfjsCache.get(variant);
  if (cached) return cached;

  const isLegacy = variant === 'legacy';
  const libUrl = isLegacy ? PDF_LEGACY_LIB_URL : PDF_LIB_URL;
  const workerUrl = isLegacy ? PDF_LEGACY_WORKER_URL : PDF_WORKER_URL;

  const promise = import(/* webpackIgnore: true */ libUrl)
    .then((mod) => {
      if (!mod || typeof mod.getDocument !== 'function') {
        throw new ExtractError(
          '依赖未加载：PDF 解析库（pdf.js）内容不完整，没有找到 getDocument。' +
            '请执行 `npm run vendor` 重新生成 web/vendor。',
        );
      }
      // worker 用相对路径解析出来的同源绝对地址；Capacitor 下即
      // https://localhost/vendor/pdf.worker.min.mjs
      mod.GlobalWorkerOptions.workerSrc = workerUrl;
      return mod;
    })
    .catch((err) => {
      pdfjsCache.delete(variant); // 允许下次重试
      if (err instanceof ExtractError) throw err;
      console.warn(`[extract] 加载 pdf.js(${variant}) 失败（原始错误）:`, err);
      throw new ExtractError(
        `依赖未加载：PDF 解析库（pdf.js ${isLegacy ? '兼容版' : '标准版'}）读取失败，无法解析 .pdf。` +
          '请确认 web/vendor 下的 pdf*.mjs 存在（执行 `npm run vendor` 重新生成），' +
          'APK 需要重新打包才能生效。',
      );
    });

  pdfjsCache.set(variant, promise);
  return promise;
}

/**
 * 解析 .pdf → 文本行（每页一个 1 起的行号序列）。
 * @param {File|Blob} file
 * @param {string[]} warnings
 * @returns {Promise<Array<{page:number,line:number,para:number,text:string}>>}
 */
/**
 * 读取文件二进制内容，并把「读不到 / 读不完整」这类问题和「文件本身有问题」区分开。
 * 安卓上从微信/QQ/网盘选文件时，ContentProvider 有时给不出内容（读到 0 字节），
 * 以前这种情况会被糊成「文件已损坏」，实际是读取失败。
 * @param {File|Blob} file
 * @param {string} kind 用于提示的格式名（如 'PDF'）
 * @returns {Promise<Uint8Array>}
 */
async function readFileBytes(file, kind) {
  if (typeof file.arrayBuffer !== 'function') {
    throw new ExtractError('该文件对象不支持读取二进制内容，请重新选择文件。');
  }
  let buffer;
  try {
    buffer = await file.arrayBuffer();
  } catch (err) {
    console.warn('[extract] file.arrayBuffer() 失败（原始错误）:', err);
    throw new ExtractError(
      `读取文件内容失败（${err && err.name ? err.name : '未知错误'}）：` +
        '如果文件来自微信 / QQ / 网盘，请先「用其他应用打开 → 保存到手机文件」再导入。',
    );
  }
  const bytes = new Uint8Array(buffer);
  const size = Number(file.size || 0);
  if (bytes.length === 0) {
    throw new ExtractError(
      size > 0
        ? `文件内容读取为空（文件本身有 ${size} 字节）：多出现在微信 / QQ / 网盘里的文件，` +
          '请先另存到手机「文件 / 下载」目录再导入。'
        : '这个文件是空的（0 字节），请换一个文件。',
    );
  }
  if (size && bytes.length < size) {
    throw new ExtractError(
      `文件只读到了 ${bytes.length} / ${size} 字节，内容不完整，无法解析。` +
        '请先把文件另存到手机本地再导入。',
    );
  }
  return bytes;
}

/** 常见文件头 → 人话，用于「后缀是 .pdf 但内容不是 PDF」的诊断 */
function sniffFileType(bytes) {
  const head = Array.from(bytes.slice(0, 8));
  const ascii = head.map((b) => (b >= 32 && b <= 126 ? String.fromCharCode(b) : '.')).join('');
  const hex = head.map((b) => b.toString(16).padStart(2, '0')).join(' ').toUpperCase();
  let guess = '';
  if (ascii.startsWith('PK')) guess = '这是一个压缩包（.zip / .docx / .xlsx 都长这样）';
  else if (ascii.startsWith('%PDF')) guess = '确实是 PDF';
  else if (ascii.startsWith('%!PS')) guess = '这是 PostScript 文件';
  else if (ascii.startsWith('{\\rtf')) guess = '这是 RTF 文档';
  else if (ascii.startsWith('DÐÏà') || hex.startsWith('D0 CF 11 E0')) guess = '这是旧版 Office 文档（.doc / .xls）';
  else if (/^\s*</.test(ascii)) guess = '这是网页/HTML 内容';
  return { ascii, hex, guess };
}

/**
 * 校验确实是 PDF：内容开头 1KB 内必须出现 %PDF-。
 * （有些 PDF 前面带 BOM 或空白，所以不能只看第 0 字节。）
 * @param {Uint8Array} bytes
 * @param {File|Blob} file
 */
function assertLooksLikePdf(bytes, file) {
  const probe = bytes.slice(0, Math.min(1024, bytes.length));
  const text = Array.from(probe, (b) => String.fromCharCode(b)).join('');
  if (text.includes('%PDF-')) return;
  const { ascii, hex, guess } = sniffFileType(bytes);
  throw new ExtractError(
    `「${file && file.name ? file.name : '所选文件'}」的实际内容不是 PDF（开头是 ${hex}「${ascii}」${guess ? '，' + guess : ''}，` +
      `大小 ${bytes.length} 字节）。可能只是改了后缀名，请换用真正的 PDF 文件。`,
  );
}

/**
 * 打开失败时给出的诊断信息：带上真实错误名与信息、文件大小、试过的所有方式，
 * 方便把问题一次说清（用户会把这个弹窗整段发出来）。
 * @param {any} err
 * @param {File|Blob} file
 * @param {Uint8Array} bytes
 * @param {string[]} [tried] 已尝试过的解析方式与各自失败原因
 * @returns {string}
 */
function describePdfFailure(err, file, bytes, tried = []) {
  const name = (err && err.name) || 'Error';
  const msg = String((err && err.message) || err || '').slice(0, 120);
  const size = bytes ? `${(bytes.length / 1024).toFixed(0)} KB` : '未知大小';
  const fileName = file && file.name ? file.name : '所选文件';

  // 自动判断几条最常见的原因，直接给结论，别让用户猜
  const hints = [];
  if (bytes && bytes.length) {
    const tail = bytes.slice(Math.max(0, bytes.length - 2048));
    const tailText = Array.from(tail, (b) => String.fromCharCode(b)).join('');
    if (!tailText.includes('%%EOF')) {
      hints.push(
        '文件末尾缺少 PDF 结束标记（%%EOF），内容很可能只读到一半（从微信 / QQ / 网盘直接选文件时常见）。' +
          '请先把文件「保存到手机文件 / 下载目录」再导入。',
      );
    }
    if (bytes.length > 30 * 1024 * 1024) {
      hints.push('文件超过 30 MB，手机内存可能不够，建议先用 WPS 压缩，或拆成几份再导入。');
    }
  }
  if (/InvalidPDF|Invalid PDF/i.test(`${name} ${msg}`)) {
    hints.push('解析库认为该文件的结构不合法（最常见的原因是内容被截断，或 PDF 被加密限制了权限）。');
  }
  if (/password/i.test(msg)) {
    hints.push('文件带密码保护，请先用 WPS / Adobe 去掉密码再导入。');
  }
  if (/Setting up fake worker|worker/i.test(`${name} ${msg}`) && !tried.length) {
    hints.push('解析用的后台线程没能启动（安卓 WebView 的常见问题），已自动改用主线程模式重试。');
  }

  return (
    `「${fileName}」（${size}）打开失败。\n` +
    `真实错误：${name}: ${msg}\n` +
    (tried.length ? `已尝试：\n· ${tried.join('\n· ')}\n` : '') +
    (hints.length ? '可能原因：\n· ' + hints.join('\n· ') + '\n' : '') +
    '把这段信息发给我即可定位。'
  );
}

/**
 * 让 pdf.js 在主线程里跑（不创建 Web Worker）。
 *
 * 为什么需要：安卓 WebView 里 `new Worker('https://localhost/...')` 经常拿不到脚本
 * （Capacitor 的本地资源拦截对 worker 请求不一定生效），于是 pdf.js 打开文档直接失败。
 * pdf.js 内部会先看 `globalThis.pdfjsWorker.WorkerMessageHandler`，
 * 有的话就完全跳过 Worker、改在主线程解析（见 PDFWorker._initialize 的实现）。
 * 所以我们自己把 worker 模块 import 进主线程挂上去即可。
 * @param {'modern'|'legacy'} variant 必须与当前使用的 pdf.js 构建一致
 */
async function enableMainThreadMode(variant) {
  const workerUrl = variant === 'legacy' ? PDF_LEGACY_WORKER_URL : PDF_WORKER_URL;
  const mod = await import(/* webpackIgnore: true */ workerUrl);
  const handler = mod && (mod.WorkerMessageHandler || (mod.default && mod.default.WorkerMessageHandler));
  if (!handler) {
    throw new Error(`worker 模块里没有 WorkerMessageHandler：${workerUrl}`);
  }
  globalThis.pdfjsWorker = { WorkerMessageHandler: handler };
  return handler;
}

/**
 * 给 promise 加超时：worker 卡死时不能一直转圈，超时按失败处理（换个方式重试）。
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超过 ${Math.round(ms / 1000)} 秒没有响应`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** 是否是「文件内容本身不合法」这类结论性错误（重试别的解析方式也没用） */
function isInvalidPdfError(err) {
  const raw = `${(err && err.name) || ''} ${(err && err.message) || err || ''}`;
  return /InvalidPDF|Invalid PDF structure/i.test(raw);
}

/** 上次成功的解析方式（记住它，下次直接用，省掉反复试错的时间） */
const PDF_STRATEGY_KEY = 'quiz.pdfStrategy';

/** @param {string} label @returns {string} */
function loadSavedStrategy() {
  try {
    return globalThis.localStorage ? globalThis.localStorage.getItem(PDF_STRATEGY_KEY) || '' : '';
  } catch {
    return '';
  }
}

/** @param {string} label */
function saveStrategy(label) {
  try {
    if (globalThis.localStorage) globalThis.localStorage.setItem(PDF_STRATEGY_KEY, label);
  } catch {
    /* 存不了就算了 */
  }
}

/**
 * 解析 .pdf → 文本行（每页一个 1 起的行号序列）。
 *
 * 依次尝试 4 种组合，哪种能跑通就用哪种（安卓 WebView 的兼容问题主要靠「主线程模式」解决）：
 *   ① 标准版 + 多线程   ② 兼容版 + 多线程   ③ 标准版 + 主线程   ④ 兼容版 + 主线程
 * 上次成功的那种会被记住，并在下次优先尝试。
 * @param {File|Blob} file
 * @param {string[]} warnings
 * @returns {Promise<Array<{page:number,line:number,para:number,text:string}>>}
 */
async function extractPdf(file, warnings) {
  const bytes = await readFileBytes(file, 'PDF');
  assertLooksLikePdf(bytes, file);

  const strategies = [
    { variant: 'modern', mainThread: false, label: '标准版+多线程', timeout: 15000 },
    { variant: 'legacy', mainThread: false, label: '兼容版+多线程', timeout: 15000 },
    { variant: 'modern', mainThread: true, label: '标准版+主线程', timeout: 60000 },
    { variant: 'legacy', mainThread: true, label: '兼容版+主线程', timeout: 60000 },
  ];

  // 上次成功的那一种排到最前面（例如这台手机必须用主线程模式）
  const saved = loadSavedStrategy();
  if (saved) {
    const idx = strategies.findIndex((s) => s.label === saved);
    if (idx > 0) strategies.unshift(strategies.splice(idx, 1)[0]);
  }

  let lastError = null;
  const tried = [];
  let contentInvalid = false;

  for (let i = 0; i < strategies.length; i += 1) {
    const strategy = strategies[i];

    // 已经判定「文件结构不合法」两次以上 → 是文件本身的问题，别再耗时间
    if (contentInvalid && tried.length >= 2) break;

    let pdfjsLib;
    try {
      pdfjsLib = await loadPdfLib(strategy.variant);
    } catch (err) {
      lastError = err;
      tried.push(`${strategy.label}：解析库加载失败（${String(err && err.message).slice(0, 40)}）`);
      continue;
    }

    try {
      const lines = await readPdfDocument(pdfjsLib, bytes, warnings, strategy);
      saveStrategy(strategy.label);
      if (tried.length) {
        warnings.push(`已改用「${strategy.label}」模式完成解析（前 ${tried.length} 种方式未成功）。`);
      }
      return lines;
    } catch (err) {
      // 扫描版 / 加密 这类结论性错误直接抛给用户，不做无谓重试
      if (err instanceof ExtractError) throw err;
      lastError = err;
      if (isInvalidPdfError(err)) contentInvalid = true;
      console.warn(`[extract] PDF 解析失败（${strategy.label}，原始错误）:`, err);
      tried.push(`${strategy.label}：${String((err && err.message) || err).slice(0, 60)}`);
    }
  }

  console.warn('[extract] PDF 解析最终失败（原始错误）:', lastError);
  throw new ExtractError(describePdfFailure(lastError, file, bytes, tried));
}

/**
 * 用指定的 pdf.js 打开文档并逐页读取文本行（不做兜底重试，异常原样抛出）。
 * @param {any} pdfjsLib 已设置好 workerSrc 的 pdf.js 命名空间
 * @param {Uint8Array} sourceBytes 原始字节（内部会复制，因为 pdf.js 会把 buffer 转移给 worker）
 * @param {string[]} warnings
 * @param {{variant?:'modern'|'legacy', mainThread?:boolean, label?:string, timeout?:number}} [strategy]
 */
async function readPdfDocument(pdfjsLib, sourceBytes, warnings, strategy = {}) {
  const { variant = 'modern', mainThread = false, label = 'PDF', timeout = 60000 } = strategy;

  if (mainThread) {
    // 必须在 getDocument 之前挂好，pdf.js 创建 PDFWorker 时会检查它
    await enableMainThreadMode(variant);
  }

  // 必须复制：pdf.js 会把这份 ArrayBuffer transfer 给 worker，之后再读会是空的
  const data = sourceBytes.slice();

  const task = pdfjsLib.getDocument({
    data,
    // ↓ 必须指向 vendor 下的配套数据，否则中文 PDF 会一行都读不出来（见文件头注释）
    cMapUrl: PDF_CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: PDF_STANDARD_FONTS_URL,
  });

  let pdf;
  try {
    pdf = await withTimeout(task.promise, timeout, label);
  } catch (err) {
    try {
      await task.destroy();
    } catch (ignored) {
      /* 清理失败无所谓 */
    }
    const raw = String(err && err.message ? err.message : err);
    if (/password/i.test(raw)) {
      throw new ExtractError('该 PDF 已加密，需要输入密码才能打开，请先解除密码保护再导入。');
    }
    throw err;
  }

  const numPages = Number(pdf.numPages) || 0;

  const lines = [];
  let totalChars = 0;
  let textPageCount = 0;

  try {
    for (let pageNumber = 1; pageNumber <= numPages; pageNumber += 1) {
      let content = null;
      try {
        const page = await pdf.getPage(pageNumber);
        content = await page.getTextContent();
      } catch (err) {
        // 单页失败不整体失败：记警告继续解析其它页，尽量让用户能导进来
        console.warn(`[extract] 第 ${pageNumber} 页文本读取失败（原始错误）:`, err);
        warnings.push(`第 ${pageNumber} 页文字读取失败，已跳过该页。`);
        continue;
      }

      // 先归一化（行首尾空白不进结果）再编号，保证 line 从 1 连续无空洞
      const pageTexts = groupTextItemsIntoLines(content ? content.items : [])
        .map((text) => text.trim())
        .filter(Boolean);
      if (!pageTexts.length) {
        warnings.push(`第 ${pageNumber} 页没有文字层（可能是图片页）。`);
        continue;
      }
      textPageCount += 1;
      pageTexts.forEach((text, idx) => {
        totalChars += text.replace(/\s/g, '').length;
        lines.push({ page: pageNumber, line: idx + 1, para: 0, text });
      });
    }
  } finally {
    // 释放 worker / 文档资源，避免连续导入多个 PDF 时内存上涨
    try {
      await pdf.destroy();
    } catch (err) {
      console.warn('[extract] pdf.destroy() 失败（可忽略）:', err);
    }
  }

  // 扫描版判定：有页面但全篇几乎没有可读文字
  if (textPageCount === 0 || totalChars < SCANNED_PDF_MIN_CHARS) {
    throw new ExtractError(
      `该 PDF 可能是扫描版/图片版（共 ${numPages} 页，仅提取到 ${totalChars} 个字符），` +
        '暂不支持 OCR 识别文字。请改用文字版 PDF，或用 Word/PDF 工具先做一次 OCR 转换后再导入。',
    );
  }

  return lines;
}

/**
 * 把 pdf.js 的 textContent.items 按 y 坐标聚合为「行」（**导出以便单测复用**：
 * Node 下的冒烟脚本会用同一个函数处理 legacy 构建读出的 item，保证浏览器/Node 行为一致）。
 *
 * 算法：
 *   1. 每个 item 取 transform[4] 作 x、transform[5] 作 y；
 *   2. y 相差在 tolerance 内的 item 归为同一行（取最近的已有行，行基准 y 用滑动平均）；
 *   3. 行按 y **从大到小**排序 —— PDF 用户坐标原点在左下角，y 越大越靠上，越先读到；
 *   4. 行内按 x 从小到大排序，靠 item 宽度估算间隙决定要不要补空格
 *      （中文 PDF 常把每个字/词拆成独立 item，无脑补空格会把整行变成「一 个 字 一 个 空 格」）。
 *
 * @param {Array<{str?:string, width?:number, height?:number, transform?:number[]}>} items
 * @param {number} [tolerance=1.5] y 方向聚合同一行的容差
 * @returns {string[]} 按阅读顺序排列的行文本
 */
export function groupTextItemsIntoLines(items, tolerance = LINE_Y_TOLERANCE) {
  const list = Array.isArray(items) ? items : [];
  /** @type {Array<{y:number, items:Array<{x:number,y:number,w:number,h:number,str:string}>}>} */
  const rows = [];

  for (const item of list) {
    if (!item || typeof item.str !== 'string') continue; // 跳过 TextMarkedContent 等非文本项
    if (!item.str.trim()) continue; // 纯空白 item 丢弃：位置信息已由相邻 item 的间隙体现

    const tr = Array.isArray(item.transform) ? item.transform : [];
    const x = Number(tr[4]);
    const y = Number(tr[5]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

    let row = null;
    let best = Infinity;
    for (const candidate of rows) {
      const delta = Math.abs(candidate.y - y);
      if (delta <= tolerance && delta < best) {
        best = delta;
        row = candidate;
      }
    }
    if (!row) {
      row = { y, items: [] };
      rows.push(row);
    }
    const w = Number(item.width);
    const h = Number(item.height);
    row.items.push({
      x,
      y,
      w: Number.isFinite(w) && w > 0 ? w : NaN,
      h: Number.isFinite(h) && h > 0 ? h : NaN,
      str: item.str,
    });
    // 行基准 y 用滑动平均，避免首项偏上/偏下把后续 item 挤出容差
    row.y += (y - row.y) / row.items.length;
  }

  rows.sort((a, b) => b.y - a.y); // y 大在上，先读

  return rows.map((row) => {
    row.items.sort((a, b) => a.x - b.x); // 行内从左到右
    let text = '';
    let prevEnd = NaN; // 上一个 item 的右边缘；NaN 表示宽度不可信，不补空格
    for (const it of row.items) {
      if (Number.isFinite(prevEnd)) {
        const gap = it.x - prevEnd;
        // 只有明显间隙才补空格：阈值取字高的 25%（至少 0.5pt），中文逐字 item 之间不会补
        const threshold = Number.isFinite(it.h) ? Math.max(0.5, it.h * 0.25) : 0.5;
        if (gap > threshold && text && !/\s$/.test(text) && !/^\s/.test(it.str)) text += ' ';
      }
      text += it.str;
      prevEnd = Number.isFinite(it.w) ? it.x + it.w : NaN;
    }
    return text;
  });
}

/* ------------------------------------------------------------------ *
 * txt / md
 * ------------------------------------------------------------------ */

/**
 * 解析 .txt/.md → 文本行。
 * line 用**文件真实行号**（空行也计数），这样与用记事本打开看到的行号一致，
 * 解析日志里报「第几行」最直观；空行本身不进结果。
 * @param {File|Blob} file
 * @param {string[]} warnings
 * @returns {Promise<Array<{page:number,line:number,para:number,text:string}>>}
 */
async function extractPlainText(file, warnings) {
  if (typeof file.text !== 'function') {
    throw new ExtractError('该文件对象不支持读取文本内容，请重新选择文件。');
  }
  // 统一按 UTF-8 解码（TextDecoder 默认非 fatal，非法字节会变成 U+FFFD，不抛错）
  const raw = await file.text();
  const out = [];
  const pieces = String(raw || '').split(/\r\n|\r|\n/);
  let lineNo = 0;
  for (const piece of pieces) {
    lineNo += 1; // 行号按原文递增（含空行）
    const text = piece.replace(/\uFEFF/g, '').trim(); // 去掉首行 BOM 与行首尾空白
    if (!text) continue;
    out.push({ page: 0, line: lineNo, para: 0, text });
  }
  if (!out.length) {
    throw new ExtractError('这个文件里没有读到任何文字（可能是空文件）。');
  }
  if (out.length < 3) {
    warnings.push('文件内容很少，可能不是完整的题库。');
  }
  return out;
}
