const { cloud } = require('../../utils/cloud')
const store = require('../../utils/store')
const access = require('../../utils/access')
const { tagsOf, normalizeIds } = require('../../utils/arrayId')
const write = require('../../utils/write')
const aiFeedback = require('../../utils/aiFeedback')

// —— 金额分→元（带千分位） ——
function fen2yuan(fen, withComma) {
  const v = Math.round(Number(fen || 0) / 100)
  if (!withComma) return v ? Number(v).toFixed(2) : '0.00'
  return v ? v.toLocaleString('zh-CN') : '0'
}

// —— 中文数字映射（数量/日期共用）——
const CN_NUM = { '零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 }

// 材料类型词（用于从「品牌+类型」组合名里拆品牌，如 欧派木门→品牌欧派/类型木门）。按长度降序优先匹配长词。
// 材料类型词（用于从「品牌+类型」组合名里拆品牌，如 欧派木门→品牌欧派/类型木门）。按长度降序优先匹配长词。
// 复合类型（木地板/实木地板…）放前面，保证先于「地板」命中；属性词见 MAT_ATTR_WORDS，不在此列。
const MAT_TYPE_KEYWORDS = ['木地板','实木地板','复合地板','强化地板','实木复合地板','铝合金门窗','断桥铝门窗','实木门','整体橱柜','定制衣柜','集成吊顶','乳胶漆','美缝剂','填缝剂','大理石','石膏板','腻子粉','防盗门','推拉门','淋浴房','浴霸','铝扣板','踢脚线','门槛石','玻璃胶','密封胶','开关插座','水龙头','花洒','水槽','门锁','合页','导轨','置物架','地漏','角阀','软管','壁纸','壁布','油漆','涂料','木门','地板','瓷砖','橱柜','衣柜','沙发','床垫','床架','马桶','龙头','开关','插座','灯具','水管','电线','石材','水泥','地毯','窗帘','门','漆','砖']
  .sort((a, b) => b.length - a.length)

// 材料属性/特征词（拆分「品牌+类型」时，这些词不应被判为品牌，如「实木地板」的「实木」）
const MAT_ATTR_WORDS = ['实木','复合','强化','进口','国产','原木','生态','烤漆','免漆','哑光','半哑','高光','亮光','防水','防滑','通体','欧式','现代','简欧','北欧','中式','美式','日式','新中式','仿古','复古','轻奢','极简','无醛','环保','免胶','自粘','竹','塑','铝','钢','铜','铁','玻璃','亚克力']

// 从候选品牌前缀里剔除属性词，剩余部分才是真正品牌名（实木→空，欧派→欧派，大自然实木→大自然）
function stripAttr(s) {
  let r = String(s || '')
  MAT_ATTR_WORDS.forEach((w) => { r = r.split(w).join('') })
  return r.trim()
}

// 显式品牌：品牌是X / 品牌：X / 牌子X / 商标X / 牌号X
function extractDeclaredBrand(text) {
  const decl = text.match(/(?:品牌|牌子|商标|牌号)\s*(?:是|[:：])?\s*([\u4e00-\u9fa5A-Za-z0-9·•\-]{1,12})/)
  if (decl && decl[1]) {
    const b = decl[1].trim()
    if (b && MAT_ATTR_WORDS.indexOf(b) === -1) return { brand: b, raw: decl[0] }
  }
  return null
}

// 后缀品牌：X牌 + 材料类型词（如「大自然牌地板」）
function extractSuffixBrand(text) {
  const suf = text.match(/([\u4e00-\u9fa5A-Za-z0-9·•]{1,10})牌(?=木门|木地板|地板|实木门|门|窗|砖|漆|板|材|橱柜|衣柜|瓷砖|涂料|乳胶漆|吊顶|插座|龙头|花洒|水槽|灯具|壁纸|壁布|地毯|窗帘|五金)/)
  if (suf && suf[1]) {
    const b = suf[1].trim()
    if (b && !['名', '招', '铜', '铁', '铝'].includes(b)) return { brand: b, raw: suf[0] }
  }
  return null
}

// —— 从文本里匹配「项目已知名字」（房间/阶段）转 id 数组 ——
// 策略：文本包含某名字子串即命中；名字按长度降序匹配，长名优先（避免「卫生」误中「卫生间」）
function matchNameIds(text, list, field) {
  const ids = []
  if (!list || !list.length) return ids
  const sorted = list.slice().sort((a, b) => String(b[field] || '').length - String(a[field] || '').length)
  sorted.forEach((item) => {
    const n = String(item[field] || '').trim()
    if (n && n.length >= 2 && text.indexOf(n) !== -1) ids.push(item.id)
  })
  return ids
}

// —— 从文本提取日期 → YYYY-MM-DD ——
// 支持：今天/昨天/前天/大前天/明天/后天/上周X/这周X/本月X号/具体日期(10月15日 / 2026-10-15)
function parseDateFromText(text, todayDate) {
  const d = todayDate ? new Date(todayDate + 'T00:00:00') : new Date()
  const pad = (n) => (n < 10 ? '0' + n : '' + n)
  const fmt = (dt) => dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate())
  // 具体日期 2026-10-15
  const iso = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (iso) {
    const m = Number(iso[2]); const day = Number(iso[3])
    if (m >= 1 && m <= 12 && day >= 1 && day <= 31) return fmt(new Date(Number(iso[1]), m - 1, day))
  }
  // 中文日期 X月X日
  const cn = text.match(/(\d{1,2})月(\d{1,2})[日号]/)
  if (cn) {
    const m = Number(cn[1]); const day = Number(cn[2])
    if (m >= 1 && m <= 12 && day >= 1 && day <= 31) return fmt(new Date(d.getFullYear(), m - 1, day))
  }
  if (/大前天/.test(text)) { d.setDate(d.getDate() - 3); return fmt(d) }
  if (/前天/.test(text)) { d.setDate(d.getDate() - 2); return fmt(d) }
  if (/昨天|昨日/.test(text)) { d.setDate(d.getDate() - 1); return fmt(d) }
  if (/后天/.test(text)) { d.setDate(d.getDate() + 2); return fmt(d) }
  if (/明天|明日/.test(text)) { d.setDate(d.getDate() + 1); return fmt(d) }
  // 上周X / 这周X / 本周X
  const wk = text.match(/(上|这|本)周([日一二三四五六天])/)
  if (wk) {
    const base = wk[1] === '上' ? -7 : 0
    const map = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 }
    const target = map[wk[2]] != null ? map[wk[2]] : 0
    const cur = d.getDay()
    let diff = target - cur + base
    // 上周：取最近的过去那周
    if (wk[1] === '上' && diff >= 0) diff -= 7
    d.setDate(d.getDate() + diff)
    return fmt(d)
  }
  return fmt(new Date())
}

// —— 把 ID 数组转名字（专用于快照里嵌 roomNames/stageNames）——
function namesOfIds(arr, itemMap) {
  const ids = normalizeIds(arr)
  return ids.map((id) => (itemMap && itemMap[id]) || '?')
}
function buildRoomMap(rooms) { const m = {}; (rooms || []).forEach((r) => { if (r && r.id) m[r.id] = r.name }); return m }
function buildStageMap(stages) { const m = {}; (stages || []).forEach((s) => { if (s && s.id) m[s.id] = s.name }); return m }

// —— 按状态名（to_buy/bought/on_site） ——
const MAT_STATUS_NAME = { to_buy: '待购', bought: '已购', on_site: '已进场' }
const EXP_TYPE_NAME = { labor: '人工', design: '设计', deposit: '订金/定金', other: '其他', material: '材料' }

