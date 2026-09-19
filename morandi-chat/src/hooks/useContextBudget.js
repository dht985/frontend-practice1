// 上下文预算 hook：把「按预算裁剪历史 + 记录裁剪提示」收在一处。
// 依赖原样注入（workbench 参数、附件表），保持纯函数可测。

import { useState } from "react";
import {
  DEFAULT_CONTEXT_WINDOW,
  estimateMessagesTokens,
  reservedOutputTokens,
  trimNodesToBudget,
} from "../api/contextBudget";

export default function useContextBudget({ workbench, attachmentsRef }) {
  const [trimNotice, setTrimNotice] = useState(null);

  // 固定部分（system 提示、本轮提问、回灌内容）先扣掉，再从最早的整轮开始丢弃
  const planHistory = (nodes, { convId, systemMessages = [], extraFixed = [] }) => {
    const plan = trimNodesToBudget(nodes, attachmentsRef.current, {
      budgetTokens: workbench.contextWindow || DEFAULT_CONTEXT_WINDOW,
      reservedTokens: reservedOutputTokens(workbench.maxTokens),
      fixedTokens: estimateMessagesTokens([...systemMessages, ...extraFixed]),
    });
    setTrimNotice(
      plan.droppedTurns > 0
        ? {
            convId,
            droppedTurns: plan.droppedTurns,
            estimatedTokens: plan.estimatedTokens,
            budgetTokens: plan.budgetTokens,
          }
        : null
    );
    return plan;
  };

  return { planHistory, trimNotice };
}
