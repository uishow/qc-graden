# AI 摘要功能 · 大模型环境变量配置指引

> 适用对象：`enrichArticle` 云函数（确认导入后自动生成「摘要 + 标签」）。
> 不配任何环境变量也能用——会自动降级为「网页描述 + 关键词」的轻量抽取，只是摘要没那么精炼。

## ⭐ 2026-10-09 起：推荐用「AI 设置」集中配置（免逐函数配环境变量）

小程序「我的」页 →「AI 设置」（仅家庭成员可见）→ 填接口地址 / 模型名 / API Key → 保存。
配置集中存于 `app_settings` 集合（安全规则 read/write 均为 false，客户端完全不可见），
`enrichArticle` / `askAI` / `weeklyDigest` 三个函数**共用这一份**，改一次全生效。

- 首次保存时 `aiAdmin` 云函数会自动创建 `app_settings` 集合，无需手动建。
- API Key 保存后不再回显（只显示尾 4 位）；留空保存 = 不修改密钥。
- 环境变量仍有效但**优先级更低**：集合里没有配置时才回退用 env。
- 前提：`aiAdmin` 云函数已部署（DevTools 右键上传并部署）。

## 旧方式：逐函数配环境变量（仍兼容，作兜底）

## 在哪里填

微信开发者工具 → 云开发控制台 → 云函数 → **enrichArticle** → **配置** → **环境变量** → 添加（Key / Value 成对）。填完保存后，再回 DevTools 右键 `enrichArticle` →「上传并部署：云端安装依赖」让运行时加载。

## 需要哪几个变量

| 变量名 | 是否必填 | 说明 |
|---|---|---|
| `LLM_BASE_URL` | 选填* | 完整的 chat/completions 地址。填了才会用大模型。 |
| `LLM_API_KEY` | 选填* | 模型服务密钥。**不填=走降级抽取**。 |
| `LLM_MODEL` | 选填 | 模型名，不填默认 `deepseek-chat`。 |

\* 想用「真·AI 摘要」就至少填 `LLM_BASE_URL` + `LLM_API_KEY`。

## 方案 A：腾讯混元（推荐，国内网络顺畅）

先到 腾讯云控制台 → 混元大模型 → **API Key 管理** → 创建一个 API Key（复制保存好）。

| 变量 | 填写值 |
|---|---|
| `LLM_BASE_URL` | `https://api.hunyuan.cloud.tencent.com/v1/chat/completions` |
| `LLM_API_KEY` | 你刚创建的混元 API Key |
| `LLM_MODEL` | 如 `hunyuan-t1` / `hunyuan-turbo` / `hunyuan-large`（按控制台可用列表填） |

## 方案 B：DeepSeek（OpenAI 兼容，文档最全）

| 变量 | 填写值 |
|---|---|
| `LLM_BASE_URL` | `https://api.deepseek.com/v1/chat/completions` |
| `LLM_API_KEY` | 你的 DeepSeek API Key（平台充值后创建） |
| `LLM_MODEL` | `deepseek-chat` |

## 原理说明

- 云函数用 Node 内置 `https` 调 **OpenAI 兼容接口**，请求头 `Authorization: Bearer <API_KEY>`，不落代码库、不进前端。
- 提示词要求模型**只输出 JSON**：`{"summary":"...","tags":["..."]}`；代码会容忍模型返回 markdown 包裹或逗号分隔标签。
- 密钥只放云函数环境变量，前端永远拿不到。

## 常见问题

- **没反应 / 摘要很敷衍** → 多半是没配 `LLM_API_KEY`，走了降级抽取。
- **报 401 / 鉴权失败** → API Key 不对或已失效；混元若你的账号只给了 SecretId/SecretKey（需 TC3 签名，不支持 Bearer），告诉开发者，我改成 TC3 签名方式。
- **图片类条目摘要就是标题** → 图片没有正文可读，目前不做看图识别（vision）；需要的话可另行接入。