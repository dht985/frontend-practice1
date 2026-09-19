// conversationTree.test.js：对话树的纯逻辑
import { describe, it, expect } from "vitest";
import {
  collectUserNodeIds,
  findNodeById,
  lastVisibleNode,
  makeNode,
  makeRoot,
  migrateConv,
  uid,
  visibleChain,
  visibleNodes,
} from "../conversationTree";

// 造一棵：root → u1 → a1 → u2(a2 / a2b 两个版本)
function sampleTree() {
  const root = makeRoot();
  const u1 = makeNode("user", "第一个问题");
  const a1 = makeNode("assistant", "第一个回答");
  const u2 = makeNode("user", "第二个问题");
  const a2 = makeNode("assistant", "回答 A");
  const a2b = makeNode("assistant", "回答 B");
  root.children.push(u1);
  u1.children.push(a1);
  a1.children.push(u2);
  u2.children.push(a2, a2b);
  u2.active = 1; // 选中第二个版本
  return { root, u1, a1, u2, a2, a2b };
}

describe("节点构造", () => {
  it("makeNode 生成带 id/children/active 的节点", () => {
    const node = makeNode("user", "你好", { streaming: true });
    expect(node.role).toBe("user");
    expect(node.content).toBe("你好");
    expect(node.children).toEqual([]);
    expect(node.active).toBe(0);
    expect(node.streaming).toBe(true);
    expect(typeof node.id).toBe("string");
  });

  it("extra.id 可以覆盖自动生成的 id（先算好 id 再塞进树时会用到）", () => {
    const node = makeNode("assistant", "", { id: "fixed-id" });
    expect(node.id).toBe("fixed-id");
  });

  it("uid 每次不同", () => {
    expect(uid()).not.toBe(uid());
  });
});

describe("visibleChain / visibleNodes", () => {
  it("沿 active 指针走出当前路径", () => {
    const { root } = sampleTree();
    expect(visibleNodes(root).map((n) => n.content)).toEqual([
      "第一个问题",
      "第一个回答",
      "第二个问题",
      "回答 B",
    ]);
  });

  it("切换 active 后路径随之变化（多版本分支）", () => {
    const { root, u2 } = sampleTree();
    u2.active = 0;
    expect(visibleNodes(root).map((n) => n.content).at(-1)).toBe("回答 A");
  });

  it("空树返回空路径", () => {
    expect(visibleChain(makeRoot())).toEqual([]);
    expect(visibleChain(null)).toEqual([]);
  });

  it("lastVisibleNode 返回路径末端", () => {
    const { root, a2b } = sampleTree();
    expect(lastVisibleNode(root).id).toBe(a2b.id);
    expect(lastVisibleNode(makeRoot())).toBeNull();
  });
});

describe("查找与遍历", () => {
  it("findNodeById 能找到任意分支上的节点", () => {
    const { root, a2, a2b } = sampleTree();
    expect(findNodeById(root, a2.id).content).toBe("回答 A");
    expect(findNodeById(root, a2b.id).content).toBe("回答 B");
    expect(findNodeById(root, "nope")).toBeNull();
  });

  it("collectUserNodeIds 收集所有分支上的 user 节点", () => {
    const { root, u1, u2 } = sampleTree();
    expect(collectUserNodeIds(root)).toEqual([u1.id, u2.id]);
  });
});

describe("migrateConv 旧结构迁移", () => {
  it("扁平 messages 转成对话树，并保留附件元信息", () => {
    const legacy = {
      id: "1000",
      title: "旧对话",
      messages: [
        { role: "user", content: "问题", attachments: [{ name: "a.png" }] },
        { role: "assistant", content: "回答" },
      ],
    };
    const conv = migrateConv(legacy);
    expect(conv.messages).toBeUndefined();
    expect(conv.tree.role).toBe("root");
    expect(conv.tree.children).toHaveLength(1);
    const [userNode] = conv.tree.children;
    expect(userNode.content).toBe("问题");
    expect(userNode.attachments).toEqual([{ name: "a.png" }]);
    expect(userNode.children[0].content).toBe("回答");
    expect(visibleNodes(conv.tree)).toHaveLength(2);
  });

  it("已经是树结构时原样返回（幂等）", () => {
    const existing = { id: "1000", title: "新结构", tree: makeRoot() };
    expect(migrateConv(existing)).toBe(existing);
  });

  it("没有 messages 时也能得到一个空树", () => {
    const conv = migrateConv({ id: "1000", title: "空" });
    expect(conv.tree.children).toEqual([]);
  });
});
