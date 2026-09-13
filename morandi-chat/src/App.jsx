import { useState, useEffect, useRef } from "react";
import Sidebar from "./components/Sidebar";
import ChatArea from "./components/ChatArea";
import Settings from "./components/Settings";
import WorkbenchPanel from "./components/WorkbenchPanel";
import { streamChat } from "./api/chat";
import { prepareAttachments, kindOf, formatSize } from "./api/files";
import { loadToolLib, saveToolLib } from "./api/tools";
import { PROVIDERS, getProvider, detectProvider, newProfileId, getParamCaps } from "./api/providers";

const STORAGE_KEY = "morandi-chat-conversations";
const CONFIG_KEY = "morandi-chat-config";
const ACTIVE_KEY = "morandi-chat-active";
const WORKBENCH_KEY = "morandi-chat-workbench";
const PROMPTS_KEY = "morandi-chat-prompts";

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

// 配置结构：{ profiles: [{id, provider, baseURL, apiKey, model}], activeId }
function loadConfig() {
  const stored = loadJSON(CONFIG_KEY, null);

  // 已是多档案结构
  if (stored && Array.isArray(stored.profiles) && stored.profiles.length) {
    const profiles = stored.profiles.map((p) => ({
      id: p.id || newProfileId(),
      provider: p.provider || detectProvider(p.baseURL),
      baseURL: p.baseURL || "",
      apiKey: p.apiKey || "",
      model: LEGACY_MODELS.includes(p.model) ? "kimi-k3" : p.model || "",
    }));
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
  const [workbenchOpen, setWorkbenchOpen] = useState(false);
  const abortRef = useRef(null); // 当前请求的 AbortController
  const userStoppedRef = useRef(false); // 标记是否用户手动停止（避免 onDone 覆盖 stopped 标记）

  // 对话持久化：流式期间每个 token 都全量序列化+写盘会越来越卡，改为 400ms 防抖；
  // 页面关闭/切后台时立即落盘，避免丢尾部更新
  const convRef = useRef(conversations);
  convRef.current = conversations;
  useEffect(() => {
    const t = setTimeout(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(convRef.current));
    }, 400);
    return () => clearTimeout(t);
  }, [conversations]);
  useEffect(() => {
    const flush = () => localStorage.setItem(STORAGE_KEY, JSON.stringify(convRef.current));
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
    localStorage.setItem(ACTIVE_KEY, JSON.stringify(next));
  }, [activeId, conversations]);

  useEffect(() => {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  }, [config]);

  // 工作台配置 / 提示词模板（低频写入，直接持久化即可）
  useEffect(() => {
    localStorage.setItem(WORKBENCH_KEY, JSON.stringify(workbench));
  }, [workbench]);
  useEffect(() => {
    localStorage.setItem(PROMPTS_KEY, JSON.stringify(promptLib));
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
        node.toolSteps.push({
          id: step.callId, name: step.name, source: step.source,
          args: step.args, status: "running",
        });
      } else {
        const s = node.toolSteps.find((x) => x.id === step.callId);
        if (s) {
          s.status = step.error ? "error" : "done";
          s.result = step.result;
        }
      }
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

  const handleSend = async (text, options = {}) => {
    const { webSearch = false, agentMode = false, files = [], retry = false, regenerate = false, editIndex = -1 } = options;
    if (!activeConfig.apiKey) {
      setSettingsOpen(true);
      return;
    }
    const useWebSearch = webSearch && activeCaps.webSearch;
    const enabledTools = toolLib.filter((t) => t.enabled);
    // Agent 模式必须有可用工具（自定义工具或联网搜索），否则退化为普通对话
    const useAgent = agentMode && (useWebSearch || enabledTools.length > 0);

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

    // —— 编辑模式：在被编辑的 user 消息处新增一个版本分支（保留原对话为第一版）——
    if (editIndex >= 0) {
      setConvTree(convId, (tree) => {
        const chain = visibleChain(tree);
        const entry = chain[editIndex];
        if (!entry || entry.node.role !== "user") return;
        const userNode = makeNode("user", text);
        userNode.children.push(makeNode("assistant", "", { streaming: true, hint: "" }));
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
          target.node.children.push(makeNode("assistant", "", { streaming: true, hint: "" }));
          target.node.active = target.node.children.length - 1;
        }
      });
    } else {
      // 仅保存用于展示的附件元信息（文件数据不入库，避免撑爆 localStorage）
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

      setConvTree(convId, (tree) => {
        const userNode = makeNode("user", userMsg.content, { attachments: userMsg.attachments });
        if (!userNode.attachments) delete userNode.attachments;
        userNode.children.push(makeNode("assistant", aiMsg.content, { streaming: true, hint: "" }));
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

    // 不支持的文件（音频等）给模型一条说明，让它在回答里告知用户
    const noteMessages = prepared.skipped.length
      ? [
          {
            role: "system",
            content: `以下文件无法处理，请在回答开头简要告知用户：${prepared.skipped
              .map((s) => `《${s.name}》（${s.reason}）`)
              .join("、")}`,
          },
        ]
      : [];

    // 有图片/视频时，本轮用户消息必须是多模态数组格式
    const askText = text.trim() || "请分析我上传的文件";
    const apiUserContent = prepared.parts.length
      ? [...prepared.parts, { type: "text", text: askText }]
      : text;

    // 发给 API 的历史：只保留 role/content；
    // 过滤空消息、前端 UI 字段，以及以 ⚠️ 开头的错误气泡
    // 联网搜索开启时，额外剔除历史中"无法搜索/工具不可用"等 AI 回复，彻底消除误导
    const searchFailPatterns = /(无法联网|无法搜索|搜索失败|工具不可用|暂时无法|无法访问互联网|没有联网|不支持联网)/;
    const history = [
      ...baseNodes
        .filter((m) => {
          if (m.role !== "user" && !(m.role === "assistant" && m.content)) return false;
          if (String(m.content).startsWith("⚠️")) return false;
          // 联网开启时，剔除历史上"无法搜索"的 AI 回复
          if (useWebSearch && m.role === "assistant" && searchFailPatterns.test(m.content)) return false;
          return true;
        })
        .map((m) => ({ role: m.role, content: m.content })),
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

    await streamChat({
      messages: history,
      systemMessages: [
        ...customSystemMessages(),
        buildTimeMessage(),
        ...webSearchPrompt,
        ...agentPrompt,
        ...noteMessages,
        ...prepared.systemMessages,
      ],
      config: activeConfig,
      webSearch: useWebSearch,
      customTools: enabledTools,
      agentMode: useAgent,
      structured: workbench.structured,
      schemaText: workbench.schemaText,
      genParams: buildGenParams(),
      signal: controller.signal,
      onChunk: (chunk) => {
        updateLastVisible(convId, (node) => {
          node.content += chunk;
          node.searching = false;
          node.hint = "";
        });
      },
      onStatus: (status, toolName) => {
        if (status === "searching" || status === "tool") {
          updateLastVisible(convId, (node) => {
            node.searching = true;
            node.toolName = status === "tool" ? toolName : "";
            node.hint = "";
          });
        }
      },
      // Agent 工具执行进度：start 追加一步（running），result 回填结果与状态
      onToolStep: toolStepHandler(convId),
      onSources: (sources) => {
        updateLastVisible(convId, (node) => {
          const existing = node.sources || [];
          const seen = new Set(existing.map((s) => s.url));
          node.sources = [...existing, ...sources.filter((s) => !seen.has(s.url))];
        });
      },
      onDone: (usage) => {
        const stopped = userStoppedRef.current;
        userStoppedRef.current = false;
        updateLastVisible(convId, (node) => {
          // 联网搜索开启但 fiber 未返回来源时，从最终回答的 Markdown 链接中提取
          if (useWebSearch && !(node.sources?.length) && node.content) {
            const mdLinkRe = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
            const extracted = [];
            let m;
            while ((m = mdLinkRe.exec(node.content)) !== null) {
              extracted.push({ title: m[1], url: m[2] });
            }
            if (extracted.length) node.sources = extracted;
          }
          node.streaming = false;
          node.searching = false;
          node.hint = "";
          node.stopped = stopped;
          // 兜底：把仍标记为执行中的工具步骤收口（如达到 Agent 轮数上限）
          if (Array.isArray(node.toolSteps)) {
            node.toolSteps.forEach((s) => {
              if (s.status === "running") s.status = "done";
            });
          }
          if (usage) node.usage = usage;
        });
        setIsStreaming(false);
        abortRef.current = null;
      },
      onError: (err) => {
        updateLastVisible(convId, (node) => {
          node.content = `⚠️ ${err.message}`;
          node.streaming = false;
          node.searching = false;
          node.hint = "";
          if (Array.isArray(node.toolSteps)) {
            node.toolSteps.forEach((s) => {
              if (s.status === "running") s.status = "error";
            });
          }
        });
        setIsStreaming(false);
        abortRef.current = null;
      },
    });
  };

  // 停止生成
  const handleStop = () => {
    userStoppedRef.current = true; // onDone 会读这个标记设置 stopped
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

      const controller = new AbortController();
      abortRef.current = controller;

      // 历史 = 已有对话（末尾那条空 assistant 消息过滤掉）
      const history = chain
        .map((e) => e.node)
        .filter(
          (m) =>
            (m.role === "user" || (m.role === "assistant" && m.content)) &&
            !String(m.content).startsWith("⚠️")
        )
        .map((m) => ({ role: m.role, content: m.content }));

      await streamChat({
        messages: history,
        systemMessages: [...customSystemMessages(), buildTimeMessage()],
        config: activeConfig,
        webSearch: false,
        customTools: toolLib.filter((t) => t.enabled),
        structured: workbench.structured,
        schemaText: workbench.schemaText,
        genParams: buildGenParams(),
        signal: controller.signal,
        onChunk: (chunk) => {
          updateLastVisible(convId, (node) => {
            node.content += chunk;
            node.searching = false;
            node.hint = "";
          });
        },
        onToolStep: toolStepHandler(convId),
        onDone: (usage) => {
          const stopped = userStoppedRef.current;
          userStoppedRef.current = false;
          updateLastVisible(convId, (node) => {
            node.streaming = false;
            node.searching = false;
            node.hint = "";
            node.stopped = stopped;
            if (Array.isArray(node.toolSteps)) {
              node.toolSteps.forEach((s) => {
                if (s.status === "running") s.status = "done";
              });
            }
            if (usage) node.usage = usage;
          });
          setIsStreaming(false);
          abortRef.current = null;
        },
        onError: (err) => {
          updateLastVisible(convId, (node) => {
            node.content = `⚠️ ${err.message}`;
            node.streaming = false;
            node.stopped = false;
            node.hint = "";
          });
          setIsStreaming(false);
          abortRef.current = null;
        },
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

    const controller = new AbortController();
    abortRef.current = controller;

    // 历史 = 已有对话（含已生成的不完整 AI 回答），让模型接着续写
    const history = chain
      .map((e) => e.node)
      .filter(
        (m) =>
          (m.role === "user" || m.role === "assistant") &&
          m.content &&
          !String(m.content).startsWith("⚠️")
      )
      .map((m) => ({ role: m.role, content: m.content }));

    await streamChat({
      messages: history,
      systemMessages: [...customSystemMessages(), buildTimeMessage()],
      config: activeConfig,
      webSearch: false,
      customTools: toolLib.filter((t) => t.enabled),
      genParams: buildGenParams(),
      signal: controller.signal,
      onChunk: (chunk) => {
        updateLastVisible(convId, (node) => {
          node.content += chunk;
        });
      },
      onToolStep: toolStepHandler(convId),
      onDone: (usage) => {
        updateLastVisible(convId, (node) => {
          node.streaming = false;
          node.stopped = false;
          node.hint = "";
          if (Array.isArray(node.toolSteps)) {
            node.toolSteps.forEach((s) => {
              if (s.status === "running") s.status = "done";
            });
          }
          if (usage) node.usage = usage;
        });
        setIsStreaming(false);
        abortRef.current = null;
      },
      onError: (err) => {
        updateLastVisible(convId, (node) => {
          node.content += `\n\n⚠️ ${err.message}`;
          node.streaming = false;
          node.stopped = false;
          node.hint = "";
        });
        setIsStreaming(false);
        abortRef.current = null;
      },
    });
  };

  // 重试：复用可见路径中最后一条 user 消息重新请求
  const handleRetry = () => {
    if (!activeConv || isStreaming) return;
    const chain = visibleChain(activeConv.tree);
    let lastUserText = "";
    for (let i = chain.length - 1; i >= 0; i--) {
      if (chain[i].node.role === "user") {
        lastUserText = typeof chain[i].node.content === "string" ? chain[i].node.content : "";
        break;
      }
    }
    if (lastUserText) handleSend(lastUserText, { retry: true });
  };

  // 换一个回答：对最后一条 user 消息重新生成，新回答作为同分支的新版本（旧回答保留，< y/x > 可切换）
  const handleRegenerate = () => {
    if (!activeConv || isStreaming) return;
    const chain = visibleChain(activeConv.tree);
    const last = chain[chain.length - 1];
    if (!last || last.node.role !== "assistant") return;
    let lastUserText = "";
    for (let i = chain.length - 1; i >= 0; i--) {
      if (chain[i].node.role === "user") {
        lastUserText = typeof chain[i].node.content === "string" ? chain[i].node.content : "";
        break;
      }
    }
    if (lastUserText) handleSend(lastUserText, { regenerate: true });
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
      />
      <ChatArea
        messages={messages}
        entries={visibleEntries}
        onSwitchVersion={switchVersion}
        isStreaming={isStreaming}
        model={`${getProvider(activeConfig.provider).name} · ${activeConfig.model || "未设置模型"}`}
        webSearchAvailable={activeCaps.webSearch}
        agentAvailable={activeCaps.webSearch || toolLib.some((t) => t.enabled)}
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
      />
      <Settings
        open={settingsOpen}
        config={config}
        onUpsert={upsertProfile}
        onActivate={activateProfile}
        onDelete={deleteProfile}
        onClose={() => setSettingsOpen(false)}
      />
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
      />
    </div>
  );
}
