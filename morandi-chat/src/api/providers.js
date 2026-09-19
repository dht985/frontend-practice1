// 服务商预设：统一走 OpenAI 兼容协议（/chat/completions + Bearer Key + SSE）
// caps 描述各平台私有能力，前端据此门控功能：
//   webSearch       联网搜索（目前仅 Kimi Formula 通道）
//   video           视频理解（Kimi /files + ms:// 引用）
//   fileExtract     服务端文档解析（Kimi file-extract：Word/PPT/Excel/PDF 等）
//   localText       纯文本类文件本地读取后注入（通用能力，所有平台可用）
//   reasoningEffort 请求体可带 reasoning_effort 参数
//   responseFormat  请求体可带 response_format（JSON Mode，json_object）
export const PROVIDERS = {
  kimi: {
    name: "Kimi",
    baseURL: "https://api.moonshot.cn/v1",
    model: "kimi-k3",
    models: ["kimi-k3", "kimi-k2-turbo-preview", "moonshot-v1-128k", "moonshot-v1-32k", "moonshot-v1-8k"],
    caps: { webSearch: true, video: true, fileExtract: true, localText: true, reasoningEffort: true, responseFormat: true },
    keyUrl: "https://platform.kimi.com",
    hint: "Key 在 platform.kimi.com 获取。K3 为旗舰模型，需实名并真实充值后才可调用；联网搜索、视频与文档解析为 Kimi 专属能力。",
  },
  deepseek: {
    name: "DeepSeek",
    baseURL: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    models: ["deepseek-chat", "deepseek-reasoner"],
    caps: { webSearch: false, video: false, fileExtract: false, localText: true, reasoningEffort: false, responseFormat: true },
    keyUrl: "https://platform.deepseek.com",
    hint: "Key 在 platform.deepseek.com 创建。支持文本对话与图片；视频、Office 文档解析不可用。",
  },
  qwen: {
    name: "通义千问（百炼）",
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
    models: ["qwen-plus", "qwen-turbo", "qwen-max", "qwen-vl-plus"],
    caps: { webSearch: false, video: false, fileExtract: false, localText: true, reasoningEffort: false, responseFormat: true },
    keyUrl: "https://bailian.console.aliyun.com",
    hint: "使用阿里云百炼的 OpenAI 兼容端点。图片理解选 qwen-vl 系列模型；Key 在百炼控制台获取。",
  },
  zhipu: {
    name: "智谱 GLM",
    baseURL: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-4-flash",
    models: ["glm-4-flash", "glm-4-plus", "glm-4-air", "glm-4v-flash"],
    caps: { webSearch: false, video: false, fileExtract: false, localText: true, reasoningEffort: false, responseFormat: true },
    keyUrl: "https://open.bigmodel.cn",
    hint: "Key 在 open.bigmodel.cn 获取。glm-4-flash 免费；图片理解选 glm-4v 系列。",
  },
  openai: {
    name: "OpenAI",
    baseURL: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    models: ["gpt-4o-mini", "gpt-4o", "o4-mini", "gpt-4.1-mini"],
    caps: { webSearch: false, video: false, fileExtract: false, localText: true, reasoningEffort: false, responseFormat: true },
    keyUrl: "https://platform.openai.com",
    hint: "国内直连通常需要代理环境；浏览器报跨域(CORS)错误时说明需要中转。",
  },
  openrouter: {
    name: "OpenRouter（聚合）",
    baseURL: "https://openrouter.ai/api/v1",
    model: "deepseek/deepseek-chat",
    models: ["deepseek/deepseek-chat", "google/gemini-2.0-flash-exp:free", "meta-llama/llama-3.3-70b-instruct", "qwen/qwen-2.5-72b-instruct"],
    caps: { webSearch: false, video: false, fileExtract: false, localText: true, reasoningEffort: false, responseFormat: true },
    keyUrl: "https://openrouter.ai/keys",
    hint: "一个 Key 可调用几百个模型，模型名格式为 厂商/模型，在 openrouter.ai 上复制。",
  },
  custom: {
    name: "自定义（OpenAI 兼容）",
    baseURL: "",
    model: "",
    models: [],
    caps: { webSearch: false, video: false, fileExtract: false, localText: true, reasoningEffort: false, responseFormat: false },
    keyUrl: "",
    hint: "任何提供 OpenAI 兼容 /chat/completions 端点的服务均可接入（含第三方中转站）。若浏览器报 CORS 跨域错误，需要加本地代理。",
  },
};

export function getProvider(id) {
  return PROVIDERS[id] || PROVIDERS.custom;
}

// 根据 baseURL 猜测服务商（旧配置迁移用）
export function detectProvider(baseURL = "") {
  const u = baseURL.toLowerCase();
  if (u.includes("moonshot")) return "kimi";
  if (u.includes("deepseek")) return "deepseek";
  if (u.includes("dashscope") || u.includes("aliyun")) return "qwen";
  if (u.includes("bigmodel")) return "zhipu";
  if (u.includes("openrouter")) return "openrouter";
  if (u.includes("openai")) return "openai";
  return "custom";
}

export function newProfileId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// 显式声明不接受 temperature/top_p 的推理类模型（由推理强度控制，采样参数会 400）。
// 采用显式集合 + 前缀兜底：OpenAI o 系列命名会持续出新（o1/o3/o4…），前缀匹配更稳妥。
const REASONING_MODELS = new Set(["kimi-k3", "deepseek-reasoner"]);

// 生成参数能力：temperature/top_p 是 OpenAI 兼容协议的通用采样参数，
// 但推理类模型（Kimi K3、DeepSeek reasoner、OpenAI o 系列）由推理强度控制，不接受采样参数
// 返回 { temperature, topP, maxTokens, stop }
export function getParamCaps(providerId, model = "") {
  const base = { temperature: true, topP: true, maxTokens: true, stop: true };
  const m = (model || "").toLowerCase();
  const reasoningModel =
    REASONING_MODELS.has(m) ||
    (providerId === "openai" && /^o\d/.test(m));
  return reasoningModel
    ? { ...base, temperature: false, topP: false }
    : base;
}
