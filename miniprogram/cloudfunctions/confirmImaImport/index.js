const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// 人工确认门禁的「开关」：把 syncIma 写入的 pending 条目翻成 published（进入知识库）或 rejected（拒绝）。
//
// 为什么是云函数：pending 记录由 syncIma（管理员上下文）创建，_openid 为空，
// 客户端直接 update 会被 knowledge_articles 的写安全规则 doc._openid==auth.openid 拦掉。
// 本函数以管理员上下文运行，绕过规则。
//
// 触发（客户端）：wx.cloud.callFunction({ name:'confirmImaImport', data:{ id, status } })
//   status: 'published'（确认导入）| 'rejected'（拒绝）

exports.main = async (event) => {
  const { id, status } = event || {}
  if (!id || !status) return { ok: false, message: '缺少 id 或 status' }
  if (!['published', 'rejected'].includes(status)) {
    return { ok: false, message: 'status 仅支持 published / rejected' }
  }
  const db = cloud.database()
  const { error } = await db
    .collection('knowledge_articles')
    .doc(id)
    .update({ data: { status, updated_at: new Date().toISOString() } })
  if (error) return { ok: false, error: error.message || String(error) }
  return { ok: true, id, status }
}
