const store = require('./utils/store')

App({
  globalData: {
    user: null, // { openid, id } —— id === openid
    loginReady: null,
  },

  onLaunch() {
    wx.cloud.init({
      env: 'cloudbase-d0gcanr6v1194af27',
      traceUser: true,
    })
    this.globalData.loginReady = this.ensureLogin()
  },

  // 微信静默登录：调用 login 云函数拿 OPENID，并在 globalData 落地 user。
  // 云函数未部署/网络异常时走到 catch，页面据此展示受限态。
  async ensureLogin() {
    try {
      const res = await wx.cloud.callFunction({ name: 'login' })
      console.log('[login] rawResult', JSON.stringify(res))
      const openid = res && res.result && res.result.openid
      if (!openid) throw new Error('login 未返回 openid: ' + JSON.stringify(res && res.result))
      const user = { openid, id: openid }
      this.globalData.user = user
      return user
    } catch (e) {
      console.error('[Cloud] login failed', JSON.stringify({
        stage: 'wechat-login',
        message: (e && e.message) || '登录失败',
      }))
      wx.showToast({ title: '登录失败：' + ((e && e.message) || '未知错误'), icon: 'none' })
      return null
    }
  },

  // 页面统一等待登录就绪；返回 user 或 null
  async ready() {
    return this.globalData.loginReady
  },
})
