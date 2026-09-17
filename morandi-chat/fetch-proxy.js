// Vite 开发服务器插件：为内置工具 fetch_url 提供同源抓取端点 GET /__fetch__?url=<encodeURIComponent(url)>
// 浏览器直接 fetch 跨域页面会被 CORS 拦截，因此由开发服务器在 Node 侧发起请求。
// 与前端工具调用完全解耦：正式环境只需让后端提供同样的接口约定（返回同样的 JSON 信封），
// 前端把 VITE_FETCH_ENDPOINT 指过去即可，无需改动抓取与解析逻辑。
//
// 安全/稳定性约束：
//   - 仅允许 http/https，且只放行 80/443 端口（前端还会再校验一次）
//   - 拦截本机环回、私网、链路本地与云厂商元数据地址（见 urlGuard.js）：
//     DNS 解析出的每个地址都要校验，重定向逐跳校验，避免被当成内网跳板
//   - 15 秒超时；仅放行网页类 Content-Type；响应体最多读取 2MB（超出截断）
//   - 不转发用户 Cookie，只能抓取公开页面

import { assertSafeTarget, MAX_REDIRECTS } from "./urlGuard.js";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const HTML_CONTENT_TYPE = /text\/html|application\/xhtml\+xml|text\/plain|text\/xml|application\/xml/i;

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(obj));
}

export default function fetchProxyPlugin() {
  return {
    name: "morandi-dev-fetch-proxy",
    apply: "serve", // 仅开发服务器生效，构建产物不含此逻辑
    configureServer(server) {
      server.middlewares.use("/__fetch__", async (req, res) => {
        if (req.method !== "GET" && req.method !== "HEAD") {
          return sendJson(res, 405, { ok: false, error: "仅支持 GET 请求" });
        }
        let target = "";
        try {
          const u = new URL(req.url, "http://localhost");
          target = u.searchParams.get("url") || "";
        } catch {
          return sendJson(res, 400, { ok: false, error: "请求参数无法解析" });
        }
        if (!/^https?:\/\//i.test(target)) {
          return sendJson(res, 400, { ok: false, error: "仅允许抓取 http/https 协议的 URL" });
        }

        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
        let resp;
        let redirects = 0;
        let currentUrl = target;
        try {
          // 手动跟随重定向：每一跳都重新做安全检查（公网地址 302 到内网是常见绕过手法）
          for (;;) {
            await assertSafeTarget(currentUrl);
            resp = await fetch(currentUrl, {
              redirect: "manual",
              signal: ctrl.signal,
              headers: {
                accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
                "user-agent":
                  "Mozilla/5.0 (compatible; MorandiChatFetcher/1.0; +https://localhost) AppleWebKit/537.36",
              },
            });
            const location =
              resp.status >= 300 && resp.status < 400 ? resp.headers.get("location") : null;
            if (!location) break;
            resp.body?.cancel?.().catch(() => {});
            if (redirects >= MAX_REDIRECTS) {
              throw new Error(`重定向次数超过上限（${MAX_REDIRECTS} 次）`);
            }
            redirects += 1;
            currentUrl = new URL(location, currentUrl).toString();
          }
        } catch (err) {
          clearTimeout(timer);
          if (err?.code === "unsafe_target") {
            return sendJson(res, err.httpStatus || 403, { ok: false, error: err.message });
          }
          const timedOut = err?.name === "AbortError";
          return sendJson(res, timedOut ? 504 : 502, {
            ok: false,
            error: timedOut
              ? `抓取超时（超过 ${FETCH_TIMEOUT_MS / 1000} 秒），该站点可能不可达或响应过慢`
              : `网络错误，无法连接目标网站：${err?.message || err}`,
          });
        }
        clearTimeout(timer);

        const finalUrl = resp.url || currentUrl;
        const contentType = resp.headers.get("content-type") || "";

        // 目标站点返回 4xx/5xx：不下载正文，把状态码带回前端（前端据此决定是否可重试）
        if (!resp.ok) {
          resp.body?.cancel?.().catch(() => {});
          return sendJson(res, 200, {
            ok: false,
            status: resp.status,
            finalUrl,
            contentType,
            error: `目标网站返回 HTTP ${resp.status}`,
          });
        }

        // Content-Type 检查：只抓网页，拒绝 PDF/图片/压缩包/JSON API 等
        if (!HTML_CONTENT_TYPE.test(contentType)) {
          resp.body?.cancel?.().catch(() => {});
          return sendJson(res, 415, {
            ok: false,
            status: 415,
            finalUrl,
            contentType,
            error: `unsupported content-type "${contentType || "未知"}"：fetch_url 只能读取网页（text/html），不能下载文件或接口数据`,
          });
        }

        // 流式读取并在达到上限时停止（避免大页面把内存/带宽吃光）
        let html = "";
        let sizeTruncated = false;
        try {
          const reader = resp.body.getReader();
          const chunks = [];
          let total = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const remaining = MAX_HTML_BYTES - total;
            if (value.length >= remaining) {
              chunks.push(value.subarray(0, remaining));
              total = MAX_HTML_BYTES;
              sizeTruncated = true;
              reader.cancel().catch(() => {});
              break;
            }
            chunks.push(value);
            total += value.length;
          }
          const buf = Buffer.concat(chunks);
          // 优先遵循响应头 charset，非法回退 utf-8
          const charset = /charset=([\w-]+)/i.exec(contentType)?.[1] || "utf-8";
          try {
            html = new TextDecoder(charset).decode(buf);
          } catch {
            html = buf.toString("utf8");
          }
        } catch (err) {
          return sendJson(res, 502, {
            ok: false,
            status: 502,
            finalUrl,
            error: `读取响应体失败（网络中断）：${err?.message || err}`,
          });
        }

        return sendJson(res, 200, {
          ok: true,
          status: resp.status,
          finalUrl,
          contentType,
          html,
          truncated: sizeTruncated,
        });
      });
    },
  };
}
