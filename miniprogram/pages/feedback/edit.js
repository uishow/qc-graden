const store = require('../../utils/store')

const app = getApp()

// 三维评分（易用性 / 美观性 / 功能性）：1-5 分，0 = 未评。
// 约束：仅允许 1-5 整数；用户可重复点击同一颗星切换清除。
// 提交口径：评分空 + 意见空 → 拦截；任一非空 → 入库。

const DIM_KEYS = ['usability', 'aesthetics', 'functionality']

// ISO 时间戳 → YYYY-MM-DD HH:mm；空值兜底 '—'
function formatTime(iso) {
  const s = String(iso || '').trim()
  if (!s) return '—'
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/)
  return m ? m[1] + ' ' + m[2] : s.slice(0, 16)
}

Page({
  data: {
    theme: 'theme-a',
    scores: { usability: 0, aesthetics: 0, functionality: 0 }, // 每维 0-5，0 = 未评
    comment: '', // 用户输入的意见（最多 1000 字，服务端再兜底截断）
    submitting: false,
    done: false,
    // 提交回执快照：done=true 时填，供感谢卡片把刚提交的内容回放给用户看；
    // 同时写 wx.storage「lastFeedbackAt」让「我的」页下方展示一行「上次反馈：xxx」
    doneSnapshot: null, // { scores:{...}, comment, hasScores, hasComment, submittedAt }
    // 我的反馈历史（合并自独立 /list 页，commit 6 2026-10-15）
    showHistory: true, // 默认展开：用户一进页面就能看到自己过往的反馈
    isManager: false,
    historyScope: 'self', // 'self' = 我的反馈 / 'all' = 全员反馈（仅管理员可切）
    historyList: [],
    historyLoading: false,
    historyEmptyText: '',
  },

  onShow() {
    store.applyTheme(this)
    // 每次进入页面重新加载历史区——也保证新提交的反馈立刻能看到
    this.loadHistory()
  },

  // 点星打分：再次点击同一颗星 = 切换清除（变 0），点不同星 = 替换。
  setScore(e) {
    if (this.data.submitting || this.data.done) return
    const field = e.currentTarget.dataset.field
    const value = Number(e.currentTarget.dataset.value)
    if (!DIM_KEYS.includes(field)) return
    const cur = this.data.scores[field] || 0
    const next = cur === value ? 0 : value
    this.setData({ ['scores.' + field]: next })
  },

  onCommentInput(e) {
    const v = String(e.detail.value || '')
    this.setData({ comment: v.length > 1000 ? v.slice(0, 1000) : v })
  },

  resetAgain() {
    this.setData({
      scores: { usability: 0, aesthetics: 0, functionality: 0 },
      comment: '',
      done: false,
      doneSnapshot: null,
      submitting: false,
    })
    // 「再写一条」时同时刷新历史区
    this.loadHistory()
  },

  goBack() {
    wx.navigateBack({ delta: 1, fail: () => wx.switchTab({ url: '/pages/user/profile' }) })
  },

  toggleHistory() {
    this.setData({ showHistory: !this.data.showHistory })
  },

  switchHistoryScope(e) {
    const next = e.currentTarget.dataset.scope
    if (!next || next === this.data.historyScope) return
    this.setData({ historyScope: next, historyList: [] }, () => this.loadHistory())
  },

  // 拉取历史反馈（按当前 historyScope：self/all）
  // 服务端在管理员申请 all 但实际不是管理员时会强制回落到 self，
  // 这里同步对齐 UI，避免「选了全员但只列自己的数据」出现
  async loadHistory() {
    if (this.data.historyLoading) return
    this.setData({ historyLoading: true })
    let result = null
    try {
      const r = await wx.cloud.callFunction({
        name: 'feedbackList',
        data: { scope: this.data.historyScope },
      })
      result = (r && r.result) || null
    } catch (e) {
      result = { ok: false, message: '网络异常，请重试' }
    }
    this.setData({ historyLoading: false })
    if (!result || !result.ok) {
      this.setData({
        historyList: [],
        historyEmptyText: (result && result.message) || '加载失败',
        isManager: false,
      })
      return
    }
    const isManager = !!result.isManager
    const finalScope = (this.data.historyScope === 'all' && result.scope === 'self') ? 'self' : this.data.historyScope
    const list = (result.list || []).map((it) => ({
      ...it,
      timeText: formatTime(it.submittedAt),
    }))
    this.setData({
      isManager,
      historyScope: finalScope,
      historyList: list,
      historyEmptyText: list.length ? '' : (finalScope === 'all' ? '暂无全员反馈' : '还没有反馈记录'),
    })
  },

  async submit() {
    if (this.data.submitting || this.data.done) return
    const s = this.data.scores
    const text = (this.data.comment || '').trim()
    const anyRated = DIM_KEYS.some((k) => (s[k] || 0) > 0)
    if (!anyRated && !text) {
      wx.showToast({ title: '请至少打一项分或填写意见', icon: 'none' })
      return
    }
    // 一次性收集客户端环境，便于后续按版本/平台归因
    const sysInfo = (() => {
      try { return wx.getSystemInfoSync() } catch (e) { return {} }
    })()
    const payload = {
      scores: { usability: s.usability, aesthetics: s.aesthetics, functionality: s.functionality },
      comment: text,
      app_version: (sysInfo && (sysInfo.AppBaseInfo && sysInfo.AppBaseInfo.version) || sysInfo.version) || '',
      platform: (sysInfo && (sysInfo.AppBaseInfo && sysInfo.AppBaseInfo.platform) || sysInfo.platform) || '',
      system: (sysInfo && (sysInfo.system || '')) || '',
    }

    this.setData({ submitting: true })
    wx.showLoading({ title: '提交中', mask: true })
    let result = null
    try {
      const r = await wx.cloud.callFunction({ name: 'feedbackSubmit', data: payload })
      result = (r && r.result) || null
    } catch (err) {
      result = { ok: false, message: '网络异常，请重试' }
    } finally {
      wx.hideLoading() // 必须先于 toast，否则提示被瞬间关掉
    }
    this.setData({ submitting: false })
    if (!result || !result.ok) {
      wx.showToast({ title: (result && result.message) || '提交失败', icon: 'none' })
      return
    }
    // 写「上次反馈时间」到本地缓存：让「我的」页下方展示一行小字
    const nowISO = new Date().toISOString()
    try { wx.setStorageSync('lastFeedbackAt', nowISO) } catch (e) { /* 写失败不影响主流程 */ }
    this.setData({
      done: true,
      doneSnapshot: {
        scores: { usability: s.usability, aesthetics: s.aesthetics, functionality: s.functionality },
        comment: text,
        hasScores: anyRated,
        hasComment: !!text,
        submittedAt: nowISO,
      },
    })
    wx.showToast({ title: '已提交，谢谢', icon: 'success' })
    // 关键修复（2026-10-15 用户反馈「自己写的看不到自己提交的」）：
    // 提交成功后立即刷新历史区，让刚提交的那条立刻出现在「我的反馈」列表里
    this.loadHistory()
  },
})
