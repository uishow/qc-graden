const { cloud } = require('../../utils/cloud')
const store = require('../../utils/store')
const { yuan2fen, fen2yuan, today } = require('../../utils/format')
const { BELONG_WHOLEHOUSE } = require('../../utils/wholehouse')
const att = require('../../utils/attachment')

// B 防重模型：花费类目不再含「材料」，材料支出统一在「材料清单」登记、自动计入预算，
// 结构上杜绝与材料清单重复。可手填类目为 人工 / 设计 / 其他 / 订金·定金。
const TYPES = ['labor', 'design', 'deposit', 'other']
const TYPE_NAMES = { material: '材料', labor: '人工', design: '设计', other: '其他', deposit: '订金/定金' }
const BELONG_NAMES = ['无归属', '全屋定制']

// 文本交集：较短串的任意连续 2 字片段出现在另一串中即视为相似（中文无分词，滑窗够用）
function textOverlap(a, b) {
  const s = String(a || '').trim()
  const t = String(b || '').trim()
  if (s.length < 2 || t.length < 2) return false
  const [shortStr, longStr] = s.length <= t.length ? [s, t] : [t, s]
  for (let i = 0; i + 2 <= shortStr.length; i++) {
    if (longStr.indexOf(shortStr.slice(i, i + 2)) !== -1) return true
  }
  return false
}

Page({
  data: {
    theme: 'theme-a',
    id: null,
    baseVersion: 1,
    amount: '',
    typeIndex: 0,
    typeNames: TYPES.map((t) => TYPE_NAMES[t]),
    belongIndex: 0,
    belongNames: BELONG_NAMES,
    stageIndex: 0,
    stageNames: ['不关联（通用）'],
    stageIds: [''],
    payDate: today(),
    remark: '',
    attachments: [], // [{fileID, name, kind:'image'|'file'}] 附件凭证
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
      const { data, error } = await cloud.database
        .from('expenses').select('*').eq('id', options.id).limit(1)
      if (error) {
        wx.showToast({ title: '记录加载失败', icon: 'none' })
        return
      }
      const d = data && data[0]
      if (d) {
        const stageIndex = this.data.stageIds.indexOf(d.stage_id || '')
        this.setData({
          id: d.id,
          baseVersion: d.version,
          amount: fen2yuan(d.amount, false),
          typeIndex: Math.max(0, TYPES.indexOf(d.type)),
          belongIndex: d.belong === BELONG_WHOLEHOUSE ? 1 : 0,
          stageIndex: stageIndex >= 0 ? stageIndex : 0,
          payDate: d.pay_date,
          remark: d.remark || '',
          attachments: att.normalizeList(d.attachments),
        })
      }
      this.loadRevisions(options.id, 'expenses')
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
        timeText: String(r.created_at || '').slice(0, 16).replace('T', ' '),
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
  onTypeChange(e) {
    this.setData({ typeIndex: Number(e.detail.value) })
  },
  onBelongChange(e) {
    this.setData({ belongIndex: Number(e.detail.value) })
  },
  onStageChange(e) {
    this.setData({ stageIndex: Number(e.detail.value) })
  },
  onDateChange(e) {
    this.setData({ payDate: e.detail.value })
  },

  // —— 附件凭证：图片（拍照/相册）+ 微信聊天文件，传云存储，随保存写入 attachments ——
  async addAttachment() {
    const picked = await att.choose(this.data.attachments.length)
    if (!picked.length) return
    wx.showLoading({ title: '上传中…', mask: true })
    try {
      const uploaded = await att.upload(picked, 'expenses')
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

  // 保存前防重提示（C 兜底）：B 防重模型堵住了「手动录材料类花费」的入口，
  // 但堵不住换类目重复录同一笔钱（如材料已计「已购买」，又把这笔钱录成人工费）。
  // 金额与某材料完全一致且描述有交集时提醒，确认后仍可保存——只提示不拦截。
  async findDupMaterial(fen, remark) {
    const text = String(remark || '').trim()
    if (!text || !fen || !this.projectId) return null
    const { data } = await cloud.database
      .from('materials').select('name,remark,total_price,status').eq('project_id', this.projectId)
    const rows = data || []
    return rows.find((m) => Number(m.total_price) === fen && textOverlap(text, (m.name || '') + ' ' + (m.remark || ''))) || null
  },

  async onSave() {
    const { id, baseVersion, amount, typeIndex, belongIndex, stageIndex, payDate, remark } = this.data
    const fen = yuan2fen(amount)
    if (fen <= 0) {
      wx.showToast({ title: '请填写金额', icon: 'none' })
      return
    }
    if (this.data.saving) return
    const dupMat = await this.findDupMaterial(fen, remark)
    if (dupMat) {
      const statusName = dupMat.status === 'bought' ? '已购买' : dupMat.status === 'on_site' ? '已进场' : '待购买'
      const { confirm } = await new Promise((resolve) =>
        wx.showModal({
          title: '可能重复计入',
          content: `金额 ${fen2yuan(fen)} 元与材料「${dupMat.name || '未命名'}」（${statusName}）一致且描述相似，这笔钱可能已计入预算。仍要保存？`,
          confirmText: '仍要保存',
          success: (r) => resolve(r),
        })
      )
      if (!confirm) return
    }
    this.setData({ saving: true })
    try {
      const now = new Date().toISOString()
      const payload = {
        type: TYPES[typeIndex],
        amount: fen,
        belong: belongIndex === 1 ? BELONG_WHOLEHOUSE : '',
        stage_id: this.data.stageIds[stageIndex] || '',
        pay_date: payDate,
        remark: remark.trim(),
        attachments: this.data.attachments,
        updated_at: now,
      }
      if (id) {
        // 老数据可能没有 version 字段：仅当确有版本号时才加乐观锁校验，否则按 id 直接更新，避免编辑失败
        const ver = baseVersion || 1
        let q = cloud.database
          .from('expenses').update({ ...payload, version: ver + 1 })
          .eq('id', id)
        if (baseVersion) q = q.eq('version', baseVersion)
        const { data, error } = await q.select()
        if (error) throw error
        if (!data || data.length === 0) {
          wx.showModal({ title: '记录已被他人修改', content: '请返回查看最新版本后再编辑。', showCancel: false })
          return
        }
        // 追加修改历史（写入失败不影响已保存的数据）
        try {
          await cloud.database.from('revisions').insert({
            project_id: this.projectId, collection: 'expenses', doc_id: id,
            action: 'update', prev_version: baseVersion || 1, new_version: (baseVersion || 1) + 1,
          })
        } catch (e2) {}
      } else {
        const { error } = await cloud.database
          .from('expenses').insert({ ...payload, version: 1, created_at: new Date().toISOString(), deleted: false, project_id: this.projectId })
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
