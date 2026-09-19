// 配置与本地偏好：服务商档案、会话级 API Key、工作台默认值、时间上下文。
// 从 App.jsx 搬出来——App 只负责界面与状态编排，这类"规则"放这里，顺便能单独测试。

import { PROVIDERS, detectProvider, newProfileId } from "../api/providers";

export const CONFIG_KEY = "morandi-chat-config";
export const ACTIVE_KEY = "morandi-chat-active";
export const WORKBENCH_KEY = "morandi-chat-workbench";
export const PROMPTS_KEY = "morandi-chat-prompts";
// 选择「仅本次会话保存 Key」时，apiKey 只放 sessionStorage，不进 localStorage
const SESSION_KEYS_KEY = "morandi-chat-session-keys";

function loadSessionKeys() {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEYS_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

export function writeSessionKey(profileId, apiKey) {
  const all = loadSessionKeys();
  if (apiKey) all[profileId] = apiKey;
  else delete all[profileId];
  sessionStorage.setItem(SESSION_KEYS_KEY, JSON.stringify(all));
}

/** localStorage 写入；配额满时返回 false，其它错误仍抛出 */
export function safeSetItem(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (err) {
    const quota =
      err?.name === "QuotaExceededError" ||
      err?.code === 22 ||
      err?.code === 1014;
    if (quota) return false;
    throw err;
  }
}

/** 持久化用的配置：会话级 Key 写成空串，避免明文落盘 */
export function configForStorage(config) {
  return {
    ...config,
    profiles: config.profiles.map((p) =>
      p.persistKey === false ? { ...p, apiKey: "" } : p
    ),
  };
}

// 工作台默认配置：temperature 0.7 为多数模型的常用值；maxTokens 0 = 不限
export const DEFAULT_WORKBENCH = {
  systemPrompt: "",
  temperature: 0.7,
  topP: 1,
  maxTokens: 0,
  contextWindow: 0, // 上下文窗口（tokens），0 = 用默认 128k；见 api/contextBudget.js
  // 没有自建抓取端点时，是否允许用第三方阅读服务兜底（会把目标网址发给对方）
  useThirdPartyFetch: true,
  stop: "",
  structured: false, // 结构化输出（JSON Mode），需服务商支持 response_format
  schemaText: "",    // 可选：期望的 JSON 结构说明 / JSON Schema
};

// 旧版默认模型已下线：读取本地保存的配置时自动迁移到 kimi-k3
const LEGACY_MODELS = ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"];

// 配置结构：{ profiles: [{id, provider, baseURL, apiKey, model, persistKey}], activeId }
export function loadConfig() {
  const stored = loadJSON(CONFIG_KEY, null);
  const sessionKeys = loadSessionKeys();

  // 已是多档案结构
  if (stored && Array.isArray(stored.profiles) && stored.profiles.length) {
    const profiles = stored.profiles.map((p) => {
      const persistKey = p.persistKey !== false;
      const id = p.id || newProfileId();
      return {
        id,
        provider: p.provider || detectProvider(p.baseURL),
        baseURL: p.baseURL || "",
        // 会话级 Key：优先读 sessionStorage；持久化 Key：读 localStorage
        apiKey: persistKey ? p.apiKey || "" : sessionKeys[id] || "",
        model: LEGACY_MODELS.includes(p.model) ? "kimi-k3" : p.model || "",
        persistKey,
      };
    });
    const activeId = profiles.some((p) => p.id === stored.activeId) ? stored.activeId : profiles[0].id;
    return { profiles, activeId };
  }

  // 旧版单配置 → 迁移为一个档案
  const legacy = stored || {};
  const provider = detectProvider(legacy.baseURL || PROVIDERS.kimi.baseURL);
  let model = legacy.model || PROVIDERS[provider].model;
  if (LEGACY_MODELS.includes(model)) model = "kimi-k3";
  const profile = {
    id: newProfileId(),
    provider,
    baseURL: legacy.baseURL || PROVIDERS[provider].baseURL,
    apiKey: legacy.apiKey || "",
    model,
    persistKey: true,
  };
  return { profiles: [profile], activeId: profile.id };
}

export function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

// 构造设备当前日期/时间上下文（本地时区），供模型准确理解"今天/现在"等相对时间
export function buildTimeMessage() {
  const now = new Date();
  const weekdays = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
  const pad = (n) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  let timezone = "未知时区";
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || String(-now.getTimezoneOffset() / 60);
  } catch {
    timezone = `UTC${-now.getTimezoneOffset() / 60 >= 0 ? "+" : ""}${-now.getTimezoneOffset() / 60}`;
  }
  return {
    role: "system",
    content: `用户设备当前的本地时间信息（请以此为准回答涉及日期、星期、时间的问题）：${date} ${weekdays[now.getDay()]}，当前时间 ${time}，时区 ${timezone}。`,
  };
}
