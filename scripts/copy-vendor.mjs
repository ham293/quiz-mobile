#!/usr/bin/env node
/**
 * copy-vendor.mjs —— 把 node_modules 里的第三方库拷贝到 web/vendor/，
 * 让 Capacitor 打包出来的 APK 在**完全离线**的情况下也能解析 Word / PDF、导出 PDF。
 *
 * 用法：
 *   npm run vendor        # 或 node scripts/copy-vendor.mjs
 *   node scripts/copy-vendor.mjs --verbose   # 额外打印每个 cmap/字体文件
 *
 * 特性：
 *   - 自动 mkdir -p（web/vendor/ 不存在时自动创建）
 *   - 幂等：重复运行安全；源文件与目标文件大小/时间一致时跳过拷贝
 *   - 任一必需源文件缺失：逐个打印中文提示，最后 process.exitCode = 1
 *
 * ⚠️ 路径都是**实测**确认过的（pdfjs-dist@5.7.284 / mammoth@1.8+ / jspdf / html2canvas），
 *    注释里写明了为什么选它、以及兜底候选。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const NODE_MODULES = path.join(ROOT, 'node_modules');
const VENDOR = path.join(ROOT, 'web', 'vendor');

const VERBOSE = process.argv.includes('--verbose');

/** 相对项目根目录的短路径，用于打印 */
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const fmt = (n) => n.toLocaleString('en-US');

/* ------------------------------------------------------------------ *
 * 一、单文件拷贝清单
 * ------------------------------------------------------------------ */
const FILE_ASSETS = [
  {
    dest: 'pdf.min.mjs',
    desc: 'pdf.js 主库（ESM）',
    // 实测：node_modules/pdfjs-dist/build/pdf.min.mjs 存在。
    // pdfjs-dist 同时提供 build/（现代浏览器）与 legacy/build/（老浏览器 + Node）。
    // APK 里的 WebView 是现代内核，用 build/ 即可；legacy 仅作兜底候选。
    candidates: [
      'pdfjs-dist/build/pdf.min.mjs',
      'pdfjs-dist/legacy/build/pdf.min.mjs',
      'pdfjs-dist/build/pdf.mjs',
    ],
  },
  {
    dest: 'pdf.worker.min.mjs',
    desc: 'pdf.js Worker 脚本（离线解析必需）',
    // 实测：pdfjs-dist/build/pdf.worker.min.mjs 存在（1.2 MB）。
    // 必须与 pdf.min.mjs 来自同一个目录，否则主库与 worker 版本不一致会报错。
    candidates: [
      'pdfjs-dist/build/pdf.worker.min.mjs',
      'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
      'pdfjs-dist/build/pdf.worker.mjs',
    ],
  },
  {
    dest: 'mammoth.browser.min.js',
    desc: 'mammoth 浏览器构建（.docx → 纯文本，UMD，挂到 globalThis.mammoth）',
    // 实测：mammoth@1.8+ 的浏览器 UMD 就在**包根目录**，没有 dist/ 子目录。
    // candidates[1] 是给「未来版本挪到 dist/」留的兜底。
    candidates: [
      'mammoth/mammoth.browser.min.js',
      'mammoth/dist/mammoth.browser.min.js',
    ],
  },
  {
    dest: 'jspdf.umd.min.js',
    desc: 'jsPDF（导出 PDF）',
    candidates: ['jspdf/dist/jspdf.umd.min.js', 'jspdf/dist/jspdf.umd.js'],
  },
  {
    dest: 'html2canvas.min.js',
    desc: 'html2canvas（把 DOM 渲成图片，保证中文不乱码）',
    candidates: [
      'html2canvas/dist/html2canvas.min.js',
      'html2canvas/dist/html2canvas.js',
    ],
  },
];

/* ------------------------------------------------------------------ *
 * 二、目录拷贝清单（pdf.js 的运行时配套数据）
 *
 * 为什么必须一起 vendor（这是实测踩到的坑，别删）：
 *   ReportLab / WPS / 方正 等导出的中文 PDF 常用「非嵌入的 CID 字体 + UniGB-UCS2-H
 *   这类 CMap」。pdf.js 解析这种字体需要去 cMapUrl 下载 <CMap名>.bcmap：
 *     - 不提供 cMapUrl → translateFont 失败 → 该页 getTextContent() 返回 **0 个 item**
 *       → 会被 extract.js 误判成「扫描版 PDF」。
 *   实测 tests/fixtures/sample-questions.pdf（2 页中文 PDF，正是这种字体）：
 *     - 不给 cMapUrl：每页 items = 0，提取到 0 个字符 ❌
 *     - 给了 cMapUrl：第 1 页 16 行、第 2 页 8 行，共 432 个非空白字符 ✅
 *   所以 cmaps/ 是**必需**资产，不是可选项；APK 离线场景更不能靠 CDN。
 *
 *   standard_fonts/ 不是提取文本的硬前提（实测只影响非嵌入标准 14 字体的
 *   字形数据，不提供只会打印一条 warning），但只有 780 KB，一起打包可以
 *   消掉告警、让后续若要渲染 PDF 也完整，故一并拷贝。
 *
 *   wasm/（1.5 MB）与 iccs/ 只跟图片解码、色彩管理有关，纯文本提取用不到，**不拷贝**。
 * ------------------------------------------------------------------ */
