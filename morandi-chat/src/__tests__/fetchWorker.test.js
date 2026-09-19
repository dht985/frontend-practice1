// fetchWorker.test.js：线上抓取端点（Cloudflare Worker）的行为与安全边界
// 用注入的 fetch 模拟 DoH 解析与目标站点，不需要真实网络。
import { describe, it, expect, vi } from "vitest";
import { handleFetch } from "../../server/fetch-worker.js";

const PUBLIC_IP = "93.184.216.34";

const request = (targetUrl, { method = "GET", token } = {}) => ({
  method,
  url: `https://worker.example/?url=${encodeURIComponent(targetUrl)}`,
  headers: {
    get: (name) => (token && name.toLowerCase() === "x-fetch-token" ? token : null),
  },
});

// 目标站点返回：{ ok, status, contentType, body, url }
function targetResponse({ text = "<html><body>hello</body></html>", status = 200, contentType = "text/html; charset=utf-8", url } = {}) {
  const bytes = new TextEncoder().encode(text);
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: (name) => (name.toLowerCase() === "content-type" ? contentType : null) },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  };
}

const dohResponse = (addresses) => ({
  ok: true,
  json: async () => ({
    Answer: addresses.map((data) => ({
      type: data.includes(":") ? 28 : 1,
      data,
    })),
  }),
});

// 组装一个 fetch 桩：DoH 查询走 dohAddresses，目标抓取走 targetHandler
function mockFetch({ dohAddresses = [PUBLIC_IP], targetHandler } = {}) {
  return vi.fn(async (url) => {
    if (String(url).startsWith("https://cloudflare-dns.com/dns-query")) {
      return dohResponse(dohAddresses);
    }
    return targetHandler ? targetHandler(url) : targetResponse();
  });
}

describe("抓取端点 - 安全边界", () => {
  it("私网 IP 字面量直接拦截，不做任何出网请求", async () => {
    const fetchImpl = mockFetch();
    const res = await handleFetch(request("http://10.0.0.1/"), {}, fetchImpl);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/拦截/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("云元数据地址被拦截", async () => {
    const res = await handleFetch(request("http://169.254.169.254/latest/meta-data/"), {}, mockFetch());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/元数据|链路本地/);
  });

  it("localhost 等本机域名在解析前就被拦截", async () => {
    const fetchImpl = mockFetch();
    const res = await handleFetch(request("http://localhost/admin"), {}, fetchImpl);
    expect(res.status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("域名解析到内网地址时拦截（防解析到私网）", async () => {
    const res = await handleFetch(
      request("http://intranet.example/"),
      {},
      mockFetch({ dohAddresses: ["192.168.1.10"] })
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/拦截/);
  });

  it("解析不到地址时按不安全处理（fail closed）", async () => {
    const res = await handleFetch(
      request("http://nx.example/"),
      {},
      mockFetch({ dohAddresses: [] })
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/未解析到任何地址/);
  });

  it("非 http/https 协议与非常用端口被拒绝", async () => {
    expect((await handleFetch(request("ftp://example.com/"), {}, mockFetch())).status).toBe(400);
    expect((await handleFetch(request("http://example.com:8080/"), {}, mockFetch())).status).toBe(403);
  });

  it("配置了令牌时，缺少或错误的令牌返回 401", async () => {
    const env = { FETCH_TOKEN: "s3cret" };
    expect((await handleFetch(request("https://example.com/"), env, mockFetch())).status).toBe(401);
    expect(
      (await handleFetch(request("https://example.com/", { token: "wrong" }), env, mockFetch())).status
    ).toBe(401);
    expect(
      (await handleFetch(request("https://example.com/", { token: "s3cret" }), env, mockFetch())).status
    ).toBe(200);
  });

  it("只接受 GET / HEAD，其它方法 405；OPTIONS 预检返回 204", async () => {
    expect((await handleFetch(request("https://example.com/", { method: "POST" }), {}, mockFetch())).status).toBe(405);
    const preflight = await handleFetch(request("https://example.com/", { method: "OPTIONS" }), {});
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toContain("GET");
  });
});

describe("抓取端点 - 正常抓取", () => {
  it("返回与本地代理一致的 JSON 信封", async () => {
    const res = await handleFetch(
      request("https://example.com/"),
      {},
      mockFetch({ targetHandler: () => targetResponse({ text: "<html><title>示例</title></html>", url: "https://example.com/" }) })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe(200);
    expect(body.finalUrl).toBe("https://example.com/");
    expect(body.html).toContain("示例");
    expect(body.truncated).toBe(false);
  });

  it("目标 4xx/5xx 时外层仍是 200，把状态码交给前端判断", async () => {
    const res = await handleFetch(
      request("https://example.com/missing"),
      {},
      mockFetch({ targetHandler: () => targetResponse({ status: 404, text: "not found" }) })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.status).toBe(404);
  });

  it("非网页类型（PDF/JSON 等）返回 415", async () => {
    const res = await handleFetch(
      request("https://example.com/data.json"),
      {},
      mockFetch({
        targetHandler: () => targetResponse({ contentType: "application/json", text: "{}" }),
      })
    );
    expect(res.status).toBe(415);
    expect((await res.json()).error).toMatch(/unsupported content-type/);
  });

  it("公网地址重定向到内网时，在跳转那一跳被拦截", async () => {
    let hop = 0;
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).startsWith("https://cloudflare-dns.com/dns-query")) {
        return dohResponse([PUBLIC_IP]);
      }
      hop += 1;
      return {
        ok: false,
        status: 302,
        headers: { get: (name) => (name.toLowerCase() === "location" ? "http://169.254.169.254/" : null) },
        body: { cancel: async () => {} },
      };
    });
    const res = await handleFetch(request("https://example.com/"), {}, fetchImpl);
    expect(res.status).toBe(403);
    expect(hop).toBe(1);
  });
});
