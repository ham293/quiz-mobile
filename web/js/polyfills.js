/**
 * 现代 JS API 补齐（polyfill）。
 *
 * 为什么需要：pdf.js 5 用了一批较新的 API（实测 web/vendor/pdf.min.mjs 里
 * `Promise.withResolvers` 出现 26 次、`structuredClone` 4 次等）。
 * 这些 API 要 Chrome/WebView 119（2023-11）之后才有；国产 ROM 或旧机型上的
 * WebView 可能更老，缺了就会在解析 PDF 时抛出「xxx is not a function」，
 * 表现为「打不开 / 提取不到文字」。这里做最小可行的补齐。
 *
 * 必须在其它模块（尤其是 extract.js）之前 import。
 */

/** Promise.withResolvers —— pdf.js 用得最多，缺了基本必挂 */
if (typeof Promise.withResolvers !== 'function') {
  // eslint-disable-next-line no-extend-native
  Promise.withResolvers = function withResolvers() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

/** Object.hasOwn */
if (typeof Object.hasOwn !== 'function') {
  // eslint-disable-next-line no-extend-native
  Object.hasOwn = function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  };
}

/** Array.prototype.at / String.prototype.at */
if (typeof Array.prototype.at !== 'function') {
  // eslint-disable-next-line no-extend-native
  Object.defineProperty(Array.prototype, 'at', {
    value: function at(index) {
      const len = this.length >>> 0;
      const i = Math.trunc(index) || 0;
      return i < 0 ? this[len + i] : this[i];
    },
    writable: true,
    configurable: true,
  });
}
if (typeof String.prototype.at !== 'function') {
  // eslint-disable-next-line no-extend-native
  Object.defineProperty(String.prototype, 'at', {
    value: function at(index) {
      const len = this.length;
      const i = Math.trunc(index) || 0;
      return i < 0 ? this[len + i] : this[i];
    },
    writable: true,
    configurable: true,
  });
}

/** String.prototype.replaceAll */
if (typeof String.prototype.replaceAll !== 'function') {
  // eslint-disable-next-line no-extend-native
  Object.defineProperty(String.prototype, 'replaceAll', {
    value: function replaceAll(search, replacement) {
      const s = String(this);
      if (search instanceof RegExp) {
        if (!search.global) {
          throw new TypeError('replaceAll must be called with a global RegExp');
        }
        return s.replace(search, replacement);
      }
      return s.split(String(search)).join(replacement);
    },
    writable: true,
    configurable: true,
  });
}

/** Array.prototype.flat / flatMap（老 WebView 也常缺，pdf.js 依赖） */
if (typeof Array.prototype.flat !== 'function') {
  // eslint-disable-next-line no-extend-native
  Object.defineProperty(Array.prototype, 'flat', {
    value: function flat(depth = 1) {
      const result = [];
      const walk = (arr, d) => {
        for (const item of arr) {
          if (Array.isArray(item) && d > 0) walk(item, d - 1);
          else result.push(item);
        }
      };
      walk(this, Math.trunc(depth) || 0);
      return result;
    },
    writable: true,
    configurable: true,
  });
}

/** globalThis.structuredClone（只做兜底实现：优先原生，缺失时用 JSON 近似） */
if (typeof globalThis.structuredClone !== 'function') {
  globalThis.structuredClone = function structuredCloneFallback(value) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return value;
    }
  };
}

/** queueMicrotask */
if (typeof globalThis.queueMicrotask !== 'function') {
  globalThis.queueMicrotask = (cb) => Promise.resolve().then(cb);
}

/** 环境自检用：返回当前补齐情况，供「自检」页展示 */
export function polyfillReport() {
  return [
    { name: 'Promise.withResolvers', ok: typeof Promise.withResolvers === 'function' },
    { name: 'structuredClone', ok: typeof globalThis.structuredClone === 'function' },
    { name: 'Object.hasOwn', ok: typeof Object.hasOwn === 'function' },
    { name: 'Array.prototype.at', ok: typeof Array.prototype.at === 'function' },
    { name: 'String.prototype.replaceAll', ok: typeof String.prototype.replaceAll === 'function' },
    { name: 'Array.prototype.flat', ok: typeof Array.prototype.flat === 'function' },
    { name: 'queueMicrotask', ok: typeof globalThis.queueMicrotask === 'function' },
  ];
}
