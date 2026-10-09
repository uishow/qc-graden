# 项目长期记忆 (qc-graden)

## 协作约定
- 改代码前先给用户方案确认，不擅自动手（用户 2026-10-07 明确要求）。涉及多文件或有歧义时先列选项让用户拍板，再写代码。

## 架构要点
- 微信原生小程序 + CloudBase 文档型数据库；适配层 utils/cloud.js 把 supabase 风格链式 API 映射到云开发（order 默认升序；neq 用于软删过滤；eq('id')→_id）。
- 软删：expenses/diaries 用 deleted:true；materials 硬删。插入须补 deleted:false、version:1、created_at。
- **附件**：expenses/materials 均有 `attachments: [{fileID,name,kind:'image'|'file'}]`（2026-10-08 加），通用工具 `utils/attachment.js`（choose/upload/previewImages/openFile，上限 9）；编辑页 budget/edit + material/edit 各有附件区；overview 列表有「附件N」角标。前端直传 wx.cloud.uploadFile；删除仅移除引用不删文件；fileID 不能直接 previewImage，须先 getTempFileURL。
- 花费页(budget/overview)为 tabBar 页，承载「花费」与「材料」两个标签。**已花费口径（2026-10-08 统一）**：非材料手动花费 + 已购买(bought)/已进场(on_site)材料合计；待购买(to_buy)不计入，推进后数字才变化；首页与花费页同口径（首页/花费页材料合计卡均显示「已购/待购」拆分）；全屋定制归集总额仍按清单全量。材料编辑子页 material/edit（用 navigateTo 进入）。**「单一真源」已拍板 = A+C（2026-10-09）**：维持 B 防重模型（不自动建/删 expenses）；budget/edit.js 保存前对材料清单按「金额一致 + 2 字滑窗文本交集」查重，命中弹「可能重复计入」确认框，确认后仍可保存（只提示不拦截）。
- 花费页是 tabBar 页，外部跳转用 wx.switchTab + store.setBudgetTab 暂存目标子标签，onShow 读取后清除（navigateTo 不能跳 tabBar 页）。
- **自定义 tabBar**（2026-10-08，选中项=主题色高亮胶囊）：app.json `tabBar.custom:true` + `custom-tab-bar/` 四件套；各 tab 页 onShow 必须调 `store.applyTabBar(this, 序号)`（0首页/1日记/2花费/3知识库/4我的）同步选中态与主题；新增 tab 页要同步改 custom-tab-bar list 与序号。组件内拿不到 page-root 的 CSS 变量，主题色在组件 wxss 自定义。
- 安全规则（2026-10-09 改）：`stages`/`rooms`/`diaries`/`expenses`/`materials` 写权限放宽为 `true`（任何登录用户可写，支持成员协同编辑他人创建的条目）；`knowledge_articles`/`knowledge_comments`/`projects`/`members` 保持 `doc._openid==auth.openid`（创建者可改）；`profiles`/`knowledge_categories` 服务端独占（`false`）。`projects`/`members` 的写统一走云函数 `joinProject`/`projectAdmin`（管理员上下文绕过规则）。
- **项目可见性 = 邀请码授权模式**（2026-10-09，由「全员可见」反转）：每个项目两种 6 位永久邀请码 `invite_code_family`(家庭码·加入得 `family`·全权限) / `invite_code_member`(协作码·加入得 `member`·仅协同编辑)，建项目时由 create.js 生成（两码互不相等），可各自重置（projectAdmin.regenCode）。加入走 `joinProject` 云函数（校验码→插 members(role,status:active)）。首页/我的/知识库均按本人 `members` 记录做隔离（不展示他人项目）；管理员(`owner`/`family`)可在「我的」页管理面板重置码/移除成员/退出/删除项目（projectAdmin）。角色：owner=管理员(可删项目)、family=家庭成员(全权限)、member=协作成员(仅编辑内容)。
- 云函数目录是 miniprogram/cloudfunctions/（DevTools 项目根=miniprogram/，project.config.json 的 cloudfunctionRoot=cloudfunctions/）；切忌建到仓库根 cloudfunctions/，DevTools 不扫那个目录（2026-10-07 曾建错导致用户看不到）。
- 标准施工阶段（`create.js` PRESET_STAGES / `syncStages.STAGES` 两处须一致，**共 10 段**）：准备→设计→主体拆改→水电改造→泥瓦工程→木工工程→油漆工程→安装阶段→软装进场→入住准备。**全屋定制已移出线性工序**（2026-10-09 确认），改为阶段看板按需手建的并行环节（从 `board?scope=wholehouse` 进入，key 一律 `customhome`）；新增线性阶段须两处同步改。阶段/名称识别：`wholehouse.js isWholeHouseStage`（key='customhome' 或名称含「全屋定制」/「定制」）；`board.js resolveStageKey` 含「定制」落 customhome，避开看板用户自建阶段占用的 key:'custom'。花费页全屋定制卡支持多阶段列表（2026-10-09 加）。
- 正文抓取为**格式感知**（方案A，2026-10-08 拍板）：`htmlToText` 把 `h1-h6→## `、`ul→- `、`ol→n. `、`blockquote→> `、`strong→**…**` 转成详情页轻量 markdown 可渲染的标记，花式内联样式（颜色/字号）丢弃。ul/ol/li 必须**单趟正则+栈**解析（分开 replace 栈状态不连续，ol 会失效）。`enrichArticle` 支持 `force:true` 覆盖重抓；详情页有「重新抓取正文」按钮（二次确认）。
- 换大模型 = 只改云函数环境变量（`LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL`，OpenAI 兼容）；**环境变量按函数隔离**，配错函数/没保存/值带引号空格是常见坑；备选方案：改读 `app_settings` 集合一次配全函数通用（未实施，用户确认环境变量配不进时再做）。
- 基础数据 vs 测试数据边界：基础=knowledge_categories(8 类，含全屋定制) + knowledge_articles(scope='official' 4 篇种子，由 init 写入)；测试=projects 及 members/stages/rooms/diaries/expenses/materials + knowledge_articles(scope='member' 成员导入)。清测试用 clearTestData 云函数（只删测试、不碰基础）。

