const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// 清除测试数据，保留基础数据（知识库分类 + 官方种子文章 scope='official'）。
//
// 保留（基础数据，绝不删）：
//   - knowledge_categories（全部 7 个种子分类）
//   - knowledge_articles（scope='official' 的 4 篇种子文章）
//
// 删除（测试数据）：
//   - 模式A（默认，不传 projectName）：所有 projects + 其下 members/stages/rooms/diaries/expenses/materials
//                                    + knowledge_articles(scope='member' 的成员测试导入)
//   - 模式B（传 projectName）：仅该项目的项目主记录 + 其子表，不动其它项目与文章
//
// 云函数以管理员身份运行，绕过集合安全规则；仅由运维在云控制台手动触发。
exports.main = async (event = {}) => {
  const childCols = ['members', 'stages', 'rooms', 'diaries', 'expenses', 'materials']
  const out = { ok: true, mode: event.projectName ? 'single' : 'all', deleted: {} }
  const tally = (col, n) => { out.deleted[col] = (out.deleted[col] || 0) + (n || 0) }

  if (event.projectName) {
    const pr = await db.collection('projects').where({ name: event.projectName }).limit(1).get()
    if (!pr.data || !pr.data.length) return { ok: false, error: '未找到项目: ' + event.projectName }
    const pid = pr.data[0]._id
    for (const col of childCols) {
      const r = await db.collection(col).where({ project_id: pid }).remove()
      if (r.stats) tally(col, r.stats.removed)
    }
    await db.collection('projects').doc(pid).remove()
    tally('projects', 1)
    return out
  }

  // 模式A：全量清除测试数据
  const projects = (await db.collection('projects').limit(100).get()).data || []
  for (const p of projects) {
    const pid = p._id
    for (const col of childCols) {
      const r = await db.collection(col).where({ project_id: pid }).remove()
      if (r.stats) tally(col, r.stats.removed)
    }
    await db.collection('projects').doc(pid).remove()
  }
  tally('projects', projects.length)

  // 删除成员导入的测试文章，保留官方种子（scope='official'）
  const art = await db.collection('knowledge_articles').where({ scope: 'member' }).remove()
  if (art.stats) tally('knowledge_articles_member', art.stats.removed)

  // knowledge_categories 与 knowledge_articles(scope='official') 保持不动
  return out
}
