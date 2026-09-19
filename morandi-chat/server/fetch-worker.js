// 线上抓取端点：Cloudflare Worker
//
// 作用与本地开发代理（../fetch-proxy.js）一致，返回同样的 JSON 信封，
// 前端只要把 VITE_FETCH_ENDPOINT 指向本 Worker 即可，抓取与正文解析逻辑不用改。
//
// 安全设计：
//   - 规则复用 shared/ssrfGuard.js（协议 / 端口 / 私网与云元数据 / 本机域名）
//   - 域名先用 DNS-over-HTTPS 解析，**解析出的每个地址**都校验，防「解析到内网」
//   - 重定向逐跳校验（公网 302 到内网是常见绕过手法）
//   - 可选令牌（环境变量 FETCH_TOKEN）：不是机密（前端包里可见），但能挡住随手盗用
//   - 只放行网页类 Content-Type，响应体最多 2MB，15 秒超时
//
// 已知局限：DoH 解析与实际连接之间仍有 DNS rebinding 的时间窗；要更严格需在
// 连接层把 IP 钉死（Workers 平台不支持自定义 dialer，故这里是尽力而为）。

import { blockedReason, isIpLiteral, parseTargetUrl } from "../shared/ssrfGuard.js";

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const HTML_CONTENT_TYPE =
  /text\/html|application\/xhtml\+xml|text\/plain|text\/xml|application\/xml/i;
const UA =
  "Mozilla/5.0 (compatible; MorandiChatFetcher/1.0; +https://github.com/dht985/frontend-practice1)";

export default {
  fetch: (request, env) => handleFetch(request, env),
};

function corsHeaders(env) {
  return {
    "access-control-allow-origin": env?.ALLOW_ORIGIN || "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "x-fetch-token, accept",
    "access-control-max-age": "86400",
  };
}

function sendJson(body, status, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...corsHeaders(env),
    },
  });
}

// 用 DoH 解析域名：返回全部 A/AAAA 地址（失败或没解析到 → 调用方按不安全处理）
async function resolveAddresses(hostname, fetchImpl) {
  const out = [];
  for (const [type, code] of [
    ["A", 1],
    ["AAAA", 28],
  ]) {
    try {
      const resp = await fetchImpl(
        `${DOH_ENDPOINT}?name=${encodeURIComponent(hostname)}&type=${type}`,
        { headers: { accept: "application/dns-json" } }
      );
      if (!resp.ok) continue;
      const data = await resp.json();
      for (const answer of data?.Answer || []) {
        if (answer?.type === code && typeof answer.data === "string") out.push(answer.data);
      }
    } catch {
      // 单个查询失败就继续试下一个
    }
  }
  return out;
}

// 域名层 + 解析后地址层校验；通过则返回解析出的地址
async function assertSafeTarget(rawUrl, fetchImpl) {
  const { url, hostname } = parseTargetUrl(rawUrl);
  if (isIpLiteral(hostname)) return { url: url.toString(), hostname, addresses: [hostname] };
  const addresses = await resolveAddresses(hostname, fetchImpl);
  if (!addresses.length) {
    const err = new Error(`域名 ${hostname} 未解析到任何地址`);
    err.code = "unsafe_target";
    err.httpStatus = 403;
    throw err;
  }
  for (const address of addresses) {
    const reason = blockedReason(address);
    if (reason) {
      const err = new Error(`目标地址被拦截：${hostname} → ${address}（${reason}）`);
      err.code = "unsafe_target";
      err.httpStatus = 403;
      throw err;
    }
  }
  return { url: url.toString(), hostname, addresses };
}

async function readCappedText(response, maxBytes) {
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = maxBytes - total;
    if (value.length >= remaining) {
      chunks.push(value.subarray(0, remaining));
      total = maxBytes;
      truncated = true;
      reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes: merged, truncated };
}

/**
 * 处理一次抓取请求（导出以便测试）
 * @param {Request} request
 * @param {{FETCH_TOKEN?: string, ALLOW_ORIGIN?: string}} env
 * @param {typeof fetch} [fetchImpl] 便于测试注入
 */
export async function handleFetch(request, env = {}, fetchImpl = fetch) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(env) });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return sendJson({ ok: false, error: "仅支持 GET 请求" }, 405, env);
  }
  if (env.FETCH_TOKEN && request.headers.get("x-fetch-token") !== env.FETCH_TOKEN) {
    return sendJson({ ok: false, error: "缺少或错误的抓取令牌（x-fetch-token）" }, 401, env);
  }

  const target = new URL(request.url).searchParams.get("url") || "";
  if (!/^https?:\/\//i.test(target)) {
    return sendJson({ ok: false, error: "仅允许抓取 http/https 协议的 URL" }, 400, env);
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let resp;
  let currentUrl = target;
  try {
    for (let redirects = 0; ; ) {
      await assertSafeTarget(currentUrl, fetchImpl);
      resp = await fetchImpl(currentUrl, {
        redirect: "manual",
        signal: ctrl.signal,
        headers: {
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
          "user-agent": UA,
        },
      });
      const location =
        resp.status >= 300 && resp.status < 400 ? resp.headers.get("location") : null;
      if (!location) break;
      resp.body?.cancel?.().catch(() => {});
      if (redirects >= MAX_REDIRECTS) throw new Error(`重定向次数超过上限（${MAX_REDIRECTS} 次）`);
      redirects += 1;
      currentUrl = new URL(location, currentUrl).toString();
    }
  } catch (err) {
    clearTimeout(timer);
    if (err?.code === "unsafe_target") {
      return sendJson({ ok: false, error: err.message }, err.httpStatus || 403, env);
    }
    const timedOut = err?.name === "AbortError" || err?.name === "TimeoutError";
    return sendJson(
      {
        ok: false,
        error: timedOut
          ? `抓取超时（超过 ${TIMEOUT_MS / 1000} 秒），该站点可能不可达或响应过慢`
          : `网络错误，无法连接目标网站：${err?.message || err}`,
      },
      timedOut ? 504 : 502,
      env
    );
  }
  clearTimeout(timer);

  const finalUrl = resp.url || currentUrl;
  const contentType = resp.headers.get("content-type") || "";

  if (!resp.ok) {
    resp.body?.cancel?.().catch(() => {});
    return sendJson(
      {
        ok: false,
        status: resp.status,
        finalUrl,
        contentType,
        error: `目标网站返回 HTTP ${resp.status}`,
      },
      200,
      env
    );
  }

  if (!HTML_CONTENT_TYPE.test(contentType)) {
    resp.body?.cancel?.().catch(() => {});
    return sendJson(
      {
        ok: false,
        status: 415,
        finalUrl,
        contentType,
        error: `unsupported content-type "${contentType || "未知"}"：fetch_url 只能读取网页（text/html），不能下载文件或接口数据`,
      },
      415,
      env
    );
  }

  let html = "";
  let truncated = false;
  try {
    const { bytes, truncated: capped } = await readCappedText(resp, MAX_BYTES);
    truncated = capped;
    const charset = /charset=([\w-]+)/i.exec(contentType)?.[1] || "utf-8";
    try {
      html = new TextDecoder(charset).decode(bytes);
    } catch {
      html = new TextDecoder("utf-8").decode(bytes);
    }
  } catch (err) {
    return sendJson(
      { ok: false, status: 502, finalUrl, error: `读取响应体失败（网络中断）：${err?.message || err}` },
      502,
      env
    );
  }

  return sendJson(
    { ok: true, status: resp.status, finalUrl, contentType, html, truncated },
    200,
    env
  );
}
