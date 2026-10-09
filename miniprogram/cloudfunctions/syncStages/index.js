// 云函数 syncStages：把 10 个标准施工阶段同步到指定项目。
// 以管理员身份运行，绕过客户端 stages 写权限（doc._openid == auth.openid，云函数建的阶段无 _openid）。
// 触发方式（云控制台「测试」）：{ "projectName": "启呈花园" } 或 { "projectId": "<项目_id>" }
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

// 与 miniprogram/pages/project/create.js 的 PRESET_STAGES 保持一致
const STAGES = [
  { key: 'prepare', name: '准备阶段' },
  { key: 'design', name: '设计阶段' },
  { key: 'demolition', name: '主体拆改' },
  { key: 'electric', name: '水电改造' },
  { key: 'masonry', name: '泥瓦工程' },
  { key: 'carpentry', name: '木工工程' },
  { key: 'painting', name: '油漆工程' },
  { key: 'install', name: '安装阶段' },
  { key: 'soft', name: '软装进场' },
  { key: 'movein', name: '入住准备' },
]

exports.main = async (event = {}) => {
  const { projectId, projectName } = event
  let pid = projectId

  if (!pid && projectName) {
    const res = await db.collection('projects').where({ name: projectName }).limit(1).get()
    if (res.data && res.data.length) pid = res.data[0]._id
  }
  if (!pid) {
    return { ok: false, error: '未提供 projectId，且按 projectName 未找到项目' }
  }

  const existRes = await db.collection('stages').where({ project_id: pid }).get()
  const existMap = {}
  ;(existRes.data || []).forEach((s) => { existMap[s.key] = s })

  let created = 0
  let updated = 0
  for (let i = 0; i < STAGES.length; i++) {
    const s = STAGES[i]
    const sortOrder = i + 1
    const existing = existMap[s.key]
    if (existing) {
      if (existing.sort_order !== sortOrder || existing.name !== s.name) {
        await db.collection('stages').doc(existing._id).update({
          data: { sort_order: sortOrder, name: s.name, updated_at: new Date().toISOString() },
        })
        updated++
      }
    } else {
      await db.collection('stages').add({
        data: {
          project_id: pid,
          key: s.key,
          name: s.name,
          sort_order: sortOrder,
          status: 'pending',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      })
      created++
    }
  }

  return { ok: true, projectId: pid, total: STAGES.length, created, updated }
}
