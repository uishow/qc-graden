const { cloud } = require('../../utils/cloud')
const store = require('../../utils/store')
const access = require('../../utils/access')
const { fen2yuan } = require('../../utils/format')
const { BELONG_WHOLEHOUSE, isWholeHouseLike, isWholeHouseStage } = require('../../utils/wholehouse')
const { exportExpensesTabCsv, exportMaterialsTabCsv, exportWholeHouseTabCsv } = require('../../utils/exportCsv')
const cache = require('../../utils/cache')
const write = require('../../utils/write')

const app = getApp()

const TYPE_NAMES = { material: '材料', labor: '人工', design: '设计', deposit: '订金/定金', other: '其他' }
const MAT_STATUS = [
  { key: 'to_buy', name: '待购买' },
  { key: 'bought', name: '已购买' },
  { key: 'on_site', name: '已进场' },
]
const STAGE_STATUS_NAMES = { pending: '未开始', doing: '进行中', done: '已完成' }

Page({
  data: {
    theme: 'theme-a',
    empty: false,
    activeTab: 0, // 0=费用总览 / 1=材料清单 / 2=花费清单 / 3=全屋定制
    // 花费
    budgetText: '¥0.00',
    spentText: '¥0.00',
    remainText: '¥0.00',
    spentPercent: 0,
    typeSums: [],
    recent: [],
    // 材料清单
    matEmpty: true,
    matTotalText: '¥0.00',
    matExecPercent: 0, // 采购计划执行率：已购 / 材料清单总额
    matGroups: [],
    // 全屋定制（阶段进度卡 + 归集）
    wholeHouse: { has: false, name: '', status: '', statusName: '', id: '' },
    whMatTotalText: '¥0.00',
    whExpTotalText: '¥0.00',
    whTotalText: '¥0.00',
    whItems: [],
    whSuggestCount: 0,
    // 一键归集疑似项：勾选弹窗
    whSheet: false,
    whPicks: [],
    whPickedCount: 0,
  },

  onLoad() {},

  // 导出：每个 Tab 只导当前页数据（花费清单=花费 / 材料清单=材料 / 全屋定制=归属全屋定制的项）
  goExport() {
    exportExpensesTabCsv(cloud, store.getCurrentProjectId())
  },
  goExportMaterials() {
    exportMaterialsTabCsv(cloud, store.getCurrentProjectId())
  },
  goExportWholeHouse() {
    exportWholeHouseTabCsv(cloud, store.getCurrentProjectId())
  },

  // 切换「费用总览 / 材料清单 / 花费清单 / 全屋定制」四个 tab（参考知识库分块方式）
  switchTab(e) {
    const tab = Number(e.currentTarget.dataset.tab)
    if (tab === this.data.activeTab) return
    this.setData({ activeTab: tab })
  },

  async onShow() {
    store.applyTheme(this)
    store.applyTabBar(this, 2)
    const session = await app.ready()
    if (!session) return
    await this.load()
    this.startWatch() // M3·L1 扩展：花费/材料实时监听（日记页试点已真机验证通过）
  },

  onHide() {
    this.setBarHidden(false) // 安全兜底：离开页面时恢复 tabBar
    this.stopWatch() // 长连接随页面隐藏关闭，避免堆积
  },

  onUnload() {
    this.stopWatch()
  },

  // —— M3·L1 实时监听扩展：expenses + materials 双 watcher（复用日记页试点模式）——
  // 直接用 wx.cloud 客户端 SDK（适配层不支持 watch）；读权限放宽为 true，登录用户可监听。
  startWatch() {
    this.stopWatch() // 项目可能已切换，先关旧监听
    if (!wx.cloud || typeof wx.cloud.database !== 'function') return
    const projectId = store.getCurrentProjectId()
    if (!projectId) return
    try {
      const db = wx.cloud.database()
      const onChange = () => {
        // 双 watcher 可能接连触发，500ms 去抖合并为一次刷新
        clearTimeout(this._watchTimer)
        this._watchTimer = setTimeout(() => this.load(), 500)
      }
      this._watchers = ['expenses', 'materials'].map((coll) =>
        db.collection(coll).where({ project_id: projectId }).watch({
          onChange,
          onError: (e) => {
            console.warn('[watch] ' + coll + ' 实时监听异常（不影响手动刷新）', e)
          },
        })
      )
    } catch (e) {
      console.warn('[watch] 初始化失败（不影响手动刷新）', e)
    }
  },

  stopWatch() {
    clearTimeout(this._watchTimer)
    ;(this._watchers || []).forEach((w) => {
      try { w.close() } catch (e) {}
    })
    this._watchers = []
  },

  noop() {},

  // 弹窗打开期间隐藏自定义 tabBar：其框架包装层层级高于页面 fixed 弹窗，会盖住底部按钮
  setBarHidden(hidden) {
    const bar = this.getTabBar && this.getTabBar()
    if (bar) bar.setData({ hidden: !!hidden })
  },

  async load() {
    const projectId = store.getCurrentProjectId()
    if (!projectId) {
      this.setData({ empty: true })
      return
    }
    // 成员校验：本机残留的 projectId 可能来自已退出/被移除的项目，非 active 成员不放行
    const user = await app.ready()
    const myIds = await access.myProjectIds(user ? user.id : null)
    if (myIds.indexOf(projectId) === -1) {
      store.setCurrentProjectId(null)
      this.setData({ empty: true })
      return
    }
    // 增量同步 v1（stale-while-revalidate）：先渲染上次快照（秒开），再拉最新覆盖并回写缓存
    const cached = cache.read(projectId, 'overview')
    if (cached) this.render(cached)
    const [{ data: projects }, { data: expenses }, { data: materials }, { data: stages }] = await Promise.all([
      cloud.database.from('projects').select('budget').eq('id', projectId).limit(1),
      cloud.database.from('expenses').select('*').eq('project_id', projectId)
        .neq('deleted', true).order('pay_date', { ascending: false }).limit(100),
      cloud.database.from('materials').select('*').eq('project_id', projectId).order('created_at', { ascending: false }),
      cloud.database.from('stages').select('*').eq('project_id', projectId),
    ])
    const snapshot = { projects: projects || [], expenses: expenses || [], materials: materials || [], stages: stages || [] }
    cache.write(projectId, 'overview', snapshot)
    this.render(snapshot)
  },

  // 由一份 {projects, expenses, materials, stages} 快照计算全部展示数据并渲染
  render({ projects, expenses, materials, stages }) {
    // 花费：expenses 表（非材料类目）+ 材料合计，均计入预算（B 防重模型：
    // 材料不手填，统一由材料清单汇总，结构上杜绝重复）
    const budget = projects && projects[0] ? Number(projects[0].budget || 0) : 0
    const list = expenses || []
    const mat = materials || []
    // 已花费口径（与首页统一）：非材料手动花费 + 已购买/已进场材料(实际成交价)；待购买(to_buy)不计入——推进后数字才会变化
    // 计划价 planned_price：创建时定格；已执行项改实际价不动计划价。无该字段的老数据回退 total_price。
    const planOf = (m) => Number((m.planned_price != null ? m.planned_price : m.total_price) || 0)
    const purchasedMat = mat.filter((m) => m.status === 'bought' || m.status === 'on_site')
    const matTotal = purchasedMat.reduce((s, m) => s + Number(m.total_price || 0), 0) // 实际已购
    const purchasedPlanTotal = purchasedMat.reduce((s, m) => s + planOf(m), 0) // 已执行项的计划额
    const planTotal = mat.reduce((s, m) => s + planOf(m), 0) // 计划总额（冻结）
    const pendingPlanTotal = mat.filter((m) => m.status === 'to_buy').reduce((s, m) => s + planOf(m), 0) // 待购=计划
    const matExecPercent = planTotal > 0 ? Math.round((purchasedPlanTotal / planTotal) * 100) : 0
    const matPlanDeviation = matTotal - purchasedPlanTotal // 实际-计划（已执行项），正=超支
    const spent = list
      .filter((e) => e.type !== 'material')
      .reduce((s, e) => s + Number(e.amount || 0), 0) + matTotal
    const sums = {}
    list.forEach((e) => { sums[e.type] = (sums[e.type] || 0) + Number(e.amount || 0) })

    // 材料：清单（按状态分组），金额已并回预算
    const matGroups = MAT_STATUS
      .filter((s) => mat.some((m) => m.status === s.key))
      .map((s) => ({
        ...s,
        items: mat
          .filter((m) => m.status === s.key)
          .map((m) => {
            const planPrice = planOf(m)
            const dev = Number(m.total_price || 0) - planPrice // 实际-计划，正=超支
            const devType = dev > 0 ? 'over' : (dev < 0 ? 'save' : 'none')
            const devTag = devType === 'over' ? '超支 ' + fen2yuan(dev)
              : (devType === 'save' ? '结余 ' + fen2yuan(-dev) : '')
            return {
              ...m,
              totalText: fen2yuan(m.total_price),
              planText: fen2yuan(planPrice),
              devType, devTag,
              attCount: (m.attachments || []).length,
            }
          }),
      }))

    // 全屋定制：并行环节，不再是线性固定阶段。支持用户在看板建多个全屋定制子阶段
    //（橱柜/衣柜/窗帘安装…），按 key='customhome' 或名称含「全屋定制」/「定制」匹配，列出全部。
    const whMatch = (stages || []).filter(isWholeHouseStage)
    const whStages = whMatch.map((s) => ({
      id: s.id,
      name: s.name,
      statusName: STAGE_STATUS_NAMES[s.status] || '未开始',
    }))
    const wholeHouse = whMatch.length
      ? { has: true, count: whMatch.length, name: whMatch[0].name, statusName: STAGE_STATUS_NAMES[whMatch[0].status] || '未开始', id: whMatch[0].id }
      : { has: false, count: 0, name: '全屋定制', statusName: '', id: '' }

    // 全屋定制归集：只认 belong === 'wholehouse' 的材料 / 花费（花费排除历史材料类，避免与材料清单重复）
    const whMat = mat.filter((m) => m.belong === BELONG_WHOLEHOUSE)
    const whExp = list.filter((e) => e.belong === BELONG_WHOLEHOUSE && e.type !== 'material')
    const whMatTotal = whMat.reduce((s, m) => s + Number(m.total_price || 0), 0)
    const whExpTotal = whExp.reduce((s, e) => s + Number(e.amount || 0), 0)
    const whItems = [
      ...whMat.map((m) => {
        const planPrice = planOf(m)
        const dev = Number(m.total_price || 0) - planPrice
        const devType = dev > 0 ? 'over' : (dev < 0 ? 'save' : 'none')
        const devTag = devType === 'over' ? '超支 ' + fen2yuan(dev)
          : (devType === 'save' ? '结余 ' + fen2yuan(-dev) : '')
        return {
          k: 'm' + m.id, kind: 'material', id: m.id, kindName: '材料',
          title: m.name, sub: m.sub || '全屋定制', text: fen2yuan(m.total_price),
          planText: fen2yuan(planPrice), devType, devTag,
          attCount: (m.attachments || []).length,
        }
      }),
      ...whExp.map((e) => ({
        k: 'e' + e.id, kind: 'expense', id: e.id, kindName: TYPE_NAMES[e.type] || '其他',
        title: e.remark || '花费', sub: e.pay_date, text: fen2yuan(e.amount),
        attCount: (e.attachments || []).length,
      })),
    ]
    // 关键词兑底：统计「疑似属于全屋定制但尚未标记」的项，供一键归集
    const whSuggestCount =
      mat.filter((m) => m.belong !== BELONG_WHOLEHOUSE && isWholeHouseLike((m.name || '') + ' ' + (m.remark || ''))).length +
      list.filter((e) => e.belong !== BELONG_WHOLEHOUSE && isWholeHouseLike(e.remark || '')).length

    // 费用总览·按阶段维度（轻量关联：只认带 stage_id 的；未带归入「通用」；花费排除历史材料类；
    // 材料只计已购部分，与已花费口径一致）
    const expByStage = {}
    const matByStage = {}
    list.forEach((e) => { if (e.stage_id && e.type !== 'material') expByStage[e.stage_id] = (expByStage[e.stage_id] || 0) + Number(e.amount || 0) })
    purchasedMat.forEach((m) => { if (m.stage_id) matByStage[m.stage_id] = (matByStage[m.stage_id] || 0) + Number(m.total_price || 0) })
    const stageRollups = (stages || [])
      .map((s) => ({ id: s.id, name: s.name, exp: expByStage[s.id] || 0, mat: matByStage[s.id] || 0 }))
      .filter((r) => r.exp > 0 || r.mat > 0)
      .map((r) => ({ name: r.name, expText: fen2yuan(r.exp), matText: fen2yuan(r.mat), total: r.exp + r.mat }))
    const untaggedExp = list.reduce((s, e) => s + (e.stage_id ? 0 : Number(e.amount || 0)), 0)
    const untaggedMat = mat.reduce((s, m) => s + (m.stage_id ? 0 : Number(m.total_price || 0)), 0)
    if (untaggedExp > 0 || untaggedMat > 0) {
      stageRollups.push({ name: '通用（未归类）', expText: fen2yuan(untaggedExp), matText: fen2yuan(untaggedMat), total: untaggedExp + untaggedMat })
    }
    // 条形图占比：相对组内最大值，保底 3% 保证可见（纯 CSS 条，不用 canvas）
    const stageMax = Math.max(0, ...stageRollups.map((r) => r.total))
    stageRollups.forEach((r) => { r.pct = stageMax ? Math.max(3, Math.round((r.total / stageMax) * 100)) : 0 })

    // 费用总览·按材料类型维度（只计已购材料，与已花费口径一致）
    const MAT_CATS = ['主材', '辅材', '家具', '家电', '软装']
    const matTypeTotals = MAT_CATS
      .map((c) => ({ name: c, total: purchasedMat.filter((m) => m.category === c).reduce((s, m) => s + Number(m.total_price || 0), 0) }))
      .filter((x) => x.total > 0)
      .map((x) => ({ name: x.name, text: fen2yuan(x.total), total: x.total }))
    const matTypeMax = Math.max(0, ...matTypeTotals.map((x) => x.total))
    matTypeTotals.forEach((x) => { x.pct = matTypeMax ? Math.max(3, Math.round((x.total / matTypeMax) * 100)) : 0 })

    // 按花费类目：仅人工/设计/其他/订金·定金（材料由材料清单汇总，不再单列，杜绝重复）
    const typeSumArr = ['labor', 'design', 'deposit', 'other']
      .filter((t) => sums[t])
      .map((t) => ({ name: TYPE_NAMES[t], text: fen2yuan(sums[t]), total: sums[t] }))
    const typeMax = Math.max(0, ...typeSumArr.map((x) => x.total))
    typeSumArr.forEach((x) => { x.pct = typeMax ? Math.max(3, Math.round((x.total / typeMax) * 100)) : 0 })

    this.setData({
      empty: false,
      budgetText: fen2yuan(budget),
      spentText: fen2yuan(spent),
      remainText: fen2yuan(budget - spent),
      spentPercent: budget > 0 ? Math.min(100, Math.round((spent / budget) * 100)) : 0,
      // 按花费类目条形图数据（typeSumArr 已含 pct）
      typeSums: typeSumArr,
      recent: list.map((e) => ({
        ...e,
        typeName: TYPE_NAMES[e.type] || '其他',
        amountText: fen2yuan(e.amount),
        attCount: (e.attachments || []).length,
      })),
      matEmpty: mat.length === 0,
      matTotalText: fen2yuan(planTotal),
      matPurchasedText: fen2yuan(matTotal),
      matPendingText: fen2yuan(pendingPlanTotal),
      matExecPercent,
      matPlanDeviationText: matPlanDeviation === 0 ? '' : (matPlanDeviation > 0 ? '超支 ' : '结余 ') + fen2yuan(Math.abs(matPlanDeviation)),
      matGroups,
      wholeHouse,
      whMatTotalText: fen2yuan(whMatTotal),
      whExpTotalText: fen2yuan(whExpTotal),
      whTotalText: fen2yuan(whMatTotal + whExpTotal),
      whItems,
      whSuggestCount,
      stageRollups,
      matTypeTotals,
    })
  },

  // 花费
  goEdit() {
    wx.navigateTo({ url: '/pages/budget/edit' })
  },
  goEditItem(e) {
    wx.navigateTo({ url: `/pages/budget/edit?id=${e.currentTarget.dataset.id}` })
  },
  async removeItem(e) {
    const id = e.currentTarget.dataset.id
    const { confirm } = await new Promise((resolve) =>
      wx.showModal({
        title: '删除这笔花费',
        content: '确定删除这条花费记录？（删除后不再计入汇总）',
        confirmText: '删除',
        success: (r) => resolve(r),
      })
    )
    if (!confirm) return
    // 软删除：与日记一致，置 deleted:true，列表查询已过滤
    const { error } = await write.update('expenses', store.getCurrentProjectId(), id, {
      deleted: true,
      updated_at: new Date().toISOString(),
    })
    if (error) {
      wx.showToast({ title: '删除失败', icon: 'none' })
      return
    }
    await this.load()
  },

  // 材料清单
  goAddMaterial() {
    if (!store.getCurrentProjectId()) {
      wx.showToast({ title: '请先在首页创建或选择项目', icon: 'none' })
      return
    }
    wx.navigateTo({ url: '/pages/material/edit' })
  },
  goEditMaterial(e) {
    wx.navigateTo({ url: `/pages/material/edit?id=${e.currentTarget.dataset.id}` })
  },
  async removeMaterial(e) {
    const id = e.currentTarget.dataset.id
    const { confirm } = await new Promise((resolve) =>
      wx.showModal({
        title: '删除材料',
        content: '确定从清单中删除这项材料？',
        confirmText: '删除',
        success: (r) => resolve(r),
      })
    )
    if (!confirm) return
    const { error } = await write.remove('materials', store.getCurrentProjectId(), id)
    if (error) {
      wx.showToast({ title: '删除失败', icon: 'none' })
      return
    }
    await this.load()
  },
  async advanceMaterialStatus(e) {
    const id = e.currentTarget.dataset.id
    const cur = e.currentTarget.dataset.status
    const order = ['to_buy', 'bought', 'on_site']
    const next = order[Math.min(order.indexOf(cur) + 1, order.length - 1)]
    if (next === cur) return
    const { error } = await write.update('materials', store.getCurrentProjectId(), id, {
      status: next,
      updated_at: new Date().toISOString(),
    })
    if (error) {
      wx.showToast({ title: '更新失败', icon: 'none' })
      return
    }
    await this.load()
    // 注意：材料是独立表，不回写 expenses；预算已花费 = 花费合计 + 材料合计（按用户确认「所有花的钱都计入预算」）
  },

  // 全屋定制：阶段进度卡，点一下跳阶段看板查看/推进（带 scope=wholehouse 只显示全屋定制阶段）
  goWholeHouse() {
    wx.navigateTo({ url: '/pages/stage/board?scope=wholehouse' })
  },

  // 归集入口：加/改全屋定制的材料与花费（保存时自动带归属）
  goAddWhMaterial() {
    if (!store.getCurrentProjectId()) {
      wx.showToast({ title: '请先在首页创建或选择项目', icon: 'none' })
      return
    }
    wx.navigateTo({ url: `/pages/material/edit?belong=${BELONG_WHOLEHOUSE}` })
  },
  goAddWhExpense() {
    if (!store.getCurrentProjectId()) {
      wx.showToast({ title: '请先在首页创建或选择项目', icon: 'none' })
      return
    }
    wx.navigateTo({ url: `/pages/budget/edit?belong=${BELONG_WHOLEHOUSE}` })
  },
  goEditWhItem(e) {
    const { kind, id } = e.currentTarget.dataset
    if (kind === 'material') wx.navigateTo({ url: `/pages/material/edit?id=${id}` })
    else wx.navigateTo({ url: `/pages/budget/edit?id=${id}` })
  },
  // 关键词兜底：把名称/备注含全屋定制关键词的材料/花费标记为全屋定制。
  // 弹出底部弹窗列出疑似项，勾选后确认，只归集勾选的条目（默认全选）。
  async autoTagWholeHouse() {
    const pid = store.getCurrentProjectId()
    if (!pid) return
    const [{ data: mats }, { data: exps }] = await Promise.all([
      cloud.database.from('materials').select('id,name,remark,belong').eq('project_id', pid),
      cloud.database.from('expenses').select('id,remark,belong').eq('project_id', pid).neq('deleted', true),
    ])
    const matHit = (mats || []).filter((m) => m.belong !== BELONG_WHOLEHOUSE && isWholeHouseLike((m.name || '') + ' ' + (m.remark || '')))
    const expHit = (exps || []).filter((x) => x.belong !== BELONG_WHOLEHOUSE && isWholeHouseLike(x.remark || ''))
    const picks = [
      ...matHit.map((m) => ({
        k: 'm' + m.id, kind: 'material', id: m.id, kindName: '材料',
        title: m.name || '未命名材料', sub: m.remark || '', checked: true,
      })),
      ...expHit.map((x) => ({
        k: 'e' + x.id, kind: 'expense', id: x.id, kindName: '花费',
        title: x.remark || '未填备注', sub: '', checked: true,
      })),
    ]
    if (!picks.length) {
      wx.showToast({ title: '没有可归集的疑似项', icon: 'none' })
      return
    }
    this.setBarHidden(true)
    this.setData({ whSheet: true, whPicks: picks, whPickedCount: picks.length })
  },

  // checkbox-group 勾选变化：同步每项 checked 态与已选数（用于按钮文案）
  onWhPickChange(e) {
    const keys = e.detail.value || []
    const whPicks = this.data.whPicks.map((p) => ({ ...p, checked: keys.indexOf(p.k) !== -1 }))
    this.setData({ whPicks, whPickedCount: whPicks.filter((p) => p.checked).length })
  },

  cancelWhPick() {
    this.setBarHidden(false)
    this.setData({ whSheet: false, whPicks: [], whPickedCount: 0 })
  },

  async confirmWhPick() {
    const picked = this.data.whPicks.filter((p) => p.checked)
    if (!picked.length) {
      wx.showToast({ title: '请先勾选要归集的项', icon: 'none' })
      return
    }
    wx.showLoading({ title: '归集中…', mask: true })
    // showLoading/showToast 共用同一原生单例：hideLoading 必须在 showToast 之前，否则提示被瞬间关掉
    let ok = true
    try {
      const now = new Date().toISOString()
      await Promise.all(
        picked.map((p) =>
          cloud.database
            .from(p.kind === 'material' ? 'materials' : 'expenses')
            .update({ belong: BELONG_WHOLEHOUSE, updated_at: now })
            .eq('id', p.id)
        )
      )
    } catch (err) {
      ok = false
    } finally {
      wx.hideLoading()
    }
    if (!ok) {
      wx.showToast({ title: '归集失败，请重试', icon: 'none' })
      return
    }
    this.cancelWhPick()
    wx.showToast({ title: `已归集 ${picked.length} 项` })
    await this.load()
  },
})
