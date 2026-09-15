// 工具调用结果全文的 IndexedDB 持久化层
// 用途：localStorage 里的 conversations 只存 120 字预览（避免撑爆配额），
// 这里单独存全文（可达 20k 字/条），刷新后异步加载回 fullResultsRef。
//
// 数据库：morandi-chat，store：fullResults（keyPath = callId）
// 字段：{ callId, full, ts }（ts 仅用于未来 LRU/清理，目前不淘汰）
//
// 所有方法返回 Promise；IndexedDB 请求异步，调用方需 await。
// 测试通过 vitest setupFiles 的 fake-indexeddb/auto 注入全局 indexedDB。

const DB_NAME = "morandi-chat";
const STORE = "fullResults";
const DB_VERSION = 1;

let dbPromise = null;

// 打开/升级数据库，返回 Promise<IDBDatabase>
// 升级事件中创建 store（仅首次打开或版本提升时触发）
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        // keyPath 用 callId（与 fullResultsRef 的 Map key 一致）
        db.createObjectStore(STORE, { keyPath: "callId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

// 运行一个事务并等待其完成；store 操作在 fn 内执行
async function withStore(mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    let result;
    try {
      result = fn(store);
    } catch (err) {
      reject(err);
      return;
    }
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// 把单个 IDBRequest 的结果包成 Promise
function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// 启动时加载全部全文：返回 Map(callId → full)
// 用于 mount 时一次性填充 fullResultsRef.current
export async function loadAllFullResults() {
  try {
    return await withStore("readonly", (store) => {
      const req = store.getAll();
      // withStore 等 oncomplete，但 getAll 的结果需在 onsuccess 时拿
      // 这里返回一个内部 Promise，由 withStore 的 oncomplete 解析
      return new Promise((res, rej) => {
        req.onsuccess = () => {
          const map = new Map();
          for (const row of req.result || []) {
            if (row && typeof row.callId === "string" && typeof row.full === "string") {
              map.set(row.callId, row.full);
            }
          }
          res(map);
        };
        req.onerror = () => rej(req.error);
      });
    });
  } catch (err) {
    // IndexedDB 不可用（隐私模式/旧浏览器/异常）时静默退化为空 Map
    console.warn("[fullResultsStore] loadAll 失败，回退空 Map：", err);
    return new Map();
  }
}

// 写入（或覆盖）一条全文记录
export async function saveFullResult(callId, full) {
  if (typeof callId !== "string" || typeof full !== "string") return;
  try {
    await withStore("readwrite", (store) => {
      store.put({ callId, full, ts: Date.now() });
    });
  } catch (err) {
    console.warn("[fullResultsStore] save 失败：", err);
  }
}

// 删除单条
export async function deleteFullResult(callId) {
  if (typeof callId !== "string") return;
  try {
    await withStore("readwrite", (store) => {
      store.delete(callId);
    });
  } catch (err) {
    console.warn("[fullResultsStore] delete 失败：", err);
  }
}

// 清空所有（用于"清除全部"等场景）
export async function clearFullResults() {
  try {
    await withStore("readwrite", (store) => {
      store.clear();
    });
  } catch (err) {
    console.warn("[fullResultsStore] clear 失败：", err);
  }
}

// 测试辅助：重置模块级 dbPromise 缓存，强制下次重新打开 DB
// （fake-indexeddb 每个 test 想要干净环境时调用）
export function _resetDBCache() {
  dbPromise = null;
}
