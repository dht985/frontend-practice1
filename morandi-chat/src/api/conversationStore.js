// 对话数据层：IndexedDB（带 schema 版本 + 从 localStorage 的一次性迁移）
//
// 为什么不继续用 localStorage：
//   1. 容量只有几 MB，长对话 + 多版本分支很容易撞上限，撞上限就等于丢数据；
//   2. 每次改动都要 JSON.stringify 整个对话数组，对话越多越卡；
//   3. 没有 schema 版本概念，字段一变只能在读取时靠 if 猜。
// 现在：每个对话一条记录（keyPath = id），只写变动的那条；
// meta store 里记 schema 版本与迁移状态，升级时按版本逐级迁移。

import {
  SCHEMA_VERSION,
  STORE_CONVERSATIONS,
  STORE_META,
  _resetDBCache,
  withStore,
} from "./db";

// 旧版：整个对话数组存在一个 localStorage 键里
export const LEGACY_STORAGE_KEY = "morandi-chat-conversations";
const META_LEGACY = "legacyMigrated";
const META_BACKUP = "legacyBackup";

const isConversation = (c) => Boolean(c && typeof c === "object" && typeof c.id === "string");

// 对话 id 以时间戳开头（`Date.now()` 或 `${Date.now()}-随机`），用它排序即可还原「最近在前」
const idTime = (id) => {
  const match = /^(\d+)/.exec(String(id || ""));
  return match ? Number(match[1]) : 0;
};

// 读取全部对话（按最近更新在前排序，和侧边栏的预期一致）
export async function loadAllConversations() {
  try {
    const rows = await withStore(STORE_CONVERSATIONS, "readonly", (store) => {
      const req = store.getAll();
      return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    });
    return rows.filter(isConversation).sort((a, b) => idTime(b.id) - idTime(a.id));
  } catch (err) {
    console.warn("[conversationStore] 读取失败，按空列表处理：", err);
    return [];
  }
}

// 写入（或覆盖）单个对话：这是最常走的路径，只写一条记录
export async function saveConversation(conversation) {
  if (!isConversation(conversation)) return;
  try {
    await withStore(STORE_CONVERSATIONS, "readwrite", (store) => {
      store.put(conversation);
    });
  } catch (err) {
    console.warn("[conversationStore] 保存失败：", err);
    throw err;
  }
}

export async function saveConversations(list) {
  const rows = (list || []).filter(isConversation);
  if (!rows.length) return;
  await withStore(STORE_CONVERSATIONS, "readwrite", (store) => {
    for (const row of rows) store.put(row);
  });
}

export async function deleteConversation(id) {
  if (typeof id !== "string" || !id) return;
  try {
    await withStore(STORE_CONVERSATIONS, "readwrite", (store) => {
      store.delete(id);
    });
  } catch (err) {
    console.warn("[conversationStore] 删除失败：", err);
  }
}

// 清空对话数据（对话 + meta 迁移标记）：测试与「清空本地数据」用
export async function clearConversationData() {
  await clearAllConversations();
  try {
    await withStore(STORE_META, "readwrite", (store) => {
      store.clear();
    });
  } catch (err) {
    console.warn("[conversationStore] 清空 meta 失败：", err);
  }
}

// 清空全部对话（测试与「清空本地数据」用）
export async function clearAllConversations() {
  try {
    await withStore(STORE_CONVERSATIONS, "readwrite", (store) => {
      store.clear();
    });
  } catch (err) {
    console.warn("[conversationStore] 清空失败：", err);
  }
}

export async function readMeta(key) {
  try {
    return await withStore(STORE_META, "readonly", (store) => {
      const req = store.get(key);
      return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => reject(req.error);
      });
    });
  } catch {
    return null;
  }
}

export async function writeMeta(key, value) {
  return withStore(STORE_META, "readwrite", (store) => {
    store.put({ key, ...value });
  });
}

// schema 信息（调试/诊断用）
export async function readSchemaInfo() {
  const meta = await readMeta("schema");
  return { schemaVersion: SCHEMA_VERSION, ...(meta || {}) };
}

/**
 * 把旧版 localStorage 里的对话导入 IndexedDB（幂等：迁移过就不再执行）。
 * 迁移成功后才删除 localStorage 键；原始数据另存一份到 meta 里可回滚。
 *
 * @param {unknown} legacyRaw localStorage 里解析出来的原始数组
 * @param {{migrateConv?: (c: any) => any}} [options] 扁平结构 → 对话树的迁移函数
 * @returns {Promise<{migrated: number, skipped?: string}>}
 */
export async function migrateLegacyConversations(legacyRaw, { migrateConv } = {}) {
  const done = await readMeta(META_LEGACY);
  if (done?.value) return { migrated: 0, skipped: "already-migrated" };

  const rawList = Array.isArray(legacyRaw) ? legacyRaw.filter(isConversation) : [];
  if (!rawList.length) {
    await writeMeta(META_LEGACY, { value: true, migratedAt: Date.now(), migratedCount: 0 });
    return { migrated: 0 };
  }

  const list = rawList.map((c) => (migrateConv ? migrateConv(c) : c)).filter(isConversation);
  await saveConversations(list);

  // 读回来核对数量，确认写入成功再清 localStorage
  const saved = await loadAllConversations();
  if (saved.length < list.length) {
    console.warn("[conversationStore] 迁移校验未通过，保留 localStorage 原数据");
    return { migrated: 0, skipped: "verify-failed" };
  }

  try {
    // 原始数据留一份在 IndexedDB 里（可回滚），然后释放 localStorage 配额
    await writeMeta(META_BACKUP, { value: rawList, migratedAt: Date.now() });
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch (err) {
    console.warn("[conversationStore] 清理 localStorage 失败（数据已安全导入）：", err);
  }
  await writeMeta(META_LEGACY, { value: true, migratedAt: Date.now(), migratedCount: list.length });
  return { migrated: list.length };
}

// 测试辅助：重置数据库连接缓存
export function _resetConversationDB() {
  _resetDBCache();
}
