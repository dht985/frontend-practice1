// fullResultsStore.test.js：IndexedDB 持久化层测试
// 通过 vitest setupFiles 的 fake-indexeddb/auto 注入全局 indexedDB
import { describe, it, expect, beforeEach } from "vitest";
import {
  loadAllFullResults,
  saveFullResult,
  deleteFullResult,
  clearFullResults,
  _resetDBCache,
} from "../fullResultsStore";

// 每个 test 前重置 DB 缓存 + 清空 store，避免数据互相污染
beforeEach(async () => {
  _resetDBCache();
  // 先 loadAll 触发 openDB，再 clear 清空已存在的旧记录
  await clearFullResults();
});

describe("fullResultsStore - 基本写入读取", () => {
  it("save 后 loadAll 能读到对应条目", async () => {
    await saveFullResult("call-1", "这是工具调用结果全文");
    const map = await loadAllFullResults();
    expect(map.get("call-1")).toBe("这是工具调用结果全文");
  });

  it("loadAll 返回 Map 实例", async () => {
    const map = await loadAllFullResults();
    expect(map).toBeInstanceOf(Map);
  });

  it("空 DB 时 loadAll 返回空 Map", async () => {
    const map = await loadAllFullResults();
    expect(map.size).toBe(0);
  });

  it("可写入多条，loadAll 全部返回", async () => {
    await saveFullResult("a", "结果 A");
    await saveFullResult("b", "结果 B");
    await saveFullResult("c", "结果 C");
    const map = await loadAllFullResults();
    expect(map.size).toBe(3);
    expect(map.get("a")).toBe("结果 A");
    expect(map.get("b")).toBe("结果 B");
    expect(map.get("c")).toBe("结果 C");
  });

  it("同 callId 重复 save 会覆盖（put 语义）", async () => {
    await saveFullResult("dup", "第一次");
    await saveFullResult("dup", "第二次");
    const map = await loadAllFullResults();
    expect(map.size).toBe(1);
    expect(map.get("dup")).toBe("第二次");
  });
});

describe("fullResultsStore - 长文本（贴近真实场景）", () => {
  it("20k 字符的全文能完整存取", async () => {
    const long = "字".repeat(20000);
    await saveFullResult("big", long);
    const map = await loadAllFullResults();
    expect(map.get("big")).toBe(long);
    expect(map.get("big").length).toBe(20000);
  });

  it("包含换行/制表符/中文/emoji 的文本不损坏", async () => {
    const text = "第1行\n第2行\t带制表\nemoji：😀🎉 中文 ok";
    await saveFullResult("mix", text);
    const map = await loadAllFullResults();
    expect(map.get("mix")).toBe(text);
  });

  it("空字符串也能存取", async () => {
    await saveFullResult("empty", "");
    const map = await loadAllFullResults();
    expect(map.get("empty")).toBe("");
  });
});

describe("fullResultsStore - 删除", () => {
  it("deleteFullResult 删除存在的条目", async () => {
    await saveFullResult("del", "待删除");
    await deleteFullResult("del");
    const map = await loadAllFullResults();
    expect(map.has("del")).toBe(false);
    expect(map.size).toBe(0);
  });

  it("deleteFullResult 不存在的 callId 不报错", async () => {
    await expect(deleteFullResult("never-exists")).resolves.toBeUndefined();
  });

  it("删除一条不影响其他", async () => {
    await saveFullResult("keep", "保留");
    await saveFullResult("drop", "删除");
    await deleteFullResult("drop");
    const map = await loadAllFullResults();
    expect(map.size).toBe(1);
    expect(map.get("keep")).toBe("保留");
  });
});

describe("fullResultsStore - clearFullResults", () => {
  it("清空所有条目", async () => {
    await saveFullResult("a", "1");
    await saveFullResult("b", "2");
    await saveFullResult("c", "3");
    await clearFullResults();
    const map = await loadAllFullResults();
    expect(map.size).toBe(0);
  });

  it("空 DB 上 clear 不报错", async () => {
    await clearFullResults();
    const map = await loadAllFullResults();
    expect(map.size).toBe(0);
  });
});

describe("fullResultsStore - 参数边界", () => {
  it("saveFullResult 非 string callId 静默跳过", async () => {
    await saveFullResult(123, "数字 id");
    await saveFullResult(null, "null id");
    await saveFullResult(undefined, "undefined id");
    const map = await loadAllFullResults();
    expect(map.size).toBe(0);
  });

  it("saveFullResult 非 string full 静默跳过", async () => {
    await saveFullResult("num-id", 12345);
    await saveFullResult("obj-id", { foo: "bar" });
    await saveFullResult("null-full", null);
    const map = await loadAllFullResults();
    expect(map.size).toBe(0);
  });

  it("deleteFullResult 非 string callId 静默跳过", async () => {
    await expect(deleteFullResult(123)).resolves.toBeUndefined();
    await expect(deleteFullResult(null)).resolves.toBeUndefined();
  });
});

describe("fullResultsStore - 重新打开 DB（缓存重置后数据仍在）", () => {
  it("_resetDBCache 后再 loadAll 仍能读到已存条目", async () => {
    await saveFullResult("persist", "持久化的数据");
    _resetDBCache();
    const map = await loadAllFullResults();
    expect(map.get("persist")).toBe("持久化的数据");
  });
});
