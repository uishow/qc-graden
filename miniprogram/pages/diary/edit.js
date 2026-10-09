const { cloud } = require('../../utils/cloud')
const store = require('../../utils/store')
const { today } = require('../../utils/format')

Page({
  data: {
    theme: 'theme-a',
    id: null,
    baseVersion: 1,
    title: '',
    content: '',
    diaryDate: today(),
    rooms: [],
    roomIndex: -1,
    stages: [],
    stageIndex: -1,
    localImages: [],
    saving: false,
  },

  async onLoad(options) {
    store.applyTheme(this)
    const projectId = store.getCurrentProjectId()
    if (!projectId) {
      wx.showToast({ title: '请先创建项目', icon: 'none' })
      return
    }
    this.projectId = projectId
    const [{ data: rooms }, { data: stages }] = await Promise.all([
      cloud.database.from('rooms').select('id,name').eq('project_id', projectId).order('sort_order'),
      cloud.database.from('stages').select('id,name').eq('project_id', projectId).order('sort_order'),
    ])
    this.setData({ rooms: rooms || [], stages: stages || [] })

    if (options.id) {
      const { data } = await cloud.database
        .from('diaries').select('*').eq('id', options.id).limit(1)
      const d = data && data[0]
      if (d) {
        this.setData({
          id: d.id,
          baseVersion: d.version,
          title: d.title,
          content: d.content || '',
          diaryDate: d.diary_date,
          roomIndex: (this.data.rooms || []).findIndex((r) => r.id === d.room_id),
          stageIndex: (this.data.stages || []).findIndex((s) => s.id === d.stage_id),
        })
      }
    }
  },

  onInput(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value })
  },
  onDateChange(e) {
    this.setData({ diaryDate: e.detail.value })
  },
  onRoomChange(e) {
    this.setData({ roomIndex: Number(e.detail.value) })
  },
  onStageChange(e) {
    this.setData({ stageIndex: Number(e.detail.value) })
  },

  chooseImages() {
    wx.chooseMedia({
      count: 9 - this.data.localImages.length,
      mediaType: ['image'],
      success: (res) => {
        const paths = res.tempFiles.map((f) => f.tempFilePath)
        this.setData({ localImages: this.data.localImages.concat(paths) })
      },
    })
  },

  removeImage(e) {
    const i = e.currentTarget.dataset.index
    const list = this.data.localImages.slice()
    list.splice(i, 1)
    this.setData({ localImages: list })
  },

  async uploadImages() {
    const uploaded = []
    for (const path of this.data.localImages) {
      if (path.startsWith('cloud://')) {
        uploaded.push(path)
        continue
      }
      const ext = (path.match(/\.(\w+)$/) || [null, 'jpg'])[1]
      const cloudPath = `diary/${Date.now()}-${Math.floor(Math.random() * 1e6)}.${ext}`
      const res = await wx.cloud.uploadFile({ cloudPath, filePath: path })
      uploaded.push(res.fileID)
    }
    return uploaded
  },

  async onSave() {
    const { id, baseVersion, title, content, diaryDate, rooms, roomIndex, stages, stageIndex } = this.data
    if (!title.trim()) {
      wx.showToast({ title: '请填写标题', icon: 'none' })
      return
    }
    if (this.data.saving) return
    this.setData({ saving: true })
    try {
      const { user } = await cloud.auth.getSession()
      if (!user) throw new Error('未登录')
      const uid = user.id
      const imagePaths = await this.uploadImages()
      const now = new Date().toISOString()
      const payload = {
        title: title.trim(),
        content,
        diary_date: diaryDate,
        room_id: roomIndex >= 0 ? rooms[roomIndex].id : null,
        stage_id: stageIndex >= 0 ? stages[stageIndex].id : null,
        image_paths: imagePaths,
        last_editor_id: uid,
        updated_at: now,
      }

      if (id) {
        // 乐观锁：版本不符说明他人已改，提示后拉取最新
        const { data, error } = await cloud.database
          .from('diaries')
          .update({ ...payload, version: baseVersion + 1 })
          .eq('id', id)
          .eq('version', baseVersion)
          .select()
        if (error) throw error
        if (!data || data.length === 0) {
          wx.showModal({
            title: '内容已被他人修改',
            content: '你的版本未保存。请返回详情页查看最新版本后再编辑。',
            showCancel: false,
          })
          return
        }
        await cloud.database.from('revisions').insert({
          project_id: this.projectId, collection: 'diaries', doc_id: id,
          action: 'update', prev_version: baseVersion, new_version: baseVersion + 1,
          created_at: new Date().toISOString(),
        })
      } else {
        const { data, error } = await cloud.database
          .from('diaries')
          .insert({ ...payload, deleted: false, project_id: this.projectId })
          .select()
        if (error) throw error
        await cloud.database.from('revisions').insert({
          project_id: this.projectId, collection: 'diaries', doc_id: data[0].id,
          action: 'create', new_version: 1,
          created_at: new Date().toISOString(),
        })
      }
      wx.showToast({ title: '已保存' })
      setTimeout(() => wx.navigateBack(), 600)
    } catch (e) {
      wx.showToast({ title: e.message || '保存失败，请重试', icon: 'none' })
    } finally {
      this.setData({ saving: false })
    }
  },
})
