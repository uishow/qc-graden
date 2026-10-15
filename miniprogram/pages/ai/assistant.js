const { cloud } = require('../../utils/cloud')
const store = require('../../utils/store')
const access = require('../../utils/access')
const { tagsOf, normalizeIds } = require('../../utils/arrayId')
const write = require('../../utils/write')

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
    cloud.database.from('diaries').select('id,title,content,diary_date,room_id,room_ids,stage_id,stage_ids,updated_at').eq('project_id', projectId).neq('deleted', true).order('updated_at', { ascending: false }).limit(15),
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
    snapshot: {}, // 发往云函数的
    snapshotView: {}, // 顶部卡显示
    firstRoom: '',
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
        '💡 在「花费 → 材料清单」可编辑（加品牌/规格/状态推进）。',
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

  _matchStageIds(text) { return matchNameIds(text, this.data.snapshot.stages || [], 'name') },
  _matchRoomIds(text) { return matchNameIds(text, this.data.snapshot.rooms || [], 'name') },

  // —— 意图识别：材料 / 花费 / 日记 / null（非录入）——
  detectIntent(text) {
    const t = String(text || '')
    const isQuestion = /[?？]|怎么|如何|为什么|为何|啥|哪|多少|几|查询|统计|分析|看看|吗\s*$|呢\s*$/.test(t)
    const hasMat = /录入|添加|登记|加一笔|材料|建材|清单/.test(t)
    const hasDiary = /记日记|写日记|记一篇日记|记录日记|日记(?!本)/.test(t)
    const hasExp = /记一笔|记一下|花费|支出|付款|付了|报销|开支|消费|花了|花\b/.test(t)
    const qty = this._hasQtyUnit(t)
    const amt = /(\d+(?:\.\d+)?)\s*(?:元|块|块钱)/.test(t)
    const pricey = /(\d+(?:\.\d+)?)\s*(?:元|块|块钱)|单价|总价|合计|每/.test(t)
    const hasDate = /今天|昨天|昨日|前天|大前天|明天|后天|上周.|这周.|本周.|(\d+月\d+[日号])|(\d{4}-\d{1,2}-\d{1,2})/.test(t)
    const knownName = this._matchRoomIds(t).length > 0 || this._matchStageIds(t).length > 0
    if (hasDiary && !isQuestion) return 'diary'
    if (hasMat && !isQuestion) return 'material'
    if (qty && pricey) return 'material' // 欧派木门三张 300一张
    if (hasExp && amt) return 'expense' // 有金额 = 录入花费
    if (hasExp && qty) return 'material' // 记一笔瓷砖 10块（无价格按材料上下文）
    if (hasExp && !isQuestion) return 'expense' // 记一笔（纯录入指令）
    if (hasDate && !amt && !isQuestion) return 'diary' // 今天…叙述（非提问）
    if (knownName && !isQuestion && !amt && !qty) return 'diary' // 提到已知房间/阶段 + 叙述 → 日记
    return null
  },

  // —— 花费解析：金额(分) + 类型 + 支付日期 + 阶段 + 备注 ——
  tryParseExpense(text) {
    const amtRe = /(\d+(?:\.\d+)?)\s*(?:元|块|块钱)/
    const m = text.match(amtRe)
    if (!m) return null
    const amountFen = Math.round(Number(m[1]) * 100)
    if (!amountFen) return null
    let type = 'other'
    if (/人工|工钱|工人|师傅/.test(text)) type = 'labor'
    else if (/设计/.test(text)) type = 'design'
    else if (/订金|定金|预付款/.test(text)) type = 'deposit'
    const payDate = parseDateFromText(text)
    const stageIds = this._matchStageIds(text)
    let remark = text
    remark = remark.replace(amtRe, ' ')
    remark = remark.replace(/(人工|工钱|工人|师傅|设计|订金|定金|预付款|花费|支出|付款|付了|报销|开支|消费|记一笔|记一下|花)/g, ' ')
    remark = remark.replace(/(今天|昨天|昨日|前天|大前天|明天|后天|上周.|这周.|本周.|(\d+月\d+[日号])|(\d{4}-\d{1,2}-\d{1,2}))/g, ' ')
    ;(this.data.snapshot.stages || []).forEach((s) => { const n = String(s.name || '').trim(); if (n && n.length >= 2) remark = remark.split(n).join(' ') })
    ;(this.data.snapshot.rooms || []).forEach((r) => { const n = String(r.name || '').trim(); if (n && n.length >= 2) remark = remark.split(n).join(' ') })
    remark = remark.replace(/[，,。.；;]+/g, ' ').replace(/\s+/g, ' ').trim()
    return { amount: amountFen, type, pay_date: payDate, stage_ids: stageIds, remark, original: text.trim() }
  },

  // —— 日记解析：日期 + 房间 + 阶段 + 标题(首句) + 正文 ——
  tryParseDiary(text) {
    const diaryDate = parseDateFromText(text)
    const roomIds = this._matchRoomIds(text)
    const stageIds = this._matchStageIds(text)
    let body = text
    body = body.replace(/(录入|记日记|写日记|记一篇日记|记录日记|日记|记录|记一下|记一笔)/g, ' ')
    body = body.replace(/(今天|昨天|昨日|前天|大前天|明天|后天|上周.|这周.|本周.|(\d+月\d+[日号])|(\d{4}-\d{1,2}-\d{1,2}))/g, ' ')
    // 已知房间/阶段名仅当剥离后正文仍有内容时才移除，避免正文被掏空导致解析失败
    let stripped = body
    ;(this.data.snapshot.stages || []).forEach((s) => { const n = String(s.name || '').trim(); if (n && n.length >= 2) stripped = stripped.split(n).join(' ') })
    ;(this.data.snapshot.rooms || []).forEach((r) => { const n = String(r.name || '').trim(); if (n && n.length >= 2) stripped = stripped.split(n).join(' ') })
    stripped = stripped.replace(/[，,。.；;]+/g, ' ').replace(/\s+/g, ' ').trim()
    let content = stripped
    if (content.length < 4) {
      // 正文被房间/阶段名掏空 → 保留它们作为正文内容
      content = body.replace(/[，,。.；;]+/g, ' ').replace(/\s+/g, ' ').trim()
    }
    if (!content || content.length < 2) content = text.trim() // 终极兜底：整句当正文
    const firstSentence = content.split(/[。！？\n]/)[0].trim()
    const title = (firstSentence || content).slice(0, 20) || '日记'
    return { title, content, diary_date: diaryDate, room_ids: roomIds, stage_ids: stageIds, original: text.trim() }
  },

  // —— 录入统一分发：先用启发式，失败且 LLM 已配则走 LLM 兜底提取 ——
  async _handleEntry(intent, text) {
    let parsed = null
    if (intent === 'material') parsed = this.tryParseIntakeMaterial(text)
    else if (intent === 'expense') parsed = this.tryParseExpense(text)
    else if (intent === 'diary') parsed = this.tryParseDiary(text)
    if (parsed) return this._writeEntry(intent, parsed)
    // 启发式未命中 → LLM 兜底提取（已配时）
    const extracted = await this._llmExtract(intent, text)
    if (extracted) return this._writeEntry(intent, extracted)
    return this._formatHint(intent)
  },

  async _writeEntry(intent, data) {
    if (intent === 'material') return this._handleIntakeMaterial(data)
    if (intent === 'expense') return this._handleIntakeExpense(data)
    if (intent === 'diary') return this._handleIntakeDiary(data)
    return '未知录入类型'
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
      const typeName = { labor: '人工', design: '设计', deposit: '订金/定金', other: '其他' }[intake.type] || '其他'
      const lines = [
        '✅ 已录入花费：',
        `· 金额：¥${(intake.amount / 100).toFixed(2)}（${typeName}）`,
        intake.pay_date ? `· 支付日：${intake.pay_date}` : '',
        (intake.stage_ids && intake.stage_ids.length) ? '· 已关联阶段' : '',
        intake.remark ? `· 备注：${intake.remark}` : '',
        '',
        '💡 在「花费」页可查看与编辑。',
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
        '💡 在「日记」页可查看与编辑。',
      ].filter(Boolean)
      return lines.join('\n')
    } catch (e) {
      return '录入失败：' + (e.errMsg || e.message || '未知错误')
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
          rooms: (this.data.snapshot.rooms || []).map((r) => r.name),
          stages: (this.data.snapshot.stages || []).map((s) => s.name),
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
    const rooms = this.data.snapshot.rooms || []
    const stages = this.data.snapshot.stages || []
    const nameToId = (names, list) => {
      const ids = []
      ;(names || []).forEach((nm) => {
        const found = list.find((x) => String(x.name || '') === String(nm) || String(x.name || '').indexOf(String(nm)) !== -1)
        if (found) ids.push(found.id)
      })
      return ids
    }
    if (intent === 'material') {
      const qty = Number(raw.quantity || 0)
      const up = Number(raw.unit_price_yuan || 0)
      return { name: String(raw.name || '').trim(), quantity: qty, unit: String(raw.unit || '个'), unit_price: Math.round(up * 100), total_price: Math.round(up * 100 * qty), note: String(raw.note || '').trim(), original: '' }
    }
    if (intent === 'expense') {
      const typeMap = { labor: 'labor', design: 'design', deposit: 'deposit', other: 'other' }
      return {
        amount: Math.round(Number(raw.amount_yuan || 0) * 100),
        type: typeMap[String(raw.type || 'other')] || 'other',
        pay_date: String(raw.pay_date || this._todayStr()),
        stage_ids: nameToId(raw.stage_names, stages),
        remark: String(raw.remark || '').trim(),
      }
    }
    if (intent === 'diary') {
      return {
        title: String(raw.title || '日记').slice(0, 20),
        content: String(raw.content || '').trim(),
        diary_date: String(raw.diary_date || this._todayStr()),
        room_ids: nameToId(raw.room_names, rooms),
        stage_ids: nameToId(raw.stage_names, stages),
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

  async send(src) {
    const text = String(typeof src === 'string' ? src : this.data.input || '').trim()
    if (!text || this.data.loading) return
    const messages = this.data.messages.concat([{ role: 'user', text }])
    this.setData({ messages, input: '', loading: true, lastId: 'msg' + (messages.length - 1) })
    const projectId = store.getCurrentProjectId()

    // 统一收尾：无论成功/失败/异常都复位 loading，避免 UI 卡死（2026-10-15 修：裸调 tryParseIntakeMaterial 抛错未捕获导致死机）
    const finish = (replyText) => {
      const next = this.data.messages.concat([{ role: 'ai', text: String(replyText || '回答失败，请重试') }])
      this.setData({ messages: next, loading: false, lastId: 'msg' + (next.length - 1) })
    }

    try {
      // ★ 系统数据录入快捷指令（材料/日记/花费）：启发式解析 → write.insert，不走 LLM
      //   未命中且 LLM 已配时走 LLM 兜底提取；让 LLM 不可用 / 未配置时也能录入
      if (projectId) {
        // 多维分析查询优先于录入意图：避免「本月花费多少」因含「花费」被误判为花费录入
        if (this.data.raw) {
          const stats = this.computeStats()
          const quick = this._routeQuery(text, stats)
          if (quick) {
            finish(quick)
            return
          }
        }
        const intent = this.detectIntent(text)
        if (intent) {
          const reply = await this._handleEntry(intent, text)
          finish(reply)
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
      }
      finish(answer + extra)
    } catch (e) {
      // 任何未预期异常都复位 loading，绝不卡死
      finish('抱歉，处理出错了：' + (e && e.message ? e.message : '未知错误'))
    }
  },
})
