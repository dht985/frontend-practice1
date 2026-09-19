// App.integration.test.jsx：整链路测试
//
// 挂载真实的 <App />（真 UI、真流式解析、真工具循环），只在 fetch 层伪造服务商：
// 返回真正的 SSE 流，所以 chat.js 的解析、App 的流式写回、工具循环、附件回灌
// 都是被真实执行的那条代码路径。
//
// 覆盖主链路：流式回复 / 停止与继续 / 带附件重试 / 工具调用循环 / 上下文预算裁剪。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import App from "../App";
import { _resetConversationDB, clearConversationData } from "../api/conversationStore";
import { _resetTraces, listTraces } from "../api/sessionTrace";

const CONFIG_KEY = "morandi-chat-config";
const WORKBENCH_KEY = "morandi-chat-workbench";

// —— 伪造服务商 ——

const encoder = new TextEncoder();

const sseChunk = (payload) => `data: ${JSON.stringify(payload)}\n\n`;
const textChunk = (text) => ({ choices: [{ index: 0, delta: { content: text } }] });

function sseResponse(payloads, { status = 200 } = {}) {
  const stream = new ReadableStream({
    start(controller) {
      for (const payload of payloads) controller.enqueue(encoder.encode(sseChunk(payload)));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return { ok: status < 400, status, body: stream, text: async () => "mock error body" };
}

const textResponse = (...texts) => sseResponse(texts.map(textChunk));
const errorResponse = (status = 500) => ({
  ok: false,
  status,
  text: async () => "mock provider error",
});

// 先发一段、然后一直挂着的流：用于测试「停止生成」
function pendingResponse(firstText, signal) {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sseChunk(textChunk(firstText))));
      signal?.addEventListener("abort", () => {
        try {
          controller.error(new DOMException("Aborted", "AbortError"));
        } catch {
          // 已经关闭则忽略
        }
      });
    },
  });
  return { ok: true, status: 200, body: stream, text: async () => "" };
}

const toolCallResponse = (name, argsJson, callId = "call_1") =>
  sseResponse([
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: callId, type: "function", function: { name, arguments: argsJson } },
            ],
          },
        },
      ],
    },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ]);

