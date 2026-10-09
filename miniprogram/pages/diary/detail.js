const { cloud } = require('../../utils/cloud')
const store = require('../../utils/store')

Page({
  data: {
    theme: 'theme-a',
    diary: null,
    imageUrls: [],
    authorName: '',
    editorName: '',
  },

  async onLoad(options) {
    store.applyTheme(this)
    this.id = options.id
    await this.load()
  },

  async load() {
    const { data, error } = await cloud.database
      .from('diaries').select('*').eq('id', this.id).limit(1)
    if (error) {
      wx.showToast({ title: '日记加载失败', icon: 'none' })
      return
    }
    const diary = data && data[0]
    if (!diary) {
      wx.showToast({ title: '日记不存在', icon: 'none' })
      return
    }
    let imageUrls = []
    if (diary.image_paths && diary.image_paths.length) {
      const { data: urls } = await cloud.storage.createSignedUrls(diary.image_paths, 600)
      imageUrls = (urls || []).map((u) => u.signedUrl || u.signedURL || u.url || '')
    }
    const ids = [...new Set([diary.owner_id, diary.last_editor_id].filter(Boolean))]
    let nameMap = {}
    if (ids.length) {
      const { data: profiles } = await cloud.database
        .from('profiles').select('owner_id,nick_name').in('owner_id', ids)
      ;(profiles || []).forEach((p) => { nameMap[p.owner_id] = p.nick_name })
    }
    this.setData({
      diary,
      imageUrls,
      authorName: nameMap[diary.owner_id] || '家庭成员',
      editorName: diary.last_editor_id && diary.last_editor_id !== diary.owner_id
        ? (nameMap[diary.last_editor_id] || '家庭成员') : '',
    })
  },

  previewImage(e) {
    wx.previewImage({ current: e.currentTarget.dataset.url, urls: this.data.imageUrls })
  },

  goEdit() {
    wx.navigateTo({ url: `/pages/diary/edit?id=${this.id}` })
  },

  onDelete() {
    wx.showModal({
      title: '删除这篇日记？',
      content: '删除后将不再显示',
      confirmText: '删除',
      success: async (res) => {
        if (!res.confirm) return
        const { error } = await cloud.database
          .from('diaries')
          .update({ deleted: true, updated_at: new Date().toISOString() })
          .eq('id', this.id)
          .select()
        if (error) {
          wx.showToast({ title: '删除失败', icon: 'none' })
          return
        }
        wx.navigateBack()
      },
    })
  },
})
