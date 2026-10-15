// AI 管家解析/意图回归语料。用法：node tests/ai-assistant.harness.js
// 约定：每修一个理解类 bug = 补一条用例；改解析规则后必须全量跑通再提交。
// 加载真实 miniprogram/pages/ai/assistant.js，stub 掉所有依赖，验证解析逻辑
const Module = require('module')
const path = require('path')

const FILE = path.join(__dirname, '..', 'miniprogram', 'pages', 'ai', 'assistant.js')

// —— stub 数据 ——
const diariesData = [
  { id: 'd1', title: '户型图确认', content: '今天和设计师确认了户型图，附件是最终版户型图', diary_date: '2026-10-10', image_paths: ['cloud://a', 'cloud://b'] },
  { id: 'd2', title: '水电验收', content: '客厅水电验收完成，师傅说下周做防水', diary_date: '2026-10-12', image_paths: [] },
  { id: 'd3', title: '土建进场日记 999', content: '999楼项目今天土建进场', diary_date: '2026-10-14', image_paths: ['cloud://c', 'cloud://d', 'cloud://e', 'cloud://f', 'cloud://g', 'cloud://h'] },
]

// —— stubs ——（注意：真实 utils/cloud.js 是具名导出 { cloud }，assistant.js 解构取 cloud）
const cloudImpl = {
  database: {
    from: (col) => ({
      select: () => ({
        eq: () => ({
          neq: () => ({
            limit: async () => ({ data: col === 'diaries' ? diariesData : [], error: null }),
            order: () => ({ limit: async () => ({ data: [], error: null }) }),
          }),
        }),
      }),
    }),
  },
  storage: {
    createSignedUrls: async (paths) => ({ data: (paths || []).map((p) => ({ signedUrl: 'https://tmp/' + p })), error: null }),
  },
}
const stubCloud = { cloud: cloudImpl }
const stubStore = { getCurrentProjectId: () => 'p1', applyTheme() {}, applyTabBar() {} }
const stubAccess = { checkMember: async () => true, myProjectIds: async () => ['p1'] }
const stubArrayId = {
  tagsOf: (x) => (x && (x.stage_ids || (x.stage_id ? [x.stage_id] : []))) || [],
  normalizeIds: (a) => (Array.isArray(a) ? a : (a ? [a] : [])),
}
let lastInsert = null
let lastUpdate = null
const stubWrite = {
  insert: async (col, pid, data) => { lastInsert = { col, pid, data }; return { data: [{ id: 'x', _id: 'x' }], error: null } },
  update: async (col, pid, id, data) => { lastUpdate = { col, pid, id, data }; return { data: [{ id }], error: null } },
  remove: async () => ({ data: [], error: null }),
}

const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request.endsWith('utils/cloud')) return stubCloud
  if (request.endsWith('utils/store')) return stubStore
  if (request.endsWith('utils/access')) return stubAccess
  if (request.endsWith('utils/arrayId')) return stubArrayId
  if (request.endsWith('utils/write')) return stubWrite
  return origLoad.apply(this, arguments)
}

global.Page = (cfg) => { global.__page = cfg }
global.getApp = () => ({ ready: async () => ({ id: 'u1' }) })
global.wx = {
  cloud: {
    callFunction: async (arg) => {
      const d = (arg && arg.data) || {}
      // mode:'parse' 用可注入的 mock，便于验证 LLM 理解优先链路
      if (d.mode === 'parse' && global.__parseMock !== undefined) return { result: global.__parseMock }
      if (d.question && global.__qaAnswer !== undefined) return { result: { ok: true, answer: global.__qaAnswer, ai: true } }
      return { result: { ok: true, answer: 'x' } }
    },
  },
  onKeyboardHeightChange() {}, offKeyboardHeightChange() {},
  switchTab() { global.__switchTabCount++ }, navigateTo() {}, previewImage() {},
  showToast() {}, hideLoading() {}, showLoading() {},
}

