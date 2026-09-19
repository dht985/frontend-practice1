// 流式文本缓冲（纯逻辑，不依赖 React）
//
// 为什么需要：模型每秒可能吐几十个 token，如果每个 token 都触发一次状态更新 +
// 整棵树深拷贝，长回答就会卡。这里把 token 先写进缓冲，按节流窗口合并成快照，
// 由调用方（hook）决定怎么渲染；对话树只在开始/工具步骤/结束时写回。
//
// 正文与思考过程（reasoning）分开累积：思考过程只用于"思考中"折叠块。

export function createLiveStreamBuffer({
  intervalMs = 60,
  onSnapshot,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let current = null; // { convId, nodeId, text, reasoning }
  let timer = null;

  const emit = () => onSnapshot?.(current ? { ...current } : null);

  const schedule = () => {
    if (timer) return;
    timer = setTimer(() => {
      timer = null;
      emit();
    }, intervalMs);
  };

  const cancelTimer = () => {
    if (timer) {
      clearTimer(timer);
      timer = null;
    }
  };

  return {
    begin(convId, nodeId, baseText = "") {
      current = { convId, nodeId, text: typeof baseText === "string" ? baseText : "", reasoning: "" };
      emit();
    },
    appendText(chunk) {
      if (!current || !chunk) return;
      current.text += chunk;
      schedule();
    },
    appendReasoning(chunk) {
      if (!current || !chunk) return;
      current.reasoning += chunk;
      schedule();
    },
    // 立即把当前缓冲推给界面（不影响节流状态）
    flush() {
      cancelTimer();
      emit();
    },
    // 结束并取回最终文本与思考过程（正常结束、停止、出错都要调用）
    end() {
      cancelTimer();
      const snapshot = current;
      current = null;
      emit();
      return { text: snapshot?.text ?? "", reasoning: snapshot?.reasoning ?? "" };
    },
    snapshot() {
      return current ? { ...current } : null;
    },
  };
}