// 构造发往云函数的 snapshot（同时计算各项 KPI 文本给快照卡）
async function buildSnapshot(projectId) {
  const [proj, stages, rooms, diaries, materialsAll, expensesAll] = await Promise.all([
    cloud.database.from('projects').select('id,name').eq('id', projectId).limit(1),
    cloud.database.from('stages').select('*').eq('project_id', projectId).order('sort_order'),
    cloud.database.from('rooms').select('id,name,sort_order').eq('project_id', projectId).order('sort_order'),
    // 最近 15 条日记（足够 AI 看上下文，不再多取防止 LLM 输入太长）
    // image_paths 用于给 LLM 标注「哪篇有附件」，让问答能正确引导用户调图
    cloud.database.from('diaries').select('id,title,content,diary_date,image_paths,room_id,room_ids,stage_id,stage_ids,updated_at').eq('project_id', projectId).neq('deleted', true).order('updated_at', { ascending: false }).limit(15),
    // 材料全量（项目内通常 < 100 条）
    cloud.database.from('materials').select('id,name,category,status,total_price,planned_price,room_id,room_ids').eq('project_id', projectId),
    // 花费全量（用于按类型 / 按阶段 汇总；项目通常 < 500 条）
    cloud.database.from('expenses').select('id,amount,type,stage_id,stage_ids,pay_date').eq('project_id', projectId).neq('deleted', true),
  ])

  const roomsData = rooms.data || []
  const stagesData = stages.data || []
  const roomMap = buildRoomMap(roomsData)
  const stageMap = buildStageMap(stagesData)

  // —— 阶段汇总（pending/doing/done 计数 + 当前进行中阶段名）——
  const stageCounts = { pending: 0, doing: 0, done: 0 }
  stagesData.forEach((s) => { stageCounts[s.status || 'pending'] = (stageCounts[s.status || 'pending'] || 0) + 1 })
  const doingStage = stagesData.find((s) => s.status === 'doing')

  // —— 花费汇总：总额 / 本月 / 按类型 / 按阶段（多选 stage_ids 累加到每个阶段）——
  const expenses = expensesAll.data || []
  let totalExp = 0; let monthExp = 0
  const now = new Date()
  const yearMonth = now.getFullYear() * 100 + (now.getMonth() + 1)
  const byTypeMap = {}
  const byStageMap = {}
  expenses.forEach((e) => {
    const a = Number(e.amount || 0)
    totalExp += a
    const tags = tagsOf(e)
    const ymd = String(e.pay_date || '').slice(0, 7).replace('-', '')
    const ym = ymd ? Number(ymd) : 0
    if (ym && ym === yearMonth) monthExp += a
    const t = e.type || 'other'
    byTypeMap[t] = (byTypeMap[t] || 0) + a
    tags.forEach((tid) => { byStageMap[tid] = (byStageMap[tid] || 0) + a })
  })
  const byType = Object.keys(byTypeMap).map((k) => ({ type: k, name: EXP_TYPE_NAME[k] || k, total: byTypeMap[k] }))
  const byStage = Object.keys(byStageMap).map((id) => ({ id, name: stageMap[id] || id, total: byStageMap[id] }))
  byType.sort((x, y) => y.total - x.total)
  byStage.sort((x, y) => y.total - x.total)

  // —— 材料汇总：总数、状态分布、计划/已购金额、按房间 ——
  const materials = materialsAll.data || []
  const matTotal = materials.length
  let planTotal = 0; let boughtTotal = 0; let tobuyTotal = 0
  const matByStatus = { to_buy: { count: 0, planned: 0 }, bought: { count: 0, total: 0 }, on_site: { count: 0, total: 0 } }
  const matByRoomMap = {}
  const boughtList = []
  materials.forEach((m) => {
    const tp = Number(m.total_price || 0)
    const pp = Number(m.planned_price != null ? m.planned_price : m.total_price || 0)
    planTotal += pp
    if (m.status === 'bought' || m.status === 'on_site') {
      boughtTotal += tp
      matByStatus[m.status].count++
      matByStatus[m.status].total += tp
      if (boughtList.length < 80) boughtList.push({ name: m.name, total: tp, room: '' })
    } else {
      tobuyTotal += pp
      matByStatus.to_buy.count++
      matByStatus.to_buy.planned += pp
    }
    const rnames = namesOfIds(m.room_ids || [], roomMap)
    const rname = rnames[0] || ''
    if (rname) matByRoomMap[rname] = (matByRoomMap[rname] || 0) + tp
    // 给 boughtList 补 room
    if (m.status === 'bought' || m.status === 'on_site') {
      const last = boughtList[boughtList.length - 1]
      if (last && last.name === m.name && !last.room) last.room = rname
    }
  })
  const matByRoom = Object.keys(matByRoomMap).map((n) => ({ room: n, count: 1, total: matByRoomMap[n] })).sort((a, b) => b.total - a.total)

  // —— 日记映射：把 IDs 转名、加最近 15 条 ——
  const diariesData = (diaries.data || []).map((d) => {
    const roomNames = namesOfIds(d.room_ids || [], roomMap)
    const stageNames = namesOfIds(d.stage_ids || [], stageMap)
    return {
      title: d.title || '',
      diary_date: d.diary_date || '',
      content: (d.content || '').slice(0, 200), // 限 200 字写入快照
      roomNames,
      stageNames,
      hasImage: !!(d.image_paths && d.image_paths.length), // 供 LLM 问答标注「有附件」
    }
  })

  const snapshot = {
    projectName: (proj.data && proj.data[0] && proj.data[0].name) || '',
    stages: stagesData.map((s) => ({ name: s.name, status: s.status || 'pending', start_date: s.start_date || '', end_date: s.end_date || '' })),
    rooms: roomsData.map((r) => ({ name: r.name })),
    diaries: diariesData,
    expenses: {
      total: totalExp,
      thisMonth: monthExp,
      byType,
      byStage,
    },
    materials: {
      totals: { count: matTotal, planned: planTotal, bought: boughtTotal, tobuy: tobuyTotal },
      byStatus: Object.keys(matByStatus).map((k) => ({ name: MAT_STATUS_NAME[k], key: k, count: matByStatus[k].count })),
      byRoom: matByRoom,
      boughtList,
    },
  }

  // 快照卡显示用文本（数字走 fen2yuan 转元）
  const stagesText = stagesData.length

    ? '共 ' + stagesData.length + ' 段（未开始 ' + stageCounts.pending + ' / 进行中 ' + stageCounts.doing + ' / 已完成 ' + stageCounts.done + (doingStage ? '，当前「' + doingStage.name + '」' : '') + '）'
    : '尚未设置'
  const spentText = fen2yuan(totalExp, true) + ' 元'
  const monthText = fen2yuan(monthExp, true) + ' 元'
  const materialsText = matTotal + ' 项·计划 ' + fen2yuan(planTotal, true) + ' 元·已购 ' + fen2yuan(boughtTotal, true) + ' 元'
  const roomsText = roomsData.length + ' 个'
  const diariesText = diariesAll(diariesData)
  const firstRoom = roomsData[0] && roomsData[0].name ? roomsData[0].name : ''

  return {
    snapshot,
    snapReady: true,
    snapshotView: {
      projectName: snapshot.projectName,
      stagesText,
      spentText, monthText,
      materialsText,
      roomsText,
      diariesText,
    },
    // 原始数组：供 AI 管家「多维分析」做客户端真实聚合（computeStats）
    // 不直接进 LLM 快照，避免 prompt 过长
    raw: {
      expenses: (expensesAll.data || []),
      materials: (materialsAll.data || []),
      diaries: diariesData,
      stages: stagesData,
      rooms: roomsData,
    },
    firstRoom,
  }
}

function diariesAll(arr) {
  const c = (arr && arr.length) || 0
  if (!c) return '暂无'
  return c + ' 条·最近 ' + arr[0].diary_date
}

