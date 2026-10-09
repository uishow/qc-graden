const { cloud } = require('../../utils/cloud')
const store = require('../../utils/store')

const app = getApp()

Page({
  data: {
    theme: 'theme-a',
    groups: [],
    empty: false,
  },

  async onShow() {
    store.applyTheme(this)
    store.applyTabBar(this, 1)
    const session = await app.ready()
    if (!session) return
    await this.load()
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

  // —— V1.3 周报：融入「记一篇」。AI 生成后作为日记草稿进编辑页，可改可存，存了即时间线一篇日记 ——
  goAdd() {
    const projectId = store.getCurrentProjectId()
    if (!projectId) {
      wx.showToast({ title: '请先在首页创建或选择项目', icon: 'none' })
      return
    }
    wx.showActionSheet({
      itemList: ['✍️ 自己写', '🤖 AI 帮我写本周进展'],
      success: (res) => {
        if (res.tapIndex === 0) this.goEdit()
        else this.genWeeklyDraft(projectId)
      },
    })
  },

  weekRangeText() {
    const p = (n) => (n < 10 ? '0' + n : '' + n)
    const fmt = (d) => (d.getMonth() + 1) + '.' + p(d.getDate())
    const start = new Date()
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7)) // 本周一
    const end = new Date(start)
    end.setDate(start.getDate() + 6) // 本周日
    return fmt(start) + '-' + fmt(end)
  },

  async genWeeklyDraft(projectId) {
    wx.showLoading({ title: 'AI 生成中…', mask: true })
    let result = null
    try {
      const res = await wx.cloud.callFunction({ name: 'weeklyDigest', data: { projectId } })
      result = res && res.result
    } catch (e) {
      // errMsg 优先（含 timeout / not found 等真实原因），errCode 只是数字（如 -1 看不出原因）
      const ed = e || {}
      const detail = String(ed.errMsg || ed.errCode || ed.message || '').slice(0, 80)
      result = { ok: false, message: '调用失败：' + (detail || '网络异常') }
    }
    // showLoading/showToast 共用原生单例：先 hideLoading 再 toast
    wx.hideLoading()
    if (!result || !result.ok) {
      wx.showToast({ title: (result && result.message) || '生成失败，请重试', icon: 'none' })
      return
    }
    const content = [result.summary, result.stats].filter(Boolean).join('\n\n')
    try {
      // 草稿经storage传给编辑页（navigateTo 不便带长文本参数），编辑页预填后立即消费
      wx.setStorageSync('weeklyDraft:' + projectId, {
        title: '本周进展 ' + this.weekRangeText(),
        content,
      })
    } catch (e2) { /* 存不上则编辑页拿不到预填，仍可手写 */ }
    if (result.ai === false && result.aiError) {
      wx.showToast({ title: 'AI 暂不可用，已用统计兜底', icon: 'none' })
    }
    wx.navigateTo({ url: '/pages/diary/edit' })
  },

  goDetail(e) {
    wx.navigateTo({ url: `/pages/diary/detail?id=${e.currentTarget.dataset.id}` })
  },
  goEdit() {
    wx.navigateTo({ url: '/pages/diary/edit' })
  },
})