require(FILE)
const cfg = global.__page
const ctx = Object.assign({}, cfg)
// 刻意还原真实结构：snapshot 是发给 LLM 的精简版（只有 name、没有 id），
// raw 才是带 id 的原始数组。这样能真正验证「名字→id 映射必须走 raw」这一修复。
ctx.data = {
  snapshot: {
    rooms: [{ name: '主卧' }, { name: '客厅' }],       // 无 id
    stages: [{ name: '水电改造', status: 'doing' }],    // 无 id
  },
  raw: {
    expenses: [{ amount: 500000, type: 'labor', pay_date: '2026-10-15', stage_ids: ['s1'] }],
    materials: [], diaries: [{ title: '土建进场日记 999' }, { title: '水电验收' }],
    stages: [
      { id: 's0', name: '准备阶段', status: 'pending' },
      { id: 's1', name: '水电改造', status: 'doing' },
    ],
    rooms: [{ id: 'r1', name: '主卧' }, { id: 'r2', name: '客厅' }],
  },
  messages: [],
  // Phase 3 表单状态（真实 data 里也有，这里手工补齐以便驱动）
  // 真实结构里展示用的项目名在 snapshotView
  snapshotView: { projectName: '测试项目' },
  formOpen: false,
  formKind: '',
  form: {},
  typeOptions: ['人工', '设计', '订金/定金', '其他', '材料'],
}

let pass = 0, fail = 0
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  → ' + detail : '')) }
}

const LOOKUP_TEXT = '在户型图好了，那篇日记里面有一个附件，那个附件就是户型图，请显示出来。'

console.log('\n=== A. 意图识别（含显示类不误判为录入） ===')
check('显示日记附件 → null（不录入）', ctx.detectIntent(LOOKUP_TEXT) === null, ctx.detectIntent(LOOKUP_TEXT))
check('录入日记 → diary', ctx.detectIntent('录入日记 今天主卧刷了墙漆') === 'diary')
check('记日记 → diary', ctx.detectIntent('记日记 今天客厅水电验收完成') === 'diary')
check('录入材料 → material', ctx.detectIntent('录入材料 欧派木门 三张 300一张') === 'material')
check('今天叙述 → diary', ctx.detectIntent('今天主卧刷了墙漆') === 'diary')
check('本月花费(问句) → null', ctx.detectIntent('本月花费多少') === null)

console.log('\n=== B. 日记附件查询 ===')
check('_isDiaryLookup 识别', ctx._isDiaryLookup(LOOKUP_TEXT) === true)
check('_isDiaryLookup 普通录入不命中', ctx._isDiaryLookup('录入日记 今天主卧刷了墙漆') === false)
const picked = ctx._pickDiaryByText(LOOKUP_TEXT, diariesData)
check('2-gram 选篇命中 户型图日记', picked && picked.id === 'd1', picked && picked.id)

console.log('\n=== C. 材料品牌解析 ===')
function mat(t) { return ctx.tryParseIntakeMaterial(t) }
let m1 = mat('录入材料 品牌大自然 木地板 10平方 200元/平方')
check('显式品牌：大自然 / 木地板', m1 && m1.brand === '大自然' && m1.name === '木地板', JSON.stringify(m1))
let m2 = mat('录入材料 欧派木门 三张 300一张')
check('组合品牌：欧派 / 木门', m2 && m2.brand === '欧派' && m2.name === '木门', JSON.stringify(m2))
let m3 = mat('录入材料 实木地板 5平方')
check('属性词不实为品牌：brand空 / name=实木地板', m3 && m3.brand === '' && m3.name === '实木地板', JSON.stringify(m3))

