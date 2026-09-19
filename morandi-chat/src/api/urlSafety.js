// 抓取 URL 安全校验：拦截 localhost / 私网 / 链路本地 / 云 metadata，降低 SSRF 风险。
// 纯函数（无 DOM / Node 专属 API），供浏览器端 fetcher 在发请求前做第一道快速校验（纵深防御）。
// Node 端 fetch-proxy 另用 urlGuard.js 做 DNS 解析强校验（防 DNS rebinding），二者互补，见 README「安全说明」。

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.",
  "metadata.google.internal",
  "metadata.google.internal.",
]);

/** @param {string} hostname */
export function isBlockedHostname(hostname) {
  const host = String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, ""); // 去掉尾点

  if (!host) return true;
  if (BLOCKED_HOSTNAMES.has(host) || BLOCKED_HOSTNAMES.has(`${host}.`)) return true;
  if (host.endsWith(".localhost") || host.endsWith(".local")) return true;

  // IPv6：去括号后判断
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (bare.includes(":")) return isBlockedIPv6(bare);

  // IPv4 或看起来像 IPv4
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bare)) return isBlockedIPv4(bare);

  return false;
}

/** @param {string} ip */
function isBlockedIPv4(ip) {
  const parts = ip.split(".").map((x) => Number(x));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // 非法 IPv4 一律拒绝
  }
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + AWS/GCP metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a >= 224) return true; // multicast / reserved
  return false;
}

/** @param {string} ip */
function isBlockedIPv6(ip) {
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
  // IPv4-mapped ::ffff:x.x.x.x
  const mapped = lower.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return isBlockedIPv4(mapped[1]);
  // 简化：其它带冒号的字面量若不是公网形态也偏保守拦截 unique-local 已覆盖
  return false;
}

/**
 * 校验抓取目标是否允许。通过则返回规范化 URL 字符串，否则抛错。
 * @param {string} urlString
 * @returns {string}
 */
export function assertSafeFetchUrl(urlString) {
  const raw = String(urlString || "").trim();
  if (!raw) throw new Error("参数不合法：url 不能为空");

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("参数不合法：url 无法解析，请传入完整网址");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("参数不合法：仅支持 http/https 协议");
  }

  if (isBlockedHostname(parsed.hostname)) {
    throw new Error(
      "出于安全考虑，禁止抓取本机、局域网或云元数据地址（localhost / 私网 IP / link-local 等）"
    );
  }

  return parsed.href;
}
