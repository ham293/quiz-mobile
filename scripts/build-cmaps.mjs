/**
 * 把 pdf.js 的中日韩字符集（cmaps/*.bcmap）内嵌成 JS 模块。
 *
 * 为什么必须内嵌（这是踩了几轮才确认的坑）：
 *   中文 PDF 的字体多为「非嵌入 CID 字体」，pdf.js 必须拿到对应的 CMap 才能把
 *   文字解码出来。Android WebView 里 Worker 发出的网络请求不走 Capacitor 的
 *   本地资源拦截，导致 CMap 下载失败 → 页数读得到、文字全空（用户看到的就是
 *   「可能是扫描版 PDF，0 个字符」）。把字符集直接放进 App，这条路就彻底可靠了。
 *
 * 产物：web/js/cmaps-data.js（base64 内嵌 + 查表函数，随 APK 一起打包）
 * 用法：node scripts/build-cmaps.mjs
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CMAP_DIR = join(ROOT, 'node_modules/pdfjs-dist/cmaps');
const OUT = join(ROOT, 'web/js/cmaps-data.js');

/**
 * 只内嵌中文相关的字符集（简体 + 繁体），日韩不内嵌以控制体积。
 * 需要别的语种时把前缀加进来重跑即可。
 */
const KEEP_PREFIXES = [
  'UniGB-',      // 简体中文（Unicode → CID），最常用
  'Adobe-GB1-',  // 简体中文字体的 CID → Unicode 表
  'GBK-EUC-', 'GBKp-EUC-', 'GBK2K-', 'GB-EUC-', 'GBpc-EUC-', 'GBT-EUC-', 'GBTpc-EUC-', 'GBT-',
  'UniCNS-', 'ETen-B5-', 'ETenms-B5-', 'B5pc-', 'B5-', 'HKscs-B5-', 'HKdla-B5-', 'HKdlb-B5-',
  'CNS1-', 'CNS2-', 'CNS-EUC-',
  'H.bcmap', 'V.bcmap', // 通用单字节表
];

function picked(name) {
  return KEEP_PREFIXES.some((p) => (p.endsWith('.bcmap') ? name === p : name.startsWith(p)));
}

function main() {
  let files;
  try {
    files = readdirSync(CMAP_DIR).filter((f) => f.endsWith('.bcmap'));
  } catch {
    console.error(`找不到字符集目录：${CMAP_DIR}\n请先执行 npm ci`);
    process.exit(1);
  }

  const chosen = files.filter(picked).sort();
  if (!chosen.length) {
    console.error('没有匹配到任何字符集文件，请检查 KEEP_PREFIXES');
    process.exit(1);
  }

  const parts = [];
  let rawBytes = 0;
  for (const name of chosen) {
    const buf = readFileSync(join(CMAP_DIR, name));
    rawBytes += buf.length;
    parts.push(`  ${JSON.stringify(name)}: '${buf.toString('base64')}',`);
  }

  const module = `/**
 * 【自动生成，请勿手改】内嵌的中文 PDF 字符集（CMap）数据。
 * 由 \`node scripts/build-cmaps.mjs\` 生成，共 ${chosen.length} 个文件、约 ${(rawBytes / 1024).toFixed(0)} KB。
 *
 * 用途：中文 PDF 的字体（非嵌入 CID 字体）必须靠 CMap 才能解码文字，
 * 而安卓 WebView 里 Worker 取不到本地服务器的文件；内嵌后不再依赖网络。
 */

/** 内嵌字符集个数 */
export const EMBEDDED_CMAP_COUNT = ${chosen.length};

/** 文件名 → base64（.bcmap 本身是压缩过的二进制） */
const DATA = {
${parts.join('\n')}
};

/** base64 解码缓存，避免同一 cmap 反复解码 */
const cache = new Map();

/**
 * 取内嵌的字符集数据。
 * @param {string} filename 例如 'UniGB-UCS2-H.bcmap'
 * @returns {Uint8Array|null} 命中返回字节，未内嵌返回 null
 */
export function getEmbeddedCmap(filename) {
  const name = String(filename || '').split('/').pop();
  if (!name) return null;
  if (cache.has(name)) return cache.get(name);
  const b64 = DATA[name];
  if (!b64) {
    cache.set(name, null);
    return null;
  }
  const binary = typeof atob === 'function'
    ? atob(b64)
    : Buffer.from(b64, 'base64').toString('binary');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  cache.set(name, bytes);
  return bytes;
}

/** 是否内嵌了某个字符集 */
export function hasEmbeddedCmap(filename) {
  return !!getEmbeddedCmap(filename);
}

/** 内嵌字符集文件名清单（调试用） */
export function embeddedCmapNames() {
  return Object.keys(DATA);
}
`;

  writeFileSync(OUT, module, 'utf8');
  const outSize = statSync(OUT).size;
  console.log(`已生成：${OUT}`);
  console.log(`  内嵌字符集：${chosen.length} 个（原始 ${(rawBytes / 1024).toFixed(0)} KB → 模块 ${(outSize / 1024).toFixed(0)} KB）`);
  console.log(`  示例：${chosen.slice(0, 5).join(', ')} …`);
}

main();
