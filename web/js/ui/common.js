/** UI 通用工具：DOM 构造、Toast、加载遮罩、底部弹层、确认框 */

/**
 * 创建元素。
 * @param {string} tag 标签名，支持 'div.cls#id'
 * @param {object} [attrs] 属性；`text`/`html` 特殊处理，`on` 前缀为事件，`dataset` 为 data-*
 * @param {Array<Node|string>} [children]
 * @returns {HTMLElement}
 */
export function el(tag, attrs = {}, children = []) {
  const [name, ...rest] = String(tag).split(/(?=[.#])/);
  const node = document.createElement(name || 'div');
  for (const token of rest) {
    if (token.startsWith('.')) node.classList.add(token.slice(1));
    else if (token.startsWith('#')) node.id = token.slice(1);
  }
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'text') node.textContent = String(value);
    else if (key === 'html') node.innerHTML = String(value);
    else if (key === 'class') node.className = String(value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else node.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/** 清空并挂载子节点 */
export function mount(root, ...nodes) {
  root.textContent = '';
  for (const n of nodes.flat()) if (n) root.appendChild(n);
  return root;
}

/** HTML 转义（用于 innerHTML 拼接场景） */
export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

let toastTimer = null;
/**
 * 轻提示。
 * @param {string} message
 * @param {number} [ms]
 */
export function toast(message, ms = 2000) {
  const node = document.getElementById('toast');
  if (!node) return;
  node.textContent = message;
  node.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.add('hidden'), ms);
}

/**
 * 显示/隐藏全屏加载遮罩。
 * @param {string|false} text 传 false 表示隐藏
 */
export function loading(text) {
  const node = document.getElementById('loading');
  if (!node) return;
  if (text === false) {
    node.classList.add('hidden');
    return;
  }
  document.getElementById('loading-text').textContent = text || '处理中…';
  node.classList.remove('hidden');
}

/** 关闭底部弹层 */
export function closeSheet() {
  const mask = document.getElementById('sheet');
  if (mask) {
    mask.classList.add('hidden');
    document.getElementById('sheet-body').textContent = '';
  }
}

/**
 * 打开底部弹层。
 * @param {Node} content
 */
export function openSheet(content) {
  const mask = document.getElementById('sheet');
  const body = document.getElementById('sheet-body');
  body.textContent = '';
  // 点击遮罩关闭（点击内容区域不关闭）
  mask.onclick = (e) => {
    if (e.target === mask) closeSheet();
  };
  body.appendChild(content);
  mask.classList.remove('hidden');
}

/**
 * 确认对话框（基于底部弹层）。
 * @param {{title:string, message?:string, okText?:string, cancelText?:string, danger?:boolean}} opts
 * @returns {Promise<boolean>}
 */
export function confirmDialog(opts) {
  return new Promise((resolve) => {
    const done = (val) => {
      closeSheet();
      resolve(val);
    };
    const body = el('div', {}, [
      el('h3.card-title', { text: opts.title || '确认' }),
      opts.message ? el('p.card-sub.pre-wrap', { text: opts.message }) : null,
      el('div.grid2.mt12', {}, [
        el('button.btn', { type: 'button', text: opts.cancelText || '取消', onclick: () => done(false) }),
        el('button.btn' + (opts.danger ? '.bad' : '.primary'), {
          type: 'button',
          text: opts.okText || '确定',
          onclick: () => done(true),
        }),
      ]),
    ]);
    openSheet(body);
  });
}

/**
 * 底部选择菜单。
 * @param {{title?:string, items:Array<{label:string, value:any, hint?:string}>}} opts
 * @returns {Promise<any|null>}
 */
export function actionSheet(opts) {
  return new Promise((resolve) => {
    const done = (val) => {
      closeSheet();
      resolve(val);
    };
    const children = [el('h3.card-title', { text: opts.title || '请选择' })];
    for (const item of opts.items) {
      children.push(
        el('button.btn.block.mb8', {
          type: 'button',
          style: { justifyContent: 'space-between' },
          onclick: () => done(item.value),
        }, [
          el('span', { text: item.label }),
          item.hint ? el('span.tiny.muted', { text: item.hint }) : null,
        ]),
      );
    }
    children.push(el('button.btn.block.mt8', { type: 'button', text: '取消', onclick: () => done(null) }));
    openSheet(el('div', {}, children));
  });
}

/**
 * 空状态。
 * @param {string} icon
 * @param {string} text
 * @param {{label?:string, onClick?:Function}} [action]
 */
export function emptyState(icon, text, action) {
  const node = el('div.empty', {}, [
    el('span.big', { text: icon }),
    el('div', { text }),
  ]);
  if (action && action.label) {
    node.appendChild(el('button.btn.primary.mt12', { type: 'button', text: action.label, onclick: action.onClick }));
  }
  return node;
}

/** 百分比格式化 */
export function pct(n) {
  const v = Number(n || 0);
  return `${Math.round(v * 10) / 10}%`;
}

/** 小节标题 */
export function sectionTitle(text) {
  return el('h2.card-title.mt12', { text });
}

/** 键值行 */
export function kv(label, value) {
  return el('div.row.between', {}, [
    el('span.muted.small', { text: label }),
    el('span.small.bold', { text: String(value) }),
  ]);
}
