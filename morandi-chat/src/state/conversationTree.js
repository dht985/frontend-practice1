// 对话树的纯逻辑：节点构造、可见路径、遍历、旧结构迁移。
// 从 App.jsx 抽出来，一是能单独测试，二是别让 App 继续膨胀。
//
// 树结构：节点 { id, role, content, children: [], active, ...UI字段 }
// conversation.tree 是虚拟根（role: "root"），只承载 children / active。

export const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export const makeNode = (role, content, extra = {}) => ({
  id: uid(),
  role,
  content,
  children: [],
  active: 0,
  ...extra,
});

export const makeRoot = () => ({ id: uid(), role: "root", content: "", children: [], active: 0 });

// 沿 active 指针走出的当前可见路径，返回 [{ node, parent, index }]（parent 含虚拟根）
export function visibleChain(tree) {
  const chain = [];
  if (!tree || !tree.children.length) return chain;
  let parent = tree;
  let idx = Math.min(Math.max(tree.active, 0), tree.children.length - 1);
  for (;;) {
    const node = parent.children[idx];
    chain.push({ node, parent, index: idx });
    if (!node.children.length) break;
    parent = node;
    idx = Math.min(Math.max(node.active, 0), node.children.length - 1);
  }
  return chain;
}

export function visibleNodes(tree) {
  return visibleChain(tree).map((entry) => entry.node);
}

export function lastVisibleNode(tree) {
  const chain = visibleChain(tree);
  return chain.length ? chain[chain.length - 1].node : null;
}

// 按 id 在整棵树（含所有分支）里找节点
export function findNodeById(tree, id) {
  if (!tree) return null;
  if (tree.id === id) return tree;
  for (const child of tree.children || []) {
    const hit = findNodeById(child, id);
    if (hit) return hit;
  }
  return null;
}

// 收集树上所有 user 节点的 id（删除对话时联动清理附件）
export function collectUserNodeIds(tree) {
  const ids = [];
  const walk = (node) => {
    if (!node) return;
    if (node.role === "user") ids.push(node.id);
    for (const child of node.children || []) walk(child);
  };
  walk(tree);
  return ids;
}

// 深拷贝一棵树（更新前先克隆，避免直接改到 state 里的对象）
export function cloneTree(tree) {
  return structuredClone(tree || makeRoot());
}

// 旧版扁平 messages → 树结构（一次性迁移）
export function migrateConv(conversation) {
  if (conversation?.tree) return conversation;
  const root = makeRoot();
  let parent = root;
  for (const message of conversation?.messages || []) {
    const node = makeNode(message.role, message.content);
    if (message.attachments) node.attachments = message.attachments;
    parent.children.push(node);
    parent = node;
  }
  const out = { ...conversation, tree: root };
  delete out.messages;
  return out;
}
