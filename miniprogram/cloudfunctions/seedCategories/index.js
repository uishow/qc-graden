const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const CATEGORIES = [
  { key: 'hydropower', name: '水电隐蔽工程', sort_order: 1 },
  { key: 'masonry', name: '泥瓦与防水', sort_order: 2 },
  { key: 'carpentry', name: '木作与吊顶', sort_order: 3 },
  { key: 'paint', name: '油漆与墙面', sort_order: 4 },
  { key: 'material', name: '主材选购', sort_order: 5 },
  { key: 'soft', name: '软装与收纳', sort_order: 6 },
  { key: 'acceptance', name: '验收与避坑', sort_order: 7 },
  { key: 'wholehouse', name: '全屋定制', sort_order: 8 },
]

// 修复「归类到」显示空白/未命名分类：清掉 knowledge_categories 里缺 key/name 的空文档，
// 再按 key 幂等补 8 类。根因是集合里先有 7 条空文档，init 幂等"有 key 就跳过"未补 name。
// 仅由运维在云函数控制台手动触发一次；云函数以管理员身份运行，不受集合安全规则限制。
exports.main = async () => {
  const db = cloud.database()
  const all = (await db.collection('knowledge_categories').limit(100).get()).data || []
  const bad = all.filter((d) => !d.key || !d.name)
  for (const d of bad) {
    await db.collection('knowledge_categories').doc(d._id).remove()
  }
  let added = 0
  for (const c of CATEGORIES) {
    const ex = await db.collection('knowledge_categories').where({ key: c.key }).get()
    if (!ex.data.length) {
      // 注意：wx-server-sdk 服务端 add 必须包 { data: obj }，裸 add(obj) 会静默失败（已踩坑，init 同修）
      await db.collection('knowledge_categories').add({ data: c })
      added++
    }
  }
  const cnt = await db.collection('knowledge_categories').count()
  return { ok: true, removed: bad.length, added, total: cnt.total }
}
