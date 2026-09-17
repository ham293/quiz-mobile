/**
 * 决定性实验：模拟「安卓 WebView 里 Worker 发不出网络请求」的环境，
 * 验证 pdf.js 取不到字符集（cmaps）时，我们的 useWorkerFetch:false 修复是否有效。
 *
 * 做法：用 CDP 的 Target.setAutoAttach 挂上页面里的每个 Worker 目标，
 * 单独在这些 Worker 里把 cmaps 与 standard_fonts 的请求全部屏蔽，
 * 主线程的请求不受影响 —— 这正是安卓 WebView 的真实行为
 * （Capacitor 的 shouldInterceptRequest 不拦截 Worker 发出的请求）。
 *
 * 用法：
 *   chrome --headless=new --remote-debugging-port=9224 --user-data-dir=<临时> about:blank
 *   node tests/worker-block-test.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PORT = process.env.CDP_PORT || '9224';
const CDP = `http://127.0.0.1:${PORT}`;
const URL_PAGE = 'http://127.0.0.1:8765/tests/pdf-only-test.html';
const OUT = resolve('tests/shots');

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

  // 每个新出现的 worker 目标：单独屏蔽 cmaps 请求
  on(async (msg) => {
    if (msg.method !== 'Target.attachedToTarget') return;
    const info = msg.params.targetInfo;
    if (info.type !== 'worker' && info.type !== 'service_worker' && info.type !== 'shared_worker') return;
    const sessionId = msg.params.sessionId;
    blockedWorkers.push(sessionId);
    try {
      await send('Network.enable', {}, sessionId);
      await send('Network.setBlockedURLs', { urls: ['*cmaps*', '*standard_fonts*'] }, sessionId);
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
