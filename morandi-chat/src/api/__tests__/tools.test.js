// tools.js 单元测试：错误可重试判定、工具库 localStorage 持久化、工具编译与本地执行
import { describe, it, expect, beforeEach } from "vitest";
import {
  isRetryableError,
  loadToolLib,
  saveToolLib,
  compileTools,
  runLocalTool,
  BUILTIN_TOOLS,
} from "../tools";

beforeEach(() => {
  localStorage.clear();
});

describe("isRetryableError", () => {
  it("429 限流可重试", () => {
    expect(isRetryableError("Too Many Requests (429)")).toBe(true);
    expect(isRetryableError("rate limit exceeded")).toBe(true);
  });

  it("5xx 服务端错误可重试", () => {
    expect(isRetryableError("Internal Server Error (500)")).toBe(true);
    expect(isRetryableError("Bad Gateway (502)")).toBe(true);
    expect(isRetryableError("Service Unavailable (503)")).toBe(true);
    expect(isRetryableError("Gateway Timeout (504)")).toBe(true);
  });

  it("507 超出 5xx 可重试区间不可重试", () => {
    // 实现只覆盖 500-504
    expect(isRetryableError("Insufficient Storage (507)")).toBe(false);
  });

  it("4xx 客户端错误不可重试", () => {
    expect(isRetryableError("Bad Request (400)")).toBe(false);
    expect(isRetryableError("Unauthorized (401)")).toBe(false);
    expect(isRetryableError("Forbidden (403)")).toBe(false);
    expect(isRetryableError("Not Found (404)")).toBe(false);
    expect(isRetryableError("Unsupported Media Type (415)")).toBe(false);
  });

  it("网络/超时/连接错误可重试", () => {
    expect(isRetryableError("Network request failed")).toBe(true);
    expect(isRetryableError("timeout")).toBe(true);
    expect(isRetryableError("timed out after 30s")).toBe(true);
    expect(isRetryableError("ECONNRESET")).toBe(true);
    expect(isRetryableError("ECONNREFUSED")).toBe(true);
    expect(isRetryableError("ETIMEDOUT")).toBe(true);
    expect(isRetryableError("fetch failed")).toBe(true);
  });

  it("中文网络错误关键字可重试", () => {
    expect(isRetryableError("网络异常")).toBe(true);
    expect(isRetryableError("请求超时")).toBe(true);
    expect(isRetryableError("服务临时不可用")).toBe(true);
  });

  it("参数错误不可重试", () => {
    expect(isRetryableError("invalid url")).toBe(false);
    expect(isRetryableError("参数不合法：url 不能为空")).toBe(false);
    expect(isRetryableError("unexpected token in json")).toBe(false);
  });

  it("权限/未授权错误不可重试", () => {
    expect(isRetryableError("permission denied")).toBe(false);
    expect(isRetryableError("unauthorized access")).toBe(false);
    expect(isRetryableError("forbidden resource")).toBe(false);
  });

  it("工具不存在错误不可重试", () => {
    expect(isRetryableError("tool not found")).toBe(false);
    expect(isRetryableError("工具不存在")).toBe(false);
  });

  it("语法/运行时错误不可重试", () => {
    expect(isRetryableError("SyntaxError: unexpected token")).toBe(false);
    expect(isRetryableError("ReferenceError: x is not defined")).toBe(false);
    expect(isRetryableError("undefined is not a function")).toBe(false);
    expect(isRetryableError("cannot read properties of undefined")).toBe(false);
  });

  it("未知错误默认不可重试", () => {
    expect(isRetryableError("some unexpected failure")).toBe(false);
    expect(isRetryableError("")).toBe(false);
    expect(isRetryableError(null, { message: "weird" })).toBe(false);
  });

  it("err 对象作为兜底来源", () => {
    // msg 为空时回退到 err.message
    expect(isRetryableError("", { message: "network request timed out" })).toBe(true);
    expect(isRetryableError("", { message: "Invalid parameter" })).toBe(false);
  });
});

