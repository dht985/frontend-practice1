// 对话树 → 发给模型的消息（纯函数，便于测试）
//
// 关键点：树里只存附件元信息，真正的附件内容（多模态 parts / 文档抽取文本）
// 存在 attachmentStore，这里按节点 id 取回来重新拼进请求，
// 这样"重试 / 换一个回答 / 之后每一轮"都能带上原始附件。

// 历史上这些 AI 回复是因为工具不可用才道歉的，联网开启时应剔除，避免误导模型
const SEARCH_FAIL_PATTERNS =
  /(无法联网|无法搜索|搜索失败|工具不可用|暂时无法|无法访问互联网|没有联网|不支持联网)/;

export const DEFAULT_ATTACHMENT_PROMPT = "请分析我上传的文件";

// 单个 user 节点的请求内容：有图片/视频时是多模态数组，否则是文本
export function userContentWithAttachments(nodeContent, payload) {
  const fallback = String(nodeContent ?? "");
  if (!payload) return fallback;
  const text = fallback.trim() || payload.askText || DEFAULT_ATTACHMENT_PROMPT;
  if (Array.isArray(payload.parts) && payload.parts.length) {
    return [...payload.parts, { type: "text", text }];
  }
  return text;
}

// 文档抽取出来的文本是以 system 消息形式注入的，恢复时要一并带上
export function attachmentSystemMessages(nodes, attachmentMap) {
  const out = [];
  for (const node of nodes || []) {
    if (!node || node.role !== "user") continue;
    const payload = attachmentMap?.get?.(node.id);
    if (Array.isArray(payload?.systemMessages) && payload.systemMessages.length) {
      out.push(...payload.systemMessages);
    }
  }
  return out;
}

// 无法处理的文件（音频等）：提示模型在回答开头告知用户
export function skippedFileMessages(skipped) {
  if (!Array.isArray(skipped) || !skipped.length) return [];
  return [
    {
      role: "system",
      content: `以下文件无法处理，请在回答开头简要告知用户：${skipped
        .map((s) => `《${s.name}》（${s.reason}）`)
        .join("、")}`,
    },
  ];
}

/**
 * 把对话树节点转成发给模型的历史消息
 * @param {Array} nodes 可见路径上的节点
 * @param {Map<string, object>} attachmentMap 节点 id → 附件载荷
 * @param {{webSearch?: boolean}} [options]
 */
export function buildHistoryMessages(nodes, attachmentMap, { webSearch = false } = {}) {
  return (nodes || [])
    .filter((m) => {
      if (!m) return false;
      if (m.role !== "user" && !(m.role === "assistant" && m.content)) return false;
      if (String(m.content).startsWith("⚠️")) return false;
      // 联网开启时，剔除历史上"无法搜索"的 AI 回复
      if (webSearch && m.role === "assistant" && SEARCH_FAIL_PATTERNS.test(String(m.content))) {
        return false;
      }
      return true;
    })
    .map((m) => {
      if (m.role !== "user") return { role: m.role, content: m.content };
      const payload = attachmentMap?.get?.(m.id);
      return { role: "user", content: userContentWithAttachments(m.content, payload) };
    });
}
