import { memo, useState, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { BlobDot } from "./Decor";
import { JsonPanel, CodeBlock } from "./RichContent";

const ATTACHMENT_ICON = {
  image: "🖼️",
  video: "🎬",
  doc: "📄",
  audio: "🎵",
  unknown: "📎",
};

// 来源链接来自联网搜索接口的返回结果，属于不可信外部输入：
// 只允许 http/https，拦截 javascript: 等危险协议，避免渲染成可点击的存储型 XSS
const SAFE_URL = /^https?:\/\//i;
const safeUrl = (u) => (typeof u === "string" && SAFE_URL.test(u) ? u : "");

// Agent 工具调用步骤：生成中实时显示进度，完成后折叠为「工具调用 · N 步」可展开详情
function StepIcon({ status }) {
  if (status === "running") {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
           strokeLinecap="round" className="w-3 h-3 mt-0.5 text-muted animate-spin flex-shrink-0">
        <path d="M21 12a9 9 0 1 1-6.2-8.56" />
      </svg>
    );
  }
  if (status === "awaiting") {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
           strokeLinecap="round" strokeLinejoin="round"
           className="w-3 h-3 mt-0.5 text-peachdeep flex-shrink-0 animate-pulse">
        <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
        <path d="M12 9v4" />
        <path d="M12 17h.01" />
      </svg>
    );
  }
  if (status === "error") {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
           strokeLinecap="round" className="w-3 h-3 mt-0.5 text-[#b08a86] flex-shrink-0">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v5" />
        <path d="M12 16h.01" />
      </svg>
    );
  }
  if (status === "retrying") {
    // 工具失败后等待模型自纠重试：桃色转圈
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
           strokeLinecap="round" className="w-3 h-3 mt-0.5 text-peachdeep animate-spin flex-shrink-0">
        <path d="M21 12a9 9 0 1 1-6.2-8.56" />
      </svg>
    );
  }
  if (status === "rejected") {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
           strokeLinecap="round" className="w-3 h-3 mt-0.5 text-muted/60 flex-shrink-0">
        <circle cx="12" cy="12" r="9" />
        <path d="m15 9-6 6" />
        <path d="m9 9 6 6" />
      </svg>
    );
  }
  if (status === "stopped") {
    // 用户主动停止：中性灰色实心方块（停止语义），区别于成功绿勾、拒绝灰 X、失败红感叹号
    return (
      <svg viewBox="0 0 24 24" fill="currentColor"
           className="w-3 h-3 mt-0.5 text-muted/55 flex-shrink-0">
        <rect x="6" y="6" width="12" height="12" rx="2.5" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"
         strokeLinecap="round" strokeLinejoin="round"
         className="w-3 h-3 mt-0.5 text-sagedeep flex-shrink-0">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

// 把工具返回的 JSON 字符串压成简短预览，供步骤行显示（全文仍可展开）
// 优先用完整结果解析，避免步骤里 120 字截断导致 JSON 不合法而回退成原串
function previewOf(result) {
  try {
    const obj = JSON.parse(result);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      const parts = [];
      if (obj.title) parts.push(String(obj.title).slice(0, 60));
      if (typeof obj.content === "string" && obj.content) parts.push(obj.content.slice(0, 80).replace(/\s+/g, " "));
      if (Array.isArray(obj.todos)) parts.push(`${obj.todos.length} 条待办`);
      if (obj.url) parts.push(String(obj.url).slice(0, 50));
      if (parts.length) return parts.join(" · ");
    }
  } catch {
    // 非 JSON 字符串直接当预览
  }
  return String(result);
}

// 工具结果展示：默认只显示一行预览；有全文时可点击「全文/收起」展开查看
// previewText 是步骤里存的 120 字截断文本（可能是被截断的 JSON）；
// full 是内存里的完整结果，优先用它生成结构化预览（title / content / todos 等）
function ResultDisplay({ previewText, full, color, expanded, onToggle }) {
  const source = typeof full === "string" ? full : previewText || "";
  let label = `→ ${previewText}`;
  try {
    const pretty = previewOf(source);
    const candidate = `→ ${pretty}`;
    if (candidate.length <= 160) label = candidate;
  } catch {
    // 预览生成失败时回退到步骤里的截断文本
  }
  const hasFull = typeof full === "string" && full.length > (previewText || "").length;
  const showFull = expanded && hasFull;
  const fullText = hasFull ? String(full) : "";
  return (
    <div className="pl-3.5">
      <div className={`font-mono ${color}`}>
        {showFull ? (
          <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed max-h-[60vh] overflow-y-auto bg-cream/50 rounded-md p-2 border border-line/50 mt-0.5">{fullText}</pre>
        ) : (
          <span className="block break-all">{label}</span>
        )}
      </div>
      {hasFull && (
        <button
          type="button"
          onClick={onToggle}
          className="mt-0.5 text-[10.5px] text-sagedeep hover:text-ink transition-colors inline-flex items-center gap-0.5"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
               strokeLinecap="round" strokeLinejoin="round"
               className={`w-2.5 h-2.5 transition-transform ${expanded ? "rotate-180" : ""}`}>
            <path d="m6 9 6 6 6-6" />
          </svg>
          {expanded ? "收起全文" : `查看全文（${full.length} 字）`}
        </button>
      )}
    </div>
  );
}

function ToolSteps({ steps, streaming, pendingConfirms = {}, onRespond, onRetryTool, fullResultsMap }) {
  const [open, setOpen] = useState(false);
  const [expandedIds, setExpandedIds] = useState({}); // 步骤 id → 是否已展开全文
  const hasAwaiting = steps.some((s) => s.status === "awaiting");
  const blockExpanded = streaming || open || hasAwaiting;
  const isStepExpanded = (id) => expandedIds[id];
  const toggleStep = (id) => setExpandedIds((m) => ({ ...m, [id]: !m[id] }));
  return (
    <div className="mb-1.5 not-prose rounded-xl border border-line/60 bg-white/40 overflow-hidden">
      <button
        type="button"
        disabled={streaming}
        onClick={() => setOpen((v) => !v)}
        className={`w-full flex items-center gap-1.5 px-2.5 py-1.5 text-xs
                   hover:text-ink disabled:cursor-default transition-colors
                   ${hasAwaiting ? "text-peachdeep" : "text-muted"}`}
      >
        <svg viewBox="0 0 24 24" fill="currentColor"
             className={`w-3 h-3 flex-shrink-0 ${hasAwaiting ? "text-peachdeep" : "text-sagedeep"}`}>
          <path d="M12 2.5c.35 0 .66.22.78.55l1.35 3.7c.68 1.87 2.1 3.29 3.97 3.97l3.7 1.35c.33.12.55.43.55.78s-.22.66-.55.78l-3.7 1.35c-1.87.68-3.29 2.1-3.97 3.97l-1.35 3.7a.84.84 0 0 1-1.56 0l-1.35-3.7c-.68-1.87-2.1-3.29-3.97-3.97l-3.7-1.35a.84.84 0 0 1 0-1.56l3.7-1.35c1.87-.68 3.29-2.1 3.97-3.97l1.35-3.7c.12-.33.43-.55.78-.55Z" />
        </svg>
        <span>工具调用 · {steps.length} 步</span>
        {hasAwaiting && <span className="text-peachdeep/90">· 等待确认</span>}
        {streaming && !hasAwaiting && <span className="animate-blink">…</span>}
        {!streaming && (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
               strokeLinecap="round" strokeLinejoin="round"
               className={`w-3 h-3 ml-auto transition-transform ${open ? "rotate-180" : ""}`}>
            <path d="m6 9 6 6 6-6" />
          </svg>
        )}
      </button>
      {blockExpanded && (
        <div className="px-2.5 pb-2 space-y-1">
          {steps.map((s, i) => {
            // 状态文案：执行中 / 自动重试中 / 调用成功 / 已停止 / 最终失败
            let statusText = null;
            if (s.status === "running") statusText = "执行中…";
            else if (s.status === "retrying")
              statusText = `自动重试中（重试 ${s.retry}/${s.maxRetry || s.retry}）`;
            else if (s.status === "awaiting") statusText = "等待你的确认…";
            else if (s.status === "rejected") statusText = "已拒绝，未执行";
            else if (s.status === "stopped") statusText = "已停止";
            else if (s.status === "done") statusText = "调用成功";
            else if (s.status === "error")
              statusText = s.retry > 0 ? `重试 ${s.retry} 次后仍失败` : "最终失败";
            return (
            <div key={s.id || i} className="flex items-start gap-1.5 text-[11px] leading-relaxed">
              <StepIcon status={s.status} />
              <div className="min-w-0 flex-1 break-all">
                <div>
                  <span className="text-ink font-medium">{s.name}</span>
                  {s.source === "web" && <span className="text-muted/70">（联网搜索）</span>}
                  {s.args && s.args !== "{}" && (
                    <span className="text-muted/70 font-mono ml-1">{s.args}</span>
                  )}
                  {statusText && (
                    <span
                      className={`ml-1 ${
                        s.status === "error"
                          ? "text-[#b08a86] font-medium"
                          : s.status === "retrying" || s.status === "awaiting"
                          ? "text-peachdeep/90"
                          : s.status === "done"
                          ? "text-sagedeep"
                          : "text-muted/70" // rejected / stopped：中性灰，不复用成功绿
                      }`}
                    >
                      {statusText}
                    </span>
                  )}
                </div>
                {/* 人工确认按钮 */}
                {s.status === "awaiting" && pendingConfirms[s.id] && (
                  <div className="flex items-center gap-1.5 mt-1">
                    <button
                      type="button"
                      onClick={() => onRespond?.(s.id, true)}
                      className="px-2 py-0.5 rounded-md bg-sage/60 border border-sagedeep/50
                                 text-[10.5px] text-ink hover:bg-sage transition-colors"
                    >
                      允许执行
                    </button>
                    <button
                      type="button"
                      onClick={() => onRespond?.(s.id, false)}
                      className="px-2 py-0.5 rounded-md bg-blush/40 border border-[#b08a86]/40
                                 text-[10.5px] text-ink/70 hover:bg-blush/70 transition-colors"
                    >
                      拒绝
                    </button>
                  </div>
                )}
                {/* 结果 / 失败原因（带全文展开） */}
                {s.status === "done" && s.result && (
                  <ResultDisplay
                    previewText={s.result}
                    full={fullResultsMap?.get(s.id)}
                    color="text-muted/70"
                    expanded={isStepExpanded(s.id)}
                    onToggle={() => toggleStep(s.id)}
                  />
                )}
                {s.status === "error" && s.result && (
                  <ResultDisplay
                    previewText={s.result}
                    full={fullResultsMap?.get(s.id)}
                    color="text-[#b08a86]"
                    expanded={isStepExpanded(s.id)}
                    onToggle={() => toggleStep(s.id)}
                  />
                )}
                {s.status === "rejected" && s.result && (
                  <span className="block text-muted/50 font-mono pl-3.5">→ {s.result}</span>
                )}
                {/* 手动重新尝试：失败后复用原工具与参数再跑一次 */}
                {s.status === "error" && s.canRetry && onRetryTool && (
                  <button
                    type="button"
                    onClick={() => onRetryTool(s.id)}
                    className="mt-1 ml-3.5 px-2 py-0.5 rounded-md border border-line
                               text-[10.5px] text-muted hover:text-ink hover:border-sagedeep/50
                               hover:bg-sage/30 transition-colors inline-flex items-center gap-1"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                         strokeLinecap="round" strokeLinejoin="round" className="w-2.5 h-2.5">
                      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
                      <path d="M3 3v5h5" />
                    </svg>
                    重新尝试
                  </button>
                )}
              </div>
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function MessageBubble({ message: rawMessage, index, streamingText = null, streamingReasoning = null, isLast = false, versionParentId, versionIndex = 0, versionCount = 1, onRetry, onRegenerate, onEdit, onSwitchVersion, pendingConfirms, onRespondToolConfirm, onRetryTool, fullResultsMap }) {
  // 流式期间用独立文本渲染，避免每个 token 深拷贝对话树后的重渲染开销
  const message = streamingText === null ? rawMessage : { ...rawMessage, content: streamingText };
  // 思考过程：流式期间用实时 streamingReasoning，完成后用写回树的 message.reasoning
  const reasoning = streamingReasoning != null ? streamingReasoning : (message.reasoning || "");
  const isUser = message.role === "user";
  const [copied, setCopied] = useState(false);
  const isError = !isUser && String(message.content).startsWith("⚠️");

  // 完成态 JSON 检测：内容是纯 JSON（对象/数组）时渲染为可折叠 JSON 树
  const jsonMsg = useMemo(() => {
    if (isUser || message.streaming || isError) return null;
    const t = String(message.content || "").trim();
    if (!/^[[{]/.test(t) || !/[\]}]$/.test(t)) return null;
    try {
      return JSON.parse(t);
    } catch {
      return null;
    }
  }, [isUser, message.streaming, isError, message.content]);

  // Markdown 解析开销大：只有内容变化时才重新解析（流式期间按节流后的文本更新）
  // 安全红线：react-markdown 默认不渲染原始 HTML，模型输出不会被当 HTML 注入。
  // 切勿引入 rehype-raw 或把模型输出塞进 dangerouslySetInnerHTML —— 那样配合
  // 自定义工具（new Function 本地执行）与 localStorage 明文 Key，一次 XSS 即全盘泄露。
  const markdown = useMemo(
    () => (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || "");
            return match ? (
              <CodeBlock language={match[1]}>{children}</CodeBlock>
            ) : (
              <code className={className} {...props}>{children}</code>
            );
          },
        }}
      >
        {String(message.content)}
      </ReactMarkdown>
    ),
    [message.content]
  );

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message.content || "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 忽略
    }
  };

  return (
    <div className={`group flex w-full gap-3 animate-fade-up ${isUser ? "flex-row-reverse" : "flex-row"}`}>
      {/* 头像：用户为蜜桃圆点，AI 为浅紫色块 */}
      {isUser ? (
        <div className="w-8 h-8 rounded-full bg-peach flex items-center justify-center flex-shrink-0 shadow-soft">
          <span className="text-xs font-semibold text-ink">我</span>
        </div>
      ) : (
        <div className="w-8 h-8 flex-shrink-0 flex items-center justify-center shadow-soft">
          <BlobDot className="w-8 h-8 bg-lilac border-2 border-white/70 relative">
            <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-2.5 h-2.5 bg-white/80" style={{ borderRadius: "55% 45% 50% 50% / 50% 55% 45% 50%" }} />
          </BlobDot>
        </div>
      )}

      {/* 气泡 + 气泡外的操作行（纵向排列，跟随用户/AI 对齐方向） */}
      <div className={`flex flex-col max-w-[76%] min-w-0 ${isUser ? "items-end" : "items-start"}`}>
        <div
          className={`w-full px-4 py-3 border shadow-soft
            ${isUser
              ? "bg-blush border-white/60 rounded-2xl rounded-tr-md"
              : isError
              ? "bg-peachsoft/70 border-peach/40 rounded-2xl rounded-tl-md"
              : "bg-lilac/80 border-white/60 rounded-2xl rounded-tl-md"}`}
        >
        <div className="prose-md text-ink break-words">
          {/* 用户消息附带的文件（仅展示元信息） */}
          {isUser && message.attachments?.length > 0 && (
            <div className={`flex flex-wrap gap-1.5 not-prose ${message.content ? "mb-2" : ""}`}>
              {message.attachments.map((a, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1.5 max-w-full pl-1.5 pr-2.5 py-1 rounded-lg
                             bg-white/55 border border-white/70 text-[11px] text-ink"
                >
                  <span>{ATTACHMENT_ICON[a.kind] || "📎"}</span>
                  <span className="truncate">{a.name}</span>
                  {a.size && <span className="text-muted flex-shrink-0">{a.size}</span>}
                </span>
              ))}
            </div>
          )}

          {/* 文件读取 / 上传 / 解析进度 */}
          {!isUser && message.streaming && message.hint && !message.content && !message.searching && (
            <span className="inline-flex items-center gap-1.5 text-muted text-sm not-prose">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
                   strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <path d="M7 10l5 5 5-5" />
                <path d="M12 15V3" />
              </svg>
              {message.hint}
              <span className="animate-blink">…</span>
            </span>
          )}

          {message.toolSteps?.length > 0 ? (
            <ToolSteps
              steps={message.toolSteps}
              streaming={message.streaming}
              pendingConfirms={pendingConfirms}
              onRespond={onRespondToolConfirm}
              onRetryTool={onRetryTool}
              fullResultsMap={fullResultsMap}
            />
          ) : message.searching ? (
            <div className="flex items-center gap-1.5 text-xs text-muted mb-1.5 not-prose">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
                   strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                <circle cx="12" cy="12" r="9" />
                <path d="M3 12h18" />
                <path d="M12 3c2.6 2.5 3.9 5.6 3.9 9S14.6 18.5 12 21c-2.6-2.5-3.9-5.6-3.9-9S9.4 5.5 12 3Z" />
              </svg>
              <span>{message.toolName ? `正在调用工具「${message.toolName}」` : "正在联网搜索"}</span>
              <span className="animate-blink">…</span>
            </div>
          ) : null}
          {/* 思考过程（Kimi K3 / reasoner）：流式实时展示，可折叠 */}
          {!isUser && reasoning && (
            <details className="mb-2 not-prose rounded-xl border border-line/60 bg-lilacsoft/40 overflow-hidden">
              <summary className="cursor-pointer px-3 py-2 text-xs text-muted flex items-center gap-1.5 select-none">
                {message.streaming ? "思考中…" : "思考过程"}
              </summary>
              <div className="px-3 pb-2.5 text-xs text-muted/80 leading-relaxed whitespace-pre-wrap max-h-64 overflow-y-auto border-t border-line/50 pt-2">
                {reasoning}
              </div>
            </details>
          )}
          {jsonMsg !== null ? (
            <JsonPanel data={jsonMsg} raw={String(message.content).trim()} />
          ) : message.content ? (
            markdown
          ) : message.streaming && !message.searching && !message.hint && !message.toolSteps?.length ? (
            <span className="inline-flex items-center gap-1 text-muted text-sm">
              正在思考
              <span className="flex gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-muted animate-blink" />
              </span>
            </span>
          ) : null}
          {message.streaming && message.content && (
            <span className="inline-block w-[2px] h-4 bg-muted/70 align-[-2px] ml-0.5 animate-blink" />
          )}

          {/* 联网搜索参考来源 */}
          {!isUser && message.sources?.length > 0 && !message.streaming && (
            <div className="mt-3 pt-2.5 border-t border-white/40 not-prose">
              <p className="text-[11px] font-medium text-muted mb-1.5 flex items-center gap-1">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
                     strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3">
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                </svg>
                参考来源
              </p>
              <div className="space-y-1">
                {message.sources.map((s, i) => {
                  const href = safeUrl(s.url);
                  return href ? (
                    <a
                      key={i}
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block text-[11px] text-sagedeep hover:text-peachdeep transition-colors truncate"
                    >
                      {i + 1}. {s.title || s.url}
                    </a>
                  ) : (
                    <span
                      key={i}
                      className="block text-[11px] text-muted/70 truncate"
                      title="已拦截非 http/https 链接"
                    >
                      {i + 1}. {s.title || s.url}
                    </span>
                  );
                })}
              </div>
            </div>
          )}
        </div>
        </div>

        {/* 版本切换 < y/x >：消息存在多版本时显示（用户消息多版本=修改分支；AI 消息多版本=换回答） */}
        {versionCount > 1 && onSwitchVersion && (
          <div className="flex items-center gap-0.5 mt-1.5 not-prose text-[11px] text-ink/80">
            <button
              onClick={() => onSwitchVersion(versionParentId, -1)}
              disabled={versionIndex <= 0}
              title="上一版"
              className="w-5 h-5 flex items-center justify-center rounded hover:bg-white/70
                         hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
            >
              &lt;
            </button>
            <span className="tabular-nums px-0.5">
              {versionIndex + 1}/{versionCount}
            </span>
            <button
              onClick={() => onSwitchVersion(versionParentId, 1)}
              disabled={versionIndex >= versionCount - 1}
              title="下一版"
              className="w-5 h-5 flex items-center justify-center rounded hover:bg-white/70
                         hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
            >
              &gt;
            </button>
          </div>
        )}

        {/* 气泡外部操作行：复制（用户/AI 通用）+ 重试（仅错误消息常显）+ 换一个回答（仅最后一条 AI） */}
        {message.content && !message.streaming && (
          <div className="flex items-center gap-1.5 mt-1.5 not-prose">
            {isError && onRetry && (
              <button
                onClick={onRetry}
                className="inline-flex items-center gap-1 text-[11px] text-peachdeep hover:text-ink
                           px-2 py-0.5 rounded-md hover:bg-white/60 transition-colors"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
                     strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3">
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
                重试
              </button>
            )}
            {!isUser && !isError && isLast && onRegenerate && (
              <button
                onClick={onRegenerate}
                title="重新生成回答，旧回答保留为上一版"
                className="inline-flex items-center gap-1 text-[11px] text-ink/80 hover:text-ink
                           px-2 py-0.5 rounded-md hover:bg-white/70 transition-colors"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
                     strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3">
                  <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                  <path d="M21 3v6h-6" />
                </svg>
                换一个回答
              </button>
            )}
            <button
              onClick={handleCopy}
              className="inline-flex items-center gap-1 text-[11px] text-ink/80 hover:text-ink
                         px-2 py-0.5 rounded-md hover:bg-white/70 transition-colors"
            >
              {copied ? (
                <>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                       strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3">
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                  已复制
                </>
              ) : (
                <>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
                       strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                  复制
                </>
              )}
            </button>
            {isUser && onEdit && (
              <button
                onClick={() => onEdit(index)}
                title="修改后生成新版本，原对话保留，可用 < y/x > 切换"
                className="inline-flex items-center gap-1 text-[11px] text-ink/80 hover:text-ink
                           px-2 py-0.5 rounded-md hover:bg-white/70 transition-colors"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
                     strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3">
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5Z" />
                </svg>
                修改
              </button>
            )}
            {/* Token 用量：服务端返回 usage 时显示（输入/输出） */}
            {!isUser && !isError && message.usage && (
              <span
                title={`输入 ${message.usage.prompt_tokens} / 输出 ${message.usage.completion_tokens} tokens`}
                className="ml-auto pl-2 text-[10px] text-muted/70 tabular-nums whitespace-nowrap"
              >
                ↑{message.usage.prompt_tokens} ↓{message.usage.completion_tokens}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(MessageBubble);