console.log('\n=== D. 花费录入健壮性 ===')
function exp(t) { return ctx.tryParseExpense(t) }
let e1 = exp('记一笔 人工 5000元 今天 水电改造')
check('基础：金额/类型/阶段', e1 && e1.amount === 500000 && e1.type === 'labor' && e1.stage_ids.indexOf('s1') !== -1, JSON.stringify(e1))
let e2 = exp('录入花费 500元 备注：水电尾款 类型：人工 今天')
check('显式备注+类型：remark=水电尾款 / labor', e2 && e2.remark === '水电尾款' && e2.type === 'labor', JSON.stringify(e2))
let e3 = exp('记一笔 花了500 水电改造')
check('无「元」金额：花了500 → 50000分', e3 && e3.amount === 50000, JSON.stringify(e3))
let e4 = exp('录入花费 金额：800 说明：瓷砖定金')
check('金额：800 + 说明 → remark', e4 && e4.amount === 80000 && e4.remark === '瓷砖定金', JSON.stringify(e4))

async function main() {
  console.log('\n=== E. 附件查询端到端（查库→选篇→换链接） ===')
  const found = await ctx._handleDiaryLookup(LOOKUP_TEXT)
  check('返回带图消息', !!(found && found.images && found.images.length === 2), JSON.stringify(found))
  check('文案含日记标题', !!(found && found.text.indexOf('户型图确认') !== -1))
  const noImg = await ctx._handleDiaryLookup('请显示水电验收那篇日记的附件')
  check('无附件日记给出文案提示', !!(noImg && noImg.text && (!noImg.images || !noImg.images.length)), JSON.stringify(noImg))

  console.log('\n=== F. 日记解析 + 写入（回归） ===')
  let d1 = ctx.tryParseDiary('录入日记 今天主卧刷了墙漆，师傅说下周做防水')
  check('日记可解析', !!(d1 && d1.content && d1.content.length >= 2), JSON.stringify(d1))
  lastInsert = null
  await ctx._handleIntakeDiary(d1)
  check('日记写入 diaries + deleted:false', lastInsert && lastInsert.col === 'diaries' && lastInsert.data.deleted === false)
  lastInsert = null
  await ctx._handleIntakeMaterial(m1)
  check('材料写入 materials + brand', lastInsert && lastInsert.col === 'materials' && lastInsert.data.brand === '大自然')
  lastInsert = null
  await ctx._handleIntakeExpense(e2)
  check('花费写入 expenses + remark', lastInsert && lastInsert.col === 'expenses' && lastInsert.data.remark === '水电尾款')

  console.log('\n=== F2. 录入后不再自动跳转（用户 2026-10-15 要求去掉） ===')
  global.__switchTabCount = 0
  await ctx._handleIntakeDiary(d1)
  await ctx._handleIntakeMaterial(m1)
  await ctx._handleIntakeExpense(e2)
  check('三类录入后均未触发 switchTab', global.__switchTabCount === 0, 'switchTab 次数=' + global.__switchTabCount)

  console.log('\n=== G. 录入预览确认卡（Phase 1） ===')
  // 需支持微信 setData 的路径键（如 'form.stage_ids'），否则无法验证多选切换
  ctx.setData = (obj) => {
    Object.keys(obj).forEach((k) => {
      if (k.indexOf('.') >= 0 || k.indexOf('[') >= 0) {
        const parts = k.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)
        let cur = ctx.data
        for (let i = 0; i < parts.length - 1; i++) {
          const p = parts[i]
          if (cur[p] == null) cur[p] = {}
          cur = cur[p]
        }
        cur[parts[parts.length - 1]] = obj[k]
      } else {
        ctx.data[k] = obj[k]
      }
    })
  }
  const mp = ctx._tryParse('material', '录入材料 品牌大自然 木地板 10平方 200元/平方')
  check('解析材料', !!(mp && mp.brand === '大自然' && mp.name === '木地板'))
  const rows = ctx._entryRows('material', mp)
  check('预览行含 名称/品牌/单价/合计', rows.length >= 6 && rows[0][0] === '名称' && rows[1][1] === '大自然')
  ctx._showEntryPreview('material', mp)
  check('预览卡入消息流(pending+entry)', ctx.data.pending && ctx.data.pending.kind === 'material' && ctx.data.messages[ctx.data.messages.length - 1].type === 'entry')
  // 模拟点「确认写入」
  lastInsert = null
  await ctx.confirmEntry()
  check('确认后落库 materials', lastInsert && lastInsert.col === 'materials' && lastInsert.data.brand === '大自然')
  check('确认后 pending 清空', ctx.data.pending === null)

  console.log('\n=== H. Phase 2：LLM 结构化抽取适配（品牌保留 + 校验修复） ===')
  // 名字→id 映射必须靠 raw（带 id），否则会得到 undefined id
  const am = ctx._adaptLLMData('material', { name: '木门', brand: '欧派', quantity: 3, unit: '张', unit_price_yuan: 300, note: '周日安装' })
  check('材料：brand 保留', am && am.brand === '欧派', JSON.stringify(am))
  check('材料：单价元→分 + 合计', am && am.unit_price === 30000 && am.total_price === 90000, JSON.stringify(am))
  check('材料：缺 name → null（不写入脏数据）', ctx._adaptLLMData('material', { name: '', quantity: 1 }) === null)
  check('材料：quantity 缺失补 1', (() => { const x = ctx._adaptLLMData('material', { name: '瓷砖' }); return x && x.quantity === 1 })(), JSON.stringify(ctx._adaptLLMData('material', { name: '瓷砖' })))

  const ae = ctx._adaptLLMData('expense', { amount_yuan: 5000, type: 'labor', stage_names: ['水电改造'], remark: '工钱' })
  check('花费：金额元→分', ae && ae.amount === 500000, JSON.stringify(ae))
  check('花费：阶段名→id 走 raw（s1 非 undefined）', ae && ae.stage_ids.indexOf('s1') !== -1 && ae.stage_ids.indexOf(undefined) === -1, JSON.stringify(ae))
  check('花费：金额为 0 → null', ctx._adaptLLMData('expense', { amount_yuan: 0 }) === null)
  check('花费：非法 type 归 other', (() => { const x = ctx._adaptLLMData('expense', { amount_yuan: 10, type: 'zzz' }); return x && x.type === 'other' })(), JSON.stringify(ctx._adaptLLMData('expense', { amount_yuan: 10, type: 'zzz' })))

  const ad = ctx._adaptLLMData('diary', { content: '主卧刷了墙漆，下周做防水', room_names: ['主卧'], stage_names: ['水电改造'] })
  check('日记：房间名→id（r1）', ad && ad.room_ids.indexOf('r1') !== -1, JSON.stringify(ad))
  check('日记：阶段名→id（s1）', ad && ad.stage_ids.indexOf('s1') !== -1, JSON.stringify(ad))
  check('日记：无 title 时从正文截标题', ad && ad.title && ad.title.length > 0, JSON.stringify(ad))

  console.log('\n=== I. Phase 2：低置信度才走 LLM（_needsLLM） ===')
  const cleanMat = ctx._tryParse('material', '录入材料 品牌大自然 木地板 10平方 200元/平方')
  check('干净材料解析不走 LLM', ctx._needsLLM('material', cleanMat, '录入材料 品牌大自然 木地板 10平方 200元/平方') === false)
  check('未解析出结果必走 LLM', ctx._needsLLM('material', null, '随便一句') === true)
  check('声明品牌却没抽到 → 走 LLM', ctx._needsLLM('material', { name: '木地板', brand: '' }, '木地板 品牌是大自然') === true)
  check('名字疑似吞整句 → 走 LLM', ctx._needsLLM('material', { name: '这是一个非常长的材料名称啊' }, 'x') === true)

  console.log('\n=== J. Phase 3：引导式半屏表单（预填→改→落库） ===')
  ctx.data.pending = null
  ctx.data.messages = []
  const mp2 = ctx._tryParse('material', '录入材料 品牌大自然 木地板 10平方 200元/平方')
  ctx._showEntryPreview('material', mp2)
  check('预览卡已生成', !!(ctx.data.pending && ctx.data.pending.kind === 'material'))
  ctx.openEntryForm()
  check('打开半屏表单 formOpen', ctx.data.formOpen === true && ctx.data.formKind === 'material')
  check('表单预填 名称/品牌', ctx.data.form.name === '木地板' && ctx.data.form.brand === '大自然', JSON.stringify(ctx.data.form))
  check('表单预填 单价元(分转元)', ctx.data.form.unitPriceYuan === '200.00', ctx.data.form.unitPriceYuan)
  // 模拟编辑：数量改 5、品牌改「圣象」
  ctx.onFormInput({ currentTarget: { dataset: { field: 'quantity' } }, detail: { value: '5' } })
  ctx.onFormInput({ currentTarget: { dataset: { field: 'brand' } }, detail: { value: '圣象' } })
  check('编辑后表单值更新', ctx.data.form.quantity === '5' && ctx.data.form.brand === '圣象')
  // 多选切换
  ctx.data.form.stage_ids = []; ctx.data.form.stageSet = ''
  ctx.toggleFormStage({ currentTarget: { dataset: { id: 's1' } } })
  check('阶段 chip 选中', ctx.data.form.stage_ids.indexOf('s1') !== -1 && ctx.data.form.stageSet === 's1')
  ctx.toggleFormStage({ currentTarget: { dataset: { id: 's1' } } })
  check('阶段 chip 再点取消', ctx.data.form.stage_ids.length === 0 && ctx.data.form.stageSet === '')
  // 确认写入
  lastInsert = null
  await ctx.confirmFromForm()
  check('表单确认后落库 materials', lastInsert && lastInsert.col === 'materials', lastInsert && lastInsert.col)
  check('表单改动生效：品牌=圣象', lastInsert && lastInsert.data.brand === '圣象', lastInsert && JSON.stringify(lastInsert.data))
  check('表单改动生效：数量=5 且总价=5*200元', lastInsert && lastInsert.data.quantity === 5 && lastInsert.data.total_price === 100000, lastInsert && JSON.stringify(lastInsert.data))
  check('表单确认后关闭 + pending 清空', ctx.data.formOpen === false && ctx.data.pending === null)
  // 必填为空：不落库，且表单保持打开让用户改（而不是静默关闭）
  ctx.data.pending = { kind: 'material', parsed: { name: '', quantity: 1 }, rows: [] }
  ctx.openEntryForm()
  const before = lastInsert
  await ctx.confirmFromForm()
  check('材料名为空被拦截不落库', lastInsert === before)
  check('必填为空时表单保持打开待修正', ctx.data.formOpen === true)

  console.log('\n=== K. 问题1：户型图「调出来」命中附件查询 ===')
  const Q1 = '能否把装修日记中的户型图调出来？'
  check('_isDiaryLookup 识别「调出来」', ctx._isDiaryLookup(Q1) === true)
  const hit1 = ctx._pickDiaryByText(Q1, diariesData)
  check('选篇命中 户型图日记', hit1 && hit1.id === 'd1', hit1 && hit1.id)
  check('detectIntent 不误判为录入', ctx.detectIntent(Q1) === null)

  console.log('\n=== L. 问题2：阶段状态修改（装修进度） ===')
  const su = ctx._parseStageUpdate('把目前的装修进度修改为准备阶段，已开始。')
  check('解析出阶段 准备阶段 + doing', su && su.stage_id === 's0' && su.stage_name === '准备阶段' && su.status === 'doing', JSON.stringify(su))
  check('记录旧状态 pending', su && su.from_status === 'pending')
  check('无变更动词不触发', ctx._parseStageUpdate('今天水电改造完成了') === null)
  check('纯叙述无状态词不触发', ctx._parseStageUpdate('把瓷砖搬运到主卧') === null)
  const rows2 = ctx._entryRows('stage', su)
  check('预览行：阶段/状态 未开始→进行中', rows2[0][1] === '准备阶段' && rows2[1][1] === '未开始 → 进行中', JSON.stringify(rows2))
  ctx.data.pending = null; ctx.data.messages = []
  ctx._showEntryPreview('stage', su)
  check('阶段修改入预览卡', ctx.data.pending && ctx.data.pending.kind === 'stage')
  lastUpdate = null
  await ctx.confirmEntry()
  check('确认后 write.update stages', lastUpdate && lastUpdate.col === 'stages' && lastUpdate.id === 's0', JSON.stringify(lastUpdate))
  check('更新字段 status=doing + updated_at', lastUpdate && lastUpdate.data.status === 'doing' && !!lastUpdate.data.updated_at, JSON.stringify(lastUpdate && lastUpdate.data))
  check('确认后 pending 清空', ctx.data.pending === null)

  console.log('\n=== M. 问题3：录入花费不再误判为材料 ===')
  const Q3 = '录入花费一次，主要内容是设计师预定费用是200。'
  check('intent = expense（不再 material）', ctx.detectIntent(Q3) === 'expense', ctx.detectIntent(Q3))
  const e5 = ctx.tryParseExpense(Q3)
  check('金额：费用是200 → 20000分', e5 && e5.amount === 20000, JSON.stringify(e5))
  check('备注：主要内容 → 设计师预定费用（尾部金额剥离）', e5 && e5.remark === '设计师预定费用', JSON.stringify(e5 && e5.remark))
  check('回归：记一笔瓷砖10块 仍判材料', ctx.detectIntent('记一笔瓷砖 10块') === 'material')

  console.log('\n=== N. 问题4：日记显式标题/内容声明 ===')
  const d2 = ctx.tryParseDiary('录入日记一篇，标题是花花花，内容是好好好。')
  check('标题=花花花', d2 && d2.title === '花花花', d2 && d2.title)
  check('内容=好好好', d2 && d2.content === '好好好', d2 && d2.content)
  const d3 = ctx.tryParseDiary('记日记 标题：水电验收 内容：今日验收完成，下周做防水')
  check('冒号形态：标题=水电验收', d3 && d3.title === '水电验收', d3 && d3.title)
  check('冒号形态：内容含完整句', d3 && d3.content === '今日验收完成，下周做防水', d3 && d3.content)
  check('回归：无声明日记仍按首句当标题', (() => { const x = ctx.tryParseDiary('录入日记 今天主卧刷了墙漆，师傅说下周做防水'); return x && x.title !== '' })(), JSON.stringify(ctx.tryParseDiary('录入日记 今天主卧刷了墙漆')))

  await round2()

  console.log('\n=== 结果 ===')
  console.log('PASS: ' + pass + '   FAIL: ' + fail)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })

