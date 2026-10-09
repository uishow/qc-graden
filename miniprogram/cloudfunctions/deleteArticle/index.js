const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// 删除知识库文章：客户端直接 db.remove 会被 knowledge_articles 写安全规则
// (doc._openid == auth.openid) 拦掉——云函数导入(importImaKb/syncIma)的文章没有 _openid，
// 会被规则静默拒绝（删 0 条却可能误判成功）。本函数以管理员上下文运行，绕过规则。
// 仅允许删 scope='member'（官方文章不可删）；调用方(detail 页)已先确认 scope。

exports.main = async (event) => {
  const { id } = event || {}
  if (!id) return { ok: false, message: '缺少 id' }
  const db = cloud.database()
  let doc = null
  try {
    doc = (await db.collection('knowledge_articles').doc(id).get()).data
  } catch (e) {
    return { ok: false, message: '文章不存在' }
  }
  if (!doc) return { ok: false, message: '文章不存在' }
  if (doc.scope === 'official') return { ok: false, message: '官方文章不可删除' }
  await db.collection('knowledge_articles').doc(id).remove()
  return { ok: true }
}
