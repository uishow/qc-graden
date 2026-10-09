const { cloud } = require('../../utils/cloud')
const store = require('../../utils/store')

const app = getApp()

Page({
  data: {
    theme: 'theme-a',
    rooms: [],
    adding: false,
    newName: '',
  },

  async onShow() {
    store.applyTheme(this)
    const session = await app.ready()
    if (!session) return
    await this.load()
  },

  async load() {
    const projectId = store.getCurrentProjectId()
    if (!projectId) return
    const { data } = await cloud.database
      .from('rooms').select('*').eq('project_id', projectId).order('sort_order')
    this.setData({ rooms: data || [] })
  },

  startAdd() {
    this.setData({ adding: true, newName: '' })
  },
  onAddInput(e) {
    this.setData({ newName: e.detail.value })
  },
  cancelAdd() {
    this.setData({ adding: false, newName: '' })
  },

  async confirmAdd() {
    const name = this.data.newName.trim()
    if (!name) {
      wx.showToast({ title: '请输入房间名称', icon: 'none' })
      return
    }
    const projectId = store.getCurrentProjectId()
    // 同名自动编号：次卧 → 次卧 (2) → 次卧 (3)，方便对应当前户型
    const names = this.data.rooms.map((r) => r.name)
    let finalName = name
    if (names.includes(name)) {
      let n = 2
      while (names.includes(`${name} (${n})`)) n++
      finalName = `${name} (${n})`
    }
    const maxOrder = this.data.rooms.reduce((m, r) => Math.max(m, r.sort_order || 0), 0)
    const { error } = await cloud.database
      .from('rooms')
      .insert({ project_id: projectId, name: finalName, sort_order: maxOrder + 1 })
    if (error) {
      wx.showToast({ title: '添加失败', icon: 'none' })
      return
    }
    wx.showToast({ title: finalName === name ? '已添加' : `已添加为「${finalName}」`, icon: 'none' })
    this.setData({ adding: false, newName: '' })
    await this.load()
  },

  async rename(e) {
    const id = e.currentTarget.dataset.id
    const room = this.data.rooms.find((r) => r.id === id)
    if (!room) return
    const res = await new Promise((resolve) =>
      wx.showModal({
        title: '重命名房间',
        editable: true,
        placeholderText: '房间名称',
        content: room.name,
        success: (r) => resolve(r.confirm ? (r.content || '').trim() : null),
      })
    )
    if (!res || res === room.name) return
    const { error } = await cloud.database
      .from('rooms').update({ name: res, updated_at: new Date().toISOString() }).eq('id', id).select()
    if (error) {
      wx.showToast({ title: '重命名失败', icon: 'none' })
      return
    }
    await this.load()
  },

  async remove(e) {
    const id = e.currentTarget.dataset.id
    const room = this.data.rooms.find((r) => r.id === id)
    if (!room) return
    const { confirm } = await new Promise((resolve) =>
      wx.showModal({
        title: '删除房间',
        content: `确定删除「${room.name}」？已记录的日记不会被删除，只是不再归入该房间。`,
        confirmText: '删除',
        success: (r) => resolve(r),
      })
    )
    if (!confirm) return
    const { error } = await cloud.database.from('rooms').remove().eq('id', id).select()
    if (error) {
      wx.showToast({ title: '删除失败', icon: 'none' })
      return
    }
    await this.load()
  },
})
