const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// 阅读量自增：客户端直接 update 会被 knowledge_articles 写安全规则
// (doc._openid == auth.openid) 拦掉——云函数导入(importImaKb/syncIma)的文章没有 _openid，
// 会被静默拒绝（阅读量一直是 0）。本函数以管理员上下文运行，绕过规则。
exports.main = async (event) => {
  const { id } = event || {}
  if (!id) return { ok: false, message: '缺少 id' }
  const db = cloud.database()
  try {
    await db.collection('knowledge_articles').doc(id).update({
      data: { view_count: db.command.inc(1) },
    })
    return { ok: true }
  } catch (e) {
    return { ok: false, message: e.message || String(e) }
  }
}