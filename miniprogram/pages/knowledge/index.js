const { cloud } = require('../../utils/cloud')
const store = require('../../utils/store')
const access = require('../../utils/access')

Page({
  data: {
    theme: 'theme-a',
    activeTab: 0, // 0=知识库（已发布） / 1=待确认导入
    categories: [],
    activeCategory: 0,
    keyword: '',
    articles: [],
    loading: false,
    pendingList: [], // 「待确认导入」：syncIma 写入的 status='pending' 条目
    pendingLoading: false,
    syncing: false, // 「同步 ima」按钮进行中
    myProjectIds: [], // 我加入的项目（成员隔离用）
  },

  async onLoad() {
    store.applyTheme(this)
    const { data } = await cloud.database
      .from('knowledge_categories').select('*').order('sort_order')
    // 防御：name 为空时回退 key，避免标签渲染成空白
    const list = (data || []).map((d) => ({ ...d, name: d.name || d.key || '未命名分类' }))
    this.setData({ categories: [{ id: 0, name: '全部' }].concat(list) })
  },

  // 从导入页返回后自动刷新，让新导入的卡片立即出现
  async onShow() {
    store.applyTabBar(this, 3)
    // 撤销全员可见：先取我加入的项目，再按成员隔离加载列表
    const session = await getApp().ready()
    const openid = session ? session.id : null
    const myIds = await access.myProjectIds(openid)
    this.setData({ myProjectIds: myIds })
    await Promise.all([this.search(), this.loadPending()])
  },

  // 加载「待确认导入」列表：syncIma 写入的 status='pending' 条目（人工确认门禁）。
  // 成员隔离：只显示「我加入的项目」的待确认/处理中条目（成员才能确认/同步），其余项目不可见。
  async loadPending() {
    this.setData({ pendingLoading: true })
    const myIds = this.data.myProjectIds
    let data = []
    if (myIds && myIds.length) {
      const { data: rows, error } = await cloud.database
        .from('knowledge_articles')
        .select('id,title,summary,tags,scope,image_paths,url,project_id,contributor_id,source,ima_kb_id,error_note,status')
        .in('status', ['pending', 'processing']) // 含 processing：卡在处理中的条目也要可见可重试
        .in('project_id', myIds)
        .order('created_at', { ascending: false })
        .limit(50)
      if (!error) data = rows || []
    }
    this.setData({ pendingLoading: false, pendingList: data })
  },

  // 确认导入：走 enrichArticle 自动生成摘要+标签，AI 处理完成才发布进知识库
  async confirm(e) {
    await this.importOne(e.currentTarget.dataset.id)
  },

  // 单条导入：AI 生成摘要+标签 → 发布（完成才出现在知识库列表）
  async importOne(id) {
    wx.showLoading({ title: 'AI 处理中…', mask: true })
    try {
      const { result } = await wx.cloud.callFunction({ name: 'enrichArticle', data: { id } })
      if (!result || !result.ok) {
        wx.showToast({ title: (result && result.message) || '导入失败', icon: 'none' })
        return false
      }
      wx.showToast({ title: result.ai ? 'AI 已生成摘要标签' : '已导入知识库', icon: 'success' })
      this.setData({ pendingList: this.data.pendingList.filter((p) => p.id !== id) })
      await this.search()
      return true
    } catch (err) {
      wx.showToast({ title: '处理失败，请重试', icon: 'none' })
      return false
    } finally {
      wx.hideLoading()
    }
  },

  // 重试生成摘要标签（仅失败条目）：只重跑这一条，不影响其他
  async retryEnrich(e) {
    await this.importOne(e.currentTarget.dataset.id)
  },

  // 拒绝：pending -> rejected（不再进入）
  async reject(e) {
    const id = e.currentTarget.dataset.id
    await this.applyConfirm(id, 'rejected')
  },

  // 一键全部确认导入：逐条走 enrichArticle（AI 生成摘要+标签后发布）
  async confirmAll() {
    const list = this.data.pendingList
    if (!list.length) return
    const sure = await new Promise((resolve) =>
      wx.showModal({
        title: '确认全部导入',
        content: `将把待确认导入的 ${list.length} 条导入知识库，并由 AI 自动生成摘要和标签（处理完成才入库），是否继续？`,
        success: (r) => resolve(!!r.confirm),
      })
    )
    if (!sure) return
    wx.showLoading({ title: `AI 处理中 0/${list.length}`, mask: true })
    let ok = 0
    for (let i = 0; i < list.length; i++) {
      try {
        const { result } = await wx.cloud.callFunction({ name: 'enrichArticle', data: { id: list[i].id } })
        if (result && result.ok) ok++
      } catch (err) {
        // 单条失败不影响其余
      }
      wx.showLoading({ title: `AI 处理中 ${i + 1}/${list.length}`, mask: true })
    }
    wx.hideLoading()
    wx.showToast({ title: `已导入 ${ok}/${list.length} 条`, icon: ok === list.length ? 'success' : 'none' })
    await Promise.all([this.loadPending(), this.search()])
  },

  // 点开看大图（图片类待确认项）
  previewImage(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.previewImage({ current: url, urls: [url] })
  },

  // 复制链接（网页/链接类待确认项，供到浏览器核对内容）
  copyLink(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.setClipboardData({
      data: url,
      success: () => wx.showToast({ title: '链接已复制', icon: 'none' }),
    })
  },

  // 切换「知识库 / 待确认导入」两个 tab
  switchTab(e) {
    const tab = Number(e.currentTarget.dataset.tab)
    if (tab === this.data.activeTab) return
    this.setData({ activeTab: tab })
    // 切到待确认 tab 时刷新一次，确保显示最新同步进来的条目
    if (tab === 1) this.loadPending()
  },

  // 在 App 内直接触发 syncIma 云函数，把 ima 共享库的新内容拉成 pending（密钥在服务端环境变量，前端只发触发）
  async syncIma() {
    if (this.data.syncing) return
    this.setData({ syncing: true })
    wx.showLoading({ title: '同步中…', mask: true })
    let result = null
    try {
      const projectId = store.getCurrentProjectId()
      const r = await wx.cloud.callFunction({
        name: 'syncIma',
        data: { project_id: projectId, categoryKey: 'material' },
      })
      result = r && r.result
    } catch (err) {
      // 客户端超时等：服务端可能仍在跑并已写入，下面统一刷新列表
    } finally {
      wx.hideLoading()
      this.setData({ syncing: false })
      await this.loadPending() // 无论如何刷新一次，避免客户端超时但服务端已写入时列表不更新
    }
    if (result && result.ok) {
      const { pending, skipped, errors } = result
      let tip = `新增待确认 ${pending} 条`
      if (skipped) tip += `，跳过 ${skipped} 条`
      if (errors && errors.length) tip += `，${errors.length} 条失败`
      wx.showToast({ title: tip, icon: 'none' })
    } else if (result) {
      const detail = result.hasClientId === false ? '（云函数环境变量未配置 IMA 密钥）' : ''
      wx.showToast({ title: (result.message || '同步失败') + detail, icon: 'none' })
    } else {
      wx.showToast({ title: '已触发同步，列表已刷新', icon: 'none' })
    }
  },

  async applyConfirm(id, status) {
    wx.showLoading({ title: status === 'published' ? '确认中' : '拒绝中' })
    try {
      const { result } = await wx.cloud.callFunction({ name: 'confirmImaImport', data: { id, status } })
      if (!result || !result.ok) {
        wx.showToast({ title: (result && result.message) || '操作失败', icon: 'none' })
        return
      }
      wx.showToast({ title: status === 'published' ? '已确认导入' : '已拒绝', icon: 'success' })
      // 从待确认列表移除该项，并刷新正常列表（确认后会出现在 published 列表）
      const pendingList = this.data.pendingList.filter((p) => p.id !== id)
      this.setData({ pendingList })
      await this.search()
    } catch (err) {
      wx.showToast({ title: '调用失败，请重试', icon: 'none' })
    } finally {
      wx.hideLoading()
    }
  },

  onCategoryTap(e) {
    this.setData({ activeCategory: Number(e.currentTarget.dataset.index) }, () => this.search())
  },

  onKeywordInput(e) {
    this.setData({ keyword: e.detail.value })
    clearTimeout(this._t)
    this._t = setTimeout(() => this.search(), 300)
  },

  async search() {
    this.setData({ loading: true })
    const cat = this.data.categories[this.data.activeCategory]
    const kw = this.data.keyword.trim()
    // 基础查询（状态=已发布），分类/关键词过滤共用
    const base = () => {
      let q = cloud.database
        .from('knowledge_articles')
        .select('id,title,summary,tags,scope,view_count,category_id,project_id,contributor_id')
        .eq('status', 'published')
      if (cat && cat.id) q = q.eq('category_id', cat.id)
      if (kw) q = q.ilike('title', `%${kw}%`)
      return q
    }
    // 成员隔离（撤销全员可见）：
    //   官方文章(scope='official'，无 project_id) 对所有人可见；
    //   成员导入文章(scope='member') 仅「我加入的项目」可见。
    const tasks = [base().eq('scope', 'official').order('view_count', { ascending: false }).limit(50).get()]
    const myIds = this.data.myProjectIds
    if (myIds && myIds.length) {
      tasks.push(base().eq('scope', 'member').in('project_id', myIds).order('view_count', { ascending: false }).limit(50).get())
    }
    const results = await Promise.all(tasks)
    for (const r of results) {
      if (r.error) {
        this.setData({ loading: false, emptyHint: '知识库加载失败，请稍后重试' })
        return
      }
    }
    // 合并两路结果、去重、按阅读量降序取前 50
    const seen = {}
    let articles = []
    for (const r of results) articles = articles.concat(r.data || [])
    articles = articles
      .filter((a) => { if (seen[a.id]) return false; seen[a.id] = true; return true })
      .sort((a, b) => (b.view_count || 0) - (a.view_count || 0))
      .slice(0, 50)
    const emptyHint = '还没有匹配的文章'
    this.setData({ articles, loading: false, emptyHint })
  },

  goDetail(e) {
    wx.navigateTo({ url: `/pages/knowledge/detail?id=${e.currentTarget.dataset.id}` })
  },

  goImport() {
    wx.navigateTo({ url: '/pages/knowledge/import' })
  },
})
