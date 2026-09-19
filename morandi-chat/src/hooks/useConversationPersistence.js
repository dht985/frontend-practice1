// 对话持久化 hook
//
// - 启动时：把 localStorage 里的旧对话一次性迁移进 IndexedDB，再整体读出来
// - 之后：对话发生变化时按「单条记录」增量写回（只写引用变了的那些，删掉已不存在的）
//   这样既没有 localStorage 的几 MB 上限，也不会每次改动都重写整个对话数组。

import { useEffect, useRef, useState } from "react";
import {
  LEGACY_STORAGE_KEY,
  deleteConversation,
  loadAllConversations,
  migrateLegacyConversations,
  saveConversation,
} from "../api/conversationStore";

function readLegacyPayload() {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    // 旧数据损坏就当没有，别拦住启动
    return null;
  }
}

export default function useConversationPersistence({ migrateConv } = {}) {
  const [conversations, setConversations] = useState([]);
  const [ready, setReady] = useState(false);
  const persistedRef = useRef(new Map()); // id → 已写入的那个对象引用
  const migrateRef = useRef(migrateConv);
  migrateRef.current = migrateConv;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await migrateLegacyConversations(readLegacyPayload(), { migrateConv: migrateRef.current });
      } catch (err) {
        console.warn("[useConversationPersistence] 旧数据迁移失败（不影响本次使用）：", err);
      }
      const list = await loadAllConversations();
      if (cancelled) return;
      persistedRef.current = new Map(list.map((c) => [c.id, c]));
      // 加载是异步的：如果这期间用户已经发了消息（新建了对话），
      // 不能直接用磁盘数据覆盖内存状态，要把它合并进来。
      setConversations((current) => {
        if (!current.length) return list;
        const loadedIds = new Set(list.map((c) => c.id));
        const created = current.filter((c) => !loadedIds.has(c.id));
        for (const conv of created) persistedRef.current.set(conv.id, null); // 标记为待写入
        return [...created, ...list];
      });
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    const next = new Map(conversations.map((c) => [c.id, c]));
    for (const [id, conv] of next) {
      if (persistedRef.current.get(id) !== conv) {
        saveConversation(conv).catch(() => {
          // store 内部已打日志；这里避免未捕获的 Promise 拒绝
        });
      }
    }
    for (const id of persistedRef.current.keys()) {
      if (!next.has(id)) deleteConversation(id);
    }
    persistedRef.current = next;
  }, [conversations, ready]);

  return { conversations, setConversations, ready };
}
