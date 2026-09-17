// 出网目标安全校验（SSRF 防护）
// fetch_url 的代理是拿开发机自己的网络身份去请求任意 URL 的：如果不校验目标，
// 同一局域网里的任何设备都能借它访问本机端口、内网服务和云厂商元数据接口。
//
// 校验内容：协议 + 端口 + 目标 IP（含 DNS 解析出的全部地址、重定向的每一跳）。
// 已知局限：这里在解析后校验，校验与实际连接之间仍存在 DNS rebinding 的时间窗；
// 对本地开发代理来说可接受，若要部署到公网，建议在连接层把目标 IP 钉死。

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const MAX_REDIRECTS = 5;

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const ALLOWED_PORTS = new Set([80, 443]);

// 云厂商元数据 / 特殊保留地址（多数已被下面的网段覆盖，单独列出便于阅读与测试）
const BLOCKED_EXACT_IPS = new Set([
  "169.254.169.254", // AWS / GCP / Azure IMDS
  "169.254.170.2", // AWS ECS 任务元数据
  "100.100.100.200", // 阿里云元数据
  "192.0.0.192", // Oracle Cloud 元数据
]);

// [网段起点, 前缀长度, 说明]
const BLOCKED_IPV4 = [
  ["0.0.0.0", 8, "本网络（0.0.0.0/8）"],
  ["10.0.0.0", 8, "私网（10.0.0.0/8）"],
  ["100.64.0.0", 10, "运营商级 NAT（100.64.0.0/10）"],
  ["127.0.0.0", 8, "本机环回（127.0.0.0/8）"],
  ["169.254.0.0", 16, "链路本地 / 云元数据（169.254.0.0/16）"],
  ["172.16.0.0", 12, "私网（172.16.0.0/12）"],
  ["192.0.0.0", 24, "IETF 保留（192.0.0.0/24）"],
  ["192.0.2.0", 24, "保留文档地址（192.0.2.0/24）"],
  ["192.168.0.0", 16, "私网（192.168.0.0/16）"],
  ["198.18.0.0", 15, "基准测试保留（198.18.0.0/15）"],
  ["198.51.100.0", 24, "保留文档地址（198.51.100.0/24）"],
  ["203.0.113.0", 24, "保留文档地址（203.0.113.0/24）"],
  ["224.0.0.0", 4, "组播（224.0.0.0/4）"],
  ["240.0.0.0", 4, "保留（240.0.0.0/4）"],
];

// [前缀起点, 前缀长度, 说明]
const BLOCKED_IPV6 = [
  ["::", 128, "未指定地址（::）"],
  ["::1", 128, "本机环回（::1）"],
  ["::ffff:0:0", 96, "IPv4 映射地址"],
  ["64:ff9b::", 96, "NAT64（64:ff9b::/96）"],
  ["100::", 64, "丢弃前缀（100::/64）"],
  ["2001:db8::", 32, "保留文档地址（2001:db8::/32）"],
  ["2002::", 16, "6to4（2002::/16）"],
  ["fc00::", 7, "唯一本地地址（fc00::/7）"],
  ["fe80::", 10, "链路本地（fe80::/10）"],
  ["ff00::", 8, "组播（ff00::/8）"],
];

// 目标不安全（含解析失败）时抛出的错误；httpStatus 供代理层直接回给前端
function unsafe(message, httpStatus = 403) {
  const err = new Error(message);
  err.name = "UnsafeTargetError";
  err.code = "unsafe_target";
  err.httpStatus = httpStatus;
  return err;
}

// "a.b.c.d" → 32 位无符号整数；非法返回 null
function ipv4ToInt(ip) {
  const parts = String(ip).split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = (value * 256 + n) >>> 0;
  }
  return value;
}

function inIpv4Range(ip, base, bits) {
  const value = ipv4ToInt(ip);
  const start = ipv4ToInt(base);
  if (value === null || start === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (start & mask);
}

// IPv6 → 8 个 16 位分组；支持 ::、内嵌 IPv4、%scope；非法返回 null
function ipv6ToGroups(ip) {
  let text = String(ip).trim();
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  const ipv4Match = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (ipv4Match) {
    const embedded = ipv4ToInt(ipv4Match[1]);
    if (embedded === null) return null;
    text =
      text.slice(0, ipv4Match.index) +
      `${(embedded >>> 16).toString(16)}:${(embedded & 0xffff).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part) => (part ? part.split(":").filter((x) => x !== "") : []);
  const head = toGroups(halves[0]);
  const tail = halves.length === 2 ? toGroups(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  if (halves.length === 1 && missing !== 0) return null;
  const groups = [...head, ...new Array(missing).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  const out = groups.map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN));
  return out.some((n) => !Number.isInteger(n)) ? null : out;
}

function ipv6InPrefix(groups, prefixGroups, bits) {
  if (!groups || !prefixGroups) return false;
  let remaining = bits;
  for (let i = 0; i < 8 && remaining > 0; i++) {
    const take = Math.min(16, remaining);
    const mask = take === 16 ? 0xffff : (0xffff << (16 - take)) & 0xffff;
    if ((groups[i] & mask) !== (prefixGroups[i] & mask)) return false;
    remaining -= take;
  }
  return true;
}

// 命中拦截规则返回原因文本；可安全访问返回 null；无法识别（fail closed）返回原因
export function blockedReason(ip) {
  const value = String(ip || "").trim();
  if (!value) return "地址为空";
  if (BLOCKED_EXACT_IPS.has(value.toLowerCase())) return "云厂商元数据地址";
  if (ipv4ToInt(value) !== null) {
    for (const [base, bits, reason] of BLOCKED_IPV4) {
      if (inIpv4Range(value, base, bits)) return reason;
    }
    return null;
  }
  const groups = ipv6ToGroups(value);
  if (groups) {
    for (const [base, bits, reason] of BLOCKED_IPV6) {
      if (ipv6InPrefix(groups, ipv6ToGroups(base), bits)) return reason;
    }
    return null;
  }
  return "无法识别的 IP 地址";
}

export function isBlockedIp(ip) {
  return blockedReason(ip) !== null;
}

// 默认解析器：返回域名对应的全部地址（任一地址被拦截即拒绝）
async function defaultResolve(hostname) {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
}

/**
 * 校验一个出网目标是否可以安全访问
 * @param {string} rawUrl 待抓取的完整 URL
 * @param {{resolve?: (hostname: string) => Promise<string[]>}} [options] 注入解析器（便于测试）
 * @returns {Promise<{url: string, hostname: string, addresses: string[]}>}
 * @throws {Error & {code: "unsafe_target"}} 目标不安全时抛出
 */
export async function assertSafeTarget(rawUrl, { resolve = defaultResolve } = {}) {
  let url;
  try {
    url = new URL(String(rawUrl || ""));
  } catch {
    throw unsafe("请求参数无法解析");
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw unsafe(`仅允许抓取 http/https 协议，收到 ${url.protocol || "未知协议"}`);
  }
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!ALLOWED_PORTS.has(port)) {
    throw unsafe(`出于安全考虑，仅允许访问 80/443 端口，收到 ${port}`);
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, ""); // IPv6 字面量带方括号
  if (!hostname) throw unsafe("缺少主机名");

  const addresses = isIP(hostname) ? [hostname] : await resolve(hostname);
  if (!addresses.length) throw unsafe(`域名 ${hostname} 未解析到任何地址`);
  for (const address of addresses) {
    const reason = blockedReason(address);
    if (reason) {
      throw unsafe(`目标地址被拦截：${hostname} → ${address}（${reason}）`);
    }
  }
  return { url: url.toString(), hostname, addresses };
}
