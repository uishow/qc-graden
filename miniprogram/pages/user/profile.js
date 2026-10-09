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
    showJoin: false,
    joinCode: '',
    kbHeight: 0, // 键盘高度（px）：邀请码输入时把弹窗整体顶到键盘上方
    // 成员管理面板
    showManage: false,
    managing: null, // { id, name }
    managingIsOwner: false,
    codes: null, // { family, member }
    memberList: [], // [{ _id, nick, role, roleLabel, isSelf }]
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
    await this.loadProjects(openid)
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
    this.setData({ projects })
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

  // 邀请码加入
  goJoin() {
    this.setBarHidden(true)
    this.setData({ showJoin: true, joinCode: '' })
  },
  onJoinInput(e) {
    this.setData({ joinCode: e.detail.value })
  },
  cancelJoin() {
    this.setBarHidden(false)
    this.setData({ showJoin: false, joinCode: '' })
  },
  noop() {},
  async confirmJoin() {
    const code = (this.data.joinCode || '').trim()
    if (!/^\d{6}$/.test(code)) {
      wx.showToast({ title: '请输入 6 位邀请码', icon: 'none' })
      return
    }
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
    this.setData({ showJoin: false, joinCode: '', currentProjectId: result.project.id })
    wx.showToast({ title: '已加入：' + result.project.name, icon: 'success' })
    await this.loadProjects(this.data.myOpenid)
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
