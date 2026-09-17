/**
 * 存储层：优先使用 IndexedDB（手机浏览器 / APK WebView），
 * 在没有 IndexedDB 的环境（Node 单测）自动降级为内存实现，API 完全一致。
 *
 * 对象仓库：
 *   banks     keyPath 'name'
 *   wrong     keyPath ['bankName','qid']
 *   favorites keyPath ['bankName','qid']
 *   stats     keyPath 'bankName'
 *   logs      keyPath ['bankName','kind']   kind = 'errors' | 'skipped'
 *   meta      keyPath 'key'
 */

const DB_NAME = 'quiz-mobile';
const DB_VERSION = 1;

/** @type {Record<string, {keyPath: string|string[]}>} */
export const STORES = {
  banks: { keyPath: 'name' },
  wrong: { keyPath: ['bankName', 'qid'] },
  favorites: { keyPath: ['bankName', 'qid'] },
  stats: { keyPath: 'bankName' },
  logs: { keyPath: ['bankName', 'kind'] },
  meta: { keyPath: 'key' },
};

const hasIndexedDB = typeof globalThis !== 'undefined' && !!globalThis.indexedDB;
let dbPromise = null;
/** @type {Map<string, Map<string, any>>} */
const memory = new Map();

/* ------------------------------------------------------------ 内存降级 */

function memoryStore(store) {
  if (!memory.has(store)) memory.set(store, new Map());
  return memory.get(store);
}

function keyOf(store, valueOrKey) {
  const { keyPath } = STORES[store];
  const paths = Array.isArray(keyPath) ? keyPath : [keyPath];
  const parts = paths.map((p) => (typeof valueOrKey === 'object' && valueOrKey !== null ? valueOrKey[p] : valueOrKey));
  return JSON.stringify(parts);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/* -------------------------------------------------------------- 初始化 */

function openDb() {
  if (!hasIndexedDB) return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = globalThis.indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [name, conf] of Object.entries(STORES)) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: conf.keyPath });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
  });
  return dbPromise;
}

/** 在指定仓库上执行事务；mode 为 'readonly' | 'readwrite' */
async function withStore(store, mode, fn) {
  if (!STORES[store]) throw new Error(`未知的存储仓库：${store}`);
  if (!hasIndexedDB) return fn(null);
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const os = tx.objectStore(store);
    let result;
    try {
      result = fn(os);
    } catch (err) {
      reject(err);
      return;
    }
    tx.oncomplete = () => resolve(result && result.value !== undefined ? result.value : result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function reqValue(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/* ------------------------------------------------------------------ API */

/** 是否运行在内存降级模式（Node 单测） */
export function isMemoryMode() {
  return !hasIndexedDB;
}

/**
 * 写入一条记录。
 * @param {string} store
 * @param {any} value
 */
export async function put(store, value) {
  if (!hasIndexedDB) {
    memoryStore(store).set(keyOf(store, value), clone(value));
    return value;
  }
  await withStore(store, 'readwrite', (os) => os.put(clone(value)));
  return value;
}

/**
 * 批量写入。
 * @param {string} store
 * @param {any[]} values
 */
export async function bulkPut(store, values) {
  const list = Array.isArray(values) ? values : [];
  if (!hasIndexedDB) {
    const m = memoryStore(store);
    for (const v of list) m.set(keyOf(store, v), clone(v));
    return list.length;
  }
  await withStore(store, 'readwrite', (os) => {
    for (const v of list) os.put(clone(v));
  });
  return list.length;
}

/**
 * 读取一条记录。
 * @param {string} store
 * @param {string|string[]} key
 */
export async function get(store, key) {
  if (!hasIndexedDB) {
    const m = memoryStore(store);
    const k = JSON.stringify(Array.isArray(key) ? key : [key]);
    return clone(m.get(k));
  }
  return withStore(store, 'readonly', (os) => reqValue(os.get(Array.isArray(key) ? key : key)));
}

/**
 * 读取仓库全部记录。
 * @param {string} store
 */
export async function getAll(store) {
  if (!hasIndexedDB) return [...memoryStore(store).values()].map(clone);
  return withStore(store, 'readonly', (os) => reqValue(os.getAll()));
}

/**
 * 删除一条记录。
 * @param {string} store
 * @param {string|string[]} key
 */
export async function remove(store, key) {
  if (!hasIndexedDB) {
    memoryStore(store).delete(JSON.stringify(Array.isArray(key) ? key : [key]));
    return;
  }
  await withStore(store, 'readwrite', (os) => os.delete(Array.isArray(key) ? key : key));
}

/**
 * 清空整个仓库。
 * @param {string} store
 */
export async function clear(store) {
  if (!hasIndexedDB) {
    memoryStore(store).clear();
    return;
  }
  await withStore(store, 'readwrite', (os) => os.clear());
}

/** 清空所有业务数据（用于"重置 App"） */
export async function clearAll() {
  for (const store of Object.keys(STORES)) await clear(store);
}
