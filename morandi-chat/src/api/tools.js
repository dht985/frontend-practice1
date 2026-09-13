// 自定义 JS 函数工具（AI 工作台定义，前端 new Function 本地执行，思路同 Google AI Studio）
// 工具项：{ id, name, description, parameters(JSON Schema 字符串), code, enabled, builtin }
// 发送时把启用的工具转成 OpenAI function 声明随请求下发；模型返回 tool_calls 后本地执行并回传结果。

const TOOLS_KEY = "morandi-chat-tools";

// 内置示例工具（不可删除，可启停/编辑/复制）
export const BUILTIN_TOOLS = [
  {
    id: "builtin-clock",
    name: "current_timestamp",
    description: "获取当前的 Unix 时间戳（毫秒），可用来推算当前日期时间",
    parameters: '{"type":"object","properties":{}}',
    code: String.raw`// args 为模型传入的参数对象
return Date.now();`,
    enabled: true,
    builtin: true,
  },
  {
    id: "builtin-calc",
    name: "calculator",
    description: "简单四则运算计算器，输入算术表达式返回计算结果",
    parameters:
      '{"type":"object","properties":{"expression":{"type":"string","description":"四则运算表达式，如 (1+2)*3/4"}},"required":["expression"]}',
    code: String.raw`const expr = String(args.expression ?? "").trim();
if (!/^[0-9+\-*/().%\s]+$/.test(expr)) {
  throw new Error("只支持数字与 + - * / ( ) % 组成的表达式");
}
const result = Function('"use strict"; return (' + expr + ')')();
return { expression: expr, result };`,
    enabled: true,
    builtin: true,
  },
  {
    id: "builtin-dice",
    name: "roll_dice",
    description: "掷骰子，返回每次的点数与总点数",
    parameters:
      '{"type":"object","properties":{"sides":{"type":"integer","description":"骰子面数，默认 6"},"count":{"type":"integer","description":"掷几次，默认 1"}}}',
    code: String.raw`const sides = Math.max(2, Math.min(100, Number(args.sides) || 6));
const count = Math.max(1, Math.min(20, Number(args.count) || 1));
const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides));
return { rolls, total: rolls.reduce((a, b) => a + b, 0) };`,
    enabled: true,
    builtin: true,
  },
];

// 读取工具库（首次使用时写入内置示例）
export function loadToolLib() {
  try {
    const raw = localStorage.getItem(TOOLS_KEY);
    if (raw) {
      const list = JSON.parse(raw);
      if (Array.isArray(list)) return list;
    }
  } catch {
    // 数据损坏按首次使用处理
  }
  localStorage.setItem(TOOLS_KEY, JSON.stringify(BUILTIN_TOOLS));
  return BUILTIN_TOOLS.map((t) => ({ ...t }));
}

export function saveToolLib(list) {
  localStorage.setItem(TOOLS_KEY, JSON.stringify(list));
}

// 规范化工具名：OpenAI function 名只允许字母/数字/下划线/中划线，重名自动加序号
function sanitizeToolName(name, used) {
  let n = String(name || "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 64);
  if (!n) n = "tool";
  else if (/^[0-9]/.test(n)) n = `_${n}`;
  const base = n;
  let i = 2;
  while (used.has(n)) n = `${base}_${i++}`;
  used.add(n);
  return n;
}

// 把启用的工具编译成 OpenAI function 声明 + 本地执行器映射（名称 → 工具项）
// reserved：内置工具占用的名称，用户自定义工具重名时自动改名，避免声明冲突
export function compileTools(tools, reserved = []) {
  const used = new Set(reserved);
  const declarations = [];
  const executors = new Map();
  for (const t of tools || []) {
    if (!t || !t.enabled || !t.code || !t.code.trim()) continue;
    const name = sanitizeToolName(t.name, used);
    let params;
    try {
      params = JSON.parse(t.parameters || "{}");
    } catch {
      params = {}; // Schema 不合法时回退为空参数模式
    }
    if (!params || typeof params !== "object" || Array.isArray(params)) params = {};
    if (!params.type) params.type = "object";
    if (!params.properties) params.properties = {};
    declarations.push({
      type: "function",
      function: { name, description: t.description || "", parameters: params },
    });
    executors.set(name, t);
  }
  return { declarations, executors };
}

// 判断错误是否为可自动重试的暂时性错误（网络/超时/5xx/429 等）
// 参数错误、权限错误、工具不存在、语法/运行时类型错误等不自动重试
export function isRetryableError(msg, err) {
  const s = String(msg || err?.message || "").toLowerCase();
  // HTTP 状态码：429/5xx 可重试，其余 4xx 不可重试
  const statusMatch = s.match(/\b(\d{3})\b/);
  if (statusMatch) {
    const code = Number(statusMatch[1]);
    if (code === 429 || (code >= 500 && code <= 504)) return true;
    if (code >= 400 && code < 500) return false;
  }
  // 网络/超时/限流等暂时性关键字
  if (/timeout|timed\s*out|econnreset|econnrefused|etimedout|network|fetch|网络|超时|临时|暂时|temporar|rate\s*limit|too\s*many|unavailable|overloaded|bad\s*gateway|gateway\s*timeout|service\s*unavailable/.test(s)) {
    return true;
  }
  // 明显不可重试：参数/权限/不存在/语法/引用/类型(非网络)
  if (/invalid|参数|不合法|permission|权限|unauthor|forbidden|not\s*found|不存在|syntax|referenceerror|undefined\s+is\s+not|cannot\s+read|is\s+not\s+a\s+function|json\.parse|unexpected\s+token/.test(s)) {
    return false;
  }
  // 未知错误默认不自动重试，避免无脑重试浪费时间
  return false;
}

// 本地执行一次工具调用，返回 { content, isError, retryable }
// content: 回传给模型的字符串内容；执行出错时以 {"error": "..."} 回传，让模型看到原因后自行调整
export async function runLocalTool(tool, argsJson) {
  let args = {};
  try {
    args = argsJson ? JSON.parse(argsJson) : {};
  } catch {
    // 模型给的参数不是合法 JSON，按空参数执行
  }
  try {
    const fn = new Function("args", tool.code);
    const out = await fn(args);
    const content = typeof out === "string" ? out : JSON.stringify(out ?? null);
    return { content, isError: false, retryable: false };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.warn(`[自定义工具] ${tool.name} 执行出错：${msg}`);
    return {
      content: JSON.stringify({ error: msg }),
      isError: true,
      retryable: isRetryableError(msg, err),
    };
  }
}
