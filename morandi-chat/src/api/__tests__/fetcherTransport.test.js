// fetcherTransport.test.js：抓取源选择（自建端点 / 第三方兜底）
//
// import.meta.env 在模块加载时就固定了，所以每个用例用 vi.stubEnv + resetModules 重新加载模块。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const jinaBody = [
  "Title: 示例站点",
  "",
  "URL Source: https://example.com/",
  "",
  "Published Time: 2026-09-19",
  "",
  "Markdown Content:",
  "这是正文第一段。",
  "这是正文第二段。",
].join("\n");

async function loadFetcher({ dev = false, endpoint = "" } = {}) {
  vi.stubEnv("DEV", dev);
  vi.stubEnv("VITE_FETCH_ENDPOINT", endpoint);
  vi.resetModules();
  return await import("../fetcher");
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("抓取源选择", () => {
  it("没有自建端点时走第三方阅读服务，并把返回的元信息头剥掉", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => jinaBody,
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchUrl } = await loadFetcher({ dev: false, endpoint: "" });

    const out = await fetchUrl("https://example.com/");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://r.jina.ai/https://example.com/");
    expect(out.title).toBe("示例站点");
    expect(out.source).toBe("r.jina.ai");
    expect(out.content).toContain("这是正文第一段。");
    expect(out.content).not.toContain("URL Source:");
    expect(out.content).not.toContain("Title:");
  });

  it("显式关闭第三方源时给出可操作的错误（两条出路）", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { fetchUrl } = await loadFetcher({ dev: false, endpoint: "" });

    await expect(
      fetchUrl("https://example.com/", undefined, { allowThirdParty: false })
    ).rejects.toThrow(/VITE_FETCH_ENDPOINT[\s\S]*第三方抓取源/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("配置了自建端点时优先走自建端点，不碰第三方", async () => {
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes("/__fetch__")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            status: 200,
            finalUrl: "https://example.com/",
            contentType: "text/html",
            html: "<html><body><article><h1>标题</h1><p>正文内容正文内容。</p></article></body></html>",
          }),
        };
      }
      throw new Error("不应该请求第三方：" + url);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { fetchUrl } = await loadFetcher({ dev: true, endpoint: "" });

    const out = await fetchUrl("https://example.com/");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/__fetch__");
    expect(out.source).toBeUndefined(); // 自建端点路径不带 source 字段
    expect(out.content).toContain("正文内容");
  });

  it("第三方源返回错误状态时抛出带状态码的错误", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 429, text: async () => "rate limited" }))
    );
    const { fetchUrl } = await loadFetcher({ dev: false, endpoint: "" });

    await expect(fetchUrl("https://example.com/")).rejects.toThrow(/429/);
  });

  it("私网地址在任何模式下都被本地拦下（不会发给第三方）", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { fetchUrl } = await loadFetcher({ dev: false, endpoint: "" });

    await expect(fetchUrl("http://127.0.0.1:8080/")).rejects.toThrow(/本机|局域网|元数据/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
