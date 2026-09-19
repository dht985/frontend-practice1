import { useEffect, useState, useMemo } from "react";
import { NATIVE_TOOL_DECLS } from "../api/nativeTools";
import { clearTraces, exportTraces, subscribe as subscribeTraces, traceCount } from "../api/sessionTrace";

// 诊断日志：本地会话 trace 的导出入口（只在内存里，不记正文）
function DiagnosticsSection() {
  const [count, setCount] = useState(traceCount());
  useEffect(() => subscribeTraces(() => setCount(traceCount())), []);

  const handleExport = () => {
    const blob = new Blob([exportTraces()], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `morandi-trace-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="mt-4 pt-3 border-t border-line/60">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] text-ink font-medium">诊断日志</p>
          <p className="text-[10px] text-muted/80 mt-0.5 leading-relaxed">
            记录最近请求的轮次、工具调用、耗时与错误（当前 {count} 条）。
            只存在内存里、不含对话正文，出问题时导出给我看即可。
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={handleExport}
            disabled={!count}
            className="text-[11px] text-ink/80 hover:text-ink px-2 py-1 rounded-lg border border-line
                       hover:bg-sand transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            导出
          </button>
          <button
            type="button"
            onClick={() => {
              clearTraces();
              setCount(0);
            }}
            disabled={!count}
            className="text-[11px] text-muted hover:text-ink px-2 py-1 rounded-lg border border-line
                       hover:bg-sand transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            清空
          </button>
        </div>
      </div>
    </div>
  );
}

// 内置系统提示词模板（内置不可删）
const BUILTIN_PROMPTS = [
  { id: "builtin-translator", name: "中英翻译官", content: "你是一名专业翻译，在中文和英文之间互译。只输出译文，不要解释；保持原文的语气与格式。" },
  { id: "builtin-polish", name: "文字润色", content: "你是文字编辑。在保持原意的前提下，把用户给出的文字改得更通顺、专业、简洁；直接给出润色结果，必要时用一两句话说明主要改动。" },
  { id: "builtin-review", name: "代码审查", content: "你是严谨的资深工程师。审查用户给出的代码：指出 bug、边界条件、可读性和性能问题，按严重程度排序，并给出修改后的代码。" },
  { id: "builtin-python", name: "Python 老师", content: "你是耐心的 Python 老师。讲解时先给结论，再用最小可运行示例说明，语言通俗，适合大二计算机专业学生。" },
  { id: "builtin-socratic", name: "苏格拉底式引导", content: "你是学习引导者。不要直接给出答案，而是通过连续追问帮用户理清思路、自己发现答案；用户明确要求直接答案时除外。" },
];

// 组装实际会发出的参数（供代码片段展示，过滤掉无效/不支持项）
function effectiveParams(workbench, paramCaps, structuredOn) {
  const out = {};
  if (paramCaps.temperature) out.temperature = workbench.temperature;
  if (paramCaps.topP) out.top_p = workbench.topP;
  if (paramCaps.maxTokens && workbench.maxTokens > 0) out.max_tokens = workbench.maxTokens;
  const stop = workbench.stop.split(/[\n,，]/).map((s) => s.trim()).filter(Boolean);
  if (paramCaps.stop && stop.length) out.stop = stop;
  if (structuredOn) out.response_format = { type: "json_object" };
  return out;
}

function buildSnippet(lang, { baseURL, model, systemPrompt, params }) {
  const messages = [
    ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
    { role: "user", content: "你好" },
  ];
  if (lang === "curl") {
    const body = { model, messages, ...params };
    return `curl ${baseURL}/chat/completions \\
  -H "Authorization: Bearer $YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify(body, null, 2)}'`;
  }
  if (lang === "javascript") {
    const body = JSON.stringify({ model, messages, ...params }, null, 2).replace(/^/gm, "  ");
    return `const resp = await fetch("${baseURL}/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: "Bearer " + process.env.OPENAI_API_KEY,
  },
  body: JSON.stringify(
${body}
  ),
});
const data = await resp.json();
console.log(data.choices[0].message.content);`;
  }
  // python（openai SDK）
  const pyMsgs = messages
    .map((m) => `    {"role": ${JSON.stringify(m.role)}, "content": ${JSON.stringify(m.content)}},`)
    .join("\n");
  const lines = [
    "# pip install openai",
    "from openai import OpenAI",
    "",
    "client = OpenAI(",
    '    api_key="sk-你的API_KEY",  # 也可用环境变量 OPENAI_API_KEY',
    `    base_url=${JSON.stringify(baseURL)},`,
    ")",
    "",
    "resp = client.chat.completions.create(",
    `    model=${JSON.stringify(model)},`,
    "    messages=[",
    pyMsgs,
    "    ],",
  ];
  for (const [k, v] of Object.entries(params)) lines.push(`    ${k}=${JSON.stringify(v)},`);
  lines.push(")");
  lines.push("print(resp.choices[0].message.content)");
  return lines.join("\n");
}

// 开关（结构化输出等布尔项）
function Toggle({ checked, disabled, onChange }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!checked)}
      title={disabled ? "当前服务商不支持" : undefined}
      className={`relative w-9 h-5 rounded-full transition-colors flex-shrink-0
                  ${checked ? "bg-peachdeep" : "bg-line"}
                  ${disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-soft transition-transform
                    ${checked ? "translate-x-4" : "translate-x-0"}`}
      />
    </button>
  );
}

