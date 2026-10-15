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
    let aMatch = afterQty.match(priceReA) || afterQty.match(priceReB)
    if (!aMatch) aMatch = afterQty.match(priceReC)
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
    name = name.replace(/\s+/g, ' ')
    .trim()
    if (!name || name.length < 2) return null

    return {
      name,
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
      const data = {
        name: intake.name,
        category: '其他',
        brand: '',
        spec: '',
        quantity: intake.quantity,
        unit: intake.unit,
        unit_price: intake.unit_price,
        total_price: intake.total_price,
        planned_price: intake.total_price,
        status: 'to_buy',
        note: intake.note,
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
      // ★ 系统数据录入快捷指令（「录入材料：欧派木门 3 张 300/张」）
      //   不走 LLM，直接正则解析 + write.insert('materials')，把结果作为 AI 回复气泡
      //   让 LLM 不可用 / 未配置时也能录入；后续如要做日记/花费等再扩
      if (projectId) {
        const intake = this.tryParseIntakeMaterial(text)
        if (intake) {
          const reply = await this._handleIntakeMaterial(intake)
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
