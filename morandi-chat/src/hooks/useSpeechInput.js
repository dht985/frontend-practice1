import { useState, useEffect, useRef, useCallback } from "react";

// Web Speech API 语音转文字
// Edge 走微软识别服务（国内直连可用）；Chrome 走 Google 服务（需代理）
// 实时转写：已确认文本累积进输入框，临时文本（灰色候选）跟随显示，可手动编辑后再发送
const SR =
  typeof window !== "undefined" &&
  (window.SpeechRecognition || window.webkitSpeechRecognition);

export default function useSpeechInput(onText) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState("");
  const recRef = useRef(null);
  const baseRef = useRef(""); // 开始聆听时输入框已有内容
  const finalRef = useRef(""); // 本次聆听已确认文本
  const suppressCommitRef = useRef(false); // 发送/取消时阻止 onend 把旧文本写回
  const errorTimerRef = useRef(null);

  // onText 用 ref 包，避免重建 recognition 实例
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  useEffect(() => {
    if (!SR) return;
    const rec = new SR();
    rec.lang = "zh-CN";
    rec.continuous = true; // 长句不停，手动结束
    rec.interimResults = true; // 返回临时结果，边说边出字

    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalRef.current += r[0].transcript;
        else interim += r[0].transcript;
      }
      // 已有文字 + 已确认 + 临时候选，直接反映在输入框里
      onTextRef.current(baseRef.current + finalRef.current + interim);
    };

    rec.onerror = (e) => {
      // aborted=主动停止；no-speech=静音超时，都会接 onend，不提示
      if (e.error === "aborted" || e.error === "no-speech") return;
      const map = {
        "not-allowed": "麦克风权限被拒绝，请在浏览器地址栏允许使用麦克风后重试",
        "service-not-allowed": "语音识别服务不可用",
        network: "识别服务连不上（Chrome 需可访问 Google，建议改用 Edge 浏览器）",
        "audio-capture": "未检测到麦克风设备，请检查设备连接",
      };
      setError(map[e.error] || `语音识别出错：${e.error}`);
    };

    rec.onend = () => {
      setListening(false);
      // 结束时丢弃临时候选，只提交已确认文本（发送/取消场景则完全不回写）
      if (!suppressCommitRef.current) {
        onTextRef.current(baseRef.current + finalRef.current);
      }
      suppressCommitRef.current = false;
    };

    recRef.current = rec;
    return () => {
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      try { rec.abort(); } catch { /* 忽略 */ }
      clearTimeout(errorTimerRef.current);
    };
  }, []);

  const start = useCallback((currentText = "") => {
    if (!recRef.current) return;
    clearTimeout(errorTimerRef.current);
    setError("");
    baseRef.current = currentText;
    finalRef.current = "";
    suppressCommitRef.current = false;
    try {
      recRef.current.start();
      setListening(true);
    } catch {
      // start() 在识别已启动时抛 InvalidStateError，忽略
    }
  }, []);

  // 正常结束：提交已确认文本
  const stop = useCallback(() => {
    try { recRef.current?.stop(); } catch { /* 忽略 */ }
  }, []);

  // 取消（发送消息时）：onend 不回写，避免旧文本重新填回已清空的输入框
  const cancel = useCallback(() => {
    suppressCommitRef.current = true;
    try { recRef.current?.abort(); } catch { /* 忽略 */ }
    setListening(false);
  }, []);

  const clearError = useCallback(() => setError(""), []);

  return {
    supported: !!SR,
    secure: typeof window === "undefined" || window.isSecureContext,
    listening,
    error,
    start,
    stop,
    cancel,
    clearError,
  };
}
