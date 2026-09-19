import { useState, useEffect, useRef } from "react";
import Sidebar from "./components/Sidebar";
import ChatArea from "./components/ChatArea";
import Settings from "./components/Settings";
import WorkbenchPanel from "./components/WorkbenchPanel";
import { streamChat, runFiber } from "./api/chat";
import { prepareAttachments, kindOf, formatSize } from "./api/files";
import { loadToolLib, saveToolLib, runLocalTool } from "./api/tools";
import { isNativeTool, runNativeTool, loadNativeToolSettings, saveNativeToolSettings, getEnabledNativeDecls } from "./api/nativeTools";
import { todoList, onTodosChange } from "./api/todos";
import TodoPanel from "./components/TodoPanel";
import { PROVIDERS, getProvider, detectProvider, newProfileId, getParamCaps } from "./api/providers";
import {
  loadAllFullResults,
  saveFullResult,
  deleteFullResult,
} from "./api/fullResultsStore";
import {
  finalizeToolSteps,
  failToolSteps,
  consumeStopFlag,
  collectToolStepIds,
} from "./api/toolSteps";

import { loadAllAttachments, saveAttachments, deleteAttachments } from "./api/attachmentStore";
import {
  buildHistoryMessages,
  attachmentSystemMessages,
  skippedFileMessages,
  userContentWithAttachments,
  DEFAULT_ATTACHMENT_PROMPT,
} from "./api/history";

const STORAGE_KEY = "morandi-chat-conversations";
const CONFIG_KEY = "morandi-chat-config";
const ACTIVE_KEY = "morandi-chat-active";
const WORKBENCH_KEY = "morandi-chat-workbench";
const PROMPTS_KEY = "morandi-chat-prompts";
// 选择「仅本次会话保存 Key」时，apiKey 只放 sessionStorage，不进 localStorage
const SESSION_KEYS_KEY = "morandi-chat-session-keys";

function loadSessionKeys() {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEYS_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function writeSessionKey(profileId, apiKey) {
  const all = loadSessionKeys();
  if (apiKey) all[profileId] = apiKey;
  else delete all[profileId];
  sessionStorage.setItem(SESSION_KEYS_KEY, JSON.stringify(all));
}

/** localStorage 写入；配额满时返回 false，其它错误仍抛出 */
function safeSetItem(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (err) {
    const quota =
      err?.name === "QuotaExceededError" ||
      err?.code === 22 ||
      err?.code === 1014;
    if (quota) return false;
    throw err;
  }
}

/** 持久化用的配置：会话级 Key 写成空串，避免明文落盘 */
function configForStorage(config) {
  return {
    ...config,
    profiles: config.profiles.map((p) =>
      p.persistKey === false ? { ...p, apiKey: "" } : p
    ),
  };
}

// 工作台默认配置：temperature 0.7 为多数模型的常用值；maxTokens 0 = 不限
const DEFAULT_WORKBENCH = {
  systemPrompt: "",
  temperature: 0.7,
  topP: 1,
  maxTokens: 0,
  stop: "",
  structured: false, // 结构化输出（JSON Mode），需服务商支持 response_format
  schemaText: "",    // 可选：期望的 JSON 结构说明 / JSON Schema
};

// 旧版默认模型已下线：读取本地保存的配置时自动迁移到 kimi-k3
const LEGACY_MODELS = ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"];

// 配置结构：{ profiles: [{id, provider, baseURL, apiKey, model, persistKey}], activeId }
function loadConfig() {
  const stored = loadJSON(CONFIG_KEY, null);
  const sessionKeys = loadSessionKeys();

  // 已是多档案结构
  if (stored && Array.isArray(stored.profiles) && stored.profiles.length) {
    const profiles = stored.profiles.map((p) => {
      const persistKey = p.persistKey !== false;
      const id = p.id || newProfileId();
      return {
        id,
        provider: p.provider || detectProvider(p.baseURL),
        baseURL: p.baseURL || "",
        // 会话级 Key：优先读 sessionStorage；持久化 Key：读 localStorage
        apiKey: persistKey ? p.apiKey || "" : sessionKeys[id] || "",
        model: LEGACY_MODELS.includes(p.model) ? "kimi-k3" : p.model || "",
        persistKey,
      };
    });
    const activeId = profiles.some((p) => p.id === stored.activeId) ? stored.activeId : profiles[0].id;
    return { profiles, activeId };
  }

  // 旧版单配置 → 迁移为一个档案
  const legacy = stored || {};
  const provider = detectProvider(legacy.baseURL || PROVIDERS.kimi.baseURL);
  let model = legacy.model || PROVIDERS[provider].model;
  if (LEGACY_MODELS.includes(model)) model = "kimi-k3";
  const profile = {
    id: newProfileId(),
    provider,
    baseURL: legacy.baseURL || PROVIDERS[provider].baseURL,
    apiKey: legacy.apiKey || "",
    model,
    persistKey: true,
  };
  return { profiles: [profile], activeId: profile.id };
}

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

// 构造设备当前日期/时间上下文（本地时区），供模型准确理解"今天/现在"等相对时间
function buildTimeMessage() {
  const now = new Date();
  const weekdays = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
  const pad = (n) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  let timezone = "未知时区";
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || String(-now.getTimezoneOffset() / 60);
  } catch {
    timezone = `UTC${-now.getTimezoneOffset() / 60 >= 0 ? "+" : ""}${-now.getTimezoneOffset() / 60}`;
  }
  return {
    role: "system",
    content: `用户设备当前的本地时间信息（请以此为准回答涉及日期、星期、时间的问题）：${date} ${weekdays[now.getDay()]}，当前时间 ${time}，时区 ${timezone}。`,
  };
}

