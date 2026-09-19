// IndexedDB 统一入口：数据库 morandi-chat 的 schema 版本集中在这里维护。
//
// 版本升级规则：把 DB_VERSION +1，并在 createStores 里补建缺失的 store。
// IndexedDB 的 onupgradeneeded 只在版本变化时触发，所以同一段代码既负责首次创建，
// 也负责把老版本就地升级（老数据保留，只是补结构）。
//
// 目前包含：
//   conversations —— 每个对话一条记录（keyPath = id），见 conversationStore.js
//   fullResults   —— 工具调用结果全文，见 fullResultsStore.js
//   meta          —— schema 版本与迁移标记
// 附件内容仍放在独立的 morandi-chat-attachments 库（见 attachmentStore.js）：
// 它属于缓存性质的数据，独立库可以避免两边版本互相牵制，需要时再合并。

const DB_NAME = "morandi-chat";
const DB_VERSION = 2; // v1: fullResults；v2: 新增 conversations 与 meta

export const SCHEMA_VERSION = 2;
export const STORE_CONVERSATIONS = "conversations";
export const STORE_FULL_RESULTS = "fullResults";
export const STORE_META = "meta";

let dbPromise = null;

function createStores(db) {
  if (!db.objectStoreNames.contains(STORE_FULL_RESULTS)) {
    db.createObjectStore(STORE_FULL_RESULTS, { keyPath: "callId" });
  }
  if (!db.objectStoreNames.contains(STORE_CONVERSATIONS)) {
    db.createObjectStore(STORE_CONVERSATIONS, { keyPath: "id" });
  }
  if (!db.objectStoreNames.contains(STORE_META)) {
    db.createObjectStore(STORE_META, { keyPath: "key" });
  }
}

export function openChatDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => createStores(req.result);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("本地数据库被其它标签页占用，请关闭后重试"));
  });
  return dbPromise;
}

// 运行一个事务并等待其完成；store 操作在 fn 内执行
export async function withStore(storeName, mode, fn) {
  const db = await openChatDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
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

// 测试辅助：重置模块级连接缓存，强制下次重新打开数据库
export function _resetDBCache() {
  dbPromise = null;
}
