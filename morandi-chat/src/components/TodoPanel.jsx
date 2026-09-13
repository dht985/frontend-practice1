import { useState, useEffect, useRef } from "react";
import { todoList, todoComplete, todoDelete, onTodosChange } from "../api/todos";

// 本地待办面板：与 todo_list 工具读写同一份 morandi-chat-todos 数据
// 支持勾选完成/取消完成、两段式确认删除；任何来源（模型、其他标签页）的写入都会实时刷新
export default function TodoPanel({ open, onClose }) {
  const [todos, setTodos] = useState([]);
  const [confirmId, setConfirmId] = useState(null); // 待二次确认删除的待办
  const confirmTimer = useRef(null);

  const refresh = () => setTodos(todoList().todos);

  // 打开时同步一次；之后靠订阅实时更新（模型在对话里 add/complete 也会立刻反映）
  useEffect(() => {
    if (open) refresh();
  }, [open]);
  useEffect(() => onTodosChange(refresh), []);
  useEffect(() => () => clearTimeout(confirmTimer.current), []);

  if (!open) return null;

  const remaining = todos.filter((t) => !t.completed).length;

  const toggle = (t) => {
    try {
      todoComplete(t.id, !t.completed);
    } catch {
      refresh(); // 数据已被其他来源改动时，以存储中的最新列表为准
    }
  };

  // 删除二次确认：第一次点进入确认态（2.5 秒后自动复位），再点才真正删除
  const handleDeleteClick = (id) => {
    if (confirmId === id) {
      clearTimeout(confirmTimer.current);
      setConfirmId(null);
      try {
        todoDelete(id);
      } catch {
        refresh();
      }
    } else {
      setConfirmId(id);
      clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirmId(null), 2500);
    }
  };

  const fmtTime = (iso) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/25 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="w-[min(460px,calc(100vw-2rem))] max-h-[82vh] flex flex-col
                   bg-cream rounded-2xl shadow-float border border-line/70 animate-fade-up overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-5 md:px-6 pt-5 pb-4 border-b border-line/60">
          <div>
            <h2 className="text-base font-semibold text-ink">待办事项</h2>
            <p className="text-[11px] text-muted mt-0.5">
              {todos.length === 0
                ? "还没有待办"
                : remaining > 0
                  ? `还有 ${remaining} 项未完成 · 共 ${todos.length} 项`
                  : `全部 ${todos.length} 项已完成`}
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg text-muted hover:text-ink hover:bg-white/70 flex items-center justify-center transition-colors"
            title="关闭"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                 strokeLinecap="round" className="w-4 h-4">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* 列表 */}
        <div className="flex-1 overflow-y-auto px-4 md:px-5 py-4 space-y-2">
          {todos.length === 0 && (
            <div className="py-10 text-center">
              <p className="text-sm text-muted/80 leading-relaxed">
                暂无待办事项
                <br />
                <span className="text-xs text-muted/60">
                  也可以在对话里让 Agent 用 todo_list 工具帮你记录
                </span>
              </p>
            </div>
          )}
          {todos.map((t) => {
            const confirming = confirmId === t.id;
            return (
              <div
                key={t.id}
                className="group flex items-start gap-3 px-3 py-2.5 rounded-xl bg-white/60 border border-line/50"
              >
                {/* 完成勾选 */}
                <button
                  onClick={() => toggle(t)}
                  className={`mt-0.5 w-5 h-5 rounded-md border flex-shrink-0 flex items-center justify-center
                              transition-all duration-150 active:scale-90
                              ${t.completed
                                ? "bg-sagedeep border-sagedeep text-white"
                                : "border-line bg-cream hover:border-sagedeep/70"}`}
                  title={t.completed ? "标记为未完成" : "标记为已完成"}
                >
                  {t.completed && (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6"
                         strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3">
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  )}
                </button>

                <div className="flex-1 min-w-0">
                  <p className={`text-sm leading-snug break-words ${
                    t.completed ? "line-through text-muted/55" : "text-ink"
                  }`}>
                    {t.title}
                  </p>
                  <p className="text-[10.5px] text-muted/50 mt-0.5">
                    {fmtTime(t.createdAt)} 添加{t.completed ? " · 已完成" : ""}
                  </p>
                </div>

                {/* 删除（两段式确认，与侧边栏删除对话一致） */}
                {confirming ? (
                  <button
                    onClick={() => handleDeleteClick(t.id)}
                    className="flex-shrink-0 text-[10px] text-white bg-[#b08a86] hover:bg-[#a07974]
                               rounded-md px-2 py-1 transition-colors"
                    title="再次点击确认删除"
                  >
                    确认删除
                  </button>
                ) : (
                  <button
                    onClick={() => handleDeleteClick(t.id)}
                    className="flex-shrink-0 md:opacity-0 md:group-hover:opacity-100 text-muted/50
                               hover:text-[#b08a86] p-1 rounded-md hover:bg-blushsoft transition-all"
                    title="删除待办（需二次确认）"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
                         strokeLinecap="round" className="w-3.5 h-3.5">
                      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                    </svg>
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <div className="px-5 md:px-6 py-3 border-t border-line/60">
          <p className="text-[11px] text-muted/60">
            与 Agent 的 todo_list 工具共享同一份数据，仅保存在本机浏览器
          </p>
        </div>
      </div>
    </div>
  );
}
