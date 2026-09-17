/**
 * 界面截图工具：通过 Chrome DevTools Protocol 驱动 headless Chrome，
 * 逐个页面渲染完成后截图（避免 --screenshot + --virtual-time-budget 抢跑）。
 *
 * 用法：
 *   1) 先启动 Chrome：chrome --headless=new --remote-debugging-port=9222 --user-data-dir=<临时目录> about:blank
 *   2) node tests/shoot.mjs [输出目录]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CDP_PORT = process.env.CDP_PORT || '9222';
const CDP = `http://127.0.0.1:${CDP_PORT}`;
const OUT = resolve(process.argv[2] || 'tests/shots');
const ONLY = process.argv.slice(3);
const BASE = 'http://127.0.0.1:8765/tests/browser-shot.html';

const ALL_SCREENS = [
  ['banks', '题库列表'],
  ['practice', '练习首页'],
  ['session', '答题中'],
  ['report', '练习报告'],
  ['wrong', '错题本'],
  ['favorites', '收藏本'],
  ['stats', '统计'],
  ['logs', '解析日志'],
  ['manual', '手动补录'],
  ['settings', '设置'],
  ['about', '关于'],
];
const SCREENS = ONLY.length ? ALL_SCREENS.filter(([s]) => ONLY.includes(s)) : ALL_SCREENS;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  const list = await (await fetch(`${CDP}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('找不到可用的页面目标');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve: res, reject: rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(JSON.stringify(msg.error)));
      else res(msg.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const myId = ++id;
      pending.set(myId, { resolve: res, reject: rej });
      ws.send(JSON.stringify({ id: myId, method, params }));
    });
  return { send, ws };
}

async function evaluate(send, expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result ? r.result.value : undefined;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const { send } = await connect();
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true }); // 避免拿旧的 CSS/JS
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });

  for (const [screen, label] of SCREENS) {
    const url = `${BASE}?seed=1&screen=${screen}`;
    await send('Page.navigate', { url });
    // 等页面渲染出内容（最长 20 秒）
    let chars = 0;
    for (let i = 0; i < 100; i++) {
      await sleep(200);
      chars = (await evaluate(send, "document.getElementById('screen') ? document.getElementById('screen').textContent.trim().length : 0")) || 0;
      if (chars > 0) break;
    }
    await sleep(400);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(resolve(OUT, `${screen}.png`), Buffer.from(shot.data, 'base64'));
    console.log(`${screen.padEnd(10)} ${label}  文本 ${chars} 字符  已保存 ${screen}.png`);
  }
  console.log(`\n截图输出目录：${OUT}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('截图失败：', err && err.stack ? err.stack : err);
  process.exit(1);
});
