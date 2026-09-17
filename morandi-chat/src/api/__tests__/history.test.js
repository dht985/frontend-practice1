// history.test.js：对话树 → 请求消息的转换（含附件回灌）测试
import { describe, it, expect } from "vitest";
import {
  buildHistoryMessages,
  attachmentSystemMessages,
  skippedFileMessages,
  userContentWithAttachments,
  DEFAULT_ATTACHMENT_PROMPT,
} from "../history";

const imagePayload = {
  parts: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }],
  systemMessages: [],
  skipped: [],
  askText: "看看这张图",
};

const docPayload = {
  parts: [],
  systemMessages: [{ role: "system", content: "用户上传了文件《a.pdf》……正文" }],
  skipped: [],
  askText: "总结这个文档",
};

describe("userContentWithAttachments", () => {
  it("没有附件载荷时保持纯文本", () => {
    expect(userContentWithAttachments("你好", undefined)).toBe("你好");
  });

  it("有图片时拼成多模态数组，文本放在最后", () => {
    const content = userContentWithAttachments("看看这张图", imagePayload);
    expect(Array.isArray(content)).toBe(true);
    expect(content[0].type).toBe("image_url");
    expect(content[content.length - 1]).toEqual({ type: "text", text: "看看这张图" });
  });

  it("只有文件没有文字时用存下来的兜底提问", () => {
    expect(userContentWithAttachments("", imagePayload)).toEqual([
      imagePayload.parts[0],
      { type: "text", text: "看看这张图" },
    ]);
  });

  it("纯文档附件（无 parts）返回文本形式", () => {
    expect(userContentWithAttachments("总结这个文档", docPayload)).toBe("总结这个文档");
  });

  it("整条消息都是空的时候用默认提问，不会发出空内容", () => {
    expect(userContentWithAttachments("", { ...docPayload, askText: "" })).toBe(
      DEFAULT_ATTACHMENT_PROMPT
    );
  });
});

describe("buildHistoryMessages", () => {
  const nodes = [
    { id: "u1", role: "user", content: "看看这张图" },
    { id: "a1", role: "assistant", content: "这是一只猫。" },
    { id: "u2", role: "user", content: "再详细点" },
  ];

  it("保持原有的过滤规则：空 assistant 不要、错误气泡不要", () => {
    const messages = buildHistoryMessages(
      [...nodes, { id: "a2", role: "assistant", content: "" }, { id: "a3", role: "assistant", content: "⚠️ 出错了" }],
      new Map()
    );
    expect(messages).toHaveLength(3);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("历史里的 user 节点会按 id 找回附件（多轮对话不再丢图）", () => {
    const messages = buildHistoryMessages(nodes, new Map([["u1", imagePayload]]));
    expect(Array.isArray(messages[0].content)).toBe(true);
    expect(messages[0].content[0]).toEqual(imagePayload.parts[0]);
    expect(messages[2].content).toBe("再详细点");
  });

  it("重试场景：把要重发的那条 user 内容单独算出来时也能带上附件", () => {
    const payload = new Map([["u1", imagePayload]]);
    const content = userContentWithAttachments("", payload.get("u1"));
    expect(Array.isArray(content)).toBe(true);
  });

  it("联网开启时剔除历史上的“无法联网”回复", () => {
    const withFail = [
      { id: "u1", role: "user", content: "今天有什么新闻" },
      { id: "a1", role: "assistant", content: "抱歉，我无法联网，不能查询实时信息。" },
    ];
    expect(buildHistoryMessages(withFail, new Map())).toHaveLength(2);
    expect(buildHistoryMessages(withFail, new Map(), { webSearch: true })).toHaveLength(1);
  });
});

describe("attachmentSystemMessages", () => {
  it("收集用户节点上保存的文档抽取文本", () => {
    const nodes = [
      { id: "u1", role: "user", content: "总结这个文档" },
      { id: "a1", role: "assistant", content: "好的" },
      { id: "u2", role: "user", content: "接着上一份文件说" },
    ];
    const map = new Map([
      ["u1", docPayload],
      ["u2", docPayload],
      ["a1", docPayload], // assistant 节点上的载荷不参与
    ]);
    expect(attachmentSystemMessages(nodes, map)).toHaveLength(2);
  });

  it("没有任何附件时返回空数组", () => {
    expect(attachmentSystemMessages([{ id: "u1", role: "user", content: "x" }], new Map())).toEqual([]);
    expect(attachmentSystemMessages(undefined, undefined)).toEqual([]);
  });
});

describe("skippedFileMessages", () => {
  it("把跳过的文件整理成 system 提示", () => {
    const messages = skippedFileMessages([{ name: "a.mp3", reason: "当前模型暂不支持音频理解" }]);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("a.mp3");
  });

  it("没有跳过文件时返回空数组", () => {
    expect(skippedFileMessages([])).toEqual([]);
    expect(skippedFileMessages(undefined)).toEqual([]);
  });
});
