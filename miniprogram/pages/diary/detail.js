const { cloud } = require('../../utils/cloud')
const store = require('../../utils/store')
const write = require('../../utils/write')

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
    let attachTip = ''
    if (diary.image_paths && diary.image_paths.length) {
      const { data: urls, error: urlErr } = await cloud.storage.createSignedUrls(diary.image_paths, 600)
      imageUrls = (urls || []).map((u) => u.signedUrl || u.signedURL || u.url || '').filter(Boolean)
      // 「列表显示有附件、详情却一张都没有」= 库里有 fileID 但云存储取不到（上传时网络抖动留下坏引用、
      // 或文件被删）。旧实现静默显示空白，用户只能猜；现在明确说清并给出动作。（2026-10-15 实测）
      if (!imageUrls.length) {
        const n = diary.image_paths.length
        attachTip = `这篇日记记了 ${n} 个附件，但都打不开（${(urlErr && urlErr.message) || '文件不存在或无权限'}）。请在编辑页删除后重新上传。`
      } else if (imageUrls.length < diary.image_paths.length) {
        attachTip = `有 ${diary.image_paths.length - imageUrls.length} 个附件打不开，可重新上传。`
      }
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
      attachTip,
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
        const { error } = await write.update('diaries', store.getCurrentProjectId(), this.id, {
          deleted: true,
          updated_at: new Date().toISOString(),
        })
        if (error) {
          wx.showToast({ title: '删除失败', icon: 'none' })
          return
        }
        wx.navigateBack()
      },
    })
  },
})
