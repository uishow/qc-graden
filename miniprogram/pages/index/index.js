const { cloud } = require('../../utils/cloud')
const store = require('../../utils/store')
const access = require('../../utils/access')
const { fen2yuan } = require('../../utils/format')

const app = getApp()
const TYPE_NAMES = { material: '材料', labor: '人工', design: '设计', deposit: '订金/定金', other: '其他' }

Page({
  data: {
    theme: 'theme-a',
    needLogin: false,
    project: null,
    currentStage: null,
    stageDone: 0,
    stageTotal: 0,
    stagePercent: 0,
    stageChips: [],
    spentText: '¥0.00',
    budgetText: '¥0.00',
    remainText: '¥0.00',
    spentPercent: 0,
    typeSums: [],
    materialTotalText: '¥0.00',
    latestDiaries: [],
    noProject: false,
    showJoin: false,
    joinCode: '',
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
      cloud.database.from('diaries').select('id,title,diary_date,image_paths')
        .eq('project_id', projectId).neq('deleted', true)
        .order('diary_date', { ascending: false }).limit(3),
      cloud.database.from('expenses').select('amount,type').eq('project_id', projectId).neq('deleted', true),
      cloud.database.from('materials').select('total_price,status').eq('project_id', projectId),
    ])
    // 老数据可能缺 status，兜底为 pending（否则"当前阶段"判空、完成数恒 0）
    const list = (stages || []).map((s) => ({ ...s, status: s.status || 'pending' }))
    const currentStage = list.find((s) => s.status === 'doing') || list.find((s) => s.status === 'pending') || null
    const stageDone = list.filter((s) => s.status === 'done').length
    const stageTotal = list.length
    const stagePercent = stageTotal ? Math.round((stageDone / stageTotal) * 100) : 0
    const stageChips = list.map((s) => ({ name: s.name, status: s.status || 'pending' }))

    // 已花费口径（与花费页统一）：手动花费（排除历史材料类，避免与材料清单重复）
    // + 已购买/已进场材料的合计；「待购买」还没花钱不计入——采购项「推进」后数字才会变化
    const exp = expenses || []
    const mat = materials || []
    const expenseSpent = exp.filter((e) => e.type !== 'material').reduce((sum, e) => sum + Number(e.amount || 0), 0)
    const purchasedMatTotal = mat
      .filter((m) => m.status === 'bought' || m.status === 'on_site')
      .reduce((sum, m) => sum + Number(m.total_price || 0), 0)
    const spent = expenseSpent + purchasedMatTotal
    const spentPercent = project.budget > 0 ? Math.min(100, Math.round((spent / project.budget) * 100)) : 0
    const remain = Math.max(0, Number(project.budget || 0) - spent)
    const sums = {}
    exp.filter((e) => e.type !== 'material').forEach((e) => { sums[e.type] = (sums[e.type] || 0) + Number(e.amount || 0) })
    const typeSums = Object.keys(TYPE_NAMES)
      .filter((t) => sums[t])
      .map((t) => ({ name: TYPE_NAMES[t], text: fen2yuan(sums[t]) }))
    const materialTotal = mat.reduce((sum, m) => sum + Number(m.total_price || 0), 0)
    const matPendingTotal = Math.max(0, materialTotal - purchasedMatTotal)

    this.setData({
      project,
      currentStage,
      stageDone,
      stageTotal,
      stagePercent,
      stageChips,
      spentText: fen2yuan(spent),
      budgetText: fen2yuan(project.budget),
      remainText: fen2yuan(remain),
      spentPercent,
      typeSums,
      materialTotalText: fen2yuan(materialTotal),
      matPurchasedText: fen2yuan(purchasedMatTotal),
      matPendingText: fen2yuan(matPendingTotal),
      latestDiaries: diaries || [],
    })
  },

  goCreate() {
    wx.navigateTo({ url: '/pages/project/create' })
  },
  goJoin() {
    this.setBarHidden(true)
    this.setData({ showJoin: true, joinCode: '' })
  },
  noop() {},
  onJoinInput(e) {
    this.setData({ joinCode: e.detail.value })
  },
  cancelJoin() {
    this.setBarHidden(false)
    this.setData({ showJoin: false, joinCode: '' })
  },
  async confirmJoin() {
    const code = (this.data.joinCode || '').trim()
    if (!/^\d{6}$/.test(code)) {
      wx.showToast({ title: '请输入 6 位邀请码', icon: 'none' })
      return
    }
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
    this.setData({ showJoin: false, joinCode: '' })
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