## 大模型（LLM）配置约定
- `enrichArticle` 走 **OpenAI 兼容 HTTP**，配置全在云函数**环境变量**：`LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`（默认 deepseek-chat）。密钥绝不进代码库/前端。
- 地址会**自动补全** `/chat/completions`（填 `https://api.deepseek.com/v1` 或域名均可）。未配置或调用失败 → 降级为网页 meta 描述 + keywords，**不影响入库**；失败原因经 `aiError` 返回并在详情页弹窗提示。
- 环境变量**按单个云函数配置**：`enrichArticle` 与自检用的 `llmPing` 需各配一遍；改完保存即生效，无需重部署代码。
- 云函数出口在国内：**OpenAI/Claude 直连不通、本机 Ollama/localhost 不可用**，须用国内服务（DeepSeek / 智谱GLM / 通义千问 / 混元 / Kimi / 硅基流动 / 火山方舟）。
- 排查 AI 配置直接用详情页「补充内容与摘要」的 aiError 弹窗（信息最全）。曾短暂建过 `llmPing` 自检云函数，因需按函数重复配环境变量太繁琐，**用户要求已删除**（2026-10-08），不要再建议重建。

## 云函数部署检查清单（新增/改动被前端 wx.cloud.callFunction 调用的函数时，逐条核对）
1. **目录三件套**：每个云函数目录必须含 `index.js` + `package.json`(声明 `wx-server-sdk:latest`) + `config.json`({timeout,memorySize,installDependency:true})。**缺 package.json → DevTools 无法部署运行**（曾发生 confirmImaImport 只有 index.js、未部署，导致待确认区「确认/拒绝/一键全部导入」三按钮全无反应）。
2. **明确提醒部署**：每新增一个被前端调用的云函数，都要主动告诉用户去 DevTools 右键该函数 → 「上传并部署：云端安装依赖」。不能只部署部分函数——凡是前端 callFunction 用到的函数都得部署，否则表现为"按钮无反应/调用失败"。
3. **ima key 类函数额外项**（syncIma）：云函数环境变量配 `IMA_CLIENT_ID`/`IMA_API_KEY`（取自 `~/.config/ima/`，绝不进前端/不落代码库）；且 DevTools 重部署**不回写 timeout**，配完须去云控制台确认超时已生效（transferImaImages 曾因默认 3s 触发 433）。
4. **写操作走管理员上下文**：客户端直接写 knowledge_articles 会被安全规则 `doc._openid==auth.openid` 拦掉（云函数导入的文章无 `_openid`，静默失败/误判成功）。凡是确认导入/删除/状态翻转等写操作，统一走云函数（confirmImaImport / deleteArticle 模式），前端只 `wx.cloud.callFunction`。
5. **语法校验**：改动后跑 `node --check`（注意：对象简写属性 `{foo,}` 引用的是变量 `foo`，与 `fooKey` 不是一回事——这类 ReferenceError 运行时才炸，`node --check` 查不出，关键路径本地复现运行）。

