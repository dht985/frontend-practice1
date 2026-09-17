// 附件内容的 IndexedDB 持久化层
// 用途：localStorage 里的 conversations 只存附件元信息（名字/类型/大小），
// 这里按 user 节点 id 保存"真正发给模型的东西"（多模态 parts、文档抽取文本、
// 被跳过的文件说明、以及文件消息的兜底提问文本）。
//
// 有了它，重试 / 换一个回答 / 后续轮次都能重新带上原始附件，
// 而不是像以前那样只重发纯文本。
//
// 数据库：morandi-chat-attachments，store：attachments（keyPath = nodeId）
// 说明：单独一个数据库，避免和 fullResultsStore 抢同一个 DB 的版本号。

const DB_NAME = "morandi-chat-attachments";
const STORE = "attachments";
const DB_VERSION = 1;
// 单条上限（含 base64 图片/视频引用），超过则放弃持久化，避免撑爆配额
const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "nodeId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

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

// 校验并规整一份附件载荷；不合法返回 null
function normalize(payload) {
  if (!payload || typeof payload !== "object") return null;
  const parts = Array.isArray(payload.parts) ? payload.parts : [];
  const systemMessages = Array.isArray(payload.systemMessages) ? payload.systemMessages : [];
  const skipped = Array.isArray(payload.skipped) ? payload.skipped : [];
  const askText = typeof payload.askText === "string" ? payload.askText : "";
  if (!parts.length && !systemMessages.length && !skipped.length) return null;
  return { parts, systemMessages, skipped, askText };
}

// 启动时加载全部附件：返回 Map(nodeId → payload)
export async function loadAllAttachments() {
  try {
    return await withStore("readonly", (store) => {
      const req = store.getAll();
      return new Promise((res, rej) => {
        req.onsuccess = () => {
          const map = new Map();
          for (const row of req.result || []) {
            const payload = normalize(row);
            if (row && typeof row.nodeId === "string" && payload) {
              map.set(row.nodeId, payload);
            }
          }
          res(map);
        };
        req.onerror = () => rej(req.error);
      });
    });
  } catch (err) {
    // IndexedDB 不可用（隐私模式等）时退化为"本轮有效"，不阻塞对话
    console.warn("[attachmentStore] loadAll 失败，附件将只在当前标签页有效：", err);
    return new Map();
  }
}

// 写入（或覆盖）某个 user 节点的附件载荷
export async function saveAttachments(nodeId, payload) {
  if (typeof nodeId !== "string" || !nodeId) return;
  const data = normalize(payload);
  if (!data) return;
  try {
    if (JSON.stringify(data).length > MAX_PAYLOAD_BYTES) {
      console.warn(`[attachmentStore] 附件过大（>${MAX_PAYLOAD_BYTES / 1024 / 1024}MB），跳过持久化`);
      return;
    }
    await withStore("readwrite", (store) => {
      store.put({ nodeId, ...data, ts: Date.now() });
    });
  } catch (err) {
    console.warn("[attachmentStore] save 失败（可能超出配额）：", err);
  }
}

// 删除单个节点的附件
export async function deleteAttachments(nodeId) {
  if (typeof nodeId !== "string" || !nodeId) return;
  try {
    await withStore("readwrite", (store) => {
      store.delete(nodeId);
    });
  } catch (err) {
    console.warn("[attachmentStore] delete 失败：", err);
  }
}

// 清空所有附件
export async function clearAttachments() {
  try {
    await withStore("readwrite", (store) => {
      store.clear();
    });
  } catch (err) {
    console.warn("[attachmentStore] clear 失败：", err);
  }
}

// 测试辅助：重置模块级 dbPromise 缓存
export function _resetDBCache() {
  dbPromise = null;
}
