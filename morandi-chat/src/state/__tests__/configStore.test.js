// configStore.test.js：服务商档案、会话级 API Key、工作台默认值、时间上下文
import { describe, it, expect, beforeEach } from "vitest";
import {
  CONFIG_KEY,
  DEFAULT_WORKBENCH,
  buildTimeMessage,
  configForStorage,
  loadConfig,
  loadJSON,
  safeSetItem,
  writeSessionKey,
} from "../configStore";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe("loadJSON / safeSetItem", () => {
  it("没有数据时返回 fallback", () => {
    expect(loadJSON("nope", { a: 1 })).toEqual({ a: 1 });
  });

  it("JSON 损坏时回退 fallback，不抛错", () => {
    localStorage.setItem("broken", "{不是 json");
    expect(loadJSON("broken", "fallback")).toBe("fallback");
  });

  it("safeSetItem 写入成功返回 true，并能读回", () => {
    expect(safeSetItem("k", JSON.stringify({ v: 1 }))).toBe(true);
    expect(JSON.parse(localStorage.getItem("k"))).toEqual({ v: 1 });
  });
});

describe("loadConfig - 档案加载与旧版迁移", () => {
  it("首次使用返回一个可用的默认档案", () => {
    const config = loadConfig();
    expect(config.profiles).toHaveLength(1);
    expect(config.profiles[0].provider).toBe("kimi");
    expect(config.profiles[0].baseURL).toContain("http");
    expect(config.profiles[0].apiKey).toBe("");
    expect(config.activeId).toBe(config.profiles[0].id);
  });

  it("旧版单配置迁移为多档案结构", () => {
    localStorage.setItem(
      CONFIG_KEY,
      JSON.stringify({ baseURL: "https://api.deepseek.com/v1", apiKey: "sk-old", model: "deepseek-chat" })
    );
    const config = loadConfig();
    expect(config.profiles).toHaveLength(1);
    expect(config.profiles[0].provider).toBe("deepseek");
    expect(config.profiles[0].apiKey).toBe("sk-old");
  });

  it("旧版已下线的模型名迁移到 kimi-k3", () => {
    localStorage.setItem(CONFIG_KEY, JSON.stringify({ model: "moonshot-v1-8k" }));
    expect(loadConfig().profiles[0].model).toBe("kimi-k3");
  });

  it("已是多档案结构时原样读回，并保留 persistKey", () => {
    localStorage.setItem(
      CONFIG_KEY,
      JSON.stringify({
        profiles: [
          { id: "p1", provider: "openai", baseURL: "https://api.openai.com/v1", apiKey: "sk-1", model: "gpt-4o-mini", persistKey: true },
          { id: "p2", provider: "kimi", baseURL: "https://api.moonshot.cn/v1", apiKey: "", model: "kimi-k3", persistKey: false },
        ],
        activeId: "p2",
      })
    );
    const config = loadConfig();
    expect(config.activeId).toBe("p2");
    expect(config.profiles[1].persistKey).toBe(false);
  });
});

describe("会话级 API Key（不落盘）", () => {
  it("persistKey=false 的档案从 sessionStorage 取 Key", () => {
    localStorage.setItem(
      CONFIG_KEY,
      JSON.stringify({
        profiles: [
          { id: "p1", provider: "kimi", baseURL: "https://api.moonshot.cn/v1", apiKey: "", model: "kimi-k3", persistKey: false },
        ],
        activeId: "p1",
      })
    );
    writeSessionKey("p1", "sk-session");
    expect(loadConfig().profiles[0].apiKey).toBe("sk-session");
  });

  it("configForStorage 会清掉会话级档案的 Key，保留持久化档案的 Key", () => {
    const config = {
      profiles: [
        { id: "p1", apiKey: "sk-keep", persistKey: true },
        { id: "p2", apiKey: "sk-session", persistKey: false },
      ],
      activeId: "p1",
    };
    const stored = configForStorage(config);
    expect(stored.profiles[0].apiKey).toBe("sk-keep");
    expect(stored.profiles[1].apiKey).toBe("");
  });
});

describe("buildTimeMessage / DEFAULT_WORKBENCH", () => {
  it("时间上下文是 system 消息，包含日期与星期", () => {
    const msg = buildTimeMessage();
    expect(msg.role).toBe("system");
    expect(msg.content).toContain("年");
    expect(msg.content).toContain("星期");
    expect(msg.content).toContain("时区");
  });

  it("工作台默认值包含上下文窗口与生成参数", () => {
    expect(DEFAULT_WORKBENCH.contextWindow).toBe(0);
    expect(DEFAULT_WORKBENCH.temperature).toBeGreaterThan(0);
    expect(DEFAULT_WORKBENCH.structured).toBe(false);
  });
});
