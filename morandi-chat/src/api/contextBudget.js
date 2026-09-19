// 上下文预算：估算 token 用量，并在超出模型窗口前裁剪较早的对话轮次。
//
// 为什么需要它：历史 + 附件（base64 图片、文档抽取文本）会随对话持续增长，
// 一旦超过服务商窗口，接口直接返回 400，用户只看到一个报错气泡、不知道发生了什么。
// 这里在发请求前先估算、按「整轮」裁剪，并把裁剪情况回报给界面。
//
// 估算刻意保守（宁可早裁一点）：各服务商 tokenizer 不同，没有本地分词器时只能近似——
// 中文按 1 字 ≈ 1 token，其余按 4 字符 ≈ 1 token；图片/视频按常见分辨率取常数。

import { userContentWithAttachments } from "./history";

export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_RESERVED_OUTPUT = 8_000;
export const IMAGE_TOKENS = 1_100;
export const VIDEO_TOKENS = 3_000;

const OTHER_PART_TOKENS = 500;
const MESSAGE_OVERHEAD = 4; // 每条消息的角色与分隔开销

// 是否按「1 字 1 token」计的字符（CJK、假名、韩文、全角标点等）
function isWideChar(code) {
  return (
    (code >= 0x3000 && code <= 0x303f) ||
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef)
  );
}

export function estimateTextTokens(text) {
  const s = String(text ?? "");
  if (!s) return 0;
  let wide = 0;
  let total = 0;
  for (const ch of s) {
    total += 1;
    if (isWideChar(ch.codePointAt(0))) wide += 1;
  }
  const rest = Math.max(0, total - wide);
  return wide + Math.ceil(rest / 4);
}

// content 可能是字符串，也可能是 [{ type: "image_url" … }, { type: "text" … }]
export function estimateContentTokens(content) {
  if (typeof content === "string") return estimateTextTokens(content);
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (typeof part.text === "string") total += estimateTextTokens(part.text);
    else if (part.type === "image_url") total += IMAGE_TOKENS;
    else if (part.type === "video_url") total += VIDEO_TOKENS;
    else total += OTHER_PART_TOKENS;
  }
  return total;
}

export function estimateMessageTokens(message) {
  if (!message) return 0;
  return MESSAGE_OVERHEAD + estimateContentTokens(message.content);
}

export function estimateMessagesTokens(messages) {
  return (messages || []).reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

// 单节点估算：user 节点要按「实际发出去的内容」算（含多模态 parts 与文档 system 消息）
function estimateNodeTokens(node, attachmentMap) {
  if (!node) return 0;
  if (node.role !== "user") return MESSAGE_OVERHEAD + estimateContentTokens(node.content);
  const payload = attachmentMap?.get?.(node.id);
  let total =
    MESSAGE_OVERHEAD + estimateContentTokens(userContentWithAttachments(node.content, payload));
  for (const msg of payload?.systemMessages || []) total += estimateMessageTokens(msg);
  return total;
}

// 一轮 = 一条 user 消息 + 随后的 assistant/tool 消息（直到下一条 user）
export function splitIntoTurns(nodes) {
  const turns = [];
  for (const node of nodes || []) {
    if (!node) continue;
    if (node.role === "user" || !turns.length) turns.push([]);
    turns[turns.length - 1].push(node);
  }
  return turns;
}

export function estimateNodesTokens(nodes, attachmentMap) {
  return (nodes || []).reduce((sum, node) => sum + estimateNodeTokens(node, attachmentMap), 0);
}

// 没有设置最大输出长度时，给回答留的默认空间
export function reservedOutputTokens(maxTokens) {
  const n = Number(maxTokens);
  return n > 0 ? n : DEFAULT_RESERVED_OUTPUT;
}

/**
 * 从最近的轮次往前保留，直到放得下为止（整轮裁剪，不切断 user/assistant 配对）。
 * 最后一轮永远保留：哪怕它自己就超预算，也交给服务商判断，总比什么都不发更有用。
 *
 * @param {Array} nodes 可见路径上的节点（按时间顺序）
 * @param {Map<string, object>} attachmentMap 节点 id → 附件载荷
 * @param {{budgetTokens?: number, reservedTokens?: number, fixedTokens?: number}} [options]
 */
export function trimNodesToBudget(nodes, attachmentMap, options = {}) {
  const budgetTokens =
    Number(options.budgetTokens) > 0 ? Number(options.budgetTokens) : DEFAULT_CONTEXT_WINDOW;
  const reservedTokens = Math.max(0, Number(options.reservedTokens) || 0);
  const fixedTokens = Math.max(0, Number(options.fixedTokens) || 0);
  const allowedTokens = Math.max(0, budgetTokens - reservedTokens - fixedTokens);

  const turns = splitIntoTurns(nodes);
  if (!turns.length) {
    return {
      nodes: [],
      keptTurns: 0,
      droppedTurns: 0,
      estimatedTokens: 0,
      budgetTokens,
      allowedTokens,
    };
  }

  let firstKept = turns.length - 1;
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const tokens = turns[i].reduce((sum, node) => sum + estimateNodeTokens(node, attachmentMap), 0);
    const isLastTurn = i === turns.length - 1;
    if (!isLastTurn && used + tokens > allowedTokens) break;
    used += tokens;
    firstKept = i;
  }

  return {
    nodes: turns.slice(firstKept).flat(),
    keptTurns: turns.length - firstKept,
    droppedTurns: firstKept,
    estimatedTokens: used,
    budgetTokens,
    allowedTokens,
  };
}