describe("loadToolLib", () => {
  it("首次使用写入内置示例并返回副本", () => {
    const list = loadToolLib();
    expect(list).toHaveLength(BUILTIN_TOOLS.length);
    // 内容一致
    expect(list.map((t) => t.id)).toEqual(BUILTIN_TOOLS.map((t) => t.id));
    // 写入 localStorage
    const raw = localStorage.getItem("morandi-chat-tools");
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw)).toHaveLength(BUILTIN_TOOLS.length);
  });

  it("损坏数据回退默认并重写", () => {
    localStorage.setItem("morandi-chat-tools", "{bad json");
    const list = loadToolLib();
    expect(list).toHaveLength(BUILTIN_TOOLS.length);
  });

  it("存的是非数组（对象）时回退默认", () => {
    localStorage.setItem("morandi-chat-tools", JSON.stringify({ a: 1 }));
    const list = loadToolLib();
    expect(list).toHaveLength(BUILTIN_TOOLS.length);
  });

  it("正常数组原样返回", () => {
    const custom = [{ id: "x", name: "x", code: "return 1", parameters: "{}", enabled: true }];
    localStorage.setItem("morandi-chat-tools", JSON.stringify(custom));
    const list = loadToolLib();
    expect(list).toEqual(custom);
  });
});

describe("saveToolLib", () => {
  it("写入 localStorage", () => {
    const list = [{ id: "a", name: "a", code: "return 1", parameters: "{}", enabled: true }];
    saveToolLib(list);
    expect(localStorage.getItem("morandi-chat-tools")).toBe(JSON.stringify(list));
  });

  it("覆盖写入", () => {
    saveToolLib([{ id: "old" }]);
    saveToolLib([{ id: "new" }]);
    expect(loadToolLib()).toEqual([{ id: "new" }]);
  });
});

describe("compileTools", () => {
  const mk = (name, opts = {}) => ({
    id: `id-${name}`,
    name,
    code: opts.code ?? "return 1",
    parameters: opts.parameters ?? "{}",
    enabled: opts.enabled ?? true,
    builtin: false,
  });

  it("空数组返回空声明与空执行器", () => {
    const { declarations, executors } = compileTools([]);
    expect(declarations).toEqual([]);
    expect(executors.size).toBe(0);
  });

  it("过滤禁用工具", () => {
    const { declarations } = compileTools([mk("a", { enabled: true }), mk("b", { enabled: false })]);
    expect(declarations).toHaveLength(1);
    expect(declarations[0].function.name).toBe("a");
  });

  it("过滤空 code 工具", () => {
    const { declarations } = compileTools([mk("a", { code: "" }), mk("b", { code: "   " })]);
    expect(declarations).toHaveLength(0);
  });

  it("正常工具编译成 OpenAI 声明", () => {
    const tool = mk("my_tool", { parameters: '{"type":"object","properties":{}}' });
    const { declarations, executors } = compileTools([tool]);
    expect(declarations).toHaveLength(1);
    const d = declarations[0];
    expect(d.type).toBe("function");
    expect(d.function.name).toBe("my_tool");
    expect(d.function.parameters.type).toBe("object");
    expect(executors.get("my_tool")).toBe(tool);
  });

  it("参数 Schema 非法时回退空对象模式", () => {
    const { declarations } = compileTools([mk("bad", { parameters: "not json" })]);
    expect(declarations[0].function.parameters).toEqual({ type: "object", properties: {} });
  });

  it("参数 Schema 为数组时回退对象模式", () => {
    const { declarations } = compileTools([mk("arr", { parameters: "[1,2]" })]);
    expect(declarations[0].function.parameters).toEqual({ type: "object", properties: {} });
  });

  it("名字含空格转下划线", () => {
    const { declarations } = compileTools([mk("my tool")]);
    expect(declarations[0].function.name).toBe("my_tool");
  });

  it("名字含特殊字符转下划线", () => {
    const { declarations } = compileTools([mk("tool@#$x")]);
    expect(declarations[0].function.name).toBe("tool___x");
  });

  it("名字数字开头加前缀下划线", () => {
    const { declarations } = compileTools([mk("123abc")]);
    expect(declarations[0].function.name).toBe("_123abc");
  });

  it("空名字回退为 tool", () => {
    const { declarations } = compileTools([mk("")]);
    expect(declarations[0].function.name).toBe("tool");
  });

  it("重名工具自动加序号", () => {
    const { declarations } = compileTools([mk("dup"), mk("dup"), mk("dup")]);
    const names = declarations.map((d) => d.function.name);
    expect(names).toEqual(["dup", "dup_2", "dup_3"]);
  });

  it("reserved 保留字让用户工具改名", () => {
    const { declarations } = compileTools([mk("reserved_name")], ["reserved_name"]);
    expect(declarations[0].function.name).toBe("reserved_name_2");
  });

  it("reserved 保留字让后续重名也避开", () => {
    const { declarations } = compileTools([mk("a"), mk("a")], ["a"]);
    const names = declarations.map((d) => d.function.name);
    expect(names).toEqual(["a_2", "a_3"]);
  });

  it("description 缺省时为空字符串", () => {
    const { declarations } = compileTools([{ ...mk("x"), description: undefined }]);
    expect(declarations[0].function.description).toBe("");
  });
});

