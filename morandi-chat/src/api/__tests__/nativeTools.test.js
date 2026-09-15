// nativeTools.js 单元测试：预置工具的启停过滤、localStorage 读写、确认策略
import { describe, it, expect, beforeEach } from "vitest";
import {
  DEFAULT_NATIVE_TOOL_SETTINGS,
  loadNativeToolSettings,
  saveNativeToolSettings,
  getEnabledNativeDecls,
  nativeNeedsConfirm,
  isNativeTool,
  NATIVE_TOOL_DECLS,
} from "../nativeTools";

beforeEach(() => {
  localStorage.clear();
});

describe("getEnabledNativeDecls", () => {
  it("全开时返回全部预置声明", () => {
    const decls = getEnabledNativeDecls({ fetch_url: true, todo_list: true });
    expect(decls).toHaveLength(NATIVE_TOOL_DECLS.length);
    const names = decls.map((d) => d.function.name);
    expect(names).toContain("fetch_url");
    expect(names).toContain("todo_list");
  });

  it("全关时返回空数组", () => {
    const decls = getEnabledNativeDecls({ fetch_url: false, todo_list: false });
    expect(decls).toHaveLength(0);
  });

  it("部分启用只返回启用的声明", () => {
    const decls = getEnabledNativeDecls({ fetch_url: false, todo_list: true });
    expect(decls).toHaveLength(1);
    expect(decls[0].function.name).toBe("todo_list");
  });

  it("settings 为空对象时全部启用（!== false 判定）", () => {
    const decls = getEnabledNativeDecls({});
    expect(decls).toHaveLength(NATIVE_TOOL_DECLS.length);
  });

  it("settings 为 undefined 时全部启用", () => {
    const decls = getEnabledNativeDecls();
    expect(decls).toHaveLength(NATIVE_TOOL_DECLS.length);
  });

  it("未知工具键不影响已知工具的启停", () => {
    const decls = getEnabledNativeDecls({ unknown_tool: false, fetch_url: true });
    expect(decls).toHaveLength(NATIVE_TOOL_DECLS.length); // 已知工具全开
  });
});

describe("loadNativeToolSettings", () => {
  it("localStorage 为空返回默认全开", () => {
    const s = loadNativeToolSettings();
    expect(s).toEqual(DEFAULT_NATIVE_TOOL_SETTINGS);
    expect(s.fetch_url).toBe(true);
    expect(s.todo_list).toBe(true);
  });

  it("保存后能正确读取", () => {
    saveNativeToolSettings({ fetch_url: false, todo_list: true });
    const s = loadNativeToolSettings();
    expect(s).toEqual({ fetch_url: false, todo_list: true });
  });

  it("与默认值合并：新增工具时默认启用", () => {
    // 模拟旧版本只存了 fetch_url
    saveNativeToolSettings({ fetch_url: false });
    const s = loadNativeToolSettings();
    // todo_list 未在存储中，应取默认 true
    expect(s.fetch_url).toBe(false);
    expect(s.todo_list).toBe(true);
  });

  it("JSON 损坏时回退默认值", () => {
    localStorage.setItem("morandi-chat-native-tools", "{bad json");
    const s = loadNativeToolSettings();
    expect(s).toEqual(DEFAULT_NATIVE_TOOL_SETTINGS);
  });

  it("存的是非对象（如数组）时回退默认值", () => {
    localStorage.setItem("morandi-chat-native-tools", "[1,2,3]");
    const s = loadNativeToolSettings();
    expect(s).toEqual(DEFAULT_NATIVE_TOOL_SETTINGS);
  });

  it("存的是 null 时回退默认值", () => {
    localStorage.setItem("morandi-chat-native-tools", "null");
    const s = loadNativeToolSettings();
    expect(s).toEqual(DEFAULT_NATIVE_TOOL_SETTINGS);
  });
});

describe("saveNativeToolSettings", () => {
  it("写入 JSON 字符串到 localStorage", () => {
    saveNativeToolSettings({ fetch_url: false, todo_list: true });
    const raw = localStorage.getItem("morandi-chat-native-tools");
    expect(raw).toBe(JSON.stringify({ fetch_url: false, todo_list: true }));
  });

  it("覆盖写入，不合并旧值", () => {
    saveNativeToolSettings({ fetch_url: true, todo_list: false });
    saveNativeToolSettings({ fetch_url: false, todo_list: true });
    const s = loadNativeToolSettings();
    expect(s).toEqual({ fetch_url: false, todo_list: true });
  });
});

describe("nativeNeedsConfirm", () => {
  it("todo_list 的 list 操作不需确认", () => {
    expect(nativeNeedsConfirm("todo_list", JSON.stringify({ action: "list" }))).toBe(false);
  });

  it("todo_list 的 add 操作需确认", () => {
    expect(nativeNeedsConfirm("todo_list", JSON.stringify({ action: "add", title: "x" }))).toBe(true);
  });

  it("todo_list 的 complete 操作需确认", () => {
    expect(nativeNeedsConfirm("todo_list", JSON.stringify({ action: "complete", id: "1" }))).toBe(true);
  });

  it("todo_list 的 delete 操作需确认", () => {
    expect(nativeNeedsConfirm("todo_list", JSON.stringify({ action: "delete", id: "1" }))).toBe(true);
  });

  it("fetch_url 不需确认", () => {
    expect(nativeNeedsConfirm("fetch_url", JSON.stringify({ url: "https://example.com" }))).toBe(false);
  });

  it("未知工具不需确认（保守放行，由 runNativeTool 报错）", () => {
    expect(nativeNeedsConfirm("unknown_tool", "{}")).toBe(false);
  });

  it("todo_list 参数 JSON 非法时不需确认（解析为空对象）", () => {
    expect(nativeNeedsConfirm("todo_list", "{bad")).toBe(false);
  });

  it("todo_list action 缺省时不需确认", () => {
    expect(nativeNeedsConfirm("todo_list", JSON.stringify({}))).toBe(false);
  });

  it("todo_list action 为未知值时不需确认", () => {
    expect(nativeNeedsConfirm("todo_list", JSON.stringify({ action: "unknown" }))).toBe(false);
  });
});

describe("isNativeTool", () => {
  it("识别 fetch_url 为内置工具", () => {
    expect(isNativeTool("fetch_url")).toBe(true);
  });

  it("识别 todo_list 为内置工具", () => {
    expect(isNativeTool("todo_list")).toBe(true);
  });

  it("用户自定义工具返回 false", () => {
    expect(isNativeTool("current_timestamp")).toBe(false);
    expect(isNativeTool("calculator")).toBe(false);
    expect(isNativeTool("any_random_name")).toBe(false);
  });

  it("空字符串与边界值返回 false", () => {
    expect(isNativeTool("")).toBe(false);
    expect(isNativeTool(null)).toBe(false);
    expect(isNativeTool(undefined)).toBe(false);
  });
});
