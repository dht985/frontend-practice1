// 兼容 OpenAI 格式的流式对话（多服务商，能力见 providers.js）
// 工具循环（标准 function 流程），两类工具共用：
//   1. 联网搜索（Kimi）：走官方 Formula 工具通道
//      GET /formulas/moonshot/web-search:latest/tools  获取声明
//      → POST /chat/completions（带 tools）            模型返回 tool_calls
//      → POST /formulas/.../fibers                     执行联网搜索
//      → POST /chat/completions（回传 tool 结果）       得到最终回答
//   2. 自定义 JS 工具（工作台定义）：声明随请求下发，tool_calls 由前端本地执行

import { getProvider, getParamCaps } from "./providers";
import { compileTools, runLocalTool } from "./tools";

const FORMULA_URI = "moonshot/web-search:latest";
const MAX_TOOL_ROUNDS = 6; // 防止异常情况下工具调用无限循环

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
async function runFiber(config, name, args, signal) {
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
// await streamChat({ messages, systemMessages, config, webSearch, customTools, onChunk, onStatus, onDone, onError })
// customTools: 工作台启用的自定义工具项数组（见 tools.js）
export async function streamChat({
  messages,
  systemMessages = [],
  config,
  webSearch = false,
  customTools = [],
  structured = false,
  schemaText = "",
  genParams = {},
  signal,
  onChunk,
  onStatus,
  onSources,
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
    // 自定义 JS 工具（工作台定义，本地执行）→ OpenAI function 声明
    const custom = compileTools(customTools);
    if (custom.declarations.length) {
      console.info(
        `[自定义工具] 已启用 ${custom.declarations.length} 个：`,
        custom.declarations.map((d) => d.function.name)
      );
    }
    const toolDecls = [...(wsTools || []), ...custom.declarations];
    console.info(
      `[请求] 服务商：${config.provider}，模型：${config.model}，联网搜索：${!!wsTools}，自定义工具：${custom.declarations.length} 个`
    );
    if (toolDecls.length) console.info(`[工具] 工具声明已加载：${toolDecls.length} 个`, toolDecls);

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

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
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

      // 逐个执行 tool_call 并以 role=tool 消息回传（id 必须一一对齐）
      for (const tc of toolCalls) {
        const name = tc.function?.name || "";
        const localTool = custom.executors.get(name);
        if (localTool) {
          // 自定义工具：前端本地执行（支持 async 函数体）
          console.info(`[自定义工具] 本地执行：${name}`, tc.function.arguments);
          onStatus && onStatus("tool", name);
          const out = await runLocalTool(localTool, tc.function.arguments);
          console.info(`[自定义工具] ${name} 返回：`, String(out).slice(0, 300));
          convo.push({ role: "tool", tool_call_id: tc.id, content: out });
        } else {
          // 其余视为联网搜索 fiber
          console.info(`[联网搜索] 执行 fiber：${name}`, tc.function.arguments);
          onStatus && onStatus("searching");
          const { result, sources } = await runFiber(config, name, tc.function.arguments, signal);
          console.info(`[联网搜索] fiber 返回结果长度：${result.length}，来源数：${sources.length}`);
          if (sources.length && onSources) onSources(sources);
          convo.push({ role: "tool", tool_call_id: tc.id, content: result });
        }
      }
      // 继续下一轮请求（tools 每轮都要带），模型基于工具结果输出最终回答
    }

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