// 滑块行
function SliderRow({ label, value, min, max, step, disabled, hint, onChange }) {
  return (
    <div className={disabled ? "opacity-50" : ""}>
      <div className="flex items-center justify-between mb-1">
        <label className="text-[13px] text-ink font-medium">{label}</label>
        <span className="text-[11px] text-muted tabular-nums">
          {disabled ? "不支持" : value}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-peachdeep cursor-pointer disabled:cursor-not-allowed"
      />
      {hint && <p className="text-[10px] text-muted/80 mt-0.5 leading-snug">{hint}</p>}
    </div>
  );
}

// 单个工具的编辑表单（展开在列表项下方）
function ToolEditor({ tool, onUpdate }) {
  let schemaOk = true;
  try {
    JSON.parse(tool.parameters || "{}");
  } catch {
    schemaOk = false;
  }
  const nameOk = /^[A-Za-z0-9_-]+$/.test(tool.name.trim());
  return (
    <div className="px-3 pb-3 pt-2.5 border-t border-line/60 space-y-2">
      <input
        value={tool.name}
        onChange={(e) => onUpdate({ name: e.target.value })}
        placeholder="工具名，如 get_weather"
        className="w-full px-2.5 py-1.5 border border-line rounded-lg outline-none text-[12px]
                   text-ink bg-white focus:border-peach"
      />
      {!nameOk && (
        <p className="text-[10px] text-[#b08a86] leading-snug">
          名称只能包含英文字母、数字、下划线和中划线（发送时其他字符会自动替换）
        </p>
      )}
      <input
        value={tool.description}
        onChange={(e) => onUpdate({ description: e.target.value })}
        placeholder="一句话描述工具做什么，模型据此决定何时调用"
        className="w-full px-2.5 py-1.5 border border-line rounded-lg outline-none text-[12px]
                   text-ink bg-white focus:border-peach"
      />
      <textarea
        value={tool.parameters}
        onChange={(e) => onUpdate({ parameters: e.target.value })}
        rows={3}
        placeholder={'参数 JSON Schema，如 {"type":"object","properties":{"city":{"type":"string"}}}'}
        className="w-full px-2.5 py-2 border border-line rounded-lg outline-none text-[11px] font-mono
                   leading-relaxed text-ink bg-white focus:border-peach resize-y"
      />
      {!schemaOk && (
        <p className="text-[10px] text-[#b08a86] leading-snug">
          参数 Schema 不是合法 JSON，发送时将回退为空参数模式
        </p>
      )}
      <textarea
        value={tool.code}
        onChange={(e) => onUpdate({ code: e.target.value })}
        rows={6}
        placeholder="// JS 函数体：通过 args.参数名 取参数，用 return 返回结果（支持 async/await）"
        className="w-full px-2.5 py-2 border border-line rounded-lg outline-none text-[11px] font-mono
                   leading-relaxed text-ink bg-white focus:border-peach resize-y"
      />
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] text-ink font-medium leading-tight">调用前需人工确认</p>
          <p className="text-[10px] text-muted/80 leading-snug mt-0.5">
            开启后模型每次调用该工具都会暂停，等你点「允许」才执行（适合写文件、删除等危险操作）
          </p>
        </div>
        <Toggle checked={!!tool.confirm} onChange={(v) => onUpdate({ confirm: v })} />
      </div>
      <p className="text-[10px] text-muted/80 leading-snug">
        函数体里通过 <code>args.参数名</code> 读取模型传入的参数，<code>return</code> 的值会转成 JSON 回传给模型。
      </p>
    </div>
  );
}

