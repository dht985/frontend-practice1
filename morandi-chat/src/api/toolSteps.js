// 工具调用步骤（toolSteps）的终态收口与辅助逻辑
//
// 步骤状态机：
//   进行态：running（执行中）、retrying（自动重试退避中）、awaiting（等待人工确认）
//   终态：  done（成功）、error（失败）、rejected（用户拒绝，未执行）、stopped（用户停止，未完成）
//
// 抽成纯函数的原因：普通发送 / 空内容继续 / 已有内容继续三条 onDone 路径收口规则必须一致，
// 且纯函数无需渲染 React 即可写单元测试。

// 请求正常结束（onDone）时，把仍处于进行态的步骤收敛为终态（原地修改并返回原数组）
// stopped=true（用户主动停止）：running/retrying → stopped；awaiting → rejected
// stopped=false（正常完成）：    running/retrying → done；   awaiting → rejected
// 已是终态（done/error/rejected/stopped）的步骤保持不变
export function finalizeToolSteps(steps, stopped) {
  if (!Array.isArray(steps)) return steps;
  for (const s of steps) {
    if (s.status === "running" || s.status === "retrying") {
      s.status = stopped ? "stopped" : "done";
    } else if (s.status === "awaiting") {
      // 等待确认期间请求结束（含被停止）：一律按用户未批准处理
      s.status = "rejected";
    }
  }
  return steps;
}

// 请求异常结束（onError）时的收口：进行中/重试中的步骤记为失败，等待确认记为拒绝
// 已终态步骤保持不变（error 不会被误改成别的状态）
export function failToolSteps(steps) {
  if (!Array.isArray(steps)) return steps;
  for (const s of steps) {
    if (s.status === "running" || s.status === "retrying") {
      s.status = "error";
    } else if (s.status === "awaiting") {
      s.status = "rejected";
    }
  }
  return steps;
}

// 读取并一次性重置“本次请求是否被用户手动停止”标记。
// 每条结束路径（onDone/onError 互斥只会走一条）都通过它消费标记，
// 保证只消费一次且不会残留污染下一次请求。
// holder 为 useRef 对象（{ current: boolean }）
export function consumeStopFlag(holder) {
  if (!holder) return false;
  const stopped = !!holder.current;
  holder.current = false;
  return stopped;
}

// 递归遍历整棵对话树（含所有历史分支，不仅是当前可见路径），
// 收集全部 assistant 节点上 toolSteps 的 callId（去重）。
// 用于删除对话时联动清理 IndexedDB / 内存中的工具结果全文。
export function collectToolStepIds(tree) {
  const ids = new Set();
  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node.toolSteps)) {
      for (const s of node.toolSteps) {
        if (s && typeof s.id === "string") ids.add(s.id);
      }
    }
    for (const child of node.children || []) walk(child);
  };
  walk(tree);
  return [...ids];
}
