// todo_list 内置工具的存储层：localStorage 持久化，key 固定为 morandi-chat-todos。
// Todo 结构：{ id, title, completed, createdAt, updatedAt }

export const TODOS_KEY = "morandi-chat-todos";
const MAX_TODOS = 200;
const TITLE_MAX = 500;

function genId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `t_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

// 读取并容错：数据损坏/字段缺失时尽量规整，不让单条坏数据搞挂整个列表
function readAll() {
  let arr = [];
  try {
    const raw = localStorage.getItem(TODOS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) arr = parsed;
    }
  } catch {
    return [];
  }
  return arr
    .filter((t) => t && typeof t === "object" && typeof t.id === "string" && typeof t.title === "string")
    .map((t) => ({
      id: t.id,
      title: String(t.title),
      completed: !!t.completed,
      createdAt: typeof t.createdAt === "string" ? t.createdAt : new Date(0).toISOString(),
      updatedAt: typeof t.updatedAt === "string" ? t.updatedAt : new Date(0).toISOString(),
    }));
}

function writeAll(list) {
  localStorage.setItem(TODOS_KEY, JSON.stringify(list.slice(0, MAX_TODOS)));
}

// 列表默认未完成在前，同状态内新的在前，方便模型与用户阅读
function present(list) {
  return list
    .slice()
    .sort((a, b) => Number(a.completed) - Number(b.completed) || b.createdAt.localeCompare(a.createdAt));
}

export function todoAdd(rawTitle, completed = false) {
  const title = String(rawTitle ?? "").trim();
  if (!title) throw new Error("参数不合法：add 操作必须提供非空 title");
  const list = readAll();
  if (list.length >= MAX_TODOS) {
    throw new Error(`待办数量已达上限（${MAX_TODOS} 条），请先 complete 或 delete 部分待办`);
  }
  const now = new Date().toISOString();
  const todo = {
    id: genId(),
    title: title.slice(0, TITLE_MAX),
    completed: !!completed,
    createdAt: now,
    updatedAt: now,
  };
  list.push(todo);
  writeAll(list);
  return { ok: true, action: "add", todo };
}

export function todoList() {
  const todos = present(readAll());
  return {
    ok: true,
    action: "list",
    total: todos.length,
    completed: todos.filter((t) => t.completed).length,
    todos,
  };
}

export function todoComplete(rawId, completed = true) {
  const id = String(rawId ?? "").trim();
  if (!id) throw new Error("参数不合法：complete 操作必须提供待办 id（可先用 list 查询）");
  const list = readAll();
  const todo = list.find((t) => t.id === id);
  if (!todo) throw new Error(`未找到 id 为 "${id}" 的待办，可能已被删除，请先用 list 查看最新列表`);
  if (todo.completed !== !!completed) {
    todo.completed = !!completed;
    todo.updatedAt = new Date().toISOString();
    writeAll(list);
  }
  return { ok: true, action: "complete", todo };
}

// 删除是破坏性操作：必须显式 action=delete 且带 id，存储层不提供任何批量/按标题删除入口
export function todoDelete(rawId) {
  const id = String(rawId ?? "").trim();
  if (!id) throw new Error("参数不合法：delete 操作必须提供待办 id（可先用 list 查询）");
  const list = readAll();
  const idx = list.findIndex((t) => t.id === id);
  if (idx < 0) throw new Error(`未找到 id 为 "${id}" 的待办，可能已被删除，请先用 list 查看最新列表`);
  const [deleted] = list.splice(idx, 1);
  writeAll(list);
  return { ok: true, action: "delete", deleted };
}
