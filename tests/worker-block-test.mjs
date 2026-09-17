/**
 * 决定性实验：在"取不到字符集"的环境下，验证中文 PDF 还能不能解码出文字。
 *
 * 两种模式（环境变量 BLOCK_ALL）：
 *   - 默认：只屏蔽 **Worker** 目标里的 cmaps 请求（精确模拟安卓 WebView：
 *     Capacitor 的 shouldInterceptRequest 不拦截 Worker 发出的请求）
 *   - BLOCK_ALL=1：页面与 Worker 里**全部**屏蔽 cmaps 请求，即"彻底断网"，
 *     用来验证内嵌字符集（web/js/cmaps-data.js）这条路是真的不依赖网络
 *
 * 用法：
 *   chrome --headless=new --remote-debugging-port=9224 --user-data-dir=<临时> about:blank
 *   node tests/worker-block-test.mjs            # 只断 Worker
 *   BLOCK_ALL=1 node tests/worker-block-test.mjs # 全断
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PORT = process.env.CDP_PORT || '9224';
const BLOCK_ALL = process.env.BLOCK_ALL === '1';
const CDP = `http://127.0.0.1:${PORT}`;
const URL_PAGE = 'http://127.0.0.1:8765/tests/pdf-only-test.html';
const OUT = resolve('tests/shots');

// 注意：模式必须精确匹配 vendor 下的字符集目录。
// 早先用过 '*cmaps*'，结果把 web/js/cmaps-data.js（内嵌数据模块）也拦了，
// 会造出「模块加载失败」的假象 —— 那不是我们要模拟的情况。
const BLOCKED_URLS = ['*/vendor/cmaps/*', '*/vendor/standard_fonts/*'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  const list = await (await fetch(`${CDP}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('找不到页面目标');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });

  let id = 0;
  const pending = new Map();
  /** 收到的事件回调 */
  const listeners = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve: res, reject: rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(JSON.stringify(msg.error)));
      else res(msg.result);
      return;
    }
    for (const fn of listeners) fn(msg);
  };
  const send = (method, params = {}, sessionId = undefined) =>
    new Promise((res, rej) => {
      const myId = ++id;
      pending.set(myId, { resolve: res, reject: rej });
      ws.send(JSON.stringify({ id: myId, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const on = (fn) => listeners.push(fn);
  return { send, on };
}

/** 挂上的 Worker 会话：在它们里屏蔽 cmaps / standard_fonts 请求 */
const blockedWorkers = [];

async function main() {
  mkdirSync(OUT, { recursive: true });
  const { send, on } = await connect();

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  });

  // 全断模式：主线程（页面）里也屏蔽 cmaps
  if (BLOCK_ALL) {
    await send('Network.enable');
    await send('Network.setBlockedURLs', { urls: BLOCKED_URLS });
    console.log('已屏蔽主线程的 cmaps 请求（全断模式）');
  }

  // 每个新出现的 worker 目标：单独屏蔽 cmaps 请求
  on(async (msg) => {
    if (msg.method !== 'Target.attachedToTarget') return;
    const info = msg.params.targetInfo;
    if (info.type !== 'worker' && info.type !== 'service_worker' && info.type !== 'shared_worker') return;
    const sessionId = msg.params.sessionId;
    blockedWorkers.push(sessionId);
    try {
      await send('Network.enable', {}, sessionId);
      await send('Network.setBlockedURLs', { urls: BLOCKED_URLS }, sessionId);
      console.log(`已屏蔽 Worker(${info.url.split('/').pop()}) 的 cmaps 请求`);
    } catch (err) {
      console.warn('屏蔽失败:', err.message);
    }
  });

  console.log(`打开页面：${URL_PAGE}`);
  await send('Page.navigate', { url: URL_PAGE });

  let result = null;
  for (let i = 0; i < 120; i += 1) {
    await sleep(250);
    const r = await send('Runtime.evaluate', {
      expression: 'JSON.stringify(window.__result || null)',
      returnByValue: true,
    });
    const val = r.result && r.result.value;
    if (val && val !== 'null') {
      result = JSON.parse(val);
      break;
    }
  }

  console.log(`Worker 目标数：${blockedWorkers.length}`);
  console.log('提取结果:', JSON.stringify(result, null, 2));

  const ok = !!(result && result.ok);
  console.log(ok
    ? `\n✅ 通过：Worker 取不到 cmaps 时，主线程接管后仍提取到 ${result.chars} 个字符（${result.lines} 行）`
    : '\n❌ 失败：仍然提取不到文字');
  writeFileSync(resolve(OUT, 'worker-block-result.json'), JSON.stringify({ blockedWorkers: blockedWorkers.length, result }, null, 2));
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('测试失败：', err);
  process.exit(1);
});
