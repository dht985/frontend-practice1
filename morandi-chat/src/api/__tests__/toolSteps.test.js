// toolSteps.test.js：工具步骤终态收口 / 停止标记消费 / callId 收集的回归测试
// 对应修复：
//   一、继续生成后停止的 stopped 状态残留（并污染下一次请求）
//   二、停止时工具步骤不再被误标为“调用成功”，统一收口为 stopped
import { describe, it, expect } from "vitest";
import {
  finalizeToolSteps,
  failToolSteps,
  consumeStopFlag,
  collectToolStepIds,
} from "../toolSteps";

// 构造步骤的小工厂，减少重复字面量
const step = (id, status, extra = {}) => ({ id, name: id, status, ...extra });

describe("finalizeToolSteps - 用户主动停止（stopped=true）", () => {
  it("running → stopped（不再显示“调用成功”）", () => {
    const steps = [step("a", "running")];
    finalizeToolSteps(steps, true);
    expect(steps[0].status).toBe("stopped");
  });

  it("retrying → stopped（自动重试退避中被停止也要收口）", () => {
    const steps = [step("a", "retrying", { retry: 1, maxRetry: 2 })];
    finalizeToolSteps(steps, true);
    expect(steps[0].status).toBe("stopped");
  });

  it("awaiting → rejected（等待确认时被停止，显示“已拒绝，未执行”）", () => {
    const steps = [step("a", "awaiting")];
    finalizeToolSteps(steps, true);
    expect(steps[0].status).toBe("rejected");
  });

  it("已终态的步骤保持不变：done/error/rejected/stopped", () => {
    const steps = [
      step("d", "done"),
      step("e", "error"),
      step("r", "rejected"),
      step("s", "stopped"),
    ];
    finalizeToolSteps(steps, true);
    expect(steps.map((s) => s.status)).toEqual(["done", "error", "rejected", "stopped"]);
  });

  it("混合批次按各自状态收口（模拟工具执行中途点停止）", () => {
    const steps = [
      step("done-1", "done", { result: "ok" }),
      step("run-1", "running"),
      step("await-1", "awaiting"),
      step("err-1", "error", { canRetry: true }),
      step("retry-1", "retrying", { retry: 1 }),
    ];
    finalizeToolSteps(steps, true);
    expect(steps.map((s) => s.status)).toEqual([
      "done",
      "stopped",
      "rejected",
      "error",
      "stopped",
    ]);
  });
});

describe("finalizeToolSteps - 正常完成（stopped=false）", () => {
  it("running → done", () => {
    const steps = [step("a", "running")];
    finalizeToolSteps(steps, false);
    expect(steps[0].status).toBe("done");
  });

  it("retrying → done（防御：正常收敛时不应残留重试态）", () => {
    const steps = [step("a", "retrying")];
    finalizeToolSteps(steps, false);
    expect(steps[0].status).toBe("done");
  });

  it("awaiting → rejected", () => {
    const steps = [step("a", "awaiting")];
    finalizeToolSteps(steps, false);
    expect(steps[0].status).toBe("rejected");
  });

  it("error 状态保持为错误，不被改成 done", () => {
    const steps = [step("a", "error", { canRetry: true })];
    finalizeToolSteps(steps, false);
    expect(steps[0].status).toBe("error");
    expect(steps[0].canRetry).toBe(true);
  });

  it("rejected / stopped 终态保持不变", () => {
    const steps = [step("a", "rejected"), step("b", "stopped")];
    finalizeToolSteps(steps, false);
    expect(steps.map((s) => s.status)).toEqual(["rejected", "stopped"]);
  });

  it("非数组输入安全返回，不抛错", () => {
    expect(finalizeToolSteps(undefined, false)).toBeUndefined();
    expect(finalizeToolSteps(null, true)).toBeNull();
  });
});

