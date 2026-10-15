# 项目长期记忆 (qc-graden)

## 协作约定
- 改代码前先给用户方案确认，不擅自动手（用户 2026-10-07 明确要求）。涉及多文件或有歧义时先列选项。

## 架构要点
- 微信原生小程序 + CloudBase 文档型数据库；适配层 `utils/cloud.js` 把 supabase 风格链式 API 映射到云开发（order 默认升序；neq 软删过滤；eq('id')→_id）。
- 软删：expenses/diaries 用 `deleted:true`；materials 硬删。插入须补 `deleted:false`、`version:1`、`created_at`。
- **附件**：expenses/materials 均有 `attachments:[{fileID,name,kind}]`，通用 `utils/attachment.js`；前端直传 `wx.cloud.uploadFile`，删除仅移除引用。
- **已花费口径**：非材料手动花费 + 已购(bought)/已进场(on_site)材料合计；待购(to_buy)不计入。全屋定制归集按清单全量。
- **自定义 tabBar**：`app.json tabBar.custom:true` + `custom-tab-bar/` 四件套；tab 页 onShow 必调 `store.applyTabBar(this,序号)`；`.bar` 必须自带 `position:fixed;left/right/bottom:0` 钉底（否则键盘/重编译会 tabBar 悬空半屏）。
- **安全规则**：diaries/expenses/materials 写收为 false，增删改统一走云函数 `dataWrite`（落库前查 members 确认 active，非 active 返回 `NO_MEMBER`）。客户端封装 `utils/write.js`（`write.insert/update/remove`）。**部署顺序：先部署 dataWrite 验证，再把三张表规则改 false**。
- **项目可见性 = 邀请码授权**：`invite_code_family`(family·全权限)/`invite_code_member`(member·协同)，由 create.js 生成，joinProject 加入；首页/我的/知识库按本人 members 隔离。
- 云函数目录是 `miniprogram/cloudfunctions/`（DevTools 项目根=miniprogram/），勿建到仓库根 cloudfunctions/。
- 标准施工阶段共 10 段（PRESET_STAGES + syncStages.STAGES 两处须一致）；全屋定制已移出线性工序，改阶段看板并行环节（key='customhome'）。

## 大模型（LLM）配置约定
- 集中配置 `app_settings`(key='llm'：base_url/api_key/model) 为唯一真源，「我的→AI 设置」经 `aiAdmin` 读写；env 变量降级兜底。安全规则 read/write=false（存密钥）。
- LLM 走 OpenAI 兼容 HTTP（自动补 `/chat/completions`）；未配/失败各函数独立降级，不影响主功能。国内须用 DeepSeek/智谱/通义/混元/Kimi/硅基流动/火山（OpenAI/Claude 直连不通）。
- 排查用前端 `aiError`。勿重建已删的 llmPing 自检函数。

## 云函数部署清单（新增/改动被 callFunction 调用的函数时逐条核对）
1. 目录三件套：index.js + package.json(wx-server-sdk:latest) + config.json(timeout,memorySize,installDependency:true)。
2. 主动提醒用户去 DevTools 右键「上传并部署：云端安装依赖」；凡前端用到的函数都得部署。
3. ima key 函数：配 IMA_CLIENT_ID/IMA_API_KEY（取自 ~/.config/ima/，不进代码库）；重部署不回写 timeout，须去控制台确认。
4. 写操作走管理员上下文（云函数导入文章无 _openid 会被规则拦），前端只 callFunction。
5. 改动后跑 `node --check`；对象简写 `{foo,}` 引用的是变量 foo，node --check 查不出，关键路径本地复现运行。

## 前端通病/坑（ terse ）
- 底部弹窗用 `.mask`+`.sheet`：`.mask` 显式 top/left/right/bottom:0 + flex column end 钉底；长弹窗 `.sheet` flex column + `.sheet-body` flex:1 min-height:0 overflow-y:auto + head/foot flex-shrink:0（缺 min-height:0 会把 foot 顶出裁切）；别用 scroll-view/position:sticky。
- 键盘遮挡：弹窗输入框 adjust-position=false，onShow 注册 onKeyboardHeightChange 写 kbHeight，onHide 注销，.sheet margin-bottom:kbHeight。
- 自定义 tabBar 盖住 fixed 弹窗：.mask z-index 99999 + 弹窗期 `getTabBar().setData({hidden:true})`；封装 `setBarHidden`。
- 数字 input 不回显：邀请码改 6 格验证码样式（透明 input + data 驱动格子）。
- canvas 2d 块用 hidden 显隐（勿 wx:if 反复卸载，会损 WebView 布局）。
- wx.showLoading/showToast 同单例：先 hideLoading 再 showToast（放 try/finally）。
- 金额元↔分：`fen2yuan` ≥1000 插千分位逗号，`yuan2fen` 须先 `replace(/,/g,'')` 再 Number，否则 NaN→0 误判金额 0 拦截保存。
- textarea 默认 maxlength=140：长文本须 `maxlength="{{-1}}"` + auto-height。
- callFunction 约 15s 客户端超时(-1)：LLM 请求 max_tokens 限长 + 函数内 http 13s 截止 + 控制台确认函数超时 60s。
- 云函数内主键是 `_id` 不是 `id`（组装回传 id 用 `a._id || a.id`）。
- 时间显示统一 `utils/time.js.formatLocal`（DB 存 UTC 串，强制 +8h；勿用 toLocaleString，HarmonyOS 不准）；云函数内联同款。
- `app_feedback` 集合 `.order()` 报 not a function：改拉全表 + JS sort；新集合第一时间建 created_at 索引。
- **拼 where 条件的辅助函数必须同步**：曾把 `visibleWhere` 写成 `async`，`where(一个 Promise)` 会让条件
  **静默失效**（`Object.keys(promise)` 为空 → 全部命中），一行都挡不住且测试初看能跑。
