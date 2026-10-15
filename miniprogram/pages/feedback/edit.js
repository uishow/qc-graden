const store = require('../../utils/store')

const app = getApp()

// 三维评分（易用性 / 美观性 / 功能性）：1-5 分，0 = 未评。
// 约束：仅允许 1-5 整数；用户可重复点击同一颗星切换清除。
// 提交口径：评分空 + 意见空 → 拦截；任一非空 → 入库。

const DIM_KEYS = ['usability', 'aesthetics', 'functionality']

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
  },

  onShow() {
    store.applyTheme(this)
    // 评价页不带 tabBar，不调 applyTabBar
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
  },

  goBack() {
    wx.navigateBack({ delta: 1, fail: () => wx.switchTab({ url: '/pages/user/profile' }) })
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
  },
})
