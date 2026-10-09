const { cloud } = require('../../utils/cloud')
const store = require('../../utils/store')

const app = getApp()

Page({
  data: {
    theme: 'theme-a',
    messages: [], // [{ role: 'user'|'ai', text, sources:[{id,title}] }]
    input: '',
    lastId: '',
    loading: false,
    kbHeight: 0, // 键盘高度：抬升输入条避免遮挡
  },

  onLoad() {
    // 键盘高度回调需挂实例方法才能注销成对
    this._onKb = (res) => {
      this.setData({ kbHeight: res.height || 0 })
      if (res.height) this.scrollToBottom()
    }
  },

  onShow() {
    store.applyTheme(this)
    if (wx.onKeyboardHeightChange) wx.onKeyboardHeightChange(this._onKb)
  },

  onHide() {
    if (wx.offKeyboardHeightChange) wx.offKeyboardHeightChange(this._onKb)
  },

  onUnload() {
    if (wx.offKeyboardHeightChange) wx.offKeyboardHeightChange(this._onKb)
  },

  scrollToBottom() {
    const n = this.data.messages.length
    if (n) this.setData({ lastId: 'msg' + (n - 1) })
  },

  onInput(e) {
    this.setData({ input: e.detail.value })
  },

  // 空状态建议问题：点一下直接发送
  sendSuggest(e) {
    const q = e.currentTarget.dataset.q
    if (!q) return
    this.setData({ input: q }, () => this.send(q))
  },

  async send(src) {
    // bindconfirm 传事件对象、sendSuggest 传字符串，两者都要兼容
    const text = String(typeof src === 'string' ? src : this.data.input || '').trim()
    if (!text || this.data.loading) return
    const messages = this.data.messages.concat([{ role: 'user', text, sources: [] }])
    this.setData({ messages, input: '', loading: true, lastId: 'msg' + (messages.length - 1) })
    let result = null
    try {
      const res = await wx.cloud.callFunction({
        name: 'askAI',
        data: { question: text, projectId: store.getCurrentProjectId() },
      })
      result = res && res.result
    } catch (e) {
      const detail = String((e && (e.errCode || e.errMsg || e.message)) || '').slice(0, 60)
      result = { ok: false, message: '调用失败：' + (detail || '网络异常') }
    }
    const answer = result && result.ok
      ? result.answer
      : (result && result.message) || '回答失败，请重试'
    const sources = (result && result.ok && result.sources) || []
    const next = this.data.messages.concat([
      {
        role: 'ai',
        text: answer + (result && result.ok && result.ai === false && result.aiError ? '\n\n（AI 暂不可用：' + result.aiError + '）' : ''),
        sources,
      },
    ])
    this.setData({ messages: next, loading: false, lastId: 'msg' + (next.length - 1) })
  },

  goSource(e) {
    wx.navigateTo({ url: `/pages/knowledge/detail?id=${e.currentTarget.dataset.id}` })
  },
})