// —— 对话树：支持同一条用户消息的多版本分支（像 DeepSeek 那样 < y/x > 切换）——
// 节点：{ id, role, content, children: [...], active: 0, ...UI字段 }
// conversation.tree 为虚拟根节点（role: "root"，仅承载 children/active）
const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const makeNode = (role, content, extra = {}) => ({
  id: uid(),
  role,
  content,
  children: [],
  active: 0,
  ...extra,
});

const makeRoot = () => ({ id: uid(), role: "root", content: "", children: [], active: 0 });

// 沿 active 指针走出的当前可见路径，返回 [{ node, parent, index }]（parent 含虚拟根）
function visibleChain(tree) {
  const chain = [];
  if (!tree || !tree.children.length) return chain;
  let parent = tree;
  let idx = Math.min(Math.max(tree.active, 0), tree.children.length - 1);
  for (;;) {
    const node = parent.children[idx];
    chain.push({ node, parent, index: idx });
    if (!node.children.length) break;
    parent = node;
    idx = Math.min(Math.max(node.active, 0), node.children.length - 1);
  }
  return chain;
}

// 收集树上所有 user 节点的 id（删除对话时联动清理附件内容）
function collectUserNodeIds(tree) {
  const ids = [];
  const walk = (node) => {
    if (!node) return;
    if (node.role === "user") ids.push(node.id);
    for (const child of node.children || []) walk(child);
  };
  walk(tree);
  return ids;
}

// 旧版扁平 messages → 树结构（一次性迁移）
function migrateConv(c) {
  if (c.tree) return c;
  const root = makeRoot();
  let parent = root;
  for (const m of c.messages || []) {
    const node = makeNode(m.role, m.content);
    if (m.attachments) node.attachments = m.attachments;
    parent.children.push(node);
    parent = node;
  }
  const out = { ...c, tree: root };
  delete out.messages;
  return out;
}

