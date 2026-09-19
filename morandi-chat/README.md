# Morandi Chat · 本地 AI 工作台

一个仿 Google AI Studio 的前端 AI 工作台：多模型档案切换、流式对话、对话树多版本分支、
附件理解、内置/自定义工具调用、Agent 模式，以及系统提示词与生成参数面板。

纯前端实现：API Key 只保存在你自己浏览器的 localStorage 里，不会上传到任何第三方服务
（只有你配置的服务商 API 会收到请求）。

## 功能一览

- **多档案模型切换**：一次配置多个服务商/模型，对话框顶部随时切换
- **流式对话**：token 级实时输出，支持停止生成、继续生成
- **对话树多版本**：修改历史消息、重试、换一个回答都保留旧版本，用 `< y/x >` 切换
- **附件理解**：图片/视频/文档按服务商能力自动分流（多模态、文件上传解析或本地文本注入）
- **工具调用**：内置 `fetch_url`（网页抓取）、`todo_list`（待办），以及你自定义的 JS 工具
- **Agent 模式**：模型可连续多轮自主拆解任务、并行调用工具
- **工作台面板**：system prompt、temperature/top-p/max tokens/stop、JSON 模式、提示词模板
- **上下文预算**：发送前估算 token，超出窗口时自动省略最早的整轮对话（含附件），
  并在输入框上方说明省略了多少；窗口大小可在工作台里设置（默认 128k）
- **诊断日志**：每次请求记录轮次、工具调用、耗时与错误（只在内存里、不含对话正文），
  工作台底部可一键导出 JSON，出问题时能自己查
- **本地持久化**：对话、工具调用全文、附件内容都存在 IndexedDB（带 schema 版本，
  旧版 localStorage 数据首次启动自动迁移；刷新与重开都不丢）

## 快速开始

要求 Node.js **20.19+ 或 22.12+**（Vite 8 的要求）。

```bash
cd morandi-chat
npm install
npm run dev
```

打开终端里输出的地址，默认是 <http://localhost:5173/frontend-practice1/morandi-chat/>
（路径前缀来自 `vite.config.js` 里的 `base`，改成 `/` 即可部署在域名根目录）。

首次使用：点右上角「API 设置」→ 新增档案 → 选择服务商、填 API Key 与模型名 → 保存并切换到该档案。

其他命令：

```bash
npm run build     # 生产构建，产物在 dist/
npm run preview   # 本地预览构建产物
npm test          # 运行全部单元测试（vitest）
npm run lint      # oxlint 静态检查
```

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `VITE_FETCH_ENDPOINT` | `/__fetch__` | `fetch_url` 工具使用的抓取端点 |

浏览器直接抓取跨域网页会被 CORS 拦住，所以开发环境由 Vite 插件
（`fetch-proxy.js`）在 Node 侧代抓。迁移到自己的后端时，只需让后端提供同样的接口约定，
再把 `VITE_FETCH_ENDPOINT` 指向它，前端抓取与正文解析逻辑无需改动。

接口约定：`GET <endpoint>?url=<encodeURIComponent(目标URL)>`，返回 JSON 信封

```jsonc
{
  "ok": true,
  "status": 200,
  "finalUrl": "https://example.com/",
  "contentType": "text/html; charset=utf-8",
  "html": "<!doctype html>……",
  "truncated": false
}
```

失败时返回 `{ "ok": false, "error": "说明" }`；`ok: false` 且带 4xx 的错误不会被自动重试。

在项目根目录新建 `.env.local` 即可覆盖：

```bash
VITE_FETCH_ENDPOINT=https://your-backend.example.com/fetch
```

### 线上抓取端点（部署后 fetch_url 才能真正可用）

抓取代理是 Vite 的开发服务器插件，**只在本地 `npm run dev` 时存在**。部署到 GitHub Pages 后
如果没配置端点，`fetch_url` 会直接提示「抓取端点未配置」——要么按下面部署一个端点，
要么就别在工作台里启用这个工具。

