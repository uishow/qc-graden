const { cloud } = require('../../utils/cloud')
const store = require('../../utils/store')
const access = require('../../utils/access')
const { fen2yuan } = require('../../utils/format')

const app = getApp()

// 饼图配色：两主题各一套，材料/人工/设计/订金/其他 固定顺序取色（画布扇区与图例圆点同色）
const PIE_PALETTES = {
  'theme-a': ['#3F5A4C', '#B08A47', '#8C5A3B', '#D9C08A', '#8A7E72'],
  'theme-b': ['#6E7F8D', '#C2A878', '#3E3E42', '#D8CBB2', '#8B8B90'],
}
const PIE_ORDER = ['material', 'labor', 'design', 'deposit', 'other']
const PIE_LABELS = { material: '材料（已购）', labor: '人工', design: '设计', deposit: '订金/定金', other: '其他' }

Page({
  data: {
    theme: 'theme-a',
    needLogin: false,
    project: null,
    currentStage: null,
    stageDone: 0,
    stageTotal: 0,
    stagePercent: 0,
    timeline: [],
    spentText: '¥0.00',
    budgetText: '¥0.00',
    remainText: '¥0.00',
    spentPercent: 0,
    pieSlices: [],
    materialTotalText: '¥0.00',
    matExecPercent: 0, // 采购计划执行率：已购 / 材料清单总额
    latestDiaries: [],
    noProject: false,
    showJoin: false,
    joinCode: '',
    codeCells: [{ idx: 0, v: '' }, { idx: 1, v: '' }, { idx: 2, v: '' }, { idx: 3, v: '' }, { idx: 4, v: '' }, { idx: 5, v: '' }],
    joinFocus: false, // 自动聚焦一次性开关：打开弹窗 300ms 后置 true，失焦即复位（focus 常驻 true 会导致无法再次聚焦）
    kbHeight: 0, // 键盘高度（px）：邀请码输入时把弹窗整体顶到键盘上方
  },

  async onShow() {
    store.applyTheme(this)
    store.applyTabBar(this, 0)
    // 键盘高度监听：邀请码输入框聚焦时把弹窗整体顶到键盘上方（onHide 注销）
    if (!this._kbHandler) {
      this._kbHandler = (res) => { this.setData({ kbHeight: (res && res.height) || 0 }) }
      wx.onKeyboardHeightChange(this._kbHandler)
    }
    const session = await app.ready()
    if (!session) {
      this.setData({ needLogin: true, project: null })
      return
    }
    this.setData({ needLogin: false })
    await this.loadDashboard()
  },

  async loadDashboard() {
    const user = await app.ready()
    const openid = user ? user.id : null
    let projectId = store.getCurrentProjectId()
    // 撤销全员可见（2026-10-09）：先查我加入的项目（members 表），取第一个作为当前项目；
    // 没有加入任何项目 → 空状态（创建 / 邀请码加入），不再自动选「最新项目」。
    const myIds = await access.myProjectIds(openid)
    if (!myIds.length) {
      this.setData({ project: null, noProject: true })
      return
    }
    this.setData({ noProject: false })
    if (!projectId || myIds.indexOf(projectId) === -1) {
      projectId = myIds[0]
      store.setCurrentProjectId(projectId)
    }
    const { data: projects } = await cloud.database
      .from('projects').select('*').eq('id', projectId).limit(1)
    const project = projects && projects[0]
    if (!project) {
      this.setData({ project: null })
      return
    }
    const [{ data: stages }, { data: diaries }, { data: expenses }, { data: materials }] = await Promise.all([
      cloud.database.from('stages').select('*').eq('project_id', projectId).order('sort_order'),
      cloud.database.from('diaries').select('id,title,diary_date,image_paths,updated_at')
        .eq('project_id', projectId).neq('deleted', true)
        .limit(50),
      cloud.database.from('expenses').select('amount,type').eq('project_id', projectId).neq('deleted', true),
      cloud.database.from('materials').select('total_price,status').eq('project_id', projectId),
    ])
    // 老数据可能缺 status，兜底为 pending（否则"当前阶段"判空、完成数恒 0）
    const list = (stages || []).map((s) => ({ ...s, status: s.status || 'pending' }))
    const currentStage = list.find((s) => s.status === 'doing') || list.find((s) => s.status === 'pending') || null
    const stageDone = list.filter((s) => s.status === 'done').length
    const stageTotal = list.length
    const stagePercent = stageTotal ? Math.round((stageDone / stageTotal) * 100) : 0

    // 竖向时间轴：已完成绿实心（带起止日期）、进行中金色高亮、未开始灰空心。
    // 圆点+连线天然成型，没有日期的阶段也不显空，无空轨道问题
    const timeline = list.map((s, i) => {
      const status = s.status || 'pending'
      let dateText = ''
      if (status === 'done' && s.start_date) {
        dateText = String(s.start_date).slice(5) + (s.end_date ? ' ~ ' + String(s.end_date).slice(5) : ' ~')
      } else if (status === 'doing' && s.start_date) {
        dateText = String(s.start_date).slice(5) + ' 起 · 进行中'
      }
      return { idx: i, name: s.name, status, dateText }
    })

    // 已花费口径（与花费页统一）：手动花费（排除历史材料类，避免与材料清单重复）
    // + 已购买/已进场材料的合计（实际成交价）；「待购买」还没花钱不计入——采购项「推进」后数字才会变化
    // 计划价 planned_price：创建时定格；已执行项(已购/已进场)改实际价不动计划价。无该字段的老数据回退 total_price。
    const planOf = (m) => Number((m.planned_price != null ? m.planned_price : m.total_price) || 0)
    const exp = expenses || []
    const mat = materials || []
    const expenseSpent = exp.filter((e) => e.type !== 'material').reduce((sum, e) => sum + Number(e.amount || 0), 0)
    const purchasedMat = mat.filter((m) => m.status === 'bought' || m.status === 'on_site')
    const purchasedMatTotal = purchasedMat.reduce((sum, m) => sum + Number(m.total_price || 0), 0) // 实际已花
    const purchasedPlanTotal = purchasedMat.reduce((sum, m) => sum + planOf(m), 0) // 已执行项的计划额
    const planTotal = mat.reduce((sum, m) => sum + planOf(m), 0) // 计划总额（冻结）
    const pendingPlanTotal = mat.filter((m) => m.status === 'to_buy').reduce((sum, m) => sum + planOf(m), 0) // 待购=计划
    const spent = expenseSpent + purchasedMatTotal
    const spentPercent = project.budget > 0 ? Math.min(100, Math.round((spent / project.budget) * 100)) : 0
    const remain = Math.max(0, Number(project.budget || 0) - spent)
    const sums = {}
    exp.filter((e) => e.type !== 'material').forEach((e) => { sums[e.type] = (sums[e.type] || 0) + Number(e.amount || 0) })
    // 饼图：已花费构成 = 材料（已购·实际）+ 人工/设计/订金/其他；与「已花费」口径完全一致
    const palette = PIE_PALETTES[this.data.theme] || PIE_PALETTES['theme-a']
    const pieValues = {
      material: purchasedMatTotal,
      labor: sums.labor || 0,
      design: sums.design || 0,
      deposit: sums.deposit || 0,
      other: sums.other || 0,
    }
    const pieSlices = PIE_ORDER
      .map((k, i) => ({ key: k, name: PIE_LABELS[k], value: pieValues[k], color: palette[i] }))
      .filter((s) => s.value > 0)
      .map((s) => ({
        ...s,
        text: fen2yuan(s.value),
        pct: spent > 0 ? Math.max(1, Math.round((s.value / spent) * 100)) : 0,
      }))
    const matExecPercent = planTotal > 0 ? Math.round((purchasedPlanTotal / planTotal) * 100) : 0 // 计划执行率（按计划额，推进才变）
    const matPlanDeviation = purchasedMatTotal - purchasedPlanTotal // 实际-计划（已执行项），正=超支

    // 首页「最新日记」：按更新时间倒序，最近动过的在前（updated_at 所有日记都有，无需回退）
    const diaryTs = (d) => {
      const t = d.updated_at ? Date.parse(d.updated_at) : 0
      return isNaN(t) ? 0 : t
    }
    const latestDiaries = (diaries || []).slice().sort((a, b) => diaryTs(b) - diaryTs(a)).slice(0, 3)

    this.setData({
      project,
      currentStage,
      stageDone,
      stageTotal,
      stagePercent,
      timeline,
      spentText: fen2yuan(spent),
      budgetText: fen2yuan(project.budget),
      remainText: fen2yuan(remain),
      spentPercent,
      pieSlices,
      materialTotalText: fen2yuan(planTotal),
      matPurchasedText: fen2yuan(purchasedMatTotal),
      matPendingText: fen2yuan(pendingPlanTotal),
      matExecPercent,
      matPlanDeviationText: matPlanDeviation === 0 ? '' : (matPlanDeviation > 0 ? '超支 ' : '结余 ') + fen2yuan(Math.abs(matPlanDeviation)),
      latestDiaries: latestDiaries,
    }, () => this.drawPie())
  },

  // 环形图（canvas 2d）：中心显示已花费总额，扇区为各花费类目占比；随主题换色
  drawPie() {
    const slices = this.data.pieSlices || []
    this.createSelectorQuery()
      .select('#pieCanvas').fields({ node: true, size: true })
      .exec((res) => {
        const info = res && res[0]
        if (!info || !info.node) return
        const { node: canvas, width, height } = info
        if (!width || !height) return // home-main 处于 hidden 时尺寸为 0，等显示后再画
        const win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
        const dpr = win.pixelRatio || 2
        canvas.width = width * dpr
        canvas.height = height * dpr
        const ctx = canvas.getContext('2d')
        ctx.scale(dpr, dpr)
        ctx.clearRect(0, 0, width, height)
        const cx = width / 2
        const cy = height / 2
        const R = Math.min(cx, cy) - 4
        const r = R * 0.6
        const isB = this.data.theme === 'theme-b'
        const track = isB ? '#EEF1F4' : '#EDF3EF'
        const textMain = isB ? '#232326' : '#3A322B'
        const textSub = isB ? '#8B8B90' : '#8A7E72'
        // 底环（空数据时的占位轨道）
        ctx.beginPath()
        ctx.arc(cx, cy, R, 0, Math.PI * 2)
        ctx.arc(cx, cy, r, Math.PI * 2, 0, true)
        ctx.closePath()
        ctx.fillStyle = track
        ctx.fill()
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        if (!slices.length) {
          ctx.fillStyle = textSub
          ctx.font = '12px sans-serif'
          ctx.fillText('还没有花费记录', cx, cy)
          return
        }
        const total = slices.reduce((s, x) => s + x.value, 0) || 1
        const gap = slices.length > 1 ? 0.035 : 0 // 扇区间留缝更好认
        let a = -Math.PI / 2
        slices.forEach((s) => {
          const ang = (s.value / total) * Math.PI * 2
          if (ang > gap) {
            ctx.beginPath()
            ctx.arc(cx, cy, R, a + gap / 2, a + ang - gap / 2)
            ctx.arc(cx, cy, r, a + ang - gap / 2, a + gap / 2, true)
            ctx.closePath()
            ctx.fillStyle = s.color
            ctx.fill()
          }
          a += ang
        })
        // 中心：已花费 + 金额
        ctx.fillStyle = textSub
        ctx.font = '11px sans-serif'
        ctx.fillText('已花费', cx, cy - 12)
        ctx.fillStyle = textMain
        ctx.font = 'bold 14px sans-serif'
        ctx.fillText(this.data.spentText, cx, cy + 8)
      })
  },

  goCreate() {
    wx.navigateTo({ url: '/pages/project/create' })
  },
  goJoin() {
    this.setBarHidden(true)
    this._applyCode('')
    this.setData({ showJoin: true, joinFocus: false })
    // 延迟自动聚焦：wx:if 刚创建就 focus 在部分机型会失灵（键盘闪退后再点输入框无响应）
    clearTimeout(this._focusTimer)
    this._focusTimer = setTimeout(() => this.setData({ joinFocus: true }), 300)
  },
  noop() {},
  // 回填邀请码：只留数字、截 6 位；同时驱动 6 个格子显示（不依赖输入框原生回显，
  // 规避部分机型 number/digit 键盘「敲了不显示」的回显 bug）
  _applyCode(v) {
    const digits = String(v || '').replace(/\D/g, '').slice(0, 6)
    const cells = []
    for (let i = 0; i < 6; i++) cells.push({ idx: i, v: digits[i] || '' })
    this.setData({ joinCode: digits, codeCells: cells })
  },
  onJoinInput(e) {
    this._applyCode(e.detail.value)
  },
  // 失焦即复位 focus 开关：保证之后每次点击输入框都能重新拉起键盘
  onJoinBlur() {
    this.setData({ joinFocus: false })
  },
  cancelJoin() {
    clearTimeout(this._focusTimer)
    this.setBarHidden(false)
    this._applyCode('')
    this.setData({ showJoin: false, joinFocus: false })
  },
  async confirmJoin() {
    const code = (this.data.joinCode || '').trim()
    if (!/^\d{6}$/.test(code)) {
      this.setData({ joinFocus: false }) // 弹窗保持打开，复位聚焦让用户可再点输入框
      wx.showToast({ title: '请输入 6 位邀请码', icon: 'none' })
      return
    }
    clearTimeout(this._focusTimer)
    wx.showLoading({ title: '加入中', mask: true })
    // showLoading/showToast 共用同一原生单例：hideLoading 必须在 showToast 之前，
    // 否则错误提示刚弹出就被关掉（「输错码无提示」根因）
    let result = null
    try {
      const res = await wx.cloud.callFunction({ name: 'joinProject', data: { code } })
      result = res.result
    } catch (e) {
      result = null
    } finally {
      wx.hideLoading()
    }
    if (!result || !result.ok) {
      wx.showToast({ title: (result && result.message) || '加入失败，请重试', icon: 'none' })
      return
    }
    store.setCurrentProjectId(result.project.id)
    this.setBarHidden(false)
    this._applyCode('')
    this.setData({ showJoin: false, joinFocus: false })
    wx.showToast({ title: '已加入：' + result.project.name, icon: 'success' })
    await this.loadDashboard()
  },
  goStage() {
    wx.navigateTo({ url: '/pages/stage/board' })
  },
  goRoom() {
    wx.navigateTo({ url: '/pages/room/manage' })
  },
  goDiary(e) {
    wx.navigateTo({ url: `/pages/diary/detail?id=${e.currentTarget.dataset.id}` })
  },
  goDiaryList() {
    wx.switchTab({ url: '/pages/diary/list' })
  },
  goMaterials() {
    // 材料清单已并入花费页（单页竖向结构），直接进花费页即可
    wx.switchTab({ url: '/pages/budget/overview' })
  },

  onHide() {
    if (this._kbHandler) {
      wx.offKeyboardHeightChange(this._kbHandler)
      this._kbHandler = null
    }
    this.setBarHidden(false) // 安全兜底：离开页面时恢复 tabBar
  },

  // 弹窗打开期间隐藏自定义 tabBar：其框架包装层层级高于页面 fixed 弹窗，会盖住底部按钮
  setBarHidden(hidden) {
    const bar = this.getTabBar && this.getTabBar()
    if (bar) bar.setData({ hidden: !!hidden })
  },
})
