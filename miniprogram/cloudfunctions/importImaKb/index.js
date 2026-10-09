const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// 一次性导入 / 同步：把「导入 ima 共享库」准备好的 articles 写入 knowledge_articles。
// 为什么不用 CAM 密钥直连：knowledge_articles 安全规则是 doc._openid==auth.openid，
// CAM 密钥直连跑的是无 openid 的用户身份，会被静默拒绝（add 返回无 _id）。云函数以管理员上下文运行，绕过安全规则。
//
// Upsert：按 link_hash 去重——不存在则插入，已存在则更新（补 project_id/category_id/status 等）。
// 这样重复触发不会新增重复，只会把缺的 project_id 补上（修复「成员导入文章不显示」）。
//
// 触发（开发者工具）：云函数 importImaKb → 测试 → 事件填 {"project_id":"<项目id>","articles":[...]}
//   articles 取自 output/ima-import-pilot.json 的 articles 数组；project_id 让知识库页的成员过滤放行。
exports.main = async (event) => {
  const db = cloud.database()
  const articles = (event && event.articles) || []
  if (!articles.length) return { ok: false, message: 'event.articles 为空' }
  const projectId = event.project_id || null

  // 解析 category_key -> _id
  const catMap = {}
  const cats = (await db.collection('knowledge_categories').limit(100).get()).data || []
  for (const c of cats) if (c.key) catMap[c.key] = c._id

  let inserted = 0
  let updated = 0
  const errors = []
  for (const a of articles) {
    try {
      const ex = await db.collection('knowledge_articles').where({ link_hash: a.link_hash }).get()
      const doc = { ...a }
      if (doc.category_key) {
        doc.category_id = catMap[doc.category_key]
        delete doc.category_key
      }
      doc.status = 'published'
      if (projectId) doc.project_id = projectId
      if (ex.data && ex.data.length) {
        // 已存在：upsert 补字段（project_id / category_id / status 等）
        const id = ex.data[0]._id
        // 注意：wx-server-sdk 服务端 update 必须包 { data: obj }
        await db.collection('knowledge_articles').doc(id).update({ data: doc })
        updated++
      } else {
        // 注意：wx-server-sdk 服务端 add 必须包 { data: obj }，裸 add(obj) 会静默失败
        const r = await db.collection('knowledge_articles').add({ data: doc })
        if (r && r._id) inserted++
        else errors.push({ title: a.title, message: 'add 返回无 _id（疑似静默未写入）' })
      }
    } catch (e) {
      errors.push({ title: a.title, message: e.message || String(e) })
    }
  }

  return { ok: errors.length === 0, inserted, updated, errors }
}
