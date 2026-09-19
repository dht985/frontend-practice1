// liveStreamBuffer.test.js：流式缓冲的节流与收尾
// 用注入的假定时器，测试不依赖真实时间。
import { describe, it, expect, vi } from "vitest";
import { createLiveStreamBuffer } from "../liveStreamBuffer";

function setup() {
  const snapshots = [];
  const timers = new Map();
  let nextId = 1;
  const setTimer = vi.fn((fn) => {
    const id = nextId++;
    timers.set(id, fn);
    return id;
  });
  const clearTimer = vi.fn((id) => timers.delete(id));
  const buffer = createLiveStreamBuffer({
    intervalMs: 60,
    onSnapshot: (snap) => snapshots.push(snap),
    setTimer,
    clearTimer,
  });
  const runTimers = () => {
    const pending = [...timers.entries()];
    timers.clear();
    for (const [, fn] of pending) fn();
  };
  return { buffer, snapshots, setTimer, clearTimer, runTimers, pendingCount: () => timers.size };
}

describe("createLiveStreamBuffer", () => {
  it("begin 会立即推一份快照（界面好显示「正在思考」）", () => {
    const { buffer, snapshots } = setup();
    buffer.begin("conv-1", "node-1");
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toEqual({ convId: "conv-1", nodeId: "node-1", text: "", reasoning: "" });
  });

  it("begin 可以带基线文本（继续生成时接着已有内容往后写）", () => {
    const { buffer } = setup();
    buffer.begin("conv-1", "node-1", "已经写了一半");
    expect(buffer.snapshot().text).toBe("已经写了一半");
  });

  it("连续 token 只安排一次定时器，节流后才推快照", () => {
    const { buffer, snapshots, runTimers, pendingCount } = setup();
    buffer.begin("conv-1", "node-1");
    snapshots.length = 0;

    buffer.appendText("你");
    buffer.appendText("好");
    buffer.appendText("世界");

    expect(pendingCount()).toBe(1); // 只挂了一个定时器
    expect(snapshots).toHaveLength(0); // 还没到节流窗口，界面不更新
    runTimers();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].text).toBe("你好世界");
  });

  it("正文与思考过程分开累积", () => {
    const { buffer, snapshots, runTimers } = setup();
    buffer.begin("conv-1", "node-1");
    snapshots.length = 0;
    buffer.appendReasoning("先想一下");
    buffer.appendText("答案");
    runTimers();
    expect(snapshots[0].reasoning).toBe("先想一下");
    expect(snapshots[0].text).toBe("答案");
  });

  it("end 返回最终文本与思考过程，并清空缓冲、取消未触发的定时器", () => {
    const { buffer, snapshots, pendingCount, clearTimer } = setup();
    buffer.begin("conv-1", "node-1");
    buffer.appendText("前半段");
    buffer.appendReasoning("思考");

    const result = buffer.end();

    expect(result).toEqual({ text: "前半段", reasoning: "思考" });
    expect(pendingCount()).toBe(0);
    expect(clearTimer).toHaveBeenCalled();
    expect(buffer.snapshot()).toBeNull();
    expect(snapshots.at(-1)).toBeNull(); // 通知界面清空实时区域
  });

  it("没有 begin 过时 append 不影响任何东西（防御性）", () => {
    const { buffer, snapshots, pendingCount } = setup();
    buffer.appendText("野 token");
    buffer.appendReasoning("野思考");
    expect(snapshots).toHaveLength(0);
    expect(pendingCount()).toBe(0);
  });

  it("end 之后再来 token 会被忽略（请求已结束）", () => {
    const { buffer, snapshots, runTimers } = setup();
    buffer.begin("conv-1", "node-1");
    buffer.end();
    snapshots.length = 0;
    buffer.appendText("迟到的 token");
    runTimers();
    expect(snapshots).toHaveLength(0);
  });

  it("flush 立即推送当前缓冲内容", () => {
    const { buffer, snapshots, pendingCount } = setup();
    buffer.begin("conv-1", "node-1");
    buffer.appendText("内容");
    snapshots.length = 0;
    buffer.flush();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].text).toBe("内容");
    expect(pendingCount()).toBe(0);
  });
});
