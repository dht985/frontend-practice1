import { useState, useEffect, useRef } from "react";
import Sidebar from "./components/Sidebar";
import ChatArea from "./components/ChatArea";
import Settings from "./components/Settings";
import WorkbenchPanel from "./components/WorkbenchPanel";


import { loadToolLib, saveToolLib } from "./api/tools";
import { loadNativeToolSettings, saveNativeToolSettings, getEnabledNativeDecls } from "./api/nativeTools";
import { todoList, onTodosChange } from "./api/todos";
import TodoPanel from "./components/TodoPanel";
import useConversationStore from "./hooks/useConversationStore";
import useLiveStream from "./hooks/useLiveStream";
import useContextBudget from "./hooks/useContextBudget";
import useChatRunner from "./hooks/useChatRunner";

import { collectUserNodeIds, migrateConv, visibleChain } from "./state/conversationTree";
import { getProvider, getParamCaps } from "./api/providers";
import {
  ACTIVE_KEY,
  CONFIG_KEY,
  DEFAULT_WORKBENCH,
  PROMPTS_KEY,
  WORKBENCH_KEY,
  buildTimeMessage,
  configForStorage,
  loadConfig,
  loadJSON,
  safeSetItem,
  writeSessionKey,
} from "./state/configStore";
import { loadAllFullResults, deleteFullResult } from "./api/fullResultsStore";
import { collectToolStepIds } from "./api/toolSteps";

import { loadAllAttachments, deleteAttachments } from "./api/attachmentStore";



