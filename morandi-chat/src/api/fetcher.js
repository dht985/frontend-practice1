// fetch_url 工具的前端实现：传输层（fetchPageEnvelope）与正文提取（extractReadable）解耦。
// 开发环境传输层走 Vite 插件端点 /__fetch__（见 fetch-proxy.js）规避浏览器跨域；
// 迁移正式后端时，只需把 VITE_FETCH_ENDPOINT 指向提供同样 JSON 信封的后端地址。

import { Readability } from "@mozilla/readability";
import { assertSafeFetchUrl } from "./urlSafety";

const FETCH_ENDPOINT = import.meta.env.VITE_FETCH_ENDPOINT || "/__fetch__";
// 线上部署必须显式配置抓取端点：dev server 的代理只在本地开发时存在，
// 生产构建里没有它，硬编码的 /__fetch__ 只会 404（见 README「线上抓取端点」）。
const FETCH_ENDPOINT_CONFIGURED =
  Boolean(import.meta.env.VITE_FETCH_ENDPOINT) || Boolean(import.meta.env.DEV);
// 可选令牌：与 Worker 的 FETCH_TOKEN 对应。前端包里可见，只是提高盗用门槛。
const FETCH_TOKEN = import.meta.env.VITE_FETCH_TOKEN || "";
const MAX_CONTENT_CHARS = 20_000; // 回传给模型的正文上限（约 6~8k tokens），超出截断

const JUNK_TAGS = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
  "form",
  "button",
  "input",
  "select",
];
const BLOCK_TAGS = [
  "p",
  "div",
  "li",
  "ul",
  "ol",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "tr",
  "br",
  "section",
  "article",
  "header",
  "footer",
  "blockquote",
  "pre",
  "td",
  "th",
  "dt",
  "dd",
  "figcaption",
  "figure",
  "hr",
];

// 仅校验 + 请求抓取端点，返回信封：{ ok, status, finalUrl, contentType, html, truncated, error }
async function fetchPageEnvelope(url, signal) {
  if (!FETCH_ENDPOINT_CONFIGURED) {
    throw new Error(
      "抓取端点未配置：线上部署需要把 VITE_FETCH_ENDPOINT 指向抓取服务（见 README「线上抓取端点」）；本地开发用 npm run dev 自带的代理即可"
    );
  }
  const resp = await fetch(`${FETCH_ENDPOINT}?url=${encodeURIComponent(url)}`, {
    method: "GET",
    headers: {
      accept: "application/json",
      ...(FETCH_TOKEN ? { "x-fetch-token": FETCH_TOKEN } : {}),
    },
    signal,
  });
  if (!resp.ok) {
    let detail = "";
    let isJsonError = true;
    try {
      detail = (await resp.json())?.error || "";
    } catch {
      isJsonError = false;
    }
    if (resp.status === 404 && !isJsonError) {
      throw new Error(
        "抓取端点不存在 (404)：请确认 VITE_FETCH_ENDPOINT 指向已部署的抓取服务（见 README「线上抓取端点」）"
      );
    }
    // 消息保留状态码，上层 isRetryableError 可据此分类（502/504 可重试，415 不可重试）
    throw new Error(`抓取失败 (${resp.status})${detail ? `：${detail}` : ""}`);
  }
  const data = await resp.json();
  if (!data || !data.ok) {
    throw new Error(`目标网页返回错误 (${data?.status ?? "?"})${data?.error ? `：${data.error}` : ""}`);
  }
  return data;
}

// 把元素内的 HTML 转成干净纯文本：先删噪声标签，块级元素换行，再压缩空白/去重相邻重复行
function elementToText(el) {
  const node = el.cloneNode(true);
  node.querySelectorAll(JUNK_TAGS.join(",")).forEach((n) => n.remove());
  node.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
  node.querySelectorAll(BLOCK_TAGS.join(",")).forEach((n) => n.append("\n"));
  const raw = (node.textContent || "").replace(/ /g, " ");
  const lines = raw
    .split("\n")
    .map((l) => l.replace(/[\t\f\v ]+/g, " ").trim())
    .filter(Boolean);
  const out = [];
  for (const line of lines) {
    if (out[out.length - 1] !== line) out.push(line); // 相邻重复行多为导航/页脚噪声
  }
  return out.join("\n");
}

// 从 HTML 提取标题与正文：优先 article / main / [role=main]，内容过短再退回 body（同时剔除导航页脚等）
// 以上均不够 200 字时，用 Mozilla Readability 算法兜底（Firefox Reader View 同款）
export function extractReadable(html) {
  const doc = new DOMParser().parseFromString(html || "", "text/html");
  let title = String(
    doc.querySelector('meta[property="og:title"]')?.content ||
      doc.querySelector("title")?.textContent ||
      doc.querySelector("h1")?.textContent ||
      ""
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);

  const candidates = [
    doc.querySelector("article"),
    doc.querySelector("main"),
    doc.querySelector('[role="main"]'),
  ].filter(Boolean);

  let text = "";
  let best = "";
  for (const c of candidates) {
    const t = elementToText(c);
    if (t.length > best.length) best = t;
  }
  if (best.length >= 200) text = best;

  if (!text && doc.body) {
    const body = doc.body.cloneNode(true);
    body.querySelectorAll("nav,header,footer,aside,[aria-hidden='true']").forEach((n) => n.remove());
    text = elementToText(body);
  }

  // Readability 兜底：当前提取不足 200 字时，用 Readability 算法重新提取
  if (text.length < 200) {
    try {
      const reader = new Readability(doc.cloneNode(true));
      const article = reader.parse();
      if (article?.textContent?.trim()) {
        const raText = article.textContent.trim();
        if (raText.length > text.length) {
          text = raText;
          if (!title && article.title) {
            title = article.title.slice(0, 300);
          }
        }
      }
    } catch {
      // Readability 失败时保持原有结果
    }
  }

  if (!text) text = "（未提取到有效正文，该页面可能依赖 JavaScript 动态渲染）";
  return { title, text };
}

// 在长度上限处按边界截断，避免把句子/单词切成半截：
// 优先在 [75%max, max] 区间找最后一个换行（段落），其次找句末标点，都没有才硬切
export function truncateAtBoundary(text, max) {
  if (text.length <= max) return { text, truncated: false };
  const head = text.slice(0, max);
  const minCut = Math.floor(max * 0.75);
  let cut = head.lastIndexOf("\n");
  if (cut < minCut) {
    // 中英文句末标点（英文要求 ". " 两个字符，减少误伤小数点/缩写）
    const marks = ["。", "！", "？", "!\u0020", "?\u0020", ".\u0020", "；", "; "];
    for (const mk of marks) {
      const at = head.lastIndexOf(mk);
      if (at + mk.length > cut) cut = at + mk.length; // 切点包含标点本身
    }
  }
  if (cut < minCut) cut = max;
  return { text: head.slice(0, cut).trimEnd(), truncated: true };
}

// fetch_url 入口：校验 URL（含私网/环回/云元数据拦截）→ 抓取 → 提取 → 截断，返回 { title, url, content, truncated }
export async function fetchUrl(rawUrl, signal) {
  const url = assertSafeFetchUrl(rawUrl);

  const env = await fetchPageEnvelope(url, signal);
  const { title, text } = extractReadable(env.html);
  // 正文超限：优先在段落/句子边界截断；代理层按字节截断也算 truncated
  const cut = truncateAtBoundary(text, MAX_CONTENT_CHARS);
  return {
    title,
    url: env.finalUrl || url,
    content: cut.text,
    truncated: cut.truncated || !!env.truncated,
  };
}
