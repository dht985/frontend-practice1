// fetch_url 工具的前端实现：传输层（fetchPageEnvelope）与正文提取（extractReadable）解耦。
// 开发环境传输层走 Vite 插件端点 /__fetch__（见 fetch-proxy.js）规避浏览器跨域；
// 迁移正式后端时，只需把 VITE_FETCH_ENDPOINT 指向提供同样 JSON 信封的后端地址。

const FETCH_ENDPOINT = import.meta.env.VITE_FETCH_ENDPOINT || "/__fetch__";
const MAX_CONTENT_CHARS = 20_000; // 回传给模型的正文上限（约 6~8k tokens），超出截断
const HTTP_URL_RE = /^https?:\/\//i;

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
  const resp = await fetch(`${FETCH_ENDPOINT}?url=${encodeURIComponent(url)}`, {
    method: "GET",
    headers: { accept: "application/json" },
    signal,
  });
  if (!resp.ok) {
    let detail = "";
    try {
      detail = (await resp.json())?.error || "";
    } catch {
      // 非 JSON 错误响应
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
export function extractReadable(html) {
  const doc = new DOMParser().parseFromString(html || "", "text/html");
  const title = String(
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
  if (!text) text = "（未提取到有效正文，该页面可能依赖 JavaScript 动态渲染）";
  return { title, text };
}

// fetch_url 入口：校验 URL → 抓取 → 提取 → 截断，返回 { title, url, content, truncated }
export async function fetchUrl(rawUrl, signal) {
  const url = String(rawUrl || "").trim();
  if (!url) throw new Error("参数不合法：url 不能为空");
  if (!HTTP_URL_RE.test(url)) {
    throw new Error("参数不合法：仅支持 http:// 或 https:// 开头的网页地址");
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("参数不合法：url 无法解析，请传入完整网址");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("参数不合法：仅支持 http/https 协议");
  }

  const env = await fetchPageEnvelope(url, signal);
  const { title, text } = extractReadable(env.html);
  let content = text;
  let truncated = !!env.truncated;
  if (content.length > MAX_CONTENT_CHARS) {
    content = content.slice(0, MAX_CONTENT_CHARS);
    truncated = true;
  }
  return {
    title,
    url: env.finalUrl || url,
    content,
    truncated,
  };
}
