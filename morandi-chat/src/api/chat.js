// 兼容 OpenAI 格式的流式对话（多服务商，能力见 providers.js）
// 工具循环（标准 function 流程），两类工具共用：
//   1. 联网搜索（Kimi）：走官方 Formula 工具通道
//      GET /formulas/moonshot/web-search:latest/tools  获取声明
//      → POST /chat/completions（带 tools）            模型返回 tool_calls
//      → POST /formulas/.../fibers                     执行联网搜索
//      → POST /chat/completions（回传 tool 结果）       得到最终回答
//   2. 自定义 JS 工具（工作台定义）：声明随请求下发，tool_calls 由前端本地执行

import { getProvider, getParamCaps } from "./providers";
import { compileTools, runLocalTool, isRetryableError } from "./tools";
import { NATIVE_TOOL_DECLS, isNativeTool, nativeNeedsConfirm, runNativeTool } from "./nativeTools";

const FORMULA_URI = "moonshot/web-search:latest";
const MAX_TOOL_ROUNDS = 6; // 防止异常情况下工具调用无限循环
const AGENT_MAX_ROUNDS = 10; // Agent 模式允许更多轮自主工具调用
const TOOL_AUTO_RETRY = 2; // 工具暂时性错误自动重试次数（指数退避：400ms → 800ms）

let toolsCache = null;

async function authHeaders(config) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.apiKey}`,
  };
}

// 获取联网搜索工具声明（进程内缓存，声明是静态的）
async function getWebSearchTools(config) {
  if (toolsCache) return toolsCache;
  const resp = await fetch(`${config.baseURL}/formulas/${FORMULA_URI}/tools`, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`获取联网搜索工具失败 (${resp.status})：${t.slice(0, 200)}`);
  }
  const data = await resp.json();
  toolsCache = data.tools;
  return toolsCache;
}

// 执行一次流式 chat completion，实时回调 content，并累积可能出现的 tool_calls
// genParams: { temperature, topP, maxTokens, stop }（0/空 表示不发送；按模型能力过滤）
async function streamOnce(messages, config, tools, onChunk, signal, genParams = {}, structured = false) {
  const caps = getProvider(config.provider).caps;
  const paramCaps = getParamCaps(config.provider, config.model);
  const body = {
    model: config.model,
    messages,
    stream: true,
    // 让服务端在最后一个 chunk 返回 token 用量（OpenAI 兼容标准字段）
    stream_options: { include_usage: true },
  };
  // reasoning_effort 仅对支持的服务商发送，其他平台收到未知参数可能直接 400
  if (caps.reasoningEffort) body.reasoning_effort = "low";
  if (tools) body.tools = tools;

  // 采样/长度参数：模型不支持的不发，避免 400
  const p = genParams || {};
  if (paramCaps.temperature && typeof p.temperature === "number") body.temperature = p.temperature;
  if (paramCaps.topP && typeof p.topP === "number") body.top_p = p.topP;
  if (paramCaps.maxTokens && p.maxTokens > 0) body.max_tokens = p.maxTokens;
  if (paramCaps.stop && Array.isArray(p.stop) && p.stop.length) body.stop = p.stop;

  // JSON Mode：开关开启且服务商支持时强制输出合法 JSON（OpenAI 兼容参数）
  if (structured && caps.responseFormat) body.response_format = { type: "json_object" };

  const resp = await fetch(`${config.baseURL}/chat/completions`, {
    method: "POST",
    headers: await authHeaders(config),
    body: JSON.stringify(body),
    signal,
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`请求失败 (${resp.status})：${errText.slice(0, 200)}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let content = "";
  const toolCalls = [];
  let finishReason = null;
  let usage = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop(); // 最后一行可能不完整，留给下一轮

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) continue;
      const dataStr = trimmed.slice(5).trim();
      if (dataStr === "[DONE]") continue;
      try {
        const data = JSON.parse(dataStr);
        // include_usage 的用量块 choices 为空、usage 有值（部分厂商字段名不同，做兼容）
        if (data.usage) {
          usage = {
            prompt_tokens: data.usage.prompt_tokens ?? data.usage.input_tokens ?? 0,
            completion_tokens: data.usage.completion_tokens ?? data.usage.output_tokens ?? 0,
            total_tokens: data.usage.total_tokens ?? 0,
          };
          if (!usage.total_tokens) usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
        }
        const choice = data.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;

        const delta = choice.delta || {};
        // K3 的思考过程在 reasoning_content，这里忽略，只展示正式回答
        if (delta.content) {
          content += delta.content;
          onChunk && onChunk(delta.content);
        }

        // 流式拼接 tool_calls（arguments 是分片到达的字符串）
        if (Array.isArray(delta.tool_calls)) {
          for (const piece of delta.tool_calls) {
            const i = piece.index ?? 0;
            if (!toolCalls[i]) {
              toolCalls[i] = { id: "", type: "function", function: { name: "", arguments: "" } };
            }
            if (piece.id) toolCalls[i].id = piece.id;
            if (piece.type) toolCalls[i].type = piece.type;
            if (piece.function?.name) toolCalls[i].function.name = piece.function.name;
            if (piece.function?.arguments) {
              toolCalls[i].function.arguments += piece.function.arguments;
            }
          }
        }
      } catch {
        // 某些非标准数据忽略
      }
    }
  }

  return { content, toolCalls: toolCalls.filter(Boolean), finishReason, usage };
}

