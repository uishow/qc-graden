const { cloud } = require('../../utils/cloud')
const store = require('../../utils/store')

const app = getApp()

Page({
  data: {
    theme: 'theme-a',
    groups: [],
    empty: false,
    digestText: '',
    digestStats: '',
    digestTime: '',
    digestLoading: false,
  },

  async onShow() {
    store.applyTheme(this)
    store.applyTabBar(this, 1)
    const session = await app.ready()
    if (!session) return
    await this.load()
    this.restoreDigest() // 恢复本周已生成的进展（重编译/重进不丢）
    this.startWatch() // M3·L1 试点：日记时间线实时监听（真机验证 30s 双机可见）
  },

  onHide() {
    this.stopWatch() // 长连接随页面隐藏关闭，避免堆积
  },

  onUnload() {
    this.stopWatch()
  },

  // —— M3·L1 实时监听试点：CloudBase watch（运行时验证项）——
  // 直接用 wx.cloud 客户端 SDK（适配层不支持 watch）；读权限放宽为 true，登录用户可监听。
  startWatch() {
    this.stopWatch() // 项目可能已切换，先关旧监听
    if (!wx.cloud || typeof wx.cloud.database !== 'function') return
    const projectId = store.getCurrentProjectId()
    if (!projectId) return
    try {
      this._watcher = wx.cloud.database().collection('diaries')
        .where({ project_id: projectId })
        .watch({
          onChange: () => {
            if (!this._loading) this.load() // 拉取中触发则跳过，避免重入
          },
          onError: (e) => {
            console.warn('[watch] diaries 实时监听异常（不影响手动刷新）', e)
          },
        })
    } catch (e) {
      console.warn('[watch] 初始化失败（不影响手动刷新）', e)
    }
  },

  stopWatch() {
    if (this._watcher) {
      try { this._watcher.close() } catch (e) {}
      this._watcher = null
    }
  },

  async onPullDownRefresh() {
    await this.load()
    wx.stopPullDownRefresh()
  },

  async load() {
    this._loading = true
    try {
      const projectId = store.getCurrentProjectId()
      if (!projectId) {
        this.setData({ groups: [], empty: true })
        return
      }
      const { data, error } = await cloud.database
        .from('diaries')
        .select('id,title,content,diary_date,image_paths,room_id,stage_id')
        .eq('project_id', projectId)
        .neq('deleted', true)
        .order('diary_date', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(100)
      if (error) {
        wx.showToast({ title: '加载失败，请下拉重试', icon: 'none' })
        return
      }
      const map = {}
      ;(data || []).forEach((d) => {
        if (!map[d.diary_date]) map[d.diary_date] = []
        map[d.diary_date].push(d)
      })
      const groups = Object.keys(map)
        .sort()
        .reverse()
        .map((date) => ({
          date,
          items: map[date].map((d) => ({
            ...d,
            summary: (d.content || '').slice(0, 50),
            imageCount: (d.image_paths || []).length,
          })),
        }))
      this.setData({ groups, empty: groups.length === 0 })
    } finally {
      this._loading = false
    }
  },

  // —— V1.3 周报摘要（手动触发 + 本周本地缓存）——
  // 缓存 key 按项目 + 本周周一日期：跨周自动失效，重新编译/重进页面都能恢复显示。
  weekKey() {
    const d = new Date()
    const off = (d.getDay() + 6) % 7 // 周一为本周起点
    d.setDate(d.getDate() - off)
    const p = (n) => (n < 10 ? '0' + n : '' + n)
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
  },

  restoreDigest() {
    const projectId = store.getCurrentProjectId()
    if (!projectId) return
    try {
      const c = wx.getStorageSync('digest:' + projectId)
      if (c && c.week === this.weekKey() && c.text) {
        this.setData({ digestText: c.text, digestStats: c.stats || '', digestTime: c.time || '' })
      }
    } catch (e) { /* 缓存不可用则忽略 */ }
  },

  async genWeekly() {
    if (this.data.digestLoading) return
    const projectId = store.getCurrentProjectId()
    if (!projectId) {
      wx.showToast({ title: '请先在首页创建或选择项目', icon: 'none' })
      return
    }
    this.setData({ digestLoading: true })
    // showLoading/showToast 共用原生单例：hideLoading 必须在 showToast 之前
    let result = null
    try {
      const res = await wx.cloud.callFunction({ name: 'weeklyDigest', data: { projectId } })
      result = res && res.result
    } catch (e) {
      // errMsg 优先（含 timeout / not found 等真实原因），errCode 只是数字（如 -1 看不出原因）
      const ed = e || {}
      const detail = String(ed.errMsg || ed.errCode || ed.message || '').slice(0, 80)
      result = { ok: false, message: '调用失败：' + (detail || '网络异常') }
    } finally {
      this.setData({ digestLoading: false })
    }
    if (!result || !result.ok) {
      wx.showToast({ title: (result && result.message) || '生成失败，请重试', icon: 'none' })
      return
    }
    const d = new Date()
    const p = (n) => (n < 10 ? '0' + n : '' + n)
    const time = (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + p(d.getHours()) + ':' + p(d.getMinutes())
    this.setData({
      digestText: result.summary,
      digestStats: result.stats || '',
      digestTime: time,
    })
    try {
      wx.setStorageSync('digest:' + projectId, { week: this.weekKey(), text: result.summary, stats: result.stats || '', time })
    } catch (e) { /* 存不上就算了，只是缓存 */ }
    if (result.ai === false && result.aiError) {
      wx.showToast({ title: 'AI 未生成，已用统计兜底', icon: 'none' })
    }
  },

  closeDigest() {
    this.setData({ digestText: '', digestTime: '' })
    // 「收起」= 明确不想看，缓存一并清掉，避免重编译后又冒出来
    try { wx.removeStorageSync('digest:' + store.getCurrentProjectId()) } catch (e) {}
  },

  goDetail(e) {
    wx.navigateTo({ url: `/pages/diary/detail?id=${e.currentTarget.dataset.id}` })
  },
  goEdit() {
    wx.navigateTo({ url: '/pages/diary/edit' })
  },
})
