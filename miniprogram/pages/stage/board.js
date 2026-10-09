const { cloud } = require('../../utils/cloud')
const store = require('../../utils/store')
const { today, fen2yuan } = require('../../utils/format')

const app = getApp()

const STATUS_FLOW = { pending: 'doing', doing: 'done', done: 'pending' }
const STATUS_NAMES = { pending: '未开始', doing: '进行中', done: '已完成' }

// 手建阶段时，若名称命中标准预设（含全屋定制），写入规范 key，而非一律 'custom'
// —— 这样花费页「全屋定制」进度卡能正确识别。名称含「定制」二字也落 customhome。
const PRESET_KEY_BY_NAME = {
  '准备阶段': 'prepare',
  '设计阶段': 'design',
  '主体拆改': 'demolition',
  '水电改造': 'electric',
  '泥瓦工程': 'masonry',
  '木工工程': 'carpentry',
  '油漆工程': 'painting',
  '全屋定制': 'customhome',
  '安装阶段': 'install',
  '软装进场': 'soft',
  '入住准备': 'movein',
}
function resolveStageKey(name) {
  const n = (name || '').trim()
  if (PRESET_KEY_BY_NAME[n]) return PRESET_KEY_BY_NAME[n]
  for (const presetName of Object.keys(PRESET_KEY_BY_NAME)) {
    if (n.indexOf(presetName) !== -1) return PRESET_KEY_BY_NAME[presetName]
  }
  // 名称含「定制」二字（定制柜安装/整体定制橱柜…）也算全屋定制
  if (n.indexOf('定制') !== -1) return 'customhome'
  return 'custom'
}

Page({
  data: {
    theme: 'theme-a',
    stages: [],
    scope: '',
    title: '施工阶段',
  },

  onLoad(options) {
    // 从「花费-全屋定制」进入时带 scope=wholehouse，只看全屋定制相关阶段
    this.scope = (options && options.scope) || ''
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
    const [{ data: stageRows }, { data: expenses }, { data: materials }] = await Promise.all([
      cloud.database.from('stages').select('*').eq('project_id', projectId).order('sort_order'),
      cloud.database.from('expenses').select('id,amount,stage_id,type').eq('project_id', projectId).neq('deleted', true),
      cloud.database.from('materials').select('id,total_price,stage_id').eq('project_id', projectId),
    ])

    const wholehouseOnly = this.scope === 'wholehouse'
    let stages = (stageRows || []).map((s) => {
      const status = s.status || 'pending'
      return { ...s, status, statusName: STATUS_NAMES[status] }
    })
    if (wholehouseOnly) {
      // 只保留全屋定制相关阶段（key='customhome' 或名称含「全屋定制」）
      stages = stages.filter((s) => s.key === 'customhome' || (s.name || '').indexOf('全屋定制') !== -1)
    }

    // 每个阶段卡挂该阶段的花费/材料小计（轻量关联：只认带 stage_id 的）
    const expByStage = {}
    const matByStage = {}
    ;(expenses || []).forEach((e) => {
      // B 防重模型：材料类花费不手填，已由材料清单汇总，按阶段聚合时排除（仅防历史脏数据）
      if (e.stage_id && e.type !== 'material') expByStage[e.stage_id] = (expByStage[e.stage_id] || 0) + Number(e.amount || 0)
    })
    ;(materials || []).forEach((m) => {
      if (m.stage_id) matByStage[m.stage_id] = (matByStage[m.stage_id] || 0) + Number(m.total_price || 0)
    })
    stages = stages.map((s) => {
      const exp = expByStage[s.id] || 0
      const mat = matByStage[s.id] || 0
      return { ...s, expText: fen2yuan(exp), matText: fen2yuan(mat), hasCost: exp + mat > 0 }
    })

    this.setData({
      stages,
      scope: wholehouseOnly ? 'wholehouse' : '',
      title: wholehouseOnly ? '全屋定制 · 阶段' : '施工阶段',
    })
  },

  async advance(e) {
    const id = e.currentTarget.dataset.id
    const stage = this.data.stages.find((s) => s.id === id)
    if (!stage) return
    const next = STATUS_FLOW[stage.status]
    const patch = { status: next, updated_at: new Date().toISOString() }
    if (next === 'doing') patch.start_date = today()
    if (next === 'done') patch.end_date = today()
    if (next === 'pending') {
      patch.start_date = null
      patch.end_date = null
    }
    const { error } = await cloud.database
      .from('stages').update(patch).eq('id', id).select()
    if (error) {
      wx.showToast({ title: '更新失败', icon: 'none' })
      return
    }
    await this.load()
  },

  goRoom() {
    wx.navigateTo({ url: '/pages/room/manage' })
  },

  async addStage() {
    const wholehouseOnly = this.scope === 'wholehouse'
    const title = wholehouseOnly ? '添加全屋定制阶段' : '添加施工阶段'
    const placeholder = wholehouseOnly ? '如：橱柜安装 / 衣柜安装' : '如：定制柜安装'
    const name = await new Promise((resolve) =>
      wx.showModal({
        title,
        editable: true,
        placeholderText: placeholder,
        success: (r) => resolve(r.confirm ? (r.content || '').trim() : null),
      })
    )
    if (!name) return
    const projectId = store.getCurrentProjectId()
    const maxOrder = this.data.stages.reduce((m, s) => Math.max(m, s.sort_order || 0), 0)
    // 全屋定制入口下建的阶段，默认 key='customhome'，确保被「全屋定制」模块识别
    const key = wholehouseOnly ? 'customhome' : resolveStageKey(name)
    const { error } = await cloud.database
      .from('stages')
      .insert({ project_id: projectId, key, name, sort_order: maxOrder + 1, status: 'pending' })
    if (error) {
      wx.showToast({ title: '添加失败', icon: 'none' })
      return
    }
    await this.load()
  },

  async renameStage(e) {
    const id = e.currentTarget.dataset.id
    const stage = this.data.stages.find((s) => s.id === id)
    if (!stage) return
    const name = await new Promise((resolve) =>
      wx.showModal({
        title: '重命名阶段',
        editable: true,
        placeholderText: '阶段名称',
        content: stage.name,
        success: (r) => resolve(r.confirm ? (r.content || '').trim() : null),
      })
    )
    if (!name || name === stage.name) return
    const { error } = await cloud.database
      .from('stages').update({ name, updated_at: new Date().toISOString() }).eq('id', id).select()
    if (error) {
      wx.showToast({ title: '重命名失败', icon: 'none' })
      return
    }
    await this.load()
  },

  async removeStage(e) {
    const id = e.currentTarget.dataset.id
    const stage = this.data.stages.find((s) => s.id === id)
    if (!stage) return
    const { confirm } = await new Promise((resolve) =>
      wx.showModal({
        title: '删除阶段',
        content: `确定删除「${stage.name}」？已记录的日记不会被删除，只是不再归入该阶段。`,
        confirmText: '删除',
        success: (r) => resolve(r),
      })
    )
    if (!confirm) return
    const { error } = await cloud.database.from('stages').remove().eq('id', id).select()
    if (error) {
      wx.showToast({ title: '删除失败', icon: 'none' })
      return
    }
    await this.load()
  },
})
