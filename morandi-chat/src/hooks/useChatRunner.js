// 请求编排 hook：把「发一次请求」相关的逻辑从 App.jsx 里搬出来
//
// 包含：工具步骤状态机、工具手动重跑与结果回灌、危险工具确认、流式回调组装、
//      发送 / 停止 / 继续生成 / 重试 / 换一个回答，以及本地诊断埋点。
// App 只负责把「当前对话、配置、参数、数据表」传进来，拿回一组可直接绑到界面上的处理函数。

import { useEffect, useRef, useState } from "react";
import { setAllowThirdPartyFetch } from "../api/fetcher";
import { runFiber, streamChat } from "../api/chat";
import { formatSize, kindOf, prepareAttachments } from "../api/files";
import { runLocalTool } from "../api/tools";
import { isNativeTool, runNativeTool } from "../api/nativeTools";
import { deleteFullResult, saveFullResult } from "../api/fullResultsStore";
import { consumeStopFlag, failToolSteps, finalizeToolSteps } from "../api/toolSteps";
import { addStep, endTrace, startTrace } from "../api/sessionTrace";
import {
  DEFAULT_ATTACHMENT_PROMPT,
  attachmentSystemMessages,
  buildHistoryMessages,
  skippedFileMessages,
  userContentWithAttachments,
} from "../api/history";
import { saveAttachments } from "../api/attachmentStore";
import { makeNode, uid, visibleChain } from "../state/conversationTree";