export default function App() {
  const [conversations, setConversations] = useState(() => loadJSON(STORAGE_KEY, []).map(migrateConv));
  const [activeId, setActiveId] = useState(() => loadJSON(ACTIVE_KEY, null));
  const [isStreaming, setIsStreaming] = useState(false);
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
  const abortRef = useRef(null); // 当前请求的 AbortController
  const userStoppedRef = useRef(false); // 标记是否用户手动停止（避免 onDone 覆盖 stopped 标记）
  // 危险工具人工确认：callId → resolve 函数（不放 state，避免 Promise 被反复序列化）
  const confirmResolversRef = useRef(new Map());
  // 工具结果全文：callId → 完整结果字符串。只放内存不进 conversations，
  // 避免 20k 抓取正文撑大 localStorage；但单独持久化到 IndexedDB，刷新后异步加载回来。
  // fullResultsVersion 仅用于 mount 加载完后触发一次 re-render（React 不会因 ref 变化重渲染）
  const fullResultsRef = useRef(new Map());
  const [fullResultsVersion, setFullResultsVersion] = useState(0);
  // 仅把展示需要的信息放 state（callId → {name, args}），触发气泡渲染确认按钮
  const [pendingConfirms, setPendingConfirms] = useState({});
  const [todoPanelOpen, setTodoPanelOpen] = useState(false);
  const [todoBadge, setTodoBadge] = useState(0); // 侧边栏待办入口的未完成角标
  const [storageError, setStorageError] = useState(null); // localStorage 配额等
  // 附件内容（多模态 parts / 文档抽取文本）：按 user 节点 id 保存，
  // 树里只留元信息；重试、换回答、后续轮次都从这里取回原始附件。
  const attachmentsRef = useRef(new Map());
  // 流式输出文本：独立于对话树，token 只写这里，树在开始 / 工具步骤 / 结束时才写回，
  // 避免每个 token 深拷贝整棵树并触发全量重渲染。
  // reasoning 是思考过程（Kimi K3 / reasoner），与正文分开累积，供「思考中」折叠块实时展示。
  const liveRef = useRef(null); // { convId, nodeId, text, reasoning }
  const liveTimerRef = useRef(0);
  const [liveStream, setLiveStream] = useState(null); // 渲染用快照

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

  // 对话持久化：流式期间每个 token 都全量序列化+写盘会越来越卡，改为 400ms 防抖；
  // 页面关闭/切后台时立即落盘，避免丢尾部更新
  const convRef = useRef(conversations);
  convRef.current = conversations;
  const persistConversations = (data) => {
    if (!safeSetItem(STORAGE_KEY, JSON.stringify(data))) {
      setStorageError("本地存储已满，对话可能无法保存。请删除旧对话或导出后清理。");
    } else {
      setStorageError(null);
    }
  };
  useEffect(() => {
    const t = setTimeout(() => persistConversations(convRef.current), 400);
    return () => clearTimeout(t);
  }, [conversations]);
  useEffect(() => {
    const flush = () => safeSetItem(STORAGE_KEY, JSON.stringify(convRef.current));
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      document.removeEventListener("visibilitychange", flush);
    };
  }, []);

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
    const id = Date.now().toString();
    setConversations((prev) => [{ id, title: "新对话", tree: makeRoot() }, ...prev]);
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
    setConversations((prev) => prev.filter((c) => c.id !== id));
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

  // —— 流式文本缓冲：token 级更新只改这一份 state，完全不碰对话树 ——
  const flushLive = () => setLiveStream(liveRef.current ? { ...liveRef.current } : null);

  // 开始一次流式输出（baseText 用于「继续生成」时接在已有内容之后）
  const beginLiveStream = (convId, nodeId, baseText = "") => {
    liveRef.current = { convId, nodeId, text: baseText, reasoning: "" };
    flushLive();
  };

  // 追加 token：60ms 合并一次渲染，把渲染次数从每 token 降到每秒十几次
  const appendLiveStream = (chunk) => {
    if (!liveRef.current) return;
    liveRef.current.text += chunk;
    if (liveTimerRef.current) return;
    liveTimerRef.current = setTimeout(() => {
      liveTimerRef.current = 0;
      flushLive();
    }, 60);
  };

  // 追加思考过程 token：与正文共用同一节流定时器
  const appendLiveReasoning = (chunk) => {
    if (!liveRef.current) return;
    liveRef.current.reasoning += chunk;
    if (liveTimerRef.current) return;
    liveTimerRef.current = setTimeout(() => {
      liveTimerRef.current = 0;
      flushLive();
    }, 60);
  };

  // 结束流式并取回最终文本与思考过程（正常结束、停止、出错都要调用）
  const endLiveStream = () => {
    if (liveTimerRef.current) {
      clearTimeout(liveTimerRef.current);
      liveTimerRef.current = 0;
    }
    const snapshot = liveRef.current;
    const text = snapshot?.text ?? "";
    const reasoning = snapshot?.reasoning ?? "";
    liveRef.current = null;
    flushLive();
    return { text, reasoning };
  };

  // 树更新：克隆当前树 → 在 updater 中原地修改 → 写回
  const setConvTree = (convId, updater) => {
    setConversations((prev) =>
      prev.map((c) => {
        if (c.id !== convId) return c;
        const tree = structuredClone(c.tree || makeRoot());
        updater(tree);
        return { ...c, tree };
      })
    );
  };

  // 更新当前可见路径的最后一个节点（流式输出中的所有回调整它）
  const updateLastVisible = (convId, updater) => {
    setConvTree(convId, (tree) => {
      const chain = visibleChain(tree);
      if (chain.length) updater(chain[chain.length - 1].node);
    });
  };

  // 工具执行步骤回调（发送 / 继续共用）：start 追加 running 步骤，result 回填状态
  const toolStepHandler = (convId) => (step) => {
    updateLastVisible(convId, (node) => {
      if (!Array.isArray(node.toolSteps)) node.toolSteps = [];
      if (step.type === "start") {
        // 同一 callId 复用原行（手动重试时状态回退为执行中）
        const existing = node.toolSteps.find((x) => x.id === step.callId);
        if (existing) {
          existing.status = step.needsConfirm ? "awaiting" : "running";
          existing.result = "";
          existing.retry = 0;
        } else {
          node.toolSteps.push({
            id: step.callId, name: step.name, source: step.source,
            args: step.args, argsRaw: step.argsRaw,
            status: step.needsConfirm ? "awaiting" : "running",
            retry: 0, maxRetry: step.maxRetries || 0,
          });
        }
      } else if (step.type === "retrying") {
        const s = node.toolSteps.find((x) => x.id === step.callId);
        if (s) {
          s.status = "retrying";
          s.retry = step.attempt;
          s.maxRetry = step.maxRetries;
          s.result = "";
        }
      } else if (step.type === "approved") {
        const s = node.toolSteps.find((x) => x.id === step.callId);
        if (s) s.status = "running";
      } else {
        const s = node.toolSteps.find((x) => x.id === step.callId);
        if (s) {
          s.status = step.rejected ? "rejected" : step.error ? "error" : "done";
          s.result = step.result;
          s.retry = step.attempt ? step.attempt - 1 : s.retry; // 已完成的重试次数
          s.maxRetry = step.maxRetries || s.maxRetry;
          s.canRetry = !!step.error; // 失败步骤允许手动重新尝试
          if (typeof step.full === "string" && step.full.length > s.result.length) {
            fullResultsRef.current.set(step.callId, step.full);
            // 同步持久化到 IndexedDB，刷新后仍可展开全文
            saveFullResult(step.callId, step.full);
          }
        }
      }
    });
  };

  // 手动重新尝试某个失败的工具步骤：复用原工具与参数；成功后把新结果回灌模型，自动在同一条回复上继续生成
  const retryToolStep = async (callId) => {
    const conv = conversations.find((c) => c.id === activeId);
    if (!conv || isStreaming) return;
    const chain = visibleChain(conv.tree);
    const node = chain[chain.length - 1]?.node;
    const step = node?.toolSteps?.find((s) => s.id === callId);
    if (!step) return;
    // 先把该行状态切回执行中
    updateLastVisible(conv.id, (n) => {
      const s = n.toolSteps?.find((x) => x.id === callId);
      if (s) { s.status = "running"; s.result = ""; s.canRetry = false; }
    });
    try {
      let resultStr = "";
      let isError = false;
      let sources = [];
      if (step.source === "web") {
        const { result, sources: src } = await runFiber(activeConfig, step.name, step.argsRaw || "{}");
        resultStr = result;
        sources = src || [];
      } else if (isNativeTool(step.name)) {
        // 预置内置工具（fetch_url/todo_list），手动重试即用户显式确认，不再弹写操作确认框
        const res = await runNativeTool(step.name, step.argsRaw || "{}");
        resultStr = res.content;
        isError = res.isError;
      } else {
        const tool = toolLib.find((t) => t.name === step.name);
        if (!tool) throw new Error("工具不存在或已被删除");
        const res = await runLocalTool(tool, step.argsRaw || "{}");
        resultStr = res.content;
        isError = res.isError;
      }
      updateLastVisible(conv.id, (n) => {
        const s = n.toolSteps?.find((x) => x.id === callId);
        if (s) {
          s.status = isError ? "error" : "done";
          s.result = String(resultStr).slice(0, 120);
          s.canRetry = isError;
        }
      });
      if (String(resultStr).length > 120) {
        fullResultsRef.current.set(callId, String(resultStr));
        // 同步持久化到 IndexedDB，刷新后仍可展开全文
        saveFullResult(callId, String(resultStr));
      } else {
        fullResultsRef.current.delete(callId);
        // 结果变短就清掉旧全文，避免显示陈旧数据
        deleteFullResult(callId);
      }
      if (sources.length) {
        updateLastVisible(conv.id, (n) => {
          const map = new Map((n.sources || []).map((x) => [x.url, x]));
          sources.forEach((x) => map.set(x.url, x));
          n.sources = Array.from(map.values());
        });
      }
      // 成功：把新工具结果回灌模型，在同一条 assistant 气泡上继续生成
      if (!isError) {
        await continueAfterToolRetry(conv.id, step.name, String(resultStr));
      }
    } catch (err) {
      if (err?.name === "AbortError") return;
      updateLastVisible(conv.id, (n) => {
        const s = n.toolSteps?.find((x) => x.id === callId);
        if (s) {
          s.status = "error";
          s.result = String(err?.message || err).slice(0, 120);
          s.canRetry = true;
        }
      });
    }
  };

  // 工具手动重试成功后：用 system 注入最新结果，让模型基于新结果在同一条 assistant 气泡上续写/修正。
  // 不同于「换一个回答」挂新版本，这里是接续现有回答（旧内容保留、新 token 追加）。
  const continueAfterToolRetry = async (convId, toolName, resultStr) => {
    if (isStreaming) return;
    const conv = conversations.find((c) => c.id === convId);
    if (!conv?.tree || !activeConfig.apiKey) return;

    const chain = visibleChain(conv.tree);
    const last = chain[chain.length - 1]?.node;
    if (!last || last.role !== "assistant") return;

    updateLastVisible(convId, (node) => {
      node.streaming = true;
      node.stopped = false;
      node.hint = "正在根据新的工具结果继续…";
    });
    setIsStreaming(true);
    // 已有内容作为基线，新 token 接在后面
    beginLiveStream(convId, last.id, String(last.content || ""));

    const controller = new AbortController();
    abortRef.current = controller;
    userStoppedRef.current = false;

    // 历史 = 已有对话（含已生成的不完整 AI 回答），让模型接着续写；带附件
    const history = buildHistoryMessages(
      chain
        .map((e) => e.node)
        .filter(
          (m) =>
            (m.role === "user" || m.role === "assistant") &&
            m.content &&
            !String(m.content).startsWith("⚠️")
        ),
      attachmentsRef.current
    );

    const boost = {
      role: "system",
      content:
        `用户手动重新执行了工具「${toolName}」，最新结果如下。请基于此结果继续或修正回答，不要编造工具返回内容。\n\n` +
        String(resultStr).slice(0, 12000),
    };

    await streamChat({
      messages: history,
      systemMessages: [
        ...customSystemMessages(),
        buildTimeMessage(),
        boost,
        ...attachmentSystemMessages(chain.map((e) => e.node), attachmentsRef.current),
      ],
      config: activeConfig,
      webSearch: false,
      customTools: toolLib.filter((t) => t.enabled),
      nativeToolSettings,
      structured: workbench.structured,
      schemaText: workbench.schemaText,
      genParams: buildGenParams(),
      signal: controller.signal,
      ...makeStreamCallbacks(convId, { clearStatus: false, appendTextOnError: true }),
    });
  };

  // 危险工具确认：chat.js 在调用前 await 这个 Promise，直到用户点允许/拒绝
  const toolConfirmHandler = (callId, name, argsJson) =>
    new Promise((resolve) => {
      confirmResolversRef.current.set(callId, resolve);
      setPendingConfirms((prev) => ({ ...prev, [callId]: { name, args: String(argsJson || "").slice(0, 120) } }));
    });

  // 用户响应确认（ok=true 允许执行）
  const respondToolConfirm = (callId, ok) => {
    const resolve = confirmResolversRef.current.get(callId);
    if (resolve) {
      resolve(ok);
      confirmResolversRef.current.delete(callId);
    }
    setPendingConfirms((prev) => {
      if (!prev[callId]) return prev;
      const next = { ...prev };
      delete next[callId];
      return next;
    });
  };

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

  // 组装一次 streamChat 的标准回调（onChunk/onReasoning/onToolStep/onToolConfirm/onDone/onError）。
  // 发送 / 继续生成 / 工具重试回灌 三类请求共用，差异通过 opts 注入，避免四份样板复制后各自漂移。
  const makeStreamCallbacks = (convId, opts = {}) => {
    const { onStatus, onSources, onDoneExtra, clearStatus = true, appendTextOnError = false } = opts;
    let statusCleared = false;
    return {
      onChunk: (chunk) => {
        appendLiveStream(chunk);
        if (clearStatus && !statusCleared) {
          statusCleared = true;
          updateLastVisible(convId, (node) => {
            node.searching = false;
            node.hint = "";
          });
        }
      },
      onReasoning: appendLiveReasoning,
      onStatus,
      onSources,
      onToolStep: toolStepHandler(convId),
      onToolConfirm: toolConfirmHandler,
      onDone: (usage) => {
        const stopped = consumeStopFlag(userStoppedRef);
        const { text, reasoning } = endLiveStream();
        updateLastVisible(convId, (node) => {
          onDoneExtra && onDoneExtra(node, text);
          node.content = text;
          if (reasoning) node.reasoning = reasoning;
          node.streaming = false;
          node.searching = false;
          node.hint = "";
          node.stopped = stopped;
          finalizeToolSteps(node.toolSteps, stopped);
          if (usage) node.usage = usage;
        });
        setIsStreaming(false);
        abortRef.current = null;
      },
      onError: (err) => {
        consumeStopFlag(userStoppedRef);
        const { text, reasoning } = endLiveStream();
        updateLastVisible(convId, (node) => {
          node.content = appendTextOnError && text ? `${text}\n\n⚠️ ${err.message}` : `⚠️ ${err.message}`;
          if (reasoning) node.reasoning = reasoning;
          node.streaming = false;
          node.stopped = false;
          node.hint = "";
          failToolSteps(node.toolSteps);
        });
        setIsStreaming(false);
        abortRef.current = null;
      },
    };
  };

  const handleSend = async (text, options = {}) => {
    const { webSearch = false, agentMode = false, files = [], retry = false, regenerate = false, editIndex = -1 } = options;
    if (!activeConfig.apiKey) {
      setSettingsOpen(true);
      return;
    }
    const useWebSearch = webSearch && activeCaps.webSearch;
    const enabledTools = toolLib.filter((t) => t.enabled);
    // Agent 模式：预置内置工具（fetch_url/todo_list）始终可用，其余为自定义工具或联网搜索
    const useAgent = agentMode;

    // 没有活动对话则先建一个，直接用返回的 id（避免 setState 异步时序问题）
    const convId = activeId || handleNew();

    // 发给 API 的历史基准：编辑模式取被编辑节点之前的部分；重试/换回答截到最后一条 user 之前
    // （旧的 AI 回答不进历史，否则模型会参考旧答案）；同步快照避免 setState 异步读到旧分支
    const snapshotNodes = activeConv && activeConv.tree ? visibleChain(activeConv.tree).map((e) => e.node) : [];
    let baseNodes = snapshotNodes;
    if (editIndex >= 0) {
      baseNodes = snapshotNodes.slice(0, editIndex);
    } else if (retry || regenerate) {
      let cut = snapshotNodes.length;
      for (let i = snapshotNodes.length - 1; i >= 0; i--) {
        if (snapshotNodes[i].role === "user") { cut = i; break; }
      }
      baseNodes = snapshotNodes.slice(0, cut);
    }

    // 重试 / 换回答：把那条 user 消息当初的附件找回来（图片、文档抽取文本、被跳过的文件）
    const retriedUserNode = retry || regenerate
      ? [...snapshotNodes].reverse().find((n) => n.role === "user") || null
      : null;
    const retriedPayload = retriedUserNode ? attachmentsRef.current.get(retriedUserNode.id) || null : null;
    const retriedText =
      (typeof retriedUserNode?.content === "string" ? retriedUserNode.content : "") ||
      retriedPayload?.askText ||
      "";
    // 纯附件消息（没有文字）也要能重试；完全没有任何内容才直接返回
    if ((retry || regenerate) && !retriedText.trim() && !retriedPayload) return;

    // 本次流式输出的 assistant 节点 id、附件挂载的 user 节点 id。
    // 必须先算好再写进树：setState 的 updater 是异步执行的，拿不到里面创建的对象。
    const liveNodeId = uid();
    let attachNodeId = null;

    // —— 编辑模式：在被编辑的 user 消息处新增一个版本分支（保留原对话为第一版）——
    if (editIndex >= 0) {
      setConvTree(convId, (tree) => {
        const chain = visibleChain(tree);
        const entry = chain[editIndex];
        if (!entry || entry.node.role !== "user") return;
        const userNode = makeNode("user", text);
        userNode.children.push(makeNode("assistant", "", { id: liveNodeId, streaming: true, hint: "" }));
        // 挂为父节点的下一个版本，并切换为当前显示
        entry.parent.children.push(userNode);
        entry.parent.active = entry.parent.children.length - 1;
      });
    } else if (retry || regenerate) {
      setConvTree(convId, (tree) => {
        const chain = visibleChain(tree);
        const last = chain[chain.length - 1];
        if (!last) return;
        // 重试：移除末尾的错误 AI 占位；换回答：旧回答保留为历史版本
        if (
          retry &&
          last.node.role === "assistant" &&
          String(last.node.content).startsWith("⚠️")
        ) {
          last.parent.children.pop();
        }
        // 新 AI 回答挂到最后一条 user 消息下，作为下一个版本
        const anchor = visibleChain(tree);
        let target = null;
        for (let i = anchor.length - 1; i >= 0; i--) {
          if (anchor[i].node.role === "user") { target = anchor[i]; break; }
        }
        if (target) {
          attachNodeId = target.node.id;
          target.node.children.push(makeNode("assistant", "", { id: liveNodeId, streaming: true, hint: "" }));
          target.node.active = target.node.children.length - 1;
        }
      });
    } else {
      // 仅保存用于展示的附件元信息（文件内容/抽取文本存 IndexedDB，避免撑爆 localStorage）
      const attachmentInfo = files.map((f) => ({
        name: f.name,
        kind: kindOf(f),
        size: formatSize(f.size),
      }));
      const userMsg = {
        role: "user",
        content: text,
        attachments: attachmentInfo.length ? attachmentInfo : undefined,
      };
      const aiMsg = { role: "assistant", content: "", streaming: true, hint: "" };

      // 首条消息作为对话标题（纯文件消息用文件名兜底）
      const title = text.trim() || files[0]?.name?.slice(0, 20) || "新对话";

      const userId = uid();
      attachNodeId = userId;
      setConvTree(convId, (tree) => {
        const userNode = makeNode("user", userMsg.content, { id: userId, attachments: userMsg.attachments });
        if (!userNode.attachments) delete userNode.attachments;
        userNode.children.push(makeNode("assistant", aiMsg.content, { id: liveNodeId, streaming: true, hint: "" }));
        const chain = visibleChain(tree);
        if (chain.length) {
          const tail = chain[chain.length - 1].node;
          tail.children.push(userNode);
          tail.active = tail.children.length - 1;
        } else {
          tree.children.push(userNode);
          tree.active = tree.children.length - 1;
        }
      });

      setConversations((prev) =>
        prev.map((c) =>
          c.id === convId && c.title === "新对话" ? { ...c, title: title.slice(0, 20) } : c
        )
      );
    }

    setIsStreaming(true);

    // 为本次请求创建 AbortController
    const controller = new AbortController();
    abortRef.current = controller;
    // 防御性重置停止标记：上一次请求若走了异常路径没消费掉，不能污染本次请求
    userStoppedRef.current = false;

    const setHint = (hint) =>
      updateLastVisible(convId, (node) => {
        node.hint = hint;
      });

    // —— 预处理附件（图片转 base64 / 视频上传 / 文档解析）——
    let prepared = { parts: [], systemMessages: [], skipped: [] };
    if (files.length) {
      try {
        prepared = await prepareAttachments(files, activeConfig, setHint);
      } catch (err) {
        updateLastVisible(convId, (node) => {
          node.content = `⚠️ ${err.message}`;
          node.streaming = false;
          node.searching = false;
          node.hint = "";
        });
        setIsStreaming(false);
        return;
      }
    }

    // 本次提问文本：重试 / 换回答时沿用那条 user 消息（含附件）
    const askText = (retry || regenerate ? retriedText : text).trim() || DEFAULT_ATTACHMENT_PROMPT;
    const apiUserContent =
      retry || regenerate
        ? userContentWithAttachments(retriedText, retriedPayload)
        : prepared.parts.length
        ? [...prepared.parts, { type: "text", text: askText }]
        : askText;

    // 附件内容按 user 节点 id 存起来：之后每一轮、重试、刷新都能复用
    if (
      !retry &&
      !regenerate &&
      attachNodeId &&
      (prepared.parts.length || prepared.systemMessages.length || prepared.skipped.length)
    ) {
      const payload = {
        parts: prepared.parts,
        systemMessages: prepared.systemMessages,
        skipped: prepared.skipped,
        askText,
      };
      attachmentsRef.current.set(attachNodeId, payload);
      saveAttachments(attachNodeId, payload);
    }

    // 不支持的文件（音频等）给模型一条说明，让它在回答里告知用户
    const noteMessages = skippedFileMessages(retry || regenerate ? retriedPayload?.skipped : prepared.skipped);

    // 文档类附件的内容是以 system 消息注入的：重试 / 换回答时要把这一轮的文档内容一起带上，
    // 否则模型只看到「用户上传了文件」的提问，却拿不到文件正文。
    const attachmentNodes =
      (retry || regenerate) && retriedUserNode ? [...baseNodes, retriedUserNode] : baseNodes;

    // 发给 API 的历史：过滤空消息、前端 UI 字段、⚠️ 错误气泡；
    // 历史里 user 节点的附件会按节点 id 自动补回（多轮对话不再丢文件）
    const history = [
      ...buildHistoryMessages(baseNodes, attachmentsRef.current, { webSearch: useWebSearch }),
      { role: "user", content: apiUserContent },
    ];

    // 联网搜索开启时，明确告知模型工具可用，并要求在回答末尾附参考链接
    const webSearchPrompt = useWebSearch
      ? [{
          role: "system",
          content: "联网搜索工具已启用且可用。如果用户的问题涉及最新信息、新闻、实时数据，请务必调用 web-search 工具搜索，工具已恢复正常工作。在回答末尾请用 Markdown 链接格式列出参考来源，格式如：[标题](URL)。",
        }]
      : [];

    // Agent 模式：引导模型自主拆解任务、连续调用工具、基于结果决定下一步
    const agentPrompt = useAgent
      ? [{
          role: "system",
          content:
            "【Agent 模式已开启】你是可以自主使用工具的智能助手。工作方式：1）先拆解任务需要哪些步骤；" +
            "2）需要工具时主动调用，相互独立的调用可以放在同一轮并行发起；3）根据每步返回结果决定下一步，" +
            "允许连续多轮调用，直到信息齐备；4）全部完成后用简洁中文给出最终答案，并简要说明用了哪些工具、得到什么关键结果。" +
            "规则：不要编造工具返回的结果；工具报错时可修正参数重试一次，仍失败就如实告知；简单问题无需调用工具。",
        }]
      : [];

    // 流式文本写进独立的 liveStream：token 不再触发对话树更新与全量重渲染
    beginLiveStream(convId, liveNodeId, "");

    await streamChat({
      messages: history,
      systemMessages: [
        ...customSystemMessages(),
        buildTimeMessage(),
        ...webSearchPrompt,
        ...agentPrompt,
        ...attachmentSystemMessages(attachmentNodes, attachmentsRef.current),
        ...noteMessages,
        ...prepared.systemMessages,
      ],
      config: activeConfig,
      webSearch: useWebSearch,
      customTools: enabledTools,
      nativeToolSettings,
      agentMode: useAgent,
      structured: workbench.structured,
      schemaText: workbench.schemaText,
      genParams: buildGenParams(),
      signal: controller.signal,
      ...makeStreamCallbacks(convId, {
        onStatus: (status, toolName) => {
          if (status === "searching" || status === "tool") {
            updateLastVisible(convId, (node) => {
              node.searching = true;
              node.toolName = status === "tool" ? toolName : "";
              node.hint = "";
            });
          }
        },
        onSources: (sources) => {
          updateLastVisible(convId, (node) => {
            const existing = node.sources || [];
            const seen = new Set(existing.map((s) => s.url));
            node.sources = [...existing, ...sources.filter((s) => !seen.has(s.url))];
          });
        },
        onDoneExtra: (node, finalText) => {
          // 联网搜索开启但 fiber 未返回来源时，从最终回答的 Markdown 链接中提取
          if (useWebSearch && !(node.sources?.length) && finalText) {
            const mdLinkRe = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
            const extracted = [];
            let m;
            while ((m = mdLinkRe.exec(finalText)) !== null) {
              extracted.push({ title: m[1], url: m[2] });
            }
            if (extracted.length) node.sources = extracted;
          }
        },
      }),
    });
  };

  // 停止生成
  const handleStop = () => {
    userStoppedRef.current = true; // onDone 会读这个标记设置 stopped
    // 等待人工确认中的工具：一律按拒绝处理，避免 Promise 悬挂
    confirmResolversRef.current.forEach((resolve) => resolve(false));
    confirmResolversRef.current.clear();
    setPendingConfirms({});
    abortRef.current?.abort();
    abortRef.current = null;
    setIsStreaming(false);
  };

  // 继续生成：从停止点接着续写（把已有内容作为 assistant 历史发回，让模型接着写）
  // 如果思考阶段就停了（content 为空），则复用原气泡重新请求
  const handleContinue = async () => {
    if (!activeConv || isStreaming) return;
    const chain = visibleChain(activeConv.tree);
    const lastEntry = chain[chain.length - 1];
    const last = lastEntry?.node;
    if (!last || last.role !== "assistant" || !last.stopped) return;

    // 思考阶段停止（无内容）→ 复用原气泡重新请求，不产生新消息
    if (!last.content) {
      const convId = activeId;
      // 把原气泡标记回 streaming，不删不加
      updateLastVisible(convId, (node) => {
        node.streaming = true;
        node.stopped = false;
        node.hint = "";
      });
      setIsStreaming(true);
      beginLiveStream(convId, last.id, "");

      const controller = new AbortController();
      abortRef.current = controller;
      // 防御性重置停止标记，避免污染本次继续生成
      userStoppedRef.current = false;

      // 历史 = 已有对话（末尾那条空 assistant 消息过滤掉），并带上历史附件
      const history = buildHistoryMessages(
        chain
          .map((e) => e.node)
          .filter(
            (m) =>
              (m.role === "user" || (m.role === "assistant" && m.content)) &&
              !String(m.content).startsWith("⚠️")
          ),
        attachmentsRef.current
      );

      await streamChat({
        messages: history,
        systemMessages: [
          ...customSystemMessages(),
          buildTimeMessage(),
          ...attachmentSystemMessages(chain.map((e) => e.node), attachmentsRef.current),
        ],
        config: activeConfig,
        webSearch: false,
        customTools: toolLib.filter((t) => t.enabled),
        nativeToolSettings,
        structured: workbench.structured,
        schemaText: workbench.schemaText,
        genParams: buildGenParams(),
        signal: controller.signal,
        ...makeStreamCallbacks(convId, {}),
      });
      return;
    }

    const convId = activeId;

    // 标记为继续生成中
    updateLastVisible(convId, (node) => {
      node.streaming = true;
      node.stopped = false;
    });
    setIsStreaming(true);
    // 已有内容作为基线，新 token 接在后面
    beginLiveStream(convId, last.id, String(last.content || ""));

    const controller = new AbortController();
    abortRef.current = controller;
    // 防御性重置停止标记，避免污染本次继续生成
    userStoppedRef.current = false;

    // 历史 = 已有对话（含已生成的不完整 AI 回答），让模型接着续写；带附件
    const history = buildHistoryMessages(
      chain
        .map((e) => e.node)
        .filter(
          (m) =>
            (m.role === "user" || m.role === "assistant") &&
            m.content &&
            !String(m.content).startsWith("⚠️")
        ),
      attachmentsRef.current
    );

    await streamChat({
      messages: history,
      systemMessages: [
        ...customSystemMessages(),
        buildTimeMessage(),
        ...attachmentSystemMessages(chain.map((e) => e.node), attachmentsRef.current),
      ],
      config: activeConfig,
      webSearch: false,
      customTools: toolLib.filter((t) => t.enabled),
      nativeToolSettings,
      genParams: buildGenParams(),
      signal: controller.signal,
      ...makeStreamCallbacks(convId, { clearStatus: false, appendTextOnError: true }),
    });
  };

  // 重试：复用可见路径中最后一条 user 消息（含附件）重新请求
  const handleRetry = () => {
    if (!activeConv || isStreaming) return;
    const lastUser = [...visibleChain(activeConv.tree)].reverse().find((e) => e.node.role === "user")?.node;
    if (!lastUser) return;
    // 纯附件消息（没有文字）也要能重试：附件内容存在 attachmentsRef 里
    if (!String(lastUser.content || "").trim() && !attachmentsRef.current.get(lastUser.id)) return;
    handleSend(typeof lastUser.content === "string" ? lastUser.content : "", { retry: true });
  };

  // 换一个回答：对最后一条 user 消息重新生成，新回答作为同分支的新版本（旧回答保留，< y/x > 可切换）
  const handleRegenerate = () => {
    if (!activeConv || isStreaming) return;
    const chain = visibleChain(activeConv.tree);
    const last = chain[chain.length - 1];
    if (!last || last.node.role !== "assistant") return;
    const lastUser = [...chain].reverse().find((e) => e.node.role === "user")?.node;
    if (!lastUser) return;
    // 纯附件消息同样支持换回答
    if (!String(lastUser.content || "").trim() && !attachmentsRef.current.get(lastUser.id)) return;
    handleSend(typeof lastUser.content === "string" ? lastUser.content : "", { regenerate: true });
  };

  // 对话重命名
  const handleRename = (id, title) => {
    const t = (title || "").trim();
    if (!t) return;
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title: t.slice(0, 30) } : c)));
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
