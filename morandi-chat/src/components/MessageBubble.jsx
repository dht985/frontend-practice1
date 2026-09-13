import { useState, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter";
import jsx from "react-syntax-highlighter/dist/esm/languages/prism/jsx";
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css";
import markup from "react-syntax-highlighter/dist/esm/languages/prism/markup";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import { BlobDot } from "./Decor";

// 只注册常用语言，保持包体轻量
[
  ["jsx", jsx], ["javascript", javascript], ["typescript", typescript],
  ["python", python], ["css", css], ["markup", markup],
  ["html", markup], ["bash", bash], ["shell", bash], ["json", json],
].forEach(([name, mod]) => SyntaxHighlighter.registerLanguage(name, mod));

// 暖深色代码主题（背景为深灰紫，与莫兰迪色系呼应）
const codeTheme = {
  'code[class*="language-"]': {
    color: "#efe9f2",
    background: "none",
    textShadow: "none",
    fontFamily: '"SF Mono", "Cascadia Code", Consolas, monospace',
    fontSize: "0.85rem",
    lineHeight: "1.6",
    whiteSpace: "pre",
  },
  'pre[class*="language-"]': {
    background: "#3a3340",
    padding: "14px 16px",
    margin: 0,
    overflow: "auto",
    borderRadius: "12px",
  },
  comment: { color: "#a79fb0", fontStyle: "italic" },
  keyword: { color: "#dcb8dc" },
  string: { color: "#ddcfa8" },
  function: { color: "#ecc9ae" },
  number: { color: "#e5bcaa" },
  operator: { color: "#c8bfd8" },
  punctuation: { color: "#b8aec2" },
  'class-name': { color: "#c8d4bc" },
  property: { color: "#ecc9ae" },
  tag: { color: "#d8b4bc" },
  attr: { color: "#ddcfa8" },
  'attr-value': { color: "#ddcfa8" },
  builtin: { color: "#c8d4bc" },
};

// —— 结构化输出：完成态 AI 气泡的 JSON 树视图 ——
const JSON_COLORS = {
  key: "#6d5f7a",
  string: "#9a6b4f",
  number: "#6d7fa3",
  boolean: "#71875f",
  null: "#8c847c",
};

function JsonValue({ value }) {
  if (value === null) return <span style={{ color: JSON_COLORS.null }}>null</span>;
  switch (typeof value) {
    case "string":
      return <span style={{ color: JSON_COLORS.string }}>"{value}"</span>;
    case "number":
      return <span style={{ color: JSON_COLORS.number }}>{String(value)}</span>;
    case "boolean":
      return <span style={{ color: JSON_COLORS.boolean }}>{String(value)}</span>;
    default:
      return null;
  }
}

// 单个节点：对象/数组可折叠（默认展开到第二层），基础类型着色直显
function JsonNode({ label, value, depth }) {
  const [open, setOpen] = useState(depth < 2);
  const isContainer = value !== null && typeof value === "object";
  const isArr = isContainer && Array.isArray(value);
  const entries = isContainer
    ? isArr
      ? value.map((v, i) => [i, v])
      : Object.entries(value)
    : [];
  const labelText = label === null ? null : typeof label === "number" ? `[${label}]` : `"${label}"`;

  if (!isContainer) {
    return (
      <div className="whitespace-pre-wrap break-all" style={{ paddingLeft: depth ? 12 : 0 }}>
        {labelText !== null && (
          <span className="font-medium" style={{ color: JSON_COLORS.key }}>{labelText}: </span>
        )}
        <JsonValue value={value} />
      </div>
    );
  }

  return (
    <div style={{ paddingLeft: depth ? 12 : 0 }}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-left rounded px-0.5 -mx-0.5 hover:bg-white/60 transition-colors"
      >
        <span className={`inline-block text-[9px] text-muted transition-transform ${open ? "rotate-90" : ""}`}>▶</span>
        {labelText !== null && (
          <span className="font-medium" style={{ color: JSON_COLORS.key }}>{labelText}</span>
        )}
        <span className="text-muted">
          {isArr ? "[" : "{"}
          {!open && ` …${entries.length} 项${isArr ? "]" : "}"}`}
        </span>
      </button>
      {open && (
        <>
          {entries.map(([k, v]) => (
            <JsonNode key={k} label={k} value={v} depth={depth + 1} />
          ))}
          <div className="text-muted">{isArr ? "]" : "}"}</div>
        </>
      )}
    </div>
  );
}

// JSON 面板：树 / 原文切换 + 复制 + 下载 .json
function JsonPanel({ data, raw }) {
  const [view, setView] = useState("tree");
  const [copied, setCopied] = useState(false);
  const btn = "text-[10px] text-ink/80 hover:text-ink px-1.5 py-0.5 rounded-md hover:bg-white/70 transition-colors";

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(raw);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 忽略
    }
  };

  const handleDownload = () => {
    const blob = new Blob([raw], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "response.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="not-prose">
      <div className="flex items-center gap-1 mb-1.5">
        <span className="px-1.5 py-0.5 rounded-md bg-white/60 border border-white/70 text-[10px] font-semibold text-ink tracking-wide">
          {"{ } JSON"}
        </span>
        <button onClick={() => setView(view === "tree" ? "raw" : "tree")} className={btn}>
          {view === "tree" ? "原文" : "树视图"}
        </button>
        <button onClick={handleCopy} className={btn}>{copied ? "已复制" : "复制"}</button>
        <button onClick={handleDownload} className={btn}>下载 .json</button>
      </div>
      {view === "tree" ? (
        <div className="px-3 py-2.5 rounded-xl bg-white/50 border border-white/60 text-[12px] leading-6 overflow-auto max-h-80">
          <JsonNode label={null} value={data} depth={0} />
        </div>
      ) : (
        <CodeBlock language="json">{raw}</CodeBlock>
      )}
    </div>
  );
}

