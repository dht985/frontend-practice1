import { useState, useRef, useEffect } from "react";
import MessageBubble from "./MessageBubble";
import { BackgroundBlobs, BlobDot } from "./Decor";
import { kindOf, formatSize } from "../api/files";
import useSpeechInput from "../hooks/useSpeechInput";

const ACCEPT_TYPES =
  "image/*,video/*,audio/*,.pdf,.txt,.csv,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.md,.html,.htm,.json,.epub,.mobi,.log,.yaml,.yml,.ini,.conf,.ts,.tsx,.js,.css,.py,.java,.go,.c,.cpp,.cs,.php";

const KIND_META = {
  image: { icon: "🖼️", label: "图片", warn: false },
  video: { icon: "🎬", label: "视频", warn: false },
  doc: { icon: "📄", label: "文档", warn: false },
  audio: { icon: "🎵", label: "音频", warn: true },
  unknown: { icon: "📎", label: "文件", warn: true },
};

const SUGGESTIONS = [
  { icon: "💡", dot: "bg-lilac/80", title: "通俗解释概念", text: "用通俗的话解释一下什么是闭包，举个 JavaScript 的例子" },
  { icon: "🐍", dot: "bg-peach/80", title: "写段代码", text: "帮我写一段 Python 快速排序，并解释思路" },
  { icon: "✍️", dot: "bg-blush/80", title: "润色文字", text: "帮我把一段话润色得更专业、更简洁" },
];

