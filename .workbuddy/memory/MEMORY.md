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

## AI 管家（pages/ai/assistant.js）录入字段映射（2026-10-15 关键）
- 录入走启发式解析（材料/花费/日记）+ LLM 兜底（`aiAssistant` mode:'extract'）。`send()` 用 try/catch+`finish()` 复位 loading，严禁裸调 Page 方法（须 `this.`）。
- **字段必须对齐集合读取端**，否则数据写进去了但页面读不到（用户实测「数据未对应到相应字段」）：
  - 材料：`remark`（非 `note`！）、`unit_price/total_price/planned_price`（分）、`belong/sub/stage_ids/stage_id/attachments/created_at/updated_at` 都要补。
  - 花费：`amount`(分)、`type`、`pay_date`、`stage_ids`+`stage_id`、`belong`、`remark`、`created_at`+`updated_at`、`deleted:false`。
  - 日记：`title/content/diary_date/room_ids`+`room_id`/`stage_ids`+`stage_id`/`created_at`+`updated_at`/`deleted:false`。
  - `dataWrite` 透传 `event.data`，字段名完全由前端负责；落库后用「我的/日记/花费/材料」页确认识别。
- 中文 NP 解析要点：head 不强制 `\s+`；总价 bMatch 先于裸 priceReC；name 清理先剥 bMatch 再 aMatch；alternation 长选项放最左；unitRe 用 alternation 非字符类。
