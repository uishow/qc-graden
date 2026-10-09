// 成员校验写：diaries / expenses / materials 的增删改统一走 dataWrite 云函数。
// 函数先校验「当前用户是该项目的 active 成员」，否则拒绝；配合三张表安全规则 write:false，
// 彻底堵死被移除成员手机残留 projectId 直接越权写入。
//
// 返回形状与 utils/cloud.js 适配层一致：{ data, error }，前端调用方几乎零改动。
const FUNC = 'dataWrite'

function wrap(res) {
  const r = (res && res.result) || {}
  if (r.error) return { data: null, error: r.error }
  return { data: r.data != null ? r.data : [], error: null }
}

function fail(e) {
  return { data: null, error: { code: 'call_failed', message: (e && e.errMsg) || '网络错误，请重试' } }
}

// 新增：data 为字段对象；成功返回 data=[{ id }]
function insert(collection, projectId, data) {
  return wx.cloud
    .callFunction({ name: FUNC, data: { collection, op: 'insert', projectId, data } })
    .then(wrap)
    .catch(fail)
}

// 更新：id 为文档 _id；version 为可选乐观锁旧版本号（不传则不校验版本）
function update(collection, projectId, id, data, version) {
  return wx.cloud
    .callFunction({ name: FUNC, data: { collection, op: 'update', projectId, id, data, version } })
    .then(wrap)
    .catch(fail)
}

// 删除（硬删）：id 为文档 _id
function remove(collection, projectId, id) {
  return wx.cloud
    .callFunction({ name: FUNC, data: { collection, op: 'delete', projectId, id } })
    .then(wrap)
    .catch(fail)
}

module.exports = { insert, update, remove }
