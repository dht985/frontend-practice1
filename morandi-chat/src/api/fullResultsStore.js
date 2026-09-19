// 工具调用结果全文的 IndexedDB 持久化层
// 用途：localStorage 里的会话只存 120 字预览，这里单独存全文（可达 20k 字/条），
// 刷新后异步加载回内存 Map。
//
// 数据库与 schema 版本统一由 db.js 管理（store：fullResults，keyPath = callId）；
// 字段：{ callId, full, ts }（ts 仅用于未来 LRU/清理，目前不淘汰）。
//
// 所有方法返回 Promise；IndexedDB 请求异步，调用方需 await。
// 测试通过 vitest setupFiles 的 fake-indexeddb/auto 注入全局 indexedDB。

import { STORE_FULL_RESULTS, withStore } from "./db";

export { _resetDBCache } from "./db";

// 启动时加载全部全文：返回 Map(callId → full)
// 用于 mount 时一次性填充 fullResultsRef.current
export async function loadAllFullResults() {
  try {
    return await withStore(STORE_FULL_RESULTS, "readonly", (store) => {
      const req = store.getAll();
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
    await withStore(STORE_FULL_RESULTS, "readwrite", (store) => {
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
    await withStore(STORE_FULL_RESULTS, "readwrite", (store) => {
      store.delete(callId);
    });
  } catch (err) {
    console.warn("[fullResultsStore] delete 失败：", err);
  }
}

// 清空所有（用于"清除全部"等场景）
export async function clearFullResults() {
  try {
    await withStore(STORE_FULL_RESULTS, "readwrite", (store) => {
      store.clear();
    });
  } catch (err) {
    console.warn("[fullResultsStore] clear 失败：", err);
  }
}
