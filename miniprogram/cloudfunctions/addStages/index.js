const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// 一次性迁移：给【所有已有项目】补「准备阶段」「设计阶段」，使阶段与现行 10 段标准一致。
// 全屋定制不再强制排进线性工序（与油漆等无绝对先后），改为阶段看板按需手建的并行环节，故此处不再插入。
// - 幂等：项目已有 prepare 阶段则跳过，可反复运行。
// - 现有阶段 sort_order 整体 +2，给新 1/2 让位（避免排序冲突）。
// - 旧阶段若缺 status 字段，补 'pending'，使看板状态显示与新阶段一致（未开始）。
// 仅由运维在云函数控制台手动触发一次；云函数以管理员身份运行，不受集合安全规则限制。
exports.main = async () => {
  const db = cloud.database()
  const _ = db.command
  const projects = (await db.collection('projects').limit(100).get()).data || []
  const log = []
  for (const p of projects) {
    const pid = p._id
    // 幂等：已有 prepare 阶段则跳过该项目
    const exist = await db.collection('stages').where({ project_id: pid, key: 'prepare' }).get()
    if (exist.data && exist.data.length) {
      log.push({ project_id: pid, skipped: true })
      continue
    }
    // 现有阶段 sort_order 整体 +2（云函数端 update 批量生效）
    await db.collection('stages').where({ project_id: pid }).update({ data: { sort_order: _.inc(2) } })
    // 旧阶段若缺 status，补 pending
    const old = (await db.collection('stages').where({ project_id: pid }).get()).data || []
    for (const s of old) {
      if (!s.status) {
        await db.collection('stages').doc(s._id).update({ data: { status: 'pending' } })
      }
    }
    // 插入准备/设计阶段（最前）
    // 注意：wx-server-sdk 服务端 add 必须包 { data: obj }，裸 add(obj) 会静默失败（已踩坑，init 同修）
    await db.collection('stages').add({ data: { project_id: pid, key: 'prepare', name: '准备阶段', sort_order: 1, status: 'pending' } })
    await db.collection('stages').add({ data: { project_id: pid, key: 'design', name: '设计阶段', sort_order: 2, status: 'pending' } })
    log.push({ project_id: pid, added: 2 })
  }
  return { ok: true, projects: projects.length, log }
}
