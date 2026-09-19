// 对话 store（hook 形态）：把「对话数据」这件事收在一处
//
// 1) 持久化：IndexedDB 加载 + 旧 localStorage 一次性迁移 + 按单条记录增量写回
// 2) 会话操作：新建 / 删除 / 重命名 / 默认标题 / 树更新 / 更新最后一个可见节点
//
// 这样 App.jsx 只负责编排（发请求、流式、工具循环），不再自己维护对话状态的细节。

import { useEffect, useRef, useState } from "react";
import {
  LEGACY_STORAGE_KEY,
  deleteConversation,
  loadAllConversations,
  migrateLegacyConversations,
  saveConversation,
} from "../api/conversationStore";
import { cloneTree, makeRoot, visibleChain } from "../state/conversationTree";

function readLegacyPayload() {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    // 旧数据损坏就当没有，别拦住启动
    return null;
  }
}

export default function useConversationStore({ migrateConv } = {}) {
  const [conversations, setConversations] = useState([]);
  const [ready, setReady] = useState(false);
  const persistedRef = useRef(new Map()); // id → 已写入磁盘的那个对象引用
  const migrateRef = useRef(migrateConv);
  migrateRef.current = migrateConv;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await migrateLegacyConversations(readLegacyPayload(), { migrateConv: migrateRef.current });
      } catch (err) {
        console.warn("[useConversationStore] 旧数据迁移失败（不影响本次使用）：", err);
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
        for (const conv of created) persistedRef.current.delete(conv.id); // 标记为待写入
        return [...created, ...list];
      });
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 增量写回：只写引用变化过的对话，删掉已不存在的
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

  // —— 会话操作 ——
  const createConversation = () => {
    const id = Date.now().toString();
    setConversations((prev) => [{ id, title: "新对话", tree: makeRoot() }, ...prev]);
    return id;
  };

  const removeConversation = (id) => {
    setConversations((prev) => prev.filter((c) => c.id !== id));
  };

  const renameConversation = (id, title) => {
    const trimmed = (title || "").trim();
    if (!trimmed) return;
    setConversations((prev) =>
      prev.map((c) => (c.id === id ? { ...c, title: trimmed.slice(0, 30) } : c))
    );
  };

  // 首条消息作为标题（仅当还是默认标题时）
  const applyDefaultTitle = (id, title) => {
    const next = (title || "").trim().slice(0, 20);
    if (!next) return;
    setConversations((prev) =>
      prev.map((c) => (c.id === id && c.title === "新对话" ? { ...c, title: next } : c))
    );
  };

  // 克隆 → 原地改 → 写回（避免直接改到 state 里的对象）
  const setConvTree = (convId, updater) => {
    setConversations((prev) =>
      prev.map((c) => {
        if (c.id !== convId) return c;
        const tree = cloneTree(c.tree);
        updater(tree);
        return { ...c, tree };
      })
    );
  };

  const updateLastVisible = (convId, updater) => {
    setConvTree(convId, (tree) => {
      const chain = visibleChain(tree);
      if (chain.length) updater(chain[chain.length - 1].node);
    });
  };

  return {
    conversations,
    setConversations,
    ready,
    createConversation,
    removeConversation,
    renameConversation,
    applyDefaultTitle,
    setConvTree,
    updateLastVisible,
  };
}
