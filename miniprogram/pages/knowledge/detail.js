const { cloud, command } = require('../../utils/cloud')
const store = require('../../utils/store')

Page({
  data: {
    theme: 'theme-a',
    article: null,
    scope: '',
    metaText: '', // 来源 · 日期 · 阅读
    needsEnrich: false, // 缺摘要/正文，可手动「补充内容与摘要」
    enriching: false,
    lines: [],
    imageUrls: [],
    comments: [],
    commentInput: '',
    sending: false,
  },

  async onLoad(options) {
    store.applyTheme(this)
    this.articleId = options.id
    await this.loadAll()
  },

  async loadAll() {
    const { data } = await cloud.database
      .from('knowledge_articles').select('*').eq('id', this.articleId).limit(1)
    const article = data && data[0]
    if (!article) {
      wx.showToast({ title: '文章不存在', icon: 'none' })
      return
    }
    // 阅读量自增：走 incrArticleView 云函数（管理员上下文）——客户端直接 update 会被
    // knowledge_articles 写安全规则(doc._openid==auth.openid)拦掉，云函数导入的文章无 _openid 会一直是 0。
    // 触发式（fire-and-forget），失败不影响正文展示
    wx.cloud.callFunction({ name: 'incrArticleView', data: { id: article.id } })
      .then(() => {})
      .catch(() => {})

    let imageUrls = []
    if (article.image_paths && article.image_paths.length) {
      const { data: urls } = await cloud.storage.createSignedUrls(article.image_paths, 600)
      imageUrls = (urls || []).map((u) => u.signedUrl || u.signedURL || u.url || '')
    }

    // 轻量 Markdown：## 标题 / - 列表 / n. 有序列表 / > 引用 / **加粗** / ![img](url)
    // 行内加粗：按 ** 切分成段（奇数段为粗体），供 WXML 用嵌套 <text> 渲染
    const parseSegs = (text) =>
      String(text).split('**').map((t, i) => ({ t, b: i % 2 === 1, k: i })).filter((s) => s.t)
    const lines = (article.content || '').split('\n').map((raw) => {
      const t = raw.trim()
      if (t.startsWith('## ')) return { kind: 'h2', text: t.slice(3).replace(/\*\*/g, '') }
      if (t.startsWith('- ')) return { kind: 'li', text: t.slice(2), segs: parseSegs(t.slice(2)) }
      if (t.startsWith('> ')) return { kind: 'quote', text: t.slice(2), segs: parseSegs(t.slice(2)) }
      if (/^\d+\.\s/.test(t)) return { kind: 'li', text: t, segs: parseSegs(t) }
      const imgM = t.match(/^!\[[^\]]*\]\(([^)\s]+)\)$/)
      if (imgM) return { kind: 'img', text: imgM[1] }
      return { kind: t ? 'p' : 'blank', text: t, segs: t ? parseSegs(t) : [] }
    })
    // 元信息行：来源 · 日期 · 阅读（source_note 可能为空，ima 文章用 source='ima' 兜底）
    const bits = []
    if (article.source_note) bits.push(article.source_note)
    else if (article.source === 'ima') bits.push('ima 共享库')
    if (article.created_at) bits.push(String(article.created_at).slice(0, 10))
    bits.push('阅读 ' + (article.view_count || 0))
    const metaText = bits.join(' · ')

    this.setData({ article, scope: article.scope || '', lines, imageUrls, metaText })
    // 缺摘要或正文（ima 链接类老文章）→ 允许手动补充
    const needsEnrich = (article.source === 'ima' || article.scope === 'member') &&
      (!article.summary || !(article.content || '').trim())
    this.setData({ needsEnrich })
    await this.loadComments()
  },

  // 补充内容与摘要：调 enrichArticle 抓网页正文 + 生成摘要标签（用于已发布但缺内容的老文章）
  // data-force='1' 时为「重新抓取」：覆盖现有正文与摘要（用最新格式解析）
  async enrichNow(e) {
    if (this.data.enriching) return
    const force = !!(e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.force === '1')
    this.setData({ enriching: true })
    wx.showLoading({ title: force ? '重新抓取中…' : 'AI 处理中…', mask: true })
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'enrichArticle',
        data: force ? { id: this.articleId, force: true } : { id: this.articleId },
      })
      if (!result || !result.ok) {
        wx.showToast({ title: (result && result.message) || '生成失败', icon: 'none' })
        return
      }
      await this.loadAll()
      // AI 调用失败时明确告知原因（未配置密钥/401/余额不足/超时），已用网页描述兜底，不影响入库
      if (result.aiError) {
        wx.showModal({
          title: 'AI 摘要未生效',
          content: `${result.aiError}\n\n已用网页描述兜底，文章仍可正常入库。可在云开发控制台配置 LLM_* 环境变量后重试。`,
          showCancel: false,
          confirmText: '知道了',
        })
      } else if (force && !result.filledContent) {
        wx.showToast({ title: '未抓到正文（原文可能需登录），内容未覆盖', icon: 'none' })
      } else if (result.ai === false) {
        wx.showToast({ title: '已补充（未配置大模型，用网页摘要）', icon: 'none' })
      } else {
        wx.showToast({
          title: result.filledContent ? `已更新正文${result.images ? `·${result.images}图` : ''}与摘要` : '已补充摘要',
          icon: 'success',
        })
      }
    } catch (e) {
      wx.showToast({ title: '处理失败，请重试', icon: 'none' })
    } finally {
      wx.hideLoading()
      this.setData({ enriching: false })
    }
  },

  // 重新抓取正文（仅 ima 导入且带原文链接）：用最新格式解析覆盖现有正文，需二次确认
  onRefetch() {
    if (this.data.enriching) return
    wx.showModal({
      title: '重新抓取正文',
      content: '将重新抓取原文，并以新格式（标题/列表/加粗/图片）覆盖现有正文与摘要，确定继续？',
      confirmText: '覆盖',
      success: (res) => {
        if (res.confirm) this.enrichNow({ currentTarget: { dataset: { force: '1' } } })
      },
    })
  },

  async loadComments() {
    const { data } = await cloud.database
      .from('knowledge_comments')
      .select('id,content,owner_id,created_at')
      .eq('article_id', this.articleId)
      .order('created_at', { ascending: false })
      .limit(50)
    const list = data || []
    const ids = [...new Set(list.map((c) => c.owner_id))]
    let nameMap = {}
    if (ids.length) {
      const { data: profiles } = await cloud.database
        .from('profiles').select('owner_id,nick_name').in('owner_id', ids)
      ;(profiles || []).forEach((p) => { nameMap[p.owner_id] = p.nick_name })
    }
    this.setData({
      comments: list.map((c) => ({
        ...c,
        author: nameMap[c.owner_id] || '邻居',
        time: String(c.created_at).slice(0, 10),
      })),
    })
  },

  onCommentInput(e) {
    this.setData({ commentInput: e.detail.value })
  },

  async sendComment() {
    const content = this.data.commentInput.trim()
    if (!content || this.data.sending) return
    this.setData({ sending: true })
    try {
      const { user } = await cloud.auth.getSession()
      const openid = user ? user.id : null
      const { error } = await cloud.database
        .from('knowledge_comments')
        .insert({ article_id: this.articleId, content, owner_id: openid })
      if (error) throw error
      this.setData({ commentInput: '' })
      await this.loadComments()
    } catch (e) {
      wx.showToast({ title: e.message || '评论失败，请先登录', icon: 'none' })
    } finally {
      this.setData({ sending: false })
    }
  },

  // 预览图片：支持正文内联图片（内容里的 ![img](fileID)）与顶部图集
  previewImage(e) {
    const url = e.currentTarget.dataset.url
    const urls = [url, ...this.data.imageUrls].filter((u, i, a) => u && a.indexOf(u) === i)
    wx.previewImage({ current: url, urls })
  },

  // 复制链接：优先 source_link，兜底 url（ima 链接类条目存的是 url）
  openSource() {
    const a = this.data.article
    const url = a && (a.source_link || a.url)
    if (!url) return
    wx.setClipboardData({
      data: url,
      success: () => wx.showToast({ title: '原文链接已复制', icon: 'none' }),
    })
  },

  // 仅本人导入的成员文章可删除（官方文章不可删）。删除走 deleteArticle 云函数（管理员上下文，
  // 绕过 knowledge_articles 写安全规则——云函数导入的文章没有 _openid，客户端直接删会被静默拒绝）。
  onDelete() {
    if (this.data.scope !== 'member') return
    wx.showModal({
      title: '删除这篇文章？',
      content: '删除后将不再显示，且无法恢复',
      confirmText: '删除',
      success: async (res) => {
        if (!res.confirm) return
        wx.showLoading({ title: '删除中' })
        try {
          const { result } = await wx.cloud.callFunction({
            name: 'deleteArticle',
            data: { id: this.articleId },
          })
          if (!result || !result.ok) {
            wx.showToast({ title: (result && result.message) || '删除失败', icon: 'none' })
            return
          }
          wx.showToast({ title: '已删除' })
          setTimeout(() => wx.navigateBack(), 500)
        } catch (e) {
          wx.showToast({ title: '删除失败，请重试', icon: 'none' })
        } finally {
          wx.hideLoading()
        }
      },
    })
  },
})
