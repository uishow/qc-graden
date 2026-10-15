const store = require('../../utils/store')

// 我的反馈历史 / 管理员全员反馈 — 完全由 feedbackList 云函数控制可见性：
//   scope='self' (默认)：返回当前 openid 的反馈（任何登录用户）
//   scope='all'：仅 family/owner 才能取（其他角色服务端强制回落为 self）
const PAGE_SIZE = 50

function formatTime(iso) {
  // ISO 时间戳 → YYYY-MM-DD HH:mm；空值兜底 '—'
  const s = String(iso || '').trim()
  if (!s) return '—'
  // 服务端 created_at 通常是 ISO 字符串 (含 T)；浏览器兼容方式截断
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/)
  if (m) return m[1] + ' ' + m[2]
  return s.slice(0, 16)
}

Page({
  data: {
    theme: 'theme-a',
    loading: false,
    isManager: false,
    scope: 'self', // 'self' = 我的反馈 / 'all' = 全员（仅管理员）
    list: [],
    emptyText: '',
  },

  onShow() {
    store.applyTheme(this)
    // 不带 tabBar，不调 applyTabBar
    this.load()
  },

  async load() {
    if (this.data.loading) return
    this.setData({ loading: true })
    let result = null
    try {
      const r = await wx.cloud.callFunction({
        name: 'feedbackList',
        data: { scope: this.data.scope },
      })
      result = (r && r.result) || null
    } catch (e) {
      result = { ok: false, message: '网络异常，请重试' }
    }
    this.setData({ loading: false })
    if (!result || !result.ok) {
      this.setData({ list: [], emptyText: (result && result.message) || '加载失败', isManager: false })
      return
    }
    const isManager = !!result.isManager
    // 服务端可能降级：客户端申请的 scope='all' 但非管理员，服务器把 scope 强制回落到 self，
    // 此处也同步对齐 UI，避免看到「全员反馈」tab 高亮但只列了自己的数据
    const finalScope = (this.data.scope === 'all' && result.scope === 'self') ? 'self' : this.data.scope
    const list = (result.list || []).map((it) => ({
      ...it,
      timeText: formatTime(it.submittedAt),
    }))
    this.setData({
      isManager,
      scope: finalScope,
      list,
      emptyText: list.length ? '' : (finalScope === 'all' ? '暂无全员反馈' : '还没有反馈记录'),
    })
  },

  switchScope(e) {
    const next = e.currentTarget.dataset.scope
    if (!next || next === this.data.scope) return
    this.setData({ scope: next, list: [] }, () => this.load())
  },

  goWrite() {
    wx.navigateTo({ url: '/pages/feedback/edit' })
  },
})