export default function useChatRunner({
  // 对话数据
  conversations,
  setConvTree,
  updateLastVisible,
  applyDefaultTitle,
  activeId,
  activeConv,
  handleNew,
  // 服务商与生成参数
  activeConfig,
  activeCaps,
  workbench,
  customSystemMessages,
  buildGenParams,
  buildTimeMessage,
  toolLib,
  nativeToolSettings,
  // 附件与工具结果全文（App 与本 hook 共用同一份 ref）
  attachmentsRef,
  fullResultsRef,
  // 上下文预算
  planHistory,
  // 流式缓冲
  beginLiveStream,
  appendLiveStream,
  appendLiveReasoning,
  endLiveStream,
}) {
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef(null); // 当前请求的 AbortController
  const userStoppedRef = useRef(false); // 是否用户手动停止（避免 onDone 覆盖 stopped 标记）
  // 危险工具人工确认：callId → resolve 函数（不放 state，避免 Promise 被反复序列化）
  const confirmResolversRef = useRef(new Map());
  // 仅放展示需要的信息（callId → {name, args}），触发气泡渲染确认按钮
  const [pendingConfirms, setPendingConfirms] = useState({});

  // 把工作台里的「允许第三方抓取源」同步给抓取层（默认开启；自建端点始终优先）
  useEffect(() => {
    setAllowThirdPartyFetch(workbench.useThirdPartyFetch !== false);
  }, [workbench.useThirdPartyFetch]);

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
    const chainNodes = chain
      .map((e) => e.node)
      .filter(
        (m) =>
          (m.role === "user" || m.role === "assistant") &&
          m.content &&
          !String(m.content).startsWith("⚠️")
      );

    const boost = {
      role: "system",
      content:
        `用户手动重新执行了工具「${toolName}」，最新结果如下。请基于此结果继续或修正回答，不要编造工具返回内容。\n\n` +
        String(resultStr).slice(0, 12000),
    };

    // 上下文预算：先把固定部分（system 提示 + 回灌的工具结果）扣掉，再按整轮裁剪历史
    const plan = planHistory(chainNodes, {
      convId,
      systemMessages: [...customSystemMessages(), buildTimeMessage(), boost],
    });

    await streamChat({
      messages: buildHistoryMessages(plan.nodes, attachmentsRef.current),
      systemMessages: [
        ...customSystemMessages(),
        buildTimeMessage(),
        boost,
        ...attachmentSystemMessages(plan.nodes, attachmentsRef.current),
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

  // 组装一次 streamChat 的标准回调（onChunk/onReasoning/onToolStep/onToolConfirm/onDone/onError）。
  // 发送 / 继续生成 / 工具重试回灌 三类请求共用，差异通过 opts 注入，避免四份样板复制后各自漂移。
  const makeStreamCallbacks = (convId, opts = {}) => {
    const { onStatus, onSources, onDoneExtra, clearStatus = true, appendTextOnError = false } = opts;
    let statusCleared = false;
    // 每次请求记一条本地诊断（只在内存里，不记正文，见 api/sessionTrace.js）
    const traceId = startTrace("chat-request", {
      convId,
      provider: activeConfig.provider,
      model: activeConfig.model,
    });
    const tracedToolStep = toolStepHandler(convId);
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
      onStatus: (status, toolName) => {
        addStep(traceId, "status", { status, tool: toolName || "" });
        onStatus && onStatus(status, toolName);
      },
      onSources: (sources) => {
        addStep(traceId, "sources", { count: sources?.length || 0 });
        onSources && onSources(sources);
      },
      onRound: (info) => addStep(traceId, "round", info),
      onToolStep: (step) => {
        addStep(traceId, "tool", {
          phase: step.type,
          name: step.name,
          attempt: step.attempt,
          error: step.error ? String(step.result || "").slice(0, 200) : undefined,
        });
        tracedToolStep(step);
      },
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
        endTrace(traceId, {
          status: stopped ? "stopped" : "done",
          usage: usage || null,
          contentLength: text.length,
          reasoningLength: reasoning.length,
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
        endTrace(traceId, {
          status: "error",
          error: String(err?.message || err).slice(0, 300),
          contentLength: text.length,
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

      applyDefaultTitle(convId, title);
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

    // 上下文预算：先把固定部分（system 提示 + 本轮提问与附件）扣掉，
    // 再按「整轮」从最早处裁剪历史，避免把请求撑爆服务商窗口。
    const systemBase = [
      ...customSystemMessages(),
      buildTimeMessage(),
      ...webSearchPrompt,
      ...agentPrompt,
      ...noteMessages,
    ];
    const budgetPlan = planHistory(baseNodes, {
      convId,
      systemMessages: systemBase,
      extraFixed: [...prepared.systemMessages, { role: "user", content: apiUserContent }],
    });
    const history = [
      ...buildHistoryMessages(budgetPlan.nodes, attachmentsRef.current, { webSearch: useWebSearch }),
      { role: "user", content: apiUserContent },
    ];

    // 流式文本写进独立的 liveStream：token 不再触发对话树更新与全量重渲染
    beginLiveStream(convId, liveNodeId, "");

    await streamChat({
      messages: history,
      systemMessages: [
        ...systemBase,
        ...attachmentSystemMessages(budgetPlan.nodes, attachmentsRef.current),
        ...(retry || regenerate ? retriedPayload?.systemMessages || [] : []),
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
      const chainNodes = chain
        .map((e) => e.node)
        .filter(
          (m) =>
            (m.role === "user" || (m.role === "assistant" && m.content)) &&
            !String(m.content).startsWith("⚠️")
        );
      // 上下文预算：超限时从最早的整轮开始省略
      const plan = planHistory(chainNodes, {
        convId,
        systemMessages: [...customSystemMessages(), buildTimeMessage()],
      });

      await streamChat({
        messages: buildHistoryMessages(plan.nodes, attachmentsRef.current),
        systemMessages: [
          ...customSystemMessages(),
          buildTimeMessage(),
          ...attachmentSystemMessages(plan.nodes, attachmentsRef.current),
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
    const chainNodes = chain
      .map((e) => e.node)
      .filter(
        (m) =>
          (m.role === "user" || m.role === "assistant") &&
          m.content &&
          !String(m.content).startsWith("⚠️")
      );
    // 上下文预算：超限时从最早的整轮开始省略
    const plan = planHistory(chainNodes, {
      convId,
      systemMessages: [...customSystemMessages(), buildTimeMessage()],
    });

    await streamChat({
      messages: buildHistoryMessages(plan.nodes, attachmentsRef.current),
      systemMessages: [
        ...customSystemMessages(),
        buildTimeMessage(),
        ...attachmentSystemMessages(plan.nodes, attachmentsRef.current),
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

  return {
    isStreaming,
    pendingConfirms,
    handleSend,
    handleStop,
    handleContinue,
    handleRetry,
    handleRegenerate,
    retryToolStep,
    respondToolConfirm,
  };
}
