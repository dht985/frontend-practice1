// sessionTrace.test.js：本地诊断记录（容量上限、步骤、导出、订阅）
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  addStep,
  clearTraces,
  endTrace,
  exportTraces,
  listTraces,
  startTrace,
  subscribe,
  traceCount,
  _resetTraces,
} from "../sessionTrace";

beforeEach(() => {
  _resetTraces();
});

describe("sessionTrace - 基本流程", () => {
  it("startTrace 返回 id，并进入 running 状态", () => {
    const id = startTrace("chat-request", { provider: "kimi", model: "kimi-k3" });
    expect(typeof id).toBe("string");
    const [trace] = listTraces();
    expect(trace.id).toBe(id);
    expect(trace.status).toBe("running");
    expect(trace.meta.provider).toBe("kimi");
  });

  it("addStep 按顺序累积步骤，并带相对耗时", () => {
    const id = startTrace("chat-request");
    addStep(id, "status", { status: "tool", tool: "calculator" });
    addStep(id, "round", { round: 1, toolCalls: 1 });
    const [trace] = listTraces();
    expect(trace.steps.map((s) => s.type)).toEqual(["status", "round"]);
    expect(trace.steps[0].tool).toBe("calculator");
    expect(typeof trace.steps[0].ms).toBe("number");
  });

  it("endTrace 写入状态与耗时，且只结束一次", () => {
    const id = startTrace("chat-request");
    endTrace(id, { status: "done", usage: { total_tokens: 42 }, contentLength: 10 });
    endTrace(id, { status: "error" }); // 二次调用不应覆盖
    const [trace] = listTraces();
    expect(trace.status).toBe("done");
    expect(trace.usage.total_tokens).toBe(42);
    expect(trace.contentLength).toBe(10);
    expect(typeof trace.durationMs).toBe("number");
  });

  it("对不存在的 trace 写入不会报错", () => {
    expect(() => addStep("nope", "x")).not.toThrow();
    expect(() => endTrace("nope", { status: "done" })).not.toThrow();
  });
});

describe("sessionTrace - 容量与清理", () => {
  it("只保留最近 30 次请求，最旧的被丢弃", () => {
    for (let i = 0; i < 35; i++) startTrace("chat-request", { index: i });
    expect(traceCount()).toBe(30);
    const traces = listTraces();
    expect(traces[0].meta.index).toBe(34); // 最新在前
    expect(traces.at(-1).meta.index).toBe(5);
  });

  it("单条请求的步骤有上限，避免异常循环把内存撑爆", () => {
    const id = startTrace("chat-request");
    for (let i = 0; i < 250; i++) addStep(id, "round", { round: i });
    expect(listTraces()[0].steps).toHaveLength(200);
  });

  it("clearTraces 清空全部记录", () => {
    startTrace("chat-request");
    clearTraces();
    expect(traceCount()).toBe(0);
  });
});

describe("sessionTrace - 导出与订阅", () => {
  it("导出的 JSON 含有导出时间与全部记录", () => {
    const id = startTrace("chat-request", { provider: "kimi" });
    addStep(id, "round", { round: 1 });
    endTrace(id, { status: "done" });
    const parsed = JSON.parse(exportTraces());
    expect(parsed.count).toBe(1);
    expect(parsed.traces[0].steps[0].type).toBe("round");
    expect(typeof parsed.exportedAt).toBe("string");
  });

  it("订阅者会在开始/记录/结束时收到通知，取消订阅后不再收到", () => {
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);
    const id = startTrace("chat-request");
    addStep(id, "round", { round: 1 });
    endTrace(id, { status: "done" });
    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(3);

    unsubscribe();
    const before = listener.mock.calls.length;
    startTrace("chat-request");
    expect(listener.mock.calls.length).toBe(before);
  });

  it("不记录对话正文，只记长度与状态（隐私）", () => {
    const id = startTrace("chat-request");
    endTrace(id, { status: "done", contentLength: 1234 });
    const json = exportTraces();
    const [trace] = listTraces();
    expect(trace.contentLength).toBe(1234);
    expect(json).not.toMatch(/content:\s*"/); // 没有正文内容字段
  });
});