describe("failToolSteps - 异常结束路径（onError）", () => {
  it("running → error", () => {
    const steps = [step("a", "running")];
    failToolSteps(steps);
    expect(steps[0].status).toBe("error");
  });

  it("retrying → error", () => {
    const steps = [step("a", "retrying", { retry: 2, maxRetry: 2 })];
    failToolSteps(steps);
    expect(steps[0].status).toBe("error");
  });

  it("awaiting → rejected", () => {
    const steps = [step("a", "awaiting")];
    failToolSteps(steps);
    expect(steps[0].status).toBe("rejected");
  });

  it("已是 error 的步骤保持 error（错误不混用）", () => {
    const steps = [step("a", "error", { result: "旧失败原因" })];
    failToolSteps(steps);
    expect(steps[0].status).toBe("error");
    expect(steps[0].result).toBe("旧失败原因");
  });

  it("done / rejected / stopped 终态不被改动", () => {
    const steps = [step("a", "done"), step("b", "rejected"), step("c", "stopped")];
    failToolSteps(steps);
    expect(steps.map((s) => s.status)).toEqual(["done", "rejected", "stopped"]);
  });

  it("非数组输入安全返回，不抛错", () => {
    expect(failToolSteps(undefined)).toBeUndefined();
  });
});

describe("consumeStopFlag - 停止标记只消费一次并重置", () => {
  it("标记为 true：消费返回 true 且立刻重置为 false", () => {
    const holder = { current: true };
    expect(consumeStopFlag(holder)).toBe(true);
    expect(holder.current).toBe(false);
  });

  it("标记为 false：消费返回 false，保持 false", () => {
    const holder = { current: false };
    expect(consumeStopFlag(holder)).toBe(false);
    expect(holder.current).toBe(false);
  });

  it("连续两次消费：第二次必为 false（不会重复读到旧标记）", () => {
    const holder = { current: true };
    expect(consumeStopFlag(holder)).toBe(true);
    expect(consumeStopFlag(holder)).toBe(false);
  });

  it("holder 缺失时安全返回 false", () => {
    expect(consumeStopFlag(null)).toBe(false);
    expect(consumeStopFlag(undefined)).toBe(false);
  });
});

// —— 场景级回归：按 App.jsx 三条结束路径的实际使用方式驱动纯函数 ——
// 模拟 onDone 回调对消息节点的收口动作（与 App.jsx 中逻辑同构）
function simulateOnDone(node, flag, { usage = null } = {}) {
  // 请求启动时的防御性重置发生在 simulateRequestStart；此处只做 onDone 体
  const stopped = consumeStopFlag(flag);
  node.streaming = false;
  node.stopped = stopped;
  finalizeToolSteps(node.toolSteps, stopped);
  if (usage) node.usage = usage;
  return node;
}
const simulateRequestStart = (flag) => {
  flag.current = false; // 与 App.jsx 三处 controller 创建旁的重置一致
};

describe("场景回归 - 已有内容继续生成后停止（修复一/二核心链路）", () => {
  it("继续生成途中停止：消息保留 stopped=true，运行中的步骤为 stopped", () => {
    const flag = { current: false };
    const node = {
      streaming: true,
      stopped: false,
      content: "已写出的部分内容",
      toolSteps: [step("run-1", "running"), step("done-1", "done")],
    };

    // 用户点停止（handleStop 同步置位），chat.js 因 AbortError 走 onDone
    flag.current = true;
    simulateOnDone(node, flag);

    expect(node.stopped).toBe(true); // “继续生成”入口必须保留
    expect(node.streaming).toBe(false);
    expect(node.toolSteps.map((s) => s.status)).toEqual(["stopped", "done"]);
  });

  it("紧接着发送新消息并正常完成：不被上一次停止标记误标，步骤正常 done", () => {
    const flag = { current: false };

    // 第一段：继续生成被停止
    const first = { streaming: true, stopped: false, content: "半截回答", toolSteps: [step("t1", "running")] };
    flag.current = true;
    simulateOnDone(first, flag);
    expect(first.stopped).toBe(true);

    // 第二段：用户发新消息（请求启动重置），服务端正常结束
    simulateRequestStart(flag);
    const next = { streaming: true, stopped: false, content: "", toolSteps: [step("t2", "running")] };
    simulateOnDone(next, flag, { usage: { prompt_tokens: 1, completion_tokens: 2 } });

    expect(flag.current).toBe(false);
    expect(next.stopped).toBe(false); // 不能误标“已停止”
    expect(next.toolSteps[0].status).toBe("done"); // 不能显示“已停止/调用成功”错乱
    expect(next.usage).toEqual({ prompt_tokens: 1, completion_tokens: 2 });
  });

  it("等待确认的步骤在停止后为 rejected（已拒绝，未执行）", () => {
    const flag = { current: true };
    const node = { streaming: true, stopped: false, toolSteps: [step("t1", "awaiting")] };
    simulateOnDone(node, flag);
    expect(node.toolSteps[0].status).toBe("rejected");
    expect(node.stopped).toBe(true);
  });
});

