// attachmentStore.test.js：附件内容持久化层测试
// 通过 vitest setupFiles 的 fake-indexeddb/auto 注入全局 indexedDB
import { describe, it, expect, beforeEach } from "vitest";
import {
  loadAllAttachments,
  saveAttachments,
  deleteAttachments,
  clearAttachments,
  _resetDBCache,
} from "../attachmentStore";

beforeEach(async () => {
  _resetDBCache();
  await clearAttachments();
});

const imagePayload = {
  parts: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }],
  systemMessages: [],
  skipped: [],
  askText: "这张图里有什么？",
};

describe("attachmentStore - 基本读写", () => {
  it("save 后 loadAll 能按节点 id 读回附件", async () => {
    await saveAttachments("node-1", imagePayload);
    const map = await loadAllAttachments();
    expect(map.get("node-1")).toEqual(imagePayload);
  });

  it("loadAll 返回 Map 实例，空库返回空 Map", async () => {
    const map = await loadAllAttachments();
    expect(map).toBeInstanceOf(Map);
    expect(map.size).toBe(0);
  });

  it("同一节点重复 save 覆盖旧值", async () => {
    await saveAttachments("node-1", imagePayload);
    await saveAttachments("node-1", { ...imagePayload, askText: "换了个问法" });
    const map = await loadAllAttachments();
    expect(map.get("node-1").askText).toBe("换了个问法");
    expect(map.size).toBe(1);
  });

  it("多条记录互不影响", async () => {
    await saveAttachments("node-1", imagePayload);
    await saveAttachments("node-2", { parts: [], systemMessages: [{ role: "system", content: "文件内容" }] });
    const map = await loadAllAttachments();
    expect(map.size).toBe(2);
    expect(map.get("node-2").systemMessages[0].content).toBe("文件内容");
  });
});

describe("attachmentStore - 删除", () => {
  it("delete 移除指定节点", async () => {
    await saveAttachments("node-1", imagePayload);
    await deleteAttachments("node-1");
    const map = await loadAllAttachments();
    expect(map.has("node-1")).toBe(false);
  });

  it("delete 不存在的节点不报错", async () => {
    await expect(deleteAttachments("nope")).resolves.toBeUndefined();
  });

  it("删除一条不影响其他条目", async () => {
    await saveAttachments("node-1", imagePayload);
    await saveAttachments("node-2", imagePayload);
    await deleteAttachments("node-1");
    const map = await loadAllAttachments();
    expect(map.size).toBe(1);
    expect(map.has("node-2")).toBe(true);
  });
});

describe("attachmentStore - 参数边界", () => {
  it("空载荷（没有 parts/系统消息/跳过文件）不写入", async () => {
    await saveAttachments("node-1", { parts: [], systemMessages: [], skipped: [], askText: "x" });
    const map = await loadAllAttachments();
    expect(map.size).toBe(0);
  });

  it("非字符串 nodeId 静默跳过", async () => {
    await saveAttachments(123, imagePayload);
    await deleteAttachments(null);
    const map = await loadAllAttachments();
    expect(map.size).toBe(0);
  });

  it("非法字段被规整为空数组", async () => {
    await saveAttachments("node-1", { parts: "not-array", systemMessages: null, skipped: 7, askText: 5 });
    const map = await loadAllAttachments();
    expect(map.size).toBe(0); // 规整后没有任何有效内容
  });

  it("大文本（文档抽取）能完整存取", async () => {
    const text = "长文本".repeat(5000);
    await saveAttachments("node-1", {
      parts: [],
      systemMessages: [{ role: "system", content: text }],
    });
    const map = await loadAllAttachments();
    expect(map.get("node-1").systemMessages[0].content).toBe(text);
  });

  it("重新打开 DB（缓存重置）后数据仍在", async () => {
    await saveAttachments("node-1", imagePayload);
    _resetDBCache();
    const map = await loadAllAttachments();
    expect(map.get("node-1")).toEqual(imagePayload);
  });
});
