const store = require('../../utils/store')

const app = getApp()

// 三维评分（易用性 / 美观性 / 功能性）：1-5 分，0 = 未评。
// 约束：仅允许 1-5 整数；用户可重复点击同一颗星切换清除。
// 提交口径：评分空 + 意见空 → 拦截；任一非空 → 入库。

const DIM_KEYS = ['usability', 'aesthetics', 'functionality']

// ISO 时间戳（UTC）→ 中国本地时间 `YYYY-MM-DD HH:mm`
// 历史：曾用 `s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/)` 直接截前 13 位，
//   但数据库存的 created_at 是 `new Date().toISOString()` 的 UTC 串，
//   直接截得到的是 UTC 时间（如 02:58），用户在中国看到本地时间应是 10:58（+8h），
//   差 8 小时会让用户怀疑「时间不对」。修法：手动 +8 小时再格式化。
//   不依赖 toLocaleString 是因为部分平台（如 HarmonyOS 微信）的默认时区可能不准确，
//   项目方所在地就是北京，统一 UTC+8 最稳。
const TZ_OFFSET_MS = 8 * 3600 * 1000
function formatTime(iso) {
  const s = String(iso || '').trim()
  if (!s) return '—'
  const d = new Date(s)
  if (isNaN(d.getTime())) {
    // 解析失败兜底：保留原来的「前 13 位」逻辑
    const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/)
    return m ? m[1] + ' ' + m[2] : s.slice(0, 16)
  }
  const t = new Date(d.getTime() + TZ_OFFSET_MS)
  const pad = (n) => (n < 10 ? '0' + n : '' + n)
  return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate())
    + ' ' + pad(t.getUTCHours()) + ':' + pad(t.getUTCMinutes())
}

// 本地缓存 key：云函数 feedbackList 不可用（未部署 / 调用失败）时，
// 用本地图把刚提交的内容兜底出来给用户看；不会和云端数据冲突（只兜底用）
const LOCAL_KEY = 'localFeedbackList'
function readLocalFeedback() {
  try {
    const arr = wx.getStorageSync(LOCAL_KEY)
    return Array.isArray(arr) ? arr : []
  } catch (e) { return [] }
}
function appendLocalFeedback(item) {
  try {
    const arr = readLocalFeedback()
    arr.unshift(item)
    wx.setStorageSync(LOCAL_KEY, arr.slice(0, 200))
  } catch (e) { /* 写失败也不影响主流程 */ }
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
    // 详情弹窗：点击历史条目后从底部弹出
    showDetail: false,
    detailItem: null,
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

  // 点击历史条目 → 打开详情弹窗（含每维分数数字、评论、来源 ID 等完整信息）
  openDetail(e) {
    const idx = Number(e.currentTarget.dataset.index || 0)
    const item = (this.data.historyList || [])[idx]
    if (!item) return
    this.setData({ detailItem: item, showDetail: true })
    // 自定义 tabBar 会盖住 fixed 弹窗，临时隐藏；关闭时恢复
    try { if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().setData({ hidden: true }) } catch (err) {}
  },

  closeDetail() {
    this.setData({ showDetail: false })
    // 短暂延迟恢复 tabBar，避免动画过程中的层级叠加错位
    setTimeout(() => {
      try { if (typeof this.getTabBar === 'function' && this.getTabBar()) this.getTabBar().setData({ hidden: false }) } catch (err) {}
    }, 200)
  },

  // 拉取历史反馈（按当前 historyScope：self/all）
  // 服务端在管理员申请 all 但实际不是管理员时会强制回落到 self，
  // 这里同步对齐 UI，避免「选了全员但只列自己的数据」出现
  // 兜底：若云函数没部署 / 调用失败（feedbackList 不存在是 2026-10-15 用户遇到的实坑），
  //      用本地缓存展示自己提交过的内容，至少用户能看到自己刚写的；
  //      服务端成功时仍以云端为主源（本地仅作为「数据存在但读不到」时的兜底）。
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
      // 云函数不存在 / 超时 / 鉴权失败等 → result.ok=false
      result = { ok: false, message: '加载失败（云函数未就绪）' }
    }
    this.setData({ historyLoading: false })
    // 本地兜底：self 视图下若「云端空 / 云端失败」，都尝试用本地缓存展示自己提交过的内容
    // 原因：2026-10-15 用户反馈「提交后看不到自己的反馈」——经排查是反馈列表云函数
    //       feedbackList 已部署但 openid 查询返回空（管理员 self 场景偶发），
    //       此时 feedbackList 仍返回 ok=true，单纯「result.ok=false 才兜底」覆盖不到。
    if (!result || !result.ok) {
      // ★ 云端失败：尝试本地兜底
      this._fallbackToLocal(false)
      return
    }
    const isManager = !!result.isManager
    const finalScope = (this.data.historyScope === 'all' && result.scope === 'self') ? 'self' : this.data.historyScope
    let list = (result.list || []).map((it) => ({
      ...it,
      timeText: formatTime(it.submittedAt),
    }))
    // ★ self 视图下云端空：用本地兜底（云端有数据时不掺入本地，避免 UI 看起来不一致）
    if (finalScope === 'self' && list.length === 0) {
      const local = readLocalFeedback()
      if (local.length) {
        list = local.map((it) => ({ ...it, timeText: formatTime(it.submittedAt), fromLocal: true }))
        this.setData({
          isManager,
          historyScope: finalScope,
          historyList: list,
          historyEmptyText: '',
        })
        return
      }
    }
    this.setData({
      isManager,
      historyScope: finalScope,
      historyList: list,
      historyEmptyText: list.length ? '' : (finalScope === 'all' ? '暂无全员反馈' : '还没有反馈记录'),
    })
  },

  // 本地兜底辅助：仅 self 视图
  _fallbackToLocal(keepManager) {
    const isAll = this.data.historyScope === 'all'
    const local = isAll ? [] : readLocalFeedback()
    if (local.length) {
      const list = local.map((it) => ({ ...it, timeText: formatTime(it.submittedAt), fromLocal: true }))
      this.setData({
        historyList: list,
        historyEmptyText: '',
        isManager: keepManager ? this.data.isManager : false,
      })
      return
    }
    this.setData({
      historyList: [],
      historyEmptyText: '加载失败（云端暂无记录）',
      isManager: false,
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
    // ★ 本地兜底缓存：把刚提交的快照保存到本地，万一云端 feedbackList 没部署/失败，
    //   loadHistory() 会自动从这里兜底出来给用户看自己刚写的内容
    appendLocalFeedback({
      id: 'local-' + nowISO,
      submittedAt: nowISO,
      scores: { usability: s.usability, aesthetics: s.aesthetics, functionality: s.functionality },
      comment: text,
      system: payload.system,
    })
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