仓库里自带一个可以直接部署的 Cloudflare Worker（`server/fetch-worker.js`，个人用量在免费额度内）：

```bash
cd morandi-chat/server
npx wrangler deploy     # 首次会要求登录 Cloudflare
```

把输出的地址（形如 `https://morandi-fetch.<账号>.workers.dev`）配到两处：

1. 线上：GitHub 仓库 → Settings → Secrets and variables → Actions → Variables，
   新增 `FETCH_ENDPOINT = <地址>`（部署工作流会在构建时注入）
2. 本地（可选）：`morandi-chat/.env.local` 里写 `VITE_FETCH_ENDPOINT=<地址>`；
   不配则继续用 dev server 自带的代理

Worker 与本地代理共用 `shared/ssrfGuard.js` 的同一套规则：拦截本机/内网/云元数据、
只放行 80/443、DNS-over-HTTPS 校验解析出的每个地址、重定向逐跳校验、响应体上限 2MB。
`server/wrangler.toml` 里的 `ALLOW_ORIGIN` 用于限制只有你的站点能跨域调用它；
想再加一道门槛可以 `npx wrangler secret put FETCH_TOKEN` 并在前端配 `VITE_FETCH_TOKEN`
（前端包里可见，属于提高盗用门槛，不是真正的机密）。

## 模型档案配置

内置了 7 种服务商预设：Kimi、DeepSeek、通义千问（百炼）、智谱 GLM、OpenAI、
OpenRouter、自定义（任意 OpenAI 兼容接口）。能力差异写在 `src/api/providers.js` 的 `caps` 里：

| 能力 | 说明 |
| --- | --- |
| `webSearch` | 官方联网搜索通道（目前仅 Kimi 公式通道） |
| `video` | 视频理解（仅 Kimi，走文件上传 + `ms://` 引用） |
| `fileExtract` | 服务端文档解析（Word/PPT/Excel/PDF，仅 Kimi） |
| `responseFormat` | 结构化输出（JSON Mode） |

档案存在 localStorage 的 `morandi-chat-config`，结构是 `{ profiles: [...], activeId }`；
旧版单档案配置会在启动时自动迁移。**对话数据存在 IndexedDB**（库 `morandi-chat` 的
`conversations` store，每个对话一条记录，schema 版本由 `src/api/db.js` 统一维护；
首次启动会把旧的 `morandi-chat-conversations` 自动导入并清理）。
其余 localStorage 键：
`morandi-chat-active`（当前对话）、`morandi-chat-workbench`（生成参数）、
`morandi-chat-prompts`（提示词模板）、`morandi-chat-tools`（自定义工具）、
`morandi-chat-native-tools`（内置工具开关）、`morandi-chat-todos`（待办）。

> API Key 以明文存在浏览器 localStorage 里，这是纯前端方案的取舍。请勿在公用电脑上保存 Key，
> 需要更强隔离时应改用自建后端代理。

## 工具系统

**内置工具**（工作台面板里可单独开关）

- `fetch_url`：抓取网页并提取正文（Mozilla Readability + 启发式清洗），回传上限 2 万字
- `todo_list`：查询/新增/完成/删除待办；写操作会弹出人工确认

**自定义工具**：在工作台里用 JavaScript 写函数体，声明成 OpenAI function 参数，前端本地执行。
代码只在你自己的浏览器里运行，请只放你信任的代码。

**联网搜索**：Kimi 的公式（Formula）通道，走标准 function 调用流程，工具失败会带原因回传给模型。

**Agent 模式**：允许模型连续多轮调用工具（上限 10 轮），相互独立的调用并行执行，
每轮最多自动重试 2 次（指数退避），危险操作先确认再执行。

**手动重跑某个失败的工具步骤**：只重跑那一步并更新展示，**不会**自动改写模型已有的回答——
界面上会明确提示「仅本地结果，未影响当前回答」，需要模型据此重新作答时点「用新结果重新回答」。

## 安全说明

