import { useState, useEffect } from "react";
import { PROVIDERS, getProvider, newProfileId } from "../api/providers";

export default function Settings({ open, config, onUpsert, onActivate, onDelete, onClose }) {
  const [editId, setEditId] = useState(config.activeId);
  const [form, setForm] = useState(() => {
    const p = config.profiles.find((x) => x.id === config.activeId) || config.profiles[0];
    return { ...p };
  });

  // 每次打开弹窗时，把编辑目标同步为当前激活档案
  useEffect(() => {
    if (open) {
      const p = config.profiles.find((x) => x.id === config.activeId) || config.profiles[0];
      setEditId(p.id);
      setForm({ ...p });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 档案被删除后，编辑器自动切到激活档案
  useEffect(() => {
    if (!config.profiles.some((p) => p.id === editId)) {
      const p = config.profiles.find((x) => x.id === config.activeId) || config.profiles[0];
      if (p) {
        setEditId(p.id);
        setForm({ ...p });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.profiles]);

  if (!open) return null;

  const field =
    "w-full px-3.5 py-2.5 border border-line rounded-xl outline-none text-base md:text-sm text-ink bg-cream/50 focus:bg-white focus:border-peach transition-colors";
  const label = "block text-[13px] text-ink font-medium mb-1.5";
  const presetList = Object.entries(PROVIDERS);
  const editing = getProvider(form.provider);

  const selectProfile = (p) => {
    onActivate(p.id);
    setEditId(p.id);
    setForm({ ...p });
  };

  const addPreset = (providerId) => {
    const preset = PROVIDERS[providerId];
    const profile = {
      id: newProfileId(),
      provider: providerId,
      baseURL: preset.baseURL,
      apiKey: "",
      model: preset.model,
    };
    onUpsert(profile);
    setEditId(profile.id);
    setForm({ ...profile });
  };

  const save = () => {
    onUpsert({
      id: editId,
      provider: form.provider,
      baseURL: form.baseURL.trim(),
      apiKey: form.apiKey.trim(),
      model: form.model.trim(),
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/25 backdrop-blur-[2px]"
         onClick={onClose}>
      <div
        className="w-[min(480px,calc(100vw-2rem))] max-h-[88vh] overflow-y-auto bg-cream rounded-2xl shadow-float border border-line/70 p-5 md:p-6 space-y-5 animate-fade-up"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题 */}
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-lilacsoft border border-line/60 flex items-center justify-center text-sagedeep">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
                 strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px]">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33
                       1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06
                       a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09
                       A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6
                       a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06
                       a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.2.65.78 1.08 1.51 1H21a2 2 0 0 1 0 4h-.09
                       a1.65 1.65 0 0 0-1.51 1Z" />
            </svg>
          </div>
          <div>
            <h2 className="text-base font-semibold text-ink">模型服务商</h2>
            <p className="text-xs text-muted mt-0.5">均为 OpenAI 兼容协议，Key 仅保存在本机</p>
          </div>
        </div>

        {/* 已保存的档案 */}
        <div className="space-y-1.5">
          {config.profiles.map((p) => {
            const active = p.id === config.activeId;
            const editingRow = p.id === editId;
            return (
              <div
                key={p.id}
                onClick={() => selectProfile(p)}
                className={`group flex items-center gap-2.5 pl-3.5 pr-2 py-2.5 rounded-xl border cursor-pointer transition-all
                  ${active
                    ? "bg-lilacsoft/70 border-plum/60 shadow-soft"
                    : "bg-white/60 border-line/70 hover:border-peach/50"}
                  ${editingRow && !active ? "ring-1 ring-peach/40" : ""}`}
              >
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${active ? "bg-sagedeep" : "bg-muted/30"}`} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-ink font-medium truncate leading-tight">
                    {getProvider(p.provider).name}
                    {active && <span className="ml-1.5 text-[10px] text-sagedeep font-normal">使用中</span>}
                  </p>
                  <p className="text-[11px] text-muted truncate mt-0.5">{p.model || "未设置模型"}</p>
                </div>
                {config.profiles.length > 1 && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onDelete(p.id); }}
                    className="text-muted/50 hover:text-[#b08a86] p-1 rounded-md hover:bg-blushsoft/70 flex-shrink-0"
                    title="删除该配置"
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

        {/* 添加服务商 */}
        <div>
          <p className="text-[11px] font-medium text-muted/80 tracking-widest mb-2">添加服务商</p>
          <div className="grid grid-cols-2 gap-1.5">
            {presetList.map(([id, preset]) => (
              <button
                key={id}
                onClick={() => addPreset(id)}
                className="text-left px-3 py-2 rounded-lg bg-white/60 border border-line/70 text-xs text-ink
                           hover:border-peach/60 hover:bg-peachsoft/50 transition-colors truncate"
              >
                + {preset.name}
              </button>
            ))}
          </div>
        </div>

        {/* 当前编辑档案的表单 */}
        <div className="border-t border-line/70 pt-4 space-y-4">
          <p className="text-[11px] font-medium text-muted/80 tracking-widest">
            编辑 · {editing.name}
          </p>

          <div>
            <label className={label}>Base URL</label>
            <input
              value={form.baseURL}
              onChange={(e) => setForm({ ...form, baseURL: e.target.value })}
              placeholder="https://api.example.com/v1"
              className={field}
            />
          </div>

          <div>
            <label className={label}>API Key</label>
            <input
              type="password"
              value={form.apiKey}
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
              placeholder="sk-..."
              className={field}
            />
          </div>

          <div>
            <label className={label}>模型名称</label>
            <input
              value={form.model}
              onChange={(e) => setForm({ ...form, model: e.target.value })}
              placeholder={editing.model || "模型名"}
              list="model-suggestions"
              className={field}
            />
            <datalist id="model-suggestions">
              {editing.models.map((m) => <option key={m} value={m} />)}
            </datalist>
          </div>

          {/* 能力提示 */}
          <div className="flex flex-wrap gap-1.5">
            {editing.caps.webSearch && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-lilacsoft border border-plum/40 text-ink">联网搜索</span>
            )}
            {editing.caps.video && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-peachsoft border border-peach/40 text-ink">视频理解</span>
            )}
            {editing.caps.fileExtract && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-blushsoft border border-blush/50 text-ink">文档解析</span>
            )}
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/70 border border-line/70 text-muted">图片</span>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-white/70 border border-line/70 text-muted">文本文件</span>
          </div>

          <div className="rounded-xl bg-peachsoft/60 border border-line/60 px-4 py-3">
            <p className="text-xs text-muted leading-relaxed">{editing.hint}</p>
          </div>
        </div>

        <div className="flex justify-end gap-2.5 pt-1">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-muted text-sm hover:bg-blushsoft transition-colors"
          >
            取消
          </button>
          <button
            onClick={save}
            className="px-6 py-2 rounded-xl bg-peach hover:bg-peachdeep text-ink text-sm font-medium
                       shadow-soft transition-all active:scale-[0.97]"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
