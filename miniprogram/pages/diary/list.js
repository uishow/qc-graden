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
  },

  async onPullDownRefresh() {
    await this.load()
    wx.stopPullDownRefresh()
  },

  async load() {
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
  },

  goDetail(e) {
    wx.navigateTo({ url: `/pages/diary/detail?id=${e.currentTarget.dataset.id}` })
  },
  goEdit() {
    wx.navigateTo({ url: '/pages/diary/edit' })
  },
})