- `fetch_url` 的代理会拦截本机环回、私网、链路本地与云厂商元数据地址
  （`127.0.0.0/8`、`10/8`、`172.16/12`、`192.168/16`、`169.254/16`、`100.100.100.200`、
  `::1`、`fc00::/7` 等），只放行 http/https 的 80/443 端口，DNS 解析出的每个地址都会校验，
  重定向逐跳校验（防「公网 302 到内网」）。规则本体在 `shared/ssrfGuard.js`，
  Node 端（本地代理）与线上 Worker（`server/fetch-worker.js`）共用同一份；
  浏览器端另有 `src/api/urlSafety.js` 在发请求前做一次快速预校验（纵深防御）。
- 开发服务器默认只监听本机环回（`vite.config.js` 的 `host: '127.0.0.1'`），减少暴露面
  （`fetch_url` 代理也挂在上面）。需要在局域网或 VPN 下访问时，把 `host` 改回 `true`。
- 代理不转发 Cookie，只抓取公开页面，超时 15 秒，响应体最多读 2MB。
- 自定义工具代码在前端执行，等同你自己运行的脚本权限。

## 诊断与排查

工作台面板底部有「诊断日志」：每次请求会记一条记录，包含服务商/模型、每轮的
工具调用数、工具执行阶段、联网来源数量、用量与错误信息，以及总耗时。

- **只在内存里**：不写磁盘、不上传，刷新页面即清空（最多保留最近 30 次请求）
- **不含对话正文**：只记长度与状态，导出前可以自己打开检查
- 出现「明明该成功却失败了」「工具没执行」这类问题时，导出这份 JSON 就能定位
  （写这版代码时它已经帮我抓到过一次 `onStatus is not defined` 的真实回归）

## 测试

```bash
npm test
```

GitHub Pages 的部署工作流会在构建前先跑 `npm test`，测试失败就不部署。

19 个测试文件、326 个用例（含整链路与 Worker 测试）：

| 文件 | 覆盖内容 |
| --- | --- |
| `src/api/__tests__/urlGuard.test.js` | SSRF 拦截规则：私网/元数据/IPv6/端口/协议、DNS 多地址、字面量 |
| `src/api/__tests__/history.test.js` | 对话树 → 请求消息：附件回灌、错误气泡过滤、联网失败回答剔除 |
| `src/api/__tests__/attachmentStore.test.js` | 附件内容 IndexedDB 存取、覆盖、删除、边界与配额保护 |
| `src/api/__tests__/fetcher.test.js` | 正文提取（article/main/Readability 兜底）与边界截断 |
| `src/api/__tests__/tools.test.js` | 工具编译、本地执行、错误可重试判定 |
| `src/api/__tests__/nativeTools.test.js` | 内置工具声明/开关/确认策略 |
| `src/api/__tests__/toolSteps.test.js` | 工具步骤状态收口（停止/失败/等待确认）与场景回归 |
| `src/api/__tests__/fullResultsStore.test.js` | 工具结果全文持久化 |
| `src/api/__tests__/urlSafety.test.js` | 浏览器端 URL 预校验：localhost / 私网 / 链路本地 / 云元数据 / 非法输入 |
| `src/components/__tests__/MessageBubble.test.jsx` | 消息气泡渲染：正文、思考块、JSON、工具步骤（@testing-library） |
| `src/api/__tests__/providers.test.js` | 生成参数能力：推理模型（kimi-k3 变体 / reasoner / o 系列）不发送采样参数 |
| `src/api/__tests__/contextBudget.test.js` | 上下文预算：中英文与多模态/附件的 token 估算、按预算整轮裁剪、最后一轮永远保留 |
| `src/api/__tests__/conversationStore.test.js` | 对话数据层：单条读写/排序/删除、schema 版本、从 localStorage 迁移与回滚备份 |
| `src/state/__tests__/conversationTree.test.js` | 对话树纯逻辑：可见路径与多版本分支、查找遍历、旧结构迁移 |
| `src/state/__tests__/liveStreamBuffer.test.js` | 流式缓冲：token 节流合并、正文与思考过程分离、结束与清理 |
| `src/api/__tests__/sessionTrace.test.js` | 诊断日志：步骤记录、容量上限、导出、订阅与隐私（不记正文） |
| `src/state/__tests__/configStore.test.js` | 配置与偏好：档案加载与旧版迁移、会话级 Key 不落盘、存储兜底、时间上下文 |
| `src/__tests__/App.integration.test.jsx` | 整链路：真 SSE 流式回复、工具调用循环、停止/继续生成、带附件重试、超预算裁剪与提示 |
| `src/__tests__/fetchWorker.test.js` | 线上抓取端点：私网/元数据/本机域名拦截、DoH 解析后校验、重定向跳转拦截、令牌与 CORS |