- 云函数聚合查询用 `fetchAll` 分页（100/页、最多 10 页），别 `limit(500)`：单次上限各环境不一致会静默少算。
- 云函数可脱离真环境单测：`Module._load` 桩掉 `wx-server-sdk` + 内存版 CloudBase，直接调 `exports.main`
  （见 `tests/ai-feedback.harness.js`），权限门禁这类逻辑一定要这样测，否则只能靠线上试。

## AI 管家（pages/ai/assistant.js）录入字段映射（2026-10-15 关键）
- 录入走启发式解析（材料/花费/日记）+ LLM 兜底（`aiAssistant` mode:'extract'）。`send()` 用 try/catch+`finish()` 复位 loading，严禁裸调 Page 方法（须 `this.`）。
- **字段必须对齐集合读取端**，否则数据写进去了但页面读不到（用户实测「数据未对应到相应字段」）：
  - 材料：`remark`（非 `note`！）、`unit_price/total_price/planned_price`（分）、`belong/sub/stage_ids/stage_id/attachments/created_at/updated_at` 都要补。
  - 花费：`amount`(分)、`type`、`pay_date`、`stage_ids`+`stage_id`、`belong`、`remark`、`created_at`+`updated_at`、`deleted:false`。
  - 日记：`title/content/diary_date/room_ids`+`room_id`/`stage_ids`+`stage_id`/`created_at`+`updated_at`/`deleted:false`。
  - `dataWrite` 透传 `event.data`，字段名完全由前端负责；落库后用「我的/日记/花费/材料」页确认识别。
- **`snapshot` 没有 id，`raw` 才有**（2026-10-15 大坑）：`buildSnapshot` 返回的 `snapshot`（发 LLM 用）里 rooms/stages 只有 `name`；带 `id` 的原始数组在 `raw`。凡「名字→id 映射」或「id→名字」必须用 `raw`（`_matchStageIds/_matchRoomIds`、`_adaptLLMData` 的 nameToId、`_entryRows` 的 roomMap/stageMap）。用 snapshot 会得到 `undefined` id → **阶段/房间关联静默丢失**（即「数据未对应到字段」）。纯名字列表用 `_knownStageNames()/_knownRoomNames()`（不过滤长度；剥词时自行 `.filter(n=>n.length>=2)`）。快照卡**展示**文本在 `snapshotView`（`stagesText/spentText/...`），不在 `snapshot`。
- **写 harness 桩必须还原真实数据形状**：曾给桩 `snapshot` 塞 id，把这个 bug 完全掩盖（测试全绿、线上坏）。另外微信 `setData` 支持路径键（`form.stage_ids`），桩里 `Object.assign` 不支持，需手写 path-set；`wx.showToast` 等也要补桩。
- 中文 NP 解析要点：head 不强制 `\s+`；总价 bMatch 先于裸 priceReC；name 清理先剥 bMatch 再 aMatch；alternation 长选项放最左；unitRe 用 alternation 非字符类。
- **意图路由顺序（send 内固定）**：`_routeQuery`（统计问答）→ `_isDiaryLookup`（显示日记附件，2-gram+DF 选篇→createSignedUrls 气泡渲染图）→ `detectIntent`（录入）。显示/找出/打开/搜等动词一律进 isQuestion 不算录入；hasDiary 判在 hasMat 前（`日记(?!本)`）。
- 显式字段声明优先：材料 `品牌是X/牌子X/X牌`（MAT_ATTR_WORDS 属性词表 stripAttr 防实木当品牌）；花费 `备注/说明/事由` `类型/类别`；金额兜底 `花了500/金额：500` 无元形态。
- **录入成功后不自动跳转**（用户 2026-10-15 要求去掉，已删 `_afterEntryJump` 及 3 处调用）；回执改为「可在「XX」页查看…」。
- **技术路线决策（2026-10-15）：混合渐进——① 先上预览确认卡（解析成功弹字段卡，确认才落库，最高 ROI）② 再上 LLM 结构化抽取（部署 aiAssistant extract + JSON schema + 校验修复，正则退兜底）③ 最后引导式半屏表单。Phase1 已落地。**
- Node stub 坑：`utils/cloud.js` 是具名导出 `{ cloud }`，桩必须 `{ cloud: {...} }` 包裹，否则解构 undefined 抛错被兜底吞成 null；新增依赖（如 `utils/aiFeedback`）必须同步在 harness 的 `Module._load` 里补桩。

## 反馈闭环（2026-10-15 建成，用户「全做」）
- 结构：埋点（`assistant.js` 7 类信号）→ 集合 `ai_feedback`（规则 read/write=false）→ 云函数 `aiFeedback`（log/list/setStatus/summary，管理员=members role owner|family）→ 待办台 `pages/ai/feedback`（我的页管理员入口+角标）。
- 信号：edit_diff（最高价值，带 understood/fixed 标准答案）> unparsed > thumb_down > no_result > retry > cancel > degraded。
- **retry 判定阈值：2-gram 重合率 ≥0.8 且长度比 ≥0.6**（0.6 会把「水电阶段花了多少/木工阶段花了多少」误判重问）。
- 待办台「复制待办」导出「原文+AI解析+用户改后答案」，可直接贴给 AI 批量修并补回归用例。
- 部署依赖：控制台建 `ai_feedback` 集合 + 建 created_at 索引 + 规则改 false；`aiFeedback` 与 `aiAssistant` 都要重新上传部署。
