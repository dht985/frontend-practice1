// 出网目标安全校验（SSRF 防护）——Node 端，供 Vite 开发服务器的抓取代理使用
//
// 规则本体在 shared/ssrfGuard.js（协议 / 端口 / 私网与元数据网段 / 本机域名），
// 线上抓取端点（server/fetch-worker.js）复用同一份规则；这里只补 Node 特有的部分：
// DNS 解析 + 解析出的每个地址逐个校验。
//
// 已知局限：DNS 校验与实际连接之间仍存在 DNS rebinding 的时间窗（解析后校验，非连接层钉 IP）。
// 本地开发代理可接受；线上 Worker 用 DNS-over-HTTPS 做同样的解析后校验，见其文件内说明。

import { lookup } from "node:dns/promises";
import { blockedReason, isIpLiteral, parseTargetUrl, unsafeError } from "./shared/ssrfGuard.js";

export {
  blockedReason,
  isBlockedIp,
  blockedHostnameReason,
  unsafeError,
} from "./shared/ssrfGuard.js";

export const MAX_REDIRECTS = 5;

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
  const { url, hostname } = parseTargetUrl(rawUrl);
  const addresses = isIpLiteral(hostname) ? [hostname] : await resolve(hostname);
  if (!addresses.length) throw unsafeError(`域名 ${hostname} 未解析到任何地址`);
  for (const address of addresses) {
    const reason = blockedReason(address);
    if (reason) {
      throw unsafeError(`目标地址被拦截：${hostname} → ${address}（${reason}）`);
    }
  }
  return { url: url.toString(), hostname, addresses };
}
