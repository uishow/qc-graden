const { cloud } = require('../../utils/cloud')
const store = require('../../utils/store')
const { today } = require('../../utils/format')
const write = require('../../utils/write')
const { joinNames, normalizeIds } = require('../../utils/arrayId')

// 订阅消息模板：家人新日记提醒（后台公共模板，字段 thing1作者/thing2内容/time3时间/thing5备注）
const SUBSCRIBE_TMPL_ID = 'd7KlYUn-ZiAtiSr3kuRkiD2qYbYygi0T_6kLxYTMMTk'

Page({
  data: {
    theme: 'theme-a',
    id: null,
    baseVersion: 1,
    title: '',
    content: '',
    diaryDate: today(),
    rooms: [],
    stages: [],
    // 多选 state：roomIds/stageIdsSelected 是「已确认」选中 id 数组；*Checked 是弹窗里每项临时勾选状态
    roomIds: [], // string[] 选中房间 id
    stageIdsSelected: [], // string[] 选中阶段 id
    roomChecked: [], // boolean[] 弹窗中房间勾选状态
    stageChecked: [], // boolean[] 弹窗中阶段勾选状态
    roomText: '', // 触发器上展示文本（4 房间/主卧、次卧等）
    stageText: '',
    showRoomPicker: false,
    showStagePicker: false,
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
    const roomsArr = rooms || []
    const stagesArr = stages || []
    // 兼容旧数据：取多选数组，没有则从单字段构造
    this._roomsArr = roomsArr
    this._stagesArr = stagesArr
    this.setData({ rooms: roomsArr, stages: stagesArr })

    if (options.id) {
      const { data } = await cloud.database
        .from('diaries').select('*').eq('id', options.id).limit(1)
      const d = data && data[0]
      if (d) {
        const initRoomIds = normalizeIds(d.room_ids, d.room_id)
        const initStageIds = normalizeIds(d.stage_ids, d.stage_id)
        this.setData({
          id: d.id,
          baseVersion: d.version,
          title: d.title,
          content: d.content || '',
          diaryDate: d.diary_date,
          roomIds: initRoomIds,
          stageIdsSelected: initStageIds,
          roomText: joinNames(initRoomIds, this.data.rooms),
          stageText: joinNames(initStageIds, this.data.stages),
        })
      }
    } else {
      // AI 周报草稿：仅新建模式预填（「记一篇 → AI 帮我写本周进展」传入），读后即删
      try {
        const draft = wx.getStorageSync('weeklyDraft:' + projectId)
        if (draft && draft.title) {
          this.setData({ title: draft.title, content: draft.content || '' })
          wx.removeStorageSync('weeklyDraft:' + projectId)
        }
      } catch (e) { /* 无草稿或存储不可用，正常空白新建 */ }
    }
  },

  onInput(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value })
  },
  onDateChange(e) {
    this.setData({ diaryDate: e.detail.value })
  },

  // —— 房间多选弹窗 ——
  openRoomPicker() {
    this.setBarHidden(true)
    const checked = (this.data.rooms || []).map((r) => this.data.roomIds.indexOf(r.id) !== -1)
    this.setData({ showRoomPicker: true, roomChecked: checked })
  },
  toggleRoom(e) {
    const i = Number(e.currentTarget.dataset.index)
    const arr = (this.data.roomChecked || []).slice()
    arr[i] = !arr[i]
    this.setData({ roomChecked: arr })
  },
  cancelRoomPicker() {
    this.setBarHidden(false)
    this.setData({ showRoomPicker: false })
  },
  confirmRoomPicker() {
    const ids = []
    ;(this.data.roomChecked || []).forEach((on, i) => { if (on && this.data.rooms[i]) ids.push(this.data.rooms[i].id) })
    this.setData({
      roomIds: ids,
      roomText: joinNames(ids, this.data.rooms),
      showRoomPicker: false,
    })
    this.setBarHidden(false)
  },

  // —— 阶段多选弹窗 ——
  openStagePicker() {
    this.setBarHidden(true)
    const checked = (this.data.stages || []).map((s) => this.data.stageIdsSelected.indexOf(s.id) !== -1)
    this.setData({ showStagePicker: true, stageChecked: checked })
  },
  toggleStage(e) {
    const i = Number(e.currentTarget.dataset.index)
    const arr = (this.data.stageChecked || []).slice()
    arr[i] = !arr[i]
    this.setData({ stageChecked: arr })
  },
  cancelStagePicker() {
    this.setBarHidden(false)
    this.setData({ showStagePicker: false })
  },
  confirmStagePicker() {
    const ids = []
    ;(this.data.stageChecked || []).forEach((on, i) => { if (on && this.data.stages[i]) ids.push(this.data.stages[i].id) })
    this.setData({
      stageIdsSelected: ids,
      stageText: joinNames(ids, this.data.stages),
      showStagePicker: false,
    })
    this.setBarHidden(false)
  },

  noop() {},
  // 弹窗打开期间隐藏自定义 tabBar：其框架包装层层级高于页面 fixed 弹窗，会盖住底部按钮
  setBarHidden(hidden) {
    const bar = this.getTabBar && this.getTabBar()
    if (bar) bar.setData({ hidden: !!hidden })
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
    const { id, baseVersion, title, content, diaryDate, roomIds, stageIdsSelected } = this.data
    if (!title.trim()) {
      wx.showToast({ title: '请填写标题', icon: 'none' })
      return
    }
    // 新建日记时顺手请求订阅授权（一次性订阅：授权一次=可收一条提醒）。
    // 必须在 tap 同步链路里调用；用户选「总是允许」后不再弹，拒绝也不影响保存。
    if (!id && wx.requestSubscribeMessage) {
      wx.requestSubscribeMessage({ tmplIds: [SUBSCRIBE_TMPL_ID] })
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
        // 新字段（多选）+ 旧单值字段（主值，取首项；老读取端/汇总处仍能用）
        room_ids: roomIds,
        stage_ids: stageIdsSelected,
        room_id: roomIds[0] || '',
        stage_id: stageIdsSelected[0] || '',
        image_paths: imagePaths,
        last_editor_id: uid,
        created_at: now,
        updated_at: now,
      }

      if (id) {
        // 乐观锁：版本不符说明他人已改，提示后拉取最新
        const { data, error } = await write.update('diaries', this.projectId, id, { ...payload, version: baseVersion + 1 }, baseVersion)
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
        const { data, error } = await write.insert('diaries', this.projectId, { ...payload, deleted: false, project_id: this.projectId, version: 1 })
        if (error) throw error
        await cloud.database.from('revisions').insert({
          project_id: this.projectId, collection: 'diaries', doc_id: data[0].id,
          action: 'create', new_version: 1,
          created_at: new Date().toISOString(),
        })
        // 触发式通知其他成员（未订阅/发送失败均静默，不影响保存流程）
        wx.cloud.callFunction({ name: 'notifyDiary', data: { diaryId: data[0].id } })
          .then(() => {})
          .catch(() => {})
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
