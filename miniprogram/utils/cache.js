// 页面级快照缓存（stale-while-revalidate）：进页先渲染上次快照（秒开），拉到最新后覆盖渲染并回写。
// 缓存只是展示加速，不是数据真源；读写失败一律静默忽略，不影响主流程。
function storageKey(projectId, name) {
  return `cache:${projectId}:${name}`
}

// 读取快照；无缓存或已损坏返回 null
function read(projectId, name) {
  try {
    const v = wx.getStorageSync(storageKey(projectId, name))
    return v && typeof v === 'object' ? v : null
  } catch (e) {
    return null
  }
}

// 写入快照（传本次拉取的原始行数组即可）
function write(projectId, name, data) {
  try {
    wx.setStorageSync(storageKey(projectId, name), data)
  } catch (e) {
    // 存储满等异常静默，缓存不可用时退化为普通拉取
  }
}

// 清掉某项目的全部页面快照（删项目/切项目清理时用）
function clear(projectId) {
  try {
    const prefix = `cache:${projectId}:`
    const info = wx.getStorageInfoSync()
    ;(info.keys || []).filter((k) => k.indexOf(prefix) === 0).forEach((k) => wx.removeStorageSync(k))
  } catch (e) {}
}

module.exports = { read, write, clear }