const DIR_ASSETS = [
  {
    dest: 'cmaps',
    desc: 'pdf.js CMap 表（中文 PDF 非嵌入 CID 字体必需）',
    src: 'pdfjs-dist/cmaps',
  },
  {
    dest: 'standard_fonts',
    desc: 'pdf.js 标准字体数据（含 LICENSE_LIBERATION / LICENSE_FOXIT，遵守许可一起拷）',
    src: 'pdfjs-dist/standard_fonts',
  },
];

/* ------------------------------------------------------------------ */

/** 读 stat，不存在返回 null（不抛错） */
async function statOrNull(p) {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

/**
 * 拷贝单个文件（自动建父目录）；大小与 mtime 一致时跳过，保证幂等。
 * @returns {Promise<{bytes:number, skipped:boolean}>}
 */
async function syncFile(srcAbs, destAbs) {
  const src = await fs.stat(srcAbs);
  const dst = await statOrNull(destAbs);
  if (dst && dst.isFile() && dst.size === src.size && dst.mtimeMs >= src.mtimeMs) {
    return { bytes: src.size, skipped: true };
  }
  await fs.mkdir(path.dirname(destAbs), { recursive: true });
  await fs.copyFile(srcAbs, destAbs);
  return { bytes: src.size, skipped: false };
}

async function main() {
  console.log('📦 拷贝第三方库到 web/vendor/（离线可用）');
  console.log(`   源: ${rel(NODE_MODULES)}/`);
  console.log(`   目标: ${rel(VENDOR)}/\n`);

  const problems = [];
  let totalBytes = 0;
  let totalFiles = 0;
  let copiedFiles = 0;

  // ---- 单文件 ----
  console.log('【1. 主库】');
  for (const asset of FILE_ASSETS) {
    // 在 candidates 里挑第一个真实存在的
    let srcAbs = null;
    for (const cand of asset.candidates) {
      const p = path.join(NODE_MODULES, ...cand.split('/'));
      if (await statOrNull(p)) {
        srcAbs = p;
        break;
      }
    }

    if (!srcAbs) {
      problems.push(
        `✗ ${asset.desc}：源文件缺失。\n` +
          `     已尝试（均不存在）: ${asset.candidates.join(' , ')}\n` +
          `     请先安装依赖：npm install，然后再跑 npm run vendor。`,
      );
      console.log(`  ✗ ${asset.dest}  —— 源文件缺失`);
      continue;
    }

    const destAbs = path.join(VENDOR, asset.dest);
    const { bytes, skipped } = await syncFile(srcAbs, destAbs);
    totalBytes += bytes;
    totalFiles += 1;
    if (!skipped) copiedFiles += 1;
    console.log(
      `  ${skipped ? '=' : '✓'} ${rel(destAbs).padEnd(38)} ${fmt(bytes).padStart(10)} 字节` +
        `   （${asset.desc}${skipped ? '，已是最新，跳过' : ''}）`,
    );
    console.log(`      来源: ${rel(srcAbs)}`);
  }

  // ---- 目录 ----
  console.log('\n【2. pdf.js 运行时配套数据】');
  for (const asset of DIR_ASSETS) {
    const srcDir = path.join(NODE_MODULES, ...asset.src.split('/'));
    const st = await statOrNull(srcDir);
    if (!st || !st.isDirectory()) {
      problems.push(
        `✗ ${asset.desc}：源目录缺失 ${rel(srcDir)}/。\n` +
          `     请先安装依赖：npm install，然后再跑 npm run vendor。`,
      );
      console.log(`  ✗ ${rel(path.join(VENDOR, asset.dest))}/  —— 源目录缺失`);
      continue;
    }

    const entries = (await fs.readdir(srcDir, { withFileTypes: true }))
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort();

    const destDir = path.join(VENDOR, asset.dest);
    let dirBytes = 0;
    let dirCopied = 0;
    const lines = [];
    for (const name of entries) {
      const { bytes, skipped } = await syncFile(path.join(srcDir, name), path.join(destDir, name));
      dirBytes += bytes;
      totalBytes += bytes;
      totalFiles += 1;
      if (!skipped) dirCopied += 1;
      lines.push(`      ${skipped ? '=' : '✓'} ${rel(path.join(destDir, name)).padEnd(46)} ${fmt(bytes).padStart(9)} 字节`);
    }
    copiedFiles += dirCopied;

    console.log(
      `  ✓ ${rel(destDir)}/  —— ${entries.length} 个文件，共 ${fmt(dirBytes)} 字节` +
        `（本次新拷贝 ${dirCopied} 个）   ${asset.desc}`,
    );
    if (VERBOSE) {
      console.log(lines.join('\n'));
    } else {
      console.log(`      （加 --verbose 可逐个列出；前 3 个：${entries.slice(0, 3).join(', ')} …）`);
    }
  }

  // ---- 汇总 ----
  console.log('\n──────────── 汇总 ────────────');
  console.log(`文件总数: ${totalFiles} 个（本次实际写入 ${copiedFiles} 个，其余已是最新被跳过）`);
  console.log(`总体积  : ${fmt(totalBytes)} 字节（约 ${(totalBytes / 1024 / 1024).toFixed(2)} MB）`);
  console.log(`输出目录: ${rel(VENDOR)}/`);

  if (problems.length) {
    console.error('\n❌ 有必需文件/目录没找到，vendor 不完整：\n');
    for (const p of problems) console.error(`   ${p}\n`);
    console.error('   APK 离线运行会失败（extract.js / exporter.js 会提示「依赖未加载」）。');
    process.exitCode = 1;
    return;
  }

  console.log('\n✅ vendor 拷贝完成，web/vendor/ 已可完全离线使用。');
}

await main();
