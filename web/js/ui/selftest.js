/**
 * 机器自检页：把「PDF 解析到底卡在哪一步」直接显示在屏幕上，
 * 用户截个图就能定位问题（比让他复制长文本可靠得多）。
 *
 * 检查项：
 *   1. App 版本、WebView 版本
 *   2. 现代 JS API 是否齐全（pdf.js 5 依赖 Promise.withResolvers 等）
 *   3. 内置的字符集表能不能取到（不应该依赖网络）
 *   4. 从服务器取字符集能不能成功（网络路径是否可用）
 *   5. 真实 PDF 解析：内置示例 PDF 用 4 种方式各能得到多少页 / 多少字符
 */

import { APP_NAME, APP_VERSION } from '../config.js';
import * as repo from '../bank.js';
import { setAction, setBackVisible } from '../app.js';
import { el, mount, toast } from './common.js';
import { polyfillReport } from '../polyfills.js';

/**
 * 跑一个检查项，失败也要返回结果而不是中断整页。
 * @param {string} name
 * @param {() => Promise<{ok: boolean, detail: string}>} fn
 * @param {{optional?: boolean}} [opts] optional=true 的项失败不算异常（仅作参考）
 */
async function runCheck(name, fn, opts = {}) {
  try {
    const r = await fn();
    return { name, ok: !!r.ok, detail: String(r.detail || ''), optional: !!opts.optional };
  } catch (err) {
    return { name, ok: false, detail: `异常：${(err && err.message) || err}`, optional: !!opts.optional };
  }
}

/**
 * 渲染自检页。
 * @param {HTMLElement} root
 */