// 打桩 fetch 并记录每次请求体，便于断言「发出去的到底是什么」
function mockProvider(handler) {
  const calls = [];
  const fetchMock = vi.fn(async (url, init = {}) => {
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url, body, signal: init.signal });
    return handler(calls.length, { url, body, signal: init.signal });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

async function sendMessage(text) {
  const textarea = screen.getByPlaceholderText(/输入消息|附上一句说明/);
  fireEvent.change(textarea, { target: { value: text } });
  fireEvent.keyDown(textarea, { key: "Enter" });
}

beforeEach(async () => {
  // jsdom 没实现的浏览器 API：按需垫平
  Element.prototype.scrollIntoView = vi.fn();
  URL.createObjectURL = vi.fn(() => "blob:mock");
  URL.revokeObjectURL = vi.fn();

  localStorage.clear();
  sessionStorage.clear();
  // 对话现在存在 IndexedDB 里，测试之间要清干净，避免上一轮的数据串进来
  _resetConversationDB();
  await clearConversationData();
  _resetTraces();
  localStorage.setItem(
    CONFIG_KEY,
    JSON.stringify({
      profiles: [
        {
          id: "p1",
          provider: "kimi",
          baseURL: "https://api.mock/v1",
          apiKey: "test-key",
          model: "kimi-k3",
          persistKey: true,
        },
      ],
      activeId: "p1",
    })
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("App 整链路", () => {
  it("流式回复：多个分片拼成一条完整回答", async () => {
    mockProvider(async () => textResponse("你好", "，世界"));
    render(<App />);

    await sendMessage("打个招呼");

    await waitFor(() => expect(screen.getByText("你好，世界")).toBeTruthy());
  });

  it("工具调用：本地执行后把结果回传模型，再给出最终回答", async () => {
    const calls = mockProvider(async (n) =>
      n === 1
        ? toolCallResponse("calculator", JSON.stringify({ expression: "1+2*3" }))
        : textResponse("结果是 7")
    );
    render(<App />);

    await sendMessage("算一下 1+2*3");

    await waitFor(() => expect(screen.getByText("结果是 7")).toBeTruthy());
    expect(calls).toHaveLength(2);
    const toolMessage = calls[1].body.messages.find((m) => m.role === "tool");
    expect(toolMessage).toBeTruthy();
    expect(String(toolMessage.content)).toContain("7");
  });

  it("停止生成后可以继续生成，内容接在同一条回答上", async () => {
    mockProvider(async (n, { signal }) =>
      n === 1 ? pendingResponse("第一段", signal) : textResponse("第二段")
    );
    render(<App />);

    await sendMessage("写一段话");
    await waitFor(() => expect(screen.getByText("第一段")).toBeTruthy());

    fireEvent.click(screen.getByTitle("停止生成"));
    await waitFor(() => expect(screen.getByTitle("继续生成")).toBeTruthy());

    fireEvent.click(screen.getByTitle("继续生成"));
    await waitFor(() => expect(screen.getByText("第一段第二段")).toBeTruthy());
  });

  it("带图片的消息重试时，仍会把附件重新发给模型", async () => {
    const calls = mockProvider(async (n) => (n === 1 ? errorResponse(500) : textResponse("重试后的回答")));
    render(<App />);

    const file = new File([new Uint8Array([1, 2, 3])], "pic.png", { type: "image/png" });
    fireEvent.change(document.querySelector('input[type="file"]'), { target: { files: [file] } });
    await sendMessage("看看这张图");

    await waitFor(() => expect(screen.getByText(/⚠️/)).toBeTruthy());
    fireEvent.click(screen.getByText("重试"));

    await waitFor(() => expect(calls).toHaveLength(2));
    const retried = calls[1].body.messages.at(-1);
    expect(Array.isArray(retried.content)).toBe(true);
    expect(retried.content[0].type).toBe("image_url");
  });

  it("超出上下文预算时省略最早的轮次，并在界面上说明", async () => {
    // 把窗口设得极小：可用额度为 0，只剩最后一轮
    localStorage.setItem(WORKBENCH_KEY, JSON.stringify({ contextWindow: 60 }));
    const calls = mockProvider(async () => textResponse("好的"));
    render(<App />);

    await sendMessage("第一个问题");
    await waitFor(() => expect(calls).toHaveLength(1));
    await sendMessage("第二个问题");
    await waitFor(() => expect(calls).toHaveLength(2));
    await sendMessage("第三个问题");
    await waitFor(() => expect(calls).toHaveLength(3));

    const lastRequest = calls[2].body.messages;
    // 预算只够最后一轮：最早那轮被丢掉，保留「上一轮 + 当前提问」
    const userTexts = lastRequest.filter((m) => m.role === "user").map((m) => m.content);
    expect(userTexts).toEqual(["第二个问题", "第三个问题"]);
    expect(lastRequest.at(-1).content).toBe("第三个问题");
    await waitFor(() => expect(screen.getByText(/省略了最早的 \d+ 轮对话/)).toBeTruthy());
  });

  it("每次请求都会留下一条本地诊断记录（只有元信息，不含正文）", async () => {
    mockProvider(async () => textResponse("好的"));
    render(<App />);

    await sendMessage("记录一下这次请求");
    await waitFor(() => expect(screen.getByText("好的")).toBeTruthy());

    const traces = listTraces();
    expect(traces).toHaveLength(1);
    expect(traces[0].status).toBe("done");
    expect(traces[0].meta.provider).toBe("kimi");
    expect(traces[0].steps.some((s) => s.type === "round")).toBe(true);
    expect(typeof traces[0].durationMs).toBe("number");
    expect(traces[0].contentLength).toBe(2);
  });
});