// 通过 Formula fiber 执行一次工具（web-search 为 protected，结果在 encrypted_output）
// 同时尝试从响应中提取可读的搜索来源（title/url），供前端展示
export async function runFiber(config, name, args, signal) {
  const resp = await fetch(`${config.baseURL}/formulas/${FORMULA_URI}/fibers`, {
    method: "POST",
    headers: await authHeaders(config),
    body: JSON.stringify({ name, arguments: args }),
    signal,
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`联网搜索执行失败 (${resp.status})：${t.slice(0, 200)}`);
  }
  const fiber = await resp.json();
  const ctx = fiber.context || {};
  if (fiber.status && fiber.status !== "succeeded") {
    const detail = fiber.error?.message || fiber.message || JSON.stringify(fiber).slice(0, 200);
    throw new Error(`联网搜索执行失败：${detail}`);
  }
  const result = ctx.output || ctx.encrypted_output || "";
  if (!result) {
    throw new Error(`联网搜索未返回结果：${JSON.stringify(fiber).slice(0, 200)}`);
  }

  // 尝试从 fiber 响应中提取可读的搜索来源
  // Kimi 的 encrypted_output 对客户端不可读，但部分响应会在其他字段携带结构化来源
  const sources = [];
  const tryExtract = (obj) => {
    if (!obj || typeof obj !== "object") return;
    // 常见字段名：search_results / results / references / citations
    const fields = ["search_results", "results", "references", "citations", "sources"];
    for (const f of fields) {
      if (Array.isArray(obj[f])) {
        for (const item of obj[f]) {
          if (item && typeof item === "object") {
            const title = item.title || item.name || item.text || "";
            const url = item.url || item.link || item.href || "";
            if (title || url) sources.push({ title, url });
          }
        }
      }
    }
  };
  tryExtract(ctx);
  tryExtract(fiber);

  return { result, sources };
}