export async function renderSelfTest(root) {
  setBackVisible(true);
  setAction(null);

  const status = el('div.pre-wrap.small', { text: '正在自检…（约需 10 秒）' });
  mount(root, el('div.card', {}, [
    el('h3.card-title', { text: '🔍 机器自检' }),
    el('p.card-sub', {
      text: '把这一步的结果截图发给开发者，就能定位「PDF 导不进来」到底卡在哪里。',
    }),
  ]), el('div.card', {}, [status]));

  const results = [];

  // 1. 版本信息
  results.push({
    name: `App 版本：v${APP_VERSION}（${APP_NAME}）`,
    ok: true,
    detail: '',
  });
  // WebView 版本只作提示：内核较老本身不算异常（所需 API 已由 polyfills 补齐，
  // 解析会自动改用 pdf.js 兼容版），所以标成 ⚠️ 参考项而不是 ❌
  results.push(await runCheck('WebView 版本（仅参考）', async () => {
    const ua = navigator.userAgent || '';
    const m = /Chrome\/(\d+)/.exec(ua);
    const major = m ? Number(m[1]) : 0;
    const old = major > 0 && major < 124;
    return {
      ok: !old,
      detail: major
        ? `Chrome/${major}${old ? '（内核较旧，所需 API 已自动补齐，解析走兼容版，不影响使用）' : ''}`
        : ua.slice(0, 60),
    };
  }, { optional: true }));

  // 2. 现代 API
  for (const item of polyfillReport()) {
    results.push({ name: `JS API：${item.name}`, ok: item.ok, detail: item.ok ? '可用' : '缺失（未补齐成功）' });
  }

  // 3. 内置字符集
  results.push(await runCheck('内置字符集表（不依赖网络）', async () => {
    const mod = await import('../cmaps-data.js');
    const bytes = mod.getEmbeddedCmap('UniGB-UCS2-H.bcmap');
    return {
      ok: !!bytes && bytes.length > 1000,
      detail: `内置 ${mod.EMBEDDED_CMAP_COUNT} 个；UniGB-UCS2-H ${bytes ? `${bytes.length} 字节` : '取不到'}`,
    };
  }));

  // 4. 网络路径取字符集（**仅作参考**：新版已改用内嵌字符集，
  //    安卓 WebView 里这条路失败是正常的，不算异常项）
  results.push(await runCheck('从服务器取字符集（仅参考）', async () => {
    // 注意：本文件在 web/js/ui/ 下，要退两级才是 web/（写错会误报 404）
    const url = new URL('../../vendor/cmaps/UniGB-UCS2-H.bcmap', import.meta.url).href;
    try {
      const resp = await fetch(url);
      const buf = resp.ok ? await resp.arrayBuffer() : null;
      return {
        ok: !!buf && buf.byteLength > 1000,
        detail: `HTTP ${resp.status}${buf ? `，${buf.byteLength} 字节` : '（不影响使用，已内嵌字符集）'}`,
      };
    } catch (err) {
      return { ok: false, detail: `请求失败（不影响使用，已内嵌字符集）：${(err && err.message) || err}` };
    }
  }, { optional: true }));

  // 5. 真实 PDF 解析（用内置示例 PDF）
  results.push(await runCheck('内置示例 PDF 解析', async () => {
    const { extractLines } = await import('../extract.js');
    const resp = await fetch(new URL('../../samples/sample-bank.pdf', import.meta.url).href);
    if (!resp.ok) return { ok: false, detail: `示例 PDF 读取失败：HTTP ${resp.status}` };
    const blob = await resp.blob();
    const file = new File([blob], 'sample-bank.pdf', { type: 'application/pdf' });
    try {
      const r = await extractLines(file);
      const chars = r.lines.reduce((n, l) => n + l.text.replace(/\s/g, '').length, 0);
      return { ok: chars > 100, detail: `${r.lines.length} 行 / ${chars} 字符${r.warnings.length ? `（提示：${r.warnings.join('；')}）` : ''}` };
    } catch (err) {
      return { ok: false, detail: String((err && err.message) || err).replace(/\n/g, ' ') };
    }
  }));

  // 6. 存储与数据
  results.push(await runCheck('本地存储（IndexedDB）', async () => {
    const banks = await repo.listBanks();
    const q = banks.reduce((n, b) => n + b.questionCount, 0);
    return { ok: true, detail: `题库 ${banks.length} 个、共 ${q} 题` };
  }));

  // 汇总
  const failed = results.filter((r) => !r.ok && !r.optional);
  const lines = results.map((r) => {
    const mark = r.ok ? '✅' : r.optional ? '⚠️' : '❌';
    return `${mark} ${r.name}${r.detail ? `　${r.detail}` : ''}`;
  });
  const summary = failed.length
    ? `发现 ${failed.length} 项异常（下面标 ❌ 的），请截图发给开发者`
    : '没有发现异常 ✅（⚠️ 是仅作参考的项，不影响使用）';

  const reportText = [
    `【刷题助手 自检报告】App v${APP_VERSION}`,
    `时间：${new Date().toLocaleString()}`,
    summary,
    '',
    ...lines,
    '',
    `UA: ${navigator.userAgent}`,
  ].join('\n');

  const reportNode = el('pre.pre-wrap.mono', {
    style: { maxHeight: '52vh', overflow: 'auto', background: 'var(--bg)', padding: '10px', borderRadius: '10px', fontSize: '12px', margin: '0' },
    text: reportText,
  });

  mount(
    root,
    el('div.card', {}, [
      el('h3.card-title', { text: '🔍 机器自检' }),
      el('p.card-sub', {
        text: failed.length
          ? '发现异常项，请把下面整段截图（或点「复制」）发给开发者。'
          : '全部通过：这台设备解析 PDF / Word 的链路正常，若仍导入失败，多半是文件本身的问题。',
      }),
    ]),
    el('div.card', {}, [reportNode]),
    el('div.grid2', {}, [
      el('button.btn', {
        type: 'button',
        text: '重新自检',
        onclick: () => renderSelfTest(root),
      }),
      el('button.btn.primary', {
        type: 'button',
        text: '复制报告',
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(reportText);
            toast('已复制自检报告');
          } catch {
            toast('复制失败，请直接截图');
          }
        },
      }),
    ]),
  );
}