const ATTACHMENT_ICON = {
  image: "🖼️",
  video: "🎬",
  doc: "📄",
  audio: "🎵",
  unknown: "📎",
};

function CodeBlock({ language, children }) {
  const [copied, setCopied] = useState(false);
  const code = String(children).replace(/\n$/, "");
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 忽略
    }
  };
  return (
    <div className="relative not-prose">
      <SyntaxHighlighter
        language={language || "text"}
        style={codeTheme}
        customStyle={{
          background: "#3a3340",
          borderRadius: "12px",
          margin: "0.6em 0",
          boxShadow: "inset 0 0 0 1px rgba(247,243,238,0.06)",
        }}
      >
        {code}
      </SyntaxHighlighter>
      <button
        onClick={handleCopy}
        title="复制代码"
        className={`absolute top-2 right-2 px-2 py-0.5 rounded-md text-[10px] transition-all
                    ${copied
                      ? "bg-sage/80 text-[#2f2a33]"
                      : "bg-white/10 text-[#efe9f2]/80 hover:bg-white/20 hover:text-[#efe9f2]"}`}
      >
        {copied ? "已复制" : "复制"}
      </button>
    </div>
  );
}

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
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"
         strokeLinecap="round" strokeLinejoin="round"
         className="w-3 h-3 mt-0.5 text-sagedeep flex-shrink-0">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function ToolSteps({ steps, streaming, pendingConfirms = {}, onRespond, onRetryTool }) {
  const [open, setOpen] = useState(false);
  const hasAwaiting = steps.some((s) => s.status === "awaiting");
  const expanded = streaming || open || hasAwaiting;
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
      {expanded && (
        <div className="px-2.5 pb-2 space-y-1">
          {steps.map((s, i) => {
            // 状态文案：执行中 / 自动重试中 / 调用成功 / 最终失败
            let statusText = null;
            if (s.status === "running") statusText = "执行中…";
            else if (s.status === "retrying")
              statusText = `自动重试中（重试 ${s.retry}/${s.maxRetry || s.retry}）`;
            else if (s.status === "awaiting") statusText = "等待你的确认…";
            else if (s.status === "rejected") statusText = "已拒绝，未执行";
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
                          : "text-muted/70"
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
                {/* 结果 / 失败原因 */}
                {s.status === "done" && s.result && (
                  <span className="block text-muted/70 font-mono pl-3.5">→ {s.result}</span>
                )}
                {s.status === "error" && s.result && (
                  <span className="block text-[#b08a86] font-mono pl-3.5">→ {s.result}</span>
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

export default function MessageBubble({ message, index, entry, isLast = false, onRetry, onRegenerate, onEdit, onSwitchVersion, pendingConfirms, onRespondToolConfirm, onRetryTool }) {
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
          {jsonMsg !== null ? (
            <JsonPanel data={jsonMsg} raw={String(message.content).trim()} />
          ) : message.content ? (
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
              {message.content}
            </ReactMarkdown>
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
                {message.sources.map((s, i) => (
                  <a
                    key={i}
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block text-[11px] text-sagedeep hover:text-peachdeep transition-colors truncate"
                  >
                    {i + 1}. {s.title || s.url}
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
        </div>

        {/* 版本切换 < y/x >：消息存在多版本时显示（用户消息多版本=修改分支；AI 消息多版本=换回答） */}
        {entry?.parent?.children?.length > 1 && onSwitchVersion && (
          <div className="flex items-center gap-0.5 mt-1.5 not-prose text-[11px] text-ink/80">
            <button
              onClick={() => onSwitchVersion(entry.parent.id, -1)}
              disabled={entry.index <= 0}
              title="上一版"
              className="w-5 h-5 flex items-center justify-center rounded hover:bg-white/70
                         hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
            >
              &lt;
            </button>
            <span className="tabular-nums px-0.5">
              {entry.index + 1}/{entry.parent.children.length}
            </span>
            <button
              onClick={() => onSwitchVersion(entry.parent.id, 1)}
              disabled={entry.index >= entry.parent.children.length - 1}
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
