// AI 管家反馈闭环 · 管理员待办台
// 数据来源：ai_feedback 集合（read/write=false，只能经 aiFeedback 云函数）
// 三类用法：
//   1. 看「高频 + 待处理」的问题，按出现次数倒序，先修最痛的
//   2. edit_diff 类直接带「AI 解析成什么 / 用户改成什么」= 现成的回归语料 + 标准答案
//   3. 「复制待办」把待处理项拷成文本，可直接贴给开发/AI 批量修
const aiFeedback = require('../../utils/aiFeedback')
const { formatLocal } = require('../../utils/time')

const SIGNAL_LABEL = {
  edit_diff: '解析字段要改',
  cancel: '用户取消录入',
  unparsed: '没解析出字段',
  no_result: '查不到结果',
  retry: '重复提问',
  degraded: 'AI 降级回答',
  thumb_down: '点了👎',
}
// 严重程度：决定排序权重（edit_diff 有标准答案，最该先修）
const SIGNAL_WEIGHT = { edit_diff: 100, unparsed: 80, thumb_down: 60, no_result: 50, retry: 30, cancel: 20, degraded: 10 }

const STATUS_LABEL = { pending: '待处理', fixed: '已修复', notbug: '不是问题', ignored: '已忽略' }
const STATUS_ORDER = ['pending', 'fixed', 'notbug', 'ignored']

Page({
  data: {
    loading: true,
    groups: [],       // 当前筛选后的分组（含视图字段）
    all: [],          // 全量
    total: 0,
    pendingCount: 0,
    filter: 'pending',
    filters: [
      { key: 'pending', label: '待处理' },
      { key: 'all', label: '全部' },
      { key: 'fixed', label: '已修复' },
      { key: 'notbug', label: '不是问题' },
      { key: 'ignored', label: '已忽略' },
    ],
    expanded: {},     // key -> true（展开看样例）
  },

  onShow() {
    this.load()
  },

  async load() {
    this.setData({ loading: true })
    const { data, error } = await aiFeedback.list()
    if (error || !data) {
      this.setData({ loading: false })
      wx.showToast({ title: (error && error.message) || '加载失败', icon: 'none' })
      return
    }
    const all = (data.groups || []).map((g) => {
      const samples = (g.samples || []).map((s) => ({
        question: s.question || '',
        understood: s.understood || '',
        fixed: s.fixed || '',
        reply: s.reply || '',
        reason: s.reason || '',
        at: formatLocal(s.at, 'short'),
      }))
      return {
        key: g.key,
        signal: g.signal,
        intent: g.intent,
        norm: g.norm,
        count: g.count,
        status: g.status || 'pending',
        note: g.note || '',
        signalText: SIGNAL_LABEL[g.signal] || g.signal || '其他',
        statusText: STATUS_LABEL[g.status] || '待处理',
        timeText: formatLocal(g.lastAt, 'short'),
        samples,
      }
    })
    // 排序：出现次数 × 严重权重，最痛的排最前
    all.sort((a, b) => {
      const wa = (SIGNAL_WEIGHT[a.signal] || 10) * a.count
      const wb = (SIGNAL_WEIGHT[b.signal] || 10) * b.count
      return wb - wa
    })
    const pendingCount = all.filter((g) => g.status === 'pending').length
    this.setData({ all, total: data.total || 0, pendingCount, loading: false }, () => this.applyFilter())
  },

  applyFilter() {
    const f = this.data.filter
    const groups = f === 'all' ? this.data.all : this.data.all.filter((g) => g.status === f)
    this.setData({ groups })
  },

  onFilter(e) {
    const k = e.currentTarget.dataset.key
    if (k === this.data.filter) return
    this.setData({ filter: k }, () => this.applyFilter())
  },

  toggleExpand(e) {
    const k = e.currentTarget.dataset.key
    const expanded = Object.assign({}, this.data.expanded)
    expanded[k] = !expanded[k]
    this.setData({ expanded })
  },

  // 状态机：整组标记（同一类说法只需要处理一次）
  async mark(e) {
    const idx = Number(e.currentTarget.dataset.idx)
    const status = e.currentTarget.dataset.status
    const g = this.data.groups[idx]
    if (!g) return
    if (status === 'fixed') {
      // 已修复：允许顺手写一句备注（记在组内，便于回溯当时怎么修的）
      const note = await this._askNote(g)
      if (note === null) return
      await this._doMark(g, status, note)
      return
    }
    await this._doMark(g, status, '')
  },

  async _doMark(g, status, note) {
    wx.showLoading({ title: '处理中' })
    try {
      const { error } = await aiFeedback.setStatus({ signal: g.signal, intent: g.intent, norm: g.norm || '' }, status, note)
      if (error) {
        wx.showToast({ title: error.message || '操作失败', icon: 'none' })
        return
      }
      wx.showToast({ title: STATUS_LABEL[status] || '已处理', icon: 'none' })
      await this.load()
    } finally {
      wx.hideLoading()
    }
  },

  _askNote(g) {
    return new Promise((resolve) => {
      wx.showModal({
        title: '标记为已修复',
        placeholderText: true,
        editable: true,
        content: g.note || '',
        confirmText: '确定',
        cancelText: '取消',
        success: (r) => {
          if (r.confirm) resolve(String(r.content || '').slice(0, 200))
          else resolve(null)
        },
        fail: () => resolve(null),
      })
    })
  },

  // 复制待处理清单：贴给开发/AI，一次批量修（原文 + AI 理解 + 用户改后答案）
  copyPending() {
    const list = this.data.all.filter((g) => g.status === 'pending')
    if (!list.length) { wx.showToast({ title: '没有待处理项', icon: 'none' }); return }
    const lines = ['【AI 管家反馈 · 待处理 ' + list.length + ' 类 / 合计 ' + list.reduce((s, g) => s + g.count, 0) + ' 次】']
    list.slice(0, 30).forEach((g, i) => {
      lines.push('')
      lines.push((i + 1) + '. [' + g.signalText + (g.intent ? '/' + g.intent : '') + '] ×' + g.count + ' 最近 ' + g.timeText)
      const s = g.samples[0] || {}
      if (s.question) lines.push('   用户说：' + s.question)
      if (s.reason) lines.push('   差异字段：' + s.reason)
      if (s.understood) lines.push('   AI 解析：' + s.understood)
      if (s.fixed) lines.push('   用户改后：' + s.fixed)
    })
    wx.setClipboardData({
      data: lines.join('\n'),
      success: () => wx.showToast({ title: '已复制待办清单', icon: 'none' }),
    })
  },
})
