import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import MessageBubble from "../MessageBubble";

// 覆盖本次改动的两个关键行为：reasoning 思考过程展示、Markdown 渲染安全（rehype-raw 红线）
describe("MessageBubble 思考过程展示", () => {
  it("流式期间显示「思考中…」并实时渲染思考内容", () => {
    const msg = { id: "a1", role: "assistant", content: "", streaming: true };
    render(<MessageBubble message={msg} index={0} streamingReasoning="我先拆解一下这个问题…" />);
    expect(screen.getByText("思考中…")).toBeTruthy();
    expect(screen.getByText("我先拆解一下这个问题…")).toBeTruthy();
  });

  it("完成后显示「思考过程」折叠块，展示写回树的 reasoning", () => {
    const msg = { id: "a1", role: "assistant", content: "最终回答", reasoning: "完整的思考过程文本" };
    render(<MessageBubble message={msg} index={0} />);
    expect(screen.getByText("思考过程")).toBeTruthy();
    expect(screen.getByText("完整的思考过程文本")).toBeTruthy();
  });

  it("无 reasoning 时（普通模型）不渲染思考过程块", () => {
    const msg = { id: "a1", role: "assistant", content: "普通回答" };
    const { container } = render(<MessageBubble message={msg} index={0} />);
    expect(container.querySelector("details")).toBeNull();
  });
});

describe("MessageBubble Markdown 渲染安全", () => {
  it("模型输出中的 HTML 不被渲染为真实 DOM（防 XSS）", () => {
    const msg = {
      id: "a1",
      role: "assistant",
      content: '<script>alert(1)</script><img src=x onerror=alert(2)>',
    };
    const { container } = render(<MessageBubble message={msg} index={0} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });
});
