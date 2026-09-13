// 预置内置工具（原生 JS 实现，非工作台里 new Function 执行的用户代码）：
//   fetch_url  — 读取公开网页正文
//   todo_list  — 本地待办增查改删（写操作需用户确认）
// 执行契约与 runLocalTool 一致：返回 { content, isError, retryable }，AbortError 向上抛出。

import { fetchUrl } from "./fetcher";
import { todoAdd, todoList, todoComplete, todoDelete } from "./todos";
import { isRetryableError } from "./tools";

const WRITE_ACTIONS = new Set(["add", "complete", "delete"]);

export const NATIVE_TOOL_DECLS = [
  {
    type: "function",
    function: {
      name: "fetch_url",
      description:
        "读取指定公开网页的正文内容并转成纯文本，返回 {title, url, content, truncated}（正文过长时 truncated=true 并自动截断）。" +
        "适合查阅在线文档、技术文章、新闻、博客等静态或服务端渲染的网页；" +
        "不适合下载文件（PDF/图片/压缩包/视频等）、读取需要登录的内容、或依赖 JavaScript 渲染的复杂动态网站（如多数社交平台），遇到这类页面应直接告知用户。",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "要读取的完整网页地址，必须以 http:// 或 https:// 开头",
          },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "todo_list",
      description:
        "管理保存在用户本机浏览器中的待办事项列表，通过 action 参数指定操作：" +
        "list（只读）查看全部待办；add 新增一条待办（参数 title，可选 completed）；" +
        "complete 把指定待办标记为完成或未完成（参数 id，可选 completed，默认 true）；" +
        "delete 永久删除指定待办（参数 id，不可恢复，仅在用户明确要求删除时使用，不要因为清理或猜测而删除）。" +
        "add/complete/delete 为写操作，执行前会弹出确认。拿不到 id 时先调用 list 查询。",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["add", "list", "complete", "delete"],
            description: "要执行的操作：add=新增，list=查看（只读），complete=标记完成，delete=删除",
          },
          title: { type: "string", description: "待办内容（action=add 时必填）" },
          id: { type: "string", description: "待办 id（action=complete/delete 时必填）" },
          completed: {
            type: "boolean",
            description: "完成状态：add 时作为初始状态（默认 false），complete 时设置目标状态（默认 true）",
          },
        },
        required: ["action"],
      },
    },
  },
];

const NATIVE_NAMES = new Set(NATIVE_TOOL_DECLS.map((d) => d.function.name));

export function isNativeTool(name) {
  return NATIVE_NAMES.has(name);
}

function parseArgs(argsJson) {
  try {
    const a = argsJson ? JSON.parse(argsJson) : {};
    return a && typeof a === "object" && !Array.isArray(a) ? a : {};
  } catch {
    return {}; // 参数 JSON 非法时按空对象执行，由各操作自己报参数错误
  }
}

// 写操作确认策略：todo_list 只有 add/complete/delete 需要确认，list 只读不拦截；fetch_url 不需要
export function nativeNeedsConfirm(name, argsJson) {
  if (name !== "todo_list") return false;
  const { action } = parseArgs(argsJson);
  return WRITE_ACTIONS.has(String(action || ""));
}

async function executeNative(name, args, ctx) {
  if (name === "fetch_url") {
    return await fetchUrl(args.url, ctx?.signal);
  }
  if (name === "todo_list") {
    const action = String(args.action || "");
    switch (action) {
      case "add":
        return todoAdd(args.title, args.completed === true);
      case "list":
        return todoList();
      case "complete":
        return todoComplete(args.id, args.completed === undefined ? true : !!args.completed);
      case "delete":
        return todoDelete(args.id);
      default:
        throw new Error(`参数不合法：action 必须是 add、list、complete、delete 之一，收到的是 "${action}"`);
    }
  }
  throw new Error(`内置工具不存在：${name}`);
}

// 执行一次内置工具，返回与 runLocalTool 相同的结构，方便 chat.js 复用重试/回传逻辑
export async function runNativeTool(name, argsJson, ctx) {
  const args = parseArgs(argsJson);
  try {
    const out = await executeNative(name, args, ctx);
    return { content: JSON.stringify(out), isError: false, retryable: false };
  } catch (err) {
    if (err?.name === "AbortError") throw err; // 用户中止必须向上传播
    const msg = String(err?.message || err || "工具执行失败");
    console.warn(`[内置工具] ${name} 执行出错：${msg}`);
    return {
      content: JSON.stringify({ error: msg }),
      isError: true,
      retryable: isRetryableError(msg, err),
    };
  }
}
