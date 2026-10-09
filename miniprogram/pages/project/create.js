const { cloud } = require('../../utils/cloud')
const store = require('../../utils/store')
const { yuan2fen, today } = require('../../utils/format')

const PRESET_STAGES = [
  { key: 'prepare', name: '准备阶段' },
  { key: 'design', name: '设计阶段' },
  { key: 'demolition', name: '主体拆改' },
  { key: 'electric', name: '水电改造' },
  { key: 'masonry', name: '泥瓦工程' },
  { key: 'carpentry', name: '木工工程' },
  { key: 'painting', name: '油漆工程' },
  { key: 'install', name: '安装阶段' },
  { key: 'soft', name: '软装进场' },
  { key: 'movein', name: '入住准备' },
]
// 常用户型快捷选项（点一下填入「户型」）
const HOUSE_TYPE_PRESETS = ['一室一厅', '两室一厅', '两室两厅', '三室两厅', '三室两厅两卫', '四室两厅两卫']

// 中文/全角数字 → 阿拉伯数字（户型里的「三室两厅」等）
function normalizeNumerals(s) {
  const map = { '零': '0', '一': '1', '二': '2', '两': '2', '三': '3', '四': '4', '五': '5', '六': '6', '七': '7', '八': '8', '九': '9', '十': '10' }
  return String(s)
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 65248))
    .replace(/[零一二两三四五六七八九十]/g, (c) => map[c])
}

// 取「数字 + 关键字」的计数；未出现返回 0。cls 为字符类，如 '室房居'
function extractCount(s, cls) {
  const m = s.match(new RegExp('(\\d+)\\s*[' + cls + ']'))
  return m ? parseInt(m[1], 10) : 0
}

// 生成 6 位数字邀请码（family / member 两种码各自独立、互不相等）
function genInviteCode() {
  return String(Math.floor(100000 + Math.random() * 900000))
}
function genInviteCodePair() {
  let family = genInviteCode()
  let member = genInviteCode()
  let guard = 0
  while (member === family && guard < 20) {
    member = genInviteCode()
    guard++
  }
  return { invite_code_family: family, invite_code_member: member }
}

// 同名房间按序号顺延：次卧 → 次卧 (2) → 次卧 (3)（与房间管理页编号规则一致）
function dedupeNumber(names) {
  const seen = {}
  return names.map((n) => {
    seen[n] = (seen[n] || 0) + 1
    return seen[n] === 1 ? n : `${n} (${seen[n]})`
  })
}

// 户型是否可解析（含「数字 + 室/房/居/厅/卫」）
function isParseableHouseType(houseType) {
  const raw = String(houseType || '').trim()
  if (!raw) return false
  return /\d\s*[室房居厅卫]/.test(normalizeNumerals(raw))
}

// 按户型文本生成房间名；留空或无法识别时返回空数组（不建房，用户可稍后在「房间管理」添加）
// 规则：室→第1间主卧其余次卧；厅→1厅客厅、≥2厅客厅+餐厅；卫→卫生间×N；厨房/阳台默认各1
function parseHouseTypeToRooms(houseType) {
  const raw = String(houseType || '').trim()
  if (!isParseableHouseType(raw)) return []
  const s = normalizeNumerals(raw)

  const bedrooms = extractCount(s, '室房居') || 1
  const halls = extractCount(s, '厅') || 1
  const baths = extractCount(s, '卫') || 1
  const kitchens = extractCount(s, '厨') || 1
  const balconies = extractCount(s, '阳台') || 1

  const names = ['客厅']
  if (halls >= 2) names.push('餐厅')
  for (let i = 0; i < bedrooms; i++) names.push(i === 0 ? '主卧' : '次卧')
  for (let i = 0; i < kitchens; i++) names.push('厨房')
  for (let i = 0; i < baths; i++) names.push('卫生间')
  for (let i = 0; i < balconies; i++) names.push('阳台')
  return dedupeNumber(names)
}

Page({
  data: {
    theme: 'theme-a',
    name: '',
    houseType: '',
    houseTypePresets: HOUSE_TYPE_PRESETS,
    area: '',
    budget: '',
    startDate: today(),
    saving: false,
  },

  onShow() {
    store.applyTheme(this)
  },

  onInput(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value })
  },
  pickHouseType(e) {
    this.setData({ houseType: e.currentTarget.dataset.val })
  },
  onDateChange(e) {
    this.setData({ startDate: e.detail.value })
  },

  async onSave() {
    const { name, houseType, area, budget, startDate } = this.data
    if (!name.trim()) {
      wx.showToast({ title: '请填写项目名称', icon: 'none' })
      return
    }
    if (this.data.saving) return

    // 按户型解析房间，并在创建前预览确认（取消则不创建，避免解析不准时直接落库）
    const parsed = isParseableHouseType(houseType)
    const roomNames = parseHouseTypeToRooms(houseType)
    const content = parsed
      ? `按户型「${houseType.trim()}」生成房间：\n\n${roomNames.join('、')}\n\n共 ${roomNames.length} 间，确认创建项目？`
      : '未填写或未识别户型，将不自动创建房间（可稍后在「房间管理」中添加）。\n\n确认创建项目？'
    const ok = await new Promise((resolve) =>
      wx.showModal({
        title: '确认房间',
        content,
        confirmText: '创建',
        cancelText: '取消',
        success: (r) => resolve(!!r.confirm),
      })
    )
    if (!ok) return

    this.setData({ saving: true })
    try {
      const { user } = await cloud.auth.getSession()
      if (!user) throw new Error('未登录')
      const uid = user.id

      const codes = genInviteCodePair()
      const { data: created, error } = await cloud.database
        .from('projects')
        .insert({
          name: name.trim(),
          house_type: houseType.trim(),
          area: Number(area) || null,
          budget: yuan2fen(budget),
          start_date: startDate,
          status: 'in_progress',
          invite_code_family: codes.invite_code_family,
          invite_code_member: codes.invite_code_member,
        })
        .select()
      if (error) throw error
      const project = created[0]

      const { error: memberErr } = await cloud.database
        .from('members')
        .insert({ project_id: project.id, user_id: uid, role: 'owner', status: 'active' })
      if (memberErr) throw memberErr

      await cloud.database.from('stages').insert(
        PRESET_STAGES.map((s, i) => ({ project_id: project.id, key: s.key, name: s.name, sort_order: i + 1, status: 'pending' }))
      )
      if (roomNames.length) {
        await cloud.database.from('rooms').insert(
          roomNames.map((r, i) => ({ project_id: project.id, name: r, sort_order: i + 1 }))
        )
      }

      store.setCurrentProjectId(project.id)
      wx.showToast({ title: '项目已创建' })
      setTimeout(() => wx.navigateBack(), 600)
    } catch (e) {
      wx.showToast({ title: e.message || '创建失败，请重试', icon: 'none' })
    } finally {
      this.setData({ saving: false })
    }
  },
})
