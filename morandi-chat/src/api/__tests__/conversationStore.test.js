// conversationStore.test.js：对话数据层（IndexedDB + schema 版本 + 旧数据迁移）
import { describe, it, expect, beforeEach } from "vitest";
import {
  LEGACY_STORAGE_KEY,
  clearAllConversations,
  clearConversationData,
  deleteConversation,
  loadAllConversations,
  migrateLegacyConversations,
  readMeta,
  readSchemaInfo,
  saveConversation,
  saveConversations,
  _resetConversationDB,
} from "../conversationStore";
import { SCHEMA_VERSION } from "../db";

const conv = (id, title = "对话") => ({ id, title, tree: { id: `${id}-root`, role: "root", children: [] } });

// 旧版扁平结构（migrateConv 要把它转成对话树）
const flat = (id, messages) => ({ id, title: "旧对话", messages });

const migrateConv = (c) => {
  if (c.tree) return c;
  return {
    id: c.id,
    title: c.title,
    tree: { id: `${c.id}-root`, role: "root", children: (c.messages || []).map((m, i) => ({ id: `${c.id}-${i}`, role: m.role, content: m.content, children: [], active: 0 })) },
  };
};

beforeEach(async () => {
  localStorage.clear();
  _resetConversationDB();
  await clearConversationData();
});

describe("conversationStore - 基本读写", () => {
  it("保存后能按原样读回", async () => {
    await saveConversation(conv("1000", "第一个"));
    const list = await loadAllConversations();
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe("第一个");
  });

  it("单条覆盖写入（同 id 只留一条）", async () => {
    await saveConversation(conv("1000", "旧标题"));
    await saveConversation(conv("1000", "新标题"));
    const list = await loadAllConversations();
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe("新标题");
  });

  it("批量写入多条", async () => {
    await saveConversations([conv("1000"), conv("2000"), conv("3000")]);
    expect(await loadAllConversations()).toHaveLength(3);
  });

  it("按 id 里的时间戳倒序返回（最近在前）", async () => {
    await saveConversations([conv("1000"), conv("3000"), conv("2000")]);
    const ids = (await loadAllConversations()).map((c) => c.id);
    expect(ids).toEqual(["3000", "2000", "1000"]);
  });

  it("删除指定对话", async () => {
    await saveConversations([conv("1000"), conv("2000")]);
    await deleteConversation("1000");
    const ids = (await loadAllConversations()).map((c) => c.id);
    expect(ids).toEqual(["2000"]);
  });

  it("非法输入被忽略，不会写入脏数据", async () => {
    await saveConversation({ title: "没有 id" });
    await saveConversation(null);
    await deleteConversation(123);
    expect(await loadAllConversations()).toHaveLength(0);
  });
});

describe("conversationStore - schema 版本", () => {
  it("暴露当前 schema 版本", async () => {
    const info = await readSchemaInfo();
    expect(info.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it("迁移标记写在 meta 里，且重复迁移会被跳过", async () => {
    const first = await migrateLegacyConversations([flat("1000", [{ role: "user", content: "你好" }])], { migrateConv });
    expect(first.migrated).toBe(1);
    const second = await migrateLegacyConversations([flat("2000", [])], { migrateConv });
    expect(second.skipped).toBe("already-migrated");
    expect(await loadAllConversations()).toHaveLength(1);
    const meta = await readMeta("legacyMigrated");
    expect(meta.value).toBe(true);
  });
});

describe("conversationStore - 从 localStorage 迁移", () => {
  it("把旧版扁平对话转成对话树后导入，并清掉 localStorage 键", async () => {
    const legacy = [flat("1000", [{ role: "user", content: "问题" }, { role: "assistant", content: "回答" }])];
    localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(legacy));

    const res = await migrateLegacyConversations(legacy, { migrateConv });

    expect(res.migrated).toBe(1);
    const [saved] = await loadAllConversations();
    expect(saved.tree.children).toHaveLength(2);
    expect(saved.tree.children[0].content).toBe("问题");
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
  });

  it("导入前先留一份原始数据在 meta 里（可回滚）", async () => {
    const legacy = [flat("1000", [{ role: "user", content: "问题" }])];
    await migrateLegacyConversations(legacy, { migrateConv });
    const backup = await readMeta("legacyBackup");
    expect(backup.value).toEqual(legacy);
  });

  it("旧数据为空时只落一个迁移标记", async () => {
    const res = await migrateLegacyConversations(null, { migrateConv });
    expect(res.migrated).toBe(0);
    expect((await readMeta("legacyMigrated")).value).toBe(true);
    expect(await loadAllConversations()).toHaveLength(0);
  });

  it("旧数据里有损坏条目时跳过它们，不阻断迁移", async () => {
    const legacy = [flat("1000", []), { title: "坏数据" }, null];
    const res = await migrateLegacyConversations(legacy, { migrateConv });
    expect(res.migrated).toBe(1);
    expect(await loadAllConversations()).toHaveLength(1);
  });
});