describe("runLocalTool", () => {
  it("正常执行返回 JSON 字符串", async () => {
    const tool = { name: "echo", code: "return { ok: true, value: args.x }", parameters: "{}" };
    const r = await runLocalTool(tool, JSON.stringify({ x: 42 }));
    expect(r.isError).toBe(false);
    expect(r.retryable).toBe(false);
    const parsed = JSON.parse(r.content);
    expect(parsed).toEqual({ ok: true, value: 42 });
  });

  it("返回字符串时原样作为 content", async () => {
    const tool = { name: "str", code: "return 'hello'", parameters: "{}" };
    const r = await runLocalTool(tool, "{}");
    expect(r.content).toBe("hello");
    expect(r.isError).toBe(false);
  });

  it("返回 undefined 时 content 为 'null'", async () => {
    const tool = { name: "nil", code: "return undefined", parameters: "{}" };
    const r = await runLocalTool(tool, "{}");
    expect(r.content).toBe("null");
  });

  it("支持 async/await（AsyncFunction）", async () => {
    const tool = {
      name: "async",
      code: "const v = await Promise.resolve(7); return { v }",
      parameters: "{}",
    };
    const r = await runLocalTool(tool, "{}");
    expect(JSON.parse(r.content)).toEqual({ v: 7 });
  });

  it("参数 JSON 非法时按空对象执行", async () => {
    const tool = { name: "ok", code: "return { hasArgs: typeof args === 'object' }", parameters: "{}" };
    const r = await runLocalTool(tool, "{bad");
    expect(JSON.parse(r.content)).toEqual({ hasArgs: true });
  });

  it("执行抛错时返回 isError 并以 {error} 回传", async () => {
    const tool = { name: "boom", code: "throw new Error('boom!')", parameters: "{}" };
    const r = await runLocalTool(tool, "{}");
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content)).toEqual({ error: "boom!" });
  });

  it("语法错误不可重试", async () => {
    const tool = { name: "syntax", code: "return !@#", parameters: "{}" };
    const r = await runLocalTool(tool, "{}");
    expect(r.isError).toBe(true);
    expect(r.retryable).toBe(false);
  });

  it("网络类运行时错误可重试", async () => {
    const tool = { name: "net", code: "throw new Error('network request timed out')", parameters: "{}" };
    const r = await runLocalTool(tool, "{}");
    expect(r.isError).toBe(true);
    expect(r.retryable).toBe(true);
  });
});

describe("BUILTIN_TOOLS", () => {
  it("包含三个内置示例", () => {
    expect(BUILTIN_TOOLS).toHaveLength(3);
    const names = BUILTIN_TOOLS.map((t) => t.name);
    expect(names).toEqual(["current_timestamp", "calculator", "roll_dice"]);
  });

  it("内置工具默认启用", () => {
    for (const t of BUILTIN_TOOLS) {
      expect(t.enabled).toBe(true);
    }
  });

  it("内置工具标记 builtin=true", () => {
    for (const t of BUILTIN_TOOLS) {
      expect(t.builtin).toBe(true);
    }
  });

  it("current_timestamp 返回数字", async () => {
    const tool = BUILTIN_TOOLS.find((t) => t.name === "current_timestamp");
    const r = await runLocalTool(tool, "{}");
    expect(r.isError).toBe(false);
    expect(typeof JSON.parse(r.content)).toBe("number");
  });

  it("calculator 计算 1+2*3=7", async () => {
    const tool = BUILTIN_TOOLS.find((t) => t.name === "calculator");
    const r = await runLocalTool(tool, JSON.stringify({ expression: "1+2*3" }));
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.content)).toEqual({ expression: "1+2*3", result: 7 });
  });

  it("calculator 拒绝非数字表达式", async () => {
    const tool = BUILTIN_TOOLS.find((t) => t.name === "calculator");
    const r = await runLocalTool(tool, JSON.stringify({ expression: "alert(1)" }));
    expect(r.isError).toBe(true);
    expect(r.retryable).toBe(false); // invalid 类不可重试
  });

  it("roll_dice 返回合法骰子点数", async () => {
    const tool = BUILTIN_TOOLS.find((t) => t.name === "roll_dice");
    const r = await runLocalTool(tool, JSON.stringify({ sides: 6, count: 3 }));
    expect(r.isError).toBe(false);
    const out = JSON.parse(r.content);
    expect(out.rolls).toHaveLength(3);
    for (const v of out.rolls) {
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(6);
    }
    expect(out.total).toBe(out.rolls.reduce((a, b) => a + b, 0));
  });
});