export default function WorkbenchPanel({
  open, onClose, workbench, onChange, paramCaps, modelLabel, baseURL,
  responseFormat,
  promptLib, onAddTemplate, onDeleteTemplate,
  toolLib, onAddTool, onUpdateTool, onDeleteTool,
  nativeToolSettings, onToggleNativeTool,
}) {
  const [tab, setTab] = useState("curl");
  const [copied, setCopied] = useState(false);
  const [tplPick, setTplPick] = useState("");
  const [saving, setSaving] = useState(false);
  const [tplName, setTplName] = useState("");
  const [editingTool, setEditingTool] = useState(""); // 当前展开编辑的工具 id

  const set = (patch) => onChange({ ...workbench, ...patch });
  const allTemplates = useMemo(() => [...BUILTIN_PROMPTS, ...promptLib], [promptLib]);

  // 下拉选择模板 → 内容载入系统提示词编辑框
  const loadTemplate = (id) => {
    setTplPick(id);
    const t = allTemplates.find((x) => x.id === id);
    if (t) set({ systemPrompt: t.content });
  };

  const saveTemplate = () => {
    const name = tplName.trim();
    if (!name || !workbench.systemPrompt.trim()) { setSaving(false); return; }
    onAddTemplate({ name, content: workbench.systemPrompt.trim() });
    setTplName("");
    setSaving(false);
  };

  const snippet = useMemo(() => {
    if (!open) return "";
    return buildSnippet(tab, {
      baseURL: baseURL || "https://api.example.com/v1",
      model: modelLabel.split(" · ")[1] || "model-name",
      systemPrompt: workbench.systemPrompt.trim(),
      params: effectiveParams(workbench, paramCaps, workbench.structured && responseFormat),
    });
  }, [tab, open, baseURL, modelLabel, workbench, paramCaps, responseFormat]);

  const copySnippet = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* 忽略 */ }
  };

  if (!open) return null;

  return (
    <>
      {/* 遮罩 */}
      <div
        className="fixed inset-0 z-40 bg-ink/25 backdrop-blur-[2px] animate-fade-up"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* 右侧抽屉 */}
      <aside
        className={`fixed top-0 right-0 z-50 h-full w-[min(400px,92vw)] bg-cream shadow-float
                    border-l border-line/70 flex flex-col animate-fade-up`}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-line/70">
          <div>
            <h2 className="text-[15px] font-semibold text-ink">AI 工作台</h2>
            <p className="text-[11px] text-muted mt-0.5 truncate max-w-[260px]">{modelLabel}</p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg text-muted hover:text-ink hover:bg-sand flex items-center justify-center transition-colors"
            title="关闭"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                 strokeLinecap="round" className="w-4 h-4">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-6">
          {/* —— 系统提示词 —— */}
          <section>
            <div className="flex items-center justify-between mb-1.5">
              <h3 className="text-[13px] font-semibold text-ink">系统提示词（System）</h3>
              <button
                onClick={() => setSaving((v) => !v)}
                disabled={!workbench.systemPrompt.trim()}
                className="text-[11px] text-peachdeep hover:text-ink disabled:opacity-40
                           px-2 py-0.5 rounded-md hover:bg-white/70 transition-colors"
              >
                + 存为模板
              </button>
            </div>
            <textarea
              value={workbench.systemPrompt}
              onChange={(e) => set({ systemPrompt: e.target.value })}
              rows={5}
              placeholder="给模型设定角色与规则，例如：你是严谨的代码审查员……&#10;留空则不发送自定义系统提示。"
              className="w-full px-3 py-2.5 border border-line rounded-xl outline-none text-[13px] leading-relaxed
                         text-ink bg-white/70 focus:border-peach transition-colors resize-y"
            />
            {/* 模板库 */}
            <div className="mt-2 flex items-center gap-2">
              <select
                value={tplPick}
                onChange={(e) => loadTemplate(e.target.value)}
                className="flex-1 min-w-0 px-2.5 py-1.5 border border-line rounded-lg bg-cream/60
                           text-[12px] text-ink outline-none focus:border-peach"
              >
                <option value="">📚 提示词模板库…</option>
                {BUILTIN_PROMPTS.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
                {promptLib.length > 0 && promptLib.map((t) => (
                  <option key={t.id} value={t.id}>（我的）{t.name}</option>
                ))}
              </select>
            </div>
            {/* 自定义模板列表 + 删除 */}
            {promptLib.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {promptLib.map((t) => (
                  <span key={t.id}
                        className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-md
                                   bg-lilacsoft/60 border border-plum/40 text-[11px] text-ink">
                    <button onClick={() => loadTemplate(t.id)} className="hover:text-peachdeep">{t.name}</button>
                    <button
                      onClick={() => onDeleteTemplate(t.id)}
                      title="删除该模板"
                      className="text-muted/60 hover:text-[#b08a86] p-0.5"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                           strokeLinecap="round" className="w-2.5 h-2.5">
                        <path d="M18 6 6 18M6 6l12 12" />
                      </svg>
                    </button>
                  </span>
                ))}
              </div>
            )}
            {saving && (
              <div className="mt-2 flex items-center gap-2">
                <input
                  autoFocus
                  value={tplName}
                  onChange={(e) => setTplName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing) return;
                    if (e.key === "Enter") saveTemplate();
                    if (e.key === "Escape") setSaving(false);
                  }}
                  placeholder="模板名称，如：面试官"
                  className="flex-1 min-w-0 px-2.5 py-1.5 border border-peach/60 rounded-lg
                             bg-white text-[12px] text-ink outline-none"
                />
                <button onClick={saveTemplate}
                        className="text-[11px] px-2.5 py-1.5 rounded-lg bg-peach hover:bg-peachdeep text-ink">
                  保存
                </button>
              </div>
            )}
          </section>

          {/* —— 生成参数 —— */}
          <section className="space-y-3.5">
            <h3 className="text-[13px] font-semibold text-ink">生成参数</h3>
            <SliderRow
              label="Temperature（随机性）"
              value={workbench.temperature}
              min={0} max={2} step={0.05}
              disabled={!paramCaps.temperature}
              hint={paramCaps.temperature
                ? "0 严谨确定，2 发散奔放"
                : "该推理模型由推理强度控制，不接受采样参数"}
              onChange={(v) => set({ temperature: v })}
            />
            <SliderRow
              label="Top P（核采样）"
              value={workbench.topP}
              min={0} max={1} step={0.05}
              disabled={!paramCaps.topP}
              hint={paramCaps.topP ? "只从累计概率前 P 的词中采样，一般与温度调一个即可" : "该模型不支持此参数"}
              onChange={(v) => set({ topP: v })}
            />
            <div className={paramCaps.maxTokens ? "" : "opacity-50"}>
              <label className="block text-[13px] text-ink font-medium mb-1">最大输出长度（tokens）</label>
              <input
                type="number"
                min={0}
                step={100}
                value={workbench.maxTokens}
                disabled={!paramCaps.maxTokens}
                onChange={(e) => set({ maxTokens: Math.max(0, Number(e.target.value) || 0) })}
                className="w-full px-3 py-2 border border-line rounded-xl outline-none text-[13px]
                           text-ink bg-white/70 focus:border-peach disabled:cursor-not-allowed"
              />
              <p className="text-[10px] text-muted/80 mt-0.5">0 表示不限制（使用模型默认上限）</p>
            </div>
            <div>
              <label className="block text-[13px] text-ink font-medium mb-1">上下文窗口（tokens）</label>
              <input
                type="number"
                min={0}
                step={1000}
                value={workbench.contextWindow ?? 0}
                onChange={(e) => set({ contextWindow: Math.max(0, Number(e.target.value) || 0) })}
                className="w-full px-3 py-2 border border-line rounded-xl outline-none text-[13px]
                           text-ink bg-white/70 focus:border-peach"
              />
              <p className="text-[10px] text-muted/80 mt-0.5">
                0 表示用默认 128k；超出预算时会自动省略最早的整轮对话（含附件）
              </p>
            </div>
            <div className={paramCaps.stop ? "" : "opacity-50"}>
              <label className="block text-[13px] text-ink font-medium mb-1">停止序列</label>
              <input
                type="text"
                value={workbench.stop}
                disabled={!paramCaps.stop}
                onChange={(e) => set({ stop: e.target.value })}
                placeholder="用逗号或换行分隔，如：END, 完毕"
                className="w-full px-3 py-2 border border-line rounded-xl outline-none text-[13px]
                           text-ink bg-white/70 focus:border-peach disabled:cursor-not-allowed"
              />
              <p className="text-[10px] text-muted/80 mt-0.5">模型生成到这些词时自动停止</p>
            </div>
          </section>

          {/* —— 结构化输出 —— */}
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-[13px] font-semibold text-ink">结构化输出（JSON）</h3>
              <Toggle
                checked={workbench.structured}
                disabled={!responseFormat}
                onChange={(v) => set({ structured: v })}
              />
            </div>
            {responseFormat ? (
              <p className="text-[10px] text-muted/80 leading-snug">
                开启后请求带 response_format: {`{ type: "json_object" }`}，模型只输出合法 JSON；
                AI 气泡会自动渲染为可折叠 JSON 树，可复制 / 下载。
              </p>
            ) : (
              <p className="text-[10px] text-muted/80 leading-snug">
                当前服务商不支持 response_format 参数，无法开启。
              </p>
            )}
            {workbench.structured && !responseFormat && (
              <p className="text-[10px] text-[#b08a86] leading-snug">
                切换到不支持的服务商后，该设置将被自动忽略。
              </p>
            )}
            {workbench.structured && responseFormat && (
              <textarea
                value={workbench.schemaText}
                onChange={(e) => set({ schemaText: e.target.value })}
                rows={4}
                placeholder={'可选：描述期望的 JSON 结构，如 {"name": "string", "tags": ["string"]}，或粘贴 JSON Schema'}
                className="w-full px-3 py-2.5 border border-line rounded-xl outline-none text-[12px] font-mono
                           leading-relaxed text-ink bg-white/70 focus:border-peach transition-colors resize-y"
              />
            )}
          </section>

          {/* —— 预置工具（fetch_url / todo_list） —— */}
          <section className="space-y-2">
            <h3 className="text-[13px] font-semibold text-ink">预置工具</h3>
            <p className="text-[10px] text-muted/80 leading-snug">
              内置的 fetch_url（网页抓取）与 todo_list（本地待办）可在此启停。关闭后不随请求声明给模型，Agent 按钮可用性也会跟随实际工具数。
            </p>
            {NATIVE_TOOL_DECLS.map((d) => {
              const name = d.function.name;
              const enabled = nativeToolSettings?.[name] !== false;
              const desc = d.function.description.split("。")[0];
              return (
                <div key={name} className="flex items-center gap-2 px-3 py-2 border border-line/70 rounded-xl bg-white/50">
                  <div className="flex-1 min-w-0">
                    <span className="text-[12.5px] text-ink font-medium">{name}</span>
                    <p className="text-[10.5px] text-muted truncate">{desc}</p>
                  </div>
                  <Toggle checked={enabled} onChange={(v) => onToggleNativeTool?.(name, v)} />
                </div>
              );
            })}
          </section>

          {/* —— 自定义工具（Function Calling） —— */}
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-[13px] font-semibold text-ink">自定义工具（Function Calling）</h3>
              <button
                onClick={() => {
                  const t = onAddTool();
                  setEditingTool(t.id);
                }}
                className="text-[11px] text-peachdeep hover:text-ink px-2 py-0.5 rounded-md
                           hover:bg-white/70 transition-colors"
              >
                ＋ 新建工具
              </button>
            </div>
            <p className="text-[10px] text-muted/80 leading-snug">
              启用的工具会随请求声明给模型，模型决定调用时在你本地浏览器执行（思路同 Google AI Studio），
              请只添加自己写的代码。内置示例工具可启停、编辑或复制。
            </p>
            {toolLib.map((t) => (
              <div key={t.id} className="border border-line/70 rounded-xl bg-white/50 overflow-hidden">
                <div className="flex items-center gap-2 px-3 py-2">
                  <button
                    onClick={() => setEditingTool(editingTool === t.id ? "" : t.id)}
                    className="flex-1 min-w-0 text-left"
                    title="点击展开 / 收起编辑"
                  >
                    <span className="text-[12.5px] text-ink font-medium truncate">{t.name || "未命名工具"}</span>
                    {t.builtin && (
                      <span className="ml-1.5 text-[9.5px] px-1 py-0.5 rounded bg-lilacsoft/70 text-ink/60 align-middle">
                        内置
                      </span>
                    )}
                    {t.confirm && (
                      <span title="调用前需人工确认"
                            className="ml-1 text-[11px] text-peachdeep align-middle leading-none">⚠</span>
                    )}
                    <p className="text-[10.5px] text-muted truncate">{t.description || "（无描述）"}</p>
                  </button>
                  {t.builtin && (
                    <button
                      onClick={() => {
                        const nt = onAddTool(t);
                        setEditingTool(nt.id);
                      }}
                      title="复制一份为自定义工具"
                      className="text-[10.5px] text-muted hover:text-ink px-1.5 py-0.5 rounded-md
                                 hover:bg-sand transition-colors flex-shrink-0"
                    >
                      复制
                    </button>
                  )}
                  {!t.builtin && (
                    <button
                      onClick={() => {
                        if (editingTool === t.id) setEditingTool("");
                        onDeleteTool(t.id);
                      }}
                      title="删除该工具"
                      className="text-muted/60 hover:text-[#b08a86] p-1 flex-shrink-0 transition-colors"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                           strokeLinecap="round" className="w-3 h-3">
                        <path d="M18 6 6 18M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                  <Toggle checked={t.enabled} onChange={(v) => onUpdateTool(t.id, { enabled: v })} />
                </div>
                {editingTool === t.id && (
                  <ToolEditor tool={t} onUpdate={(patch) => onUpdateTool(t.id, patch)} />
                )}
              </div>
            ))}
          </section>

          {/* —— 生成调用代码 —— */}
          <section>
            <div className="flex items-center justify-between mb-1.5">
              <h3 className="text-[13px] font-semibold text-ink">生成调用代码</h3>
              <button
                onClick={copySnippet}
                className="text-[11px] text-peachdeep hover:text-ink px-2 py-0.5 rounded-md
                           hover:bg-white/70 transition-colors"
              >
                {copied ? "✓ 已复制" : "复制代码"}
              </button>
            </div>
            <div className="flex gap-1 mb-1.5">
              {[["curl", "curl"], ["javascript", "JavaScript"], ["python", "Python"]].map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setTab(k)}
                  className={`px-2.5 py-1 rounded-lg text-[11px] transition-colors
                    ${tab === k
                      ? "bg-ink text-cream"
                      : "bg-white/60 text-muted hover:text-ink border border-line/60"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <pre className="bg-[#3a3340] text-[#efe9f2] rounded-xl p-3 overflow-x-auto
                            text-[10.5px] leading-relaxed max-h-64 overflow-y-auto whitespace-pre">
              {snippet}
            </pre>
            <p className="text-[10px] text-muted/80 mt-1">代码中 API Key 为占位符，请勿把真实 Key 提交到公开仓库。</p>
          </section>
        </div>

        {/* 底部：重置 */}
        <div className="px-5 py-3 border-t border-line/70 flex justify-between items-center">
          <span className="text-[11px] text-muted">配置对所有对话生效，自动保存</span>
          <button
            onClick={() => {
              onChange({
                systemPrompt: "",
                temperature: 0.7,
                topP: 1,
                maxTokens: 0,
                contextWindow: 0,
                stop: "",
                structured: false,
                schemaText: "",
              });
              setTplPick("");
            }}
            className="text-[11px] text-muted hover:text-ink px-2.5 py-1 rounded-lg
                       hover:bg-sand transition-colors"
          >
            恢复默认
          </button>
        </div>
        <DiagnosticsSection />
      </aside>
    </>
  );
}
