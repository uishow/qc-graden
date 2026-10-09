const { cloud } = require('../../utils/cloud')
const store = require('../../utils/store')

// 非加密短哈希（djb2），仅用于同项目内链接去重，不要求密码学强度
function linkHash(str) {
  let h = 5381
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) >>> 0
  }
  return 'l' + h.toString(36)
}

// 从用户粘贴的内容里抠出真正的 http(s) 链接。
// 兼容两类脏输入：
//   1) 微信分享卡片包裹串，如「@share-html#ima.qq.com%2F...:https://ima.qq.com/wiki/?shareId=xxxx」
//      —— 真实链接在第一个 http(s):// 之后；前缀部分是 URL 编码的卡片元信息，忽略。
//   2) 整串被 percent 编码的情况 —— 尝试 decodeURIComponent 还原。
function normalizeLink(raw) {
  if (!raw) return ''
  const m = raw.match(/https?:\/\/[^\s"'<>]+/i)
  let url = m ? m[0] : ''
  if (!url) return ''
  // 去掉结尾可能夹带的标点/括号/全角符号
  url = url.replace(/[)\]}>，`。、；]+$/, '')
  // 若含 %xx 编码，尝试整体解码（还原被编码的中文/路径）
  if (/%[0-9a-f]{2}/i.test(url)) {
    try { url = decodeURIComponent(url) } catch (e) { /* 解码失败则保留原串 */ }
  }
  return url
}

Page({
  data: {
    theme: 'theme-a',
    link: '',
    title: '',
    note: '',
    categories: [],
    activeCategory: 0,
    saving: false,
  },

  onLoad() {
    store.applyTheme(this)
    this.loadCategories()
  },

  async loadCategories() {
    const { data } = await cloud.database
      .from('knowledge_categories').select('*').order('sort_order')
    // 防御：name 为空时回退 key，避免渲染出空白标签
    const list = (data || []).map((d) => ({ ...d, name: d.name || d.key || '未命名分类' }))
    this.setData({ categories: [{ id: 0, name: '未分类' }].concat(list) })
  },

  onLinkInput(e) { this.setData({ link: e.detail.value }) },
  onTitleInput(e) { this.setData({ title: e.detail.value }) },
  onNoteInput(e) { this.setData({ note: e.detail.value }) },

  onCategoryTap(e) {
    this.setData({ activeCategory: Number(e.currentTarget.dataset.index) })
  },

  async doImport() {
    if (this.data.saving) return
    // 微信转发来的 ima 链接常被包成分享卡片格式，先规范化再校验
    const link = normalizeLink((this.data.link || '').trim())
    if (!link) {
      wx.showToast({ title: '没找到 http(s):// 链接，请粘贴 ima 分享链接', icon: 'none' })
      return
    }
    const projectId = store.getCurrentProjectId()
    if (!projectId) {
      wx.showToast({ title: '请先在首页创建/选择一个装修项目', icon: 'none' })
      return
    }
    const { user } = await cloud.auth.getSession()
    const uid = user ? user.id : null
    if (!uid) {
      wx.showToast({ title: '登录未就绪，请稍后重试', icon: 'none' })
      return
    }

    this.setData({ saving: true })
    try {
      const hash = linkHash(link)
      // 去重：同一项目内相同链接只导入一次
      const { data: exist } = await cloud.database
        .from('knowledge_articles').select('id').eq('link_hash', hash).eq('project_id', projectId)
      if (exist && exist.length) {
        const id = exist[0] && exist[0].id
        wx.showToast({ title: '该链接已在知识库中', icon: 'none' })
        // 直接跳到已存在的那条，避免回到列表一脸懵（也方便确认它确实写入成功）
        setTimeout(() => {
          if (id) wx.redirectTo({ url: `/pages/knowledge/detail?id=${id}` })
          else wx.navigateBack()
        }, 800)
        return
      }

      const cat = this.data.categories[this.data.activeCategory]
      const note = (this.data.note || '').trim()
      const title = (this.data.title || '').trim() || 'ima 知识卡片'
      const content = note
        ? '> 导入备注\n\n' + note + '\n\n原文链接：' + link
        : '原文链接：' + link
      const doc = {
        scope: 'member',
        project_id: projectId,
        contributor_id: uid,
        source_link: link,
        link_hash: hash,
        title,
        summary: note ? note.slice(0, 60) : '',
        content,
        tags: [],
        status: 'published',
        view_count: 0,
        category_id: cat && cat.id ? cat.id : null,
        created_at: new Date().toISOString(),
      }
      const { error } = await cloud.database.from('knowledge_articles').insert(doc)
      if (error) throw error
      wx.showToast({ title: '导入成功', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 700)
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '导入失败', icon: 'none' })
    } finally {
      this.setData({ saving: false })
    }
  },
})
