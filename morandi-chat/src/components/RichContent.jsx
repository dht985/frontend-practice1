import { useState } from "react";
import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter";
import jsx from "react-syntax-highlighter/dist/esm/languages/prism/jsx";
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css";
import markup from "react-syntax-highlighter/dist/esm/languages/prism/markup";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";

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

export function CodeBlock({ language, children }) {
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
export function JsonPanel({ data, raw }) {
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
