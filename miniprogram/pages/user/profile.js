const { cloud } = require('../../utils/cloud')
const store = require('../../utils/store')
const { fen2yuan } = require('../../utils/format')
const { exportExpensesCsv } = require('../../utils/exportCsv')
const access = require('../../utils/access')

const app = getApp()

Page({
  data: {
    theme: 'theme-a',
    signedIn: false,
    projects: [], // [{ id, name, role, roleLabel, isManager, isCurrent }]
    currentProjectId: null,
    myOpenid: null,
    myNick: '', // 自己的昵称（profiles.nick_name，login 云函数 setNick 修改）
    // 昵称设置弹窗
    showNick: false,
    nickValue: '',
    nickFocus: false, // 一次性自动聚焦开关（同 joinFocus，防 focus 常驻 true 无法再聚焦）
    savingNick: false,
    showJoin: false,
    joinCode: '',
    codeCells: [{ idx: 0, v: '' }, { idx: 1, v: '' }, { idx: 2, v: '' }, { idx: 3, v: '' }, { idx: 4, v: '' }, { idx: 5, v: '' }],
    joinFocus: false, // 自动聚焦一次性开关：打开弹窗 300ms 后置 true，失焦即复位（focus 常驻 true 会导致无法再次聚焦）
    kbHeight: 0, // 键盘高度（px）：邀请码输入时把弹窗整体顶到键盘上方
    // 成员管理面板
    showManage: false,
    managing: null, // { id, name }
    managingIsOwner: false,
    codes: null, // { family, member }
    memberList: [], // [{ _id, nick, role, roleLabel, isSelf }]
    // AI 设置弹窗（管理员专属；集中配置存 app_settings，三个 AI 函数共用）
    isAnyManager: false,
    showAISet: false,
    aiForm: { base_url: '', model: '', api_key: '' },
    aiConfigured: false,
    aiKeyTail: '',
    aiSaving: false,
  },

  async onShow() {
    store.applyTheme(this)
    store.applyTabBar(this, 4)
    // 键盘高度监听：邀请码输入框聚焦时把弹窗整体顶到键盘上方（onHide 注销）
    if (!this._kbHandler) {
      this._kbHandler = (res) => { this.setData({ kbHeight: (res && res.height) || 0 }) }
      wx.onKeyboardHeightChange(this._kbHandler)
    }
    const session = await app.ready()
    this.setData({ signedIn: !!session, currentProjectId: store.getCurrentProjectId() })
    if (!session) return
    const openid = session.id
    this.setData({ myOpenid: openid })
    // 取自己昵称（profiles 所有人可读；写走 login 云函数 setNick）
    try {
      const { data: profRows } = await cloud.database
        .from('profiles').select('nick_name').eq('owner_id', openid).limit(1)
      this.setData({ myNick: (profRows && profRows[0] && profRows[0].nick_name) || '' })
    } catch (e) { /* 读失败不影响页面，昵称显示为未设置 */ }
    await this.loadProjects(openid)
  },

  onHide() {
    clearTimeout(this._nickTimer)
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

  // 撤销全员可见：列表只显示我加入的项目（members 过滤），并标角色
  async loadProjects(openid) {
    const myIds = await access.myProjectIds(openid)
    if (!myIds.length) {
      this.setData({ projects: [] })
      return
    }
    const { data: projRows } = await cloud.database
      .from('projects').select('id,name,status').in('id', myIds).order('created_at', { ascending: false }).limit(50)
    const members = await access.myMembers(openid)
    const roleMap = {}
    members.forEach((m) => { roleMap[m.project_id] = m.role })
    const current = store.getCurrentProjectId()
    const projects = (projRows || []).map((p) => {
      const role = roleMap[p.id] || 'member'
      return {
        id: p.id,
        name: p.name || '未命名项目',
        role,
        roleLabel: access.roleLabel(role),
        isManager: access.isManager(role),
        isCurrent: p.id === current,
      }
    })
    this.setData({ projects, isAnyManager: projects.some((p) => p.isManager) })
  },

  switchProject(e) {
    const id = e.currentTarget.dataset.id
    store.setCurrentProjectId(id)
    this.setData({
      currentProjectId: id,
      projects: this.data.projects.map((p) => ({ ...p, isCurrent: p.id === id })),
    })
    wx.showToast({ title: '已切换项目', icon: 'none' })
  },

  goCreate() {
    wx.navigateTo({ url: '/pages/project/create' })
  },
  goRoom() {
    wx.navigateTo({ url: '/pages/room/manage' })
  },
  setThemeA() { this.switchTheme('theme-a') },
  setThemeB() { this.switchTheme('theme-b') },
  switchTheme(theme) {
    store.setTheme(theme)
    store.applyTheme(this)
    wx.showToast({ title: theme === 'theme-a' ? '已切换：中古暖调' : '已切换：轻奢冷调', icon: 'none' })
  },

  async goExport() {
    const projectId = store.getCurrentProjectId()
    await exportExpensesCsv(cloud, projectId)
  },

  // —— 我的昵称：成员列表/日记/评论显示的名字；写走 login 云函数（profiles 仅服务端可写）——
  openNick() {
    this.setBarHidden(true)
    this.setData({ showNick: true, nickValue: this.data.myNick || '', nickFocus: false })
    clearTimeout(this._nickTimer)
    this._nickTimer = setTimeout(() => this.setData({ nickFocus: true }), 300)
  },
  onNickInput(e) {
    this.setData({ nickValue: e.detail.value })
  },
  onNickBlur() {
    this.setData({ nickFocus: false })
  },
  cancelNick() {
    clearTimeout(this._nickTimer)
    this.setBarHidden(false)
    this.setData({ showNick: false, nickFocus: false })
  },
  async saveNick() {
    const nick = (this.data.nickValue || '').trim()
    if (!nick) {
      wx.showToast({ title: '请输入昵称', icon: 'none' })
      return
    }
    if (this.data.savingNick) return
    this.setData({ savingNick: true })
    let result = null
    try {
      const r = await wx.cloud.callFunction({ name: 'login', data: { setNick: nick } })
      result = r.result
    } catch (e) {
      result = null
    }
    this.setData({ savingNick: false })
    if (!result || !result.ok) {
      wx.showToast({ title: (result && result.error) || '保存失败，请重试', icon: 'none' })
      return
    }
    clearTimeout(this._nickTimer)
    this.setBarHidden(false)
    this.setData({ showNick: false, nickFocus: false, myNick: nick })
    wx.showToast({ title: '昵称已保存', icon: 'success' })
    // 成员管理面板若开着，刷新成员名显示
    if (this.data.showManage && this.data.managing) {
      await this.loadMemberList(this.data.managing.id)
    }
  },

  // 邀请码加入
  goJoin() {
    this.setBarHidden(true)
    this._applyCode('')
    this.setData({ showJoin: true, joinFocus: false })
    // 延迟自动聚焦：wx:if 刚创建就 focus 在部分机型会失灵（键盘闪退后再点输入框无响应）
    clearTimeout(this._focusTimer)
    this._focusTimer = setTimeout(() => this.setData({ joinFocus: true }), 300)
  },
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
  noop() {},
  async confirmJoin() {
    const code = (this.data.joinCode || '').trim()
    if (!/^\d{6}$/.test(code)) {
      this.setData({ joinFocus: false }) // 弹窗保持打开，复位聚焦让用户可再点输入框
      wx.showToast({ title: '请输入 6 位邀请码', icon: 'none' })
      return
    }
    clearTimeout(this._focusTimer)
    wx.showLoading({ title: '加入中', mask: true })
    // 注意：showLoading/showToast 共用同一原生单例，hideLoading 必须在 showToast 之前，
    // 否则错误提示刚弹出就被 hideLoading 关掉（表现为「输错码没有任何提示」）
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
    this.setData({ showJoin: false, joinFocus: false, currentProjectId: result.project.id })
    wx.showToast({ title: '已加入：' + result.project.name, icon: 'success' })
    await this.loadProjects(this.data.myOpenid)
  },

  // —— AI 设置（管理员专属）：集中配置存 app_settings，askAI/weeklyDigest/enrichArticle 共用 ——
  async openAI() {
    this.setBarHidden(true)
    this.setData({ showAISet: true, aiConfigured: false, aiKeyTail: '', aiForm: { base_url: '', model: '', api_key: '' } })
    try {
      const r = await wx.cloud.callFunction({ name: 'aiAdmin', data: { action: 'get' } })
      const res = r && r.result
      if (res && res.ok && res.configured) {
        this.setData({
          aiConfigured: true,
          aiKeyTail: res.keyTail || '',
          aiForm: { base_url: res.base_url || '', model: res.model || '', api_key: '' }, // 密钥不回显，留空=不修改
        })
      }
    } catch (e) { /* 预填失败给空表单，不影响配置 */ }
  },

  onAIInput(e) {
    const field = e.currentTarget.dataset.field
    this.setData({ ['aiForm.' + field]: e.detail.value })
  },

  cancelAI() {
    this.setBarHidden(false)
    this.setData({ showAISet: false })
  },

  async saveAI() {
    const f = this.data.aiForm
    if (!f.base_url.trim() || !f.model.trim()) {
      wx.showToast({ title: '接口地址与模型名必填', icon: 'none' })
      return
    }
    if (!this.data.aiConfigured && !f.api_key.trim()) {
      wx.showToast({ title: '请填写 API Key', icon: 'none' })
      return
    }
    this.setData({ aiSaving: true })
    // showLoading/showToast 共用原生单例：hideLoading 必须在 showToast 之前
    let result = null
    try {
      const r = await wx.cloud.callFunction({
        name: 'aiAdmin',
        data: { action: 'save', base_url: f.base_url.trim(), model: f.model.trim(), api_key: f.api_key.trim() },
      })
      result = r && r.result
    } catch (e) {
      result = { ok: false, message: '网络异常，请重试' }
    } finally {
      this.setData({ aiSaving: false })
    }
    if (!result || !result.ok) {
      wx.showToast({ title: (result && result.message) || '保存失败，请重试', icon: 'none' })
      return
    }
    this.cancelAI()
    this.setData({ aiConfigured: true, aiKeyTail: '****' })
    wx.showToast({ title: '已保存，全端生效' })
  },

  // 成员管理面板（仅管理员可打开）
  async openManage(e) {
    const id = e.currentTarget.dataset.id
    const proj = this.data.projects.find((p) => p.id === id)
    if (!proj || !proj.isManager) return
    wx.showLoading({ title: '加载中', mask: true })
    try {
      const { data: projRows } = await cloud.database
        .from('projects').select('id,name,invite_code_family,invite_code_member').eq('id', id).limit(1)
      const p = projRows && projRows[0]
      const codes = { family: (p && p.invite_code_family) || '', member: (p && p.invite_code_member) || '' }
      // 老项目缺码则补生成（管理员上下文云函数，跳过客户端的写权限限制）
      if (!codes.family || !codes.member) {
        if (!codes.family) {
          const r = await wx.cloud.callFunction({ name: 'projectAdmin', data: { action: 'regenCode', projectId: id, type: 'family' } })
          if (r && r.result && r.result.ok) codes.family = r.result.code
        }
        if (!codes.member) {
          const r = await wx.cloud.callFunction({ name: 'projectAdmin', data: { action: 'regenCode', projectId: id, type: 'member' } })
          if (r && r.result && r.result.ok) codes.member = r.result.code
        }
      }
      await this.loadMemberList(id)
      this.setBarHidden(true)
      this.setData({ showManage: true, managing: { id, name: proj.name }, managingIsOwner: proj.role === 'owner', codes })
    } finally {
      wx.hideLoading()
    }
  },
  closeManage() {
    this.setBarHidden(false)
    this.setData({ showManage: false, managing: null, managingIsOwner: false, memberList: [] })
  },
  noopManage() {},

  async loadMemberList(projectId) {
    const { data } = await cloud.database
      .from('members').select('id,user_id,role,status').eq('project_id', projectId).eq('status', 'active').limit(50)
    const list = data || []
    const ids = [...new Set(list.map((m) => m.user_id))]
    let nameMap = {}
    if (ids.length) {
      const { data: profiles } = await cloud.database.from('profiles').select('owner_id,nick_name').in('owner_id', ids)
      ;(profiles || []).forEach((p) => { nameMap[p.owner_id] = p.nick_name })
    }
    const memberList = list.map((m) => ({
      _id: m.id,
      user_id: m.user_id,
      role: m.role,
      roleLabel: access.roleLabel(m.role),
      isSelf: m.user_id === this.data.myOpenid,
      // 昵称取 profiles.nick_name；未设昵称的成员用「角色·openid 尾 4 位」区分，避免多人同名「成员」难以辨认
      nick: nameMap[m.user_id] || ('成员·' + (m.user_id ? String(m.user_id).slice(-4) : '????')),
    }))
    this.setData({ memberList })
  },

  copyCode(e) {
    const code = e.currentTarget.dataset.code
    if (!code) return
    wx.setClipboardData({ data: code, success: () => wx.showToast({ title: '邀请码已复制', icon: 'none' }) })
  },
  async regenCode(e) {
    const type = e.currentTarget.dataset.type
    const id = this.data.managing.id
    wx.showLoading({ title: '重置中', mask: true })
    let result = null
    try {
      const r = await wx.cloud.callFunction({ name: 'projectAdmin', data: { action: 'regenCode', projectId: id, type } })
      result = r.result
    } catch (err) {
      result = null
    } finally {
      wx.hideLoading() // 必须先于 toast，否则提示被瞬间关掉
    }
    if (!result || !result.ok) {
      wx.showToast({ title: (result && result.message) || '重置失败', icon: 'none' })
      return
    }
    wx.showToast({ title: '已重置', icon: 'success' })
    this.setData({ codes: { ...this.data.codes, [type]: result.code } })
  },
  async removeMember(e) {
    const memberId = e.currentTarget.dataset.id
    const ok = await new Promise((r) => wx.showModal({
      title: '移除成员', content: '确定将该成员移出项目？', success: (s) => r(!!s.confirm),
    }))
    if (!ok) return
    wx.showLoading({ title: '移除中', mask: true })
    let result = null
    try {
      const r = await wx.cloud.callFunction({
        name: 'projectAdmin', data: { action: 'removeMember', projectId: this.data.managing.id, memberId },
      })
      result = r.result
    } catch (err) {
      result = null
    } finally {
      wx.hideLoading()
    }
    if (!result || !result.ok) {
      wx.showToast({ title: (result && result.message) || '操作失败', icon: 'none' })
      return
    }
    wx.showToast({ title: '已移除', icon: 'success' })
    await this.loadMemberList(this.data.managing.id)
  },
  async exitProject() {
    const id = this.data.managing.id
    const ok = await new Promise((r) => wx.showModal({
      title: '退出项目', content: '确定退出该项目？退出后需重新用邀请码加入', success: (s) => r(!!s.confirm),
    }))
    if (!ok) return
    wx.showLoading({ title: '退出中', mask: true })
    let result = null
    try {
      const r = await wx.cloud.callFunction({ name: 'projectAdmin', data: { action: 'exit', projectId: id } })
      result = r.result
    } catch (err) {
      result = null
    } finally {
      wx.hideLoading()
    }
    if (!result || !result.ok) {
      wx.showToast({ title: (result && result.message) || '操作失败', icon: 'none' })
      return
    }
    wx.showToast({ title: '已退出', icon: 'success' })
    this.setBarHidden(false)
    this.setData({ showManage: false, managing: null })
    await this.loadProjects(this.data.myOpenid)
  },
  async deleteProject() {
    const id = this.data.managing.id
    const ok = await new Promise((r) => wx.showModal({
      title: '删除项目',
      content: '将删除该项目及全部阶段/房间/日记/花费/材料/知识库，且不可恢复。确定？',
      confirmColor: '#C0392B',
      success: (s) => r(!!s.confirm),
    }))
    if (!ok) return
    wx.showLoading({ title: '删除中', mask: true })
    let result = null
    try {
      const r = await wx.cloud.callFunction({ name: 'projectAdmin', data: { action: 'deleteProject', projectId: id } })
      result = r.result
    } catch (err) {
      result = null
    } finally {
      wx.hideLoading()
    }
    if (!result || !result.ok) {
      wx.showToast({ title: (result && result.message) || '删除失败', icon: 'none' })
      return
    }
    wx.showToast({ title: '已删除', icon: 'success' })
    this.setBarHidden(false)
    this.setData({ showManage: false, managing: null })
    if (store.getCurrentProjectId() === id) store.setCurrentProjectId(null)
    await this.loadProjects(this.data.myOpenid)
  },
})