Page({
  data: {
    theme: 'theme-a',
    messages: [], // [{ role, text }]
    input: '',
    lastId: '',
    loading: false,
    kbHeight: 0,
    snapCollapsed: false,
    snapReady: false,
    snapshot: {}, // 发往云函数的（只有 name，无 id，供 LLM 用）
    snapshotView: {}, // 顶部卡显示
    // raw 由 refreshSnapshot 整体覆盖（含 expenses/materials/stages/rooms 原始数组，带 id）。
    // 这里只给 stages/rooms 一个安全默认值，供半屏表单的多选 chips 渲染（避免未加载时 wxml 取空报错）
    raw: { stages: [], rooms: [] },
    firstRoom: '',
    pending: null, // 待确认的录入预览 { kind, parsed, rows }
    // —— Phase 3：引导式半屏编辑表单（从预览卡点「修改」进入，预填解析结果，可改后落库）——
    formOpen: false,
    formKind: '',
    form: {}, // 可编辑副本 { name, brand, quantity, unit, unitPriceYuan, note, amountYuan, typeIndex, remark, payDate, title, content, diaryDate, stage_ids, room_ids }
    typeOptions: ['人工', '设计', '订金/定金', '其他', '材料'],
  },

  onLoad() {
    this._onKb = (res) => {
      this.setData({ kbHeight: res.height || 0 })
      if (res.height && this.data.messages.length) {
        this.scrollToBottom()
      }
    }
  },

  onShow() {
    store.applyTheme(this)
    if (wx.onKeyboardHeightChange) wx.onKeyboardHeightChange(this._onKb)
    this.refreshSnapshot()
  },

  onHide() {
    if (wx.offKeyboardHeightChange) wx.offKeyboardHeightChange(this._onKb)
  },
  onUnload() {
    if (wx.offKeyboardHeightChange) wx.offKeyboardHeightChange(this._onKb)
  },

  async refreshSnapshot() {
    const projectId = store.getCurrentProjectId()
    if (!projectId) {
      this.setData({ snapReady: true, snapshot: {}, snapshotView: {}, firstRoom: '' })
      return
    }
    // 校验是当前账号成员（access 内置读安全 + myMembers 隔离）
    try {
      const ok = await access.checkMember(projectId)
      if (!ok) {
        this.setData({ snapReady: true, snapshot: {}, snapshotView: {}, firstRoom: '' })
        wx.showToast({ title: '当前项目已无权访问', icon: 'none' })
        return
      }
      const r = await buildSnapshot(projectId)
      this.setData({ ...r })
    } catch (e) {
      this.setData({ snapReady: true })
    }
  },

  toggleSnap() {
    this.setData({ snapCollapsed: !this.data.snapCollapsed })
  },

  scrollToBottom() {
    const n = this.data.messages.length
    if (n) this.setData({ lastId: 'msg' + (n - 1) })
  },

  onInput(e) {
    this.setData({ input: e.detail.value })
  },

  sendSuggest(e) {
    const q = e.currentTarget.dataset.q
    if (!q) return
    this.setData({ input: q }, () => this.send(q))
  },

  // —— 2026-10-15 录入材料指令解析：识别「录入/添加/记一笔」+ 材料名 + 数量 + 单价/总价 ——
  // 返回 { name, quantity, unit, unit_price (分), total_price (分), note, original } 或 null
  // 解析失败返回 null（不消费消息，让正常 LLM 路径处理）
  tryParseIntakeMaterial(text) {
    // 必须有「录入/添加/记一笔/登记/加一笔」之一 + 可选「材料/材料清单/建材」
    // 注意：不要在 head 里强制 \s+，因为「录入材料清单，欧派木门...」里中文逗号「，」紧跟正文没空白，会整句不匹配
    // alternation 中把更长的「材料清单」放最左，否则「材料」先吃掉剩「清单」在 body
    const head = text.match(/(?:^|\s)(?:录入|添加|记一笔|登记|加一笔)\s*(?:材料清单|材料|建材)?\s*/)
    if (!head) return null
    let body = text.slice(head[0].length).replace(/^[\s，,：:、]+/, '').trim()
    if (!body) return null

    // 品牌：先抽显式声明（品牌是X / 品牌：X / 牌子X / X牌）并移出 body，避免泄漏进 name
    let brand = ''
    const decl = extractDeclaredBrand(body) || extractSuffixBrand(body)
    if (decl) {
      brand = decl.brand
      body = body.replace(decl.raw, ' ').replace(/\s+/g, ' ').trim()
    }

    // 单位表覆盖常见装修材料单位
    // ★ alternation 必须把更长的组合单位（平方/平米）放最左，否则「5 平方」会被拆成「5 平」+「方...」
    const unitList = '平方|平米|张|个|件|块|套|片|根|米|条|箱|包|盒|双|对|扇|台|把|只|卷|桶|本'
    // 数量：支持阿拉伯 + 中文数字
    const cnNum = { '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 }
    const qtyRe = new RegExp(`(\\d+|${Object.keys(cnNum).join('|')})\\s*(${unitList})`)
    const qtyMatch = body.match(qtyRe)
    if (!qtyMatch) return null
    const qtyRaw = qtyMatch[1]
    const quantity = /^\d+$/.test(qtyRaw) ? Number(qtyRaw) : cnNum[qtyRaw]
    const unit = qtyMatch[2]
    if (!quantity || quantity <= 0) return null

    // 单价：4 种优先级
    //   A) 「(单价)? 数字 (元/块)? (/?每/一)?单位」 连续段：300 一张 / 单价300一张 / 300元一张 / 80元/桶 / 每张 300
    //   B) 「每 单位 数字」：每张 300 / 每套 150
    //   C) 裸「数字 元/块」（无单位兜底）：250元
    //   D) 总价：共/一共/总共/合计/总价/花 数字 元 → 推单价 = total / quantity
    // **只在 qty 之后找**，避免把 qty 自身当成价格
    // 注意：unitRe 用 alternation（不是字符类），让「平方/平米」优先于「平/米」匹配
    const afterQty = body.slice(qtyMatch.index + qtyMatch[0].length)
    // 数字与单位之间允许「一/每/」连接" "
    const priceReA = new RegExp(`(?:单价\\s*)?(\\d+(?:\\.\\d+)?)\\s*(?:元|块|块钱)?\\s*[/一每]?\\s*(?:${unitList})`, 'i')
    const priceReB = new RegExp(`每\\s*(?:${unitList})\\s*(\\d+(?:\\.\\d+)?)\\s*(?:元|块|块钱)?`, 'i')
    const priceReC = /(\d+(?:\.\d+)?)\s*(?:元|块|块钱)/
    const priceReD = /(?:单价|总价|合计)\s*(\d+(?:\.\d+)?)/ // 单价/总价/合计 后直接跟数字（省略 元/单位）
    let aMatch = afterQty.match(priceReA) || afterQty.match(priceReB)
    if (!aMatch) aMatch = afterQty.match(priceReC)
    if (!aMatch) aMatch = afterQty.match(priceReD)
    // ★ 「共/一共/总共/合计/总价/花了」是总价强信号，必须先于裸 priceReC 命中，避免把总价当成单价
    const bMatch = body.match(/(共|一共|总共|合计|总价|花了|花)\s*(\d+(?:\.\d+)?)\s*(?:元|块|块钱)/i)
    let unitPriceFen = 0
    if (bMatch) {
      const totalFen = Math.round(Number(bMatch[2]) * 100)
      unitPriceFen = Math.round(totalFen / quantity)
    } else if (aMatch) {
      unitPriceFen = Math.round(Number(aMatch[1]) * 100)
    }

    // 名字 = body 去掉数量/价格/常见修饰
    // 顺序：先剥长的 bMatch「共/一共/总共...」再剥短的 aMatch，避免部分匹配导致长串残留
    let name = body
    if (bMatch) name = name.replace(bMatch[0], ' ')
    name = name.replace(qtyMatch[0], ' ')
    if (aMatch) name = name.replace(aMatch[0], ' ')
    // 修饰匹配：必须命中"要求/本周/周X/上门/送货/安装/到货"至少一个
    name = name.replace(/(要求|本(?:周|个)?[日一二三四五六天]?|下周[日一二三四五六天]?|上门|送货|安装|到货|到现场)[^,，。.]*/g, ' ')
    // 裸「共/一共/总价/合计」若 bMatch 没命中（比如后面没跟数字）作为孤立修饰剥掉
    name = name.replace(/(?:^|\s)(?:一共|总共|合计|总价)(?:\s|$)/g, ' ')
    name = name.replace(/[，,。.；;]+/g, ' ')
    name = name.replace(/\s+/g, ' ').trim()
    if (!name || name.length < 2) return null

    // 从「品牌+类型」组合名拆出品牌（如 欧派木门 → brand=欧派, name=木门）
    // 仅当没有显式品牌时，才做保守子串拆分：候选前缀剔除属性词后仍≥2字才算品牌，
    // 否则（如「实木地板」前缀是属性词）保持 name 完整、不留空品牌
    if (!brand) {
      for (const kw of MAT_TYPE_KEYWORDS) {
        const idx = name.indexOf(kw)
        if (idx >= 2) {
          const cand = name.slice(0, idx)
          const stripped = stripAttr(cand)
          if (stripped.length >= 2) { brand = stripped; name = name.slice(idx) }
          break
        }
      }
    }

    return {
      name,
      brand,
      quantity,
      unit,
      unit_price: unitPriceFen,
      total_price: unitPriceFen * quantity,
      note: text.trim(),
      original: text.trim(),
    }
  },

  // 处理材料录入：write.insert + 构造成功/失败回复
  async _handleIntakeMaterial(intake) {
    const projectId = store.getCurrentProjectId()
    if (!projectId) return '当前没有项目，无法录入。'
    try {
      // 字段必须与 materials 集合读取端一致：备注是 remark（不是 note），并补齐
      // belong/sub/stage_ids/attachments/created_at/updated_at（material/edit.js 写入的字段）
      const now = new Date().toISOString()
      const data = {
        name: intake.name,
        category: '其他',
        brand: intake.brand || '',
        spec: '',
        quantity: intake.quantity,
        unit: intake.unit,
        unit_price: intake.unit_price,
        total_price: intake.total_price,
        planned_price: intake.total_price,
        status: 'to_buy',
        belong: '',
        sub: '',
        stage_ids: [],
        stage_id: '',
        attachments: [],
        remark: intake.note, // 原 note（用户原始要求/备注）映射到 remark
        created_at: now,
        updated_at: now,
      }
      const r = await write.insert('materials', projectId, { ...data, version: 1, project_id: projectId })
      if (r && r.error) {
        return '录入失败：' + (r.error.message || r.error.errMsg || '未知错误')
      }
      const totalYuan = (intake.total_price / 100).toFixed(2)
      const unitYuan = (intake.unit_price / 100).toFixed(2)
      const lines = [
        '✅ 已录入材料清单：',
        `· 名称：${intake.name}`,
        `· 数量：${intake.quantity} ${intake.unit}` + (intake.unit_price > 0 ? `（单价 ¥${unitYuan}，合计 ¥${totalYuan}）` : ''),
        `· 状态：待购`,
        `· 备注：${intake.note}`,
        '',
        '💡 可在「花费 · 材料清单」里加规格/推进状态。',
      ]
      return lines.join('\n')
    } catch (e) {
      return '录入失败：' + (e.errMsg || e.message || '未知错误')
    }
  },

  // ============ 2026-10-15 录入/分析增强：日记 + 花费 + 多维分析 ============

  _todayStr() {
    const d = new Date()
    const p = (n) => (n < 10 ? '0' + n : '' + n)
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
  },

  // 文本是否含「数字+单位」（材料量词特征）
  _hasQtyUnit(text) {
    const unitList = '平方|平米|张|个|件|块|套|片|根|米|条|箱|包|盒|双|对|扇|台|把|只|卷|桶|本'
    return new RegExp('(\\d+|一|二|两|三|四|五|六|七|八|九|十)\\s*(' + unitList + ')').test(text)
  },

  // 名字→id 必须用 raw（带 id 的原始数组）：snapshot 里的 stages/rooms 只有 name 没有 id，
  // 用它匹配会得到 undefined id，录入的阶段/房间关联就丢了
  _matchStageIds(text) { return matchNameIds(text, this.data.raw.stages || [], 'name') },
  _matchRoomIds(text) { return matchNameIds(text, this.data.raw.rooms || [], 'name') },
  // 纯名字列表（与 id 映射同源，都取 raw）。不在此处过滤长度：
  // 剥词场景自行过滤 length>=2，而发给 LLM 的「已知名」要保留全部（含「厅」这类单字名）
  _knownStageNames() { return (this.data.raw.stages || []).map((s) => String(s.name || '').trim()).filter(Boolean) },
  _knownRoomNames() { return (this.data.raw.rooms || []).map((r) => String(r.name || '').trim()).filter(Boolean) },

  // —— 意图识别：材料 / 花费 / 日记 / null（非录入）——
  detectIntent(text) {
    const t = String(text || '')
    const isQuestion = /[?？]|怎么|如何|为什么|为何|啥|哪|多少|几|查询|统计|分析|看看|显示|展示|找出|找一下|打开|搜一下|搜索|发我|发出来|吗\s*$|呢\s*$/.test(t)
    const hasMat = /录入|添加|登记|加一笔|材料|建材|清单/.test(t)
    const hasDiary = /记日记|写日记|记一篇日记|记录日记|日记(?!本)/.test(t)
    // 「费用」是用户高频说法（2026-10-15 实测「设计师预定费用是200」）
    const hasExp = /记一笔|记一下|花费|支出|付款|付了|报销|开支|消费|花了|费用|花\b/.test(t)
    const qty = this._hasQtyUnit(t)
    // 货币判定：「数字元/块钱」或「花了/付了/费用/金额 + 数字」。
    // 裸「数字块」不算钱——「瓷砖 10块」的块是量词（2026-10-15 回归发现）
    const amt = /(\d+(?:\.\d+)?)\s*(?:元|块钱)/.test(t) || /(?:花了|付了|费用|金额)\s*(?:是|[:：])?\s*\d/.test(t)
    const pricey = /(\d+(?:\.\d+)?)\s*(?:元|块|块钱)|单价|总价|合计|每/.test(t)
    const hasDate = /今天|昨天|昨日|前天|大前天|明天|后天|上周.|这周.|本周.|(\d+月\d+[日号])|(\d{4}-\d{1,2}-\d{1,2})/.test(t)
    const knownName = this._matchRoomIds(t).length > 0 || this._matchStageIds(t).length > 0
    if (hasDiary && !isQuestion) return 'diary'
    // 「录入花费…」含「录入」会命中 hasMat —— 花费意图必须优先于材料（2026-10-15 实测误判为材料卡）
    if (hasExp && amt) return 'expense' // 有金额 = 录入花费
    if (hasMat && !hasExp && !isQuestion) return 'material'
    if (qty && pricey) return 'material' // 欧派木门三张 300一张
    if (hasExp && qty) return 'material' // 记一笔瓷砖 10块（无价格按材料上下文）
    if (hasExp && !isQuestion) return 'expense' // 记一笔（纯录入指令）
    if (hasDate && !amt && !isQuestion) return 'diary' // 今天…叙述（非提问）
    if (knownName && !isQuestion && !amt && !qty) return 'diary' // 提到已知房间/阶段 + 叙述 → 日记
    return null
  },

  // —— 花费解析：金额(分) + 类型 + 支付日期 + 阶段 + 备注 ——
  // 健壮性（与材料品牌解析同思路）：
  //   ① 显式声明字段优先：备注/说明/事由 → remark；类型/类别 → type
  //   ② 金额多形态：「500元」「花了500」「金额：500」
  //   ③ 声明短语从 remark 清理出去，避免泄漏
  tryParseExpense(text) {
    // 显式备注：备注/说明/事由/主要内容 后的内容（截止到逗号/句末/下一个字段关键词）
    // 「主要内容是设计师预定费用是200」是用户实测句式（2026-10-15）
    const remarkDecl = text.match(/(?:备注|说明|事由|主要内容|内容)\s*(?:是|[:：])?\s*([^，。；;]*)/)
    let declaredRemark = ''
    if (remarkDecl && remarkDecl[1]) {
      declaredRemark = remarkDecl[1].split(/\s*(?:阶段|类型|类别|日期|支付)\s*(?:是|[:：])?\s*/)[0].trim()
      // 尾部粘连的金额剥掉（如「设计师预定费用是200」→「设计师预定费用」）
      declaredRemark = declaredRemark.replace(/\s*(?:是|[:：])?\s*\d+(?:\.\d+)?\s*元?\s*$/, '').trim()
    }
    // 显式类型：类型/类别 是/： 人工|设计|订金|定金|材料|其他
    const typeDecl = text.match(/(?:类型|类别)\s*(?:是|[:：])?\s*(人工|设计|订金|定金|材料|其他)/)

    // 金额：优先「数字元/块」，其次「花了500」「金额：500」「费用是200」（省略元）
    // alternation 长词放最左：「块钱」必须在「块」前，否则「300块钱」吃掉「块」漏下「钱」
    const amtRe = /(\d+(?:\.\d+)?)\s*(?:元|块钱|块)/
    const m = text.match(amtRe) || text.match(/(?:花了|金额|费用)\s*(?:是|[:：])?\s*(\d+(?:\.\d+)?)/)
    if (!m) return null
    const amountFen = Math.round(Number(m[1]) * 100)
    if (!amountFen) return null
    let type = 'other'
    if (typeDecl) {
      type = { 人工: 'labor', 设计: 'design', 订金: 'deposit', 定金: 'deposit', 材料: 'material', 其他: 'other' }[typeDecl[1]] || 'other'
    } else if (/人工|工钱|工人|师傅/.test(text)) type = 'labor'
    else if (/设计/.test(text)) type = 'design'
    else if (/订金|定金|预付款/.test(text)) type = 'deposit'
    else if (/材料/.test(text)) type = 'material'
    const payDate = parseDateFromText(text)
    const stageIds = this._matchStageIds(text)
    // 备注：显式声明优先；否则从原文剥离金额/类型词/日期/房间阶段名
    let remark
    if (declaredRemark) {
      remark = declaredRemark
    } else {
      remark = text
      remark = remark.replace(amtRe, ' ')
      remark = remark.replace(/(花了|金额|费用)\s*(?:是|[:：])?\s*(\d+(?:\.\d+)?)/g, ' ')
      remark = remark.replace(/(备注|说明|事由|类型|类别)\s*(?:是|[:：])?/g, ' ')
      // 只剥离指令词/意图词/日期，保留领域词（设计师/定金等是备注本意）。
      // 旧版把 设计|定金|师傅 一并剥掉，把「设计师的定金」切碎成「是 师 的 钱」（2026-10-15 用户二轮反馈）
      remark = remark.replace(/(录入|添加|登记|记一笔|记一下|花费|支出|付款|付了|报销|开支|消费|花了)/g, ' ')
      remark = remark.replace(/(今天|昨天|昨日|前天|大前天|明天|后天|上周.|这周.|本周.|(\d+月\d+[日号])|(\d{4}-\d{1,2}-\d{1,2}))/g, ' ')
      this._knownStageNames().filter((n) => n.length >= 2).forEach((n) => { remark = remark.split(n).join(' ') })
      this._knownRoomNames().filter((n) => n.length >= 2).forEach((n) => { remark = remark.split(n).join(' ') })
      remark = remark.replace(/[，,。.；;]+/g, ' ').replace(/\s+/g, ' ').trim()
      remark = remark.replace(/^[\s是的，,、]+/, '') // 去掉句首悬空的「是/的」虚词
    }
    return { amount: amountFen, type, pay_date: payDate, stage_ids: stageIds, remark, original: text.trim() }
  },

  // —— 日记解析：日期 + 房间 + 阶段 + 标题(首句) + 正文 ——
  tryParseDiary(text) {
    const diaryDate = parseDateFromText(text)
    const roomIds = this._matchRoomIds(text)
    const stageIds = this._matchStageIds(text)
    // 显式声明优先（2026-10-15 用户实测「标题是花花花，内容是好好好」整句漏进正文）：
    // 标题值截到逗号/下一个字段词；内容值允许逗号、截到句末
    const titleDecl = text.match(/标题\s*(?:是|[:：])\s*([^，,。；;]+)/)
    const titleVal = titleDecl && titleDecl[1] ? titleDecl[1].split(/\s*(?:内容|日期|房间|阶段)\s*(?:是|[:：])/)[0].trim() : ''
    const contentDecl = text.match(/内容\s*(?:是|[:：])\s*([^。；;]+)/)
    let body = text
    body = body.replace(/(录入|记日记|写日记|记一篇日记|记录日记|日记|记录|记一下|记一笔|一篇)/g, ' ')
    if (titleDecl) body = body.replace(/标题\s*(?:是|[:：])[^，,。；；：:]*/g, ' ')
    if (contentDecl) body = body.replace(/内容\s*(?:是|[:：])[^。；；]*/g, ' ')
    body = body.replace(/(今天|昨天|昨日|前天|大前天|明天|后天|上周.|这周.|本周.|(\d+月\d+[日号])|(\d{4}-\d{1,2}-\d{1,2}))/g, ' ')
    // 已知房间/阶段名仅当剥离后正文仍有内容时才移除，避免正文被掏空导致解析失败
    let stripped = body
    this._knownStageNames().filter((n) => n.length >= 2).forEach((n) => { stripped = stripped.split(n).join(' ') })
    this._knownRoomNames().filter((n) => n.length >= 2).forEach((n) => { stripped = stripped.split(n).join(' ') })
    stripped = stripped.replace(/[，,。.；;]+/g, ' ').replace(/\s+/g, ' ').trim()
    let content = stripped
    if (content.length < 4) {
      // 正文被房间/阶段名掏空 → 保留它们作为正文内容
      content = body.replace(/[，,。.；;]+/g, ' ').replace(/\s+/g, ' ').trim()
    }
    if (!content || content.length < 2) content = text.trim() // 终极兜底：整句当正文
    if (contentDecl && contentDecl[1]) content = contentDecl[1].trim() // 显式内容声明最优先
    // 显式标题声明 > 首句截取
    const firstSentence = content.split(/[。！？\n]/)[0].trim()
    const title = (titleVal || (firstSentence || content)).slice(0, 20) || '日记'
    return { title, content, diary_date: diaryDate, room_ids: roomIds, stage_ids: stageIds, original: text.trim() }
  },

  // —— 先解析，不直接落库：返回结构化对象（启发式优先，失败则 LLM 兜底）——
  _tryParse(intent, text) {
    if (intent === 'material') return this.tryParseIntakeMaterial(text)
    if (intent === 'expense') return this.tryParseExpense(text)
    if (intent === 'diary') return this.tryParseDiary(text)
    return null
  },

  // —— 阶段状态修改（问题 2：用户想用 AI 改装修进度）——
  // 命中条件：变更动词（改为/设为/…）+ 状态词；阶段从 raw.stages 按名字匹配。
  // 返回 { stage_id, stage_name, status, from_status } 或 null
  _parseStageUpdate(text) {
    const t = String(text || '')
    if (!/(改为|改成|设为|设置成|设置成|标为|标记为|标成|换成|更新为|调整为|修改为|改成)/.test(t)) return null
    // 状态词→枚举（判定顺序：done → doing → pending，「开始」是「已开始」子串故 doing 放 done 后）
    let status = ''
    if (/(已经)?完成|做完|竣工|收尾/.test(t)) status = 'done'
    else if (/进行中|已开始|已经开工|开工了|开始干了|在做|开始/.test(t)) status = 'doing'
    else if (/未开始|还没开始|暂停|停工|不干了/.test(t)) status = 'pending'
    if (!status) return null
    // 阶段名匹配：优先文本直接命中已知阶段名；无命中时尝试「X阶段」候选模糊匹配
    let ids = this._matchStageIds(t)
    if (!ids.length) {
      const cand = t.match(/([\u4e00-\u9fa5A-Za-z0-9]{2,6})阶段/)
      if (cand && cand[1]) {
        const hit = (this.data.raw.stages || []).find((s) => {
          const n = String(s.name || '')
          return n === (cand[1] + '阶段') || n.indexOf(cand[1]) !== -1 || cand[1].indexOf(n) !== -1
        })
        if (hit) ids = [hit.id]
      }
    }
    if (!ids.length) return null
    const st = (this.data.raw.stages || []).find((s) => s.id === ids[0])
    if (!st) return null
    return { stage_id: st.id, stage_name: st.name || '', status, from_status: st.status || 'pending' }
  },

  // 启发式解析结果是否「置信度不足」，需要 LLM 兜底补全。
  // 目标：干净输入走正则（即时/离线），含糊输入交给 LLM，避免「解析一般」的观感。
  _needsLLM(intent, parsed, text) {
    if (!parsed) return true
    const t = String(text || '')
    if (intent === 'material') {
      // 名字疑似把整句吞进来了（没拆出数量/单位），或正文声明了品牌却没抽到
      if (parsed.name && parsed.name.length >= 12) return true
      if (/品牌|牌子|商标/.test(t) && !parsed.brand) return true
    } else if (intent === 'diary') {
      // 整段被当成正文、几乎没拆出房间/阶段/日期线索（说明启发式没命中已知名）
      const clue = /(房间|卧室|主卧|次卧|客厅|厨房|卫生间|卫浴|阳台|书房|阶段|水电|泥木|油漆|竣工|验收)/.test(t)
      if (clue && parsed.content && parsed.content.length >= t.trim().length * 0.9) return true
    }
    return false
  },

  // 把解析结果转成预览卡片的「字段行」
  _entryRows(kind, p) {
    const yuan = (fen) => (Number(fen || 0) / 100).toFixed(2)
    // id→name 映射用 raw（带 id）；用 snapshot 会因无 id 导致 key 全是 undefined、预览卡显示不出房间/阶段名
    const roomMap = {}; (this.data.raw.rooms || []).forEach((r) => { roomMap[r.id] = r.name })
    const stageMap = {}; (this.data.raw.stages || []).forEach((s) => { stageMap[s.id] = s.name })
    const names = (ids) => (ids || []).map((id) => roomMap[id] || stageMap[id] || id).join('、') || '—'
    if (kind === 'material') {
      return [
        ['名称', p.name || '—'],
        ['品牌', p.brand || '—'],
        ['数量', p.quantity + ' ' + p.unit],
        ['单价', '¥' + yuan(p.unit_price)],
        ['合计', '¥' + yuan(p.total_price)],
        ['备注', p.note || '—'],
      ]
    }
    if (kind === 'stage') {
      const sn = { pending: '未开始', doing: '进行中', done: '已完成' }
      return [
        ['阶段', p.stage_name || '—'],
        ['状态', (sn[p.from_status] || p.from_status || '—') + ' → ' + (sn[p.status] || p.status)],
      ]
    }
    if (kind === 'expense') {
      const tn = { labor: '人工', design: '设计', deposit: '订金/定金', other: '其他', material: '材料' }[p.type] || '其他'
      return [
        ['金额', '¥' + yuan(p.amount)],
        ['类别', tn],
        ['备注', p.remark || '—'],
        ['阶段', names(p.stage_ids)],
        ['日期', p.pay_date || '—'],
      ]
    }
    return [
      ['日期', p.diary_date || '—'],
      ['标题', p.title || '—'],
      ['内容', (p.content || '').slice(0, 60) || '—'],
      ['房间', names(p.room_ids)],
      ['阶段', names(p.stage_ids)],
    ]
  },

  // 追加一条消息（ai/user/entry 卡片通用）
  _appendMessage(m) {
    const messages = this.data.messages.concat([m])
    this.setData({ messages, loading: false, lastId: 'msg' + (messages.length - 1) })
  },

  // 解析成功 → 展示预览卡，等用户确认再写
  _showEntryPreview(intent, parsed) {
    const entry = { kind: intent, parsed, rows: this._entryRows(intent, parsed) }
    this.setData({ pending: entry, loading: false })
    this._appendMessage({ role: 'ai', type: 'entry', entry })
  },

  // 用户点「确认写入」：真正落库（含自动跳转）
  async confirmEntry() {
    const entry = this.data.pending
    if (!entry) return
    this.setData({ pending: null })
    try {
      const reply = await this._writeEntry(entry.kind, entry.parsed)
      this._appendMessage({ role: 'ai', text: reply })
    } catch (e) {
      this._appendMessage({ role: 'ai', text: '写入失败：' + (e && e.message ? e.message : '未知错误') })
    }
  },

  // 用户点「取消」：丢弃本次解析（同时记为"理解错且用户放弃"信号）
  cancelEntry() {
    if (!this.data.pending) return
    this._logFeedback('cancel', { intent: this.data.pending.kind, understood: this.data.pending.parsed })
    this.setData({ pending: null })
    this._appendMessage({ role: 'ai', text: '已取消本次录入。' })
  },

  // —— Phase 3：从预览卡进入半屏编辑表单，预填解析结果 ——
  openEntryForm() {
    const entry = this.data.pending
    if (!entry) return
    const p = entry.parsed || {}
    const typeIndex = this.data.typeOptions.findIndex((label, i) => {
      const map = { 人工: 'labor', 设计: 'design', '订金/定金': 'deposit', 其他: 'other', 材料: 'material' }
      return map[label] === (p.type || 'other')
    })
    const form = {
      name: p.name || '',
      brand: p.brand || '',
      quantity: p.quantity != null ? String(p.quantity) : '',
      unit: p.unit || '个',
      unitPriceYuan: p.unit_price != null ? (Number(p.unit_price) / 100).toFixed(2) : '',
      note: p.note || '',
      amountYuan: p.amount != null ? (Number(p.amount) / 100).toFixed(2) : '',
      typeIndex: typeIndex >= 0 ? typeIndex : 3,
      remark: p.remark || '',
      payDate: p.pay_date || this._todayStr(),
      title: p.title || '',
      content: p.content || '',
      diaryDate: p.diary_date || this._todayStr(),
      stage_ids: (p.stage_ids || []).slice(),
      room_ids: (p.room_ids || []).slice(),
      // 多选选中态用逗号拼接字符串，便于 wxml 里字符串 indexOf 判定高亮（数组 indexOf 在 wxml 不可靠）
      stageSet: (p.stage_ids || []).join(','),
      roomSet: (p.room_ids || []).join(','),
    }
    this.setData({ formOpen: true, formKind: entry.kind, form })
    this.setBarHidden(true)
  },

  // 关闭半屏表单（不写入）
  closeEntryForm() {
    if (!this.data.formOpen) return
    this.setData({ formOpen: false })
    this.setBarHidden(false)
  },

  // 表单字段输入绑定（data-field 指定字段名）
  onFormInput(e) {
    const field = e.currentTarget.dataset.field
    if (!field) return
    const form = Object.assign({}, this.data.form)
    form[field] = e.detail.value
    this.setData({ form })
  },

  // 花费类别切换
  onFormTypePick(e) {
    const idx = Number(e.currentTarget.dataset.idx)
    if (Number.isNaN(idx)) return
    this.setData({ ['form.typeIndex']: idx })
  },

  // 阶段/房间多选切换（用于关联）
  toggleFormStage(e) {
    const id = e.currentTarget.dataset.id
    const ids = this.data.form.stage_ids || []
    const next = ids.indexOf(id) >= 0 ? ids.filter((x) => x !== id) : ids.concat([id])
    this.setData({ ['form.stage_ids']: next, ['form.stageSet']: next.join(',') })
  },
  toggleFormRoom(e) {
    const id = e.currentTarget.dataset.id
    const ids = this.data.form.room_ids || []
    const next = ids.indexOf(id) >= 0 ? ids.filter((x) => x !== id) : ids.concat([id])
    this.setData({ ['form.room_ids']: next, ['form.roomSet']: next.join(',') })
  },

  // 从表单重建结构化对象（元→分、类别索引→枚举），覆盖 pending.parsed 后走原写入链路
  _buildFromForm(kind, form) {
    if (kind === 'material') {
      const qty = Number(form.quantity || 0)
      const upFen = Math.round(Number(form.unitPriceYuan || 0) * 100)
      return {
        name: String(form.name || '').trim(),
        brand: String(form.brand || '').trim(),
        quantity: qty > 0 ? qty : 1,
        unit: String(form.unit || '个').trim() || '个',
        unit_price: upFen,
        total_price: upFen * (qty > 0 ? qty : 1),
        note: String(form.note || '').trim(),
        original: '',
      }
    }
    if (kind === 'expense') {
      const typeMap = ['labor', 'design', 'deposit', 'other', 'material']
      return {
        amount: Math.round(Number(form.amountYuan || 0) * 100),
        type: typeMap[Number(form.typeIndex) || 3] || 'other',
        pay_date: String(form.payDate || this._todayStr()),
        stage_ids: (form.stage_ids || []).slice(),
        remark: String(form.remark || '').trim(),
        original: '',
      }
    }
    return {
      title: String(form.title || '').trim().slice(0, 20) || '日记',
      content: String(form.content || '').trim(),
      diary_date: String(form.diaryDate || this._todayStr()),
      room_ids: (form.room_ids || []).slice(),
      stage_ids: (form.stage_ids || []).slice(),
      original: '',
    }
  },

  // 半屏表单「确认写入」：用表单数据覆盖解析结果，再走 confirmEntry 落库 + 跳转
  confirmFromForm() {
    const { formKind, form } = this.data
    if (!formKind) return
    const built = this._buildFromForm(formKind, form)
    if (formKind === 'material' && !built.name) { wx.showToast({ title: '请填写材料名称', icon: 'none' }); return }
    if (formKind === 'expense' && !built.amount) { wx.showToast({ title: '请填写金额', icon: 'none' }); return }
    if (formKind === 'diary' && !built.content) { wx.showToast({ title: '请填写日记内容', icon: 'none' }); return }
    // ★ 反馈闭环最有价值的一类：用户手动改了哪些字段 = 模型/规则解析错在哪，且给出了「标准答案」
    const before = this.data.pending && this.data.pending.parsed
    const diff = this._diffParsed(formKind, before, built)
    if (diff && diff.length) {
      this._logFeedback('edit_diff', {
        intent: formKind,
        understood: before,
        fixed: built,
        reason: diff.join(','),
      })
    }
    this.setData({ formOpen: false, pending: { kind: formKind, parsed: built, rows: this._entryRows(formKind, built) } })
    this.setBarHidden(false)
    return this.confirmEntry() // 返回 promise，便于调用方/测试等待落库完成
  },

  // 对比「AI 解析结果」与「用户改后的结果」，返回被改动的字段名列表。
  // 只比对各类型关键字段；数组（stage_ids/room_ids）比内容不看顺序；空↔空不算改动。
  _diffParsed(kind, before, after) {
    const b = before || {}
    const a = after || {}
    const fields = kind === 'material'
      ? ['name', 'brand', 'quantity', 'unit', 'unit_price', 'note']
      : kind === 'expense'
        ? ['amount', 'type', 'pay_date', 'remark', 'stage_ids']
        : ['title', 'content', 'diary_date', 'room_ids', 'stage_ids']
    const same = (x, y) => {
      if (Array.isArray(x) || Array.isArray(y)) {
        const p = (Array.isArray(x) ? x : []).slice().sort().join('|')
        const q = (Array.isArray(y) ? y : []).slice().sort().join('|')
        return p === q
      }
      return String(x == null ? '' : x) === String(y == null ? '' : y)
    }
    const out = []
    fields.forEach((f) => { if (!same(b[f], a[f])) out.push(f) })
    return out
  },

  async _writeEntry(intent, data) {
    if (intent === 'material') return this._handleIntakeMaterial(data)
    if (intent === 'expense') return this._handleIntakeExpense(data)
    if (intent === 'diary') return this._handleIntakeDiary(data)
    if (intent === 'stage') return this._handleStageUpdate(data)
    return '未知录入类型'
  },

  // —— 阶段状态修改落库：write.update('stages')，成功后回执（不自动跳转，提示去首页看板）——
  async _handleStageUpdate(p) {
    const projectId = store.getCurrentProjectId()
    if (!projectId) return '当前没有项目，无法修改进度。'
    if (!p.stage_id) return '未识别到要修改的阶段，请说「把 XX 阶段改为进行中」。'
    try {
      const r = await write.update('stages', projectId, p.stage_id, {
        status: p.status,
        updated_at: new Date().toISOString(),
      })
      if (r && r.error) return '修改失败：' + (r.error.message || r.error.errMsg || '未知错误')
      const sn = { pending: '未开始', doing: '进行中', done: '已完成' }
      return [
        '✅ 已修改装修进度：',
        `· 阶段：${p.stage_name}`,
        `· 状态：${sn[p.from_status] || p.from_status || '—'} → ${sn[p.status] || p.status}`,
        '',
        '💡 可到「首页」的阶段看板查看最新进度。',
      ].join('\n')
    } catch (e) {
      return '修改失败：' + (e && (e.errMsg || e.message) || '未知错误')
    }
  },

  async _handleIntakeExpense(intake) {
    const projectId = store.getCurrentProjectId()
    if (!projectId) return '当前没有项目，无法录入。'
    try {
      const now = new Date().toISOString()
      const data = {
        amount: intake.amount,
        type: intake.type || 'other',
        pay_date: intake.pay_date || this._todayStr(),
        stage_ids: intake.stage_ids || [],
        stage_id: (intake.stage_ids && intake.stage_ids[0]) || '', // 旧读取端兼容
        belong: '', // 非全屋定制归属
        remark: intake.remark || '',
        created_at: now,
        updated_at: now,
      }
      const r = await write.insert('expenses', projectId, { ...data, version: 1, project_id: projectId, deleted: false })
      if (r && r.error) return '录入失败：' + (r.error.message || r.error.errMsg || '未知错误')
      const typeName = { labor: '人工', design: '设计', deposit: '订金/定金', other: '其他', material: '材料' }[intake.type] || '其他'
      const lines = [
        '✅ 已录入花费：',
        `· 金额：¥${(intake.amount / 100).toFixed(2)}（${typeName}）`,
        intake.pay_date ? `· 支付日：${intake.pay_date}` : '',
        (intake.stage_ids && intake.stage_ids.length) ? '· 已关联阶段' : '',
        intake.remark ? `· 备注：${intake.remark}` : '',
        '',
        '💡 可在「花费」页查看这笔记录。',
      ].filter(Boolean)
      return lines.join('\n')
    } catch (e) {
      return '录入失败：' + (e.errMsg || e.message || '未知错误')
    }
  },

  async _handleIntakeDiary(intake) {
    const projectId = store.getCurrentProjectId()
    if (!projectId) return '当前没有项目，无法录入。'
    try {
      const now = new Date().toISOString()
      const data = {
        title: intake.title,
        content: intake.content,
        diary_date: intake.diary_date || this._todayStr(),
        room_ids: intake.room_ids || [],
        room_id: (intake.room_ids && intake.room_ids[0]) || '', // 旧读取端兼容
        stage_ids: intake.stage_ids || [],
        stage_id: (intake.stage_ids && intake.stage_ids[0]) || '', // 旧读取端兼容
      }
      const r = await write.insert('diaries', projectId, {
        ...data, version: 1, project_id: projectId, deleted: false,
        created_at: now, updated_at: now,
      })
      if (r && r.error) return '录入失败：' + (r.error.message || r.error.errMsg || '未知错误')
      const lines = [
        '✅ 已录入日记：',
        `· 标题：${intake.title}`,
        `· 日期：${intake.diary_date}`,
        (intake.room_ids && intake.room_ids.length) ? '· 已关联房间' : '',
        (intake.stage_ids && intake.stage_ids.length) ? '· 已关联阶段' : '',
        '',
        '💡 可在「日记」页查看这篇记录。',
      ].filter(Boolean)
      return lines.join('\n')
    } catch (e) {
      return '录入失败：' + (e.errMsg || e.message || '未知错误')
    }
  },

  // —— LLM 理解优先：一句话同时判意图 + 抽字段（云函数 mode:'parse'）——
  // 返回：{ intent:'material'|'expense'|'diary'|'stage', parsed }；
  //       { intent:null } = LLM 明确说不是录入指令（客户端转规则/问答）；
  //       null = 未配置/调用失败/结果不可用（客户端继续走规则兜底）
  async _llmParse(text) {
    try {
      const res = await wx.cloud.callFunction({
        name: 'aiAssistant',
        data: {
          mode: 'parse',
          text,
          rooms: this._knownRoomNames(),
          stages: this._knownStageNames(),
          today: this._todayStr(),
        },
      })
      const r = res && res.result
      if (!r || !r.ok) return null
      if (r.intent === 'none') return { intent: null }
      if (r.intent === 'stage_update') {
        const d = r.data || {}
        const name = String(d.stage_name || '').trim()
        const status = ['pending', 'doing', 'done'].indexOf(d.status) >= 0 ? d.status : ''
        if (!name || !status) return null
        const st = (this.data.raw.stages || []).find((s) => {
          const n = String(s.name || '')
          return n === name || (name && (n.indexOf(name) !== -1 || name.indexOf(n) !== -1))
        })
        if (!st) return null
        return { intent: 'stage', parsed: { stage_id: st.id, stage_name: st.name, status, from_status: st.status || 'pending' } }
      }
      const parsed = this._adaptLLMData(r.intent, r.data || {})
      if (!parsed) return null
      return { intent: r.intent, parsed }
    } catch (e) {
      return null
    }
  },

  // —— LLM 兜底提取：让云函数把自由文本转结构化 JSON 再落库 ——
  async _llmExtract(intent, text) {
    try {
      const res = await wx.cloud.callFunction({
        name: 'aiAssistant',
        data: {
          mode: 'extract',
          collection: intent,
          text,
          rooms: this._knownRoomNames(),
          stages: this._knownStageNames(),
        },
      })
      const r = res && res.result
      if (!r || !r.ok || !r.data) return null
      return this._adaptLLMData(intent, r.data)
    } catch (e) {
      return null
    }
  },

  // LLM 返回的 JSON（yuan + 名字）→ 写库就绪形状（fen + id）
  _adaptLLMData(intent, raw) {
    // 必须用 raw（带 id 的原始数组）：snapshot.rooms/stages 是发给 LLM 的精简版，只有 name 没有 id，
    // 用它做名字→id 映射会得到 undefined id，导致阶段/房间关联写不进去
    const rooms = this.data.raw.rooms || []
    const stages = this.data.raw.stages || []
    const nameToId = (names, list) => {
      const ids = []
      ;(names || []).forEach((nm) => {
        const found = list.find((x) => String(x.name || '') === String(nm) || String(x.name || '').indexOf(String(nm)) !== -1)
        if (found) ids.push(found.id)
      })
      return ids
    }
    if (intent === 'material') {
      const name = String(raw.name || '').trim()
      if (!name) return null // 品牌/数量可缺省，但材料名必填
      const qty = Number(raw.quantity || 0) > 0 ? Number(raw.quantity) : 1
      const up = Number(raw.unit_price_yuan || 0) || 0
      return {
        name,
        brand: String(raw.brand || '').trim(),
        quantity: qty,
        unit: String(raw.unit || '个').trim() || '个',
        unit_price: Math.round(up * 100),
        total_price: Math.round(up * 100 * qty),
        note: String(raw.note || '').trim(),
        original: '',
      }
    }
    if (intent === 'expense') {
      const amountFen = Math.round(Number(raw.amount_yuan || 0) * 100)
      if (!amountFen) return null // 金额必填
      const typeMap = { labor: 'labor', design: 'design', deposit: 'deposit', other: 'other', material: 'material' }
      return {
        amount: amountFen,
        type: typeMap[String(raw.type || 'other')] || 'other',
        pay_date: String(raw.pay_date || this._todayStr()),
        stage_ids: nameToId(raw.stage_names, stages),
        remark: String(raw.remark || '').trim(),
        original: '',
      }
    }
    if (intent === 'diary') {
      const content = String(raw.content || '').trim()
      const title = String(raw.title || '').trim() || (content.slice(0, 20) || '日记')
      return {
        title: title.slice(0, 20),
        content,
        diary_date: String(raw.diary_date || this._todayStr()),
        room_ids: nameToId(raw.room_names, rooms),
        stage_ids: nameToId(raw.stage_names, stages),
        original: '',
      }
    }
    return null
  },

  _formatHint(intent) {
    if (intent === 'material') return '没太看懂这条材料信息～试试：「录入材料清单，欧派木门三张，单价300一张」'
    if (intent === 'expense') return '没太看懂这条花费信息～试试：「记一笔 人工 5000元 今天 水电改造」'
    if (intent === 'diary') return '没太看懂这条日记信息～试试：「记日记 今天 客厅 水电验收完成，师傅说下周做防水」'
    return '没看懂～'
  },

  // —— 多维分析：客户端真实聚合（基于 buildSnapshot 返回的原始数组）——
  computeStats() {
    const raw = this.data.raw || {}
    const rooms = raw.rooms || []
    const stages = raw.stages || []
    const expenses = (raw.expenses || []).map((e) => ({
      amount: Number(e.amount || 0),
      type: e.type || 'other',
      stage_ids: e.stage_ids || (e.stage_id ? [e.stage_id] : []),
      pay_date: String(e.pay_date || ''),
    }))
    const materials = (raw.materials || []).map((m) => ({
      name: m.name,
      status: m.status || 'to_buy',
      total: Number(m.total_price || 0),
      planned: Number(m.planned_price != null ? m.planned_price : m.total_price || 0),
      room_ids: m.room_ids || (m.room_id ? [m.room_id] : []),
    }))
    const typeName = { labor: '人工', design: '设计', deposit: '订金/定金', other: '其他', material: '材料' }
    const ymNow = new Date().getFullYear() * 100 + (new Date().getMonth() + 1)

    const byType = {}; let totalExp = 0, monthExp = 0
    const monthly = {}
    const byStageExpMap = {}
    expenses.forEach((e) => {
      totalExp += e.amount
      const ymd = e.pay_date.slice(0, 7).replace('-', '')
      const ym = ymd ? Number(ymd) : 0
      if (ym && ym === ymNow) monthExp += e.amount
      byType[e.type] = (byType[e.type] || 0) + e.amount
      if (ym) monthly[ym] = (monthly[ym] || 0) + e.amount
      ;(Array.isArray(e.stage_ids) ? e.stage_ids : [e.stage_ids]).forEach((sid) => { if (sid) byStageExpMap[sid] = (byStageExpMap[sid] || 0) + e.amount })
    })
    const stageName = (id) => { const s = stages.find((x) => x.id === id); return s ? s.name : id }
    const stageExpList = Object.keys(byStageExpMap).map((id) => ({ name: stageName(id), total: byStageExpMap[id] })).sort((a, b) => b.total - a.total)

    let planTotal = 0, boughtTotal = 0, tobuyTotal = 0, matCount = 0
    const matByStatus = { to_buy: { count: 0, total: 0 }, bought: { count: 0, total: 0 }, on_site: { count: 0, total: 0 } }
    const matByRoomMap = {}
    materials.forEach((m) => {
      matCount++
      planTotal += m.planned
      if (m.status === 'bought' || m.status === 'on_site') {
        boughtTotal += m.total
        matByStatus[m.status].count++; matByStatus[m.status].total += m.total
      } else {
        tobuyTotal += m.planned
        matByStatus.to_buy.count++; matByStatus.to_buy.total += m.planned
      }
      ;(Array.isArray(m.room_ids) ? m.room_ids : [m.room_ids]).forEach((rid) => { if (rid) matByRoomMap[rid] = (matByRoomMap[rid] || 0) + m.total })
    })
    const roomName = (id) => { const r = rooms.find((x) => x.id === id); return r ? r.name : id }
    const matByRoomList = Object.keys(matByRoomMap).map((id) => ({ name: roomName(id), total: matByRoomMap[id] })).sort((a, b) => b.total - a.total)

    const stageCounts = { pending: 0, doing: 0, done: 0 }
    stages.forEach((s) => { stageCounts[s.status || 'pending'] = (stageCounts[s.status || 'pending'] || 0) + 1 })
    const doingStage = stages.find((s) => s.status === 'doing')

    return {
      totalExp, monthExp,
      byType: Object.keys(byType).map((k) => ({ key: k, name: typeName[k] || k, total: byType[k] })).sort((a, b) => b.total - a.total),
      monthly: Object.keys(monthly).sort().map((k) => ({ month: k, total: monthly[k] })),
      stageExpList,
      materials: { count: matCount, planned: planTotal, bought: boughtTotal, tobuy: tobuyTotal, byStatus: matByStatus, byRoom: matByRoomList },
      stages: { counts: stageCounts, doing: doingStage ? doingStage.name : null, list: stages.map((s) => ({ name: s.name, status: s.status || 'pending' })) },
    }
  },

  // —— 查询路由：正则识别常见问法，直接返回格式化统计文本（离线可用）——
  _routeQuery(text, stats) {
    const t = String(text || '')
    const yuan = (fen) => Math.round(fen / 100).toLocaleString('zh-CN')
    // 本月花费
    if (/本月|这个月|当月|这月/.test(t) && /花|支出|用了|开销|花费/.test(t)) {
      let s = '📊 本月花费：¥' + yuan(stats.monthExp) + ' 元（总支出 ¥' + yuan(stats.totalExp) + ' 元）\n'
      if (stats.byType.length) s += '· 按类型：' + stats.byType.map((x) => x.name + ' ¥' + yuan(x.total)).join('；')
      return s
    }
    // 各阶段进度
    if (/进度|到哪|做到哪|进行中|已完成.*几|各阶段|阶段.*情况|目前.*阶段/.test(t)) {
      const c = stats.stages.counts
      let s = '📊 施工阶段（共 ' + stats.stages.list.length + ' 段）：未开始 ' + c.pending + ' / 进行中 ' + c.doing + ' / 已完成 ' + c.done + '\n'
      if (stats.stages.doing) s += '· 当前进行中：' + stats.stages.doing + '\n'
      s += stats.stages.list.map((x) => '· ' + x.name + '（' + ({ pending: '未开始', doing: '进行中', done: '已完成' }[x.status] || x.status) + '）').join('\n')
      return s
    }
    // 待购清单
    if (/待购|待买|待采购|还没买|没买/.test(t) && /材料|买|购/.test(t)) {
      const tb = stats.materials.byStatus.to_buy
      return '📊 待购材料：' + tb.count + ' 项，计划 ¥' + yuan(tb.total) + ' 元\n· 已购/进场合计：¥' + yuan(stats.materials.bought) + ' 元'
    }
    // 材料预算 vs 已花
    if (/材料.*预算|材料.*花|材料.*钱|材料总|材料.*合计/.test(t)) {
      const m = stats.materials
      return '📊 材料：共 ' + m.count + ' 项\n· 计划总额：¥' + yuan(m.planned) + ' 元\n· 已购/进场：¥' + yuan(m.bought) + ' 元\n· 待购：¥' + yuan(m.tobuy) + ' 元'
    }
    // 按类型花费
    if (/按类型|哪类|什么类|类目|花在|各类型/.test(t)) {
      if (!stats.byType.length) return '📊 暂无花费记录。'
      return '📊 按类目花费：\n' + stats.byType.map((x) => '· ' + x.name + '：¥' + yuan(x.total)).join('\n')
    }
    // 月度趋势
    if (/趋势|每月|月花|月度|每个月|按月/.test(t)) {
      if (!stats.monthly.length) return '📊 暂无可统计的月度花费数据。'
      return '📊 月度花费趋势：\n' + stats.monthly.map((x) => '· ' + x.month + '：¥' + yuan(x.total)).join('\n')
    }
    // 指定阶段花费
    const hitStage = stats.stages.list.find((x) => t.indexOf(x.name) !== -1)
    if (hitStage && /花|支出|用了|多少钱|开销|费用/.test(t)) {
      const item = stats.stageExpList.find((x) => x.name === hitStage.name)
      return '📊 ' + hitStage.name + ' 阶段花费：' + (item ? '¥' + yuan(item.total) + ' 元' : '暂无关联花费记录')
    }
    return null
  },

  // —— 日记附件查询：用户要求「显示某篇日记的图片/附件」而不是录入 ——
  _isDiaryLookup(text) {
    const t = String(text || '')
    if (!/日记|附件|图片|照片|户型图|图纸|截图/.test(t)) return false
    // 动词表覆盖用户实际说法：2026-10-15 用户实测「能否把…户型图调出来？」未命中，
    // 原因是「调出来」不在表里 → 落到 LLM 问答（AI 只看得到文字快照，答“调不出来”）
    return /显示|展示|找出|找一下|打开|看看|看一下|看下|发我|发出来|搜一下|搜索|哪个|哪篇|哪一篇|哪条|调出来|调出|查看|查阅|翻出来|找出来|拿出来|翻一下|翻下/.test(t)
  },

  // 2-gram 相关度打分：日记标题/正文与用户文本的重叠度。
  // 常用词（出现在多篇日记里的 gram）按 document frequency 过滤，避免「一个/里面」这类虚词干扰选篇。
  _pickDiaryByText(text, diaries) {
    const t = String(text || '')
    const list = diaries || []
    if (!list.length) return null
    // 数字串强信号：用户常用编号点名日记（如「看一下999楼项目日记的附件」）。
    // 2-gram 会把「999」稀释成「99」，叠上「日记」被 df 过滤后 score=1<2 选不中（2026-10-15 实测漏）
    const nums = t.match(/\d{2,}/g) || []
    const sets = list.map((d) => {
      const src = String(d.title || '') + String(d.content || '')
      const s = new Set()
      for (let i = 0; i + 2 <= src.length; i++) s.add(src.slice(i, i + 2))
      return s
    })
    const df = {}
    sets.forEach((s) => s.forEach((g) => { df[g] = (df[g] || 0) + 1 }))
    const dfMax = Math.max(2, list.length * 0.4)
    let best = null; let bestScore = 0
    sets.forEach((s, i) => {
      let score = 0
      s.forEach((g) => { if (t.indexOf(g) !== -1 && df[g] <= dfMax) score++ })
      const src = String(list[i].title || '') + String(list[i].content || '')
      nums.forEach((n) => { if (src.indexOf(n) !== -1) score += 3 })
      if (score > bestScore) { bestScore = score; best = list[i] }
    })
    return bestScore >= 2 ? best : null
  },

  // 返回 { text, images? }。选篇失败时返回引导文案（列最近日记+附件数），
  // 不再返回 null 落 LLM 问答——AI 看不到附件本体，只会编「调不出来」（2026-10-15 实测）
  async _handleDiaryLookup(text) {
    const projectId = store.getCurrentProjectId()
    if (!projectId) return null
    try {
      const { data, error } = await cloud.database
        .from('diaries')
        .select('id,title,content,diary_date,image_paths')
        .eq('project_id', projectId)
        .neq('deleted', true)
        .limit(100)
      if (error) return null
      const list = data || []
      if (!list.length) return { text: '当前项目还没有日记，先去「日记」页记一篇吧。' }
      const hit = this._pickDiaryByText(text, list)
      const projName = (this.data.snapshotView && this.data.snapshotView.projectName) || (this.data.snapshot && this.data.snapshot.projectName) || ''
      if (!hit) {
        const lines = list.slice(0, 5).map((d, i) => {
          const n = (d.image_paths || []).length
          return (i + 1) + '. 《' + (d.title || '无标题') + '》' + (d.diary_date || '') + (n ? '（📷' + n + '图）' : '')
        })
        // 只列当前项目的日记：用户常跨项目找（如「999楼项目」是另一个项目），
        // 明确带上项目名，避免他以为是 AI 没找到、反复重试
        return {
          miss: true, // 供 send() 记 no_result 反馈信号
          text: '在' + (projName ? '当前项目「' + projName + '」' : '当前项目') + '里没找到你说的那篇日记。\n' +
            '（日记是按项目隔离的，如果是别的项目里的日记，请先切到那个项目再问）\n当前的日记有：\n' + lines.join('\n') + '\n\n点下面的按钮直接查，或说「显示《某篇日记》的附件」：',
          // 引导做成可点按钮：用户照文字重打一遍很容易说法对不上（2026-10-15 实测「顺着引导说却没结果」）
          suggestions: list.slice(0, 3).filter((d) => (d.image_paths || []).length).map((d) => '显示《' + (d.title || '无标题') + '》的附件'),
        }
      }
      const fileIds = hit.image_paths || []
      if (!fileIds.length) {
        return { text: '📖 找到日记《' + (hit.title || '无标题') + '》（' + (hit.diary_date || '') + '），但这篇日记确实没有存附件图片（须在「日记」页上传）。' }
      }
      const signed = await cloud.storage.createSignedUrls(fileIds)
      const urls = (signed.data || []).map((x) => x.signedUrl).filter(Boolean)
      if (!urls.length) {
        return { text: '📖 找到日记《' + (hit.title || '无标题') + '》，但图片链接获取失败（' + ((signed.error && (signed.error.message || signed.error.errMsg)) || '未知原因') + '），请到「日记」页查看。' }
      }
      return {
        text: '🖼️ ' + (projName ? '「' + projName + '」' : '') + '日记《' + (hit.title || '无标题') + '》（' + (hit.diary_date || '') + '）的附件，共 ' + urls.length + ' 张，点击图片可放大：',
        images: urls,
      }
    } catch (e) {
      return null
    }
  },

  // 聊天气泡里的图片点击放大
  previewMsgImage(e) {
    const urls = e.currentTarget.dataset.imgs || []
    const cur = e.currentTarget.dataset.cur
    if (urls.length) wx.previewImage({ current: cur, urls })
  },

  // 从 AI 回答里抓出「示例指令」做成可点 chips。
  // 场景：LLM 常自由发挥引导（「你可以试试说：显示《X》的附件」），用户照着文字重打，
  // 措辞稍变就命中不了解析 → 表现就是「顺着引导说却出不来结果」（2026-10-15 实测）。
  // 规则：引号里像指令的（含显示/录入/把…改为 等动词）原样成按钮；
  //       《》里的是已知日记标题时补成「显示《标题》的附件」；最多 3 条。
  _suggestFromReply(reply) {
    const t = String(reply || '')
    const out = []
    const push = (s) => {
      s = String(s || '').trim()
      if (s.length < 4 || s.length > 40) return
      if (out.indexOf(s) === -1 && out.length < 3) out.push(s)
    }
    const cmdRe = /(显示|查看|打开|调出|翻出|录入|添加|登记|记一笔|记录|把|将|改为|改成|设为|标记为|修改)/;
    const diaryTitles = (this.data.raw && this.data.raw.diaries || []).map((d) => String(d.title || ''))
    const re = /[「『“"]([^」』”"]{2,40})[」』”"]|《([^》]{2,40})》/g
    let m
    while ((m = re.exec(t)) && out.length < 3) {
      const raw = String(m[1] || m[2] || '').trim()
      if (!raw) continue
      if (cmdRe.test(raw)) { push(raw); continue }
      // 《标题》形态：只有确实是项目里的日记标题才补成调图指令，避免生成乱七八糟的按钮
      const isDiary = diaryTitles.some((n) => n && (n === raw || n.indexOf(raw) !== -1 || raw.indexOf(n) !== -1))
      if (isDiary) push('显示《' + raw + '》的附件')
    }
    return out
  },

  // 弹窗/半屏表单打开期间隐藏自定义 tabBar（其层级高于页面 fixed 弹窗，会盖住底部按钮）
  setBarHidden(hidden) {
    const bar = this.getTabBar && this.getTabBar()
    if (bar) bar.setData({ hidden: !!hidden })
  },

  // 空处理器：用于拦截半屏表单内部的 tap / 滚动冒泡（避免点表单内部误关弹窗）
  noop() {},

  // —— 反馈闭环：记录「AI 没帮上忙」的信号 ——
  // signal: edit_diff(用户改了字段，含标准答案) / cancel / unparsed / no_result / retry / degraded / thumb_down
  // 失败一律静默（utils/aiFeedback 内部已 try/catch），绝不打断主流程
  _logFeedback(signal, extra) {
    try {
      const e = extra || {}
      aiFeedback.log(signal, {
        question: e.question || this._lastUserText || '',
        understood: typeof e.understood === 'string' ? e.understood : JSON.stringify(e.understood || {}),
        fixed: e.fixed == null ? '' : (typeof e.fixed === 'string' ? e.fixed : JSON.stringify(e.fixed)),
        reply: e.reply || '',
        intent: e.intent || '',
        reason: e.reason || '',
        projectId: store.getCurrentProjectId() || '',
      })
    } catch (err) { /* 忽略 */ }
  },

  // 判定「同一件事又问了一遍」：最近 6 条里出现过高度相似的用户原话。
  // 归一化：去空白标点 + 数字统一成 #，再算 2-gram 重合率；≥0.6 视为重复提问。
  _isRepeatAsk(text) {
    const norm = (s) => String(s || '').replace(/[\s，。；、？！?!"'“”「」《》（）()]/g, '').replace(/\d+/g, '#')
    const grams = (s) => {
      const out = []
      for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2))
      return s.length === 1 ? [s] : out
    }
    const a = norm(text)
    if (a.length < 4) return false
    const ga = grams(a)
    const users = (this.data.messages || []).slice(-6).filter((m) => m && m.role === 'user')
    for (let i = 0; i < users.length; i++) {
      const b = norm(users[i].text)
      if (!b || b.length < 4) continue
      if (b === a) return true
      const gb = grams(b)
      let hit = 0
      ga.forEach((g) => { if (gb.indexOf(g) !== -1) hit++ })
      const rate = hit / Math.max(1, Math.min(ga.length, gb.length))
      // 阈值取 0.8 + 长度比约束：0.6 会把「水电阶段花了多少 / 木工阶段花了多少」
      // 这种只有后半段相同的不同问题也算成重问（误报会污染反馈清单）
      const lenRate = Math.min(a.length, b.length) / Math.max(a.length, b.length)
      if (rate >= 0.8 && lenRate >= 0.6) return true
    }
    return false
  },

  // 用户点 👎：标记这条回答没帮上忙
  markBad(e) {
    const idx = Number(e.currentTarget.dataset.idx)
    const msg = this.data.messages[idx]
    if (!msg) return
    if (msg.voted) return
    this.setData({ ['messages[' + idx + '].voted']: 'bad' })
    this._logFeedback('thumb_down', { question: this._lastUserText || '', reply: msg.text || '' })
    wx.showToast({ title: '已记录，谢谢反馈', icon: 'none' })
  },

  async send(src) {
    const text = String(typeof src === 'string' ? src : this.data.input || '').trim()
    if (!text || this.data.loading) return
    // 反馈闭环：记住本轮原文，供 👎 / 解析失败等信号回填「用户到底说了什么」
    this._lastUserText = text
    const messages = this.data.messages.concat([{ role: 'user', text }])
    this.setData({ messages, input: '', loading: true, lastId: 'msg' + (messages.length - 1) })
    const projectId = store.getCurrentProjectId()
    // 同一句话（或高度相似）在最近 3 轮里又问了一遍 = 上一轮没帮上忙 → retry 信号
    if (this._isRepeatAsk(text)) {
      this._logFeedback('retry', { question: text, reason: 'repeat_ask' })
    }

    // 统一收尾：无论成功/失败/异常都复位 loading，避免 UI 卡死（2026-10-15 修：裸调 tryParseIntakeMaterial 抛错未捕获导致死机）
    const finish = (replyText, images, suggestions) => {
      const msg = { role: 'ai', text: String(replyText || '回答失败，请重试') }
      if (images && images.length) msg.images = images
      // 引导做成可点 chips，避免用户照文字重打导致说法对不上
      if (suggestions && suggestions.length) msg.suggestions = suggestions
      const next = this.data.messages.concat([msg])
      this.setData({ messages: next, loading: false, lastId: 'msg' + (next.length - 1) })
    }

    try {
      // ★ 系统数据录入快捷指令（材料/日记/花费）：启发式解析 → write.insert，不走 LLM
      //   未命中且 LLM 已配时走 LLM 兜底提取；让 LLM 不可用 / 未配置时也能录入
      if (projectId) {
        // 阶段状态修改（「把 X 阶段改为进行中」）必须排在 _routeQuery 之前：
        // 查询路由的 /进度|目前.*阶段/ 会把「把…装修进度修改为…」抢走当统计问答
        const stageUpd = this._parseStageUpdate(text)
        if (stageUpd) {
          this._showEntryPreview('stage', stageUpd)
          return
        }
        // 多维分析查询优先于录入意图：避免「本月花费多少」因含「花费」被误判为花费录入
        if (this.data.raw) {
          const stats = this.computeStats()
          const quick = this._routeQuery(text, stats)
          if (quick) {
            finish(quick)
            return
          }
        }
        // 日记附件查询（如「请显示那篇户型图日记的附件」）优先于录入意图，
        // 否则「请显示出来」会被 detectIntent 误判为录入日记
        if (this._isDiaryLookup(text)) {
          const found = await this._handleDiaryLookup(text)
          if (found) {
            // 命中不到具体那篇（返回的是引导列表）也算没帮上忙：no_result
            if (found.miss) this._logFeedback('no_result', { intent: 'diary_lookup', question: text, reason: 'diary_not_matched' })
            finish(found.text, found.images, found.suggestions)
            return
          }
        }
        const intent = this.detectIntent(text)
        if (intent) {
          // LLM 理解优先：先让模型判意图+抽字段（覆盖任意说法）；规则降级为离线兜底
          const understood = await this._llmParse(text)
          const llmAnswered = !!understood // LLM 已明确回应（含"不是录入"），就不再二次调用
          if (understood && understood.intent && understood.parsed) {
            this._showEntryPreview(understood.intent, understood.parsed)
            return
          }
          // 兜底：规则解析（离线可用）；置信度不足且 LLM 没答过时才调 extract
          let parsed = this._tryParse(intent, text)
          if (!llmAnswered && (!parsed || this._needsLLM(intent, parsed, text))) {
            const llm = await this._llmExtract(intent, text)
            if (llm) parsed = llm
          }
          if (parsed) { this._showEntryPreview(intent, parsed); return }
          // 判定是录入但字段没抽出来 = 典型「规则没覆盖的说法」，是最有价值的一类反馈
          this._logFeedback('unparsed', { intent, question: text, reason: 'no_field_extracted' })
          finish(this._formatHint(intent))
          return
        }
      }

      let result = null
      try {
        const res = await wx.cloud.callFunction({
          name: 'aiAssistant',
          data: { question: text, projectId, snapshot: this.data.snapshot, projectName: this.data.snapshotView.projectName || '' },
        })
        result = res && res.result
      } catch (e) {
        const detail = String((e && (e.errCode || e.errMsg || e.message)) || '').slice(0, 60)
        result = { ok: false, message: '调用失败：' + (detail || '网络异常') }
      }
      const fallback = '回答失败，请重试'
      const answer = result && result.ok ? (result.answer || fallback) : (result && result.message) || fallback
      // 透传 AI 降级原因 + 让用户知道是降级结果
      // reason: 'not_configured' | 'call_failed' | 'empty_reply' | ''
      let extra = ''
      if (result && result.ok && result.ai === false && result.reason) {
        const tip = result.reason === 'not_configured'
          ? '（AI 未配置大模型，请前往「我的 → AI 设置」）'
          : result.reason === 'call_failed'
            ? '（AI 调用失败：' + (result.aiError || '未知原因') + '）'
            : '（AI 返回为空，已用项目现状兜底）'
        extra = '\n\n' + tip
        // 降级回答 = 用户拿到的不是真 AI 答案，值得统计（配错/欠费/超时都会落这里）
        this._logFeedback('degraded', { question: text, reply: answer, reason: result.reason })
      }
      // AI 自由发挥的引导（"你可以试试说…"）用户照着重打常对不上 → 抓出示例指令做成可点 chips
      finish(answer + extra, null, this._suggestFromReply(answer))
    } catch (e) {
      // 任何未预期异常都复位 loading，绝不卡死
      finish('抱歉，处理出错了：' + (e && e.message ? e.message : '未知错误'))
    }
  },

})