// 用法：
// await streamChat({ messages, systemMessages, config, webSearch, customTools, agentMode, onChunk, onToolStep, onStatus, onDone, onError })
// customTools: 工作台启用的自定义工具项数组（见 tools.js）
// agentMode:  Agent 模式（允许连续多轮工具调用，上限 10 轮，并回调每步进度 onToolStep）
export async function streamChat({
  messages,
  systemMessages = [],
  config,
  webSearch = false,
  customTools = [],
  agentMode = false,
  structured = false,
  schemaText = "",
  genParams = {},
  signal,
  onChunk,
  onStatus,
  onSources,
  onToolStep,
  onToolConfirm,
  onDone,
  onError,
}) {
  try {
    // 联网搜索为 Kimi 专属能力，其他服务商即使开了开关也不传工具
    const caps = getProvider(config.provider).caps;
    const wsTools = webSearch && caps.webSearch ? await getWebSearchTools(config) : null;
    if (webSearch && !caps.webSearch) {
      console.info("[联网搜索] 当前服务商不支持，已忽略该选项");
    }
    // 自定义 JS 工具（工作台定义，本地执行）→ OpenAI function 声明（内置工具名保留，用户工具重名自动改名）
    const nativeNames = NATIVE_TOOL_DECLS.map((d) => d.function.name);
    const custom = compileTools(customTools, nativeNames);
    if (custom.declarations.length) {
      console.info(
        `[自定义工具] 已启用 ${custom.declarations.length} 个：`,
        custom.declarations.map((d) => d.function.name)
      );
    }
    // 工具声明：联网搜索 + 预置内置工具（fetch_url/todo_list，始终可用）+ 用户自定义工具
    const toolDecls = [...(wsTools || []), ...NATIVE_TOOL_DECLS, ...custom.declarations];
    console.info(
      `[请求] 服务商：${config.provider}，模型：${config.model}，联网搜索：${!!wsTools}，自定义工具：${custom.declarations.length} 个`
    );
    if (toolDecls.length) console.info(`[工具] 工具声明已加载：${toolDecls.length} 个`, toolDecls);
    if (agentMode) {
      console.info(
        toolDecls.length
          ? `[Agent 模式] 已开启，模型可连续多轮自主调用工具（上限 ${AGENT_MAX_ROUNDS} 轮）`
          : "[Agent 模式] 已开启，但当前没有可用工具，按普通对话处理"
      );
    }
    const maxRounds = agentMode ? AGENT_MAX_ROUNDS : MAX_TOOL_ROUNDS;

    // 结构化输出：请求体带 response_format(json_object)，system 提示词兜底
    // （DashScope/OpenAI 还要求消息里含 "JSON" 关键词，兜底指令天然满足）
    const structuredOn = structured && caps.responseFormat;
    if (structured && !caps.responseFormat) {
      console.info("[结构化输出] 当前服务商不支持 response_format，已忽略该设置");
    }
    if (structuredOn) console.info("[结构化输出] 已启用 JSON Mode");
    const structuredPrompt = structuredOn
      ? [
          {
            role: "system",
            content:
              "本次回答必须只输出一个合法的 JSON（对象或数组）：不要用 Markdown 代码块包裹，不要输出任何解释文字或前后缀。" +
              (schemaText.trim() ? `\nJSON 结构要求：${schemaText.trim()}` : ""),
          },
        ]
      : [];

    // 用副本维护完整多轮上下文（含文件 system 消息、tool_calls / role=tool 消息）
    const convo = [...systemMessages, ...structuredPrompt, ...messages];
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    for (let round = 0; round <= maxRounds; round++) {
      const { content, toolCalls, usage } = await streamOnce(
        convo, config, toolDecls.length ? toolDecls : null, onChunk, signal, genParams, structured
      );
      console.info(`[工具循环] 第 ${round + 1} 轮，模型工具调用数：${toolCalls.length}`, toolCalls);

      // 没有工具调用 → 这一轮就是最终回答
      if (!toolCalls.length) {
        onDone && onDone(usage || null);
        return;
      }

      // 模型决定调用工具：原样保留 assistant 消息（含 tool_calls）
      convo.push({ role: "assistant", content: content || "", tool_calls: toolCalls });

      // ===== 本批 tool_calls 并行编排（模型一轮可能返回多个独立调用，如同时抓多个网页）=====
      // 1) 解析每个调用的路由与确认策略，批量发出 start（UI 同时显示多个执行中/待确认）
      // 2) 确认先行：批次内所有需确认的调用并行等待用户决策，决策落定前不执行任何工具
      //    （避免「用户拒绝了危险工具，但同批的其他工具已经跑完」的语义漏洞）
      // 3) 未被拒绝的调用 Promise.all 并行执行，各自内部独立做指数退避自动重试
      // 4) 全部结束后按原 toolCalls 顺序发 result、push role=tool（与 tool_calls 一一对齐）
      // AbortError 在任何阶段都不被捕获：用户点停止即向上抛出中止整轮生成
      const makeAbortPromise = () =>
        new Promise((_, reject) => {
          if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
          } else {
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true }
            );
          }
        });

      const plans = toolCalls.map((tc) => {
        const name = tc.function?.name || "";
        const argsRaw = String(tc.function?.arguments || "");
        // 路由优先级：预置内置工具（fetch_url/todo_list）→ 用户自定义 JS 工具 → 联网搜索 fiber
        const native = isNativeTool(name);
        const localTool = custom.executors.get(name);
        const isLocalExec = native || !!localTool;
        // 确认策略：自定义工具看 confirm 标记；内置工具按参数判定（todo_list 写操作需确认）
        const needConfirm = native ? nativeNeedsConfirm(name, argsRaw) : !!localTool?.confirm;
        return {
          tc, name, argsRaw, argsPreview: argsRaw.slice(0, 80),
          native, localTool, isLocalExec, needConfirm,
        };
      });

      // 阶段 1：批量发出 start
      for (const p of plans) {
        onStatus && onStatus(p.isLocalExec ? "tool" : "searching", p.name);
        onToolStep && onToolStep({
          type: "start", callId: p.tc.id, name: p.name,
          source: p.isLocalExec ? "local" : "web",
          args: p.argsPreview, argsRaw: p.argsRaw, needsConfirm: p.needConfirm,
        });
      }

      // 阶段 2：需确认的调用并行等待（用户逐个允许/拒绝；点停止则 AbortError 中止全部）
      const approvals = await Promise.all(plans.map(async (p) => {
        if (!p.needConfirm) return true;
        if (!onToolConfirm) return false;
        return Promise.race([
          Promise.resolve(onToolConfirm(p.tc.id, p.name, p.argsRaw)),
          makeAbortPromise(),
        ]);
      }));

      // 阶段 3：并行执行（被拒绝的调用直接产出拒绝结果，不影响同批其他调用）
      const outcomes = await Promise.all(plans.map(async (p, idx) => {
        if (!approvals[idx]) return { rejected: true };
        if (p.needConfirm) {
          onToolStep && onToolStep({ type: "approved", callId: p.tc.id, name: p.name });
        }

        // 单调用自动重试：暂时性错误指数退避（400ms→800ms），不可重试错误立即结束
        const runWithAutoRetry = async (execute) => {
          let last = null;
          let attempt = 0;
          for (attempt = 0; attempt <= TOOL_AUTO_RETRY; attempt++) {
            last = await execute();
            if (!last.isError) break;
            if (!last.retryable) break;
            if (attempt >= TOOL_AUTO_RETRY) break;
            onToolStep && onToolStep({
              type: "retrying", callId: p.tc.id, name: p.name,
              source: p.isLocalExec ? "local" : "web",
              attempt: attempt + 1, maxRetries: TOOL_AUTO_RETRY,
            });
            await sleep(400 * Math.pow(2, attempt));
          }
          return { ...last, attempt: attempt + 1 }; // 1-based：第几次尝试结束
        };

        if (p.isLocalExec) {
          // 本地执行工具（预置内置或用户自定义，均支持 async）
          console.info(`[${p.native ? "内置工具" : "自定义工具"}] 本地执行：${p.name}`, p.argsRaw);
          const res = await runWithAutoRetry(() =>
            p.native
              ? runNativeTool(p.name, p.argsRaw, { signal })
              : runLocalTool(p.localTool, p.argsRaw)
          );
          console.info(`[本地工具] ${p.name} 返回：`, res.content.slice(0, 300));
          return { kind: "local", res };
        }

        // 联网搜索 fiber（非 Abort 错误在 execute 内转为结果对象，AbortError 向上抛）
        console.info(`[联网搜索] 执行 fiber：${p.name}`, p.argsRaw);
        const execute = async () => {
          try {
            const { result, sources } = await runFiber(config, p.name, p.argsRaw, signal);
            return { content: result, isError: false, sources };
          } catch (err) {
            if (err?.name === "AbortError") throw err; // 用户中止必须向上传播
            const msg = String(err?.message || err || "联网搜索失败");
            return {
              content: JSON.stringify({ error: msg }),
              isError: true,
              retryable: isRetryableError(msg, err),
              errorMsg: msg,
            };
          }
        };
        const res = await runWithAutoRetry(execute);
        return { kind: "web", res };
      }));

      // 阶段 4：按原顺序回填 UI 结果、push role=tool 消息（顺序与 tool_calls 严格对齐）
      plans.forEach((p, idx) => {
        const o = outcomes[idx];
        if (o.rejected) {
          console.info(`[本地工具] 用户拒绝调用：${p.name}`);
          onToolStep && onToolStep({
            type: "result", callId: p.tc.id, name: p.name, source: "local",
            result: "用户拒绝了本次工具调用", rejected: true,
          });
          convo.push({
            role: "tool",
            tool_call_id: p.tc.id,
            content: JSON.stringify({ error: "用户拒绝了该工具调用，请不要再次调用它，改为直接说明情况或换个方案。" }),
          });
          return;
        }
        const res = o.res;
        if (o.kind === "local") {
          const isErr = res.isError;
          onToolStep && onToolStep({
            type: "result", callId: p.tc.id, name: p.name, source: "local",
            result: res.content.slice(0, 120), full: res.content, error: isErr,
            attempt: res.attempt, maxRetries: TOOL_AUTO_RETRY, retryable: res.retryable,
          });
          // 错误结果连同原因回传给模型，让模型有机会修正参数或换方案
          let contentStr = res.content;
          if (isErr) {
            let reason = "工具执行失败";
            try { reason = JSON.parse(res.content).error || reason; } catch {}
            const hint = res.retryable
              ? `已自动重试 ${TOOL_AUTO_RETRY} 次仍失败`
              : "该错误不可自动重试";
            contentStr = JSON.stringify({
              error: `${reason}（${hint}）。请检查参数是否正确，或改用其他方式完成任务，不要重复调用同一工具。`,
            });
          }
          convo.push({ role: "tool", tool_call_id: p.tc.id, content: contentStr });
        } else if (res.isError) {
          const reason = res.errorMsg || "联网搜索失败";
          console.warn(`[联网搜索] fiber 失败：${p.name}`, reason);
          onToolStep && onToolStep({
            type: "result", callId: p.tc.id, name: p.name, source: "web",
            result: `联网搜索失败：${reason}`.slice(0, 120),
            full: `联网搜索失败：${reason}\n\n${res.content}`, error: true,
            attempt: res.attempt, maxRetries: TOOL_AUTO_RETRY, retryable: res.retryable,
          });
          const hint = res.retryable
            ? `已自动重试 ${TOOL_AUTO_RETRY} 次仍失败`
            : "该错误不可自动重试";
          convo.push({
            role: "tool",
            tool_call_id: p.tc.id,
            content: JSON.stringify({
              error: `联网搜索工具执行失败：${reason}（${hint}）。请修正参数重试，或换个查询方式，不要重复调用。`,
            }),
          });
        } else {
          console.info(`[联网搜索] fiber 返回结果长度：${res.content.length}，来源数：${res.sources?.length || 0}`);
          onToolStep && onToolStep({
            type: "result", callId: p.tc.id, name: p.name, source: "web",
            result: "已获取联网搜索结果", full: res.content, error: false,
            attempt: res.attempt, maxRetries: TOOL_AUTO_RETRY,
          });
          if (res.sources?.length && onSources) onSources(res.sources);
          convo.push({ role: "tool", tool_call_id: p.tc.id, content: res.content });
        }
      });
      // 继续下一轮请求（tools 每轮都要带），模型基于工具结果输出最终回答
    }

    // 超过最大轮数仍未收敛：最后一轮的工具结果之后没有最终回答，按完成处理并提示
    console.warn(`[Agent 模式] 已达最大工具轮数 ${maxRounds}，停止循环`);
    onDone && onDone();
  } catch (err) {
    // AbortError 不是真正的错误，不触发 onError
    if (err.name === "AbortError") {
      console.info("[请求] 用户手动停止生成");
      onDone && onDone();
      return;
    }
    onError && onError(err);
  }
}