export default function ChatArea({ messages, entries = [], liveStream = null, isStreaming, model, webSearchAvailable = false, agentAvailable = false, onSend, onStop, onContinue, canContinue, onRetry, onRegenerate, onExport, onOpenWorkbench, onSwitchVersion, onOpenSidebar, profiles = [], activeProfileId, onSwitchProfile, pendingConfirms = {}, onRespondToolConfirm, onRetryTool, fullResultsMap }) {
  // 传给 MessageBubble 的回调统一用 ref 转发：它是 React.memo 组件，
  // 回调引用每次渲染都变的话 memo 会完全失效。
  const cbRef = useRef({});
  const stableCb = useRef(null);
  if (!stableCb.current) {
    const call = (key, ...args) => cbRef.current[key]?.(...args);
    stableCb.current = {
      onRetry: () => call("onRetry"),
      onRegenerate: () => call("onRegenerate"),
      onEdit: (index) => call("onEdit", index),
      onSwitchVersion: (parentId, dir) => call("onSwitchVersion", parentId, dir),
      onRespondToolConfirm: (callId, ok) => call("onRespondToolConfirm", callId, ok),
      onRetryTool: (callId) => call("onRetryTool", callId),
    };
  }
  const [input, setInput] = useState("");
  const [webSearch, setWebSearch] = useState(false);
  const [agentMode, setAgentMode] = useState(false);
  const [attachments, setAttachments] = useState([]); // {uid, file, kind, preview}
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [editingIndex, setEditingIndex] = useState(null); // 正在修改的用户消息下标
  // 语音录入（Edge 走微软服务；Chrome 需可访问 Google）
  const speech = useSpeechInput(setInput);
  const endRef = useRef(null);
  const scrollRef = useRef(null);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const modelMenuRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // 流式输出期间保持贴底，但用户主动上滑查看历史时不打扰
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight;
  }, [liveStream]);

  // 输入框自适应高度
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 160) + "px";
  }, [input]);

  // 切换到不支持联网搜索的服务商时，自动收起开关
  useEffect(() => {
    if (!webSearchAvailable) setWebSearch(false);
  }, [webSearchAvailable]);

  // 没有任何可用工具（自定义工具/联网搜索）时，自动收起 Agent 开关
  useEffect(() => {
    if (!agentAvailable) setAgentMode(false);
  }, [agentAvailable]);

  // 点击模型下拉外部时关闭
  useEffect(() => {
    if (!modelMenuOpen) return;
    const handler = (e) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target)) {
        setModelMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [modelMenuOpen]);

  // 卸载时释放图片预览 URL
  useEffect(() => {
    return () => attachments.forEach((a) => a.preview && URL.revokeObjectURL(a.preview));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFiles = (fileList) => {
    const picked = Array.from(fileList || []);
    if (!picked.length) return;
    setAttachments((prev) => [
      ...prev,
      ...picked.map((file) => {
        const kind = kindOf(file);
        return {
          uid: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          file,
          kind,
          preview: kind === "image" ? URL.createObjectURL(file) : null,
        };
      }),
    ]);
  };

  const removeAttachment = (uid) => {
    setAttachments((prev) => {
      const target = prev.find((a) => a.uid === uid);
      if (target?.preview) URL.revokeObjectURL(target.preview);
      return prev.filter((a) => a.uid !== uid);
    });
  };

  const handleSend = (text) => {
    const content = (text ?? input).trim();
    if (isStreaming) return;
    if (!content && !attachments.length) return;
    // 发送时若还在聆听，取消识别并阻止 onend 把旧文本写回
    if (speech.listening) speech.cancel();
    onSend(content, { webSearch, agentMode, files: attachments.map((a) => a.file), editIndex: editingIndex ?? -1 });
    attachments.forEach((a) => a.preview && URL.revokeObjectURL(a.preview));
    setAttachments([]);
    setInput("");
    setEditingIndex(null);
  };

  // 点击用户气泡的「修改」：内容填入输入框，进入编辑模式
  const startEdit = (i) => {
    if (isStreaming) return;
    const m = messages[i];
    if (!m || m.role !== "user") return;
    setInput(m.content);
    setEditingIndex(i);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  cbRef.current = {
    onRetry,
    onRegenerate,
    onEdit: startEdit,
    onSwitchVersion,
    onRespondToolConfirm,
    onRetryTool,
  };

  const cancelEdit = () => {
    setEditingIndex(null);
    setInput("");
  };

  // 语音录入开关：点击麦克风开始，再点结束（结束后文字留在输入框可编辑）
  const toggleSpeech = () => {
    if (speech.listening) speech.stop();
    else speech.start(input);
  };

  // 联网搜索开关：先算 next，保证按钮样式与实际状态一致
  const toggleWebSearch = () => setWebSearch((prev) => !prev);

  const onKeyDown = (e) => {
    // 中文输入法组合期间的 Enter 是"选词上屏"，不是发送
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const empty = messages.length === 0;

  return (
    <div className="flex-1 flex flex-col bg-cream bg-grain relative min-w-0">
      <BackgroundBlobs />

      {/* 顶栏：模型标识 */}
      <header className="relative z-10 px-4 md:px-8 py-4 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {/* 移动端：打开历史对话抽屉 */}
          <button
            type="button"
            onClick={onOpenSidebar}
            className="md:hidden w-9 h-9 flex-shrink-0 rounded-xl bg-cream/85 border border-line/50
                       text-muted hover:text-ink transition-colors flex items-center justify-center active:scale-95"
            title="历史对话"
            aria-label="打开历史对话"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                 strokeLinecap="round" className="w-[18px] h-[18px]">
              <path d="M4 6h16M4 12h16M4 18h10" />
            </svg>
          </button>
          {/* 模型切换器 */}
          <div ref={modelMenuRef} className="relative">
            <button
              type="button"
              onClick={() => setModelMenuOpen((v) => !v)}
              className="flex items-center gap-2 bg-cream/85 px-3 py-1.5 rounded-full border border-line/50
                         hover:border-peach/60 hover:shadow-soft transition-all min-w-0"
            >
              <BlobDot className="w-2 h-2 bg-sage flex-shrink-0" />
              <span className="text-sm text-ink font-medium truncate max-w-[160px] md:max-w-[220px]">
                {model || "未配置模型"}
              </span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                   strokeLinecap="round" className={`w-3.5 h-3.5 flex-shrink-0 text-muted transition-transform ${modelMenuOpen ? "rotate-180" : ""}`}>
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>

            {/* 折叠下拉 */}
            {modelMenuOpen && (
              <div className="absolute top-full left-0 mt-1.5 w-[min(280px,calc(100vw-2rem))] bg-cream
                              rounded-2xl shadow-float border border-line/70 py-1.5 z-50 animate-fade-up max-h-[60vh] overflow-y-auto">
                <p className="px-3.5 pb-1.5 pt-1 text-[11px] font-medium text-muted/80 tracking-widest">切换模型</p>
                {profiles.map((p) => {
                  const active = p.id === activeProfileId;
                  const pName = p.providerName || p.provider;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => {
                        onSwitchProfile?.(p.id);
                        setModelMenuOpen(false);
                      }}
                      className={`w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors
                        ${active ? "bg-lilacsoft/60" : "hover:bg-cream/80"}`}
                    >
                      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${active ? "bg-sagedeep" : "bg-muted/30"}`} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-ink font-medium truncate leading-tight">
                          {pName}
                          {active && <span className="ml-1.5 text-[10px] text-sagedeep font-normal">使用中</span>}
                        </p>
                        <p className="text-[11px] text-muted truncate mt-0.5">{p.model || "未设置"}</p>
                      </div>
                    </button>
                  );
                })}
                <div className="border-t border-line/60 mt-1 pt-1">
                  <p className="px-3.5 py-1.5 text-[11px] text-muted/70">
                    在「API 设置」中可添加更多服务商
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* AI 工作台：系统提示词 / 生成参数 / 调用代码 */}
          <button
            type="button"
            onClick={onOpenWorkbench}
            title="AI 工作台：系统提示词、生成参数、调用代码"
            className="h-9 px-3 flex items-center gap-1.5 rounded-full bg-cream/85 border border-line/50
                       text-muted hover:text-ink hover:border-peach/60 transition-colors text-xs"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
                 strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
              <line x1="4" y1="21" x2="4" y2="14" />
              <line x1="4" y1="10" x2="4" y2="3" />
              <line x1="12" y1="21" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12" y2="3" />
              <line x1="20" y1="21" x2="20" y2="16" />
              <line x1="20" y1="12" x2="20" y2="3" />
              <line x1="1" y1="14" x2="7" y2="14" />
              <line x1="9" y1="8" x2="15" y2="8" />
              <line x1="17" y1="16" x2="23" y2="16" />
            </svg>
            <span className="hidden sm:inline">工作台</span>
          </button>
          {/* 导出当前对话为 Markdown */}
          <button
            type="button"
            onClick={onExport}
            disabled={!messages.length}
            title="导出当前对话为 Markdown 文件"
            className="w-9 h-9 flex items-center justify-center rounded-full bg-cream/85 border border-line/50
                       text-muted hover:text-ink hover:border-peach/60 transition-colors
                       disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
                 strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <path d="M7 10l5 5 5-5" />
              <path d="M12 15V3" />
            </svg>
          </button>
          <span className="hidden md:inline text-xs text-muted bg-cream/85 px-3 py-1.5 rounded-full border border-line/50">
            流式输出 · Markdown · 代码高亮
          </span>
        </div>
      </header>

      {/* 消息区 */}
      <div ref={scrollRef} className="relative z-10 flex-1 overflow-y-auto">
        {empty ? (
          /* —— 空状态 —— */
          <div className="h-full flex flex-col items-center justify-center px-6">
            {/* 三色色块组合 */}
            <div className="relative w-24 h-24 mb-7">
              <BlobDot
                className="absolute inset-0 bg-lilac/75 shadow-soft"
                radius="58% 42% 49% 51% / 55% 44% 56% 45%"
              />
              <BlobDot
                className="absolute -right-3 -top-2 w-12 h-12 bg-blush/85"
                radius="42% 58% 61% 39% / 47% 55% 45% 53%"
              />
              <BlobDot
                className="absolute -left-2 -bottom-1 w-10 h-10 bg-peach/85"
                radius="52% 48% 58% 42% / 46% 56% 44% 54%"
              />
            </div>
            <h2 className="text-2xl font-semibold text-ink tracking-wide">今天想聊点什么？</h2>
            <p className="text-sm text-muted mt-2.5 mb-8">安静的工作台，慢慢说。Enter 发送，Shift+Enter 换行</p>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 w-full max-w-2xl">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s.title}
                  onClick={() => handleSend(s.text)}
                  className="text-left p-4 rounded-2xl bg-white/75 border border-line/70 shadow-soft
                             hover:shadow-float hover:border-peach/70 hover:-translate-y-0.5
                             transition-all duration-200 group"
                >
                  <div className="flex items-center gap-2 mb-2">
                    <BlobDot className={`w-3 h-3 ${s.dot}`} radius="45% 55% 60% 40% / 50% 42% 58% 50%" />
                    <span className="text-lg leading-none">{s.icon}</span>
                  </div>
                  <div className="text-sm font-medium text-ink group-hover:text-peachdeep transition-colors">
                    {s.title}
                  </div>
                  <div className="text-xs text-muted mt-1 line-clamp-2 leading-relaxed">{s.text}</div>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="max-w-3xl mx-auto px-4 md:px-6 py-5 md:py-6 space-y-5">
            {messages.map((m, i) => {
              const entry = entries[i];
              // 流式文本只覆盖正在生成的那一条；其余消息保持原对象引用，
              // 这样 React.memo 才能让它们跳过重渲染。
              const streamingText = liveStream && liveStream.nodeId === m.id ? liveStream.text : null;
              const streamingReasoning = liveStream && liveStream.nodeId === m.id ? liveStream.reasoning : null;
              return (
                <MessageBubble
                  key={m.id || i}
                  message={m}
                  index={i}
                  streamingText={streamingText}
                  streamingReasoning={streamingReasoning}
                  isLast={i === messages.length - 1}
                  versionParentId={entry?.parent?.id}
                  versionIndex={entry?.index ?? 0}
                  versionCount={entry?.parent?.children?.length ?? 1}
                  onRetry={stableCb.current.onRetry}
                  onRegenerate={stableCb.current.onRegenerate}
                  onEdit={stableCb.current.onEdit}
                  onSwitchVersion={stableCb.current.onSwitchVersion}
                  pendingConfirms={pendingConfirms}
                  onRespondToolConfirm={stableCb.current.onRespondToolConfirm}
                  onRetryTool={stableCb.current.onRetryTool}
                  fullResultsMap={fullResultsMap}
                />
              );
            })}
            <div ref={endRef} className="h-2" />
          </div>
        )}
      </div>

      {/* 输入区 */}
      <div className="relative z-10 px-3 md:px-6 pb-4 md:pb-6 pt-2">
        <div className="max-w-3xl mx-auto">
          <div
            className="flex flex-col gap-2.5 bg-white/90 border border-line rounded-2xl px-4 pt-3 pb-3
                       shadow-float transition-all duration-200
                       focus-within:border-peach focus-within:shadow-glow"
          >
            {/* 附件预览条 */}
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {attachments.map((a) => {
                  const meta = KIND_META[a.kind];
                  return (
                    <div
                      key={a.uid}
                      className={`group flex items-center gap-2 pl-1.5 pr-2 py-1.5 rounded-xl border max-w-[240px]
                        ${meta.warn
                          ? "bg-peachsoft/70 border-peach/50"
                          : "bg-cream/70 border-line/80"}`}
                    >
                      {a.preview ? (
                        <img src={a.preview} alt="" className="w-8 h-8 rounded-lg object-cover flex-shrink-0" />
                      ) : (
                        <span className="w-8 h-8 rounded-lg bg-white/70 border border-line/60 flex items-center justify-center text-base flex-shrink-0">
                          {meta.icon}
                        </span>
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium text-ink truncate leading-tight">{a.file.name}</p>
                        <p className={`text-[10px] leading-tight mt-0.5 ${meta.warn ? "text-peachdeep" : "text-muted"}`}>
                          {meta.warn
                            ? a.kind === "audio"
                              ? "暂不支持音频，发送时将跳过"
                              : "格式不受支持，将跳过"
                            : `${meta.label} · ${formatSize(a.file.size)}`}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeAttachment(a.uid)}
                        disabled={isStreaming}
                        className="text-muted/60 hover:text-ink disabled:opacity-40 p-0.5 flex-shrink-0"
                        title="移除"
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                             strokeLinecap="round" className="w-3.5 h-3.5">
                          <path d="M18 6 6 18M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {/* 语音录入状态条 */}
            {(speech.listening || speech.error) && (
              <div className="flex items-center justify-between mb-1 px-1 animate-fade-up">
                {speech.listening ? (
                  <span className="inline-flex items-center gap-1.5 text-[11px] text-peachdeep">
                    <span className="relative flex h-2 w-2">
                      <span className="absolute inline-flex h-full w-full rounded-full bg-blush opacity-70 animate-ping" />
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-[#c98a92]" />
                    </span>
                    正在聆听，语音将转为文字…再点麦克风结束
                  </span>
                ) : (
                  <span className="flex-1 text-[11px] text-peachdeep">{speech.error}</span>
                )}
                {speech.error && !speech.listening && (
                  <button
                    type="button"
                    onClick={speech.clearError}
                    className="text-[11px] text-muted hover:text-ink px-1.5 py-0.5 rounded-md hover:bg-sand transition-colors"
                  >
                    知道了
                  </button>
                )}
              </div>
            )}

            {/* 编辑模式提示条 */}
            {editingIndex !== null && (
              <div className="flex items-center justify-between mb-2 px-1 animate-fade-up">
                <span className="inline-flex items-center gap-1.5 text-[11px] text-ink/80">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
                       strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3">
                    <path d="M12 20h9" />
                    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5Z" />
                  </svg>
                  正在修改历史消息，发送后将生成新版本，原对话保留
                </span>
                <button
                  type="button"
                  onClick={cancelEdit}
                  className="text-[11px] text-muted hover:text-ink px-1.5 py-0.5 rounded-md hover:bg-sand transition-colors"
                >
                  取消修改
                </button>
              </div>
            )}

            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder={editingIndex !== null ? "修改这句话后重新发送…" : attachments.length ? "给文件附上一句说明（可选）…" : "输入消息…"}
              className="w-full resize-none outline-none bg-transparent text-ink
                         placeholder:text-muted/70 text-base md:text-[15px] leading-relaxed py-1"
            />
            {/* 底部工具行：左下上传 + 联网搜索，右下发送 */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept={ACCEPT_TYPES}
                  className="hidden"
                  onChange={(e) => {
                    handleFiles(e.target.files);
                    e.target.value = ""; // 允许再次选择同一文件
                  }}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isStreaming}
                  title="上传图片 / 视频 / Word / PPT / Excel 等文件"
                  className="w-8 h-8 rounded-full border border-line bg-cream/60 text-muted
                             hover:text-ink hover:border-peach/60 hover:bg-peachsoft/60
                             transition-all duration-200 flex items-center justify-center
                             disabled:opacity-40 disabled:cursor-not-allowed active:scale-95"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                       strokeLinecap="round" className="w-4 h-4">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                </button>

                <button
                  type="button"
                  onClick={toggleSpeech}
                  disabled={isStreaming || !speech.supported || !speech.secure}
                  aria-pressed={speech.listening}
                  title={
                    !speech.supported
                      ? "当前浏览器不支持语音识别，请使用 Edge 或 Chrome（且需 localhost / HTTPS 环境）"
                      : speech.listening
                      ? "结束语音录入"
                      : "语音录入：说话转成文字（推荐 Edge 浏览器）"
                  }
                  className={`w-8 h-8 rounded-full border flex items-center justify-center
                              transition-all duration-200 active:scale-95
                              disabled:opacity-40 disabled:cursor-not-allowed
                    ${speech.listening
                      ? "bg-blush border-[#c98a92] text-ink shadow-soft"
                      : "border-line bg-cream/60 text-muted hover:text-ink hover:border-peach/60 hover:bg-peachsoft/60"}`}
                >
                  {speech.listening ? (
                    /* 聆听中：实心方块（点击结束） */
                    <svg viewBox="0 0 24 24" fill="currentColor" className="w-3 h-3">
                      <rect x="6" y="6" width="12" height="12" rx="2" />
                    </svg>
                  ) : (
                    /* 麦克风 */
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                         strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                      <rect x="9" y="2" width="6" height="12" rx="3" />
                      <path d="M5 10a7 7 0 0 0 14 0" />
                      <path d="M12 17v5" />
                    </svg>
                  )}
                </button>

                <button
                  type="button"
                  onClick={toggleWebSearch}
                  disabled={!webSearchAvailable || isStreaming}
                  aria-pressed={webSearch}
                  title={webSearchAvailable
                    ? "开启后，模型需要实时信息时会自动联网搜索"
                    : "当前服务商不支持联网搜索（仅 Kimi 支持）"}
                  className={`flex items-center gap-1.5 pl-2.5 pr-3 py-1.5 rounded-full border
                              text-xs font-medium transition-all duration-200 active:scale-[0.97]
                    ${!webSearchAvailable
                      ? "bg-cream/40 border-line/60 text-muted/40 cursor-not-allowed"
                      : webSearch
                      ? "bg-lilacsoft border-plum/70 text-ink shadow-soft"
                      : "bg-cream/60 border-line text-muted hover:text-ink hover:border-peach/60"}`}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
                       strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                    <circle cx="12" cy="12" r="9" />
                    <path d="M3 12h18" />
                    <path d="M12 3c2.6 2.5 3.9 5.6 3.9 9S14.6 18.5 12 21c-2.6-2.5-3.9-5.6-3.9-9S9.4 5.5 12 3Z" />
                  </svg>
                  联网搜索
                  <span className={`w-1.5 h-1.5 rounded-full transition-colors ${webSearch ? "bg-sagedeep" : "bg-muted/40"}`} />
                </button>

                <button
                  type="button"
                  onClick={() => setAgentMode((v) => !v)}
                  disabled={!agentAvailable || isStreaming}
                  aria-pressed={agentMode}
                  title={agentAvailable
                    ? "Agent 模式：模型自主拆解任务、连续调用工具完成多步操作（需启用自定义工具或联网搜索）"
                    : "需要在工作台启用至少一个自定义工具，或切换到支持联网搜索的服务商"}
                  className={`flex items-center gap-1.5 pl-2.5 pr-3 py-1.5 rounded-full border
                              text-xs font-medium transition-all duration-200 active:scale-[0.97]
                    ${!agentAvailable
                      ? "bg-cream/40 border-line/60 text-muted/40 cursor-not-allowed"
                      : agentMode
                      ? "bg-sage/70 border-sagedeep/70 text-ink shadow-soft"
                      : "bg-cream/60 border-line text-muted hover:text-ink hover:border-sagedeep/60"}`}
                >
                  {/* 四角星，寓意自主智能体 */}
                  <svg viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5">
                    <path d="M12 2.5c.35 0 .66.22.78.55l1.35 3.7c.68 1.87 2.1 3.29 3.97 3.97l3.7 1.35c.33.12.55.43.55.78s-.22.66-.55.78l-3.7 1.35c-1.87.68-3.29 2.1-3.97 3.97l-1.35 3.7a.84.84 0 0 1-1.56 0l-1.35-3.7c-.68-1.87-2.1-3.29-3.97-3.97l-3.7-1.35a.84.84 0 0 1 0-1.56l3.7-1.35c1.87-.68 3.29-2.1 3.97-3.97l1.35-3.7c.12-.33.43-.55.78-.55Z" />
                  </svg>
                  Agent
                  <span className={`w-1.5 h-1.5 rounded-full transition-colors ${agentMode ? "bg-sagedeep" : "bg-muted/40"}`} />
                </button>
              </div>

              {isStreaming ? (
                <button
                  onClick={onStop}
                  className="w-9 h-9 flex-shrink-0 rounded-xl bg-blush hover:bg-[#d4a8b4] text-ink
                             transition-all duration-200 flex items-center justify-center
                             shadow-soft hover:shadow-float active:scale-95 animate-fade-up"
                  title="停止生成"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5">
                    <rect x="6" y="6" width="12" height="12" rx="2" />
                  </svg>
                </button>
              ) : canContinue ? (
                <button
                  onClick={onContinue}
                  className="w-9 h-9 flex-shrink-0 rounded-xl bg-lilac hover:bg-plum text-ink
                             transition-all duration-200 flex items-center justify-center
                             shadow-soft hover:shadow-float active:scale-95 animate-fade-up"
                  title="继续生成"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                       strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px]">
                    <path d="M5 3l14 9-14 9V3z" />
                  </svg>
                </button>
              ) : (
                <button
                  onClick={() => handleSend()}
                  disabled={!input.trim() && !attachments.length}
                  className="w-9 h-9 flex-shrink-0 rounded-xl bg-peach hover:bg-peachdeep text-ink
                             transition-all duration-200 flex items-center justify-center
                             disabled:opacity-40 disabled:cursor-not-allowed
                             shadow-soft hover:shadow-float active:scale-95"
                  title="发送"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                       strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px]">
                    <path d="M22 2 11 13" />
                    <path d="M22 2 15 22l-4-9-9-4 20-7Z" />
                  </svg>
                </button>
              )}
            </div>
          </div>
          <p className="text-center text-[11px] text-muted/70 mt-2.5">
            内容仅保存在本机浏览器 · API Key 不会上传
          </p>
        </div>
      </div>
    </div>
  );
}