describe("场景回归 - 正常路径不回归", () => {
  it("普通发送正常完成：stopped=false，步骤 done", () => {
    const flag = { current: false };
    const node = { streaming: true, stopped: false, content: "", toolSteps: [step("t1", "running")] };
    simulateOnDone(node, flag);
    expect(node.stopped).toBe(false);
    expect(node.toolSteps[0].status).toBe("done");
  });

  it("工具失败后正常结束：error 步骤保持 error 且 canRetry 保留", () => {
    const flag = { current: false };
    const node = {
      streaming: true,
      stopped: false,
      toolSteps: [step("t1", "done"), step("t2", "error", { canRetry: true, result: "失败预览" })],
    };
    simulateOnDone(node, flag);
    expect(node.toolSteps.map((s) => s.status)).toEqual(["done", "error"]);
    expect(node.toolSteps[1].canRetry).toBe(true);
  });

  it("onError 收口：running→error、awaiting→rejected，原有 error 不变", () => {
    const node = {
      streaming: false,
      stopped: false,
      toolSteps: [step("a", "running"), step("b", "awaiting"), step("c", "error")],
    };
    failToolSteps(node.toolSteps);
    expect(node.toolSteps.map((s) => s.status)).toEqual(["error", "rejected", "error"]);
  });

  it("无工具步骤的普通对话正常完成不报错", () => {
    const flag = { current: false };
    const node = { streaming: true, stopped: false, content: "", toolSteps: undefined };
    expect(() => simulateOnDone(node, flag)).not.toThrow();
    expect(node.stopped).toBe(false);
  });
});

describe("collectToolStepIds - 删除对话时联动清理", () => {
  it("递归收集所有分支（含非 active 的历史版本）上的 callId", () => {
    // root → user → assistant(active, 含 t1/t2)
    //                  ↘ 旧版本 assistant(t3)
    const tree = {
      role: "root",
      children: [
        {
          role: "user",
          children: [
            { role: "assistant", toolSteps: [step("t1", "done"), step("t2", "stopped")], children: [] },
            { role: "assistant", toolSteps: [step("t3", "done")], children: [] },
          ],
        },
      ],
    };
    expect(collectToolStepIds(tree).sort()).toEqual(["t1", "t2", "t3"]);
  });

  it("callId 去重（手动重试复用同一 id 不重复返回）", () => {
    const tree = {
      role: "root",
      children: [{ role: "assistant", toolSteps: [step("t1", "error"), step("t1", "running")], children: [] }],
    };
    expect(collectToolStepIds(tree)).toEqual(["t1"]);
  });

  it("没有任何 toolSteps 时返回空数组", () => {
    const tree = { role: "root", children: [{ role: "user", content: "hi", children: [] }] };
    expect(collectToolStepIds(tree)).toEqual([]);
  });

  it("空树/异常输入安全返回空数组", () => {
    expect(collectToolStepIds(null)).toEqual([]);
    expect(collectToolStepIds(undefined)).toEqual([]);
    expect(collectToolStepIds({})).toEqual([]);
  });
});
