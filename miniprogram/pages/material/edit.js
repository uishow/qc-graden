const { cloud } = require('../../utils/cloud')
const store = require('../../utils/store')
const { yuan2fen, fen2yuan } = require('../../utils/format')
const { BELONG_WHOLEHOUSE, WHOLEHOUSE_SUBS } = require('../../utils/wholehouse')
const att = require('../../utils/attachment')
const write = require('../../utils/write')

const CATEGORIES = ['主材', '辅材', '家具', '家电', '软装']
const STATUS = ['to_buy', 'bought', 'on_site']
const STATUS_NAMES = { to_buy: '待购买', bought: '已购买', on_site: '已进场' }
const BELONG_NAMES = ['无归属', '全屋定制']
const SUB_NAMES = ['未分类'].concat(WHOLEHOUSE_SUBS)

Page({
  data: {
    theme: 'theme-a',
    id: null,
    baseVersion: 1,
    name: '',
    categoryIndex: 0,
    categories: CATEGORIES,
    brand: '',
    spec: '',
    quantity: '1',
    unit: '',
    unitPrice: '',
    statusIndex: 0,
    statusNames: STATUS.map((s) => STATUS_NAMES[s]),
    belongIndex: 0,
    belongNames: BELONG_NAMES,
    subIndex: 0,
    subNames: SUB_NAMES,
    stageIndex: 0,
    stageNames: ['不关联（通用）'],
    stageIds: [''],
    remark: '',
    attachments: [], // [{fileID, name, kind:'image'|'file'}] 附件凭证（报价单/效果图等）
    revisions: [], // 修改历史（revisions，只读展示）
    saving: false,
  },

  async onLoad(options) {
    store.applyTheme(this)
    this.projectId = store.getCurrentProjectId()
    // 从「花费-全屋定制」入口进入时预选归属
    if (options.belong === BELONG_WHOLEHOUSE) this.setData({ belongIndex: 1 })
    await this.loadStages()
    if (options.id) {
      const { data } = await cloud.database
        .from('materials').select('*').eq('id', options.id).limit(1)
      const d = data && data[0]
      if (d) {
        const stageIndex = this.data.stageIds.indexOf(d.stage_id || '')
        this.setData({
          id: d.id,
          baseVersion: d.version,
          name: d.name,
          categoryIndex: Math.max(0, CATEGORIES.indexOf(d.category)),
          brand: d.brand || '',
          spec: d.spec || '',
          quantity: String(d.quantity || 1),
          unit: d.unit || '',
          unitPrice: d.unit_price ? fen2yuan(d.unit_price, false) : '',
          statusIndex: Math.max(0, STATUS.indexOf(d.status)),
          belongIndex: d.belong === BELONG_WHOLEHOUSE ? 1 : 0,
          subIndex: Math.max(0, SUB_NAMES.indexOf(d.sub || '未分类')),
          stageIndex: stageIndex >= 0 ? stageIndex : 0,
          remark: d.remark || '',
          attachments: att.normalizeList(d.attachments),
        })
      }
      this.loadRevisions(options.id, 'materials')
    }
  },

  // 修改历史：读本条的 revisions（安全规则按创建者隔离，看到的是本人操作痕迹）
  async loadRevisions(docId, collection) {
    const { data } = await cloud.database
      .from('revisions').select('action,prev_version,new_version,created_at')
      .eq('doc_id', docId).eq('collection', collection)
      .order('created_at', { ascending: false }).limit(20)
    this.setData({
      revisions: (data || []).map((r) => ({
        timeText: String(r.created_at || '').slice(0, 16).replace('T', ' ') || '—',
        actionText: r.action === 'update' ? '修改' : r.action === 'create' ? '创建' : (r.action || '操作'),
        newVersion: r.new_version || '',
      })),
    })
  },

  // 加载本项目阶段，供「所属阶段」可选关联（轻量关联：不强制）
  async loadStages() {
    const pid = store.getCurrentProjectId()
    const { data } = await cloud.database
      .from('stages').select('id,name').eq('project_id', pid).order('sort_order')
    const rows = data || []
    this.setData({
      stageNames: ['不关联（通用）'].concat(rows.map((s) => s.name)),
      stageIds: [''].concat(rows.map((s) => s.id)),
    })
  },

  onInput(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value })
  },
  onCategoryChange(e) {
    this.setData({ categoryIndex: Number(e.detail.value) })
  },
  onStatusChange(e) {
    this.setData({ statusIndex: Number(e.detail.value) })
  },
  onBelongChange(e) {
    const i = Number(e.detail.value)
    // 取消全屋定制归属时一并清空子类，避免残留
    this.setData({ belongIndex: i, subIndex: i === 1 ? this.data.subIndex : 0 })
  },
  onSubChange(e) {
    this.setData({ subIndex: Number(e.detail.value) })
  },
  onStageChange(e) {
    this.setData({ stageIndex: Number(e.detail.value) })
  },

  // —— 附件凭证：图片（拍照/相册）+ 微信聊天文件，传云存储，随保存写入 attachments ——
  async addAttachment() {
    const picked = await att.choose(this.data.attachments.length)
    if (!picked.length) return
    wx.showLoading({ title: '上传中…', mask: true })
    try {
      const uploaded = await att.upload(picked, 'materials')
      this.setData({ attachments: this.data.attachments.concat(uploaded) })
    } catch (e) {
      wx.showToast({ title: '上传失败，请重试', icon: 'none' })
    } finally {
      wx.hideLoading()
    }
  },

  removeAttachment(e) {
    const i = Number(e.currentTarget.dataset.index)
    const list = this.data.attachments.slice()
    list.splice(i, 1)
    this.setData({ attachments: list }) // 仅移除引用，云存储文件保留（软删可追溯）
  },

  async previewAttachment(e) {
    const a = this.data.attachments[Number(e.currentTarget.dataset.index)]
    if (!a) return
    if (a.kind === 'image') {
      const fileIDs = this.data.attachments.filter((x) => x.kind === 'image').map((x) => x.fileID)
      await att.previewImages(fileIDs, a.fileID)
    } else {
      await att.openFile(a.fileID, a.name)
    }
  },

  async onSave() {
    const d = this.data
    if (!d.name.trim()) {
      wx.showToast({ title: '请填写材料名称', icon: 'none' })
      return
    }
    if (d.saving) return
    this.setData({ saving: true })
    try {
      const quantity = Number(d.quantity) || 1
      const unitPrice = yuan2fen(d.unitPrice)
      const payload = {
        name: d.name.trim(),
        category: CATEGORIES[d.categoryIndex],
        brand: d.brand.trim(),
        spec: d.spec.trim(),
        quantity,
        unit: d.unit.trim(),
        unit_price: unitPrice,
        total_price: Math.round(quantity * unitPrice),
        status: STATUS[d.statusIndex],
        belong: d.belongIndex === 1 ? BELONG_WHOLEHOUSE : '',
        sub: d.belongIndex === 1 && d.subIndex > 0 ? SUB_NAMES[d.subIndex] : '',
        stage_id: d.stageIds[d.stageIndex] || '',
        remark: d.remark.trim(),
        attachments: d.attachments,
        updated_at: new Date().toISOString(),
      }
      if (d.id) {
        // 老数据可能没有 version 字段：仅当确有版本号时才加乐观锁校验，否则按 id 直接更新，避免编辑失败
        const baseVersion = d.baseVersion || 1
        const { data, error } = await write.update('materials', this.projectId, d.id, { ...payload, version: baseVersion + 1 }, d.baseVersion)
        if (error) throw error
        if (!data || data.length === 0) {
          wx.showModal({ title: '记录已被他人修改', content: '请返回查看最新版本后再编辑。', showCancel: false })
          return
        }
        // 追加修改历史（写入失败不影响已保存的数据）；适配层 insert 不自动补时间戳，必须显式带 created_at
        try {
          await cloud.database.from('revisions').insert({
            project_id: this.projectId, collection: 'materials', doc_id: d.id,
            action: 'update', prev_version: baseVersion, new_version: baseVersion + 1,
            created_at: new Date().toISOString(),
          })
        } catch (e2) {}
      } else {
        const { error } = await write.insert('materials', this.projectId, { ...payload, version: 1, created_at: new Date().toISOString(), project_id: this.projectId })
        if (error) throw error
      }
      wx.showToast({ title: '已保存' })
      setTimeout(() => wx.navigateBack(), 600)
    } catch (e) {
      wx.showToast({ title: e.message || '保存失败', icon: 'none' })
    } finally {
      this.setData({ saving: false })
    }
  },
})
