// 附件处理（按服务商能力分流，能力表见 providers.js）：
// - 图片：所有服务商通用，读取为 base64 data URL 放进多模态 content
// - 视频：仅 Kimi —— POST /files（purpose=video），用 ms://<file_id> 引用
// - 文档：
//     Kimi → POST /files（purpose=file-extract），服务端解析后取回文本
//     其他 → 纯文本类文件（txt/md/csv/代码等）本地直接读取注入；Office/PDF 等跳过
// - 音频：目前所有服务商均不支持，标记为跳过

import { getProvider } from "./providers";

const IMAGE_EXT = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "heic", "heif"];
const VIDEO_EXT = ["mp4", "mpeg", "mpg", "mov", "avi", "flv", "webm", "wmv", "3gp", "3gpp"];
const AUDIO_EXT = ["mp3", "wav", "m4a", "flac", "aac", "ogg", "oga", "wma", "amr"];
// 可本地读取的纯文本类（任何服务商都能用文本注入方式处理）
const TEXT_EXT = [
  "txt", "md", "csv", "json", "log", "html", "htm", "yaml", "yml", "ini", "conf",
  "go", "h", "c", "cpp", "cxx", "cc", "cs", "java", "js", "jsx", "ts", "tsx", "css",
  "jsp", "php", "py", "asp", "xml", "sql", "sh", "bat", "vue",
];
const DOC_EXT = [
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "dot", "epub", "mobi", ...TEXT_EXT,
];

const MAX_VIDEO_MB = 90; // 视频必须走文件上传，服务端整体请求体上限 100M
const MAX_FILE_MB = 100;
const MAX_TEXT_CHARS = 200000; // 本地文本注入上限，避免上下文爆炸

export function kindOf(file) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (file.type?.startsWith("image/") || IMAGE_EXT.includes(ext)) return "image";
  if (file.type?.startsWith("video/") || VIDEO_EXT.includes(ext)) return "video";
  if (file.type?.startsWith("audio/") || AUDIO_EXT.includes(ext)) return "audio";
  if (DOC_EXT.includes(ext)) return "doc";
  return "unknown";
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
}

function readAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("文件读取失败"));
    reader.readAsText(file);
  });
}

function extOf(file) {
  return (file.name.split(".").pop() || "").toLowerCase();
}

async function uploadFile(file, purpose, config) {
  const form = new FormData();
  form.append("purpose", purpose);
  form.append("file", file, file.name);

  const resp = await fetch(`${config.baseURL}/files`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}` }, // 浏览器自动补 multipart boundary
    body: form,
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`文件「${file.name}」上传失败 (${resp.status})：${t.slice(0, 150)}`);
  }
  return resp.json(); // { id, filename, mime_type, size_bytes, purpose, extract_status }
}

// 轮询文档解析状态，ready 后取回抽取文本
async function fetchExtractedText(fileId, config) {
  for (let i = 0; i < 30; i++) {
    const infoResp = await fetch(`${config.baseURL}/files/${fileId}`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    if (infoResp.ok) {
      const info = await infoResp.json();
      if (info.extract_status === "ready" || info.status === "ready") break;
      if (info.extract_status === "error" || info.status === "error") {
        throw new Error("文件内容解析失败");
      }
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  const contentResp = await fetch(`${config.baseURL}/files/${fileId}/content`, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
  });
  if (!contentResp.ok) {
    const t = await contentResp.text();
    throw new Error(`文件内容获取失败 (${contentResp.status})：${t.slice(0, 150)}`);
  }
  return contentResp.text();
}

/**
 * 预处理全部附件（按服务商能力分流）
 * @param {File[]} files
 * @param {{provider:string, baseURL:string, apiKey:string}} config 当前激活档案
 * @param {(hint:string)=>void} onHint 进度提示
 * @returns {Promise<{parts:Array, systemMessages:Array, skipped:Array<{name:string,reason:string}>}>}
 */
export async function prepareAttachments(files, config, onHint) {
  const caps = getProvider(config.provider).caps;
  const parts = [];
  const systemMessages = [];
  const skipped = [];

  for (const file of files) {
    const kind = kindOf(file);
    const ext = extOf(file);
    const mb = file.size / 1024 / 1024;

    if (kind === "audio") {
      skipped.push({ name: file.name, reason: "当前模型暂不支持音频理解" });
      continue;
    }
    if (kind === "unknown") {
      skipped.push({ name: file.name, reason: "不支持的文件格式" });
      continue;
    }
    if (kind === "video") {
      if (!caps.video) {
        skipped.push({ name: file.name, reason: "当前服务商暂不支持视频理解（仅 Kimi 支持）" });
        continue;
      }
      if (mb > MAX_VIDEO_MB) {
        skipped.push({ name: file.name, reason: `视频超过 ${MAX_VIDEO_MB}MB 上限` });
        continue;
      }
    }
    if (mb > MAX_FILE_MB) {
      skipped.push({ name: file.name, reason: `文件超过 ${MAX_FILE_MB}MB 上限` });
      continue;
    }

    if (kind === "image") {
      onHint?.(`正在读取图片 ${file.name}`);
      const url = await readAsDataURL(file);
      parts.push({ type: "image_url", image_url: { url } });
    } else if (kind === "video") {
      onHint?.(`正在上传视频 ${file.name}`);
      const uploaded = await uploadFile(file, "video", config);
      parts.push({ type: "video_url", video_url: { url: `ms://${uploaded.id}` } });
    } else if (caps.fileExtract) {
      // Kimi：服务端文档解析（Word/PPT/Excel/PDF/文本等）
      onHint?.(`正在解析文档 ${file.name}`);
      const uploaded = await uploadFile(file, "file-extract", config);
      const text = await fetchExtractedText(uploaded.id, config);
      systemMessages.push({
        role: "system",
        content: `用户上传了文件《${file.name}》，以下是该文件提取出的内容，请据此回答用户的问题：\n\n${text}`,
      });
    } else if (TEXT_EXT.includes(ext)) {
      // 其他服务商：纯文本类本地读取后直接注入
      onHint?.(`正在读取文件 ${file.name}`);
      let text = await readAsText(file);
      if (text.length > MAX_TEXT_CHARS) {
        text = text.slice(0, MAX_TEXT_CHARS) + "\n\n（文件过长，已截断）";
      }
      systemMessages.push({
        role: "system",
        content: `用户上传了文件《${file.name}》，以下是该文件的完整内容，请据此回答用户的问题：\n\n${text}`,
      });
    } else {
      skipped.push({ name: file.name, reason: "当前服务商暂不支持该类文档解析（仅 Kimi 支持 Word/PPT/Excel/PDF）" });
    }
  }

  return { parts, systemMessages, skipped };
}