export default function App() {
  // 对话数据与树操作都收在 store hook 里：IndexedDB 加载/迁移/增量写回 + 会话增删改
  const {
    conversations,
    setConversations,
    createConversation,
    removeConversation,
    renameConversation,
    applyDefaultTitle,
    setConvTree,
    updateLastVisible,
  } = useConversationStore({ migrateConv });
  const [activeId, setActiveId] = useState(() => loadJSON(ACTIVE_KEY, null));

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false); // 移动端抽屉
  const [config, setConfig] = useState(loadConfig);
  const [workbench, setWorkbench] = useState(() => ({
    ...DEFAULT_WORKBENCH,
    ...loadJSON(WORKBENCH_KEY, {}),
  }));
  const [promptLib, setPromptLib] = useState(() => loadJSON(PROMPTS_KEY, []));
  const [toolLib, setToolLib] = useState(loadToolLib);
  const [nativeToolSettings, setNativeToolSettings] = useState(loadNativeToolSettings);
  const [workbenchOpen, setWorkbenchOpen] = useState(false);

  // 工具结果全文：callId → 完整结果字符串。只放内存不进 conversations，
  // 避免 20k 抓取正文撑大 localStorage；但单独持久化到 IndexedDB，刷新后异步加载回来。
  // fullResultsVersion 仅用于 mount 加载完后触发一次 re-render（React 不会因 ref 变化重渲染）
  const fullResultsRef = useRef(new Map());
  const [fullResultsVersion, setFullResultsVersion] = useState(0);

  const [todoPanelOpen, setTodoPanelOpen] = useState(false);
  const [todoBadge, setTodoBadge] = useState(0); // 侧边栏待办入口的未完成角标
  const [storageError, setStorageError] = useState(null); // localStorage 配额等

  // 附件内容（多模态 parts / 文档抽取文本）：按 user 节点 id 保存，
  // 树里只留元信息；重试、换回答、后续轮次都从这里取回原始附件。
  const attachmentsRef = useRef(new Map());
  // 流式输出文本：独立于对话树，token 只写这里，树在开始 / 工具步骤 / 结束时才写回，
  // 避免每个 token 深拷贝整棵树并触发全量重渲染。
  // reasoning 是思考过程（Kimi K3 / reasoner），与正文分开累积，供「思考中」折叠块实时展示。
  const { liveStream, beginLiveStream, appendLiveStream, appendLiveReasoning, endLiveStream } =
    useLiveStream();

  // 待办角标：初始读一次，之后任何来源（模型工具写入/面板操作/其他标签页）变更都实时刷新
  useEffect(() => {
    const refresh = () => setTodoBadge(todoList().todos.filter((t) => !t.completed).length);
    refresh();
    return onTodosChange(refresh);
  }, []);

  // mount 时一次性从 IndexedDB 加载全部工具结果全文到内存 Map
  // fullResultsRef.current 是引用类型，直接 set 不会触发渲染，故额外 bump version
  // 加载失败（隐私模式/IndexedDB 不可用）时 store 内部已静默降级为空 Map，这里无需 try/catch
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const map = await loadAllFullResults();
      if (cancelled) return;
      // 合并而非覆盖：mount 期间若已通过 toolStepHandler 写入新条目，避免被覆盖
      for (const [k, v] of map) {
        if (!fullResultsRef.current.has(k)) fullResultsRef.current.set(k, v);
      }
      setFullResultsVersion((v) => v + 1);
    })();
    return () => { cancelled = true; };
  }, []);

  // mount 时加载已持久化的附件内容（多模态 parts / 文档抽取文本），
  // 让刷新页面后的重试与后续轮次同样能带上原始附件
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const map = await loadAllAttachments();
      if (cancelled) return;
      for (const [k, v] of map) {
        if (!attachmentsRef.current.has(k)) attachmentsRef.current.set(k, v);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // 对话持久化在 store hook 里完成（见 hooks/useConversationStore），这里不用再手动落盘

  // 记住上次打开的对话；若该对话已不存在则回退为空
  useEffect(() => {
    const valid = conversations.some((c) => c.id === activeId);
    const next = valid ? activeId : null;
    if (next !== activeId) setActiveId(next);
    safeSetItem(ACTIVE_KEY, JSON.stringify(next));
  }, [activeId, conversations]);

  useEffect(() => {
    // 会话级 Key 单独写入 sessionStorage；localStorage 里对应字段为空
    for (const p of config.profiles) {
      if (p.persistKey === false) writeSessionKey(p.id, p.apiKey);
      else writeSessionKey(p.id, ""); // 改为持久化时清掉会话副本
    }
    if (!safeSetItem(CONFIG_KEY, JSON.stringify(configForStorage(config)))) {
      setStorageError("本地存储已满，服务商配置可能无法保存。");
    }
  }, [config]);

  // 工作台配置 / 提示词模板（低频写入，直接持久化即可）
  useEffect(() => {
    safeSetItem(WORKBENCH_KEY, JSON.stringify(workbench));
  }, [workbench]);
  useEffect(() => {
    safeSetItem(PROMPTS_KEY, JSON.stringify(promptLib));
  }, [promptLib]);
  // 自定义工具库（低频写入，直接持久化）
  useEffect(() => {
    saveToolLib(toolLib);
  }, [toolLib]);

  const handleNew = () => {
    const id = createConversation();
    setActiveId(id);
    return id;
  };

  const handleDelete = (id) => {
    // 联动清理该对话所有分支（不只当前可见路径）上工具结果全文，
    // 避免删除对话后 20k 正文长期残留在内存 Map 与 IndexedDB 中
    const conv = conversations.find((c) => c.id === id);
    if (conv?.tree) {
      for (const callId of collectToolStepIds(conv.tree)) {
        fullResultsRef.current.delete(callId);
        deleteFullResult(callId);
      }
      // 附件内容同样按分支联动清理，避免长期占用 IndexedDB
      for (const nodeId of collectUserNodeIds(conv.tree)) {
        attachmentsRef.current.delete(nodeId);
        deleteAttachments(nodeId);
      }
    }
    removeConversation(id);
    if (activeId === id) setActiveId(null);
  };

  // —— 服务商档案管理 ——
  const activeConfig =
    config.profiles.find((p) => p.id === config.activeId) || config.profiles[0];
  const activeCaps = getProvider(activeConfig.provider).caps;

  // 工作台：从配置派生实际发给 API 的参数（停止序列支持换行/逗号分隔）
  const buildGenParams = () => ({
    temperature: workbench.temperature,
    topP: workbench.topP,
    maxTokens: workbench.maxTokens || 0,
    stop: workbench.stop.split(/[\n,，]/).map((s) => s.trim()).filter(Boolean),
  });
  // 自定义 system 排在时间消息之前
  const customSystemMessages = () =>
    workbench.systemPrompt.trim()
      ? [{ role: "system", content: workbench.systemPrompt.trim() }]
      : [];

  // 提示词模板：增/删
  const addPromptTemplate = (tpl) => {
    const item = { id: uid(), name: (tpl.name || "未命名模板").slice(0, 20), content: tpl.content || "" };
    setPromptLib((prev) => [...prev, item]);
    return item;
  };
  const deletePromptTemplate = (id) => {
    setPromptLib((prev) => prev.filter((t) => t.id !== id));
  };

  // 自定义工具：新增（source 传入时为复制）/ 更新 / 删除（内置项不可删）
  const addTool = (source) => {
    const item = {
      id: uid(),
      name: source ? `${source.name}_copy` : "new_tool",
      description: source?.description || "",
      parameters: source?.parameters || '{"type":"object","properties":{}}',
      code: source?.code || 'return "hello";',
      enabled: true,
      confirm: source?.confirm || false, // 调用前是否需要人工确认
      builtin: false,
    };
    setToolLib((prev) => [...prev, item]);
    return item;
  };
  const updateTool = (id, patch) =>
    setToolLib((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  const deleteTool = (id) => {
    setToolLib((prev) => prev.filter((t) => t.id !== id));
  };

  // 新增或更新一个档案，并切换为当前使用
  const upsertProfile = (profile) => {
    setConfig((prev) => {
      const exists = prev.profiles.some((p) => p.id === profile.id);
      const profiles = exists
        ? prev.profiles.map((p) => (p.id === profile.id ? profile : p))
        : [...prev.profiles, profile];
      return { profiles, activeId: profile.id };
    });
  };

  // 仅切换当前使用的档案（不关闭编辑态）
  const activateProfile = (id) => {
    setConfig((prev) =>
      prev.profiles.some((p) => p.id === id) ? { ...prev, activeId: id } : prev
    );
  };

  const deleteProfile = (id) => {
    setConfig((prev) => {
      if (prev.profiles.length <= 1) return prev; // 至少保留一个
      const profiles = prev.profiles.filter((p) => p.id !== id);
      const activeId = prev.activeId === id ? profiles[0].id : prev.activeId;
      return { profiles, activeId };
    });
  };

  const activeConv = conversations.find((c) => c.id === activeId) || null;
  // 当前可见路径（含 parent 引用，供版本切换）与扁平节点视图
  const visibleEntries = activeConv?.tree ? visibleChain(activeConv.tree) : [];
  const messages = visibleEntries.map((e) => e.node);





  // 上下文预算：超预算时按整轮裁剪，并把裁剪情况写到 trimNotice 供界面提示
  const { planHistory, trimNotice } = useContextBudget({ workbench, attachmentsRef });

  // 请求编排（工具步骤 / 确认 / 流式回调 / 发送 / 停止 / 继续 / 重试）都在这个 hook 里
  const {
    isStreaming,
    pendingConfirms,
    handleSend,
    handleStop,
    handleContinue,
    handleRetry,
    handleRegenerate,
    retryToolStep,
    respondToolConfirm,
  } = useChatRunner({
    conversations,
    setConvTree,
    updateLastVisible,
    applyDefaultTitle,
    activeId,
    activeConv,
    handleNew,
    activeConfig,
    activeCaps,
    workbench,
    customSystemMessages,
    buildGenParams,
    buildTimeMessage,
    toolLib,
    nativeToolSettings,
    attachmentsRef,
    fullResultsRef,
    planHistory,
    beginLiveStream,
    appendLiveStream,
    appendLiveReasoning,
    endLiveStream,
  });

  // 版本切换：dir 为 -1（上一版）/ 1（下一版）；parentId = 用户消息节点的父节点 id
  const switchVersion = (parentId, dir) => {
    if (!activeId) return;
    setConvTree(activeId, (tree) => {
      const shift = (node) => {
        if (node.id === parentId) {
          const next = node.active + dir;
          if (next >= 0 && next < node.children.length) node.active = next;
          return true;
        }
        return node.children.some(shift);
      };
      shift(tree);
    });
  };


  // 对话重命名
  const handleRename = (id, title) => {
    const t = (title || "").trim();
    if (!t) return;
    renameConversation(id, t);
  };

  // 导出当前可见对话为 Markdown 文件
  const handleExport = () => {
    if (!activeConv || !activeConv.tree) return;
    const chain = visibleChain(activeConv.tree);
    if (!chain.length) return;
    const lines = [`# ${activeConv.title || "对话记录"}`, ""];
    for (const { node } of chain) {
      if (node.role === "user") {
        lines.push(`**我：**`, "");
        if (node.content) lines.push(node.content, "");
        if (node.attachments?.length) {
          lines.push(`> 附件：${node.attachments.map((a) => a.name).join("、")}`, "");
        }
      } else if (node.role === "assistant" && node.content) {
        lines.push(`**AI：**`, "", node.content, "");
      }
    }
    const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(activeConv.title || "对话记录").replace(/[\\/:*?"<>|]/g, "").slice(0, 30) || "对话记录"}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <Sidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        conversations={conversations}
        activeId={activeId}
        onSelect={(id) => { setActiveId(id); setSidebarOpen(false); }}
        onNew={() => { handleNew(); setSidebarOpen(false); }}
        onDelete={handleDelete}
        onRename={handleRename}
        onOpenSettings={() => { setSettingsOpen(true); setSidebarOpen(false); }}
        onOpenTodos={() => { setTodoPanelOpen(true); setSidebarOpen(false); }}
        todoBadge={todoBadge}
      />
      <ChatArea
        messages={messages}
        entries={visibleEntries}
        liveStream={liveStream}
        trimNotice={trimNotice && trimNotice.convId === activeId ? trimNotice : null}
        onSwitchVersion={switchVersion}
        isStreaming={isStreaming}
        model={`${getProvider(activeConfig.provider).name} · ${activeConfig.model || "未设置模型"}`}
        webSearchAvailable={activeCaps.webSearch}
        agentAvailable={getEnabledNativeDecls(nativeToolSettings).length > 0 || toolLib.some((t) => t.enabled) || activeCaps.webSearch}
        onSend={handleSend}
        onStop={handleStop}
        onContinue={handleContinue}
        canContinue={!isStreaming && messages.length > 0 && messages[messages.length - 1]?.role === "assistant" && messages[messages.length - 1]?.stopped}
        onRetry={handleRetry}
        onRegenerate={handleRegenerate}
        onExport={handleExport}
        onOpenWorkbench={() => setWorkbenchOpen(true)}
        onOpenSidebar={() => setSidebarOpen(true)}
        profiles={config.profiles.map((p) => ({
          id: p.id,
          provider: p.provider,
          providerName: getProvider(p.provider).name,
          model: p.model,
        }))}
        activeProfileId={config.activeId}
        onSwitchProfile={activateProfile}
        pendingConfirms={pendingConfirms}
        onRespondToolConfirm={respondToolConfirm}
        onRetryTool={retryToolStep}
        fullResultsMap={fullResultsRef.current}
        // fullResultsVersion 仅用于在 mount 加载完后触发 App 重新渲染，
        // 让子组件（ChatArea→MessageBubble→ResultDisplay）顺带重读 Map 内的最新全文
        fullResultsVersion={fullResultsVersion}
      />
      <Settings
        open={settingsOpen}
        config={config}
        onUpsert={upsertProfile}
        onActivate={activateProfile}
        onDelete={deleteProfile}
        onClose={() => setSettingsOpen(false)}
      />
      <TodoPanel open={todoPanelOpen} onClose={() => setTodoPanelOpen(false)} />
      <WorkbenchPanel
        open={workbenchOpen}
        onClose={() => setWorkbenchOpen(false)}
        workbench={workbench}
        onChange={setWorkbench}
        paramCaps={getParamCaps(activeConfig.provider, activeConfig.model)}
        responseFormat={activeCaps.responseFormat}
        modelLabel={`${getProvider(activeConfig.provider).name} · ${activeConfig.model || "未设置模型"}`}
        baseURL={activeConfig.baseURL}
        promptLib={promptLib}
        onAddTemplate={addPromptTemplate}
        onDeleteTemplate={deletePromptTemplate}
        toolLib={toolLib}
        onAddTool={addTool}
        onUpdateTool={updateTool}
        onDeleteTool={deleteTool}
        nativeToolSettings={nativeToolSettings}
        onToggleNativeTool={(name, enabled) => {
          const next = { ...nativeToolSettings, [name]: enabled };
          setNativeToolSettings(next);
          saveNativeToolSettings(next);
        }}
      />
      {storageError && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-2.5 rounded-xl bg-ink/90 text-cream text-sm shadow-float max-w-[90vw]">
          <span>{storageError}</span>
          <button
            onClick={() => setStorageError(null)}
            className="text-cream/70 hover:text-cream shrink-0"
            title="关闭"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                 strokeLinecap="round" className="w-4 h-4">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}
