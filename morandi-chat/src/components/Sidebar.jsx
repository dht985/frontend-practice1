import { useState, useRef, useEffect } from "react";
import { BlobMark } from "./Decor";

export default function Sidebar({
  open, onClose, conversations, activeId, onSelect, onNew, onDelete, onRename, onOpenSettings,
  onOpenTodos, todoBadge = 0,
}) {
  const [keyword, setKeyword] = useState("");
  const [editingId, setEditingId] = useState(null); // 正在重命名的对话 id
  const [editText, setEditText] = useState("");
  const [confirmId, setConfirmId] = useState(null); // 待二次确认删除的对话 id
  const confirmTimer = useRef(null);
  const editInputRef = useRef(null);

  useEffect(() => {
    if (editingId) editInputRef.current?.focus();
  }, [editingId]);
  useEffect(() => () => clearTimeout(confirmTimer.current), []);

  const filtered = conversations.filter((c) =>
    (c.title || "").toLowerCase().includes(keyword.trim().toLowerCase())
  );

  const startRename = (c) => {
    setEditingId(c.id);
    setEditText(c.title || "");
  };

  const commitRename = () => {
    if (editingId) onRename?.(editingId, editText);
    setEditingId(null);
  };

  // 删除二次确认：第一次点进入确认态（2.5 秒后自动复位），再点才真正删除
  const handleDeleteClick = (id) => {
    if (confirmId === id) {
      clearTimeout(confirmTimer.current);
      setConfirmId(null);
      onDelete(id);
    } else {
      setConfirmId(id);
      clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirmId(null), 2500);
    }
  };

  return (
    <>
    {/* 移动端遮罩：点击关闭抽屉（桌面端不渲染交互） */}
    <div
      className={`fixed inset-0 z-30 bg-ink/25 transition-opacity duration-300 md:hidden
                  ${open ? "opacity-100" : "opacity-0 pointer-events-none"}`}
      onClick={onClose}
      aria-hidden="true"
    />
    <aside
      className={`w-64 flex-shrink-0 bg-sand border-r border-line/70 flex flex-col overflow-hidden
                  fixed inset-y-0 left-0 z-40 transition-transform duration-300
                  md:relative md:translate-x-0
                  ${open ? "translate-x-0 shadow-float" : "-translate-x-full"}`}
    >
      {/* 侧边栏背景色块：极淡，增加层次 */}
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        <div className="absolute -bottom-16 -left-16 w-56 h-56">
          <div
            className="w-full h-full bg-plum/25"
            style={{ borderRadius: "52% 48% 58% 42% / 46% 56% 44% 54%" }}
          />
        </div>
        <div className="absolute -top-14 -right-14 w-44 h-44">
          <div
            className="w-full h-full bg-white/35"
            style={{ borderRadius: "47% 53% 58% 42% / 55% 45% 55% 45%" }}
          />
        </div>
      </div>

      {/* 品牌区 */}
      <div className="relative z-10 px-5 pt-6 pb-5 flex items-center gap-3">
        <div className="w-10 h-10 rounded-2xl bg-cream border border-line/60 flex items-center justify-center shadow-soft">
          <BlobMark className="w-6 h-6" />
        </div>
        <div>
          <h1 className="text-[15px] font-semibold text-ink leading-tight">静语工作台</h1>
          <p className="text-[11px] text-muted tracking-wide mt-0.5">MORANDI CHAT</p>
        </div>
      </div>

      {/* 新建对话 */}
      <div className="px-4 pb-4">
        <button
          onClick={onNew}
          className="w-full py-2.5 px-4 rounded-xl bg-peach hover:bg-peachdeep text-ink text-sm font-medium
                     shadow-soft transition-all duration-200 flex items-center justify-center gap-2
                     hover:shadow-float active:scale-[0.98]"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
               strokeLinecap="round" className="w-4 h-4">
            <path d="M12 5v14M5 12h14" />
          </svg>
          新建对话
        </button>
      </div>

      {/* 历史列表 */}
      <div className="relative z-10 flex-1 overflow-y-auto px-3 pb-3">
        <p className="px-2 pb-2 text-[11px] font-medium text-muted/80 tracking-widest">历史对话</p>

        {/* 搜索框 */}
        <div className="px-1 pb-2">
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-cream/70 border border-line/60
                          focus-within:border-peach/70 transition-colors">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
                 strokeLinecap="round" className="w-3.5 h-3.5 text-muted/60 flex-shrink-0">
              <circle cx="11" cy="11" r="7" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜索对话"
              className="flex-1 min-w-0 bg-transparent text-xs text-ink outline-none placeholder:text-muted/60"
            />
            {keyword && (
              <button
                onClick={() => setKeyword("")}
                className="text-muted/60 hover:text-ink p-0.5 flex-shrink-0"
                title="清空搜索"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                     strokeLinecap="round" className="w-3 h-3">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        </div>

        {conversations.length === 0 && (
          <div className="px-3 py-8 text-center">
            <p className="text-xs text-muted/70 leading-relaxed">还没有对话<br />从右侧开始吧</p>
          </div>
        )}
        {conversations.length > 0 && filtered.length === 0 && (
          <div className="px-3 py-6 text-center">
            <p className="text-xs text-muted/70">没有匹配「{keyword.trim()}」的对话</p>
          </div>
        )}
        <div className="space-y-1">
          {filtered.map((c) => {
            const active = c.id === activeId;
            const confirming = confirmId === c.id;
            const renaming = editingId === c.id;
            return (
              <div
                key={c.id}
                onClick={() => onSelect(c.id)}
                className={`group relative flex items-center gap-2.5 pl-4 pr-2 py-2.5 rounded-xl cursor-pointer
                            text-sm transition-all duration-150
                            ${active
                              ? "bg-cream text-ink shadow-soft"
                              : "text-muted hover:bg-cream/60 hover:text-ink"}`}
              >
                {active && (
                  <span className="absolute left-2 top-1/2 -translate-y-1/2 w-1 h-4 rounded-full bg-peachdeep" />
                )}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
                     strokeLinecap="round" strokeLinejoin="round"
                     className={`w-3.5 h-3.5 flex-shrink-0 ${active ? "text-sagedeep" : "text-muted/50"}`}>
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />
                </svg>

                {renaming ? (
                  /* 重命名输入框 */
                  <input
                    ref={editInputRef}
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.nativeEvent.isComposing) return;
                      if (e.key === "Enter") commitRename();
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    onBlur={commitRename}
                    className="flex-1 min-w-0 bg-transparent text-sm text-ink outline-none
                               border-b border-peach/70 px-0.5"
                  />
                ) : (
                  <>
                    <span className="flex-1 truncate" onDoubleClick={() => startRename(c)}>
                      {c.title}
                    </span>
                    {/* 重命名（悬停显示） */}
                    <button
                      onClick={(e) => { e.stopPropagation(); startRename(c); }}
                      className="md:opacity-0 md:group-hover:opacity-100 text-muted/60 hover:text-ink
                                 transition-all text-xs p-1 rounded-md hover:bg-sand"
                      title="重命名"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
                           strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                        <path d="M12 20h9" />
                        <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5Z" />
                      </svg>
                    </button>
                    {/* 删除（两段式确认） */}
                    {confirming ? (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDeleteClick(c.id); }}
                        className="text-[10px] text-white bg-[#b08a86] hover:bg-[#a07974]
                                   rounded-md px-1.5 py-1 flex-shrink-0 transition-colors"
                        title="再次点击确认删除"
                      >
                        确认
                      </button>
                    ) : (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDeleteClick(c.id); }}
                        className="md:opacity-0 md:group-hover:opacity-100 text-muted/60 hover:text-[#b08a86]
                                   transition-all text-xs p-1 rounded-md hover:bg-blushsoft"
                        title="删除对话（需二次确认）"
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
                             strokeLinecap="round" className="w-3.5 h-3.5">
                          <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                        </svg>
                      </button>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* 底部：待办 + 设置 */}
      <div className="relative z-10 p-3 border-t border-line/70 space-y-0.5">
        <button
          onClick={onOpenTodos}
          className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-muted text-sm
                     hover:bg-cream/70 hover:text-ink transition-colors"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
               strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
            <path d="M9 11l3 3L22 4" />
            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
          </svg>
          <span className="flex-1 text-left">待办事项</span>
          {todoBadge > 0 && (
            <span className="text-[10px] font-medium leading-none px-2 py-1 rounded-full bg-sage/50 border border-sagedeep/40 text-ink">
              {todoBadge > 99 ? "99+" : todoBadge}
            </span>
          )}
        </button>
        <button
          onClick={onOpenSettings}
          className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-muted text-sm
                     hover:bg-cream/70 hover:text-ink transition-colors"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
               strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33
                     1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06
                     a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09
                     A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6
                     a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06
                     a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.2.65.78 1.08 1.51 1H21a2 2 0 0 1 0 4h-.09
                     a1.65 1.65 0 0 0-1.51 1Z" />
          </svg>
          API 设置
        </button>
      </div>
    </aside>
    </>
  );
}
