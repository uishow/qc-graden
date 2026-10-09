// 轻量状态：主题、当前项目。本地存储为准，启动即读。
const THEME_KEY = 'theme'
const PROJECT_KEY = 'currentProjectId'

function getTheme() {
  return wx.getStorageSync(THEME_KEY) || 'theme-a'
}

function setTheme(theme) {
  wx.setStorageSync(THEME_KEY, theme)
}

// 每页 onShow 调一行：applyTheme(this)
function applyTheme(page) {
  page.setData({ theme: getTheme() })
}

// 自定义 tabBar：各 tab 页 onShow 调 applyTabBar(this, 序号)，同步选中态与主题
function applyTabBar(page, index) {
  if (typeof page.getTabBar !== 'function') return
  const bar = page.getTabBar()
  if (bar) bar.setData({ selected: index, theme: getTheme() })
}

function getCurrentProjectId() {
  // 云开发文档型主键为字符串 _id，原样存取，不要转 Number
  const v = wx.getStorageSync(PROJECT_KEY)
  return v || null
}

function setCurrentProjectId(id) {
  wx.setStorageSync(PROJECT_KEY, id)
}

module.exports = { getTheme, setTheme, applyTheme, applyTabBar, getCurrentProjectId, setCurrentProjectId }
