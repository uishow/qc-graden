const { cloud } = require('../../utils/cloud')
const store = require('../../utils/store')
const access = require('../../utils/access')
const { tagsOf, normalizeIds } = require('../../utils/arrayId')

// —— 金额分→元（带千分位） ——
function fen2yuan(fen, withComma) {
  const v = Math.round(Number(fen || 0) / 100)
  if (!withComma) return v ? Number(v).toFixed(2) : '0.00'
  return v ? v.toLocaleString('zh-CN') : '0'
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

  async send(src) {
    const text = String(typeof src === 'string' ? src : this.data.input || '').trim()
    if (!text || this.data.loading) return
    const messages = this.data.messages.concat([{ role: 'user', text }])
    this.setData({ messages, input: '', loading: true, lastId: 'msg' + (messages.length - 1) })
    const projectId = store.getCurrentProjectId()
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
    let extra = ''
    if (result && result.ok && result.ai === false && result.aiError) {
      extra = '\n\n（AI 暂不可用：' + result.aiError + '）'
    }
    const next = this.data.messages.concat([{ role: 'ai', text: answer + extra }])
    this.setData({ messages: next, loading: false, lastId: 'msg' + (next.length - 1) })
  },
})
