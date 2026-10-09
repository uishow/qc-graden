// 自定义底部 tabBar：选中项为高亮胶囊（原生效样式仅文字微变色，几乎看不出选中）。
// app.json tabBar.custom=true 后生效；list 仍需保留（微信要求）。
// 各 tab 页 onShow 里调 store.applyTabBar(this, 序号) 同步选中态与主题。
Component({
  data: {
    selected: 0,
    theme: 'theme-a',
    hidden: false, // 页面弹窗打开期间置 true 隐藏整条 tabBar（其层级高于弹窗会盖住底部按钮）
    list: [
      { pagePath: '/pages/index/index', text: '首页', icon: 'home' },
      { pagePath: '/pages/diary/list', text: '日记', icon: 'diary' },
      { pagePath: '/pages/budget/overview', text: '花费', icon: 'cost' },
      { pagePath: '/pages/knowledge/index', text: '知识库', icon: 'know' },
      { pagePath: '/pages/user/profile', text: '我的', icon: 'me' },
    ],
  },
  methods: {
    switchTab(e) {
      wx.switchTab({ url: e.currentTarget.dataset.path })
    },
  },
})