## 前端通病/坑
- **底部弹窗按钮被裁切 / 键盘遮挡（bottomsheet clipping）**：自定义底部弹窗统一用 `.mask`+`.sheet`（见 app.wxss）。坑与正解：
  ① 遮罩 `.mask` 不能写 `inset:0`（部分基础库不识别）→ 显式 `top/left/right/bottom:0`，并用 `display:flex;flex-direction:column;justify-content:flex-end` 钉底。
  ② 长内容弹窗（如成员管理：标题+码+成员列表+退出/删除按钮）必须用「flex column + 可滚主体」结构：`.sheet` 设 `display:flex;flex-direction:column;max-height:86vh`；标题 `.sheet-head`(flex-shrink:0) + 中间可滚区 `.sheet-body`(flex:1;**min-height:0**;overflow-y:auto) + 底部 `.sheet-foot`(flex-shrink:0)。**关键 `min-height:0`**：不设时 flex 子项不会收缩到内容高度以下，会被长列表撑高把 foot 顶出可视区，按钮被裁切。可滚区用普通 `<view class="sheet-body">` 即可（**别用 `<scroll-view>`**：flex 内 scroll-view 默认不定高同样会溢出把 foot 顶出去）；`position:sticky` 在微信 WebView 不可靠，勿用。
  ③ 键盘遮挡：邀请码类带输入框弹窗，输入框设 `adjust-position="{{false}}"`，页面 `onShow` 注册 `wx.onKeyboardHeightChange` 把高度写入 `kbHeight` data、`onHide` 注销；`.sheet` 加 `style="margin-bottom:{{kbHeight}}px"` 整体抬到键盘上方。短弹窗（标题+输入+两按钮）无滚动，靠①即可，但仍建议统一加 `kbHeight` 防键盘遮挡。
  ④ **自定义 tabBar 会盖住页面 fixed 弹窗**（tabBar 框架包装层层级 > 普通弹窗，截图表现为底部按钮被 tabBar 压掉一半）：双保险修复 = `.mask` z-index 提到 99999（官方社区结论须 >9999）+ 弹窗打开期间 `this.getTabBar().setData({hidden:true})` 整条隐藏 tabBar（custom-tab-bar 加 `hidden` data + wxml `wx:if`），关闭/成功/`onHide` 时恢复 false。页面用 `setBarHidden(hidden)` 助手封装。
  ⑤ **弹窗内 input 自动聚焦禁止绑常驻布尔**（如 `focus="{{showJoin}}"`）：focus 常驻 true 时，键盘被 kbHeight 重排等打断后微信认为「仍聚焦」，再点输入框不拉键盘不收键。正解：一次性 `joinFocus` 开关——goJoin 里先 false、`setTimeout 300ms` 后置 true；input 加 `bindblur` 失焦即复位；cancel/confirm/校验失败路径全部复位并 clearTimeout。
  ⑥ **数字输入「敲了不回显」终极解法 = 6 格验证码样式（透明 input + data 驱动格子）**：`type="number"` 在部分机型有敲键不回显的顽疾（邀请码两次中招）。邀请码弹窗已改为：6 个 `.code-cell` 格子由 `codeCells` data 渲染，透明 `.code-input`（opacity:0 绝对定位盖在格子上，type="digit"）只负责聚焦收键盘；`_applyCode(v)` 统一回填（去非数字、截 6 位、算格子）。显示不依赖原生回显，敲没敲进来看格子即知。首页/我的页均此实现，`.join-input` 样式已删。
  ⑦ **canvas 2d 所在的块不要用 wx:if 反复卸载，用 hidden 显隐**：退出项目 → 首页 `wx:elif` 整块卸载（含饼图 canvas 2d）→ 部分机型 WebView 布局损坏（内容挤压、自定义 tabBar 悬空在 3/4 屏处、下方漏页面底色），重启小程序才恢复（2026-10-09 实测）。正解：首页改 `<view class="home-main" hidden="{{!project}}">` 常驻显隐；drawPie 等画布逻辑加零尺寸守卫（hidden 时 fields size=0 直接 return）。同层渲染不可用的老设备上，任何「创建/销毁原生组件节点」的动态操作都可能损坏布局。
- **wx.showLoading 与 wx.showToast 共用同一原生单例视图**：失败分支「先 showToast 再 finally hideLoading」会把刚弹出的错误提示瞬间关掉，表现为「操作失败但没有任何提示」（2026-10-09 邀请码输错无提示的根因）。正解：先 `wx.hideLoading()` 再 `wx.showToast`——把 callFunction 包在 try/catch/finally 里只取 result，hideLoading 放 finally，toast 判断放到 hideLoading 之后。confirmJoin/regenCode/removeMember/exit/delete 全部按此模式改。
- **金额「元↔分」往返陷阱（fen2yuan / yuan2fen）**：`utils/format.js` 的 `fen2yuan` 对 ≥1000 元会插入千分位逗号（如 "1,234.00"），而 `yuan2fen` 必须先把逗号去掉再 `Number()` 解析（`String(yuan).replace(/,/g,'')`），否则 `Number("1,234.00")` 为 NaN→0。后果：编辑已存金额 ≥1000 的花费/材料时，`onSave` 的 `if(fen<=0)` 守卫会误判「金额为 0」拦截保存（用户反馈「点明细能编辑但不能保存」的根因）。一次性改 `yuan2fen` 即可同时修好 budget/edit.js 与 material/edit.js。录入框统一用 `type="digit"`（非 number，避免受控不回显）。