## 项目结构

```
morandi-chat/
├─ fetch-proxy.js          # 开发期抓取代理（Vite 插件），含安全校验入口
├─ urlGuard.js             # Node 端出网校验：DNS 解析 + 逐地址判定
├─ shared/ssrfGuard.js     # 出网安全规则本体（本地代理与线上 Worker 共用）
├─ server/                 # 线上抓取端点：Cloudflare Worker + wrangler 配置
├─ src/
│  ├─ App.jsx              # 状态中枢：对话树、流式、工具循环、持久化
│  ├─ api/
│  │  ├─ chat.js           # OpenAI 兼容流式请求 + 工具循环
│  │  ├─ providers.js      # 服务商预设与能力表
│  │  ├─ files.js          # 附件按能力分流处理
│  │  ├─ fetcher.js        # fetch_url 的传输层与正文提取
│  │  ├─ urlSafety.js      # 浏览器端抓取 URL 预校验（localhost/私网/元数据）
│  │  ├─ db.js             # IndexedDB 统一入口与 schema 版本（conversations / fullResults / meta）
│  │  ├─ conversationStore.js # 对话持久化（每条对话一条记录）
│  │  ├─ history.js        # 对话树 → 请求消息（含附件回灌）
│  │  ├─ attachmentStore.js# 附件内容 IndexedDB 持久化
│  │  ├─ fullResultsStore.js# 工具结果全文持久化
│  │  ├─ tools.js          # 自定义工具编译/执行
│  │  ├─ nativeTools.js    # 内置工具（fetch_url / todo_list）
│  │  ├─ sessionTrace.js   # 本地诊断日志（轮次/工具/耗时/错误，不含正文）
│  │  └─ todos.js          # 待办存储
│  ├─ hooks/               # useConversationStore（对话 store）、useChatRunner（请求编排）、useLiveStream、useContextBudget
│  ├─ state/               # 纯逻辑：conversationTree、liveStreamBuffer、configStore（档案与偏好）
│  └─ components/          # ChatArea / MessageBubble / RichContent（代码高亮、JSON 面板）/ Sidebar / Settings …
```

## 已知限制

- 历史里的附件会按节点重新带上（这样多轮对话不丢文件），但会持续消耗上下文长度；
  超出窗口时会自动省略最早的整轮对话（含附件）并在输入框上方提示。如果被省略的内容仍需要，
  可以新开一个对话，或把工作台里的「上下文窗口」调成模型真实上限。
- 音频文件目前所有服务商都不支持，发送时会跳过并告知模型。
- 单条附件载荷超过 32MB 时不做持久化（当次仍可正常发送，刷新后不可恢复）。
- 抓取代理的 DNS 校验与实际连接之间仍有理论上的 rebinding 时间窗；要对外暴露时，
  建议在连接层把目标 IP 钉死，或加上端点鉴权 token。

## 常见问题

**抓取网页提示「目标地址被拦截」**：这是安全策略，内网/本机/云元数据地址不允许通过抓取工具访问。

**抓取提示跨域或 404**：确认 `VITE_FETCH_ENDPOINT` 指向的端点存在且返回上面的 JSON 信封。

**换服务商后联网搜索/视频不可用**：这些是服务商能力差异，见上面的能力表。

**更新代码后页面还是旧的**：`npm run dev` 下刷新即可；生产构建需要重新 `npm run build`。
