// providers.test.js：生成参数能力判定（重点是推理模型不能收到 temperature/top_p）
import { describe, it, expect } from "vitest";
import { getParamCaps } from "../providers";

describe("getParamCaps - 推理模型关闭 temperature/top_p", () => {
  const cases = [
    ["kimi", "kimi-k3"],
    ["kimi", "kimi-k3-128k"], // 带后缀的变体：厂商会持续出新命名，必须同样识别
    ["kimi", "KIMI-K3"], // 大小写不敏感
    ["deepseek", "deepseek-reasoner"],
    ["deepseek", "deepseek-reasoner-0528"],
    ["openai", "o1"],
    ["openai", "o3-mini"],
    ["custom", "kimi-k3-preview"], // 换服务商也要按模型名识别
    ["custom", "my-reasoner-model"],
  ];

  for (const [provider, model] of cases) {
    it(`${provider} / ${model}：不发送 temperature 与 top_p`, () => {
      const caps = getParamCaps(provider, model);
      expect(caps.temperature).toBe(false);
      expect(caps.topP).toBe(false);
    });
  }

  it("推理模型仍保留 maxTokens/stop 能力位（是否发送由用户设置决定）", () => {
    const caps = getParamCaps("kimi", "kimi-k3");
    expect(caps.maxTokens).toBe(true);
    expect(caps.stop).toBe(true);
  });
});

describe("getParamCaps - 普通模型保留采样参数", () => {
  const cases = [
    ["deepseek", "deepseek-chat"],
    ["openai", "gpt-4o-mini"],
    ["qwen", "qwen-plus"],
    ["zhipu", "glm-4-flash"],
    ["openrouter", "deepseek/deepseek-chat"],
    ["custom", "llama-3.1-70b"],
    ["custom", ""], // 未填模型名时不激进禁用
  ];

  for (const [provider, model] of cases) {
    it(`${provider} / ${model || "(空模型)"}：保留 temperature 与 top_p`, () => {
      const caps = getParamCaps(provider, model);
      expect(caps.temperature).toBe(true);
      expect(caps.topP).toBe(true);
    });
  }
});
