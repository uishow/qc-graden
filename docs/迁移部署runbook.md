# 迁移部署 Runbook · 微信云开发

> 目标：把「多人协作装修日记本」小程序从 WorkBuddy 云服务切换为微信云开发（CloudBase）后，完成首次可运行部署。
> 环境 ID：`cloudbase-d0gcanr6v1194af27` ｜ AppID：`wx5074d5bfbc6e1aaf`
> 前置：数据层迁移代码已完成（见 `utils/cloud.js` 及 13 个页面改造，commit 于 feat/云开发迁移 分支）。

## 0. 改动清单（已落地，供核对）

- [x] `utils/cloud.js`：supabase 链式 API → 云开发文档型适配层（`id`↔`_id`、乐观锁、签名 URL）
- [x] `app.js`：`wx.cloud.init({env})` + 静默登录（`ensureLogin` 调 login 云函数）
- [x] `store.js`：`currentProjectId` 不再 `Number()`，原样存字符串 `_id`
- [x] `project.config.json`：加 `cloudfunctionRoot: "cloudfunctions/"`
- [x] 云函数 `login`（OPENID + upsert profiles）、`init`（幂等写分类 + 官方文章，带 `status:'published'` 与 `category_id`）
- [x] `package.json`：移除 `@tencent-ai/workbuddy-cloud-sdk` 依赖
- [x] 页面改造：`user/profile`、`index`、`knowledge/detail` 的 members 关系查询 / `rpc` 自增 / `Number(id)` 已替换；`knowledge/index` 关键词搜索走适配层 `ilike`（→ 云开发正则）

## 1. 用微信开发者工具打开项目

1. 打开微信开发者工具 → 导入项目 → 目录选 `miniprogram/`，AppID 填 `wx5074d5bfbc6e1aaf`。
2. 工具会自动识别 `cloudfunctionRoot`，左侧出现「云开发」入口。

## 2. 开通 / 确认云开发环境

1. 点左上角「云开发」→ 若未开通按向导开通；确认环境 ID 为 `cloudbase-d0gcanr6v1194af27`（与 `app.js` 中 `env` 一致）。
2. 记录环境对应的**存储桶**与**数据库**入口，无需额外建桶。

## 3. 部署云函数（关键）

对 `cloudfunctions/login` 与 `cloudfunctions/init` 分别操作：

1. 在 `cloudfunctions/login` 目录上**右键 → 上传并部署：云端安装依赖**（推荐，省去本地 npm）。
   - 若选「本地上传」，需先 `cd cloudfunctions/login && npm install`（装 `wx-server-sdk`）。
2. 同样部署 `cloudfunctions/init`。
3. 部署后在「云开发 → 云函数」能看到 `login`、`init` 且状态正常。

> 验证：云函数列表点 `login` → 测试调用（空参数），应返回 `{ openid: "..." }`。

## 4. 建数据库集合 + 索引

1. 「云开发 → 数据库 → 新建集合」，建立以下 12 个集合（名称务必一致）：
   `projects, members, rooms, stages, diaries, expenses, materials, revisions, profiles, knowledge_categories, knowledge_articles, knowledge_comments`
2. 为高频查询字段建单字段索引（提升 `.where().orderBy()` 性能）：
   - `members`：`user_id`↑、`project_id`↑
   - `diaries`：`project_id`↑、`diary_date`↓
   - `expenses`：`project_id`↑、`pay_date`↓
   - `materials`：`project_id`↑
   - `stages`：`project_id`↑、`sort_order`↑
   - `knowledge_articles`：`status`↑、`category_id`↑、`view_count`↓
   - `knowledge_comments`：`article_id`↑
3. 各集合粘贴 `云开发安全规则.md` 第 2 节的 JSON（或逐集合按第 3 节表设置）。

## 5. 灌种子数据

1. 在「云开发 → 云函数 → init → 测试调用」触发一次。
2. 检查 `knowledge_categories` 有 7 条、`knowledge_articles` 有 4 条且带 `status:'published'`、`category_id` 非空。
3. （可选重复触发验证幂等：数量不变、无重复。）

## 6. 编译运行 + 真机自检

1. 开发者工具编译，模拟器走一遍：
   - 首次进入走静默登录（无需授权弹窗）。
   - 建项目 → 自动写入 `members`(owner)、`stages`(8)、`rooms`(6)。
   - 记一篇日记（带图）→ 检查 `diaries.image_paths` 为 `cloud://` fileID，`storage` 有对应文件。
   - 知识库：切分类、搜关键词，文章能打开、浏览量 +1。
   - 我的 → 项目列表能显示、可切换。
2. 真机预览（同一 AppID 下微信号）再走一遍，确认 openid 与存储回显正常。

## 7. 收尾

- [ ] 隐私清单：确认 `project.config.json` 同级 `privacy.json`（Album + EXUserPublishContent）已配（Task #4 产物），上传时勾选「用户隐私保护指引」。
- [ ] 旧 WorkBuddy 云服务 13 张表**暂保留**（评估文档结论），确认前端不再引用 `@tencent-ai/workbuddy-cloud-sdk`（已移除）。
- [ ] 设计文档 §2 已改述为微信云开发（见 `docs/多人协作装修日记本-设计文档-V1.0.md`）。

## 8. 回退方案

若云开发出现不可接受问题，前端因有 `utils/cloud.js` 这一唯一边界，只需把该适配层换回 WorkBuddy SDK 实现即可，13 个页面代码无需改动。
