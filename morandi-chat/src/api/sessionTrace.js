// 本地会话诊断（session trace）
//
// 目的：出问题时能自己查——每次请求记录一轮「开始 → 各阶段 → 结束/报错」的结构化事件，
// 需要时导出成 JSON 自己看或贴给别人。只存在内存里，不上传任何地方。
//
// 隐私：只记长度、耗时、工具名、用量与错误信息，不记对话正文。

const MAX_TRACES = 30; // 保留最近多少次请求
const MAX_STEPS = 200; // 单条请求最多记多少步

let traces = []; // 最近的在前
let seq = 0;
const listeners = new Set();

const now = () =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();

function notify() {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // 单个订阅者出错不影响其它订阅者
    }
  }
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function startTrace(kind, meta = {}) {
  const trace = {
    id: `t${++seq}-${Date.now().toString(36)}`,
    kind,
    startedAt: new Date().toISOString(),
    t0: now(),
    steps: [],
    status: "running",
    meta,
  };
  traces.unshift(trace);
  if (traces.length > MAX_TRACES) traces = traces.slice(0, MAX_TRACES);
  notify();
  return trace.id;
}

export function addStep(traceId, type, data = {}) {
  const trace = traces.find((t) => t.id === traceId);
  if (!trace || trace.steps.length >= MAX_STEPS) return;
  trace.steps.push({ ms: Math.round(now() - trace.t0), type, ...data });
  notify();
}

export function endTrace(traceId, patch = {}) {
  const trace = traces.find((t) => t.id === traceId);
  if (!trace || trace.status !== "running") return;
  trace.durationMs = Math.round(now() - trace.t0);
  trace.status = patch.status || "done";
  for (const [key, value] of Object.entries(patch)) {
    if (key !== "status") trace[key] = value;
  }
  notify();
}

export function listTraces() {
  return traces.map((t) => ({ ...t, steps: t.steps.map((s) => ({ ...s })) }));
}

export function traceCount() {
  return traces.length;
}

export function clearTraces() {
  traces = [];
  notify();
}

// 导出成 JSON 文本（下载用）
export function exportTraces() {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
      count: traces.length,
      traces: listTraces(),
    },
    null,
    2
  );
}

// 测试辅助
export function _resetTraces() {
  traces = [];
  seq = 0;
  listeners.clear();
}