// —— 追加：二轮反馈回归（在 main 末尾前执行不现实，直接在此定义并运行）——
async function round2() {
  console.log('\n=== O. 二轮反馈：按钮/备注/阶段确认 ===')
  const e6 = ctx.tryParseExpense('录入花费，是设计师的定金300块钱。')
  check('金额 300块钱 → 30000分', e6 && e6.amount === 30000, JSON.stringify(e6))
  check('备注保留领域词：设计师的定金', e6 && e6.remark === '设计师的定金', e6 && e6.remark)
  check('类型识别 design（设计师）', e6 && e6.type === 'design', e6 && e6.type)
  const e7 = ctx.tryParseExpense('记一笔 人工 5000元 今天 水电改造')
  check('回归：备注不残留指令词', e7 && e7.remark === '水电改造' || (e7 && e7.remark.indexOf('记') === -1 && e7.remark.indexOf('500') === -1), e7 && e7.remark)
  check('阶段卡有确认修改入口（confirmEntry 走 stage 分支）', typeof ctx._handleStageUpdate === 'function')

  console.log('\n=== P. 三轮反馈：编号点名日记（999楼附件） ===')
  const QP = '看一下999楼项目日记的附件显示出来'
  check('数字串强信号选中 999 日记', (() => { const x = ctx._pickDiaryByText(QP, diariesData); return x && x.id === 'd3' })(), JSON.stringify(ctx._pickDiaryByText(QP, diariesData) && ctx._pickDiaryByText(QP, diariesData).id))
  const pFound = await ctx._handleDiaryLookup(QP)
  check('端到端调出 6 张图', !!(pFound && pFound.images && pFound.images.length === 6), JSON.stringify(pFound && (pFound.images || []).length))
  check('文案含日记标题', !!(pFound && pFound.text.indexOf('土建进场日记 999') !== -1))
  const pMiss = await ctx._handleDiaryLookup('显示一下完全不存在的那篇日记的附件')
  check('选篇失败给引导文案（不再落 LLM 编话）', !!(pMiss && pMiss.text && pMiss.text.indexOf('没找到') !== -1 && pMiss.text.indexOf('当前的日记有') !== -1), pMiss && pMiss.text)
  check('引导文案带项目名（跨项目找不到时不让用户白试）', !!(pMiss && pMiss.text.indexOf('当前项目「测试项目」') !== -1), pMiss && pMiss.text)
  check('引导文案列出日记+附件数', !!(pMiss && pMiss.text.indexOf('户型图确认') !== -1 && pMiss.text.indexOf('（📷2图）') !== -1), pMiss && pMiss.text)
  check('引导带可点 chips（有附件的日记）', !!(pMiss && pMiss.suggestions && pMiss.suggestions.length === 2 && pMiss.suggestions[0].indexOf('显示《') === 0), JSON.stringify(pMiss && pMiss.suggestions))
  // 用户照着引导原样说一遍（可点 chip 就是这个文案）必须命中
  const pFollow = await ctx._handleDiaryLookup('显示《土建进场日记 999》的附件')
  check('顺着引导原样说 → 命中并出图', !!(pFollow && pFollow.images && pFollow.images.length === 6), JSON.stringify(pFollow && (pFollow.images || []).length))
  const pNoImg = await ctx._handleDiaryLookup('显示《水电验收》的附件')
  check('无附件日记说清「确实没有存附件」', !!(pNoImg && pNoImg.text && pNoImg.text.indexOf('确实没有存附件') !== -1 && !pNoImg.images), pNoImg && pNoImg.text)

  console.log('\n=== Q. LLM 理解优先（mode:parse） ===')
  // 规则完全没见过的说法，交给 LLM 也能出结构化结果
  global.__parseMock = { ok: true, intent: 'expense', data: { amount_yuan: 200, type: 'design', stage_names: ['水电改造'], remark: '设计师定金' } }
  const up1 = await ctx._llmParse('前天给做效果图那哥们儿转了两百块')
  check('LLM 判 expense + 元转分', up1 && up1.intent === 'expense' && up1.parsed.amount === 20000, JSON.stringify(up1))
  check('LLM 阶段名→id', up1 && up1.parsed.stage_ids.indexOf('s1') !== -1, JSON.stringify(up1 && up1.parsed.stage_ids))
  check('LLM 备注透传', up1 && up1.parsed.remark === '设计师定金')

  global.__parseMock = { ok: true, intent: 'stage_update', data: { stage_name: '准备阶段', status: 'done' } }
  const up2 = await ctx._llmParse('准备阶段这块儿已经弄完了')
  check('LLM 判 stage_update → stage + id', up2 && up2.intent === 'stage' && up2.parsed.stage_id === 's0' && up2.parsed.status === 'done', JSON.stringify(up2))

  global.__parseMock = { ok: true, intent: 'diary', data: { title: '水电验收', content: '今天验收完成', room_names: ['主卧'], stage_names: ['水电改造'] } }
  const up3 = await ctx._llmParse('记一下今天水电验收搞定了')
  check('LLM 判 diary + 房间/阶段 id', up3 && up3.intent === 'diary' && up3.parsed.room_ids.indexOf('r1') !== -1 && up3.parsed.stage_ids.indexOf('s1') !== -1, JSON.stringify(up3))

  global.__parseMock = { ok: true, intent: 'none' }
  const up4 = await ctx._llmParse('这个月总共花了多少钱')
  check('LLM 判 none（提问不录入）', up4 && up4.intent === null && !up4.parsed, JSON.stringify(up4))

  global.__parseMock = { ok: false, reason: 'not_configured' }
  check('LLM 未配置 → null（走规则兜底）', (await ctx._llmParse('随便')) === null)

  global.__parseMock = { ok: true, intent: 'material', data: { name: '', quantity: 1 } }
  check('LLM 材料缺 name → null（不落脏数据）', (await ctx._llmParse('买点东西')) === null)

  // 端到端：LLM 优先时预览卡走 LLM 结果（而非规则）
  global.__parseMock = { ok: true, intent: 'expense', data: { amount_yuan: 200, type: 'design', remark: '设计师定金' } }
  ctx.data.pending = null; ctx.data.messages = []
  ctx.data.input = '前天给做效果图那哥们儿转了两百块'
  await ctx.send()
  check('send 走 LLM 结果生成花费预览卡', ctx.data.pending && ctx.data.pending.kind === 'expense' && ctx.data.pending.parsed.amount === 20000, JSON.stringify(ctx.data.pending && ctx.data.pending.kind))
  check('预览后 loading 已复位', ctx.data.loading === false)
  global.__parseMock = undefined

  console.log('\n=== R. AI 回答里的引导 → 可点 chips ===')
  check('抓出带动词的示例指令', (() => {
    const r = ctx._suggestFromReply('你可以试试说：「显示《土建进场日记 999》的附件」')
    return r.length === 1 && r[0] === '显示《土建进场日记 999》的附件'
  })(), JSON.stringify(ctx._suggestFromReply('你可以试试说：「显示《土建进场日记 999》的附件」')))
  check('《已知日记标题》补成调图指令', (() => {
    const r = ctx._suggestFromReply('直接说《水电验收》就行')
    return r.length === 1 && r[0] === '显示《水电验收》的附件'
  })(), JSON.stringify(ctx._suggestFromReply('直接说《水电验收》就行')))
  check('非日记的引号词不生成按钮', ctx._suggestFromReply('通用建议：先看「通用建议」这一条').length === 0, JSON.stringify(ctx._suggestFromReply('通用建议：先看「通用建议」这一条')))
  check('无引号回答不生成按钮', ctx._suggestFromReply('目前装修到水电阶段').length === 0)
  check('最多 3 条', ctx._suggestFromReply('可说「录入材料 瓷砖」「录入花费 200」「记一篇日记」「把准备阶段改为进行中」').length === 3)
  // 端到端：问答回复带 chips
  ctx.data.messages = []
  global.__qaAnswer = '我这边看不到附件本体，你可以说「显示《土建进场日记 999》的附件」把图调出来。'
  await ctx.send('装修下一步该做什么') // 不用含「日记/图片」的句子，否则会先命中日记查图路径
  const lastMsg = ctx.data.messages[ctx.data.messages.length - 1]
  check('问答回复带可点 chips', !!(lastMsg && lastMsg.suggestions && lastMsg.suggestions.length === 1 && lastMsg.suggestions[0] === '显示《土建进场日记 999》的附件'), JSON.stringify(lastMsg && lastMsg.suggestions))
  check('问答后 loading 复位', ctx.data.loading === false)
  global.__qaAnswer = undefined
}
