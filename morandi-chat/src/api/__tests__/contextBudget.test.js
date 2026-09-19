// contextBudget.test.js：上下文估算与整轮裁剪
import { describe, it, expect } from "vitest";
import {
  DEFAULT_CONTEXT_WINDOW,
  IMAGE_TOKENS,
  estimateTextTokens,
  estimateContentTokens,
  estimateMessagesTokens,
  estimateNodesTokens,
  reservedOutputTokens,
  splitIntoTurns,
  trimNodesToBudget,
} from "../contextBudget";

const imagePayload = {
  parts: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }],
  systemMessages: [],
  skipped: [],
  askText: "看看这张图",
};

const docPayload = {
  parts: [],
  systemMessages: [{ role: "system", content: "文档正文".repeat(100) }],
  skipped: [],
  askText: "总结这个文档",
};

const turn = (i, payload) => [
  { id: `u${i}`, role: "user", content: `问题${i}`, ...(payload ? {} : {}) },
  { id: `a${i}`, role: "assistant", content: `回答${i}` },
];

describe("estimateTextTokens", () => {
  it("空文本为 0", () => {
    expect(estimateTextTokens("")).toBe(0);
    expect(estimateTextTokens(null)).toBe(0);
  });

  it("中文按 1 字 1 token", () => {
    expect(estimateTextTokens("你好世界")).toBe(4);
  });

  it("英文按 4 字符 1 token 向上取整", () => {
    expect(estimateTextTokens("hello world")).toBe(3); // 11 字符 → ceil(11/4)
  });

  it("中英混排分别计算", () => {
    expect(estimateTextTokens("你好abcd")).toBe(3); // 2 + ceil(4/4)
  });
});

describe("estimateContentTokens / estimateMessagesTokens", () => {
  it("字符串内容直接估算", () => {
    expect(estimateContentTokens("你好")).toBe(2);
  });

  it("多模态数组按 part 类型估算（图片按常数）", () => {
    const tokens = estimateContentTokens([
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      { type: "text", text: "你好" },
    ]);
    expect(tokens).toBe(IMAGE_TOKENS + 2);
  });

  it("消息数组累加并计入每条的消息开销", () => {
    const tokens = estimateMessagesTokens([
      { role: "system", content: "你好" },
      { role: "user", content: "你好" },
    ]);
    expect(tokens).toBe(2 + 2 + 4 * 2);
  });
});

describe("splitIntoTurns", () => {
  it("以 user 消息为界切分", () => {
    const nodes = [...turn(1), ...turn(2)];
    const turns = splitIntoTurns(nodes);
    expect(turns).toHaveLength(2);
    expect(turns[0].map((n) => n.role)).toEqual(["user", "assistant"]);
    expect(turns[1][0].id).toBe("u2");
  });

  it("空输入返回空数组", () => {
    expect(splitIntoTurns([])).toEqual([]);
    expect(splitIntoTurns(undefined)).toEqual([]);
  });
});

describe("estimateNodesTokens", () => {
  it("附件（多模态 parts）计入所在轮次", () => {
    const nodes = turn(1);
    const plain = estimateNodesTokens(nodes, new Map());
    const withImage = estimateNodesTokens(nodes, new Map([["u1", imagePayload]]));
    expect(withImage - plain).toBe(IMAGE_TOKENS);
  });

  it("文档抽取文本（system 消息）也计入", () => {
    const nodes = turn(1);
    const plain = estimateNodesTokens(nodes, new Map());
    const withDoc = estimateNodesTokens(nodes, new Map([["u1", docPayload]]));
    expect(withDoc).toBeGreaterThan(plain + 100);
  });
});

describe("reservedOutputTokens", () => {
  it("设置了最大输出长度就用它", () => {
    expect(reservedOutputTokens(2000)).toBe(2000);
  });

  it("未设置（0/空）时用默认预留", () => {
    expect(reservedOutputTokens(0)).toBe(8000);
    expect(reservedOutputTokens(undefined)).toBe(8000);
  });
});

describe("trimNodesToBudget", () => {
  const manyTurns = () => {
    const nodes = [];
    for (let i = 1; i <= 6; i++) nodes.push(...turn(i));
    return nodes;
  };

  it("预算充足时一轮都不裁", () => {
    const nodes = manyTurns();
    const plan = trimNodesToBudget(nodes, new Map(), {
      budgetTokens: 100000,
      reservedTokens: 0,
      fixedTokens: 0,
    });
    expect(plan.nodes).toEqual(nodes);
    expect(plan.droppedTurns).toBe(0);
  });

  it("预算不足时从最早的轮次开始整轮丢弃", () => {
    const nodes = manyTurns();
    const plan = trimNodesToBudget(nodes, new Map(), {
      budgetTokens: 60, // 每轮约 12 token
      reservedTokens: 0,
      fixedTokens: 0,
    });
    expect(plan.droppedTurns).toBeGreaterThan(0);
    // 保留的必须是末尾连续若干轮，且从 user 消息开始
    expect(plan.nodes[0].role).toBe("user");
    expect(plan.nodes[plan.nodes.length - 1].id).toBe("a6");
    expect(plan.nodes).toEqual(nodes.slice(nodes.length - plan.nodes.length));
  });

  it("最后一轮永远保留，即使它自己就超预算", () => {
    const nodes = [...turn(1), { id: "u2", role: "user", content: "很长的问题".repeat(50) }];
    const plan = trimNodesToBudget(nodes, new Map(), {
      budgetTokens: 20,
      reservedTokens: 0,
      fixedTokens: 0,
    });
    expect(plan.nodes[plan.nodes.length - 1].id).toBe("u2");
    expect(plan.keptTurns).toBe(1);
  });

  it("固定开销（system + 本轮提问）会挤压可用额度", () => {
    const nodes = manyTurns();
    const wide = trimNodesToBudget(nodes, new Map(), { budgetTokens: 100000, fixedTokens: 0 });
    const tight = trimNodesToBudget(nodes, new Map(), { budgetTokens: 100, fixedTokens: 80 });
    expect(tight.keptTurns).toBeLessThan(wide.keptTurns);
    expect(tight.allowedTokens).toBe(20);
  });

  it("带附件的老轮次会因 token 更高而更早被裁掉", () => {
    const nodes = manyTurns();
    const map = new Map([["u1", imagePayload], ["u2", imagePayload], ["u3", imagePayload]]);
    const plan = trimNodesToBudget(nodes, map, {
      budgetTokens: 2000,
      reservedTokens: 0,
      fixedTokens: 0,
    });
    expect(plan.droppedTurns).toBeGreaterThanOrEqual(1);
    expect(plan.nodes.some((n) => n.id === "u1")).toBe(false);
  });

  it("空历史返回空计划", () => {
    const plan = trimNodesToBudget([], new Map(), {});
    expect(plan.nodes).toEqual([]);
    expect(plan.droppedTurns).toBe(0);
    expect(plan.budgetTokens).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it("非法预算回退到默认窗口", () => {
    const plan = trimNodesToBudget(manyTurns(), new Map(), { budgetTokens: 0 });
    expect(plan.budgetTokens).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(plan.droppedTurns).toBe(0);
  });
});
