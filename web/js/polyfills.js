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

/** Promise.withResolvers —— pdf.js 用得最多，缺了基本必挂（Chrome 119+） */
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

/** Promise.try（Chrome 128+；pdf.js 在 PDFDocumentLoadingTask 初始化时就会调用） */
if (typeof Promise.try !== 'function') {
  // eslint-disable-next-line no-extend-native
  Promise.try = function promiseTry(fn, ...args) {
    return new Promise((resolve) => resolve(fn(...args)));
  };
}

/** URL.parse（Chrome 126+）：解析失败返回 null 而不是抛错 */
if (typeof URL.parse !== 'function') {
  // eslint-disable-next-line no-extend-native
  URL.parse = function parse(url, base) {
    try {
      return new URL(url, base);
    } catch {
      return null;
    }
  };
}

/** Uint8Array 的 base64 / hex 方法（Chrome 130+；pdf.js 用它给字体生成 data: URL） */
if (typeof Uint8Array.prototype.toBase64 !== 'function') {
  // eslint-disable-next-line no-extend-native
  Object.defineProperty(Uint8Array.prototype, 'toBase64', {
    value: function toBase64(options) {
      const url = !!(options && options.alphabet === 'base64url');
      let binary = '';
      for (let i = 0; i < this.length; i += 1) binary += String.fromCharCode(this[i]);
      let b64 = globalThis.btoa ? globalThis.btoa(binary) : Buffer.from(binary, 'binary').toString('base64');
      if (url) b64 = b64.replace(/\+/g, '-').replace(/\//g, '_');
      if (options && options.omitPadding) b64 = b64.replace(/=+$/, '');
      return b64;
    },
    writable: true,
    configurable: true,
  });
}
if (typeof Uint8Array.fromBase64 !== 'function') {
  // eslint-disable-next-line no-extend-native
  Uint8Array.fromBase64 = function fromBase64(str, options) {
    const url = !!(options && options.alphabet === 'base64url');
    let s = String(str).replace(/\s+/g, '');
    if (url) s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const binary = globalThis.atob ? globalThis.atob(s) : Buffer.from(s, 'base64').toString('binary');
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  };
}
if (typeof Uint8Array.prototype.setFromBase64 !== 'function') {
  // eslint-disable-next-line no-extend-native
  Object.defineProperty(Uint8Array.prototype, 'setFromBase64', {
    value: function setFromBase64(str, options) {
      const bytes = Uint8Array.fromBase64(str, options);
      const written = Math.min(bytes.length, this.length);
      this.set(bytes.subarray(0, written));
      return { read: String(str).length, written };
    },
    writable: true,
    configurable: true,
  });
}
if (typeof Uint8Array.prototype.toHex !== 'function') {
  // eslint-disable-next-line no-extend-native
  Object.defineProperty(Uint8Array.prototype, 'toHex', {
    value: function toHex() {
      let out = '';
      for (let i = 0; i < this.length; i += 1) out += this[i].toString(16).padStart(2, '0');
      return out;
    },
    writable: true,
    configurable: true,
  });
}
if (typeof Uint8Array.fromHex !== 'function') {
  // eslint-disable-next-line no-extend-native
  Uint8Array.fromHex = function fromHex(str) {
    const s = String(str).replace(/\s+/g, '');
    const out = new Uint8Array(Math.floor(s.length / 2));
    for (let i = 0; i < out.length; i += 1) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16) || 0;
    return out;
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

/**
 * ReadableStream 的异步迭代 —— **这是旧 WebView（Chrome 116）上 PDF 提取 0 字符的真凶**。
 *
 * pdf.js 5 的 `getTextContent()` 内部用 `for await (const chunk of readableStream)`
 * 逐块取文字；而 `ReadableStream.prototype[Symbol.asyncIterator]` 要到
 * Chrome 124 / Safari 18 才有。旧 WebView 上会抛 `TypeError: e is not async iterable`，
 * 表现为「页数读得到、文字全空」。这里按规范补上 values() 与 [Symbol.asyncIterator]。
 * （已在 Chrome 116 上实测复现并验证修复）
 */
if (typeof ReadableStream !== 'undefined' && typeof Symbol.asyncIterator === 'symbol') {
  if (typeof ReadableStream.prototype.values !== 'function') {
    // eslint-disable-next-line no-extend-native
    ReadableStream.prototype.values = function values({ preventCancel = false } = {}) {
      const reader = this.getReader();
      return {
        async next() {
          try {
            const result = await reader.read();
            if (result.done) reader.releaseLock();
            return result;
          } catch (err) {
            reader.releaseLock();
            throw err;
          }
        },
        async return(value) {
          reader.releaseLock();
          if (!preventCancel) {
            const cancelPromise = reader.cancel(value);
            return cancelPromise.then(() => ({ done: true, value }));
          }
          return { done: true, value };
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    };
  }
  if (typeof ReadableStream.prototype[Symbol.asyncIterator] !== 'function') {
    // eslint-disable-next-line no-extend-native
    ReadableStream.prototype[Symbol.asyncIterator] = ReadableStream.prototype.values;
  }
}

/** ReadableStream 是否可异步迭代（自检页展示用） */
export function streamAsyncIterableOk() {
  try {
    return (
      typeof ReadableStream !== 'undefined' &&
      typeof ReadableStream.prototype[Symbol.asyncIterator] === 'function'
    );
  } catch {
    return false;
  }
}

/** 环境自检用：返回当前补齐情况，供「自检」页展示 */
export function polyfillReport() {
  return [
    { name: 'Promise.withResolvers', ok: typeof Promise.withResolvers === 'function' },
    { name: 'Promise.try', ok: typeof Promise.try === 'function' },
    { name: 'URL.parse', ok: typeof URL.parse === 'function' },
    { name: 'Uint8Array.toBase64', ok: typeof Uint8Array.prototype.toBase64 === 'function' },
    { name: 'structuredClone', ok: typeof globalThis.structuredClone === 'function' },
    { name: 'Object.hasOwn', ok: typeof Object.hasOwn === 'function' },
    { name: 'Array.prototype.at', ok: typeof Array.prototype.at === 'function' },
    { name: 'String.prototype.replaceAll', ok: typeof String.prototype.replaceAll === 'function' },
    { name: 'Array.prototype.flat', ok: typeof Array.prototype.flat === 'function' },
    { name: 'queueMicrotask', ok: typeof globalThis.queueMicrotask === 'function' },
    { name: 'ReadableStream 异步迭代（PDF 取字关键）', ok: streamAsyncIterableOk() },
  ];
}
